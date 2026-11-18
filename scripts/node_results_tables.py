#!/usr/bin/env python3
"""Экспорт таблиц результатов ЛЛМ-нод в JSON/CSV/XLSX.

Один универсальный скрипт на все ноды: берёт готовый ответ ручки
``GET /api/projects/{id}/node-llm/{key}/table`` — тот же, что видит UI, — и
раскладывает по файлам. Никаких правил под конкретную ноду здесь нет.
Нормализатор (``app.web.node_tables``) остаётся фолбэком: если сервер старый и
ручки ``/table`` ещё нет, документы тянутся через ``/documents`` и
нормализуются локально.

Примеры:

    python scripts/node_results_tables.py --project 2 --node n_excel_gpt_pk_shots
    python scripts/node_results_tables.py --project 2 --node n_excel_gpt_pk_shots \
        --node n_excel_gpt_pk_qc --format csv --out out
    python scripts/node_results_tables.py --project 2 --all --format xlsx --out out

Форматы: ``json`` — один файл-ответ на ноду; ``csv`` — файл на таблицу
(разделитель «;», BOM для Excel); ``xlsx`` — книга на ноду, лист на таблицу
плюс лист «Параметры». Длинные значения выгружаются целиком (``full=1``), а не
обрезанными до 2000 символов, как в API по умолчанию.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.web.node_tables import normalize_document  # noqa: E402

#: Что нельзя писать в имя файла/листа.
_BAD_NAME = re.compile(r'[\\/:*?"<>|\s]+')


def _api_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}{path}"


def _get_json(url: str, token: str | None = None) -> Any:
    """GET JSON из API студии (единственное место, где ходим в сеть)."""
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def _node_url(base_url: str, project_id: int, node_key: str) -> str:
    return _api_url(
        base_url,
        f"/api/projects/{project_id}/node-llm/{urllib.parse.quote(node_key, safe='')}",
    )


def project_llm_nodes(base_url: str, project_id: int, token: str | None = None) -> list[dict[str, str]]:
    """Все ЛЛМ-ноды проекта из ``meta.canvas_graph`` (``--all``)."""
    from app.web.routers.node_llm import _is_llm_node_type

    data = _get_json(_api_url(base_url, f"/api/projects/{project_id}"), token)
    meta = data.get("meta") if isinstance(data, dict) else None
    graph = (meta or {}).get("canvas_graph") if isinstance(meta, dict) else None
    nodes = (graph or {}).get("nodes") if isinstance(graph, dict) else None
    result: list[dict[str, str]] = []
    for node in nodes or []:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        node_type = str(node.get("type") or "")
        if not node_id or not _is_llm_node_type(node_type):
            continue
        data_field = node.get("data") if isinstance(node.get("data"), dict) else {}
        result.append(
            {"id": node_id, "type": node_type, "label": str(data_field.get("label") or "")}
        )
    return result


def node_documents(
    base_url: str,
    project_id: int,
    node_key: str,
    token: str | None = None,
) -> list[dict[str, Any]]:
    data = _get_json(f"{_node_url(base_url, project_id, node_key)}/documents", token)
    documents = data.get("documents") if isinstance(data, dict) else None
    return [doc for doc in documents or [] if isinstance(doc, dict)]


def node_table_url(
    base_url: str,
    project_id: int,
    node_key: str,
    doc_id: str | None = None,
) -> str:
    """URL ручки таблиц: полные тексты (``full=1``) и, если задан, один документ."""
    query: dict[str, str] = {"full": "1"}
    if doc_id:
        query["doc"] = doc_id
    return f"{_node_url(base_url, project_id, node_key)}/table?{urllib.parse.urlencode(query)}"


def api_node_tables(
    base_url: str,
    project_id: int,
    node_key: str,
    doc_id: str | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    """Готовый ответ ``/table`` — тот же, что получает UI (все источники ноды)."""
    data = _get_json(node_table_url(base_url, project_id, node_key, doc_id), token)
    if not isinstance(data, dict):
        raise ValueError(f"неожиданный ответ {node_key}/table")
    for key in ("tables", "params", "warnings", "sources"):
        data.setdefault(key, [])
    return data


def pick_document(documents: list[dict[str, Any]], doc_id: str | None = None) -> dict[str, Any] | None:
    """Выбранный документ или самый крупный JSON (как в API таблиц)."""
    if doc_id:
        return next((doc for doc in documents if str(doc.get("id")) == doc_id), None)

    def sort_key(doc: dict[str, Any]) -> tuple[int, int]:
        return (0 if doc.get("isJson") else 1, -int(doc.get("size") or 0))

    ordered = sorted(documents, key=sort_key)
    return ordered[0] if ordered else None


def document_text(
    base_url: str,
    project_id: int,
    node_key: str,
    doc_id: str,
    token: str | None = None,
) -> str:
    url = f"{_node_url(base_url, project_id, node_key)}/documents/{urllib.parse.quote(doc_id, safe='')}"
    data = _get_json(url, token)
    return str((data or {}).get("text") or "")


def local_node_tables(
    base_url: str,
    project_id: int,
    node_key: str,
    doc_id: str | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    """Фолбэк для сервера без ``/table``: документы по HTTP + общий нормализатор."""
    documents = node_documents(base_url, project_id, node_key, token)
    if not documents:
        raise RuntimeError("у ноды нет документов ответа")
    doc = pick_document(documents, doc_id)
    if doc is None:
        raise RuntimeError(f"документ {doc_id} не найден")
    text = document_text(base_url, project_id, node_key, str(doc["id"]), token)
    stem = Path(str(doc.get("name") or "")).stem
    result = normalize_document(text, full=True, name=stem or None)
    return {
        "nodeKey": node_key,
        "document": doc.get("id"),
        "name": doc.get("name"),
        "kind": result["kind"],
        "tables": result["tables"],
        "params": result["params"],
        "warnings": result["warnings"],
    }


def build_node_tables(
    base_url: str,
    project_id: int,
    node_key: str,
    doc_id: str | None = None,
    token: str | None = None,
) -> dict[str, Any]:
    """Таблицы одной ноды из ``/table``; старый сервер — локальная нормализация."""
    try:
        return api_node_tables(base_url, project_id, node_key, doc_id, token)
    except urllib.error.HTTPError as exc:
        # Ручки /table ещё нет (404/405) — работаем как раньше: сами читаем
        # документы и нормализуем локально. Прочие ошибки не глотаем.
        if exc.code not in (404, 405, 501):
            raise
        return local_node_tables(base_url, project_id, node_key, doc_id, token)


def _payload_kind(payload: dict[str, Any]) -> str:
    """Короткая метка для консоли: json / text / mixed."""
    if "kind" in payload:
        return str(payload["kind"])
    kinds = {
        str(source.get("kind"))
        for source in payload.get("sources") or []
        if isinstance(source, dict)
    }
    if not kinds:
        return "text"
    if kinds == {"json"}:
        return "json"
    return "mixed" if "json" in kinds else "text"


def _safe_name(text: str, fallback: str = "table") -> str:
    cleaned = _BAD_NAME.sub("_", str(text)).strip("_.")
    return cleaned[:80] or fallback


def _cell(value: Any) -> str:
    """Значение для CSV/XLSX: без потери типов, но всегда строкой."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def _table_columns(table: dict[str, Any]) -> list[dict[str, Any]]:
    return [col for col in table.get("columns") or [] if isinstance(col, dict)]


def write_json_file(path: Path, payload: dict[str, Any]) -> Path:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def write_csv_files(out_dir: Path, node_key: str, tables: list[dict[str, Any]]) -> list[Path]:
    """Файл на таблицу: разделитель «;», BOM — Excel открывает без плясок."""
    written: list[Path] = []
    for table in tables:
        columns = _table_columns(table)
        path = out_dir / f"{_safe_name(node_key)}__{_safe_name(str(table.get('id')))}.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle, delimiter=";")
            writer.writerow([str(col.get("label") or col.get("key")) for col in columns])
            for row in table.get("rows") or []:
                writer.writerow([_cell(row.get(col.get("key"))) for col in columns])
        written.append(path)
    return written


def _sheet_title(title: str, used: set[str]) -> str:
    base = _safe_name(title, "Лист")[:31]
    candidate = base
    suffix = 2
    while candidate.lower() in used:
        tail = f"_{suffix}"
        candidate = f"{base[: 31 - len(tail)]}{tail}"
        suffix += 1
    used.add(candidate.lower())
    return candidate


def write_xlsx_file(
    path: Path,
    tables: list[dict[str, Any]],
    params: list[dict[str, Any]],
) -> Path:
    """Книга на ноду: лист на таблицу + лист «Параметры»."""
    from openpyxl import Workbook

    workbook = Workbook()
    workbook.remove(workbook.active)
    used: set[str] = set()
    for table in tables:
        columns = _table_columns(table)
        sheet = workbook.create_sheet(_sheet_title(str(table.get("title") or table.get("id")), used))
        sheet.append([str(col.get("label") or col.get("key")) for col in columns])
        for row in table.get("rows") or []:
            sheet.append([_cell(row.get(col.get("key"))) for col in columns])
    if params:
        sheet = workbook.create_sheet(_sheet_title("Параметры", used))
        sheet.append(["Параметр", "Значение"])
        for param in params:
            sheet.append([str(param.get("label") or param.get("key")), str(param.get("value") or "")])
    if not workbook.sheetnames:
        workbook.create_sheet("Пусто")
    workbook.save(path)
    return path


def export_node(
    out_dir: Path,
    node_key: str,
    payload: dict[str, Any],
    fmt: str,
) -> list[Path]:
    if fmt == "json":
        return [write_json_file(out_dir / f"{_safe_name(node_key)}.json", payload)]
    if fmt == "csv":
        return write_csv_files(out_dir, node_key, payload["tables"])
    return [write_xlsx_file(out_dir / f"{_safe_name(node_key)}.xlsx", payload["tables"], payload["params"])]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Таблицы результатов ЛЛМ-нод: нормализация JSON в строки и экспорт",
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8766", help="адрес студии")
    parser.add_argument("--project", type=int, help="id проекта")
    parser.add_argument("--node", action="append", default=[], help="ключ ноды (можно несколько)")
    parser.add_argument("--all", action="store_true", help="все ЛЛМ-ноды проекта")
    parser.add_argument("--format", choices=("json", "csv", "xlsx"), default="json")
    parser.add_argument("--out", default="node_tables", help="каталог для файлов")
    parser.add_argument("--token", default=None, help="Bearer-токен студии (если включена авторизация)")
    parser.add_argument(
        "--doc", default=None, help="id документа (по умолчанию все источники ноды)"
    )
    args = parser.parse_args(argv)

    if args.project is None:
        parser.error("нужен --project")
    node_keys = list(args.node)
    if args.all:
        node_keys = [
            node["id"] for node in project_llm_nodes(args.base_url, args.project, args.token)
        ]
    if not node_keys:
        parser.error("нужен --node или --all")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    failed = 0
    for node_key in node_keys:
        try:
            payload = build_node_tables(
                args.base_url,
                args.project,
                node_key,
                doc_id=args.doc,
                token=args.token,
            )
        except (urllib.error.URLError, OSError, RuntimeError, ValueError) as exc:
            print(f"[{node_key}] не выгружено: {exc}", file=sys.stderr)
            failed += 1
            continue
        files = export_node(out_dir, node_key, payload, args.format)
        rows = sum(len(table.get("rows") or []) for table in payload["tables"])
        sources = len(payload.get("sources") or [])
        print(
            f"[{node_key}] {_payload_kind(payload)}: источников {sources}, "
            f"таблиц {len(payload['tables'])}, строк {rows}, файлов {len(files)}"
        )
        for path in files:
            print(f"    {path}")
    if failed:
        print(f"ошибок: {failed}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
