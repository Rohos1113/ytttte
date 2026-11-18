"""Полный ответ ЛЛМ по ноде: чтение, правка, загрузка и сохранение.

Зачем это нужно. В «Результатах» ЛЛМ-ноды UI показывал только ``replyPreview``
из meta (обрезано до 2000 символов), а полный ответ модели лежит на диске
(``gpt_reply.txt``) и дотянуться до него из окна было нечем. Здесь одна общая
ручка на все ЛЛМ-ноды: источники документов собираются по типу ноды и её папке,
поэтому отдельного эндпоинта на каждый тип не нужно.

Документы бывают трёх видов:

* ``file`` — файл ноды на диске (``gpt_reply.txt``, ``gpt_reply_raw.txt``,
  ``analysis.json``, ``shots.json``, паспорт стиля и т.п.);
* ``project_text`` — ответ модели живёт в поле проекта (``general_plan``,
  ``script_text``), отдельного файла у него нет;
* ``meta_json`` — ответ лежит в ``project.meta`` (план звуков).

Если ответа ещё нет, для ЛЛМ-ноды отдаётся пустой документ-заготовка
(``exists=false``) — окно открывается, в него можно вставить/загрузить JSON и
сохранить: файл появится на диске.

UI: ``web/src/components/canvas/node-llm-json-dialog.tsx`` (кнопка «JSON ответа»
в «Результатах» ноды).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import commit_with_retry
from app.models import Project
from app.web import node_tables, table_import
from app.web.deps import get_session

router = APIRouter(prefix="/projects", tags=["node-llm"])

#: Имена главного ответа модели — такие документы идут первыми в списке.
_REPLY_FIRST: tuple[str, ...] = (
    "gpt_reply.txt",
    "gpt_reply_raw.txt",
    "check_report.txt",
    "analysis.json",
)
_TEXT_SUFFIXES: frozenset[str] = frozenset({".txt", ".json", ".jsonl", ".md"})
_JSON_SUFFIXES: frozenset[str] = frozenset({".json", ".jsonl"})
_MAX_DOC_BYTES: int = 16 * 1024 * 1024
_MAX_DOCS: int = 40

#: Ноды, чей ответ модели хранится в поле проекта, а не в файле ноды.
_PROJECT_TEXT_FIELDS: dict[str, str] = {
    "plan": "general_plan",
    "script": "script_text",
}
#: Ответ «Плана звуков» — JSON в meta проекта.
_SFX_PLAN_TYPES: frozenset[str] = frozenset({"sfx_plan"})
#: Паспорт стиля от агента разбора референсов.
_STYLE_TYPES: frozenset[str] = frozenset({"style_extract", "hitl_style"})

#: Заготовка ответа для ЛЛМ-ноды, у которой файла ещё нет.
_REPLY_PLACEHOLDER: str = "gpt_reply.txt"


def _project_or_404(project: Project | None) -> Project:
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _infer_node_type(node_key: str) -> str:
    """Тип ноды по ключу — если в canvas_graph её уже нет (старые проекты)."""
    key = str(node_key or "").strip().lower()
    if not key:
        return ""
    if "sfx_plan" in key:
        return "sfx_plan"
    if "excel_gpt" in key or key.startswith("enrich") or "_enrich_" in key:
        return "excel_gpt"
    if "style" in key:
        return "style_extract"
    if "script" in key or "voiceover" in key:
        return "script"
    if key.endswith("_plan") or key == "plan":
        return "plan"
    return ""


def _node_info(project: Project, node_key: str) -> tuple[str, str]:
    """(тип ноды, её подпись) из ``meta.canvas_graph``."""
    meta = project.meta if isinstance(project.meta, dict) else {}
    graph: dict[str, Any] = {}
    try:
        from app.services.canvas_graph import canvas_graph_from_meta

        graph = canvas_graph_from_meta(meta) or {}
    except Exception:  # noqa: BLE001 — тип можно вывести по ключу
        graph = {}
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        if str(node.get("id") or "") != str(node_key):
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        return str(node.get("type") or ""), str(data.get("label") or "").strip()
    return _infer_node_type(node_key), ""


def _upload_dir(project: Project, node_key: str) -> Path:
    from app.services.excel_gpt_node import upload_dir

    return upload_dir(project, node_key)


def _is_llm_node_type(node_type: str) -> bool:
    node_type = str(node_type or "")
    if not node_type:
        return False
    if node_type == "excel_gpt" or node_type.startswith("enrich"):
        return True
    if node_type in _PROJECT_TEXT_FIELDS or node_type in _SFX_PLAN_TYPES:
        return True
    return node_type in _STYLE_TYPES


def _label_for(name: str) -> str:
    low = name.lower()
    if low.startswith("gpt_reply.txt"):
        return "Ответ модели (gpt_reply.txt)"
    if low.startswith("gpt_reply_raw.txt"):
        return "Сырой ответ (gpt_reply_raw.txt)"
    return name


def _doc_meta(
    *,
    doc_id: str,
    name: str,
    label: str,
    kind: str,
    path: Path | None,
    size: int,
    updated_at: str | None,
    is_json: bool,
    exists: bool = True,
    editable: bool = True,
    field: str | None = None,
) -> dict[str, Any]:
    return {
        "id": doc_id,
        "name": name,
        "label": label,
        "kind": kind,
        "path": str(path) if path is not None else None,
        "size": int(size),
        "updatedAt": updated_at,
        "isJson": bool(is_json),
        "exists": bool(exists),
        "editable": bool(editable),
        "field": field,
    }


def _file_doc(path: Path, *, doc_id: str, label: str | None = None) -> dict[str, Any]:
    stat = path.stat()
    return _doc_meta(
        doc_id=doc_id,
        name=path.name,
        label=label or _label_for(path.name),
        kind="file",
        path=path,
        size=stat.st_size,
        updated_at=datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(),
        is_json=path.suffix.lower() in _JSON_SUFFIXES,
    )


def _scan_text_dir(base: Path, prefix: str) -> list[dict[str, Any]]:
    """Текстовые/json-файлы папки ноды (без бэкапов и картинок)."""
    if not base.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if len(rows) >= _MAX_DOCS:
            break
        try:
            if not path.is_file():
                continue
            name = path.name
            if path.suffix.lower() not in _TEXT_SUFFIXES:
                continue
            if ".bak" in name.lower() or name.lower().endswith("~"):
                continue
            size = path.stat().st_size
        except OSError:
            continue
        if size <= 0 or size > _MAX_DOC_BYTES:
            continue
        rows.append(_file_doc(path, doc_id=f"{prefix}{name}"))
    # Главный ответ — первым; остальное по имени.
    order = {name: idx for idx, name in enumerate(_REPLY_FIRST)}

    def sort_key(doc: dict[str, Any]) -> tuple[int, str]:
        return (order.get(str(doc["name"]).lower(), len(order)), str(doc["name"]).lower())

    rows.sort(key=sort_key)
    return rows


def _style_docs(project: Project) -> list[dict[str, Any]]:
    from app.services.style_agent import job as sa_job

    out: list[dict[str, Any]] = []
    candidates = [
        ("style_passport.json", "Паспорт стиля (style_passport.json)"),
        ("style_passport.draft.json", "Черновик паспорта (draft.json)"),
        ("style_report.md", "Отчёт агента стиля"),
        ("apply_report.json", "Отчёт применения стиля"),
        ("llm_calls.jsonl", "Журнал вызовов LLM (jsonl)"),
    ]
    for name, label in candidates:
        path = sa_job.style_dir(project) / name
        try:
            if not path.is_file() or path.stat().st_size <= 0:
                continue
        except OSError:
            continue
        out.append(_file_doc(path, doc_id=f"style:{name}", label=label))
    return out


def _project_text_doc(project: Project, node_type: str) -> dict[str, Any] | None:
    field = _PROJECT_TEXT_FIELDS.get(node_type)
    if not field:
        return None
    text = str(getattr(project, field, "") or "")
    label = "План сценария (поле проекта)" if field == "general_plan" else "Закадровый текст (поле проекта)"
    return _doc_meta(
        doc_id=f"project:{field}",
        name=f"{field}.txt",
        label=label,
        kind="project_text",
        path=None,
        size=len(text.encode("utf-8")),
        updated_at=None,
        is_json=False,
        exists=bool(text.strip()),
        field=field,
    )


def _meta_json_doc(project: Project, node_type: str) -> dict[str, Any] | None:
    if node_type not in _SFX_PLAN_TYPES:
        return None
    meta = project.meta if isinstance(project.meta, dict) else {}
    plan = meta.get("sfx_plan")
    if plan is None:
        return None
    try:
        text = json.dumps(plan, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return None
    return _doc_meta(
        doc_id="meta:sfx_plan",
        name="sfx_plan.json",
        label="План звуков (JSON из meta)",
        kind="meta_json",
        path=None,
        size=len(text.encode("utf-8")),
        updated_at=None,
        is_json=True,
        exists=True,
    )


def _meta_result_paths(project: Project, node_key: str) -> list[Path]:
    """Файлы результата ноды, записанные в meta: lastReplyPath + outputPaths.

    Для excel-нод «полный JSON ответа» — это не только gpt_reply.txt (в нём
    только ops-команды), а файл результата: shots.json, plan_scenes.json,
    qc_report.json и т.п. Именно эти пути пайплайн пишет в meta, поэтому они
    идут первыми и открываются по умолчанию.
    """
    meta = project.meta if isinstance(project.meta, dict) else {}
    results = meta.get("gpt_operator_results")
    entry = results.get(node_key) if isinstance(results, dict) else None
    entry = entry if isinstance(entry, dict) else {}
    nodes = meta.get("excel_gpt_nodes")
    cfg = nodes.get(node_key) if isinstance(nodes, dict) else None
    cfg = cfg if isinstance(cfg, dict) else {}

    raw: list[str] = []
    for candidate in (cfg.get("lastReplyPath"), *(entry.get("outputPaths") or [])):
        if isinstance(candidate, str) and candidate.strip():
            raw.append(candidate.strip())

    try:
        root = Path(str(project.data_dir)).resolve()
    except (OSError, TypeError):
        return []
    found: list[Path] = []
    seen: set[str] = set()
    for item in raw:
        path = Path(item)
        if not path.is_absolute():
            path = root / path
        try:
            path = path.resolve()
            path.relative_to(root)
        except (OSError, ValueError):
            continue  # путь из meta подконтролен клиенту — только внутри проекта
        if path.suffix.lower() not in _TEXT_SUFFIXES or not path.is_file():
            continue
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        found.append(path)
    return found


def collect_node_llm_documents(project: Project, node_key: str) -> list[dict[str, Any]]:
    """Все документы ответа ЛЛМ для ноды: файлы ноды + поля проекта/meta."""
    node_type, _label = _node_info(project, node_key)
    docs: list[dict[str, Any]] = []

    # Сначала — файл результата ноды из meta (самый полный JSON), потом папка ноды.
    meta_docs = [
        _file_doc(path, doc_id=f"meta:{path.name}", label=f"Результат ноды ({path.name})")
        for path in _meta_result_paths(project, node_key)
    ]
    covered = {str(Path(str(doc["path"])).resolve()).lower() for doc in meta_docs if doc.get("path")}
    file_docs = [
        doc
        for doc in _scan_text_dir(_upload_dir(project, node_key), "file:")
        if str(Path(str(doc["path"])).resolve()).lower() not in covered
    ]
    # gpt_reply_raw.txt — тот же ответ; дубликат по размеру не показываем.
    sizes = {str(d["name"]): int(d["size"]) for d in file_docs}
    if sizes.get("gpt_reply_raw.txt") and sizes.get("gpt_reply_raw.txt") == sizes.get("gpt_reply.txt"):
        file_docs = [d for d in file_docs if d["name"] != "gpt_reply_raw.txt"]
    docs.extend(meta_docs)
    docs.extend(file_docs)
    # gpt_reply_raw.txt — тот же ответ; прячем дубликат, даже если gpt_reply.txt
    # пришёл из meta (тогда размеры в file_docs не с чем сравнить).
    reply = next((doc for doc in docs if doc["name"] == "gpt_reply.txt"), None)
    raw = next((doc for doc in docs if doc["name"] == "gpt_reply_raw.txt"), None)
    if reply is not None and raw is not None and int(reply["size"]) == int(raw["size"]):
        docs = [doc for doc in docs if doc is not raw]

    if node_type in _STYLE_TYPES:
        docs.extend(_style_docs(project))

    text_doc = _project_text_doc(project, node_type)
    if text_doc is not None:
        docs.append(text_doc)

    meta_doc = _meta_json_doc(project, node_type)
    if meta_doc is not None:
        docs.append(meta_doc)

    # ЛЛМ-нода без ответа: отдаём заготовку, чтобы окно открывалось и можно было
    # вставить/загрузить JSON и сохранить его как файл ноды.
    if not docs and _is_llm_node_type(node_type):
        target = _upload_dir(project, node_key) / _REPLY_PLACEHOLDER
        docs.append(
            _doc_meta(
                doc_id=f"file:{_REPLY_PLACEHOLDER}",
                name=_REPLY_PLACEHOLDER,
                label=_label_for(_REPLY_PLACEHOLDER),
                kind="file",
                path=target,
                size=0,
                updated_at=None,
                is_json=False,
                exists=False,
            )
        )
    return docs


def _find_document(project: Project, node_key: str, doc_id: str) -> dict[str, Any]:
    docs = collect_node_llm_documents(project, node_key)
    for doc in docs:
        if doc["id"] == doc_id:
            return doc
    # Заготовка ``file:gpt_reply.txt`` после первой записи может получить id
    # ``meta:gpt_reply.txt`` (файл попал в meta результата) — ищем по имени.
    name = doc_id.split(":", 1)[1] if ":" in doc_id else ""
    if name:
        for doc in docs:
            if str(doc.get("name") or "") == name:
                return doc
    raise HTTPException(status_code=404, detail="document not found")


def read_node_llm_document(project: Project, node_key: str, doc_id: str) -> dict[str, Any]:
    """Полный текст документа ответа (без обрезки до preview)."""
    doc = _find_document(project, node_key, doc_id)
    kind = doc["kind"]
    text = ""
    if kind == "file":
        path = Path(str(doc["path"]))
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"не прочитать {path.name}: {exc}") from exc
    elif kind == "project_text":
        text = str(getattr(project, str(doc.get("field") or ""), "") or "")
    elif kind == "meta_json":
        text = json.dumps(
            (project.meta or {}).get("sfx_plan"),
            ensure_ascii=False,
            indent=2,
        )
    return {
        **doc,
        "text": text,
        "chars": len(text),
        "size": len(text.encode("utf-8")),
    }


def _backup_file(path: Path) -> Path | None:
    """Копия предыдущей версии рядом: ``gpt_reply.txt.bak_llmjson_YYYYmmdd_HHMMSS``."""
    if not path.is_file():
        return None
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = path.with_name(f"{path.name}.bak_llmjson_{stamp}")
    try:
        backup.write_bytes(path.read_bytes())
    except OSError:
        return None
    return backup


def _sync_reply_preview(project: Project, node_key: str, path: Path, text: str) -> None:
    """Обновить ``replyPreview`` в meta — иначе «Результаты» покажут старый текст."""
    if path.name != "gpt_reply.txt":
        return
    from sqlalchemy.orm.attributes import flag_modified

    meta = dict(project.meta or {}) if isinstance(project.meta, dict) else {}
    results = dict(meta.get("gpt_operator_results") or {})
    entry = dict(results.get(node_key) or {})
    entry["replyPreview"] = text[:2000]
    entry["at"] = _now_iso()
    entry["outputPaths"] = list(entry.get("outputPaths") or [])
    if str(path) not in entry["outputPaths"]:
        entry["outputPaths"].append(str(path))
    results[node_key] = entry
    meta["gpt_operator_results"] = results
    project.meta = meta
    try:
        flag_modified(project, "meta")
    except Exception:  # noqa: BLE001 — не ORM-объект (тесты/скрипты)
        pass


async def _save_file_document(
    project: Project,
    node_key: str,
    doc: dict[str, Any],
    text: str,
) -> dict[str, Any]:
    path = Path(str(doc["path"]))
    if path.suffix.lower() in _JSON_SUFFIXES:
        _require_json(text, path.name)
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = _backup_file(path)
    body = text if text.endswith("\n") else f"{text}\n"
    try:
        path.write_text(body, encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"не записать {path.name}: {exc}") from exc
    _sync_reply_preview(project, node_key, path, text)
    return {
        "kind": "file",
        "path": str(path),
        "backup": str(backup) if backup is not None else None,
    }


def _require_json(text: str, name: str) -> None:
    try:
        json.loads(text)
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{name}: это не валидный JSON — {exc}",
        ) from exc


async def save_node_llm_document(
    project: Project,
    node_key: str,
    doc_id: str,
    text: str,
    session: AsyncSession,
) -> dict[str, Any]:
    """Записать правку документа (с бэкапом предыдущей версии файла)."""
    if len(text.encode("utf-8")) > _MAX_DOC_BYTES:
        raise HTTPException(status_code=413, detail="документ слишком большой")
    doc = _find_document(project, node_key, doc_id)
    if not doc.get("editable", True):
        raise HTTPException(status_code=403, detail="документ только для чтения")
    kind = doc["kind"]
    saved: dict[str, Any] = {}
    if kind == "file":
        saved = await _save_file_document(project, node_key, doc, text)
    elif kind == "project_text":
        field = str(doc.get("field") or "")
        if field not in ("general_plan", "script_text"):
            raise HTTPException(status_code=400, detail="неизвестное поле проекта")
        setattr(project, field, text)
        saved = {"kind": "project_text", "field": field}
    elif kind == "meta_json":
        _require_json(text, str(doc.get("name") or "meta"))
        from sqlalchemy.orm.attributes import flag_modified

        meta = dict(project.meta or {}) if isinstance(project.meta, dict) else {}
        meta["sfx_plan"] = json.loads(text)
        project.meta = meta
        try:
            flag_modified(project, "meta")
        except Exception:  # noqa: BLE001 — не ORM-объект (тесты/скрипты)
            pass
        saved = {"kind": "meta_json", "field": "sfx_plan"}
    else:  # pragma: no cover — новые виды документов сюда не попадут
        raise HTTPException(status_code=400, detail="неизвестный вид документа")
    await commit_with_retry(session)
    fresh = read_node_llm_document(project, node_key, doc_id)
    return {
        "ok": True,
        "id": doc_id,
        "name": fresh["name"],
        "savedAt": _now_iso(),
        "chars": fresh["chars"],
        "size": fresh["size"],
        **saved,
    }


@router.get("/{project_id}/node-llm/{node_key}/documents")
async def list_node_llm_documents(
    project_id: int,
    node_key: str,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Список документов полного ответа ЛЛМ для ноды."""
    project = _project_or_404(await session.get(Project, project_id))
    node_type, label = _node_info(project, node_key)
    docs = collect_node_llm_documents(project, node_key)
    return {
        "nodeKey": node_key,
        "nodeType": node_type,
        "label": label,
        "llm": _is_llm_node_type(node_type),
        "documents": docs,
    }


@router.get("/{project_id}/node-llm/{node_key}/documents/{doc_id}")
async def get_node_llm_document(
    project_id: int,
    node_key: str,
    doc_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Полный текст одного документа ответа."""
    project = _project_or_404(await session.get(Project, project_id))
    return read_node_llm_document(project, node_key, doc_id)


@router.put("/{project_id}/node-llm/{node_key}/documents/{doc_id}")
async def put_node_llm_document(
    project_id: int,
    node_key: str,
    doc_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Сохранить правку документа (JSON проверяется, старая версия — в .bak)."""
    project = _project_or_404(await session.get(Project, project_id))
    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="нужен текст документа в поле text")
    return await save_node_llm_document(project, node_key, doc_id, text, session)


def _node_in_graph(project: Project, node_key: str) -> bool:
    """Есть ли нода в ``canvas_graph`` проекта (иначе ручка таблиц даёт 404)."""
    meta = project.meta if isinstance(project.meta, dict) else {}
    try:
        from app.services.canvas_graph import canvas_graph_from_meta

        graph = canvas_graph_from_meta(meta) or {}
    except Exception:  # noqa: BLE001 — граф не прочитался: не отказываем сгоряча
        return True
    for node in graph.get("nodes") or []:
        if isinstance(node, dict) and str(node.get("id") or "") == str(node_key):
            return True
    return False


def _doc_stem(name: str) -> str:
    """Имя источника без расширения: ``plan_scenes.json`` → ``plan_scenes``."""
    stem = Path(str(name)).stem
    return stem or str(name)


def _document_text_for_table(project: Project, node_key: str, item: dict[str, Any]) -> str:
    """Текст документа для нормализации; нечитаемый — 400 (а не 500)."""
    try:
        read = read_node_llm_document(project, node_key, str(item["id"]))
    except HTTPException as exc:
        if exc.status_code >= 500:
            raise HTTPException(
                status_code=400,
                detail=f"документ не читается: {exc.detail}",
            ) from exc
        raise
    return str(read.get("text") or "")


def _collect_node_tables(
    project: Project,
    node_key: str,
    *,
    doc: str | None,
    full: bool,
    with_refs: bool = False,
) -> dict[str, Any]:
    """Собрать ответ ``GET /table`` (и скрытые refs для импорта правок).

    ``refs`` — пути значений в исходном JSON-документе; в JSON-ответ ручки
    ``/table`` они не попадают (ручка зовёт нормализатор без ``with_refs``).
    """
    node_type, label = _node_info(project, node_key)
    documents = collect_node_llm_documents(project, node_key)
    if doc:
        documents = [item for item in documents if item["id"] == doc]
        if not documents:
            raise HTTPException(status_code=404, detail="document not found")
    elif not documents:
        # Нода без документов — это 200 с предупреждением, а не 404 (спека 5.6):
        # вкладка «Результат» не должна уходить в ошибку.
        if not _node_in_graph(project, node_key):
            raise HTTPException(status_code=404, detail="нода не найдена в графе проекта")
        return {
            "payload": {
                "nodeKey": node_key,
                "nodeType": node_type,
                "label": label,
                "sources": [],
                "tables": [],
                "params": [],
                "warnings": [f"нет документов ответа ЛЛМ для ноды {node_key}"],
            },
            "refs": [],
            "items": [],
        }

    prepared: list[dict[str, Any]] = []
    for item in documents:
        text = _document_text_for_table(project, node_key, item)
        result = node_tables.normalize_document(
            text,
            full=full,
            name=_doc_stem(str(item.get("name") or "")),
            with_refs=with_refs,
        )
        prepared.append({"item": item, "result": result, "text": text})
    if not doc:
        # Основной — самый крупный JSON. Флаг isJson — только подсказка,
        # тип документа определяется разбором текста (спека 2).
        prepared.sort(
            key=lambda entry: (
                0 if entry["result"]["kind"] == "json" else 1,
                -int(entry["item"].get("size") or 0),
            )
        )

    multi = len(prepared) > 1
    sources: list[dict[str, Any]] = []
    tables: list[dict[str, Any]] = []
    params: list[dict[str, Any]] = []
    warnings: list[str] = []
    refs: list[dict[str, Any]] = []
    used_param_keys: set[str] = set()
    for entry in prepared:
        item = entry["item"]
        result = entry["result"]
        stem = _doc_stem(str(item.get("name") or ""))
        source_tables = result["tables"]
        source_refs = result.get("refs") or []
        sources.append(
            {
                "id": item["id"],
                "name": item["name"],
                "size": int(item.get("size") or 0),
                "kind": result["kind"],
                "rows": sum(int(table["total"]) for table in source_tables),
                "tables": len(source_tables),
            }
        )
        for index, table in enumerate(source_tables):
            table_entry = dict(table)
            if multi:
                table_entry["id"] = f"{stem}.{table_entry['id']}"
                table_entry["title"] = f"{item['name']} · {table_entry['title']}"
            tables.append(table_entry)
            if with_refs and index < len(source_refs):
                ref_entry = dict(source_refs[index])
                if multi:
                    ref_entry["id"] = f"{stem}.{ref_entry['id']}"
                ref_entry["document"] = item["id"]
                refs.append(ref_entry)
        for param in result["params"]:
            entry_param = dict(param)
            if multi and entry_param["key"] in used_param_keys:
                entry_param["key"] = f"{stem}.{entry_param['key']}"
                entry_param["label"] = f"{stem}.{entry_param['label']}"
            used_param_keys.add(str(entry_param["key"]))
            params.append(entry_param)
        for warning in result["warnings"]:
            message = warning
            if warning == "документ пуст":
                message = f"документ пуст: {item['name']}"
            elif multi:
                message = f"{stem}: {warning}"
            if message not in warnings:
                warnings.append(message)
    payload = {
        "nodeKey": node_key,
        "nodeType": node_type,
        "label": label,
        "sources": sources,
        "tables": tables,
        "params": params,
        "warnings": warnings,
    }
    return {"payload": payload, "refs": refs, "items": prepared}


@router.get("/{project_id}/node-llm/{node_key}/table")
async def get_node_llm_table(
    project_id: int,
    node_key: str,
    doc: str | None = None,
    full: bool = False,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Универсальная таблица ответа ЛЛМ-ноды: JSON → строки, проза → блоки.

    Без ``doc`` берутся все документы ноды, основной — самый крупный JSON;
    таблицы остальных источников идут в тот же ответ с префиксом источника
    в ``id``. ``?full=1`` отдаёт длинные тексты целиком (по умолчанию 2000).
    """
    project = _project_or_404(await session.get(Project, project_id))
    collected = _collect_node_tables(project, node_key, doc=doc, full=full)
    return collected["payload"]


@router.get("/{project_id}/node-llm/{node_key}/table/xlsx")
async def get_node_llm_table_xlsx(
    project_id: int,
    node_key: str,
    doc: str | None = None,
    full: bool = False,
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Скачать авто-таблицу ноды в xlsx (лист на таблицу, заголовки как в UI)."""
    project = _project_or_404(await session.get(Project, project_id))
    # В файл отдаём полные значения: обрезка до 2000 нужна только ответу API.
    # Параметр full оставлен для совместимости с контрактом GET /table.
    collected = _collect_node_tables(project, node_key, doc=doc, full=True)
    content = table_import.build_xlsx(collected["payload"]["tables"])
    filename = f"{node_key}-table.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{project_id}/node-llm/{node_key}/table/upload")
async def upload_node_llm_table(
    project_id: int,
    node_key: str,
    file: UploadFile = File(...),
    doc: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Загрузить xlsx/json/csv и обновить значения в JSON-документе ноды.

    Сверяются заголовки колонок и строки (по ключевым колонкам), меняются только
    значения; структура документа сохраняется, прежняя версия файла — в
    ``.bak`` (это делает ``save_node_llm_document``). Проза-документы (n_plan,
    n_script, cast с прозой) не редактируются — 400.
    """
    project = _project_or_404(await session.get(Project, project_id))
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="пустой файл")
    if len(data) > _MAX_DOC_BYTES:
        raise HTTPException(status_code=413, detail="файл слишком большой")
    try:
        parsed_sheets = table_import.parse_upload_sheets(data, str(file.filename or ""))
    except table_import.TableImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    collected = _collect_node_tables(project, node_key, doc=doc, full=True, with_refs=True)
    tables = collected["payload"]["tables"]
    roots: dict[str, Any] = {}
    original_text: dict[str, str] = {}
    totals = {"rows": 0, "cells": 0}
    doc_cells: dict[str, int] = {}
    warnings: list[str] = []
    applied_desc: list[str] = []
    first_document = ""
    for parsed in parsed_sheets:
        # Один лист (или csv/json) — как раньше: без совпадения имени берём
        # основную таблицу. Много листов — строго по имени, чужие пропускаем.
        table_index = (
            table_import.choose_table(tables, parsed.sheet)
            if len(parsed_sheets) == 1
            else table_import.find_table_index(tables, parsed.sheet)
        )
        if table_index is None:
            if parsed.sheet:
                warnings.append(f"лист «{parsed.sheet}»: такой таблицы у ноды нет — пропущен")
            continue
        refs = collected["refs"][table_index] if table_index < len(collected["refs"]) else None
        if refs is None or not refs.get("columns"):
            warnings.append(
                f"таблица {tables[table_index].get('id')}: нет привязки к JSON-документу — пропущена"
            )
            continue
        document_id = str(refs.get("document") or "")
        if not document_id:
            warnings.append(f"таблица {tables[table_index].get('id')}: документ не определён — пропущена")
            continue
        if document_id not in roots:
            entry = next(
                (item for item in collected["items"] if item["item"]["id"] == document_id),
                None,
            )
            if entry is None:
                raise HTTPException(status_code=404, detail="document not found")
            try:
                roots[document_id] = json.loads(entry["text"])
            except ValueError as exc:
                name = str(entry["item"].get("name") or document_id)
                raise HTTPException(
                    status_code=400,
                    detail=f"документ {name} — не JSON, загрузка таблицы не поддерживается",
                ) from exc
            original_text[document_id] = str(entry["text"])
        if not first_document:
            first_document = document_id

        try:
            stats = table_import.apply_upload(roots[document_id], tables[table_index], refs, parsed.rows)
        except table_import.TableImportError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        totals["rows"] += int(stats["updatedRows"])
        totals["cells"] += int(stats["updatedCells"])
        doc_cells[document_id] = doc_cells.get(document_id, 0) + int(stats["updatedCells"])
        warnings.extend(str(item) for item in stats["warnings"])
        applied_desc.append(str(tables[table_index].get("id")))

    if not applied_desc:
        raise HTTPException(
            status_code=400,
            detail="таблица не привязана к JSON-документу: загрузка правок недоступна",
        )

    saved = False
    for document_id, root in roots.items():
        if not doc_cells.get(document_id):
            continue  # правок нет — файл не переформатируем и не трогаем
        new_text = json.dumps(root, ensure_ascii=False, indent=2)
        if new_text == original_text.get(document_id):
            continue
        await save_node_llm_document(project, node_key, document_id, new_text, session)
        saved = True

    return {
        "ok": True,
        "nodeKey": node_key,
        "document": first_document,
        "saved": saved,
        "updatedRows": totals["rows"],
        "updatedCells": totals["cells"],
        "applied": applied_desc,
        "warnings": warnings,
        "tables": [{"id": str(table.get("id")), "rows": len(table.get("rows") or [])} for table in tables],
    }
