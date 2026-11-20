"""Ручки пополнения криптой: создать счёт, спросить статус, принять вебхук.

Три ручки, и у каждой свой способ доверия — это здесь главное:

* `POST /billing/topup/crypto` — обычный запрос участника. Арендатор берётся
  из сессии (`current_tenant()`), своих токенов не придумываем: у студии уже
  есть один способ сказать «кто я», второй разошёлся бы с первым.
* `GET /billing/topup/crypto/{id}` — поллинг модалки. Чужой счёт отдаётся как
  404, а не 403: существование чужого платежа — тоже сведения.
* `POST /crypto/webhook/{secret}` — чужой сервис. Токена у него нет и не
  будет, поэтому проверка — секрет в пути, а телу не верим вовсе: статус
  берём из повторного запроса к Bitcart
  (`app/services/crypto_payments.py::refresh_invoice`). Иначе любой, кто
  узнал адрес, нарисовал бы себе `complete`.

**Почему вебхук всегда 200.** Bitcart не ретраит IPN
(`docs/CRYPTO-TOPUP-BITCART.md` §10), так что 500 ничего не повторит — он
только зашумит в мониторинге и помешает разбирать настоящую аварию. Деньги не
теряются: оплаченный счёт догоняет фоновая сверка (`sync_pending`).

**Почему «обновить» — только по старым данным.** Модалка поллит раз в
несколько секунд; без порога в 30 секунд каждый её тик бил бы в шлюз. Порог
не отменяет чтение: свежий ответ с прошлого тика и есть последнее известное.
"""

from __future__ import annotations

import hmac
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from loguru import logger
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CryptoInvoice
from app.services.bitcart_client import BitcartError
from app.services.credits import format_credits
from app.services.crypto_payments import (
    CREDITS_PER_MICRO,
    MSG_DISABLED,
    MSG_NOT_CONFIGURED,
    OPEN_STATUSES,
    USD_MICRO,
    TopupLimitReached,
    TopupUnavailable,
    allow_all_tenants,
    bitcart_configured,
    create_topup,
    refresh_invoice,
)
from app.services.tenant import current_tenant
from app.settings import settings
from app.web.deps import get_session

router = APIRouter(tags=["crypto"])

#: Через сколько секунд чтение счёта идёт в шлюз. Поллинг модалки — раз в
#: 4 секунды; без порога каждый тик стоил бы HTTP-запроса к чужому инстансу.
_REFRESH_AFTER = timedelta(seconds=30)

#: Текст, который человек обязан прочитать. Ошибка «перевёл в другой сети» —
#: необратимая; это не мелкий шрифт, а предупреждение перед кнопкой «Отправить».
_PAYMENT_WARNING = (
    "Отправляйте только ту монету и по той сети, что указаны в счёте. "
    "Перевод в другой сети или другой монетой не будет зачислен автоматически."
)


class TopupIn(BaseModel):
    """Тело запроса. Any, а не Decimal: на мусор отвечаем 400, а не 422.

    Разбор денег обязан быть в одном месте (`_parse_amount`), иначе цена
    ошибки зависит от того, кто первый не согласился — pydantic или наш код.
    """

    amount_usd: Any = None


def _iso_z(moment: datetime | None) -> str | None:
    """Наивный UTC → строка с `Z`: время во всех ответах API одно и то же."""
    if moment is None:
        return None
    text = moment.isoformat()
    if moment.tzinfo is None and not text.endswith("Z"):
        text += "Z"
    return text


def _usd_str(micro: int) -> str:
    return f"{Decimal(int(micro)) / USD_MICRO:.2f}"


def _credits_str(micro: int) -> str:
    """Кредиты строкой: целые без «.00», дробные — по общему правилу кассы."""
    value = Decimal(int(micro)) / CREDITS_PER_MICRO
    if value == value.to_integral_value():
        return str(int(value))
    return format_credits(int(micro), rounding="down")


def _same_tenant(left: Any, right: Any) -> bool:
    """Один ли это арендатор. Сравниваем канонически: UUID как UUID."""
    try:
        return str(uuid.UUID(str(left))) == str(uuid.UUID(str(right)))
    except (ValueError, AttributeError, TypeError):
        return str(left) == str(right)


def _invoice_payload(inv: CryptoInvoice) -> dict:
    """Счёт в том виде, в каком его рисует модалка."""
    return {
        "id": str(inv.id),
        "status": inv.status,
        "amount_usd": _usd_str(inv.amount_usd_micro),
        "credits": _credits_str(inv.credits_micro),
        "expires_at": _iso_z(inv.expires_at),
        "methods": list(inv.methods or []),
        "warning": _PAYMENT_WARNING,
    }


def _require_tenant() -> str:
    """Арендатор запроса или понятный отказ. У пополнения нет режима владельца."""
    tenant = current_tenant()
    if tenant is None:
        raise HTTPException(
            status_code=400,
            detail="Пополнение доступно только в режиме учётных записей: у владельца нет кассы",
        )
    return tenant


def _ensure_available() -> None:
    """Доступна ли фича — спрашиваем ДО «кто ты».

    Выключенная ручка обязана отвечать 503 всем одинаково: клиент не должен
    видеть «нужен вход» там, где дело не в нём, и наоборот — не должен узнать
    про настройки шлюза, которые его не касаются.
    """
    if not settings.crypto_topup_enabled:
        raise HTTPException(status_code=503, detail=MSG_DISABLED)
    if not bitcart_configured():
        raise HTTPException(status_code=503, detail=MSG_NOT_CONFIGURED)


@router.post("/billing/topup/crypto")
async def create_crypto_topup(
    body: TopupIn,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Открыть счёт на пополнение и отдать методы оплаты для модалки."""
    _ensure_available()
    tenant = _require_tenant()
    try:
        inv = await create_topup(session, tenant, body.amount_usd)
    except ValueError as exc:
        # Сумма мусорная или вне лимитов — это ошибка клиента, не сервера.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except TopupLimitReached as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except TopupUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"invoice": _invoice_payload(inv)}


@router.get("/billing/topup/crypto/{invoice_id}")
async def get_crypto_topup(
    invoice_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Статус своего счёта для поллинга. Свежие данные — из шлюза, старые — из базы."""
    tenant = _require_tenant()
    invoice_key = _parse_id(invoice_id)
    if invoice_key is None:
        raise HTTPException(status_code=404, detail="счёт не найден")
    inv = await session.get(CryptoInvoice, invoice_key)
    if inv is None or not _same_tenant(inv.tenant_id, tenant):
        raise HTTPException(status_code=404, detail="счёт не найден")

    stale = False
    if inv.status in OPEN_STATUSES and _stale(inv.updated_at):
        stale = await _try_refresh(session, invoice_key)
        inv = await session.get(CryptoInvoice, invoice_key)
        if inv is None:
            raise HTTPException(status_code=404, detail="счёт не найден")

    return {
        "invoice": _invoice_payload(inv)
        | {
            "credited_credits": (
                _credits_str(inv.credits_micro) if inv.status == "credited" else None
            ),
            "settled_at": _iso_z(inv.settled_at),
            "stale": stale,
            "updated_at": _iso_z(inv.updated_at),
        }
    }


@router.post("/crypto/webhook/{secret}")
async def bitcart_webhook(
    secret: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Уведомление Bitcart. Не авторизация, а признак «свой»: секрет в пути."""
    expected = (settings.crypto_webhook_secret or "").strip()
    if not expected or not _secret_matches(secret, expected):
        # 404, а не 401: не подтверждаем даже существование этой ручки.
        raise HTTPException(status_code=404, detail="Not Found")
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 — битое тело это отказ, а не сбой
        raise HTTPException(status_code=400, detail="битый JSON") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="ожидался объект")

    external_id = str(body.get("id") or "").strip()
    if not external_id:
        # Тело без id: статус из него мы всё равно не читаем, так что и
        # разбирать нечего. Отвечаем 200, чтобы шлюз не считал доставку сбоем.
        logger.warning("crypto webhook: тело без id счёта — пропущено")
        return {"ok": True}

    try:
        # Чужого арендатора здесь нет и быть не может: счёт ищем по внешнему
        # id, поэтому проход поднимаем системный и явно (контракт §13).
        await allow_all_tenants(session)
        found = (
            (
                await session.execute(
                    select(CryptoInvoice).where(CryptoInvoice.external_id == external_id).limit(1)
                )
            )
            .scalars()
            .first()
        )
        if found is None:
            logger.warning("crypto webhook: счёт {} нам не принадлежит", external_id[:16])
            return {"ok": True}
        # Статус из тела НЕ используем: авторитетный источник — сам шлюз.
        await refresh_invoice(session, found)
    except BitcartError as exc:
        # Шлюз не ответил — это не повод отдавать 500: сверит фоновая задача.
        logger.warning("crypto webhook: шлюз не ответил по счёту {}: {}", external_id[:16], exc)
        await _reset(session)
        return {"ok": True}
    except Exception:  # noqa: BLE001 — вебхук не должен шуметь 500
        logger.exception("crypto webhook: сбой обработки счёта {}", external_id[:16])
        await _reset(session)
        return {"ok": True}
    return {"ok": True}


def _parse_id(raw: str) -> str | None:
    """id счёта — UUID. Мусор в пути это 404, а не 500 на приведении типа."""
    try:
        return str(uuid.UUID(str(raw)))
    except (ValueError, AttributeError, TypeError):
        return None


def _stale(moment: datetime | None) -> bool:
    """Пора ли перечитать счёт у шлюза. Время в базе — наивный UTC."""
    if moment is None:
        return True
    return moment < datetime.now(UTC).replace(tzinfo=None) - _REFRESH_AFTER


def _secret_matches(given: str, expected: str) -> bool:
    """Сравнение без утечки по времени. Байтами: секрет может быть не ASCII."""
    return hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))


async def _try_refresh(session: AsyncSession, invoice_key: str) -> bool:
    """Сходить в шлюз; ``True`` — данные могли устареть (ответ отдаём последний).

    Ошибка шлюза не валит ответ: клиент должен увидеть «ждём оплату» и таймер,
    а не 500 в модалке, из-за которой он не знает, платить ли ему.
    """
    if not settings.crypto_topup_enabled or not bitcart_configured():
        return True
    inv = await session.get(CryptoInvoice, invoice_key)
    if inv is None:
        return True
    try:
        await refresh_invoice(session, inv)
    except BitcartError as exc:
        logger.warning("crypto: шлюз не ответил по счёту {}: {}", invoice_key[:8], exc)
        await _reset(session)
        return True
    except Exception:  # noqa: BLE001 — статус важнее, чем причина сбоя
        logger.exception("crypto: сбой обновления счёта {}", invoice_key[:8])
        await _reset(session)
        return True
    return False


async def _reset(session: AsyncSession) -> None:
    """Откатить транзакцию и опустошить сессию: дальше читаем последнее из базы.

    `AsyncSession.rollback()` — корутина, её обязательно ждать: без `await`
    откат не выполнится, а в журнал полезет «coroutine was never awaited».
    Опустошение после отката нужно, чтобы объекты, протухшие при откате, не
    читались лениво в async-контексте (это уже MissingGreenlet).
    """
    try:
        await session.rollback()
        session.expunge_all()
    except Exception:  # noqa: BLE001 — сброс не должен подменять исходную ошибку
        logger.exception("crypto: не удалось сбросить сессию после ошибки шлюза")

