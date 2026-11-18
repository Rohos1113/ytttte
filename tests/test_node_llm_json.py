"""Полный JSON-ответ ЛЛМ по ноде: сборка документов и чтение без обрезки.

Ручка общая для всех ЛЛМ-нод (`app/web/routers/node_llm.py`): UI показывает
полный ``gpt_reply.txt`` вместо обрезанного ``replyPreview`` из meta.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException

from app.web.routers import node_llm


def _project(tmp_path: Path, *, meta: dict[str, Any] | None = None, **fields: Any) -> Any:
    """Минимальный двойник Project: data_dir + meta + поля проекта."""
    return SimpleNamespace(data_dir=tmp_path, meta=meta or {}, **fields)


def _graph(*nodes: tuple[str, str, str]) -> dict[str, Any]:
    return {
        "canvas_graph": {
            "nodes": [
                {"id": nid, "type": typ, "data": {"label": label}}
                for nid, typ, label in nodes
            ]
        }
    }


def _upload_dir(tmp_path: Path, node_key: str) -> Path:
    path = tmp_path / "excel_gpt_uploads" / node_key
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_reply_files_first_and_full(tmp_path: Path) -> None:
    key = "n_excel_gpt_pk_shots"
    up = _upload_dir(tmp_path, key)
    body = json.dumps({"shots": [{"id": 1}], "note": "я" * 4000}, ensure_ascii=False)
    (up / "gpt_reply.txt").write_text(body, encoding="utf-8")
    (up / "gpt_reply_raw.txt").write_text(body, encoding="utf-8")
    (up / "gpt_reply.txt.bak_v1_20261115_223050").write_text("old", encoding="utf-8")
    (up / "shots.json").write_text('{"shots": []}', encoding="utf-8")
    (up / "photo.png").write_bytes(b"\x89PNG\r\n")

    project = _project(tmp_path, meta=_graph((key, "excel_gpt", "Шоты")))
    docs = node_llm.collect_node_llm_documents(project, key)
    ids = [d["id"] for d in docs]

    assert ids[0] == "file:gpt_reply.txt"
    assert "file:shots.json" in ids
    # бэкапы, картинки и байт-в-байт дубликат raw в списке не нужны
    assert not any("bak" in doc_id for doc_id in ids)
    assert not any(doc_id.endswith(".png") for doc_id in ids)
    assert ids.count("file:gpt_reply_raw.txt") == 0

    full = node_llm.read_node_llm_document(project, key, "file:gpt_reply.txt")
    assert full["chars"] == len(body)
    assert full["text"] == body  # не 2000 символов preview, а весь ответ


def test_plan_node_shows_project_text(tmp_path: Path) -> None:
    project = _project(
        tmp_path,
        meta=_graph(("n_plan", "plan", "Сценарий")),
        general_plan="План ролика: 1) хук",
    )
    docs = node_llm.collect_node_llm_documents(project, "n_plan")
    assert [d["id"] for d in docs] == ["project:general_plan"]
    read = node_llm.read_node_llm_document(project, "n_plan", "project:general_plan")
    assert read["text"] == "План ролика: 1) хук"


def test_sfx_plan_meta_json(tmp_path: Path) -> None:
    plan = {"rows": [{"frame": 1, "sfx": "свист"}]}
    project = _project(
        tmp_path,
        meta={**_graph(("n_sfx_plan", "sfx_plan", "План звуков")), "sfx_plan": plan},
    )
    docs = node_llm.collect_node_llm_documents(project, "n_sfx_plan")
    assert [d["id"] for d in docs] == ["meta:sfx_plan"]
    read = node_llm.read_node_llm_document(project, "n_sfx_plan", "meta:sfx_plan")
    assert json.loads(read["text"]) == plan


def test_llm_node_without_reply_gets_placeholder(tmp_path: Path) -> None:
    key = "n_excel_gpt_pk_cast"
    project = _project(tmp_path, meta=_graph((key, "excel_gpt", "Персонажи")))
    docs = node_llm.collect_node_llm_documents(project, key)
    assert [d["id"] for d in docs] == ["file:gpt_reply.txt"]
    placeholder = docs[0]
    assert placeholder["exists"] is False
    assert placeholder["editable"] is True
    read = node_llm.read_node_llm_document(project, key, "file:gpt_reply.txt")
    assert read["text"] == ""


def test_non_llm_node_has_no_documents(tmp_path: Path) -> None:
    project = _project(tmp_path, meta=_graph(("n_assemble", "assemble", "Сборка")))
    assert node_llm.collect_node_llm_documents(project, "n_assemble") == []


def test_unknown_document_is_404(tmp_path: Path) -> None:
    project = _project(tmp_path, meta=_graph(("n_plan", "plan", "Сценарий")), general_plan="x")
    with pytest.raises(HTTPException) as err:
        node_llm.read_node_llm_document(project, "n_plan", "file:../../state.db")
    assert err.value.status_code == 404


def test_invalid_json_rejected(tmp_path: Path) -> None:
    with pytest.raises(HTTPException) as err:
        node_llm._require_json('{"a": }', "shots.json")
    assert err.value.status_code == 400
    assert "JSON" in str(err.value.detail)


def test_meta_result_file_goes_first(tmp_path: Path) -> None:
    """Полный JSON результата из meta (lastReplyPath) открывается первым."""
    key = "n_excel_gpt_pk_shots"
    up = _upload_dir(tmp_path, key)
    (up / "gpt_reply.txt").write_text('{"ops": []}', encoding="utf-8")
    full = json.dumps({"shots": [{"frame": index} for index in range(50)]}, ensure_ascii=False)
    (up / "shots.json").write_text(full, encoding="utf-8")
    project = _project(
        tmp_path,
        meta={
            **_graph((key, "excel_gpt", "Шоты")),
            "gpt_operator_results": {
                key: {"outputPaths": [str(up / "shots.json"), str(up / "gpt_reply.txt")]}
            },
            "excel_gpt_nodes": {key: {"lastReplyPath": str(up / "shots.json")}},
        },
    )
    docs = node_llm.collect_node_llm_documents(project, key)
    assert docs[0]["id"] == "meta:shots.json"
    assert docs[0]["name"] == "shots.json"
    read = node_llm.read_node_llm_document(project, key, "meta:shots.json")
    assert read["text"] == full
    # файл из meta не дублируется записью из папки ноды
    assert [d["id"] for d in docs].count("file:shots.json") == 0


def test_meta_result_path_outside_project_ignored(tmp_path: Path) -> None:
    """Путь из meta — клиентский ввод: читаем только файлы внутри проекта."""
    key = "n_excel_gpt_pk_cast"
    outside = tmp_path.parent / f"secret_{tmp_path.name}.json"
    outside.write_text('{"secret": true}', encoding="utf-8")
    up = _upload_dir(tmp_path, key)
    (up / "gpt_reply.txt").write_text("{}", encoding="utf-8")
    project = _project(
        tmp_path,
        meta={
            **_graph((key, "excel_gpt", "Персонажи")),
            "excel_gpt_nodes": {key: {"lastReplyPath": str(outside)}},
        },
    )
    ids = [d["id"] for d in node_llm.collect_node_llm_documents(project, key)]
    assert ids == ["file:gpt_reply.txt"]


def test_project_text_cannot_be_traversed(tmp_path: Path) -> None:
    """doc_id не должен давать чтение произвольного файла."""
    project = _project(tmp_path, meta=_graph(("n_plan", "plan", "Сценарий")), general_plan="x")
    for bad in ("file:../state.db", "file:../../windows/win.ini", "meta:..\\..\\state.db"):
        with pytest.raises(HTTPException) as err:
            node_llm.read_node_llm_document(project, "n_plan", bad)
        assert err.value.status_code == 404
