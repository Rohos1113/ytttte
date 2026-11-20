"""Ручки крипто-пополнения: счёт для модалки, поллинг, вебхук Bitcart.

Проверяется то, что видно снаружи (`docs/CRYPTO-TOPUP-CONTRACT.md` §8,
§11, §13), и три границы доверия:

* **вебхук — чужой сервис.** Токена у него нет, признак «свой» — секрет в
  пути; тело ничего не решает, статус берётся из повторного запроса к шлюзу.
  Поэтому «body `complete`, а шлюз `pending`» обязан не начислить ничего;
* **чужой счёт — 404, а не 403.** Существование чужого платежа — тоже
  сведения; и до шлюза запрос чужого арендатора не доходит;
* **недоступный шлюз — не 500.** Клиент обязан увидеть «ждём оплату» и
  таймер (последнее известное состояние, `stale: true`), а не пустой экран
  поверх оплаченного счёта.

Мок шлюза общий с `tests/test_crypto_payments.py`: те же ответы, то же
обещание «без сети».
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models import CreditEntry, CryptoInvoice
from app.services import credit_ledger as cl
from app.services import crypto_payments as cp
from app.services.bitcart_client import BitcartError
from app.settings import settings
from app.web.api import create_app
from app.web.deps import get_session
from tests import accounts_harness as ah
from tests.test_crypto_payments import STORE_ID, STUDIO_BASE, TOKEN, WEBHOOK_SECRET, FakeBitcart

#: Что модалка обязана получить от шлюза — один метод USDT-TRC20.
EXPECTED_METHODS: list[dict[str, Any]] = [
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


@dataclass
class CryptoApi:
    """Приложение, база и два арендатора: по одному на «свой» и «чужой»."""

    app: Any
    client: AsyncClient
    factory: async_sessionmaker
    fake: FakeBitcart
    alice: ah.Account
    bob: ah.Account


def _naive_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@pytest_asyncio.fixture
async def api(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[CryptoApi]:
    """Студия в режиме учётных записей поверх SQLite и мок шлюза без сети.

    Учётные записи включены намеренно: тогда вебхук проверяется в том же
    режиме, что прод, — без токена и с работающим middleware личности.
    """
    ah.configure(monkeypatch)
    engine, factory = await ah.make_engine(tmp_path / "crypto-web.db")
    ah.bind_identity_session(monkeypatch, factory)

    monkeypatch.setattr(settings, "crypto_topup_enabled", True)
    monkeypatch.setattr(settings, "bitcart_url", "https://pay.example.test/")
    monkeypatch.setattr(settings, "bitcart_store_id", STORE_ID)
    monkeypatch.setattr(settings, "bitcart_token", TOKEN)
    monkeypatch.setattr(settings, "crypto_webhook_secret", WEBHOOK_SECRET)
    monkeypatch.setattr(settings, "studio_public_url", STUDIO_BASE)
    monkeypatch.setattr(settings, "crypto_topup_min_usd", 5.0)
    monkeypatch.setattr(settings, "crypto_topup_max_usd", 500.0)
    monkeypatch.setattr(settings, "crypto_topup_expiration_min", 30)
    monkeypatch.setattr(settings, "crypto_topup_max_open", 10)
    monkeypatch.setattr(settings, "credit_usd_rate", 1.0)

    fake = FakeBitcart()
    monkeypatch.setattr(cp, "_client", lambda: fake)

    alice = await ah.make_account(factory, email="alice@studio.local")
    bob = await ah.make_account(factory, email="bob@studio.local")

    async def _session() -> Any:
        async with factory() as session:
            yield session

    app = create_app()
    app.dependency_overrides[get_session] = _session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield CryptoApi(app=app, client=client, factory=factory, fake=fake, alice=alice, bob=bob)
    await engine.dispose()


async def _create(api: CryptoApi, amount: str = "10.00", account: ah.Account | None = None) -> dict[str, Any]:
    response = await api.client.post(
        "/api/billing/topup/crypto",
        json={"amount_usd": amount},
        headers=(account or api.alice).auth,
    )
    assert response.status_code == 200, response.text
    invoice: dict[str, Any] = response.json()["invoice"]
    return invoice


async def _age(api: CryptoApi, invoice_id: str, seconds: int = 60) -> None:
    """Состарить счёт, чтобы поллинг пошёл в шлюз (порог 30 с)."""
    async with api.factory() as session:
        row = await session.get(CryptoInvoice, invoice_id)
        assert row is not None
        row.updated_at = _naive_now() - timedelta(seconds=seconds)
        await session.commit()


async def _entries(api: CryptoApi, tenant: str) -> list[CreditEntry]:
    async with api.factory() as session:
        return list(
            (await session.execute(select(CreditEntry).where(CreditEntry.tenant_id == tenant)))
            .scalars()
            .all()
        )


async def _stored(api: CryptoApi, invoice_id: str) -> CryptoInvoice:
    async with api.factory() as session:
        row = await session.get(CryptoInvoice, invoice_id)
        assert row is not None
        return row


async def _balance(api: CryptoApi, tenant: str) -> int:
    async with api.factory() as session:
        return await cl.balance_micro(session, tenant)


async def _external_id(api: CryptoApi, invoice: dict[str, Any]) -> str:
    """id счёта на стороне шлюза — по нему строится тело вебхука."""
    stored = await _stored(api, invoice["id"])
    assert stored.external_id
    return stored.external_id


# ── §11.1. Флаг и настройки ─────────────────────────────────────────────────


async def test_disabled_topup_is_503(api: CryptoApi, monkeypatch: pytest.MonkeyPatch) -> None:
    """Выключенный флаг — 503 с человеческим текстом, до шлюза дело не идёт."""
    monkeypatch.setattr(settings, "crypto_topup_enabled", False)
    response = await api.client.post(
        "/api/billing/topup/crypto", json={"amount_usd": "10.00"}, headers=api.alice.auth
    )
    assert response.status_code == 503
    assert response.json()["detail"] == cp.MSG_DISABLED
    assert api.fake.payloads == []


async def test_unconfigured_topup_is_503(api: CryptoApi, monkeypatch: pytest.MonkeyPatch) -> None:
    """Включено, но BITCART_* пусты — 503 с перечнем того, что не задано."""
    monkeypatch.setattr(settings, "bitcart_url", "")
    monkeypatch.setattr(settings, "bitcart_store_id", "")
    monkeypatch.setattr(settings, "bitcart_token", "")
    response = await api.client.post(
        "/api/billing/topup/crypto", json={"amount_usd": "10.00"}, headers=api.alice.auth
    )
    assert response.status_code == 503
    assert response.json()["detail"] == cp.MSG_NOT_CONFIGURED


async def test_topup_requires_identity(api: CryptoApi) -> None:
    """Токен нужен как у `/billing/balance`: своих способов «кто я» не заводим."""
    assert settings.accounts_enabled, "тест имеет смысл только в режиме учётных записей"
    response = await api.client.post("/api/billing/topup/crypto", json={"amount_usd": "10.00"})
    assert response.status_code == 401


# ── §11.1–2. Ответ модалке и суммы ──────────────────────────────────────────


async def test_created_invoice_is_ready_for_the_modal(api: CryptoApi) -> None:
    """Ответ 200: id, сумма строкой, кредиты строкой, методы, warning, `Z`.

    Строки, а не числа: фронт не должен парсить деньги во float.
    """
    response = await api.client.post(
        "/api/billing/topup/crypto", json={"amount_usd": "10.00"}, headers=api.alice.auth
    )
    assert response.status_code == 200
    invoice = response.json()["invoice"]
    uuid.UUID(invoice["id"])
    assert invoice["status"] == "new"
    assert invoice["amount_usd"] == "10.00"
    assert invoice["credits"] == "10"
    assert invoice["expires_at"].endswith("Z")
    assert invoice["methods"] == EXPECTED_METHODS
    assert invoice["warning"] and "Отправляйте только" in invoice["warning"]
    # Запрос к шлюзу собран из настроек, а не из тела клиента.
    payload = api.fake.payloads[0]
    assert payload["price"] == "10.00"
    assert payload["order_id"] == invoice["id"]
    assert payload["store_id"] == STORE_ID
    assert payload["notification_url"] == f"{STUDIO_BASE}/api/crypto/webhook/{WEBHOOK_SECRET}"
    # Ни токен шлюза, ни секрет вебхука в ответ клиенту не попадают.
    assert WEBHOOK_SECRET not in response.text
    assert TOKEN not in response.text


@pytest.mark.parametrize("amount", ["abc", 1, 10000, None])
async def test_bad_amount_is_400(api: CryptoApi, amount: Any) -> None:
    """Мусор и суммы вне лимитов — 400, а не 500 и не «счёт на что-нибудь»."""
    response = await api.client.post(
        "/api/billing/topup/crypto", json={"amount_usd": amount}, headers=api.alice.auth
    )
    assert response.status_code == 400
    assert api.fake.payloads == []


async def test_too_many_open_invoices_are_429(api: CryptoApi, monkeypatch: pytest.MonkeyPatch) -> None:
    """Больше лимита открытых счетов — 429: это отказ клиенту, не сбой."""
    monkeypatch.setattr(settings, "crypto_topup_max_open", 1)
    await _create(api)
    response = await api.client.post(
        "/api/billing/topup/crypto", json={"amount_usd": "10.00"}, headers=api.alice.auth
    )
    assert response.status_code == 429


async def test_absurd_amount_is_400_not_500(api: CryptoApi) -> None:
    """Огромная сумма в теле — 400, а не 500 (§8: неверная сумма — ошибка клиента).

    Отдельный клиент с `raise_app_exceptions=False`: целью теста является
    именно код ответа, который увидит клиент при необработанном исключении.
    """
    async with AsyncClient(
        transport=ASGITransport(app=api.app, raise_app_exceptions=False), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/billing/topup/crypto", json={"amount_usd": "1e100"}, headers=api.alice.auth
        )
    assert response.status_code == 400, f"клиент получил {response.status_code} на мусорную сумму"
    detail = response.json()["detail"]
    # Текст для человека, а не трейсбек и не «InvalidOperation».
    assert "сумма" in detail and "InvalidOperation" not in detail


async def test_gateway_down_on_create_is_503_and_leaves_a_trace(api: CryptoApi) -> None:
    """Шлюз не ответил при создании — 503, строка `error` с причиной, без денег.

    Счёт заводится у себя ДО внешнего вызова, поэтому попытка клиента видна
    в истории, даже когда шлюз недоступен (§7 п.4, §13).
    """
    api.fake.create_error = BitcartError("Bitcart ответил 502: bad gateway")
    response = await api.client.post(
        "/api/billing/topup/crypto", json={"amount_usd": "10.00"}, headers=api.alice.auth
    )
    assert response.status_code == 503
    assert "недоступен" in response.json()["detail"]
    async with api.factory() as session:
        rows = list((await session.execute(select(CryptoInvoice))).scalars().all())
    assert len(rows) == 1
    assert rows[0].status == "error"
    assert rows[0].last_error
    assert await _entries(api, api.alice.user_id) == []


# ── §11.8. Чужой счёт и чужие ручки ─────────────────────────────────────────


async def test_foreign_invoice_is_404_and_never_reaches_the_gateway(api: CryptoApi) -> None:
    """Чужой счёт — 404 (не 403): существование платежа тоже сведения.

    Заодно проверяется, что чужой GET не дёргает шлюз: иначе арендатор мог бы
    перебирать id и по времени ответа узнавать, что счёт существует.
    """
    invoice = await _create(api)
    api.fake.get_calls = 0
    response = await api.client.get(f"/api/billing/topup/crypto/{invoice['id']}", headers=api.bob.auth)
    assert response.status_code == 404
    assert api.fake.get_calls == 0


async def test_bad_invoice_id_is_404(api: CryptoApi) -> None:
    """Мусор в пути — 404, а не 500 на приведении к UUID."""
    response = await api.client.get("/api/billing/topup/crypto/not-a-uuid", headers=api.alice.auth)
    assert response.status_code == 404


# ── §11.4–5, 8. Вебхук: тело не решает, секрет решает ───────────────────────


async def test_webhook_credits_by_the_gateway_state(api: CryptoApi) -> None:
    """Вебхук без токена: секрет в пути, начисление — по состоянию шлюза."""
    invoice = await _create(api)
    external_id = await _external_id(api, invoice)
    api.fake.gateway_state(external_id, status="complete", effective_price="10.00")

    response = await api.client.post(
        f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": external_id, "status": "complete"}
    )
    assert settings.accounts_enabled, "вебхук обязан проходить мимо личности в SaaS-режиме"
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    stored = await _stored(api, invoice["id"])
    assert stored.status == "credited"
    assert stored.credits_micro == 10_000_000
    entries = await _entries(api, api.alice.user_id)
    assert len(entries) == 1 and entries[0].delta_micro == 10_000_000
    assert await _balance(api, api.alice.user_id) == 10_000_000


async def test_webhook_body_complete_does_not_trust_the_body(api: CryptoApi) -> None:
    """Пришло `complete`, а шлюз говорит `pending` — начисления нет (§11.5).

    Тело вебхука без подписи: если ему верить, любой, кто узнал адрес,
    нарисует себе `complete` и кредиты.
    """
    invoice = await _create(api)
    external_id = await _external_id(api, invoice)
    api.fake.gateway_state(external_id, status="pending")
    response = await api.client.post(
        f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": external_id, "status": "complete"}
    )
    assert response.status_code == 200
    assert api.fake.get_calls >= 1, "статус обязан быть перепроверен у шлюза"
    stored = await _stored(api, invoice["id"])
    assert stored.status == "new"
    assert await _entries(api, api.alice.user_id) == []


async def test_double_webhook_credits_exactly_once(api: CryptoApi) -> None:
    """Двойной вебхук — одна проводка (CAS, §11.4)."""
    invoice = await _create(api)
    external_id = await _external_id(api, invoice)
    api.fake.gateway_state(external_id, status="complete", effective_price="10.00")
    for _attempt in range(2):
        response = await api.client.post(
            f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": external_id, "status": "complete"}
        )
        assert response.status_code == 200
    assert len(await _entries(api, api.alice.user_id)) == 1
    assert await _balance(api, api.alice.user_id) == 10_000_000


async def test_webhook_wrong_secret_is_404_not_401(api: CryptoApi) -> None:
    """Неверный секрет — 404: не подтверждаем даже существование ручки."""
    invoice = await _create(api)
    response = await api.client.post(
        "/api/crypto/webhook/not-the-secret", json={"id": await _external_id(api, invoice), "status": "complete"}
    )
    assert response.status_code == 404
    assert await _entries(api, api.alice.user_id) == []


async def test_webhook_without_configured_secret_is_404(
    api: CryptoApi, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Секрет не задан — вебхук выключен целиком, даже с верным путём."""
    invoice = await _create(api)
    monkeypatch.setattr(settings, "crypto_webhook_secret", "")
    response = await api.client.post(
        f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": await _external_id(api, invoice), "status": "complete"}
    )
    assert response.status_code == 404


async def test_webhook_broken_json_is_400(api: CryptoApi) -> None:
    """Битое тело — 400 (это отказ клиента, а не сбой обработки)."""
    response = await api.client.post(
        f"/api/crypto/webhook/{WEBHOOK_SECRET}", content=b"{not json", headers={"content-type": "application/json"}
    )
    assert response.status_code == 400


async def test_webhook_unknown_or_id_less_body_is_200_without_credit(api: CryptoApi) -> None:
    """Неизвестный счёт и тело без id — 200 `ok` и никаких денег.

    Отвечать ошибкой нечего: Bitcart не ретраит, а разбирать тело мы всё
    равно не имеем права.
    """
    unknown = await api.client.post(
        f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": "bitcart-inv-unknown", "status": "complete"}
    )
    no_id = await api.client.post(f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"status": "complete"})
    assert unknown.status_code == 200 and unknown.json() == {"ok": True}
    assert no_id.status_code == 200 and no_id.json() == {"ok": True}
    assert await _entries(api, api.alice.user_id) == []


async def test_webhook_gateway_down_is_200_and_keeps_last_known_state(api: CryptoApi) -> None:
    """Шлюз не ответил на вебхук — 200 и прежнее состояние, не 500 (§13).

    500 не повторит доставку (ретраев нет), но зашумит мониторинг; оплату
    доберёт фоновая сверка.
    """
    invoice = await _create(api)
    external_id = await _external_id(api, invoice)
    api.fake.get_errors[external_id] = BitcartError("Bitcart недоступен: ConnectError")
    response = await api.client.post(
        f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": external_id, "status": "complete"}
    )
    assert response.status_code == 200
    stored = await _stored(api, invoice["id"])
    assert stored.status == "new", "строка не должна сломаться от недоступного шлюза"
    assert await _entries(api, api.alice.user_id) == []


# ── §11.3. Поллинг статуса ──────────────────────────────────────────────────


async def test_polling_refreshes_a_stale_invoice(api: CryptoApi) -> None:
    """Запись старше 30 с перечитывается у шлюза и показывает начисление."""
    invoice = await _create(api)
    external_id = await _external_id(api, invoice)
    api.fake.gateway_state(external_id, status="complete", effective_price="10.00")
    await _age(api, invoice["id"], seconds=60)

    response = await api.client.get(f"/api/billing/topup/crypto/{invoice['id']}", headers=api.alice.auth)
    assert response.status_code == 200
    body = response.json()["invoice"]
    assert body["status"] == "credited"
    assert body["credited_credits"] == "10"
    assert body["settled_at"].endswith("Z")
    assert body["updated_at"].endswith("Z")
    assert body["stale"] is False
    assert api.fake.get_calls == 1


async def test_polling_does_not_hit_the_gateway_for_a_fresh_invoice(api: CryptoApi) -> None:
    """Свежий счёт отдаётся из базы: иначе каждый тик модалки бил бы в шлюз."""
    invoice = await _create(api)
    response = await api.client.get(f"/api/billing/topup/crypto/{invoice['id']}", headers=api.alice.auth)
    assert response.status_code == 200
    body = response.json()["invoice"]
    assert body["status"] == "new"
    assert body["stale"] is False
    assert api.fake.get_calls == 0


async def test_polling_reports_stale_when_the_gateway_is_down(api: CryptoApi) -> None:
    """Шлюз недоступен — 200, последнее известное состояние и `stale: true`.

    Модалка обязана показать «ждём оплату» и таймер, а не 500 поверх уже
    оплаченного счёта.
    """
    invoice = await _create(api)
    api.fake.get_errors[await _external_id(api, invoice)] = BitcartError("Bitcart недоступен: ConnectError")
    await _age(api, invoice["id"], seconds=60)

    response = await api.client.get(f"/api/billing/topup/crypto/{invoice['id']}", headers=api.alice.auth)
    assert response.status_code == 200
    body = response.json()["invoice"]
    assert body["stale"] is True
    assert body["status"] == "new"
    assert body["credited_credits"] is None


# ── §13. Секреты не утекают ни в ответы, ни в журнал ────────────────────────


async def test_secrets_never_reach_responses_or_logs(api: CryptoApi) -> None:
    """Ни токен шлюза, ни секрет вебхука не появляются в ответах и в логах.

    Секрет вебхука специально лежит в `notification_url`, который шлюз
    возвращает: утечь он может именно оттуда — в `raw`, в лог ошибки или в
    ответ модалке. Логи собираем с настоящего логгера сервиса.
    """
    messages: list[str] = []

    def _sink(message: Any) -> None:
        messages.append(message.record["message"])

    handler_id = logger.add(_sink, level="DEBUG")
    try:
        invoice = await _create(api)
        external_id = await _external_id(api, invoice)
        created_response = await api.client.post(
            "/api/billing/topup/crypto", json={"amount_usd": "10.00"}, headers=api.alice.auth
        )
        await api.client.post(f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": external_id})
        await api.client.post(f"/api/crypto/webhook/{WEBHOOK_SECRET}", json={"id": external_id, "status": "complete"})
        bad_secret = await api.client.post("/api/crypto/webhook/wrong", json={"id": external_id})
        api.fake.get_errors[external_id] = BitcartError("Bitcart недоступен: ConnectError")
        await _age(api, invoice["id"], seconds=60)
        stale_response = await api.client.get(
            f"/api/billing/topup/crypto/{invoice['id']}", headers=api.alice.auth
        )
    finally:
        logger.remove(handler_id)

    for text in (created_response.text, bad_secret.text, stale_response.text, *messages):
        assert TOKEN not in text
        assert WEBHOOK_SECRET not in text
    # Заодно проверяем, что собранные логи непусты: иначе проверка выше
    # ничего не проверяет.
    assert messages, "логгер не собрал ни одной строки — тест потерял смысл"
