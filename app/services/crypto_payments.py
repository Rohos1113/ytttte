"""Приём крипты: счёт у Bitcart → проверка у Bitcart → проводка в леджере.

Деньги здесь не «подтверждаются вебхуком». Уведомление Bitcart приходит без
подписи и без ретраев (`docs/CRYPTO-TOPUP-BITCART.md` §10), поэтому тело
вебхука — это только повод сходить к шлюзу (`docs/CRYPTO-TOPUP-CONTRACT.md` §8).
Авторитетный источник — `GET /api/invoices/{id}`: статус, фактическая сумма и
хеши берутся оттуда. Доверять телу значило бы позволить любому, кто узнал
секретный адрес, нарисовать себе `complete` и кредиты.

**Два пути к одному начислению.** Вебхук приходит, когда доставка удалась;
фоновая сверка (`sync_pending`) добирает то, что потерялось, — это не «на
всякий случай», а обязательный второй путь. Идемпотентность держит один
условный UPDATE: `credited` встаёт только тому, кто выиграл переход из
`new|paid|partial`. Победитель ровно один, поэтому двойной вебхук и
одновременная сверка не могут начислить дважды.

**Порядок «сначала своя строка, потом чужой вызов».** Счёт заводится у себя
(``status='new'``) ДО `POST /api/invoices`. Шлюз может не ответить: в этом
случае строка остаётся `error` с причиной, но адрес и сумма уже наши — и
видно, что клиент пытался пополниться. Обратный порядок терял бы счета,
созданные на стороне шлюза, при падении на записи.

**Что не начисляется.** `paid` и `confirmed` — промежуточные: подтверждения
ещё идут, а отменить `complete` шлюз уже не может. Недоплата
(`paid_partial`) — `partial` без начисления: сколько зачислить за половину
суммы, решает человек, а не код. Переплата (`paid_over`) — по факту, разница
в memo.

Сумма начисления пересчитывается из фактической цены шлюза
(`effective_price`), а не из того, что клиент попросил: курс ходит, и
начислить по запрошенному при недоплате значило бы подарить разницу.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from loguru import logger
from sqlalchemy import and_, func, or_, select, text, update

from app.models import CryptoInvoice
from app.services.bitcart_client import BitcartClient, BitcartError
from app.services.credit_ledger import topup
from app.services.credits import usd_per_credit
from app.settings import settings

#: Микрокредитов в кредите. Имя из контракта (§7): считаем «кредиты × 10⁶»,
#: потому что леджер хранит именно микрокредиты.
CREDITS_PER_MICRO = 1_000_000

#: Микродолларов в долларе.
USD_MICRO = 1_000_000

#: Наш статус счёта: открытые (ждём денег), закрытые (начислено или поздно).
OPEN_STATUSES: tuple[str, ...] = ("new", "paid", "partial")
CLOSED_STATUSES: tuple[str, ...] = ("credited", "refunded", "expired", "invalid", "error")
#: Из каких статусов CAS пускает в `credited`. `expired` здесь намеренно: шлюз
#: мог закрыть счёт по времени, а платёж прийти в последнюю минуту и подтвердиться
#: позже. Деньги в этом случае реальные, и вебхук с `complete` обязан их зачесть
#: — иначе клиент заплатил и остался без кредитов. `invalid`/`refunded`/`error`
#: остаются закрытыми: там шлюз прямо говорит, что денег нет или их вернули.
CREDITABLE_STATUSES: tuple[str, ...] = (*OPEN_STATUSES, "expired")

#: Ключи ответа шлюза, которые нельзя хранить в `raw`: в `notification_url`
#: лежит секрет вебхука.
_SECRET_KEYS: frozenset[str] = frozenset({"notification_url"})

#: Задержка перед сверкой счёта: сразу после оплаты шлюзу нужно несколько
#: секунд, чтобы увидеть транзакцию. Дёргать его в ту же секунду — лишний шум.
_STALE_AFTER = timedelta(seconds=20)

#: Возраст счёта, после которого сверка ходит по нему в любом случае: он давно
#: истёк, и его надо закрыть, даже если кто-то только что его читал.
_EXPIRED_AFTER = timedelta(hours=6)

#: Сколько времени после истечения сверка ещё перепроверяет закрытый счёт.
#: Платёж, отправленный за минуту до дедлайна, подтверждается через блоки
#: позже, и шлюз может перевести `expired` в `complete` уже после того, как мы
#: закрылись. Вебхук в этом случае обычно доходит, но полагаться только на него
#: нельзя: IPN у Bitcart без ретраев. Окно — сутки, перепроверка — раз в два
#: часа (12 запросов на счёт, дальше тишина).
_LATE_PAYMENT_WINDOW = timedelta(hours=24)
_LATE_PAYMENT_RECHECK = timedelta(hours=2)

#: Статус Bitcart → наш статус, пока денег ещё не начислено.
_OPEN_STATUS_MAP: dict[str, str] = {
    "pending": "new",
    "new": "new",
    "paid": "paid",
    "confirmed": "paid",
    "unconfirmed": "paid",
    "expired": "expired",
    "invalid": "invalid",
    "refunded": "refunded",
}

#: Сети: как их называет Bitcart → как их понимает человек. Неизвестное
#: оставляем сырой строкой: выдуманное имя сети хуже непонятного.
_NETWORK_ALIASES: dict[str, str] = {
    "btc": "bitcoin",
    "bitcoin": "bitcoin",
    "ltc": "litecoin",
    "litecoin": "litecoin",
    "bch": "bitcoin-cash",
    "bitcoin-cash": "bitcoin-cash",
    "bitcoincash": "bitcoin-cash",
    "eth": "ethereum",
    "ethereum": "ethereum",
    "trx": "tron",
    "tron": "tron",
    "bnb": "bsc",
    "bsc": "bsc",
    "binance": "bsc",
    "polygon": "polygon",
    "matic": "polygon",
    "xmr": "monero",
    "monero": "monero",
}

#: Цепочки EIP-155 → имя сети. Пришло `eip155:1` — это ethereum, а не «eip155».
_EIP155_NETWORKS: dict[str, str] = {
    "1": "ethereum",
    "56": "bsc",
    "137": "polygon",
    "42161": "arbitrum",
    "10": "optimism",
}

#: Человеческие имена монет для label. Нет в словаре — берём верхний регистр.
_ASSET_LABELS: dict[str, str] = {
    "btc": "BTC",
    "ltc": "LTC",
    "bch": "BCH",
    "eth": "ETH",
    "trx": "TRX",
    "bnb": "BNB",
    "usdt": "USDT",
    "usdc": "USDC",
    "dai": "DAI",
    "xmr": "XMR",
}

#: Как назвать сеть в label: у токенов это стандарт, у своих монет — имя сети.
_NETWORK_LABELS: dict[str, str] = {
    "tron": "TRON",
    "ethereum": "ERC-20",
    "bsc": "BEP-20",
    "polygon": "Polygon",
    "bitcoin": "Bitcoin",
    "litecoin": "Litecoin",
    "bitcoin-cash": "Bitcoin Cash",
    "monero": "Monero",
}


class TopupUnavailable(RuntimeError):
    """Пополнение недоступно: флаг выключен, шлюз не настроен или не ответил."""


class TopupLimitReached(RuntimeError):
    """У арендатора слишком много открытых счетов. Ошибка клиента, не сервера."""


#: Тексты отказов «фича недоступна». Одни на сервис и на роутер: клиент
#: обязан видеть одинаковую причину, откуда бы проверка ни сработала — до
#: вызова сервиса (роутер) или внутри него.
MSG_DISABLED = "Пополнение криптовалютой выключено администратором студии"
MSG_NOT_CONFIGURED = (
    "Крипто-платежи не настроены: нужны BITCART_URL, BITCART_STORE_ID и BITCART_TOKEN"
)


def bitcart_configured() -> bool:
    """Есть ли всё, чтобы говорить со шлюзом. Пусто — ручки отвечают 503."""
    return bool(
        settings.bitcart_url.strip()
        and settings.bitcart_store_id.strip()
        and settings.bitcart_token.strip()
    )


def _now() -> datetime:
    """Наивный UTC: так время хранится во всей базе."""
    return datetime.now(UTC).replace(tzinfo=None)


def _client() -> BitcartClient:
    """Клиент из настроек. Одна фабрика на модуль — её и подменяют в тестах."""
    return BitcartClient(
        settings.bitcart_url,
        settings.bitcart_token,
        timeout=float(settings.crypto_bitcart_timeout_s),
    )


def _decimal(value: Any) -> Decimal | None:
    """Строгое число из чего угодно строкоподобного. ``None`` — не число."""
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, ArithmeticError):
        return None
    if not parsed.is_finite():
        return None
    return parsed


def _amount_str(value: Any) -> str:
    """Сумма как её отдал шлюз — строкой и без потери знаков."""
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value)


def to_usd_micro(usd: Decimal | float | str) -> int:
    """Доллары → микродоллары, вниз. Округление вниз — не дарим лишнего."""
    value = _decimal(usd)
    if value is None or value <= 0:
        return 0
    return int((value * USD_MICRO).to_integral_value(rounding=ROUND_FLOOR))


def credits_micro_for_usd(usd: Decimal | float | str) -> int:
    """Доллары → микрокредиты по текущему курсу, вниз (§2 контракта).

    Курс берётся из `usd_per_credit()`, а не из своей константы: переключение
    «1$ = 100 кредитов» не должно требовать правок здесь.
    """
    value = _decimal(usd)
    if value is None or value <= 0:
        return 0
    micro = value / usd_per_credit() * CREDITS_PER_MICRO
    return int(micro.to_integral_value(rounding=ROUND_FLOOR))


def _parse_amount(amount_usd: Any) -> Decimal:
    """Сумма из запроса: квантуем до центов, мусор — ``ValueError`` (роутер → 400)."""
    value = _decimal(amount_usd)
    if value is None:
        raise ValueError("сумма пополнения — число, например 10.00")
    # Квантуем ДО проверки лимитов: 4.999 не должно проскочить под минимум 5,
    # а 500.004 — над максимумом 500.
    try:
        value = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, OverflowError) as exc:
        # `1e100` и сорокозначные суммы — не деньги, а попытка сломать разбор:
        # `quantize` на них бросает InvalidOperation (это ArithmeticError, мимо
        # `ValueError`), и без этой ветки ручка отвечала 500 вместо 400.
        raise ValueError("сумма пополнения — не больше 500.00") from exc
    if value <= 0:
        raise ValueError("сумма пополнения должна быть больше нуля")
    return value


def limit_bounds_usd() -> tuple[Decimal, Decimal]:
    """Границы пополнения из настроек, в долларах."""
    low = _decimal(settings.crypto_topup_min_usd) or Decimal(0)
    high = _decimal(settings.crypto_topup_max_usd) or Decimal(0)
    return low, high


def _network_name(raw: Any) -> str:
    """Сеть в человеческом виде. Непонятное — сырой строкой, как пришло."""
    value = str(raw or "").strip().lower()
    if not value:
        return ""
    if value in _NETWORK_ALIASES:
        return _NETWORK_ALIASES[value]
    prefix, _, tail = value.partition(":")
    if prefix == "eip155" and tail in _EIP155_NETWORKS:
        return _EIP155_NETWORKS[tail]
    if value.startswith("tron"):
        return "tron"
    if "binance" in value or value.startswith("bsc"):
        return "bsc"
    return value


def _split_asset(currency: Any, wallet_network: Any) -> tuple[str, str]:
    """Монета и сеть из валюты метода плюс сети кошелька.

    Bitcart называет токен по-разному: у нативной монеты сеть приходит из
    кошелька, у токена — иногда суффиксом валюты (`usdt_trx`). Разбираем оба
    случая, иначе в истории останется `usdt_trx`, а в label — «USDT_TRX ()».
    """
    asset = str(currency or "").strip().lower()
    implied = ""
    for separator in ("_", "-", ":"):
        if separator not in asset:
            continue
        head, _, tail = asset.partition(separator)
        tail_network = _network_name(tail)
        if head and tail_network:
            asset, implied = head, tail_network
        break
    network = _network_name(wallet_network) if str(wallet_network or "").strip() else implied
    return asset, network


def _method_label(asset: str, network: str) -> str:
    """«USDT (TRON)» — то, что человек выбирает в модалке."""
    coin = _ASSET_LABELS.get(asset, asset.upper() if asset else "Криптовалюта")
    net = _NETWORK_LABELS.get(network, network.upper() if network else "")
    if not net or net.lower() == coin.lower():
        return coin
    return f"{coin} ({net})"


def normalize_methods(invoice: dict) -> list[dict]:
    """Методы оплаты счёта для фронта. Терпимо: непонятное поле — не отказ.

    Шлюз вправе добавить или переименовать поле, и падать на этом значит
    показывать клиенту пустой экран вместо адреса. Метод без адреса
    пропускается: отправить на него всё равно нечего.
    """
    methods: list[dict] = []
    raw_payments = invoice.get("payments")
    if not isinstance(raw_payments, list):
        return methods
    invoice_confirmations = invoice.get("required_confirmations")
    invoice_sender_required = invoice.get("sender_address_required")
    for payment in raw_payments:
        if not isinstance(payment, dict):
            continue
        wallet = payment.get("wallet")
        wallet = wallet if isinstance(wallet, dict) else {}
        address = str(payment.get("payment_address") or payment.get("lookup_field") or "").strip()
        if not address:
            continue
        asset, network = _split_asset(payment.get("currency"), wallet.get("network") or payment.get("network"))
        methods.append(
            {
                "asset": asset,
                "network": network,
                "label": _method_label(asset, network),
                "amount": _amount_str(payment.get("amount")),
                "address": address,
                "uri": str(payment.get("payment_url") or "").strip(),
                "required_confirmations": _as_int(
                    payment.get("required_confirmations", invoice_confirmations)
                ),
                "sender_address_required": bool(
                    payment.get("sender_address_required", invoice_sender_required)
                ),
            }
        )
    return methods


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _scrub(value: Any) -> Any:
    """Убрать секреты из ответа шлюза, не ломая его форму.

    `notification_url` содержит секрет вебхука целиком — положить его в `raw`
    значило бы разложить ключ по каждому дампу базы и каждому бэкапу.
    """
    if isinstance(value, dict):
        return {str(k): ("***" if str(k) in _SECRET_KEYS else _scrub(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def _notification_url() -> str:
    """Адрес вебхука для шлюза. Пусто — уведомлений не будет, работает сверка."""
    base = settings.studio_public_base
    secret = (settings.crypto_webhook_secret or "").strip()
    if not base or not secret:
        return ""
    return f"{base}/api/crypto/webhook/{secret}"


def _expiry_from_response(data: dict, fallback_minutes: int) -> datetime:
    """Срок счёта: сколько сказал шлюз, иначе наш срок из настроек."""
    for key in ("expiration_seconds", "time_left"):
        seconds = _decimal(data.get(key))
        if seconds is not None and seconds > 0:
            return _now() + timedelta(seconds=float(seconds))
    return _now() + timedelta(minutes=max(1, int(fallback_minutes)))


def _rate_from(data: dict) -> str:
    """Курс из ответа шлюза — справочно, строкой.

    Прямого поля может не быть (у Bitcart курс живёт в кошельке), поэтому в
    последнюю очередь считаем «долларов за монету» из price/amount: это
    честная производная, а не догадка.
    """
    for key in ("rate", "exchange_rate", "rate_usd"):
        value = data.get(key)
        if value is not None and value != "":
            parsed = _decimal(value)
            return str(parsed) if parsed is not None else str(value)
    price = _decimal(data.get("price"))
    amount = _decimal(data.get("amount"))
    if price is not None and amount is not None and price > 0 and amount > 0:
        try:
            return str((price / amount).quantize(Decimal("0.00000001")))
        except (InvalidOperation, OverflowError):
            # Курс — справочное поле. Мусор в ответе шлюза не повод ронять
            # сверку счёта: без курса платёж всё равно зачислится.
            return ""
    return ""


def _tx_hashes(data: dict) -> list[str]:
    raw = data.get("tx_hashes")
    if isinstance(raw, list):
        return [str(item) for item in raw if item]
    single = data.get("tx_hash")
    if isinstance(single, str) and single.strip():
        return [single.strip()]
    return []


def _apply_method_hint(inv: CryptoInvoice, methods: list[dict]) -> None:
    """Первый метод — в поля строки: историю платежа видно без разбора JSON."""
    first = methods[0]
    inv.asset = str(first.get("asset") or "")[:16]
    inv.network = str(first.get("network") or "")[:32]
    inv.address = str(first.get("address") or "")[:128]
    inv.payment_url = str(first.get("uri") or "")[:512]
    if first.get("amount"):
        inv.expected_amount = str(first["amount"])[:64]


def _effective_usd(inv: CryptoInvoice) -> Decimal:
    """Сколько долларов реально пришло: цена шлюза, иначе запрошенная сумма."""
    raw = inv.raw if isinstance(inv.raw, dict) else {}
    for key in ("effective_price", "paid_price"):
        parsed = _decimal(raw.get(key))
        if parsed is not None and parsed > 0:
            return parsed
    return Decimal(int(inv.amount_usd_micro)) / USD_MICRO


def _settlement_memo(inv: CryptoInvoice, amount_usd: Decimal, overpaid: bool) -> str:
    asset = (inv.asset or "crypto").upper()
    network = inv.network or "—"
    memo = f"Пополнение криптовалютой: {amount_usd:.2f}$ ({asset}/{network}), счёт {str(inv.id)[:8]}"
    if overpaid:
        memo += " — переплата, начислено по факту"
    return memo[:240]


async def allow_all_tenants(session: Any) -> None:
    """Поднять «админский» проход там, где запроса нет: вебхук и сверка.

    В фоне нет ни личности, ни арендатора, а политика RLS при пустом
    `app.tenant_id` показывает только строки владельца (``tenant_id IS NULL``),
    то есть ни одного клиентского счёта: сверка молча не нашла бы работы.
    Настройка локальна для транзакции — как привязка арендатора из `app/db.py`,
    и умирает вместе с ней. На SQLite политик нет, там это no-op.
    """
    if not settings.is_postgres:
        return
    await session.execute(text("select set_config('app.is_admin', 'true', true)"))


async def _mark_error(session: Any, inv: CryptoInvoice, message: str) -> None:
    """Счёт не состоялся: закрыть строку причиной. Деньги клиента не тронуты."""
    inv.status = "error"
    inv.last_error = message[:255]
    inv.updated_at = _now()
    await session.commit()


async def create_topup(session: Any, tenant_id: str, amount_usd: Any) -> CryptoInvoice:
    """Открыть счёт на пополнение. Внешний вызов — после своей строки.

    Бросает: ``TopupUnavailable`` (флаг/конфиг/шлюз → 503),
    ``TopupLimitReached`` (слишком много открытых → 429),
    ``ValueError`` (сумма/лимиты → 400).
    """
    if not settings.crypto_topup_enabled:
        raise TopupUnavailable(MSG_DISABLED)
    if not bitcart_configured():
        raise TopupUnavailable(MSG_NOT_CONFIGURED)
    usd = _parse_amount(amount_usd)
    min_usd, max_usd = limit_bounds_usd()
    if usd < min_usd or (max_usd > 0 and usd > max_usd):
        raise ValueError(f"Сумма пополнения — от {min_usd:.0f} до {max_usd:.0f} USD")
    max_open = max(1, int(settings.crypto_topup_max_open))
    # Считаем и `partial`, хотя контракт называет только new|paid: недоплата —
    # не закрытый счёт, по нему ещё предстоит разбор, и разрешать поверх него
    # бесконечно открывать новые значило бы дать лимиту дырку.
    open_count = (
        await session.execute(
            select(func.count())
            .select_from(CryptoInvoice)
            .where(CryptoInvoice.tenant_id == tenant_id, CryptoInvoice.status.in_(OPEN_STATUSES))
        )
    ).scalar_one()
    if int(open_count) >= max_open:
        raise TopupLimitReached(
            f"Открытых счетов уже {int(open_count)}: оплатите или дождитесь истечения прежних"
        )

    inv = CryptoInvoice(
        id=str(uuid.uuid4()),
        tenant_id=tenant_id,
        provider="bitcart",
        external_id=None,
        amount_usd_micro=to_usd_micro(usd),
        credits_micro=credits_micro_for_usd(usd),
        status="new",
        expires_at=_now() + timedelta(minutes=max(1, int(settings.crypto_topup_expiration_min))),
        created_at=_now(),
        updated_at=_now(),
    )
    session.add(inv)
    await session.flush()

    payload: dict[str, Any] = {
        "price": f"{usd:.2f}",
        "currency": "USD",
        "store_id": settings.bitcart_store_id.strip(),
        "order_id": str(inv.id),
        "expiration": max(1, int(settings.crypto_topup_expiration_min)),
    }
    notification_url = _notification_url()
    if notification_url:
        payload["notification_url"] = notification_url
    base = settings.studio_public_base
    if base:
        # Клиент после оплаты возвращается в студию, а не остаётся на чужой
        # странице шлюза — иначе он не увидит, что кредиты уже пришли. Адрес —
        # `/home`: страницы `/balance` в студии нет, редирект туда дал бы 404.
        payload["redirect_url"] = f"{base}/home"

    try:
        data = await _client().create_invoice(payload)
    except BitcartError as exc:
        logger.warning("crypto: шлюз не принял счёт {}: {}", str(inv.id)[:8], exc)
        await _mark_error(session, inv, f"шлюз недоступен: {exc}")
        raise TopupUnavailable("Крипто-шлюз сейчас недоступен, попробуйте через минуту") from exc

    external_id = str(data.get("id") or "").strip()
    if not external_id:
        await _mark_error(session, inv, "шлюз вернул счёт без идентификатора")
        raise TopupUnavailable("Крипто-шлюз ответил не полностью, попробуйте ещё раз")

    inv.external_id = external_id[:64]
    inv.invoice_status = str(data.get("status") or "")[:16]
    inv.expires_at = _expiry_from_response(data, int(settings.crypto_topup_expiration_min))
    inv.rate_usd = _rate_from(data)[:64]
    inv.raw = _scrub(data)
    methods = normalize_methods(data)
    inv.methods = methods
    if methods:
        _apply_method_hint(inv, methods)
    else:
        # Методов нет — шлюз не привязал кошельки. Счёт открыт, но платить
        # некуда: пусть это будет видно, а не превратится в пустой экран.
        inv.expected_amount = _amount_str(data.get("amount"))[:64]
    inv.updated_at = _now()
    await session.commit()
    logger.info(
        "crypto: счёт {} открыт на {:.2f}$ ({} методов)",
        str(inv.id)[:8],
        float(usd),
        len(methods),
    )
    return inv


async def refresh_invoice(session: Any, inv: CryptoInvoice) -> CryptoInvoice:
    """Перечитать счёт у шлюза и применить статус. Ошибка шлюза — ``BitcartError``.

    Порядок важен: сперва спрашиваем шлюз, потом пишем. Если шлюз не ответил,
    строка остаётся как была, и клиент видит последнее известное состояние, а
    не «счёт сломался».
    """
    external_id = str(inv.external_id or "").strip()
    if not external_id:
        return inv
    data = await _client().get_invoice(external_id)
    inv.invoice_status = str(data.get("status") or "")[:16]
    inv.exception_status = str(data.get("exception_status") or "")[:16]
    methods = normalize_methods(data)
    if methods:
        inv.methods = methods
        if not inv.address:
            _apply_method_hint(inv, methods)
    amount = _amount_str(data.get("amount"))
    if amount:
        inv.expected_amount = amount[:64]
    rate = _rate_from(data)
    if rate:
        inv.rate_usd = rate[:64]
    hashes = _tx_hashes(data)
    if hashes:
        inv.tx_hashes = hashes
    paid_currency = str(data.get("paid_currency") or "").strip()
    if paid_currency:
        # Чем реально заплатили, а не что предлагали: для истории важнее факт.
        inv.asset = paid_currency.lower()[:16]
    inv.raw = _scrub(data)
    inv.last_error = ""
    inv.updated_at = _now()
    await session.flush()
    await apply_settlement(session, inv)
    await session.commit()
    return inv


def _map_open_status(inv: CryptoInvoice, raw_status: str, exception_status: str) -> None:
    """Статус до начисления: только представление, денег не трогает."""
    if exception_status == "paid_partial" and raw_status != "complete":
        # Деньги пришли, но меньше: сколько зачесть — вопрос к человеку.
        inv.status = "partial"
        return
    mapped = _OPEN_STATUS_MAP.get(raw_status)
    if mapped is not None:
        inv.status = mapped


async def _claim_for_credit(session: Any, inv: CryptoInvoice) -> bool:
    """CAS: право начислить получает ровно один проход.

    ``UPDATE ... WHERE status IN ('new','paid','partial')`` — одна операция,
    между проверкой и записью нет щели, в которую влезет второй вебхук или
    сверка. На Postgres добавлен `RETURNING` (одним кругом), на SQLite —
    `rowcount`: RETURNING там зависит от версии движка, а поведение должно
    быть одинаковым.
    """
    now = _now()
    statement = (
        update(CryptoInvoice)
        .where(CryptoInvoice.id == inv.id, CryptoInvoice.status.in_(CREDITABLE_STATUSES))
        .values(status="credited", settled_at=now, updated_at=now)
    )
    if settings.is_postgres:
        won = (await session.execute(statement.returning(CryptoInvoice.id))).scalar_one_or_none() is not None
    else:
        won = bool((await session.execute(statement)).rowcount)
    if not won:
        logger.info("crypto: счёт {} уже начислен или закрыт — второй проход пропущен", str(inv.id)[:8])
    return won


async def apply_settlement(session: Any, inv: CryptoInvoice) -> bool:
    """Единственное место начисления. ``True`` — кредиты зачислены этим вызовом."""
    raw_status = (inv.invoice_status or "").strip().lower()
    exception_status = (inv.exception_status or "").strip().lower()
    if inv.status in CLOSED_STATUSES and not (inv.status == "expired" and raw_status == "complete"):
        # `expired` — исключение: счёт закрыли по времени, а шлюз потом увидел
        # платёж и сказал `complete`. Это настоящие деньги, и терять их нельзя.
        return False

    if raw_status != "complete":
        _map_open_status(inv, raw_status, exception_status)
        inv.updated_at = _now()
        await session.flush()
        return False

    amount_usd = _effective_usd(inv)
    credits_micro = credits_micro_for_usd(amount_usd)
    if credits_micro <= 0:
        # Шлюз сказал complete, а суммы нет. Начислять нечего, но и держать
        # счёт открытым нельзя: сверка ходила бы по нему вечно. Закрываем с
        # причиной — разбор ручной.
        logger.error("crypto: счёт {} complete без суммы — закрыт с ошибкой", str(inv.id)[:8])
        inv.status = "error"
        inv.last_error = "шлюз сообщил complete, но фактическая сумма нулевая"
        inv.updated_at = _now()
        await session.flush()
        return False

    if not await _claim_for_credit(session, inv):
        return False

    overpaid = exception_status == "paid_over"
    entry_id = str(uuid.uuid4())
    try:
        await topup(
            session,
            inv.tenant_id,
            credits_micro,
            memo=_settlement_memo(inv, amount_usd, overpaid),
            ref_table="crypto_invoices",
            ref_ids=[str(inv.id)],
            entry_id=entry_id,
        )
        inv.status = "credited"
        inv.credits_micro = credits_micro
        inv.credited_entry_id = entry_id
        inv.settled_at = _now()
        inv.updated_at = _now()
        inv.last_error = ""
        # CAS и проводка — одна транзакция: если проводка не записалась, статус
        # `credited` откатится вместе с ней, и сверка повторит начисление.
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    logger.info(
        "crypto: счёт {} оплачен — {} микрокредитов за {:.2f}$",
        str(inv.id)[:8],
        credits_micro,
        float(amount_usd),
    )
    return True


async def sync_pending(session: Any, limit: int = 25) -> int:
    """Фоновая сверка: добрать счета, по которым не дошёл вебхук.

    Берём открытые счета, которые не обновлялись дольше 20 секунд, и —
    отдельно — давно истёкшие (их надо закрыть, даже если кто-то только что
    их читал). Ошибка шлюза на одном счёте не валит пачку: следующий проход
    никуда не денется. Возвращает число успешно сверенных счетов.
    """
    if not settings.crypto_topup_enabled or not bitcart_configured():
        return 0
    await allow_all_tenants(session)
    moment = _now()
    stale = (
        (
            await session.execute(
                select(CryptoInvoice)
                .where(
                    or_(
                        # Обычный случай: открытый счёт, который давно не читали.
                        and_(
                            CryptoInvoice.status.in_(OPEN_STATUSES),
                            CryptoInvoice.updated_at < moment - _STALE_AFTER,
                        ),
                        # Давно истёкший и всё ещё открытый: закрыть, даже если
                        # его только что читали. Статус обязателен — иначе уже
                        # закрытый счёт с протухшим `expires_at` попадал бы в
                        # выборку каждый проход и вечно дёргал шлюз.
                        and_(
                            CryptoInvoice.status.in_(OPEN_STATUSES),
                            CryptoInvoice.expires_at < moment - _EXPIRED_AFTER,
                        ),
                        # Поздняя оплата: счёт закрыт по времени недавно — шлюз
                        # мог передумать и увидеть платёж. Перепроверяем редко.
                        and_(
                            CryptoInvoice.status == "expired",
                            CryptoInvoice.expires_at > moment - _LATE_PAYMENT_WINDOW,
                            CryptoInvoice.updated_at < moment - _LATE_PAYMENT_RECHECK,
                        ),
                    )
                )
                .order_by(CryptoInvoice.updated_at)
                .limit(max(1, int(limit)))
            )
        )
        .scalars()
        .all()
    )
    # id — строками и до первого отката. Откат протухает все объекты сессии,
    # поэтому `inv.external_id` на следующем круге читался бы ленивой
    # подгрузкой вне greenlet (MissingGreenlet), и это исключение вылетало бы
    # уже из обработчика: один сломанный счёт убивал всю пачку, а оплаченные
    # после него не сверялись вовсе. С id строкой счёт перечитывается заново.
    invoice_keys = [str(inv.id) for inv in stale]
    processed = 0
    for invoice_key in invoice_keys:
        try:
            # Каждый счёт может закоммитить начисление — настройка админского
            # прохода локальна для транзакции, поэтому поднимаем её заново.
            await allow_all_tenants(session)
            inv = await session.get(CryptoInvoice, invoice_key)
            if inv is None:
                continue
            await refresh_invoice(session, inv)
            processed += 1
        except Exception:  # noqa: BLE001 — один счёт не должен валить пачку
            await session.rollback()
            session.expunge_all()
            logger.exception("crypto: сверка счёта {} упала", invoice_key[:8])
    return processed


async def crypto_sync_loop(interval_s: float = 60.0) -> None:
    """Фоновый цикл сверки. Задача гасится отменой из lifespan.

    Цикл ничего не решает сам: он только просит `sync_pending` сходить к
    шлюзу. Поэтому любое исключение здесь — повод для записи в журнал и
    следующего круга, а не для падения фоновой задачи: молча умершая сверка
    означала бы оплаченные и не зачисленные деньги.
    """
    from app.db import session_scope

    while True:
        await asyncio.sleep(max(1.0, float(interval_s)))
        try:
            async with session_scope() as session:
                await sync_pending(session)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("crypto: фоновая сверка счетов упала")
