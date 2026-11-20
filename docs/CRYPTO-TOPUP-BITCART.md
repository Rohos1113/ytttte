# Пополнение баланса криптой через Bitcart: установка и внедрение

Статус: **код готов и проверен сквозным прогоном (18.11.2026), на сервер не выкладывался** —
см. §12. Установка Bitcart в §2.
Решение от 2026-11-17: платёжный шлюз — **Bitcart**
(self-hosted, MIT, не кастодиан). Сравнение вариантов — `docs/CRYPTO-TOPUP-PLAN.md` §13.
Цифры и API сверены с документацией Bitcart и исходниками 17.11.2026.

---

## 1. Что должно получиться

Клиент в панели студии жмёт «Пополнить» → выбирает сумму в долларах (например $10/$25/$50) и
монету → получает адрес + QR + таймер → платит → мы ловим уведомление от Bitcart, **сами**
перепроверяем счёт у Bitcart, начисляем кредиты через `credit_ledger.topup` и показываем новый
баланс.

Ключевое:

- деньги идут **прямо на наш кошелёк** (Bitcart — watch-only: xpub или адрес, приватные ключи
  ему не нужны);
- комиссия самого Bitcart — 0%, комиссию сети платит плательщик;
- KYC/регистрации у внешнего сервиса нет — шлюз наш;
- юр. ответственность за приём крипты без юрлица никуда не девается, шлюз её не снимает.

Ограничения, которые надо принять заранее:

- **Solana в Bitcart нет** (ни SOL, ни USDT-SPL). Нужна — отдельный рельс (Helius), вне этого плана.
- Для **USDT/ETH/TRX из обменников** нужен платный плагин «ETH payments» (см. §2.6). Без него
  checkout просит у плательщика адрес отправителя — обменник так не умеет.
- Курс (решение владельца, повторено 17.11.2026): **1 доллар = 100 кредитов**, в коде это
  `credit_usd_rate=0.01`. Сейчас в `app/settings.py` стоит `1.0` (1 кредит = $1) — переключить
  в рамках этой задачи; начислять через `usd_per_credit()`, свой коэффициент не заводить.

---

## 2. Этап 0 — сервер и установка Bitcart

### 2.1. Что нужно

| Что | Требование |
|---|---|
| VPS | 2 vCPU / 2–4 ГБ RAM / 20–40 ГБ SSD, Ubuntu 22.04/24.04, статический IP. Документация Bitcart: минимум 1 ГБ RAM / 10 ГБ диска — но 4 ГБ спокойнее, и на студийный сервер это не ставить (там 4 ГБ уже заняты студией, Postgres и ffmpeg) |
| Домен | `pay.<домен>` + DNS A-запись на IP сервера |
| Порты | 80 и 443 снаружи |
| DNS | одна доменная схема: магазин на `/`, админка на `/admin`, API на `/api`; HTTPS-сертификат Bitcart получает сам (nginx-https) |

### 2.2. Установка (по докам `bitcart-docker`)

```bash
sudo su -
apt update && apt -y install git
git clone https://github.com/bitcart/bitcart-docker
cd bitcart-docker
export BITCART_HOST=pay.example.com
export BITCART_CRYPTOS=btc,eth,trx,ltc,bch
./setup.sh
```

Пояснения:

- `BITCART_CRYPTOS` — какие монеты поднять; символы смотреть в списке монет в панели
  (btc, bch, ltc, xmr, eth, trx, bnb, polygon…). Каждая монета — отдельный контейнер-демон.
- BTC/BCH/LTC ходят в сеть Electrum/Fulcrum — **свой узел не нужен** (SPV).
- ETH/TRX/BNB/полигон — демону нужен RPC; по умолчанию Bitcart берёт публичные RPC из своего
  seed-сервера, свой задаётся переменной вида `ETH_SERVER=https://…`.
- Обновления — повторный `./setup.sh` из той же папки (данные в docker-томах).

Проверка: `https://pay.example.com/admin` открывается, сертификат валиден, `docker compose ps`
в каталоге деплоя показывает здоровые контейнеры (точная команда зависит от версии setup-скрипта).

### 2.3. Первый вход

Первый зарегистрированный на инстансе пользователь становится **суперюзером**. Пароль — в
хранилище паролей; на `/admin` лучше повесить ограничение по IP или VPN.

### 2.4. Кошельки

Один кошелёк Bitcart = одна валюта (или один токен).

- **BTC / LTC / BCH**: нужен **xpub** (watch-only). Electrum → Wallet → Information → Master
  public key. Приватный ключ в Bitcart не вводим.
- **ETH / TRX / BNB / полигон**: нужен **адрес** кошелька (MetaMask/Trust/Ledger).
- **USDT**: отдельный кошелёк с валютой сети (eth/trx/bnb) плюс поле **contract** — адрес
  контракта USDT в этой сети. Контракты брать из официального сайта Tether (или из списка
  токенов в панели Bitcart), не из чатов.
- Несколько адресов на один токен не нужны; каждый счёт получает свой адрес сам (для BTC-семейства
  из xpub, для ETH-семейства — из пула/через плагин, см. ниже).

### 2.5. Магазин (store) и его настройки

Создать store, привязать кошельки. Затем — настройки checkout (в коде это
`StoreCheckoutSettings`, значения по умолчанию в скобках):

| Настройка | Ставим | Зачем |
|---|---|---|
| `allow_anonymous_invoice_creation` (`true`) | **`false`** | иначе кто угодно создаёт счета на нашем инстансе |
| `email_required` (`true`) | `false` | нам не нужны письма покупателей |
| `expiration` (`15` мин) | `30` мин | время на оплату; таймер показываем в модалке |
| `transaction_speed` (`0`) | `1`–`2` | сколько подтверждений ждать до статуса `complete` (максимум 10; для TRON «твёрдый» блок — 19, см. риски) |
| `underpaid_percentage` (`0`) | `0`–`2` | допуск недоплаты; для крипты с комиссией сети 1–2% разумно |
| `ask_address` (`false`) | `false` | при плагине ETH-payments должен быть выключен |
| `confirmation_timeout` (`1440` мин) | оставить | через сутки «оплачен, но не подтверждён» закрывается |

Дальше:

- взять **store_id** (из URL страницы магазина или ответа API);
- создать **API-токен** (в админке, раздел настроек сервера/токенов; точный путь — по UI, swagger
  на `https://pay.<домен>/api`). Права — только на инвойсы и чтение магазинов, `full_control`
  не давать. Токен идёт в заголовке `Authorization: <token>`.

### 2.6. Плагин ETH payments (для USDT/ETH/TRX)

Зачем: без плагина ETH-подобные счета требуют от плательщика ввести **свой** адрес
(`sender_address_required`), и оплата из обменника (Binance/Bybit и т.п.) не проходит. Плагин
убирает этот запрос, принимает оплату с любых бирж и сводит токены на основной кошелёк.

Как: Plugins → Purchase → выбрать месяц/год → получить лицензию на e-mail → ввести ключ →
Install → Reload plugins. Внутри настроек:

- **fee-wallet** — отдельный кошелёк с небольшим количеством нативной монеты сети (газ для
  перевода токенов). Его приватный ключ живёт на сервере — держать там минимум средств;
- основной кошелёк остаётся watch-only.

Стоимость (по докам): подписка (месяц/год) **плюс** процент с оборота ETH-платежей свыше
$2000/мес; точные цифры видны в панели при покупке — вписать сюда после покупки.

### 2.7. Проверка до написания кода

1. В админке создать счёт на $1, оплатить USDT-TRC20 со своего кошелька.
2. Убедиться, что статусы идут `pending → paid → confirmed → complete`.
3. Подставить в счёт `notification_url` на временный приёмник (webhook.site) и убедиться, что
   приходит POST с телом `{"id": "<invoice_id>", "status": "<status>"}`.
4. Тестовые сети: `BTC_NETWORK=testnet` (по аналогии для других монет) — прогнать полный цикл
   хотя бы на BTC testnet до продакшена.

---

## 3. Этап 1 — настройки и модель в студии

Файлы и правки:

1. **`app/settings.py`** — новые поля (стиль как у остальных, alias'ы в ENV):
   `crypto_topup_enabled` (`CRYPTO_TOPUP_ENABLED`, false по умолчанию),
   `bitcart_url` (`BITCART_URL`), `bitcart_store_id` (`BITCART_STORE_ID`),
   `bitcart_token` (`BITCART_TOKEN`), `crypto_webhook_secret` (`CRYPTO_WEBHOOK_SECRET`),
   `crypto_topup_min_usd` (`CRYPTO_TOPUP_MIN_USD`, 5),
   `crypto_topup_max_usd` (`CRYPTO_TOPUP_MAX_USD`, 500),
   `crypto_topup_expiration_min` (`CRYPTO_TOPUP_EXPIRATION_MIN`, 30).
2. **`.env.example`** — те же переменные с комментариями, без значений.
3. **`app/models.py`** — модель `CryptoInvoice`:
   - `id` (uuid str), `tenant_id`, `provider` (`bitcart`), `external_id` (id инвойса Bitcart),
   - `asset`, `network`, `amount_usd_micro`, `expected_amount` (Decimal строкой), `rate_usd`,
     `address`, `payment_url`,
   - `status` (наш: `new/pending/paid/complete/expired/invalid/refunded/partial/overpaid`),
     `invoice_status` (сырой из Bitcart), `exception_status` (`paid_partial/paid_over/...`),
   - `tx_hashes` (JSON), `raw` (JSON), `credited_entry_id`, `created_at/updated_at/settled_at`,
   - индексы: UNIQUE(`provider`,`external_id`), (`tenant_id`,`status`), (`status`,`updated_at`).
4. **`app/services/tenant_tables.py`** — добавить `"crypto_invoices"` в `BASE_TENANT_TABLES`
   (иначе `check_coverage`/тесты изоляции упадут — это защита, а не помеха).
5. **`migrations/versions/0026_crypto_invoices.py`** — create table + RLS по образцу 0023/0024
   (ENABLE + FORCE + policy `tenant_isolation`). Номер 0025 может быть занят правкой курса
   (100 кредитов за доллар) — номер согласовать, чтобы не было двух 0025.
6. **`app/services/credit_ledger.py`** — `topup()` расширить keyword-аргументами
   `ref_table: str = ""`, `ref_ids: list[int] | None = None`, чтобы проводка ссылалась на
   инвойс; существующие вызовы и инвариант `Σ delta − Σ held` не меняются.
7. Юнит-тест `tests/test_tenant_isolation.py`-семейства должен остаться зелёным (новая таблица
   видна в `all_isolated()`).

---

## 4. Этап 2 — сервис и эндпоинты

### 4.1. `app/services/crypto_payments.py`

- **`create_invoice(session, tenant_id, amount_usd)`**
  1. Проверки: включено, min ≤ сумма ≤ max, число открытых инвойсов арендатора < N.
  2. `INSERT crypto_invoices(status='new')` — сначала наша строка, потом внешний вызов (при
     ошибке Bitcart строка остаётся `error`, деньги не теряются).
  3. `POST {BITCART_URL}/api/invoices`, `Authorization: <token>`, тело:
     `{"price": amount_usd, "currency": "USD", "store_id": "...", "order_id": "<crypto_invoice.id>",
       "notification_url": f"{PUBLIC_BASE}/api/crypto/webhook/{secret}",
       "redirect_url": f"{PUBLIC_BASE}/home", "expiration": 30}`.
  4. Сохранить `external_id`, `expiration_seconds`, `payments[]` → в ответ фронту методы
     (валюта, сеть, сумма в крипте, адрес, `payment_url` для QR).
- **`refresh(session, invoice)`** — `GET /api/invoices/{external_id}`, обновить
  `invoice_status/exception_status/sent_amount/tx_hashes`.
- **`apply_status(session, invoice)`** — маппинг и начисление:
  - `complete` → начислить и закрыть;
  - `paid`, `confirmed` → промежуточные, ждём;
  - `expired`, `invalid` → закрыть без начисления;
  - `refunded` → ручной разбор (кредиты списывать только вручную);
  - `exception_status = paid_partial` → `status='partial'`, **не начислять**, показать клиенту
    «пришло меньше», в админку — ручной разбор/доплата;
  - `paid_over` → начислить по факту (сумма из `sent_amount`), остаток — в memo.
  - Идемпотентность: `UPDATE crypto_invoices SET status='crediting' WHERE id=:id AND
    status IN ('new','pending','paid','confirmed') RETURNING id` → начисление делает только тот,
    кто получил строку; `topup(..., ref_table='crypto_invoices', ref_ids=[id])` и
    `status='credited'` в одной транзакции.
- **`sync_pending_crypto_invoices()`** — раз в 1–2 минуты обновляет счета в
  `new/pending/paid/confirmed` старше 30–60 секунд. Это обязательный второй путь: IPN у Bitcart
  **не имеет подписи и не ретраится**, потерянное уведомление иначе = не начисленные кредиты.

### 4.2. `app/web/routers/crypto_payments.py`

- `POST /api/billing/topup/crypto` — создать счёт (сессия пользователя, tenant из неё).
  Ответ: `{invoice_id, expires_at, methods: [{asset, network, amount, address, uri, qr}]}`
  (QR рисуем на фронте из `uri`-строки).
- `GET /api/billing/topup/crypto/{id}` — наш статус; если запись старше 30 с — refresh у Bitcart.
- `POST /api/crypto/webhook/{secret}` — вебхук Bitcart: **без авторизации**, тело
  `{"id": "...", "status": "..."}`. Телу **не доверяем**: перезапрашиваем инвойс у Bitcart,
  сверяем сумму/получателя/статус, применяем `apply_status`. Отвечаем 200 всегда (ошибки —
  в лог и в мониторинг), секрет — длинная случайная строка в пути.
- Регистрация в `app/web/api.py` рядом с `billing_router` (файл сейчас правит параллельная
  работа — согласовать вставку).

### 4.3. Что не делаем

- не доверяем сумме из запроса на создание — сумма живёт в нашем инвойсе;
- не начисляем на `paid` (только `complete` после подтверждений);
- не заводим второй леджер;
- не выдаём бесконечный лимит на инвойсы (спам = засорение адресов и ресурсов).

---

## 5. Этап 3 — фронт

`web/src/components/panels/left-bottom/payments-panel.tsx`: заглушка `«Пополнить»` (сейчас
`disabled`) превращается в кнопку → модалка:

1. сумма: быстрые $10/$25/$50/$100 + своя;
2. выбор монеты из `methods` (BTC / ETH / USDT-TRC20 / USDT-ERC20 / LTC / BCH);
3. адрес, QR, точная сумма в крипте, таймер до истечения;
4. поллинг `GET /api/billing/topup/crypto/{id}` каждые 3–5 с; при `complete` — «Зачислено» и
   обновление `/api/billing/balance`;
5. `partial` / `overpaid` / `expired` — понятный текст и кнопка «Обновить».

---

## 6. Этап 4 — тесты

`tests/test_crypto_payments.py` (Bitcart подменяем через httpx-mock):

- создание: тело запроса к Bitcart правильное (price/currency/store_id/order_id/notification_url);
- min/max, выключенный тумблер, чужой тенант (404);
- маппинг статусов: pending/paid/confirmed/complete/expired/invalid/refunded;
- **двойной вебхук** → одно начисление (CAS);
- **подмена тела**: пришло `complete`, а у Bitcart `pending` → отказ и алерт;
- недоплата (`paid_partial`) → не начислено, статус partial;
- переплата → начислено по факту;
- вебхук с неверным секретом → 404;
- новая таблица в списке изоляции, RLS-политика на Postgres (`tests/test_rls_postgres.py` —
  если поднят `vp-pg`);
- инвариант леджера `Σ delta − Σ held` после серии начислений.

Прогон перед PR:

```bash
.venv/bin/python -m pytest tests/test_crypto_payments.py tests/test_credit_ledger.py tests/test_billing_api.py -v
ruff check .
.venv/bin/python -m mypy app/ --ignore-missing-imports
```

Плюс живой прогон на testnet: инвойс → оплата → `complete` → кредиты на балансе.

---

## 7. Этап 5 — эксплуатация

- **Бэкапы**: docker-тома Bitcart (встроенный backup в админке) + наша БД; xpub/адреса — в
  хранилище секретов.
- **Мониторинг**: healthcheck Bitcart; алерты «0 вебхуков за сутки», «инвойс висит > 30 мин»,
  «ошибки API Bitcart», «расхождение леджера».
- **Безопасность**: HTTPS; `/admin` — по IP/VPN; токен только на инвойсы; вебхук — секретный
  путь; в логи не писать адреса плательщиков (решение владельца — аудит vs приватность).
- **Выводы**: свип на холодный кошелёк раз в N дней; на fee-wallet (плагин) — минимум газа;
  USDT-контракты в белом списке.
- **Ручной разбор**: недоплата/переплата/`refunded` — сначала страница в админке студии, до неё —
  SQL по `crypto_invoices`.

---

## 8. Что нужно от владельца (до старта)

1. **Домен** `pay.<домен>` и доступ к DNS; **VPS** 2–4 ГБ (отдельно от студии).
2. **Кошельки**: xpub для BTC/LTC/BCH, адреса ETH/TRON/BNB, контракты USDT; куда свипать.
3. **Решение по плагину** ETH payments: покупаем (тогда USDT/ETH/TRX из обменников работают
   сразу) или пока принимаем только BTC/BCH/LTC без USDT? Без плагина USDT-TRC20 — боль для
   клиента.
4. **Лимиты**: min/max пополнения, срок счёта, что делать с недоплатой (зачислить с допуском
   или ручной разбор).
5. **Курс**: 1 доллар = 100 кредитов ($10 = 1000). Начисление уже считает через
   `usd_per_credit()`; сама смена курса `CREDIT_USD_RATE` и миграция сумм — отдельная задача
   (`docs/CRYPTO-TOPUP-PLAN.md` §12), не в этом коде.

---

## 9. Оценка и порядок работ

| Этап | Что | Оценка |
|---|---|---|
| 0 | Сервер, Bitcart, кошельки, магазин, плагин, проверка $1 | 2–4 часа (+DNS/сертификат) |
| 1 | Модель, миграция, RLS, настройки, `topup(ref_*)` | 0,5–1 день |
| 2 | Сервис, эндпоинты, фоновая сверка, вебхук | 1,5–2 дня |
| 3 | Модалка пополнения на фронте | 0,5–1 день |
| 4 | Тесты + прогон на testnet | 1 день |
| 5 | Мониторинг, бэкапы, приёмка | 0,5 дня |

Итого ~4–6 рабочих дней. Порядок безопасный: этапы 1–2 пишутся и тестируются **без** живого
Bitcart (моки), этап 0 можно вести параллельно.

Ветка: отдельная от актуального base. В рабочем дереве сейчас есть незакоммиченные правки
`app/web/api.py`, `app/settings.py` (параллельная работа) — вставки в эти файлы согласовать.

---

## 10. Риски и грабли (по исходникам Bitcart)

| Риск | Деталь | Мера |
|---|---|---|
| Вебхук без подписи | `IPNSender` шлёт POST `{"id","status"}` без HMAC; ретраев нет | секретный путь + перезапрос инвойса у Bitcart + фоновая сверка |
| Потерянное уведомление | ошибка доставки только логируется | обязательный `sync_pending_crypto_invoices` + мониторинг «0 вебхуков» |
| Анонимные инвойсы | `allow_anonymous_invoice_creation` по умолчанию `true` | выключить в магазине |
| Двойное начисление | вебхук может прийти дважды | CAS по статусу + UNIQUE(`provider`,`external_id`) |
| Плагин привязан к машине | переезд сервера = переактивация (несколько часов) | не планировать переезд в день релиза |
| fee-wallet с ключом на сервере | компрометация сервера = деньги на нём | минимум газа, отдельный кошелёк, не основной |
| Подтверждения TRON | `transaction_speed` ≤ 10, «твёрдый» блок — 19 | суммы мелкие: 1–2 подтверждения, крупные — ручная проверка |
| Аптайм нашего домена | без него вебхуки не доходят | фоновая сверка закрывает разрыв |
| Секрет в URL вебхука | access-лог веб-сервера пишет путь целиком, вместе с секретом | логи не публиковать и не отдавать в чаты поддержки; при утечке — сменить `CRYPTO_WEBHOOK_SECRET` (старые счета досверит фоновая сверка) |
| Solana | в Bitcart нет | отдельный рельс при необходимости (Helius), не в этом плане |

---

## 11. Источники (сверено 17.11.2026)

- Установка: <https://raw.githubusercontent.com/bitcart/bitcart-docker/master/README.md>,
  <https://docs.bitcart.ai/deployment/docker>
- Требования-железо: <https://docs.bitcart.ai/deployment/hardware>
- Монеты: <https://bitcart.ai/coins>
- Кошельки/магазин/счёт: <https://docs.bitcart.ai/your-first-invoice>
- Интеграция (Merchants API, `notification_url`): <https://docs.bitcart.ai/integrations/custom-integration>
- Плагин ETH payments (и его цена/условия): <https://docs.bitcart.ai/guides/eth-payments-plugin>
- Публичные ноды/RPC по умолчанию: <https://docs.bitcart.ai/guides/default-nodes-your-own-node>
- Статусы и confirmations: <https://docs.bitcart.ai/guides/transaction-speed>
- Код: `api/services/ipn_sender.py`, `api/invoices.py`, `api/schemas/stores.py`,
  `api/schemas/invoices.py`, `api/services/crud/invoices.py` (github.com/bitcart/bitcart)

---

## 12. Что уже написано в коде (17.11.2026)

Приём платежей готов и покрыт тестами без живого Bitcart (шлюз подменён моком):

- `app/services/bitcart_client.py` — HTTP-клиент: создать счёт, прочитать счёт, таймаут,
  токен в `Authorization` без `Bearer`, без ретраев на создание.
- `app/services/crypto_payments.py` — создание счёта, разбор способов оплаты, сверка статуса,
  начисление кредитов через леджер ровно один раз, фоновая сверка `sync_pending` и цикл.
- `app/web/routers/crypto_payments.py` — `POST /api/billing/topup/crypto`,
  `GET /api/billing/topup/crypto/{id}`, `POST /api/crypto/webhook/{secret}`.
- `app/models.py` — `CryptoInvoice`; `migrations/versions/0025_crypto_invoices.py` — таблица,
  индексы и RLS; `app/services/tenant_tables.py` — таблица в списке изолированных.
- `app/services/credit_ledger.py` — `topup(..., ref_table, ref_ids, entry_id)`: в истории
  баланса видно, из какого счёта пришли кредиты.
- `app/web/identity.py` и `app/web/api.py` — вебхук ходит без токена (секрет в пути), роутер
  подключён, фоновая сверка поднимается вместе с приложением при включённом флаге.
- Фронт: кнопка «Пополнить» в панели «Оплата» и модалка
  `web/src/components/panels/left-bottom/crypto-topup-modal.tsx` (сумма → способ → адрес/QR/
  таймер → статус). QR настоящий — `qrcode.react@4.2.0` (добавлен в `web/package.json`
  2026-11-18), поэтому на сервере перед сборкой нужен `npm install`.
- `.env` / `deploy/studio/env.template`: `CRYPTO_TOPUP_ENABLED`, `BITCART_URL`,
  `BITCART_STORE_ID`, `BITCART_TOKEN`, `CRYPTO_WEBHOOK_SECRET`, `STUDIO_PUBLIC_URL`,
  `CRYPTO_TOPUP_MIN_USD`, `CRYPTO_TOPUP_MAX_USD`, `CRYPTO_TOPUP_EXPIRATION_MIN`,
  `CRYPTO_TOPUP_MAX_OPEN`, `CRYPTO_BITCART_TIMEOUT_S`.

Проверено 18.11.2026 собственным сквозным прогоном (настоящий `create_app()`, настоящий
HTTP-клиент, фейковый Bitcart отдельным сервером): 71 проверка из 71, плюс 12 проверок
миграции на чистой базе (upgrade → повтор → downgrade → upgrade). Два бага найдены и
исправлены на этом прогоне: `redirect_url` вёл на несуществующую `/balance`; оплата,
подтвердившаяся после истечения счёта, не начислялась. Ещё один — фоновая сверка вечно
дёргала шлюз по давно закрытым счетам с протухшим `expires_at`.

Почему включать не страшно:

- флаг `CRYPTO_TOPUP_ENABLED=false` по умолчанию: ручки отвечают 503, фоновая задача не
  стартует, кнопка показывает отказ;
- кредиты начисляются одной транзакцией с проводкой и условным `UPDATE`, поэтому двойной
  вебхук или одновременная сверка не начислят дважды;
- телу вебхука не верим: статус всегда перезапрашивается у Bitcart (у IPN нет подписи);
- если уведомление не дошло, сверка раз в минуту добирает оплату;
- секрет вебхука и токен Bitcart не попадают в ответы, логи и сохранённый ответ шлюза.

Не сделано намеренно: выплаты и возвраты (возврат — вручную из кошелька, студия только
фиксирует, что счёт возвращён), смена глобального курса кредитов, выкладка на сервер.

---

## 13. Включение на сервере (чек-лист)

1. Поднять Bitcart по §2; в магазине выключить анонимные счёта, срок 30 минут,
   `transaction_speed` 1–2 (для TRON больше не даст).
2. В `.env` студии заполнить переменные из §12, `STUDIO_PUBLIC_URL=https://<домен студии>`.
   Секрет вебхука: `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
3. `CRYPTO_TOPUP_ENABLED=true`, перезапустить студию. В логе ищи строку «crypto: счёт … открыт».
4. Фронт: в `web/` выполнить `npm install` (появился `qrcode.react`) и `npm run build`, иначе
   в интерфейсе останется старая модалка без QR. Перед выкладкой — `python scripts/bump_studio_version.py`.
5. Тест: «Пополнить» → $5 → адрес → оплата. Статус должен смениться на «Зачислено» в течение
   минуты (вебхук сразу, сверка — до 60 секунд).
6. Сверить цифры: при курсе 1 $ = 100 кредитов за $5 придёт 500. Если курс ещё 1.0, придёт 5 —
   это ожидаемо, сначала включается курс (`CRYPTO-TOPUP-PLAN.md` §12).
7. Пустой `CRYPTO_WEBHOOK_SECRET` не ошибка: работает только сверка, просто медленнее.
8. Проверить возврат: после оплаты Bitcart вернёт клиента на `/home` (страницы `/balance`
   в студии нет — это исправлено 18.11.2026).
9. Если платёж подтвердился позже срока счёта, кредиты всё равно начислятся: вебхук
   переведёт счёт из «истёк» в «зачислен», а сверка перепроверит недавно истёкшие счета
   в течение суток.
