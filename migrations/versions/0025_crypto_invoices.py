"""таблица счетов на пополнение криптой + изоляция арендаторов

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-20

Счёт на пополнение — это чужая запись о нашем клиенте: сколько он попросил,
на какой адрес ему велели отправить монету и начислены ли кредиты. Адрес и
tx-хеши — данные арендатора, поэтому таблица идёт под ту же политику, что
проекты и касса (`docs/SAAS-PIVOT.md` §4.2, `docs/CRYPTO-TOPUP-CONTRACT.md` §4).

Что делает:

* **Создаёт таблицу, если её нет.** `create_all` на старте её не заводит —
  схема обязана приходить из миграции, иначе на Postgres таблица родилась бы
  после включения политик и осталась без них (`assert_rls_or_die` уронил бы
  старт приложения, а healthcheck откатил выкладку).
* **Индексы, по которым реально ходят.** `status` + `updated_at` — фоновая
  сверка («что не обновилось за 20 секунд»); `tenant_id` + `status` — счёт
  открытых счетов арендатора перед созданием нового; `external_id` — поиск
  счёта из вебхука, где арендатора ещё не знают.
* **UNIQUE(`provider`, `external_id`)** — второй рубеж против двойного
  начисления: один счёт шлюза не может стать двумя строками. Обнуляемый
  `external_id` тут не дыра, а причина: строка заводится ДО вызова шлюза, и у
  двух неотвеченных счетов идентификатора ещё нет. SQLite и Postgres
  пропускают несколько NULL, но не несколько пустых строк.
* **Postgres: ENABLE + FORCE + политика `tenant_isolation`.** Предикат тот же,
  что у остальных таблиц арендатора (`app/services/rls_apply.py`), — чтобы
  `rls_check` и человек видели одну политику, а не три похожих.

Идемпотентно: повторный прогон видит таблицу и индексы и ничего не ломает.
`downgrade` удаляет таблицу, если она есть; RLS уходит вместе с ней.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "crypto_invoices"

#: Индексы таблицы: имя → колонки. Составные объявлены в модели, поэтому
#: повторяются здесь слово в слово — иначе свежая база из миграции и база из
#: `create_all` разошлись бы по схеме молча.
INDEXES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("ix_crypto_invoices_tenant_id", ("tenant_id",)),
    ("ix_crypto_invoices_external_id", ("external_id",)),
    ("ix_crypto_invoices_status", ("status",)),
    ("ix_crypto_invoices_created_at", ("created_at",)),
    ("ix_crypto_invoices_tenant_status", ("tenant_id", "status")),
    ("ix_crypto_invoices_status_updated", ("status", "updated_at")),
)

UNIQUE_NAME = "uq_crypto_invoices_ext"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    existing_tables = set(inspector.get_table_names())
    if TABLE in existing_tables:
        existing_cols = {c["name"] for c in inspector.get_columns(TABLE)}
        if "external_id" not in existing_cols:
            # Старая несовместимая таблица из ранних черновиков/экспериментов
            op.drop_table(TABLE)
            existing_tables.remove(TABLE)

    if TABLE not in existing_tables:
        op.create_table(
            TABLE,
            sa.Column("id", sa.Uuid(as_uuid=False), primary_key=True),
            sa.Column("tenant_id", sa.Uuid(as_uuid=False), nullable=False),
            sa.Column("provider", sa.String(length=16), nullable=False, server_default="bitcart"),
            # NULL, пока шлюз не ответил: строка заводится до внешнего вызова.
            sa.Column("external_id", sa.String(length=64), nullable=True),
            sa.Column("amount_usd_micro", sa.BigInteger(), nullable=False),
            sa.Column("credits_micro", sa.BigInteger(), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False, server_default="new"),
            sa.Column("invoice_status", sa.String(length=16), nullable=False, server_default=""),
            sa.Column("exception_status", sa.String(length=16), nullable=False, server_default=""),
            sa.Column("asset", sa.String(length=16), nullable=False, server_default=""),
            sa.Column("network", sa.String(length=32), nullable=False, server_default=""),
            sa.Column("expected_amount", sa.String(length=64), nullable=False, server_default=""),
            sa.Column("address", sa.String(length=128), nullable=False, server_default=""),
            sa.Column("payment_url", sa.String(length=512), nullable=False, server_default=""),
            sa.Column("rate_usd", sa.String(length=64), nullable=False, server_default=""),
            sa.Column("tx_hashes", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("methods", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("raw", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("expires_at", sa.DateTime(), nullable=True),
            sa.Column("settled_at", sa.DateTime(), nullable=True),
            sa.Column("credited_entry_id", sa.Uuid(as_uuid=False), nullable=True),
            sa.Column("last_error", sa.String(length=255), nullable=False, server_default=""),
            sa.UniqueConstraint("provider", "external_id", name=UNIQUE_NAME),
        )

    # Инспектор после создания — иначе список индексов будет пустым.
    inspector = sa.inspect(bind)
    existing = {ix.get("name") for ix in inspector.get_indexes(TABLE)}
    for name, columns in INDEXES:
        if name in existing:
            continue
        op.create_index(name, TABLE, list(columns))

    # Политика вешается отдельно от создания таблицы: база могла получить
    # таблицу раньше (create_all на SQLite, ручная правка), и повторный прогон
    # обязан долечить именно политику. На SQLite функция — no-op.
    from app.services.rls_apply import apply_tenant_isolation_sync

    apply_tenant_isolation_sync(bind, [TABLE])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if TABLE not in set(inspector.get_table_names()):
        return
    # Политика уходит вместе с таблицей; индексы тоже.
    op.drop_table(TABLE)
