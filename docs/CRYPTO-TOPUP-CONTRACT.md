# Крипто-пополнение через Bitcart — контракт реализации

Рабочая спека для исполнителей. Установка Bitcart — `docs/CRYPTO-TOPUP-BITCART.md`.
Здесь только код студии, который пишем **без сервера**: шлюз подменяется моком в тестах.

## 0. Границы

В этой задаче НЕ делаем:

- не меняем шкалу кредитов (`credit_usd_rate` остаётся как есть; считаем через
  `usd_per_credit()`, чтобы включение курса 1$ = 100 кредитов не потребовало правок);
- не делаем выплаты/возвраты (только приём);
- не трогаем BTCPay/Helius-доку (там история);
- не меняем существующие публичные контракты `/api/billing/*`.

**Решение владельца 17.11.2026: тарифов и подписок нет.** Модель — pay-as-you-go:
пополнил баланс на свободную сумму, тратишь на операции. Следствия для этой задачи:

- в панели «Платежи» сетка тарифов (`PLANS`, `PLAN_GROUPS`, `limitRows`) **убирается**:
  остаются баланс, история, кнопка «Пополнить» и модалка;
- на витрине единица называется **«токены»**, внутри остаются кредиты
  (`credit_ledger`, `credits_micro`, `usd_per_credit`) — переименования в коде нет;
- подписки (`POST /api/admin/users/{id}/subscription`), MRR в админке и блок тарифов на
  лендинге — **вне контура оплаты**, выпиливаются отдельной задачей, к крипто-приёму
  отношения не имеют.

Готовность: работает при `CRYPTO_TOPUP_ENABLED=false` (полное отсутствие эффекта), при
включённом флаге без настроек Bitcart отдаёт понятную 503, на SQLite тесты проходят без
Postgres, на Postgres миграция создаёт таблицу и RLS-политику.

## 1. Владение файлами (чужое не править)

| Владелец | Файлы |
|---|---|
| backend-агент | `app/settings.py`, `app/models.py`, `migrations/versions/0025_crypto_invoices.py`, `app/services/tenant_tables.py`, `app/services/credit_ledger.py`, `app/services/bitcart_client.py` (новый), `app/services/crypto_payments.py` (новый), `app/web/routers/crypto_payments.py` (новый), `app/web/identity.py` |
| frontend-агент | `web/src/components/panels/left-bottom/payments-panel.tsx`, `web/src/components/panels/left-bottom/crypto-topup-modal.tsx` (новый) |
| verifier | `tests/test_crypto_payments.py`, `tests/test_crypto_webhook.py` (новые) + чтение всего |
| Lead | `app/web/api.py`, `.env.example`, `docs/*` |

Если правка нужна в чужом файле — не править, написать Lead.

## 2. Настройки (`app/settings.py`, стиль `Field(default, alias="ENV")`)

```
crypto_topup_enabled: bool = False        # CRYPTO_TOPUP_ENABLED
bitcart_url: str = ""                     # BITCART_URL  (https://pay.example.com)
bitcart_store_id: str = ""                # BITCART_STORE_ID
bitcart_token: str = ""                   # BITCART_TOKEN (секрет)
crypto_webhook_secret: str = ""           # CRYPTO_WEBHOOK_SECRET (секрет)
crypto_topup_min_usd: float = 5.0         # CRYPTO_TOPUP_MIN_USD
crypto_topup_max_usd: float = 500.0       # CRYPTO_TOPUP_MAX_USD
crypto_topup_expiration_min: int = 30     # CRYPTO_TOPUP_EXPIRATION_MIN
crypto_topup_max_open: int = 10           # CRYPTO_TOPUP_MAX_OPEN (открытых счетов на арендатора)
crypto_bitcart_timeout_s: float = 15.0    # CRYPTO_BITCART_TIMEOUT_S
```
Плюс `bitcart_configured()` в сервисе: url+store+tokens непусты.

## 3. Модель `CryptoInvoice` (`app/models.py`, рядом с Coupon*)

Стиль как у `CreditEntry`: `Mapped[...]`, `Uuid(as_uuid=False)` для id/tenant, наивный UTC
`datetime` (через `_now()`), JSON — `JSON` тип.

```
__tablename__ = "crypto_invoices"
id: str uuid PK
tenant_id: str uuid index
provider: str(16) default "bitcart"
external_id: str(64) index            # id инвойса Bitcart
amount_usd_micro: int BigInt          # сколько клиент попросил (микродоллары)
credits_micro: int BigInt             # сколько зачислим (микрокредиты, из usd_per_credit)
status: str(16) index default "new"   # new|paid|credited|expired|invalid|partial|refunded|error
invoice_status: str(16) default ""    # сырой статус Bitcart
exception_status: str(16) default ""  # paid_partial|paid_over|failed_confirm|""
asset: str(16) default ""             # что выбрал клиент (usdt/eth/btc...), для истории
network: str(32) default ""           # tron|ethereum|bsc|bitcoin|...
expected_amount: str(64) default ""   # сумма в крипте, как строку (Decimal)
address: str(128) default ""          # адрес получателя этого счёта
payment_url: str default ""           # uri для QR
rate_usd: str(64) default ""          # курс на момент оплаты (справочно)
tx_hashes: JSON default list          # список хешей
methods: JSON default list            # методы для фронта (см. §4)
raw: JSON default dict                # последний ответ Bitcart (без секретов)
created_at, updated_at: datetime
expires_at: datetime | None
settled_at: datetime | None
credited_entry_id: str uuid | None    # проводка, которой начислили
last_error: str(255) default ""
__table_args__ = (
  UniqueConstraint("provider","external_id", name="uq_crypto_invoices_ext"),
  Index("ix_crypto_invoices_tenant_status","tenant_id","status"),
  Index("ix_crypto_invoices_status_updated","status","updated_at"),
)
```

## 4. Миграция `0025_crypto_invoices.py`

Образец — `0016_coupons.py`: `op.get_bind()`, `sa.inspect`, create только если таблицы нет;
индексы + unique. После создания на Postgres навесить RLS:
`from app.services.rls_apply import apply_tenant_isolation_sync; apply_tenant_isolation_sync(bind, ["crypto_invoices"])`
(на SQLite функция сама no-op). `downgrade` — drop table если есть.
`app/services/tenant_tables.py`: добавить `"crypto_invoices"` в `BASE_TENANT_TABLES`
(обязательно: `check_coverage` иначе валит тесты изоляции).

## 5. `credit_ledger.topup()`

Добавить keyword-аргументы `ref_table: str = ""`, `ref_ids: list[int] | None = None`
(по умолчанию прежнее поведение), записать их в `CreditEntry`. Существующие вызовы не трогать.

## 6. `app/services/bitcart_client.py`

Тонкий HTTP-клиент, только async, без ретраев на создание:

```
class BitcartError(Exception): ...            # сеть/таймаут/не-2xx
class BitcartClient:
    def __init__(self, base_url, token, timeout=15.0)
    async def create_invoice(self, payload: dict) -> dict      # POST {base}/api/invoices
    async def get_invoice(self, invoice_id: str) -> dict       # GET  {base}/api/invoices/{id}
```
- `Authorization: <token>` (без `Bearer`).
- `httpx.AsyncClient(timeout=httpx.Timeout(timeout), follow_redirects=False)`.
- base: убрать хвостовые `/`.
- Не логировать токен и тело заголовков. Ошибки — `BitcartError` с короткой причиной
  (код ответа + первые 200 символов тела, без токена).
- `get_invoice` можно один раз повторить при `httpx.TransportError` (только GET).

## 7. `app/services/crypto_payments.py`

```
CREDITS_PER_MICRO = 1_000_000
def credits_micro_for_usd(usd: Decimal) -> int      # int(usd / usd_per_credit() * 1e6), floor
def to_usd_micro(usd: Decimal) -> int               # int(usd*1e6)
def normalize_methods(invoice: dict) -> list[dict]  # терпимый парсер payments[]
async def create_topup(session, tenant_id, amount_usd) -> CryptoInvoice
async def refresh_invoice(session, inv: CryptoInvoice) -> CryptoInvoice
async def apply_settlement(session, inv: CryptoInvoice) -> bool   # CAS + начисление
async def sync_pending(session, limit: int = 25) -> int           # фоновая сверка
```

`create_topup`:
1. Проверить флаг/конфиг → `TopupUnavailable` (`app.services.crypto_payments`), роутер → 503.
2. `Decimal(str(amount_usd))`, квантование до 2 знаков; min/max; иначе `ValueError` → 400.
3. Счёт открытых (`status in ("new","paid","partial")`) < `crypto_topup_max_open`, иначе 429.
4. `INSERT` строки `status="new"`, `amount_usd_micro`, `credits_micro` — ДО внешнего вызова.
5. `payload = {"price": "<usd>", "currency": "USD", "store_id": store, "order_id": str(inv.id),
   "notification_url": f"{public_base}/api/crypto/webhook/{secret}",
   "redirect_url": f"{public_base}/home", "expiration": expiration_min}`.
   `redirect_url` — на `/home`: страницы `/balance` в студии нет (проверено 2026-11-18),
   редирект туда дал бы 404 после оплаты.
   `public_base` — `settings.studio_public_base` (от `STUDIO_PUBLIC_URL`); пусто —
   notification_url не передаём, работает только фоновая сверка.
6. Ответ: `external_id`, `expires_at` (из `expiration_seconds`/`time_left` или now+expiration),
   `methods=normalize_methods(...)`, `raw` (без секретов), commit.
7. Ошибка Bitcart → `status="error"`, `last_error`, commit, пробросить `TopupUnavailable` → 502/503.

`normalize_methods`: на каждый элемент `invoice["payments"]` собрать
`{"asset","network","label","amount","address","uri","required_confirmations","sender_address_required"}`:
`asset` = `currency` (usdt/eth/btc/usdt_trx…), `network` из `wallet.network` (eip155:1 → ethereum,
tron:… → tron, bsc → bsc) — если непонятно, оставить сырую строку; `address` = `payment_address`
(fallback `lookup_field`), `uri` = `payment_url`, `label` человеческое: «USDT (TRON)» из
`asset`+`network` (словарь в модуле). Пропускать методы без адреса.

`refresh_invoice`: `get_invoice(external_id)` → обновить `invoice_status`, `exception_status`,
`methods` (если пришли), `expected_amount`, `rate_usd`, `tx_hashes`, `raw`; затем `apply_settlement`.

`apply_settlement` (CAS) — единственное место начисления:
1. `if inv.status in ("credited","refunded","expired","invalid","error") and not
   (inv.status == "expired" and gateway_status == "complete"): return False`.
   Исключение для `expired`: счёт закрыли по времени, а шлюз потом увидел платёж и
   сказал `complete` — деньги реальные, кредиты обязаны начислиться (§11.3, тест
   `test_late_payment_after_expiry_is_credited`).
2. Маппинг:
   - `pending` → `new`; `paid|confirmed|unconfirmed` → `paid`; `complete` → к начислению;
   - `expired` → `expired`; `invalid` → `invalid`; `refunded` → `refunded`;
   - `exception_status=="paid_partial"` и статус не complete → `partial` (без начисления).
3. Только для complete: `UPDATE crypto_invoices SET status='credited', settled_at=:now
   WHERE id=:id AND status IN ('new','paid','partial','expired')` (на PG — `.returning(id)`;
   на SQLite тот же UPDATE + `rowcount`). Если 0 строк — уже начислено/закрыто, выйти.
4. `amount = effective_price` из ответа Bitcart (фактически полученные USD, строка), иначе
   `amount_usd_micro`; пересчитать `credits_micro = credits_micro_for_usd(amount)`; для
   `paid_over` — по факту, memo «переплата».
5. `topup(session, inv.tenant_id, credits_micro, memo=..., ref_table="crypto_invoices",
   ref_ids=[...])`; сохранить `credited_entry_id`; commit ОДНОЙ транзакцией.
6. Возвращает True/False; при ошибке БД — rollback и raise (кредит не потерян: статус не
   закоммичен → фоновая сверка повторит).

`sync_pending(session, limit)`: выбрать счета по трём причинам (объединить через `OR`):
1. `status in ("new","paid","partial")` и `updated_at < now - 20s` — обычная сверка;
2. `status in ("new","paid","partial")` и `expires_at < now - 6h` — давно истёкший
   открытый счёт надо закрыть, даже если его только что читали. Статус в условии
   обязателен: иначе уже закрытый счёт с протухшим `expires_at` выбирался бы вечно;
3. `status == "expired"` и `expires_at > now - 24h` и `updated_at < now - 2h` —
   поздняя оплата: шлюз мог передумать после дефолта, а IPN у Bitcart без ретраев.
   Окно сутки, перепроверка раз в два часа (тесты
   `test_sync_pending_rechecks_a_recently_expired_invoice`,
   `test_sync_pending_leaves_old_closed_invoices_alone`).
По одной `refresh_invoice` в try/except (ошибка одного не валит пачку), вернуть
число обработанных.

## 8. Роутер `app/web/routers/crypto_payments.py`

```python
router = APIRouter(tags=["crypto"])   # подключается в app/web/api.py (Lead)
```

`POST /billing/topup/crypto` — тело `{"amount_usd": "10.00"}` (строка или число).
Auth: как у `/billing/balance` (никаких своих токенов; tenant через `current_tenant()`).
Ответ 200:
```
{"invoice": {"id","status","amount_usd":"10.00","credits":"1000",
  "expires_at":"…Z","methods":[{"asset","network","label","amount","address","uri",
  "required_confirmations","sender_address_required"}],
  "warning":"Отправляйте только …"}}
```
Ошибки: 400 неверная сумма/лимиты, 429 слишком много открытых, 503 не настроено/шлюз недоступен
(`{"detail": "<человеческий текст>"}`).

`GET /billing/topup/crypto/{invoice_id}` — свой счёт арендатора (404 чужой).
Ответ `{"invoice": {...как выше..., "credited_credits": "1000"|null, "settled_at":…,
"stale": false, "updated_at":…}}`. Обновляет у Bitcart, только если запись старше 30 с;
ошибка Bitcart не валит ответ — `stale: true`, последнее известное.

`POST /crypto/webhook/{secret}` — БЕЗ авторизации:
- `secret` сравнить с `settings.crypto_webhook_secret` через `hmac.compare_digest`;
  не задан/не совпал → 404 (не 401: не подтверждаем существование).
- Тело `{"id": str, "status": str}` (json, `await request.json()`, битое → 400).
- Телу НЕ доверять: найти счёт по `external_id` (с `set_config('app.is_admin','true',true)`
  на Postgres, чтобы RLS пустил без арендатора), `refresh_invoice` (авторитетный источник),
  `apply_settlement`.
- Всегда 200 `{"ok": true}` кроме 404 по секрету/битого JSON; исключения логировать, не 500
  (Bitcart не ретраит, но 500 шумит в мониторинге и мешает дебагу).
- Не логировать секрет пути и тело целиком.

`app/web/identity.py`: в `path_requires_identity` пустить без токена префикс
`/api/crypto/webhook/` (по образцу `/api/voices/`). В `PUBLIC_PATHS` не добавлять (путь
параметризован). Участнику (`member`) ручки `/api/billing/topup/crypto*` уже разрешены
префиксом `/api/billing/`.

## 9. Фоновая сверка

Lead подключает в `app/web/api.py::_lifespan`: если `settings.crypto_topup_enabled` — задача
`asyncio.create_task(crypto_sync_loop(), name="crypto-topup-sync")`, цикл `while True`:
`sleep(60)`, `async with session_scope() as s: await sync_pending(s)`, всё в try/except
(`logger.exception`, не падать), отмену по `CancelledError` пробрасывать. Задачу гасить на
остановке (список задач рядом с observer).

## 10. Фронт

`payments-panel.tsx`:
- сетку тарифов (`PLANS`/`PLAN_GROUPS`/`limitRows`) и блок «выбери тариф» из панели убрать:
  тарифов нет, есть баланс и пополнение на свободную сумму (решение 17.11.2026);
- единицу в интерфейсе называть «токены», не «кредиты» (внутри — кредиты, без переименования);
- читать `GET /api/billing/topup/crypto/config` НЕ нужно; вместо этого кнопка «Пополнить»
  активна всегда, при 503 показывает текст из `detail`.
- в режиме владельца (`balance.unlimited`) кнопки «Пополнить» нет: у владельца нет кассы,
  POST вернул бы 400 — кнопка, ведущая в отказ, хуже её отсутствия.
- кнопка «Пополнить» → модалка `CryptoTopupModal` (новый файл): сумма (5/10/25/50/100 + своя),
  «Продолжить» → `POST /api/billing/topup/crypto` → список методов радиокнопками
  `label` + сумма в монете; выбранный → адрес моно-шрифтом, QR из `uri` (или адреса),
  «Отправляйте только …» (warning из ответа, крупно), таймер до `expires_at`.
- поллинг `GET /api/billing/topup/crypto/{id}` каждые 4 с; `credited` → «Зачислено, N кредитов»,
  обновить баланс (`/api/billing/balance`) через колбэк из панели; `expired|invalid|error` →
  текст и кнопка «Начать заново»; `partial` → «Пришло меньше суммы, разберём вручную».
- `credits`/`amount_usd` — строки, не парсить во float для арифметики.
- Стиль: существующие `PanelShell/Section/Btn/Chips/card/ACCENT` из `./ui`. QR — настоящий,
  `qrcode.react@4.2.0` (добавлен 2026-11-18, SVG, без нативных зависимостей). После правок
  фронта обязательны `npm install` (новый пакет) и `npm run build` в `web/`.

## 11. Тесты (verifier)

`tests/test_crypto_payments.py`, `tests/test_crypto_webhook.py` — на моках Bitcart
(`monkeypatch` на `BitcartClient` / `httpx.MockTransport`), SQLite, без сети. Обязательные кейсы:

1. флаг выключен → 503; включён без конфига → 503; конфиг есть → 200 и тело запроса к Bitcart
   (price/currency/store_id/order_id/notification_url/expiration).
2. сумма ниже min/выше max/мусор → 400; открытых больше лимита → 429.
3. маппинг статусов: pending→new, paid→paid, complete→credited + проводка в леджере на
   `credits_micro` (курс 1.0 и курс 0.01 через monkeypatch `credit_usd_rate`);
4. двойной вебхук / двойной complete → РОВНО одна проводка (CAS);
5. подмена тела: вебхук `complete`, а `get_invoice` отдаёт `pending` → начисления нет;
6. `paid_partial` → `partial`, начисления нет; `paid_over` → начислено по `effective_price`;
7. `expired`/`invalid`/`refunded` → закрыто без начисления; при этом `expired` →
   `complete` (поздняя оплата) обязан начислить, а старый закрытый счёт сверка не трогает;
8. чужой арендатор GET → 404; вебхук с неверным секретом → 404; битый JSON → 400;
9. `sync_pending` подхватывает `paid`→`complete` без вебхука, перепроверяет недавно
   истёкшие и не падает на ошибке Bitcart;
10. инвариант леджера: после N начислений `balance = Σ delta − Σ held`
    (`app/services/credit_ledger.reconcile`), и `ref_table/ref_ids` проставлены;
11. `check_coverage`/`all_isolated()` содержит `crypto_invoices` (тест изоляции не падает).

## 12. Гейты (обязательно, до отчёта)

Python (единственное окружение на машине):
`C:\Users\Admin\Desktop\video-pipeline\.venv\Scripts\python.exe -m pytest tests/test_crypto_*.py tests/test_credit_ledger.py tests/test_billing_api.py tests/test_tenant_isolation.py -q`
`…\ruff.exe check app/services/bitcart_client.py app/services/crypto_payments.py app/web/routers/crypto_payments.py app/models.py app/settings.py app/services/credit_ledger.py app/services/tenant_tables.py migrations/versions/0025_crypto_invoices.py`
`…\mypy.exe app/services/bitcart_client.py app/services/crypto_payments.py app/web/routers/crypto_payments.py --ignore-missing-imports`
Фронт: `cd web && npm run typecheck` (сборку `next build` делает Lead).

## 13. Требования «как на сервере»

- Никаких блокирующих вызовов в async (httpx async, без `requests`, без `time.sleep`).
- Все внешние вызовы с таймаутом; в БД — короткие транзакции, внешний HTTP не держит транзакцию
  открытой дольше необходимого.
- Секреты не попадают в логи/ответы/`raw`; `raw` чистить от `notification_url` (в нём секрет!).
- Наивный UTC в моделях (как весь репозиторий), ISO-время в ответах с `Z`.
- Миграция идемпотентна (повторный прогон не падает), downgrade безопасен.
- Никаких зависимостей от request-context в вебхуке и фоновой задаче (арендатор и admin-GUC
  ставятся явно).
- При недоступном Bitcart клиент видит понятный текст, а не 500; уже оплаченное не теряется.
