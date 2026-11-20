"""Приём крипты на уровне сервиса: счёт, сверка, CAS-начисление, леджер.

Проверяется не «вызвались ли функции», а три свойства, ради которых этот код
написан (`docs/CRYPTO-TOPUP-CONTRACT.md` §7, §11, §13):

* **тело вебхука ничего не решает** — статус и сумма берутся только из ответа
  шлюза, поэтому все статусные кейсы здесь гоняются через `refresh_invoice`,
  как это делает роутер;
* **начисление ровно одно** — даже если `complete` пришёл дважды или сверка
  пришла одновременно с вебхуком, в леджере одна проводка (CAS по статусу);
* **шлюз без сети** — `BitcartClient` подменён, ни один тест сюда не ходит.
  Отдельно проверяется и сам клиент: заголовок, таймаут, ретрай только у GET
  и отсутствие токена в тексте ошибки.

Время в базе — наивный UTC, деньги — целые микроединицы; оба свойства
проверяются здесь же, потому что расхождение на третьем знаке или `+03:00`
в ответе видно не сразу, а стоит денег.
"""

from __future__ import annotations

import importlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import select

from app.db import session_scope
from app.models import CreditEntry, CryptoInvoice
from app.services import credit_ledger as cl
from app.services import crypto_payments as cp
from app.services.bitcart_client import BitcartClient, BitcartError
from app.services.tenant_tables import all_isolated, check_coverage
from app.settings import settings

#: Секреты стенда. Настоящие здесь не нужны, но проверка «не утекло» без них
#: бессмысленна: ищем в ответах и `raw` именно эти строки.
TOKEN = "bitcart-token-8f3c2d"  # gitleaks:allow — фикстура теста
WEBHOOK_SECRET = "whsec-5b1e7a9c4d2f"  # gitleaks:allow — фикстура теста

STUDIO_BASE = "https://studio.example.test"
STORE_ID = "store-test"

#: Один метод оплаты в том виде, в каком его отдаёт Bitcart: токен с суффиксом
#: сети, адрес и uri для QR. Используется всеми ответами мока.
PAYMENT: dict[str, Any] = {
    "currency": "usdt_trx",
    "amount": "10.0",
    "payment_address": "TXyz1234567890",
    "payment_url": "tron:TXyz1234567890?amount=10",
    "wallet": {"network": "tron"},
    "required_confirmations": 1,
}


def _tenant() -> str:
    return str(uuid.uuid4())


def _naive_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class FakeBitcart:
    """Шлюз без сети: помнит, что у него спросили, и отвечает тем, что велели.

    Ошибки задаются по id счёта (`get_errors`), а не глобально: так видно
    разницу между «упал один счёт» и «упал шлюз». Именно этого требует §7:
    ошибка одного счёта не валит пачку.
    """

    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []
        self.invoices: dict[str, dict[str, Any]] = {}
        self.create_error: Exception | None = None
        self.get_errors: dict[str, Exception] = {}
        #: Что накладывается на любой ответ GET (статус, цена, exception_status).
        self.invoice_state: dict[str, Any] = {}
        self.get_calls = 0

    async def create_invoice(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.payloads.append(payload)
        if self.create_error is not None:
            raise self.create_error
        external_id = f"bitcart-inv-{len(self.payloads)}"
        data: dict[str, Any] = {
            "id": external_id,
            "status": "pending",
            "price": payload.get("price"),
            "amount": payload.get("price"),
            "expiration_seconds": 1800,
            # Шлюз возвращает присланный notification_url — в нём секрет.
            # `raw` обязан его вычистить (§13).
            "notification_url": payload.get("notification_url", ""),
            "payments": [dict(PAYMENT)],
        }
        self.invoices[external_id] = data
        return data

    async def get_invoice(self, external_id: str) -> dict[str, Any]:
        self.get_calls += 1
        error = self.get_errors.get(external_id)
        if error is not None:
            raise error
        data = dict(self.invoices.get(external_id, {"id": external_id, "payments": [dict(PAYMENT)]}))
        data.update(self.invoice_state)
        data["id"] = external_id
        return data

    def gateway_state(self, external_id: str, **fields: Any) -> None:
        """Выставить состояние счёта на стороне шлюза (статус, фактическая цена)."""
        self.invoices.setdefault(external_id, {"id": external_id, "payments": [dict(PAYMENT)]})
        self.invoices[external_id].update(fields)


@pytest.fixture
def fake_bitcart(monkeypatch: pytest.MonkeyPatch) -> FakeBitcart:
    """Подменить фабрику клиента. В сеть этот тест не ходит."""
    fake = FakeBitcart()
    monkeypatch.setattr(cp, "_client", lambda: fake)
    return fake


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Включённое и настроенное пополнение — состояние прода после §2."""
    monkeypatch.setattr(settings, "crypto_topup_enabled", True)
    monkeypatch.setattr(settings, "bitcart_url", "https://pay.example.test/")
    monkeypatch.setattr(settings, "bitcart_store_id", STORE_ID)
    monkeypatch.setattr(settings, "bitcart_token", TOKEN)
    monkeypatch.setattr(settings, "crypto_webhook_secret", WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "studio_public_url", STUDIO_BASE + "/")
    monkeypatch.setattr(settings, "crypto_topup_min_usd", 5.0)
    monkeypatch.setattr(settings, "crypto_topup_max_usd", 500.0)
    monkeypatch.setattr(settings, "crypto_topup_expiration_min", 30)
    monkeypatch.setattr(settings, "crypto_topup_max_open", 10)
    monkeypatch.setattr(settings, "credit_usd_rate", 1.0)


async def _create(amount: str = "10.00") -> CryptoInvoice:
    """Открыть счёт и вернуть его уже отсоединённым от сессии."""
    async with session_scope() as session:
        return await cp.create_topup(session, _tenant(), amount)


async def _entries(tenant: str) -> list[CreditEntry]:
    async with session_scope() as session:
        return list(
            (await session.execute(select(CreditEntry).where(CreditEntry.tenant_id == tenant)))
            .scalars()
            .all()
        )


async def _age(external_id: str, seconds: int) -> None:
    """Состарить счёт, чтобы его взяла фоновая сверка (порог 20 с)."""
    async with session_scope() as session:
        row = (
            await session.execute(select(CryptoInvoice).where(CryptoInvoice.external_id == external_id))
        ).scalar_one()
        row.updated_at = _naive_now() - timedelta(seconds=seconds)
        await session.commit()


# ── §11.1. Флаг, конфиг, тело запроса к шлюзу ───────────────────────────────


async def test_disabled_flag_refuses_before_the_gateway(
    fake_bitcart: FakeBitcart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Выключенное пополнение не создаёт счёт и не дёргает чужой сервис.

    «Полное отсутствие эффекта» из §0: выключенный флаг не должен оставлять
    ни строки в базе, ни запроса наружу.
    """
    monkeypatch.setattr(settings, "crypto_topup_enabled", False)
    async with session_scope() as session:
        with pytest.raises(cp.TopupUnavailable) as refused:
            await cp.create_topup(session, _tenant(), "10.00")
    assert str(refused.value) == cp.MSG_DISABLED
    assert fake_bitcart.payloads == []


async def test_enabled_without_settings_names_what_is_missing(
    fake_bitcart: FakeBitcart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Включённый флаг без BITCART_* — 503 с перечнем настроек, а не трейсбек."""
    monkeypatch.setattr(settings, "crypto_topup_enabled", True)
    monkeypatch.setattr(settings, "bitcart_url", "")
    monkeypatch.setattr(settings, "bitcart_store_id", "")
    monkeypatch.setattr(settings, "bitcart_token", "")
    async with session_scope() as session:
        with pytest.raises(cp.TopupUnavailable) as refused:
            await cp.create_topup(session, _tenant(), "10.00")
    assert str(refused.value) == cp.MSG_NOT_CONFIGURED
    assert fake_bitcart.payloads == []


async def test_create_sends_exactly_the_contract_payload(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Поля запроса к Bitcart — контракт §7 п.5, и в них нет наших секретов.

    Сравнение словарём, а не по одному полю: лишний ключ (например, токен или
    чужой адрес) тоже утечка, и заметить его надо здесь.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
        assert invoice.status == "new"
        assert invoice.tenant_id == tenant
        assert invoice.provider == "bitcart"
        assert invoice.amount_usd_micro == 10_000_000
        assert invoice.credits_micro == 10_000_000

    assert fake_bitcart.payloads == [
        {
            "price": "10.00",
            "currency": "USD",
            "store_id": STORE_ID,
            "order_id": invoice.id,
            "expiration": 30,
            "notification_url": f"{STUDIO_BASE}/api/crypto/webhook/{WEBHOOK_SECRET}",
            "redirect_url": f"{STUDIO_BASE}/home",
        }
    ]
    # Токен шлюза не уезжает в тело запроса: он живёт в заголовке.
    assert TOKEN not in json.dumps(fake_bitcart.payloads, ensure_ascii=False)


async def test_created_invoice_carries_methods_for_the_modal(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Методы оплаты разобраны терпимо: монета, сеть, адрес, QR, label."""
    invoice = await _create()
    assert invoice.external_id == "bitcart-inv-1"
    assert invoice.methods == [
        {
            "asset": "usdt",
            "network": "tron",
            "label": "USDT (TRON)",
            "amount": "10.0",
            "address": "TXyz1234567890",
            "uri": "tron:TXyz1234567890?amount=10",
            "required_confirmations": 1,
            "sender_address_required": False,
        }
    ]
    # Подсказка «что выбрал клиент» лежит и в полях строки — историю видно
    # без разбора JSON.
    assert (invoice.asset, invoice.network) == ("usdt", "tron")
    assert invoice.address == "TXyz1234567890"
    assert invoice.expected_amount == "10.0"


async def test_no_public_base_means_no_notification_url(
    configured: None, fake_bitcart: FakeBitcart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Без внешнего адреса ссылки наружу не отдаём: счёт живёт, сверка доберёт.

    Подставить `127.0.0.1` было бы хуже, чем не отдать ничего: Bitcart стучится
    снаружи и ушёл бы в никуда.
    """
    monkeypatch.setattr(settings, "studio_public_url", "")
    invoice = await _create()
    payload = fake_bitcart.payloads[0]
    assert "notification_url" not in payload
    assert "redirect_url" not in payload
    assert invoice.external_id == "bitcart-inv-1"


# ── §11.2. Суммы и лимит открытых счетов ────────────────────────────────────


@pytest.mark.parametrize(
    "garbage",
    ["4.99", "500.01", 0, -1, None, "abc", {}, "NaN", "Infinity", True],
)
async def test_bad_amount_is_refused_before_the_gateway(
    configured: None, fake_bitcart: FakeBitcart, garbage: Any
) -> None:
    """Мусор и суммы вне лимитов — ValueError (роутер → 400), без счёта."""
    async with session_scope() as session:
        with pytest.raises(ValueError):
            await cp.create_topup(session, _tenant(), garbage)
    assert fake_bitcart.payloads == []


@pytest.mark.parametrize("absurd", ["1e100", "1e30", "9" * 40])
async def test_absurd_amount_is_refused_not_crashing(
    configured: None, fake_bitcart: FakeBitcart, absurd: str
) -> None:
    """Огромное число — тоже неверная сумма, а не сбой сервера (§7 п.2, §8).

    `Decimal.quantize` на сумме в 30+ знаков уходит в `decimal.InvalidOperation`
    (это `ArithmeticError`, а не `ValueError`). Роутер ловит только `ValueError`
    и отдаёт 400, поэтому отсюда обязано выйти `ValueError` — иначе клиент
    получит 500 на мусорном поле ввода.
    """
    async with session_scope() as session:
        with pytest.raises(ValueError):
            await cp.create_topup(session, _tenant(), absurd)
    assert fake_bitcart.payloads == []


@pytest.mark.parametrize(
    ("amount", "micro"),
    [("5.00", 5_000_000), (5, 5_000_000), ("500", 500_000_000), ("10.005", 10_010_000)],
)
async def test_amount_is_quantized_to_cents(
    configured: None, fake_bitcart: FakeBitcart, amount: Any, micro: int
) -> None:
    """Квантование до центов до проверки лимитов: 10.005 — это 10.01."""
    async with session_scope() as session:
        invoice = await cp.create_topup(session, _tenant(), amount)
    assert invoice.amount_usd_micro == micro


async def test_open_invoice_limit_is_per_tenant(
    configured: None, fake_bitcart: FakeBitcart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Лимит открытых счетов считается по арендатору, а не по всей студии.

    Без лимита спам плодит адреса и держит демоны монет занятыми (§4.3), но
    чужой лимит не должен закрывать пополнение соседу.
    """
    monkeypatch.setattr(settings, "crypto_topup_max_open", 2)
    first, second = _tenant(), _tenant()
    async with session_scope() as session:
        await cp.create_topup(session, first, "10.00")
        await cp.create_topup(session, first, "10.00")
        with pytest.raises(cp.TopupLimitReached):
            await cp.create_topup(session, first, "10.00")
        # Сосед не пострадал.
        await cp.create_topup(session, second, "10.00")
    assert len(fake_bitcart.payloads) == 3


# ── §11.3. Маппинг статусов и начисление ────────────────────────────────────


@pytest.mark.parametrize(
    ("gateway_status", "ours"),
    [("pending", "new"), ("new", "new"), ("paid", "paid"), ("confirmed", "paid"), ("unconfirmed", "paid")],
)
async def test_intermediate_statuses_never_credit(
    configured: None, fake_bitcart: FakeBitcart, gateway_status: str, ours: str
) -> None:
    """Деньги «в пути» — это не деньги: `paid` и `confirmed` не начисляются."""
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(invoice.external_id or "", status=gateway_status)
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == ours
        assert row.invoice_status == gateway_status
    assert await _entries(tenant) == []


async def test_complete_credits_once_and_links_the_entry(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """`complete` при курсе 1 кредит = $1: начислено ровно запрошенное.

    Проводка обязана нести ссылку на счёт (`ref_table`/`ref_ids`), иначе
    спорный платёж нечем закрыть, а в истории видно «+10 кр» без причины.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(invoice.external_id or "", status="complete", effective_price="10.00")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "credited"
        assert row.credits_micro == 10_000_000
        assert row.settled_at is not None and row.settled_at.tzinfo is None
        entries = list(
            (await session.execute(select(CreditEntry).where(CreditEntry.tenant_id == tenant)))
            .scalars()
            .all()
        )
        assert len(entries) == 1
        entry = entries[0]
        assert (entry.kind, entry.delta_micro) == ("topup", 10_000_000)
        assert entry.ref_table == "crypto_invoices"
        assert entry.ref_ids == [invoice.id]
        assert row.credited_entry_id == entry.id
        assert await cl.balance_micro(session, tenant) == 10_000_000
        cached, computed = await cl.reconcile(session, tenant)
        assert (cached, computed) == (10_000_000, 10_000_000)


async def test_rate_one_hundred_believable_credits(
    configured: None, fake_bitcart: FakeBitcart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Курс 1$ = 100 кредитов (`credit_usd_rate=0.01`) считается через `usd_per_credit`.

    Ровно этот курс — решение владельца (`docs/CRYPTO-TOPUP-BITCART.md` §1):
    $10 обязаны стать 1000 кредитами, а не 10.
    """
    monkeypatch.setattr(settings, "credit_usd_rate", 0.01)
    assert cp.credits_micro_for_usd(Decimal("10")) == 1_000_000_000
    assert cp.credits_micro_for_usd(Decimal("5.00")) == 500_000_000

    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
        assert invoice.credits_micro == 1_000_000_000
    fake_bitcart.gateway_state(invoice.external_id or "", status="complete", effective_price="10.00")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "credited"
        assert row.credits_micro == 1_000_000_000
        assert await cl.balance_micro(session, tenant) == 1_000_000_000


def test_credits_micro_rounds_down_not_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """Микрокредиты считаются вниз: клиент не видит баланс больше фактического.

    Округление вверх подарило бы работу на дроблении шагов (§5.1 в
    `docs/SAAS-PIVOT.md`), поэтому floor закреплён тестом.
    """
    monkeypatch.setattr(settings, "credit_usd_rate", 1.0)
    assert cp.credits_micro_for_usd(Decimal("0.0105")) == 10_500
    assert cp.credits_micro_for_usd(Decimal("0.0000009")) == 0
    monkeypatch.setattr(settings, "credit_usd_rate", 0.01)
    assert cp.credits_micro_for_usd(Decimal("0.0105")) == 1_050_000
    assert cp.to_usd_micro(Decimal("10.00")) == 10_000_000


async def test_overpayment_is_credited_by_the_fact(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Переплата (`paid_over`) начисляется по фактической цене шлюза, с memo.

    Начислить по запрошенной сумме значило бы подарить разницу: курс ходит,
    и клиент мог отправить больше.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(
        invoice.external_id or "",
        status="complete",
        exception_status="paid_over",
        effective_price="12.50",
    )
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "credited"
        assert row.credits_micro == 12_500_000
        entry = (await session.execute(select(CreditEntry).where(CreditEntry.tenant_id == tenant))).scalar_one()
        assert entry.delta_micro == 12_500_000
        assert "переплата" in entry.memo


async def test_partial_payment_waits_for_a_human(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Недоплата — `partial` без начисления: сколько зачесть, решает человек.

    Автоматически зачесть половину значило бы либо подарить, либо отнять
    разницу; код выбирает не решать за человека.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(invoice.external_id or "", status="pending", exception_status="paid_partial")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "partial"
        # Счёт остаётся открытым: по нему ещё предстоит разбор.
        assert await cp.apply_settlement(session, row) is False
    assert await _entries(tenant) == []


@pytest.mark.parametrize(("gateway_status", "ours"), [("expired", "expired"), ("invalid", "invalid"), ("refunded", "refunded")])
async def test_closed_gateway_statuses_never_pay(
    configured: None, fake_bitcart: FakeBitcart, gateway_status: str, ours: str
) -> None:
    """`expired`/`invalid`/`refunded` закрывают счёт без начисления (§7 п.2)."""
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(invoice.external_id or "", status=gateway_status)
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == ours
        assert await cp.apply_settlement(session, row) is False
    assert await _entries(tenant) == []


async def test_complete_without_amount_is_closed_not_credited(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """`complete` без суммы: закрыть с причиной, а не начислить ноль.

    Оставить счёт открытым значило бы гонять сверку по нему вечно; начислить
    ноль — записать «оплачено», не заплатив.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
        invoice.amount_usd_micro = 0
        await session.commit()
    fake_bitcart.gateway_state(invoice.external_id or "", status="complete")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "error"
        assert row.last_error
    assert await _entries(tenant) == []


async def test_late_payment_after_expiry_is_credited(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Оплата, подтвердившаяся после истечения, не теряется (§7 п.2).

    Клиент отправил за минуту до дедлайна, сеть подтвердила позже: шлюз успел
    сказать `expired`, а потом увидел платёж и сказал `complete`. Деньги
    настоящие, и счёт обязан из `expired` перейти в `credited`, а не остаться
    закрытым без кредитов.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    external_id = invoice.external_id or ""
    fake_bitcart.gateway_state(external_id, status="expired")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "expired"

    fake_bitcart.gateway_state(external_id, status="complete", effective_price="10.00")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "credited"

    entries = await _entries(tenant)
    assert len(entries) == 1
    assert entries[0].delta_micro == 10_000_000


async def test_sync_pending_rechecks_a_recently_expired_invoice(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Уведомление потерялось: сверка сама перепроверит недавно истёкший счёт.

    IPN у Bitcart без ретраев, поэтому «шлюз передумал, а вебхук не дошёл» —
    реальный сценарий. Окно в сутки с редкой перепроверкой закрывает его.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    external_id = invoice.external_id or ""
    fake_bitcart.gateway_state(external_id, status="expired")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "expired"

    fake_bitcart.gateway_state(external_id, status="complete", effective_price="10.00")
    await _age(external_id, seconds=3 * 3600)  # перепроверка раз в 2 часа
    async with session_scope() as session:
        await cp.sync_pending(session)
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        assert row.status == "credited"
    assert len(await _entries(tenant)) == 1


async def test_sync_pending_leaves_old_closed_invoices_alone(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Закрытый месяц назад счёт сверка больше не трогает.

    Иначе такой счёт с протухшим `expires_at` попадал бы в выборку каждый
    проход: шлюз дёргался бы вечно, а лимит пачки (25) занимали бы счета,
    которые уже никто не переплатит.
    """
    async with session_scope() as session:
        invoice = await cp.create_topup(session, _tenant(), "10.00")
    external_id = invoice.external_id or ""
    fake_bitcart.gateway_state(external_id, status="expired")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "expired"
        row.expires_at = _naive_now() - timedelta(days=3)
        row.updated_at = _naive_now() - timedelta(days=3)
        await session.commit()

    calls_before = fake_bitcart.get_calls
    async with session_scope() as session:
        await cp.sync_pending(session)
    assert fake_bitcart.get_calls == calls_before


async def test_garbage_gateway_rate_does_not_break_the_refresh(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Мусорные `price`/`amount` в ответе шлюза не роняют сверку счёта.

    Курс — справочное поле: он считается из `price/amount`, а на паре
    `1e30`/`1e-30` деление с квантованием уходит в `decimal.InvalidOperation`.
    Упасть здесь значило бы не применить настоящий статус и не начислить по
    оплаченному счёту из-за одной справочной строки.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    external_id = invoice.external_id or ""
    fake_bitcart.invoices[external_id]["price"] = "1e30"
    fake_bitcart.invoices[external_id]["amount"] = "1e-30"
    fake_bitcart.gateway_state(external_id, status="paid")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        assert row.status == "paid"
        # Курс не переписан мусором: осталось прежнее осмысленное значение.
        assert row.rate_usd == "1.00000000"


# ── §11.4–5. Двойной complete и подмена тела ────────────────────────────────


async def test_double_complete_credits_exactly_once(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Хоть десять раз `complete` — проводка одна: CAS пускает одного.

    Вебхук Bitcart не ретраится, но может прийти дважды, и сверка может
    прийти одновременно с ним (§10). Одна проводка на счёт — не оптимизация,
    а свойство денег.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(invoice.external_id or "", status="complete", effective_price="10.00")

    async with session_scope() as session:
        first = await session.get(CryptoInvoice, invoice.id)
        assert first is not None
        assert await cp.refresh_invoice(session, first) is not None
    async with session_scope() as session:
        second = await session.get(CryptoInvoice, invoice.id)
        assert second is not None
        await cp.refresh_invoice(session, second)
        assert second.status == "credited"
        assert await cp.apply_settlement(session, second) is False

    entries = await _entries(tenant)
    assert len(entries) == 1
    assert entries[0].delta_micro == 10_000_000
    async with session_scope() as session:
        assert await cl.balance_micro(session, tenant) == 10_000_000


# ── §11.9. Фоновая сверка ───────────────────────────────────────────────────


async def test_sync_pending_picks_up_complete_without_a_webhook(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Потерянное уведомление не теряет деньги: сверка добирает `complete`."""
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    fake_bitcart.gateway_state(invoice.external_id or "", status="complete", effective_price="10.00")
    await _age(invoice.external_id or "", seconds=120)

    async with session_scope() as session:
        processed = await cp.sync_pending(session)
        assert processed == 1
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        assert row.status == "credited"
        assert row.credits_micro == 10_000_000
    assert len(await _entries(tenant)) == 1


async def test_sync_pending_survives_a_broken_invoice(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """Ошибка шлюза по одному счёту не валит пачку (`§7`, `§11.9`).

    Сценарий боевой: один счёт шлюз уже не знает (404), второй — оплачен.
    Первый обязан остаться `new` для ручного разбора, второй — начислиться.
    Если исключение из обработчика первого счёта вылетает наружу, пачка
    обрывается, и оплаченные счета после сломанного не сверяются вовсе.
    """
    tenant = _tenant()
    async with session_scope() as session:
        broken = await cp.create_topup(session, tenant, "10.00")
        paid = await cp.create_topup(session, tenant, "10.00")
    assert broken.external_id and paid.external_id
    fake_bitcart.get_errors[broken.external_id] = BitcartError("Bitcart ответил 404: invoice not found")
    fake_bitcart.gateway_state(paid.external_id, status="complete", effective_price="10.00")
    # Сломанный счёт старше: сверка берёт пачку по updated_at, и он пойдёт первым.
    await _age(broken.external_id, seconds=180)
    await _age(paid.external_id, seconds=170)

    async with session_scope() as session:
        processed = await cp.sync_pending(session)

    assert processed == 1, "сверка обязана обработать второй счёт, несмотря на ошибку первого"
    async with session_scope() as session:
        broken_row = await session.get(CryptoInvoice, broken.id)
        paid_row = await session.get(CryptoInvoice, paid.id)
        assert broken_row is not None and paid_row is not None
        assert broken_row.status == "new", "сломанный счёт остаётся открытым для разбора"
        assert paid_row.status == "credited", "оплаченный счёт обязан начислиться"
    assert [entry.delta_micro for entry in await _entries(tenant)] == [10_000_000]


async def test_sync_pending_is_a_noop_when_the_feature_is_off(
    configured: None, fake_bitcart: FakeBitcart, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Выключенное пополнение не ходит в шлюз даже по старым счетам."""
    async with session_scope() as session:
        invoice = await cp.create_topup(session, _tenant(), "10.00")
    await _age(invoice.external_id or "", seconds=120)
    monkeypatch.setattr(settings, "crypto_topup_enabled", False)
    async with session_scope() as session:
        assert await cp.sync_pending(session) == 0
    assert fake_bitcart.get_calls == 0


# ── §11.10. Инвариант леджера и ссылки на счёт ──────────────────────────────


async def test_ledger_invariant_holds_after_a_series_of_credits(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """`balance = Σ delta − Σ held` после серии начислений (§11.10).

    Кэш баланса и проводки считаются независимо — расхождение здесь означает
    потерянные или подаренные деньги, а не баг отображения.
    """
    tenant = _tenant()
    amounts = ["10.00", "25.00", "5.50"]
    invoices: list[CryptoInvoice] = []
    async with session_scope() as session:
        for amount in amounts:
            invoices.append(await cp.create_topup(session, tenant, amount))
    for invoice, amount in zip(invoices, amounts, strict=True):
        fake_bitcart.gateway_state(invoice.external_id or "", status="complete", effective_price=amount)
        async with session_scope() as session:
            row = await session.get(CryptoInvoice, invoice.id)
            assert row is not None
            await cp.refresh_invoice(session, row)

    async with session_scope() as session:
        cached, computed = await cl.reconcile(session, tenant)
        assert cached == computed == 40_500_000
        entries = list(
            (await session.execute(select(CreditEntry).where(CreditEntry.tenant_id == tenant)))
            .scalars()
            .all()
        )
        assert len(entries) == len(amounts)
        assert all(entry.ref_table == "crypto_invoices" for entry in entries)
        assert {ref for entry in entries for ref in entry.ref_ids} == {invoice.id for invoice in invoices}


# ── §11.11. Изоляция и миграция ─────────────────────────────────────────────


def test_crypto_invoices_are_in_the_isolation_lists() -> None:
    """Новая таблица обязана быть под RLS, иначе она молча видна всем.

    `check_coverage` ловит таблицу, забытую в списках; `all_isolated` — то,
    на что навешивается политика.
    """
    assert "crypto_invoices" in all_isolated()
    assert check_coverage() == []


def test_migration_0025_is_idempotent_and_reversible(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Повторный upgrade и downgrade не падают — `§4`, `§13`.

    На SQLite политик RLS нет (функция из `rls_apply` там no-op), но сама
    миграция обязана быть повторяемой: она «долечивает» базу, которая уже
    получила таблицу от `create_all`. Проверяются оба прохода и схема.
    """
    module = importlib.import_module("migrations.versions.0025_crypto_invoices")
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'migration.db'}")
    expected_indexes = {name for name, _columns in module.INDEXES}

    def run(action: Any) -> None:
        with engine.connect() as connection:
            monkeypatch.setattr(module, "op", Operations(MigrationContext.configure(connection)))
            action()
            connection.commit()

    try:
        run(module.upgrade)
        inspector = sa.inspect(engine)
        assert "crypto_invoices" in inspector.get_table_names()
        assert expected_indexes <= {index["name"] for index in inspector.get_indexes("crypto_invoices")}
        assert module.UNIQUE_NAME in {
            constraint["name"] for constraint in inspector.get_unique_constraints("crypto_invoices")
        }
        columns = {column["name"]: column for column in inspector.get_columns("crypto_invoices")}
        # Строка заводится ДО ответа шлюза: external_id обязан быть NULL-able,
        # арендатор — обязателен (иначе RLS нечего проверять).
        assert columns["external_id"]["nullable"] is True
        assert columns["tenant_id"]["nullable"] is False

        run(module.upgrade)  # повторный прогон: таблица и индексы уже есть
        run(module.downgrade)
        assert "crypto_invoices" not in sa.inspect(engine).get_table_names()
        run(module.downgrade)  # повторный downgrade тоже безопасен
        run(module.upgrade)
        assert "crypto_invoices" in sa.inspect(engine).get_table_names()
    finally:
        engine.dispose()


# ── §13. Часы, секреты, клиент шлюза ────────────────────────────────────────


async def test_timestamps_are_naive_utc(configured: None, fake_bitcart: FakeBitcart) -> None:
    """В модели наивный UTC (как весь репозиторий), без `+03:00`.

    Осознанное время с зоной в базе дало бы сравнение aware/naive в сверке и
    «счёт истёк» не в тот момент.
    """
    invoice = await _create()
    for stamp in (invoice.created_at, invoice.updated_at, invoice.expires_at):
        assert stamp is not None and stamp.tzinfo is None
    assert abs((invoice.created_at - _naive_now()).total_seconds()) < 300
    # Срок из ответа шлюза (expiration_seconds=1800), а не из настроек.
    assert invoice.expires_at is not None
    assert abs((invoice.expires_at - _naive_now()).total_seconds() - 1800) < 120


async def test_raw_never_keeps_the_webhook_secret(
    configured: None, fake_bitcart: FakeBitcart
) -> None:
    """`raw` чистится рекурсивно: `notification_url` — это секрет вебхука (§13).

    Оставленное в `raw` значение разложило бы ключ по каждому дампу базы и
    каждому бэкапу.
    """
    tenant = _tenant()
    async with session_scope() as session:
        invoice = await cp.create_topup(session, tenant, "10.00")
    assert invoice.raw["notification_url"] == "***"
    fake_bitcart.invoices[invoice.external_id or ""]["meta"] = {
        "notification_url": f"{STUDIO_BASE}/api/crypto/webhook/{WEBHOOK_SECRET}"
    }
    fake_bitcart.gateway_state(invoice.external_id or "", status="paid")
    async with session_scope() as session:
        row = await session.get(CryptoInvoice, invoice.id)
        assert row is not None
        await cp.refresh_invoice(session, row)
        dumped = json.dumps(row.raw, ensure_ascii=False)
        assert row.raw["meta"]["notification_url"] == "***"
    assert WEBHOOK_SECRET not in dumped
    assert TOKEN not in dumped


async def test_bitcart_client_sends_token_without_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    """Заголовок, адрес и таймаут клиента — контракт §6.

    `Authorization: <token>` без `Bearer`; таймаут задан целиком (зависший
    коннект к чужому инстансу — тоже отказ); токена нет в `repr`.
    """
    real_client = httpx.AsyncClient
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "inv-1", "status": "pending"})

    def factory(**kwargs: Any) -> httpx.AsyncClient:
        seen["kwargs"] = kwargs
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    client = BitcartClient("https://pay.example.test/", TOKEN, timeout=7.5)
    assert (await client.create_invoice({"price": "10.00"}))["id"] == "inv-1"

    assert seen["method"] == "POST"
    assert seen["url"] == "https://pay.example.test/api/invoices"
    assert seen["headers"]["authorization"] == TOKEN
    assert seen["body"] == {"price": "10.00"}
    timeout = seen["kwargs"]["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert {timeout.connect, timeout.read, timeout.write, timeout.pool} == {7.5}
    assert seen["kwargs"]["follow_redirects"] is False
    assert TOKEN not in repr(client)


async def test_bitcart_error_names_the_code_without_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ошибка шлюза — короткая причина без секрета (§6, §13).

    В логах окажется код ответа и обрывок тела; токен туда попасть не должен.
    """
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="invalid token " * 40)

    def factory(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    client = BitcartClient("https://pay.example.test", TOKEN)
    with pytest.raises(BitcartError) as refused:
        await client.create_invoice({"price": "10.00"})
    message = str(refused.value)
    assert "401" in message
    assert TOKEN not in message
    assert len(message) < 400


async def test_bitcart_get_retries_once_but_create_does_not(monkeypatch: pytest.MonkeyPatch) -> None:
    """Повтор есть только у GET: `POST /api/invoices` не идемпотентен (§6).

    Повтор создания после таймаута завёл бы на шлюзе второй счёт на те же
    деньги и дал бы клиенту два адреса.
    """
    real_client = httpx.AsyncClient
    calls: list[str] = []
    get_attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal get_attempts
        calls.append(request.method)
        if request.method == "POST":
            raise httpx.ConnectError("down")
        get_attempts += 1
        if get_attempts == 1:
            raise httpx.ConnectError("down")
        return httpx.Response(200, json={"id": "inv-1", "status": "pending"})

    def factory(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    client = BitcartClient("https://pay.example.test", TOKEN)

    assert (await client.get_invoice("inv-1"))["id"] == "inv-1"
    assert get_attempts == 2, "транспортная ошибка GET — один безопасный повтор"

    with pytest.raises(BitcartError):
        await client.create_invoice({"price": "10.00"})
    assert calls.count("POST") == 1, "создание счёта не повторяется"


async def test_bitcart_broken_answers_are_errors_not_crashes(monkeypatch: pytest.MonkeyPatch) -> None:
    """HTML вместо JSON и пустой адрес — `BitcartError`, а не трейсбек."""
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>maintenance</html>")

    def factory(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    with pytest.raises(BitcartError, match="не JSON"):
        await BitcartClient("https://pay.example.test", TOKEN).create_invoice({"price": "10.00"})
    with pytest.raises(BitcartError, match="адрес Bitcart"):
        await BitcartClient("", TOKEN).create_invoice({"price": "10.00"})
