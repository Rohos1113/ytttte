"""Универсальный нормализатор ответа ЛЛМ-ноды в таблицы.

Зачем. «Результаты» ЛЛМ-нод — это JSON разной формы: у шотов массив ``ops``
идёт по кадру, у QC — массив вердиктов по сцене, у отчёта — одни скаляры, у
персонажей — проза с JSON-фрагментом. Отдельная таблица под каждую ноду
разъехалась бы с пайплайном, поэтому правила общие (спека:
``docs/node-result-tables.md``, разделы 3.1–3.8):

* массив объектов в корне (или в корневом объекте на глубине до 2) — таблица;
* скаляры и массивы примитивов — параметры (key-value), пустые массивы тоже;
* вложенные объекты разворачиваются в колонки ``путь.поле``, массивы строк —
  через ``"; "``, массивы объектов остаются компактной JSON-ячейкой;
* массивы-спутники одинаковой длины склеиваются в одну строку: по общему
  ключу (``frame_uuid``/``id``/``кадр``/``номер``...), а если общего ключа нет,
  то по индексу — когда оба массива про кадры (``ops`` + ``закадр_план``);
* невалидный JSON сначала проверяется на сбалансированный JSON-фрагмент после
  прозы (``cast``: 196 символов прозы + реестр персонажей), и только потом
  считается прозой → таблица блоков {заголовок, текст, тип}.

Ограничения: глубина разворачивания 4, 5000 строк на таблицу, ``long_text``
длиннее 300 символов обрезается в ответе API до 2000 (``?full=1`` — целиком),
``json``-ячейки не обрезаются, но отдаются компактно, нормализация
прерывается через 3 секунды (200 + warning, без 500).

Нормализация живёт отдельно от FastAPI: её зовут и ручка
``GET /api/projects/{id}/node-llm/{key}/table`` (``app/web/routers/node_llm.py``),
и CLI ``scripts/node_results_tables.py``.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

#: Сколько строк максимум отдаём в одной таблице.
MAX_ROWS = 5000
#: Глубина разворачивания вложенных объектов в колонки.
MAX_FLATTEN_DEPTH = 4
#: На какой глубине от корня ещё ищем массивы объектов.
MAX_COLLECT_DEPTH = 2
#: С какой длины строка считается длинным текстом.
LONG_TEXT_CHARS = 300
#: Обрезка строковых значений в ответе API (``?full=1`` — без обрезки).
API_VALUE_LIMIT = 2000
#: Обрезка значения обычного параметра.
PARAM_VALUE_LIMIT = 2000
#: Обрезка исходного текста прозы в параметрах.
PROSE_PARAM_LIMIT = 20000
#: Строка короче этого и без точки в конце считается заголовком блока.
HEADING_MAX_CHARS = 120
#: Таймаут нормализации одного документа.
TIMEOUT_SECONDS = 3.0

_TIMEOUT_WARNING = "нормализация прервана по таймауту 3 с"
_TRIM_WARNING = "long_text обрезан до 2000 символов (?full=1 — целиком)"
#: Ключи, по которым склеиваются массивы-спутники (порядок из спеки 3.3).
_JOIN_KEY_NAMES = (
    "frame_uuid",
    "кадр",
    "id",
    "shot_id",
    "номер",
    "frame_id",
    "uuid",
    "кадр_id",
    "код",
    "key",
)
#: Маркеры «это про кадры»: имя массива или его ключи.
_FRAME_MARKERS = ("frame", "shot", "кадр", "сцен", "scene")
#: Ключи, которые в таблице идут первыми (спека 3.2).
_ID_FIRST_NAMES = frozenset({"id", "номер", "frame_uuid", "кадр", "shot_id", "frame_id", "код"})
#: Чем не может заканчиваться строка-заголовок (конец фразы или JSON-структура).
_SENTENCE_TAIL = (".", "!", "?", "…", ",", ";", ":", "{", "[", "(", "}", "]")
_MISSING = object()


class _JsonCell(str):
    """Ячейка типа ``json``: компактная JSON-строка, к ней не применяется long_text."""


@dataclass
class _Ctx:
    """Копилка результата нормализации одного документа."""

    started: float
    with_refs: bool = False
    tables: list[dict[str, Any]] = field(default_factory=list)
    params: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    #: Скрытые пути к значениям — только для импорта xlsx/JSON/CSV-правок.
    #: В JSON-ответ ``GET /table`` не попадают (см. ``normalize_document``).
    refs: list[dict[str, Any]] = field(default_factory=list)

    def expired(self) -> bool:
        return (time.monotonic() - self.started) > TIMEOUT_SECONDS

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)


def _json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _number_text(value: int | float) -> str:
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value)


def _scalar_text(value: Any) -> str:
    """Скаляр в строку: bool — true/false, None — пусто, объект — компактный JSON."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _number_text(value)
    if isinstance(value, str):
        return value
    return _json_compact(value)


def _key_text(value: Any) -> str:
    """Значение ключа склейки — сравнимая строка."""
    return _scalar_text(value).strip()


def _last_segment(key: str) -> str:
    return str(key).rsplit(".", 1)[-1].casefold()


def _param_value(value: Any) -> str:
    if isinstance(value, list):
        text = "; ".join(_scalar_text(item) for item in value)
    else:
        text = _scalar_text(value)
    if len(text) > PARAM_VALUE_LIMIT:
        return text[: PARAM_VALUE_LIMIT - 1] + "…"
    return text


def _param(key: str, value: Any) -> dict[str, Any]:
    return {"key": str(key), "label": str(key), "value": _param_value(value)}


def _result(ctx: _Ctx, *, kind: str) -> dict[str, Any]:
    return {"kind": kind, "tables": ctx.tables, "params": ctx.params, "warnings": ctx.warnings}


# ---------------------------------------------------------------------------
# JSON → таблицы
# ---------------------------------------------------------------------------


def _flatten_row(row: dict[str, Any], *, depth: int = 0, prefix: str = "") -> dict[str, Any]:
    """Строка массива в плоский словарь ``путь.поле``."""
    flat: dict[str, Any] = {}
    for key, value in row.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            if depth < MAX_FLATTEN_DEPTH:
                flat.update(_flatten_row(value, depth=depth + 1, prefix=f"{name}."))
            else:
                flat[name] = _JsonCell(_json_compact(value))
        elif isinstance(value, list):
            flat.update(_flatten_value_list(name, value))
        elif value is None:
            flat[name] = ""
        else:
            flat[name] = value
    return flat


def _flatten_value_list(name: str, value: list[Any]) -> dict[str, Any]:
    if not value:
        return {name: ""}
    if any(isinstance(item, (dict, list)) for item in value):
        # Массив объектов внутри строки разворачивается в отдельные строки и
        # колонки в _expand_object_lists; пока оставляем как есть.
        return {name: value}
    return {name: "; ".join(_scalar_text(item) for item in value)}


def _expand_object_lists(
    rows: list[dict[str, Any]],
    column_sources: list[tuple[str, str]],
    ctx: _Ctx,
) -> tuple[
    list[dict[str, Any]],
    list[tuple[str, str]],
    bool,
    bool,
    list[tuple[int, int | None]],
    str | None,
]:
    """Массив объектов в поле строки → отдельные строки и колонки.

    Пример: `ops[].fields.кадры` — 4 кадра на операцию. Каждый кадр становится
    своей строкой, его поля — колонками `кадры.<поле>`; остальные данные строки
    (frame_uuid, склейка с закадром) повторяются. Так в таблице оказываются все
    переменные, а не один обрезанный json.

    Возвращает и ``expansions``: для каждой итоговой строки — (индекс исходной
    строки, индекс элемента раскрытого массива или ``None``). По ним импорт
    правок находит объект кадра в документе.
    """
    counts: list[tuple[str, int]] = []
    for key, _src in column_sources:
        total = 0
        for row in rows:
            value = row.get(key)
            if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
                total += len(value)
        if total:
            counts.append((key, total))
    if not counts:
        return rows, column_sources, False, False, [(index, None) for index in range(len(rows))], None

    # Раскрываем самый крупный массив объектов, остальные остаются json-ячейкой.
    counts.sort(key=lambda item: -item[1])
    expand_key = counts[0][0]
    for key, _total in counts[1:]:
        for row in rows:
            value = row.get(key)
            if isinstance(value, list):
                row[key] = _JsonCell(_json_compact(value))

    expanded: list[dict[str, Any]] = []
    expansions: list[tuple[int, int | None]] = []
    new_keys: list[str] = []
    seen_new: set[str] = set()
    for row_index, row in enumerate(rows):
        value = row.get(expand_key)
        base = {key: val for key, val in row.items() if key != expand_key}
        items = value if isinstance(value, list) else []
        if not items:
            expanded.append(base)
            expansions.append((row_index, None))
            continue
        for item_index, item in enumerate(items):
            if not isinstance(item, dict):
                item = {"value": item}
            flat = _flatten_row(item, prefix=f"{expand_key}.")
            merged = dict(base)
            merged.update(flat)
            expanded.append(merged)
            expansions.append((row_index, item_index))
            for key in flat:
                if key not in seen_new:
                    seen_new.add(key)
                    new_keys.append(key)

    truncated = False
    if len(expanded) > MAX_ROWS:
        ctx.warn(f"таблица {expand_key}: показано {MAX_ROWS} из {len(expanded)} строк")
        expanded = expanded[:MAX_ROWS]
        expansions = expansions[:MAX_ROWS]
        truncated = True

    base_sources = [(key, src) for key, src in column_sources if key != expand_key]
    new_sources = [(key, key) for key in new_keys]
    return expanded, base_sources + new_sources, True, truncated, expansions, expand_key


def _column_type(values: list[Any]) -> str:
    """Тип колонки по всем непустым значениям (спека 1.3)."""
    filled = [value for value in values if value is not None and value != ""]
    if not filled:
        return "text"
    if any(isinstance(value, _JsonCell) for value in filled):
        return "json"
    if all(isinstance(value, bool) for value in filled):
        return "bool"
    if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in filled):
        return "number"
    if all(isinstance(value, str) for value in filled):
        return "long_text" if any(len(value) > LONG_TEXT_CHARS for value in filled) else "text"
    return "text"  # смешанные типы → text, числа приводятся к строкам


def _collect(
    node: dict[str, Any],
    path: tuple[str, ...],
    collections: list[dict[str, Any]],
    ctx: _Ctx,
) -> None:
    """Собрать массивы объектов (глубина до 2) и параметры корневого объекта."""
    for key, value in node.items():
        if ctx.expired():
            ctx.warn(_TIMEOUT_WARNING)
            return
        key_path = path + (str(key),)
        name = ".".join(key_path)
        if isinstance(value, list):
            if value and all(isinstance(item, dict) for item in value):
                if len(key_path) <= MAX_COLLECT_DEPTH:
                    collections.append({"name": name, "rows": value, "path": key_path})
                else:
                    ctx.params.append(_param(name, _json_compact(value)))
            else:
                ctx.params.append(_param(name, value))
        elif isinstance(value, dict):
            if len(key_path) < MAX_COLLECT_DEPTH:
                _collect(value, key_path, collections, ctx)
            else:
                ctx.params.append(_param(name, _json_compact(value)))
        else:
            ctx.params.append(_param(name, value))


def _join_key(a: dict[str, Any], b: dict[str, Any]) -> str | None:
    """Общий ключ склейки (frame_uuid/id/кадр...) с одинаковым набором значений."""
    if not a["rows"] or not b["rows"]:
        return None
    b_keys = set(b["keys"])
    for key in a["keys"]:
        if key not in b_keys or _last_segment(key) not in _JOIN_KEY_NAMES:
            continue
        a_values = {_key_text(row.get(key)) for row in a["rows"]} - {""}
        b_values = {_key_text(row.get(key)) for row in b["rows"]} - {""}
        if a_values and a_values == b_values:
            return key
    return None


def _frame_like(coll: dict[str, Any]) -> bool:
    """Массив «про кадры»: по имени или по ключам строк."""
    name = str(coll["name"]).casefold()
    if any(marker in name for marker in _FRAME_MARKERS):
        return True
    keys = " ".join(coll["keys"]).casefold()
    return any(marker in keys for marker in _FRAME_MARKERS)


def _order_columns(column_sources: list[tuple[str, str]]) -> list[str]:
    """Порядок колонок: id/номер/frame_uuid первыми, дальше — порядок появления."""
    head = [key for key, source in column_sources if _last_segment(source) in _ID_FIRST_NAMES]
    tail = [key for key, source in column_sources if _last_segment(source) not in _ID_FIRST_NAMES]
    return head + tail


def _table_from_group(
    group: list[dict[str, Any]], join_key: str | None, ctx: _Ctx
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Одна таблица из одного массива или из склеенной группы массивов.

    Заодно собирает ``refs`` — скрытые пути к значениям в исходном JSON: по ним
    загрузка xlsx/JSON/CSV правит документ. В ответ API ``refs`` не попадают.
    """
    names: dict[int, dict[str, str]] = {}
    used: set[str] = set()
    column_sources: list[tuple[str, str]] = []
    column_refs: dict[str, dict[str, Any]] = {}
    for idx, coll in enumerate(group):
        mapping: dict[str, str] = {}
        for col in coll["keys"]:
            if idx > 0 and join_key is not None and col == join_key:
                continue  # ключ склейки уже пришёл из базового массива
            if idx == 0:
                target = col
                suffix = 2
                while target in used:
                    target = f"{col}~{suffix}"
                    suffix += 1
            else:
                target = f"{coll['name']}.{col}"
                suffix = 2
                while target in used:
                    target = f"{coll['name']}.{col}~{suffix}"
                    suffix += 1
            used.add(target)
            mapping[col] = target
            column_sources.append((target, col))
            column_refs[target] = {"group": idx, "col": col}
        names[idx] = mapping

    rows: list[dict[str, Any]] = []
    positions: list[dict[int, int]] = []
    if join_key is not None:
        index: dict[str, int] = {}
        for row_index, row in enumerate(group[0]["rows"]):
            mapped = {names[0][col]: value for col, value in row.items() if col in names[0]}
            index[_key_text(row.get(join_key))] = len(rows)
            rows.append(mapped)
            positions.append({0: row_index})
        unmatched = 0
        for idx in range(1, len(group)):
            for row_index, row in enumerate(group[idx]["rows"]):
                position = index.get(_key_text(row.get(join_key)))
                if position is None:
                    unmatched += 1
                    continue
                rows[position].update(
                    {names[idx][col]: value for col, value in row.items() if col in names[idx]}
                )
                positions[position][idx] = row_index
        if unmatched:
            ctx.warn(f"склейка {join_key}: {unmatched} строк второго массива без пары")
    else:
        row_count = max(len(coll["rows"]) for coll in group)
        for position in range(row_count):
            merged: dict[str, Any] = {}
            present: dict[int, int] = {}
            for idx, coll in enumerate(group):
                if position >= len(coll["rows"]):
                    continue
                present[idx] = position
                for col, value in coll["rows"][position].items():
                    target = names[idx].get(col)
                    if target is not None:
                        merged[target] = value
            rows.append(merged)
            positions.append(present)

    rows, column_sources, expanded, expanded_truncated, expansions, expand_key = _expand_object_lists(
        rows, column_sources, ctx
    )

    columns: list[dict[str, Any]] = []
    for key in _order_columns(column_sources):
        for row in rows:
            value = row.get(key)
            if isinstance(value, (list, dict)):
                row[key] = _JsonCell(_json_compact(value))
        column_type = _column_type([row.get(key) for row in rows])
        if column_type in ("text", "long_text"):
            for row in rows:
                value = row.get(key)
                if value is not None and not isinstance(value, str):
                    row[key] = _scalar_text(value)
        columns.append({"key": key, "label": key, "type": column_type})

    # Скрытые пути для импорта правок (в JSON-ответ не попадают).
    expand_ref = column_refs.get(expand_key) if expand_key else None
    refs_columns: dict[str, dict[str, Any]] = {}
    for key, _source in column_sources:
        if expand_key is not None and (key == expand_key or key.startswith(f"{expand_key}.")):
            relative = "" if key == expand_key else key[len(expand_key) + 1 :]
            refs_columns[key] = {
                "group": int((expand_ref or {}).get("group", 0)),
                "col": relative,
                "expand": key != expand_key,
            }
            continue
        ref = column_refs.get(key)
        if ref is not None:
            refs_columns[key] = {"group": ref["group"], "col": ref["col"], "expand": False}
    refs_rows: list[dict[str, Any]] = []
    for base_row_index, item_index in expansions:
        entry: dict[str, Any] = {"positions": dict(positions[base_row_index])}
        if item_index is not None and expand_ref is not None:
            entry["expand"] = {
                "group": int(expand_ref["group"]),
                "col": str(expand_ref["col"]),
                "index": item_index,
            }
        refs_rows.append(entry)

    group_names = " + ".join(str(coll["name"]) for coll in group)
    if len(group) > 1:
        mode = f"по ключу {join_key}" if join_key else "по индексу"
        title = f"{group_names} (склейка {mode}, {len(rows)} из {len(rows)})"
    else:
        title = group_names
    total = len(rows) if expanded else max(int(coll["total"]) for coll in group)
    refs = {
        "id": str(group[0]["name"]),
        "groups": [
            {
                "path": list(coll.get("path") or (str(coll["name"]),)),
                "name": str(coll["name"]),
            }
            for coll in group
        ],
        "columns": refs_columns,
        "rows": refs_rows,
    }
    return (
        {
            "id": str(group[0]["name"]),
            "title": title,
            "columns": columns,
            "rows": rows,
            "total": total,
            "truncated": any(bool(coll["truncated"]) for coll in group) or expanded_truncated,
        },
        refs,
    )


def _build_tables(collections: list[dict[str, Any]], ctx: _Ctx) -> list[dict[str, Any]]:
    """Развернуть массивы в таблицы, склеив массивы-спутники."""
    prepared: list[dict[str, Any]] = []
    for coll in collections:
        if ctx.expired():
            ctx.warn(_TIMEOUT_WARNING)
            break
        rows: list[dict[str, Any]] = []
        keys: list[str] = []
        seen: set[str] = set()
        for row in coll["rows"]:
            if ctx.expired():
                ctx.warn(_TIMEOUT_WARNING)
                break
            if len(rows) >= MAX_ROWS:
                break
            flat = _flatten_row(row)
            rows.append(flat)
            for key in flat:
                if key not in seen:
                    seen.add(key)
                    keys.append(key)
        total = len(coll["rows"])
        if total > MAX_ROWS:
            ctx.warn(f"таблица {coll['name']}: показано {MAX_ROWS} из {total}")
        prepared.append(
            {
                "name": coll["name"],
                "rows": rows,
                "keys": keys,
                "total": total,
                "truncated": total > MAX_ROWS,
                "path": tuple(coll.get("path") or ()),
            }
        )

    tables: list[dict[str, Any]] = []
    unused = list(range(len(prepared)))
    while unused:
        base = prepared[unused.pop(0)]
        group = [base]
        join_key: str | None = None
        rest: list[int] = []
        for idx in unused:
            other = prepared[idx]
            mergeable = bool(other["rows"]) and len(other["rows"]) == len(base["rows"])
            if mergeable:
                join_candidate = _join_key(base, other)
                if join_candidate is not None and (join_key is None or join_key == join_candidate):
                    join_key = join_candidate
                    group.append(other)
                    continue
                if join_candidate is None and _frame_like(base) and _frame_like(other):
                    group.append(other)
                    continue
            rest.append(idx)
        unused = rest
        table, refs = _table_from_group(group, join_key, ctx)
        tables.append(table)
        ctx.refs.append(refs)
    return tables


def _trim_tables(tables: list[dict[str, Any]]) -> bool:
    """Обрезка длинных текстовых значений до 2000 символов (json-ячейки не трогаем)."""
    trimmed = False
    for table in tables:
        json_keys = {column["key"] for column in table["columns"] if column["type"] == "json"}
        for row in table["rows"]:
            for key, value in row.items():
                if key in json_keys or not isinstance(value, str) or len(value) <= API_VALUE_LIMIT:
                    continue
                row[key] = value[: API_VALUE_LIMIT - 1] + "…"
                trimmed = True
    return trimmed


def normalize_json(
    value: Any,
    *,
    full: bool = False,
    name: str | None = None,
    with_refs: bool = False,
) -> dict[str, Any]:
    """Нормализовать уже разобранный JSON в ``{kind, tables, params, warnings}``.

    ``with_refs=True`` добавляет служебный ``refs`` — пути значений в исходном
    JSON для загрузки правок. В ответ ``GET /table`` он не попадает: ручка зовёт
    нормализатор без этого флага.
    """
    ctx = _Ctx(started=time.monotonic(), with_refs=with_refs)
    collections: list[dict[str, Any]] = []
    if isinstance(value, list):
        if value and all(isinstance(item, dict) for item in value):
            collections.append({"name": "items", "rows": value, "path": ()})
        else:
            ctx.params.append(_param(name or "items", value))
    elif isinstance(value, dict):
        _collect(value, (), collections, ctx)
    else:
        ctx.params.append(_param(name or "value", value))
    ctx.tables.extend(_build_tables(collections, ctx))
    if not full and _trim_tables(ctx.tables):
        ctx.warn(_TRIM_WARNING)
    result = _result(ctx, kind="json")
    if with_refs:
        result["refs"] = ctx.refs
    return result


# ---------------------------------------------------------------------------
# Проза и JSON-фрагмент в прозе
# ---------------------------------------------------------------------------


def _is_heading(line: str) -> bool:
    """Строка-заголовок прозы (спека 3.4)."""
    text = line.strip()
    if not text or len(text) > HEADING_MAX_CHARS:
        return False
    if text.endswith(_SENTENCE_TAIL):
        return False
    if ". " in text:  # это предложение, а не заголовок
        return False
    return any(ch.isalpha() for ch in text)


def replace_prose_cell(
    text: str, row_index: int, column: str, value: Any
) -> tuple[str, bool]:
    """Правка ячейки таблицы блоков прозы (тип таблицы ``blocks``).

    Меняется заголовок раздела или его текст; исходный текст собирается заново
    из блоков (пустые строки между разделами сохраняются). Возвращает новый
    текст и признак изменения.
    """
    blocks = _prose_blocks(text)
    if row_index < 0 or row_index >= len(blocks):
        raise ValueError("строка не найдена в таблице блоков")
    title, body, kind = blocks[row_index]
    if column == "заголовок":
        title = str(value or "").strip()
    elif column == "текст":
        body = "\n".join(
            line.strip() for line in str(value or "").splitlines() if line.strip()
        )
    else:
        raise ValueError(f"колонка «{column}» не редактируется")
    blocks[row_index] = (title, body, kind)
    chunks: list[str] = []
    for block_title, block_body, _kind in blocks:
        lines: list[str] = []
        if block_title:
            lines.append(block_title)
        if block_body:
            lines.extend(block_body.splitlines())
        chunks.append("\n".join(lines))
    rebuilt = "\n\n".join(chunk for chunk in chunks if chunk)
    return rebuilt, rebuilt != text.strip()


def _prose_blocks(text: str) -> list[tuple[str, str, str]]:
    """Строки → блоки: вступление, разделы, соседние заголовки не склеиваем."""
    blocks: list[list[Any]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if _is_heading(line):
            blocks.append([line, [], "раздел"])
            continue
        if not blocks:
            blocks.append(["", [], "вступление"])
        blocks[-1][1].append(line)
    return [(str(title), "\n".join(body), str(kind)) for title, body, kind in blocks]


def normalize_prose(
    text: str,
    *,
    full: bool = False,
    name: str | None = None,
    with_refs: bool = False,
) -> dict[str, Any]:
    """Проза в таблицу блоков {заголовок, текст, тип} + исходный текст в параметрах."""
    ctx = _Ctx(started=time.monotonic(), with_refs=with_refs)
    blocks = _prose_blocks(text)
    total = len(blocks)
    if total > MAX_ROWS:
        ctx.warn(f"таблица blocks: показано {MAX_ROWS} из {total}")
        blocks = blocks[:MAX_ROWS]
    rows = [{"заголовок": title, "текст": body, "тип": kind} for title, body, kind in blocks]
    if not full:
        trimmed = False
        for row in rows:
            if len(row["текст"]) > API_VALUE_LIMIT:
                row["текст"] = row["текст"][: API_VALUE_LIMIT - 1] + "…"
                trimmed = True
        if trimmed:
            ctx.warn(_TRIM_WARNING)
    ctx.tables.append(
        {
            "id": "blocks",
            "title": "Блоки текста",
            "columns": [
                {"key": "заголовок", "label": "заголовок", "type": "text"},
                {"key": "текст", "label": "текст", "type": "long_text"},
                {"key": "тип", "label": "тип", "type": "text"},
            ],
            "rows": rows,
            "total": total,
            "truncated": total > MAX_ROWS,
        }
    )
    source_text = text.strip()
    label = "Исходный текст"
    if len(source_text) > PROSE_PARAM_LIMIT:
        source_text = source_text[: PROSE_PARAM_LIMIT - 1] + "…"
        label = "Исходный текст (обрезка)"
        ctx.warn(f"исходный текст обрезан до {PROSE_PARAM_LIMIT} символов")
    if source_text:
        ctx.params.append({"key": "исходный_текст", "label": label, "value": source_text})
    result = _result(ctx, kind="text")
    if with_refs:
        # Проза — не JSON: править значения загрузкой нельзя, refs пустые.
        result["refs"] = []
    return result


def _balanced_end(text: str, start: int) -> int | None:
    """Индекс закрывающей ``}`` для объекта, начинающегося на ``start`` (с учётом строк)."""
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def _json_fragment(text: str) -> tuple[Any, int] | None:
    """Первый сбалансированный ``{…}``, который разбирается как JSON (спека 3.4.1)."""
    start = text.find("{")
    while start != -1:
        end = _balanced_end(text, start)
        if end is not None:
            try:
                return json.loads(text[start : end + 1]), start
            except (TypeError, ValueError):
                pass
        start = text.find("{", start + 1)
    return None


def _load_json(text: str) -> Any:
    """JSON-объект/массив, список JSONL-объектов или ``_MISSING``."""
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        pass
    lines = [line for line in text.splitlines() if line.strip()]
    if len(lines) >= 2:
        try:
            return [json.loads(line) for line in lines]
        except (TypeError, ValueError):
            pass
    return _MISSING


def normalize_document(
    text: str,
    *,
    full: bool = False,
    name: str | None = None,
    with_refs: bool = False,
) -> dict[str, Any]:
    """Нормализовать текст документа: JSON / JSON-фрагмент → таблицы, иначе блоки."""
    raw = text or ""
    stripped = raw.lstrip("\ufeff").strip()
    if not stripped:
        empty: dict[str, Any] = {
            "kind": "text",
            "tables": [],
            "params": [],
            "warnings": ["документ пуст"],
        }
        if with_refs:
            empty["refs"] = []
        return empty
    value = _load_json(stripped)
    if value is not _MISSING:
        return normalize_json(value, full=full, name=name, with_refs=with_refs)

    fragment = _json_fragment(stripped)
    if fragment is not None:
        parsed, start = fragment
        result = normalize_json(parsed, full=full, name=name, with_refs=with_refs)
        preamble = stripped[:start].strip()
        if preamble:
            if len(preamble) > PARAM_VALUE_LIMIT:
                preamble = preamble[: PARAM_VALUE_LIMIT - 1] + "…"
            result["params"].insert(0, {"key": "преамбула", "label": "Проза до JSON", "value": preamble})
            if len(preamble) >= 50:
                result["warnings"].insert(
                    0, f"json.loads упал на прозе; разобран JSON-фрагмент с символа {start}"
                )
        return result

    return normalize_prose(raw, full=full, name=name, with_refs=with_refs)
