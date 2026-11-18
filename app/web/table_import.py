"""Файлы таблиц ноды: выгрузка в xlsx и загрузка правок обратно в документ.

Скачивание (``GET .../table/xlsx``) отдаёт ту же авто-таблицу, что видит UI, но
с полными значениями (без обрезки long_text до 2000) и с человеческими
заголовками колонок — ``humanize_column_label`` повторяет функцию из
``web/src/components/canvas/node-result-table.tsx``, чтобы шапка в Excel
совпала с шапкой в панели.

Загрузка (``POST .../table/upload``) принимает xlsx (первый лист), json или csv,
сверяет заголовки и строки с текущей таблицей и меняет только значения в
исходном JSON-документе. Обратный путь значения к месту в документе дают
скрытые ``refs`` из нормализатора (``app/web/node_tables.py``, флаг
``with_refs=True``): они не попадают в JSON-ответ ``GET /table``. Здесь
описано, как по refs пройти документ и записать значение:

* ``groups`` — путь от корня документа до массива объектов (``["ops"]``,
  ``["закадр_план"]``, ``[]`` для корневого массива);
* ``columns[key]`` — группа и путь внутри объекта строки (``закадр`` →
  ``закадр_план[i].закадр``), а для раскрытых вложенных массивов — путь внутри
  элемента раскрытия (``fields.кадры.место`` → ``ops[i].fields.кадры[j].место``);
* ``rows[n]`` — позиции строки в каждом массиве-спутнике и индекс элемента
  раскрытия.

Битый файл, неизвестные колонки — ``TableImportError`` (ручка отдаёт 400).
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: Сегменты ключа, по которым строки файла сопоставляются со строками таблицы.
_ROW_KEY_SEGMENTS = frozenset(
    {"id", "frame_uuid", "номер", "uuid", "кадр", "кадр_id", "shot_id", "frame_id", "key", "код"}
)
#: Что нельзя писать в имя листа Excel.
_BAD_SHEET_CHARS = re.compile(r"[\\/*?\[\]:\x00-\x1f\x7f]")
#: Как в ``web/src/lib/node-tables.ts``: латиница и кириллица для lower-case.
_LATIN = re.compile(r"[A-Za-z]")
_CYRILLIC = re.compile(r"[\u0400-\u04FF]")


class TableImportError(ValueError):
    """Файл не подходит для загрузки — ручка отвечает 400 с этим текстом."""


@dataclass
class ParsedUpload:
    """Разобранный файл: строки (заголовок → значение) и имя листа xlsx."""

    rows: list[dict[str, Any]]
    sheet: str | None = None


# ---------------------------------------------------------------------------
# Заголовки колонок (зеркало humanizeColumnLabel из UI)
# ---------------------------------------------------------------------------


def _normalized_token(text: str) -> str:
    """Строка без разделителей — для сравнения label и key."""
    return re.sub(r"[_\W]+", "", str(text).lower())


def _capitalize_first(text: str) -> str:
    if not text:
        return text
    return text[0].upper() + text[1:]


def humanize_column_label(label: str | None, key: str | None) -> str:
    """Человеческий заголовок колонки — как в таблице UI.

    ``fields.кадры.место`` → ``Fields · кадры · место``, ``frame_uuid`` →
    ``Frame uuid``. Порядок и смысл шагов повторяют TS-функцию из
    ``node-result-table.tsx``.
    """
    raw_key = str(key or "").strip()
    raw_label = str(label or "").strip()
    if raw_label:
        same_as_key = not raw_key or _normalized_token(raw_label) == _normalized_token(raw_key)
        if not same_as_key or re.search(r"[\s·]", raw_label):
            return _capitalize_first(raw_label)
    source = raw_key or raw_label
    if not source:
        return ""
    segments: list[str] = []
    for segment in source.split("."):
        segment = segment.strip()
        if not segment:
            continue
        segment = re.sub(r"([a-zа-яё0-9])([A-ZА-ЯЁ])", r"\1 \2", segment)
        words = [word for word in re.split(r"[_\-\s]+", segment) if word]
        words = [
            word.lower() if _LATIN.search(word) and not _CYRILLIC.search(word) else word for word in words
        ]
        joined = " ".join(words)
        if joined:
            segments.append(joined)
    if not segments:
        return source
    return _capitalize_first(" · ".join(segments))


def sheet_title(raw: str | None, used: set[str] | None = None) -> str:
    """Безопасное имя листа Excel: без спецсимволов и не длиннее 31 символа."""
    taken = used if used is not None else set()
    base = _BAD_SHEET_CHARS.sub("_", str(raw or "table")).strip("_ ") or "table"
    base = base[:31]
    candidate = base
    suffix = 2
    while candidate.lower() in taken:
        tail = f"_{suffix}"
        candidate = f"{base[: 31 - len(tail)]}{tail}"
        suffix += 1
    taken.add(candidate.lower())
    return candidate


# ---------------------------------------------------------------------------
# xlsx-выгрузка
# ---------------------------------------------------------------------------


def _cell_text(value: Any) -> str:
    """Значение в строку (для сравнения строк файла и таблицы)."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(int(value)) if isinstance(value, float) and value.is_integer() else repr(value)
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _is_empty_cell(cell: Any) -> bool:
    """Пустая ячейка файла: None или строка из пробелов (0 и False — не пусто)."""
    return cell is None or (isinstance(cell, str) and not cell.strip())


def _xlsx_cell(value: Any, column_type: str) -> Any:
    """Значение ячейки для Excel: числа/булы остаются типизированными."""
    if value is None:
        return ""
    if column_type == "number" and isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if column_type == "bool":
        return value if isinstance(value, bool) else _cell_text(value) in ("true", "да", "1")
    if isinstance(value, str):
        return value
    return _cell_text(value)


def build_xlsx(tables: list[dict[str, Any]]) -> bytes:
    """Книга на ноду: лист на каждую таблицу, заголовки — как в UI."""
    from openpyxl import Workbook

    workbook = Workbook()
    workbook.remove(workbook.active)
    used: set[str] = set()
    for table in tables:
        columns = [column for column in table.get("columns") or [] if isinstance(column, dict)]
        sheet = workbook.create_sheet(sheet_title(str(table.get("id")), used))
        sheet.append([humanize_column_label(column.get("label"), column.get("key")) for column in columns])
        for row in table.get("rows") or []:
            sheet.append(
                [
                    _xlsx_cell(row.get(column.get("key")), str(column.get("type") or "text"))
                    for column in columns
                ]
            )
    if not workbook.sheetnames:
        workbook.create_sheet("нет_таблиц")
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Разбор загруженного файла
# ---------------------------------------------------------------------------


def _rows_from_matrix(matrix: list[list[Any]]) -> list[dict[str, Any]]:
    """Матрица «строка 1 — заголовки» → список словарей."""
    if not matrix:
        raise TableImportError("в файле нет строк")
    header_cells = [str(cell).strip() if cell is not None else "" for cell in matrix[0]]
    while header_cells and not header_cells[-1]:
        header_cells.pop()
    if not header_cells:
        raise TableImportError("в файле нет заголовков колонок")
    headers = [header if header else f"колонка_{index + 1}" for index, header in enumerate(header_cells)]
    rows: list[dict[str, Any]] = []
    for raw_row in matrix[1:]:
        values = list(raw_row[: len(headers)])
        if all(value is None or str(value).strip() == "" for value in values):
            continue
        rows.append(
            {header: values[index] if index < len(values) else None for index, header in enumerate(headers)}
        )
    if not rows:
        raise TableImportError("в файле нет строк с данными")
    return rows


def _parse_xlsx(data: bytes) -> ParsedUpload:
    from openpyxl import load_workbook

    try:
        workbook = load_workbook(io.BytesIO(data), data_only=True)
    except Exception as exc:  # noqa: BLE001 — битые/чужие файлы приходят сюда
        raise TableImportError(f"не удалось прочитать xlsx: {exc}") from exc
    sheet = workbook[workbook.sheetnames[0]]
    matrix = [list(row) for row in sheet.iter_rows(values_only=True)]
    return ParsedUpload(rows=_rows_from_matrix(matrix), sheet=str(sheet.title))


def _parse_json(data: bytes) -> ParsedUpload:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise TableImportError("json должен быть в UTF-8") from exc
    try:
        value = json.loads(text)
    except ValueError as exc:
        raise TableImportError(f"файл не валидный JSON: {exc}") from exc
    if isinstance(value, list):
        candidates = [value]
    elif isinstance(value, dict):
        candidates = [
            item
            for item in value.values()
            if isinstance(item, list) and item and all(isinstance(row, dict) for row in item)
        ]
        candidates.sort(key=len, reverse=True)
    else:
        candidates = []
    if not candidates:
        raise TableImportError("в JSON нет массива объектов со строками")
    rows = candidates[0]
    if not all(isinstance(row, dict) for row in rows):
        raise TableImportError("в JSON нет массива объектов со строками")
    if not rows:
        raise TableImportError("в файле нет строк с данными")
    return ParsedUpload(rows=[dict(row) for row in rows])


def _parse_csv(data: bytes) -> ParsedUpload:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise TableImportError("csv должен быть в UTF-8") from exc
    first_line = next((line for line in text.splitlines() if line.strip()), "")
    delimiter = ";" if first_line.count(";") >= first_line.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    matrix = [row for row in reader]
    return ParsedUpload(rows=_rows_from_matrix(matrix))


def parse_upload(data: bytes, filename: str) -> ParsedUpload:
    """Разобрать загруженный файл по расширению."""
    suffix = Path(str(filename or "")).suffix.lower()
    if suffix in (".xlsx", ".xlsm"):
        return _parse_xlsx(data)
    if suffix == ".json":
        return _parse_json(data)
    if suffix in (".csv", ".txt", ".tsv"):
        return _parse_csv(data)
    raise TableImportError("поддерживаются .xlsx, .json и .csv")


def choose_table(tables: list[dict[str, Any]], sheet: str | None) -> int:
    """Индекс таблицы по имени листа; без совпадения — основная (первая)."""
    if not tables:
        raise TableImportError("у ноды нет таблиц для загрузки")
    if sheet:
        wanted = str(sheet).strip().lower()
        for index, table in enumerate(tables):
            if str(table.get("id") or "").strip().lower() == wanted:
                return index
            if sheet_title(str(table.get("id")), set()).lower() == wanted:
                return index
    return 0


def find_table_index(tables: list[dict[str, Any]], sheet: str | None) -> int | None:
    """Индекс таблицы по имени листа или ``None``, если лист не про эту ноду.

    Без имени листа (json/csv) — основная таблица. Для xlsx важно не угадывать:
    лист, которого нет среди таблиц, пропускается, а не применяется к первой.
    """
    if not tables:
        return None
    if not sheet:
        return 0
    wanted = str(sheet).strip().lower()
    for index, table in enumerate(tables):
        if str(table.get("id") or "").strip().lower() == wanted:
            return index
        if sheet_title(str(table.get("id")), set()).lower() == wanted:
            return index
    return None


def parse_upload_sheets(data: bytes, filename: str) -> list[ParsedUpload]:
    """Разобрать все листы xlsx (или единственный поток json/csv).

    Скачанный файл содержит лист на каждую таблицу; человек правит любой из них,
    поэтому применяем все листы сразу, а не только первый.
    """
    suffix = Path(str(filename or "")).suffix.lower()
    if suffix not in (".xlsx", ".xlsm"):
        return [parse_upload(data, filename)]

    from openpyxl import load_workbook

    try:
        workbook = load_workbook(io.BytesIO(data), data_only=True)
    except Exception as exc:  # noqa: BLE001 — битые/чужие файлы приходят сюда
        raise TableImportError(f"не удалось прочитать xlsx: {exc}") from exc

    sheets: list[ParsedUpload] = []
    for name in workbook.sheetnames:
        sheet = workbook[name]
        matrix = [list(row) for row in sheet.iter_rows(values_only=True)]
        try:
            rows = _rows_from_matrix(matrix)
        except TableImportError:
            continue  # пустой лист пропускаем: нечего применять
        sheets.append(ParsedUpload(rows=rows, sheet=str(sheet.title)))
    if not sheets:
        raise TableImportError("в файле нет строк с данными")
    return sheets


# ---------------------------------------------------------------------------
# Запись правок в документ
# ---------------------------------------------------------------------------

_MISSING = object()


def _navigate(node: Any, path: list[str] | tuple[str, ...]) -> Any:
    current = node
    for segment in path:
        if not isinstance(current, dict) or segment not in current:
            raise KeyError(segment)
        current = current[segment]
    return current


def _read_value(node: Any, path: str) -> Any:
    current = node
    for segment in [part for part in str(path).split(".") if part]:
        if not isinstance(current, dict) or segment not in current:
            return _MISSING
        current = current[segment]
    return current


def _write_value(node: Any, path: str, value: Any) -> None:
    segments = [part for part in str(path).split(".") if part]
    if not segments:
        raise KeyError(path)
    current = node
    for segment in segments[:-1]:
        if not isinstance(current, dict) or segment not in current:
            raise KeyError(segment)
        current = current[segment]
    if not isinstance(current, dict):
        raise KeyError(path)
    current[segments[-1]] = value


def _location_key(ref: dict[str, Any], row_ref: dict[str, Any]) -> tuple[int, int, str, int, str] | None:
    """Уникальное место ячейки в JSON: (группа, позиция, раскрытие, индекс, путь)."""
    group_index = int(ref.get("group") or 0)
    position = (row_ref.get("positions") or {}).get(group_index)
    if position is None:
        return None
    expand = row_ref.get("expand")
    expand_col = ""
    expand_index = -1
    if ref.get("expand") and expand is not None and int(expand.get("group") or 0) == group_index:
        expand_col = str(expand.get("col") or "")
        expand_index = int(expand.get("index") or 0)
    return (group_index, int(position), expand_col, expand_index, str(ref.get("col") or ""))


def _location_target(root: Any, refs: dict[str, Any], location: tuple[int, int, str, int, str]) -> Any | None:
    """Объект документа, в котором лежит ячейка (элемент раскрытия или строка)."""
    group_index, position, expand_col, expand_index, _col = location
    groups = refs.get("groups") or []
    if group_index >= len(groups):
        return None
    try:
        array = _navigate(root, groups[group_index].get("path") or [])
    except KeyError:
        return None
    if not isinstance(array, list) or position >= len(array):
        return None
    element = array[position]
    if not expand_col:
        return element
    nested_list = _read_value(element, expand_col)
    if not isinstance(nested_list, list) or expand_index >= len(nested_list):
        return None
    return nested_list[expand_index]


def _same_value(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return float(left) == float(right)
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    return type(left) is type(right) and left == right


def _convert_value(cell: Any, column_type: str, current: Any) -> tuple[Any, str | None]:
    """Ячейку файла — в значение исходного типа колонки."""
    if column_type == "json":
        if isinstance(cell, (dict, list)):
            return cell, None
        text = str(cell if cell is not None else "").strip()
        if not text:
            return None, "пустая json-ячейка"
        try:
            return json.loads(text), None
        except ValueError:
            return None, "ячейка не разбирается как JSON"
    if cell is None:
        return "", None
    if isinstance(cell, str) and not cell.strip():
        return "", None
    if column_type == "number":
        if isinstance(cell, (int, float)) and not isinstance(cell, bool):
            number: int | float = cell
        else:
            try:
                number = float(str(cell).replace(",", ".").strip())
            except ValueError:
                return None, "ячейка не число"
        if isinstance(current, int) and isinstance(number, float) and number.is_integer():
            return int(number), None
        return number, None
    if column_type == "bool":
        if isinstance(cell, bool):
            return cell, None
        text = str(cell).strip().lower()
        if text in ("true", "да", "1", "yes"):
            return True, None
        if text in ("false", "нет", "0", "no"):
            return False, None
        return None, "ячейка не bool"
    if isinstance(cell, str):
        return cell, None
    if isinstance(cell, bool):
        return ("true" if cell else "false"), None
    if isinstance(cell, (int, float)):
        return _cell_text(cell), None
    if isinstance(cell, (dict, list)):
        return json.dumps(cell, ensure_ascii=False, separators=(",", ":")), None
    return str(cell), None


def _upload_headers(rows: list[dict[str, Any]]) -> list[str]:
    headers: list[str] = []
    for row in rows:
        for key in row:
            header = str(key)
            if header not in headers:
                headers.append(header)
    return headers


def apply_upload(
    root: Any,
    table: dict[str, Any],
    refs: dict[str, Any],
    uploaded: list[dict[str, Any]],
) -> dict[str, Any]:
    """Обновить ``root`` значениями из файла. Возвращает статистику и warnings.

    Меняются только ячейки, которые реально отличаются; отсутствующие колонки
    не трогаются; строки сопоставляются по ключевым колонкам (id/frame_uuid/
    номер…), а если их нет — по порядку.
    """
    columns = [column for column in table.get("columns") or [] if isinstance(column, dict)]
    column_by_key = {str(column.get("key")): column for column in columns}
    human_by_key = {
        key: humanize_column_label(column.get("label"), key) for key, column in column_by_key.items()
    }
    warnings: list[str] = []

    # Заголовки файла → ключи колонок.
    headers = _upload_headers(uploaded)
    unknown: list[str] = []
    header_to_column: dict[str, str] = {}
    for header in headers:
        text = header.strip()
        if not text:
            continue
        if text in column_by_key:
            header_to_column[header] = text
            continue
        match = next(
            (key for key, human in human_by_key.items() if human == text),
            None,
        )
        if match is not None:
            header_to_column[header] = match
        else:
            unknown.append(text)
    if unknown:
        raise TableImportError("неизвестные колонки: " + ", ".join(sorted(set(unknown))))
    column_to_header = {column: header for header, column in header_to_column.items()}

    mapped_columns = list(dict.fromkeys(header_to_column.values()))
    missing = [key for key in column_by_key if key not in mapped_columns]
    if missing:
        warnings.append("колонки отсутствуют, значения не менялись: " + ", ".join(missing))

    key_columns = [
        str(column.get("key"))
        for column in columns
        if str(column.get("key")).rsplit(".", 1)[-1].casefold() in _ROW_KEY_SEGMENTS
    ][:3]
    # В файле может не быть части ключевых колонок (например, csv без полей
    # кадра) — сопоставляем по тем, что есть.
    available_keys = [key for key in key_columns if key in column_to_header]
    if key_columns and not available_keys:
        warnings.append("ключевые колонки в файле отсутствуют — строки сопоставлены по порядку")
    key_columns = available_keys

    current_rows = table.get("rows") or []
    index: dict[str, int] = {}
    for row_index, row in enumerate(current_rows):
        if key_columns:
            index.setdefault(
                "|".join(_cell_text(row.get(column)).strip() for column in key_columns),
                row_index,
            )
    if not key_columns:
        warnings.append("в таблице нет ключевых колонок — строки сопоставлены по порядку")

    # Сопоставление строк файла со строками таблицы.
    matched: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for upload_index, uploaded_row in enumerate(uploaded):
        if key_columns:
            key_parts: list[str] = []
            for column in key_columns:
                key_header = column_to_header.get(column)
                if key_header is None or key_header not in uploaded_row:
                    key_parts = []
                    break
                key_parts.append(_cell_text(uploaded_row.get(key_header)).strip())
            if not key_parts:
                warnings.append(f"строка {upload_index + 1}: нет ключевых колонок, пропущена")
                continue
            row_key = "|".join(key_parts)
            if row_key in seen_keys:
                warnings.append(f"строка {row_key}: дубликат, взята первая")
                continue
            seen_keys.add(row_key)
            table_index = index.get(row_key)
            if table_index is None:
                warnings.append(f"строка {row_key} не найдена, пропущена")
                continue
        else:
            if upload_index >= len(current_rows):
                warnings.append(f"строка {upload_index + 1}: в таблице меньше строк, пропущена")
                continue
            table_index = upload_index
            row_key = str(upload_index + 1)
        matched.append({"row_key": row_key, "index": table_index, "row": uploaded_row})

    # Одна и та же ячейка JSON видна в нескольких строках таблицы (поля
    # операции при раскрытых кадрах). Собираем все варианты значений и выбираем
    # то, что отличается от текущего: правка любой строки доходит, а повторная
    # загрузка без правок не считается изменением.
    refs_rows = refs.get("rows") or []
    candidates: dict[tuple[int, int, str, int, str], dict[str, Any]] = {}
    for entry in matched:
        table_index = entry["index"]
        row_ref = refs_rows[table_index] if table_index < len(refs_rows) else {}
        for column_key in mapped_columns:
            column_header = column_to_header.get(column_key)
            if column_header is None or column_header not in entry["row"]:
                continue
            ref = (refs.get("columns") or {}).get(column_key)
            if ref is None:
                continue
            location = _location_key(ref, row_ref)
            if location is None:
                continue
            candidate = candidates.setdefault(
                location,
                {"ref": ref, "column": column_by_key[column_key], "cells": [], "rows": set()},
            )
            candidate["cells"].append(entry["row"].get(column_header))
            candidate["rows"].add(table_index)

    updated_cells = 0
    affected_rows: set[int] = set()
    for location, candidate in candidates.items():
        ref = candidate["ref"]
        column = candidate["column"]
        column_key = str(column.get("key") or "")
        target = _location_target(root, refs, location)
        if target is None:
            warnings.append(f"колонка {column_key}: не найдено место в документе, пропущена")
            continue
        current_value = _read_value(target, str(ref.get("col") or ""))
        if current_value is _MISSING:
            # Колонка собрана из соседних строк: у этого объекта поля просто нет.
            # Пустую ячейку не материализуем, иначе загрузка без правок меняла бы
            # документ; непустую — записываем как новое поле.
            if all(_is_empty_cell(cell) for cell in candidate["cells"]):
                continue
            current_value = None
        elif current_value is None and all(_is_empty_cell(cell) for cell in candidate["cells"]):
            # null в документе и пустая ячейка — не правка.
            continue
        if isinstance(current_value, list) and all(
            not isinstance(item, (dict, list)) for item in current_value
        ):
            warnings.append(f"колонка {column_key} — склеенный список, не редактируется")
            continue
        converted_values: list[Any] = []
        problem: str | None = None
        for cell in candidate["cells"]:
            converted, problem = _convert_value(cell, str(column.get("type") or "text"), current_value)
            if problem is not None:
                break
            converted_values.append(converted)
        if problem is not None:
            warnings.append(f"колонка {column_key}: {problem}")
            continue
        chosen = next(
            (value for value in converted_values if not _same_value(value, current_value)),
            None,
        )
        if chosen is None or _same_value(chosen, current_value):
            continue
        try:
            _write_value(target, str(ref.get("col") or ""), chosen)
        except KeyError:
            warnings.append(f"колонка {column_key}: путь не найден в документе, пропущена")
            continue
        updated_cells += 1
        affected_rows.update(candidate["rows"])
    return {
        "updatedRows": len(affected_rows),
        "updatedCells": updated_cells,
        "warnings": list(dict.fromkeys(warnings)),
    }
