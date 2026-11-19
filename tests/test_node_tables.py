"""Универсальные таблицы ответов ЛЛМ-нод: нормализатор, ручка /table и CLI.

Ручка ``GET /api/projects/{id}/node-llm/{key}/table`` отдаёт таблицы для любой
ЛЛМ-ноды: JSON раскладывается на строки (с разворотом вложенных объектов и
склейкой массивов-спутников), проза — на блоки, JSON-фрагмент после прозы
(случай cast) разбирается отдельно. Правила живут в ``app/web/node_tables.py``,
их же использует ``scripts/node_results_tables.py``. Ожидания — по спеке
``docs/node-result-tables.md`` (разделы 3.x и 4.1).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session as SyncSession
from sqlalchemy.pool import NullPool

from app.models import Base, Project
from app.settings import settings
from app.web import node_tables
from app.web.deps import get_session
from app.web.routers import node_llm

_NODES: tuple[tuple[str, str, str], ...] = (
    ("n_plan", "plan", "Сценарий"),
    ("n_excel_gpt_pk_shots", "excel_gpt", "Шоты"),
    ("n_excel_gpt_pk_qc", "excel_gpt", "QC"),
    ("n_excel_gpt_pk_cast", "excel_gpt", "Персонажи"),
    ("n_excel_gpt_pk_report", "excel_gpt", "Отчёт"),
    ("n_images", "images", "Картинки"),
)
_PLAN_TEXT = 'Вступление без заголовка.\n\nГлава I\n\nПервый абзац.\nВторая строка.\n\nГлава II\n\nЕщё абзац.'
_CAST_TEXT = (
    "Собираю реестр персонажей по первому появлению, отделяю людей от толпы.{\n"
    '  "персонажи": [\n'
    '    {"id": "c01", "имя": "Аделфус", "внешность": "юноша"},\n'
    '    {"id": "c02", "имя": "отец", "внешность": "взрослый мужчина"}\n'
    "  ]\n"
    "}"
)


def _graph(nodes: tuple[tuple[str, str, str], ...] = _NODES) -> dict[str, Any]:
    return {
        "canvas_graph": {
            "nodes": [
                {"id": node_id, "type": node_type, "data": {"label": label}}
                for node_id, node_type, label in nodes
            ]
        }
    }


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _table_of(result: dict[str, Any], table_id: str | None = None) -> dict[str, Any]:
    tables = result["tables"]
    if table_id is None:
        assert len(tables) == 1
        return tables[0]
    match = [table for table in tables if table["id"] == table_id]
    assert len(match) == 1, [table["id"] for table in tables]
    return match[0]


def _column_keys(table: dict[str, Any]) -> list[str]:
    return [column["key"] for column in table["columns"]]


def _column_types(table: dict[str, Any]) -> dict[str, str]:
    return {column["key"]: column["type"] for column in table["columns"]}


def _params(result: dict[str, Any]) -> dict[str, str]:
    return {param["key"]: param["value"] for param in result["params"]}


# ---------------------------------------------------------------------------
# Нормализатор: JSON (спека 3.1–3.3)
# ---------------------------------------------------------------------------


def test_root_array_of_objects_is_one_table() -> None:
    result = node_tables.normalize_document(
        _json([{"id": 1, "name": "кадр", "ok": True}, {"id": 2, "name": "кадр 2", "ok": False}])
    )
    assert result["kind"] == "json"
    table = _table_of(result)
    assert table["id"] == "items"
    assert _column_keys(table) == ["id", "name", "ok"]
    assert _column_types(table) == {"id": "number", "name": "text", "ok": "bool"}
    assert table["rows"] == [
        {"id": 1, "name": "кадр", "ok": True},
        {"id": 2, "name": "кадр 2", "ok": False},
    ]
    assert table["total"] == 2
    assert table["truncated"] is False
    assert result["params"] == []


def test_root_object_arrays_to_tables_scalars_to_params() -> None:
    result = node_tables.normalize_document(
        _json(
            {
                "сцены": [{"номер": 1}, {"номер": 2}],
                "итог": "готово",
                "пусто": [],
                "теги": ["a", "b"],
                "counts": {"rows": 2, "fail": False},
            }
        ),
        name="style_report",
    )
    table = _table_of(result, "сцены")
    assert table["rows"] == [{"номер": 1}, {"номер": 2}]
    params = _params(result)
    assert params["итог"] == "готово"
    assert params["пусто"] == ""
    assert params["теги"] == "a; b"
    assert params["counts.rows"] == "2"
    assert params["counts.fail"] == "false"


def test_nested_array_of_objects_expanded_into_rows_and_columns() -> None:
    document = {
        "ops": [
            {"frame_uuid": "u1", "qc": {"verdict": "pass"}, "fields": {"кадры": [{"id": "S1-K1", "место": "комната"}]}},
            {"frame_uuid": "u2", "qc": {"verdict": "fail"}, "fields": {"кадры": [{"id": "S1-K2", "место": "двор"}]}},
        ]
    }
    table = _table_of(node_tables.normalize_document(_json(document)))
    # Вложенный массив кадров разворачивается: каждая переменная — своя колонка.
    assert _column_keys(table) == [
        "frame_uuid",
        "fields.кадры.id",
        "qc.verdict",
        "fields.кадры.место",
    ]
    assert _column_types(table) == {
        "frame_uuid": "text",
        "fields.кадры.id": "text",
        "fields.кадры.место": "text",
        "qc.verdict": "text",
    }
    assert len(table["rows"]) == 2
    assert [row["fields.кадры.id"] for row in table["rows"]] == ["S1-K1", "S1-K2"]
    assert table["rows"][0]["frame_uuid"] == "u1"
    assert table["rows"][1]["qc.verdict"] == "fail"


def test_null_becomes_empty_string_and_mixed_column_becomes_text() -> None:
    document = {"строки": [{"id": 1, "parent": None, "смесь": 5}, {"id": 2, "parent": "x", "смесь": "y"}]}
    table = _table_of(node_tables.normalize_document(_json(document)))
    assert _column_types(table) == {"id": "number", "parent": "text", "смесь": "text"}
    assert table["rows"][0]["parent"] == ""
    assert [row["смесь"] for row in table["rows"]] == ["5", "y"]


def test_merge_satellites_by_common_key() -> None:
    document = {
        "старт": [{"frame_uuid": "u1", "кадр": "S1"}, {"frame_uuid": "u2", "кадр": "S2"}],
        "финал": [{"frame_uuid": "u2", "статус": "ok"}, {"frame_uuid": "u1", "статус": "fail"}],
    }
    table = _table_of(node_tables.normalize_document(_json(document)))
    assert _column_keys(table) == ["frame_uuid", "кадр", "финал.статус"]
    assert [row["финал.статус"] for row in table["rows"]] == ["fail", "ok"]
    assert "склейка по ключу frame_uuid" in table["title"]


def test_merge_satellites_by_index_when_no_common_key() -> None:
    """ops и закадр_план про кадры и одной длины — строки склеиваются по порядку."""
    document = {
        "ops": [{"frame_uuid": "u1"}, {"frame_uuid": "u2"}],
        "закадр_план": [{"номер": 1, "закадр": "раз"}, {"номер": 2, "закадр": "два"}],
    }
    result = node_tables.normalize_document(_json(document))
    table = _table_of(result)
    assert table["id"] == "ops"
    assert table["title"] == "ops + закадр_план (склейка по индексу, 2 из 2)"
    assert _column_keys(table) == ["frame_uuid", "закадр_план.номер", "закадр_план.закадр"]
    assert table["rows"][1] == {
        "frame_uuid": "u2",
        "закадр_план.номер": 2,
        "закадр_план.закадр": "два",
    }
    assert result["warnings"] == []


def test_arrays_of_different_length_are_not_merged() -> None:
    document = {
        "пункты": [{"код": "P1"}, {"код": "P2"}, {"код": "P3"}],
        "сцены": [{"номер": 1}, {"номер": 2}],
    }
    result = node_tables.normalize_document(_json(document))
    assert sorted(_column_keys(_table_of(result, "пункты"))) == ["код"]
    assert len(_table_of(result, "пункты")["rows"]) == 3
    assert len(_table_of(result, "сцены")["rows"]) == 2


# ---------------------------------------------------------------------------
# Нормализатор: проза, JSON-фрагмент, лимиты (спека 3.4–3.6)
# ---------------------------------------------------------------------------


def test_prose_splits_into_blocks_by_headings() -> None:
    result = node_tables.normalize_document(_PLAN_TEXT)
    assert result["kind"] == "text"
    table = _table_of(result, "blocks")
    assert _column_keys(table) == ["заголовок", "текст", "тип"]
    assert _column_types(table) == {"заголовок": "text", "текст": "long_text", "тип": "text"}
    assert [(row["заголовок"], row["тип"]) for row in table["rows"]] == [
        ("", "вступление"),
        ("Глава I", "раздел"),
        ("Глава II", "раздел"),
    ]
    assert table["rows"][1]["текст"] == "Первый абзац.\nВторая строка."
    assert _params(result)["исходный_текст"] == _PLAN_TEXT


def test_consecutive_headings_give_empty_text_blocks() -> None:
    text = "Картинка для привлечения внимания\n\n\"Cыны Империума\"\n\nПролог\n\nТекст пролога."
    table = _table_of(node_tables.normalize_document(text), "blocks")
    assert [(row["заголовок"], row["текст"]) for row in table["rows"]] == [
        ("Картинка для привлечения внимания", ""),
        ('"Cыны Империума"', ""),
        ("Пролог", "Текст пролога."),
    ]


def test_json_fragment_after_prose_is_parsed() -> None:
    """cast: 196 символов прозы + реестр персонажей; json.loads всего текста падает."""
    result = node_tables.normalize_document(_CAST_TEXT)
    assert result["kind"] == "json"
    table = _table_of(result, "персонажи")
    assert _column_keys(table) == ["id", "имя", "внешность"]
    assert [row["id"] for row in table["rows"]] == ["c01", "c02"]
    assert _params(result)["преамбула"].startswith("Собираю реестр персонажей")
    assert result["warnings"] == [
        "json.loads упал на прозе; разобран JSON-фрагмент с символа 72"
    ] or any("JSON-фрагмент с символа" in warning for warning in result["warnings"])


def test_prose_without_json_fragment_stays_blocks() -> None:
    text = "Обычная проза без структуры.\n\nИ ещё один абзац."
    result = node_tables.normalize_document(text)
    assert result["kind"] == "text"
    assert result["tables"][0]["id"] == "blocks"
    assert len(result["tables"][0]["rows"]) == 2
    assert [row["текст"] for row in result["tables"][0]["rows"]] == [
        "Обычная проза без структуры.",
        "И ещё один абзац.",
    ]
    assert [row["тип"] for row in result["tables"][0]["rows"]] == ["вступление", "раздел"]
    assert result["warnings"] == []


def test_narration_script_without_headings_splits_into_paragraph_rows() -> None:
    """Закадровый текст без заголовков разбивается на строки таблицы по абзацам."""
    script = (
        "В 1975 году инженер Kodak Стивен Сассон собрал один из первых прототипов цифровой камеры.\n"
        "Изображение сохранялось электронно, без плёнки.\n\n"
        "Покупка фотоаппарата была началом долгих отношений с плёнкой.\n"
        "Для отпуска или праздника требовался новый рулон.\n\n"
        "Цифровая камера постепенно убирала эти обязательные покупки."
    )
    result = node_tables.normalize_document(script)
    assert result["kind"] == "text"
    table = _table_of(result, "blocks")
    assert len(table["rows"]) == 3
    assert table["rows"][0]["тип"] == "вступление"
    assert table["rows"][0]["заголовок"] == ""
    assert "Стивен Сассон" in table["rows"][0]["текст"]
    assert table["rows"][1]["тип"] == "раздел"
    assert "Покупка фотоаппарата" in table["rows"][1]["текст"]
    assert table["rows"][2]["тип"] == "раздел"
    assert "Цифровая камера" in table["rows"][2]["текст"]


def test_jsonl_document_is_rows() -> None:
    result = node_tables.normalize_document('{"id": 1, "ok": true}\n{"id": 2, "ok": false}\n')
    assert result["kind"] == "json"
    table = _table_of(result)
    assert table["rows"] == [{"id": 1, "ok": True}, {"id": 2, "ok": False}]


def test_long_text_trimmed_and_nested_frames_expanded() -> None:
    long_text = "я" * 2500
    frames = [{"id": f"S1-K{index}", "описание": "ш" * 200} for index in range(10)]
    text = _json({"строки": [{"текст": long_text, "кадры": frames}]})

    trimmed = node_tables.normalize_document(text)
    table = _table_of(trimmed)
    # Массив кадров раскрыт строками и колонками, json-ячейки больше нет.
    assert _column_types(table) == {
        "текст": "long_text",
        "кадры.id": "text",
        "кадры.описание": "text",
    }
    assert len(table["rows"]) == 10
    assert [row["кадры.id"] for row in table["rows"]] == [f"S1-K{index}" for index in range(10)]
    # Каждая строка несёт длинный текст, обрезанный до лимита.
    assert len(table["rows"][0]["текст"]) == 2000
    assert table["rows"][0]["текст"].endswith("…")
    assert any("long_text обрезан до 2000" in warning for warning in trimmed["warnings"])

    full = node_tables.normalize_document(text, full=True)
    assert _table_of(full)["rows"][0]["текст"] == long_text


def test_row_limit_truncates_and_warns() -> None:
    rows = [{"id": index} for index in range(5001)]
    result = node_tables.normalize_document(_json(rows))
    table = _table_of(result)
    assert table["total"] == 5001
    assert len(table["rows"]) == 5000
    assert table["truncated"] is True
    assert any("показано 5000 из 5001" in warning for warning in result["warnings"])


def test_empty_document_has_no_tables() -> None:
    result = node_tables.normalize_document("   \n")
    assert result["tables"] == []
    assert result["params"] == []
    assert result["warnings"] == ["документ пуст"]


# ---------------------------------------------------------------------------
# API /table
# ---------------------------------------------------------------------------


@pytest.fixture()
def studio(tmp_path: Path) -> Any:
    """Проект во временной БД + клиент роутера + папки документов нод."""
    db_path = tmp_path / "tables.db"
    sync_engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(sync_engine)
    with SyncSession(sync_engine) as session:
        project = Project(
            slug="tables-test",
            topic="тема",
            meta=_graph(),
            general_plan=_PLAN_TEXT,
        )
        session.add(project)
        session.commit()
        project_id = int(project.id)
    sync_engine.dispose()

    async_engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}", poolclass=NullPool)
    factory = async_sessionmaker(async_engine, expire_on_commit=False)

    async def _session() -> Any:
        async with factory() as session:
            yield session

    app = FastAPI()
    app.include_router(node_llm.router, prefix="/api")
    app.dependency_overrides[get_session] = _session

    data_dir = Path(settings.data_dir) / "videos" / "tables-test"

    def upload(node_key: str) -> Path:
        path = data_dir / "excel_gpt_uploads" / node_key
        path.mkdir(parents=True, exist_ok=True)
        return path

    with TestClient(app) as client:
        yield SimpleNamespace(
            client=client,
            project_id=project_id,
            data_dir=data_dir,
            upload=upload,
        )


def _write(upload_dir: Path, name: str, payload: Any) -> None:
    (upload_dir / name).write_text(
        payload if isinstance(payload, str) else _json(payload),
        encoding="utf-8",
    )


def test_api_shots_merges_frame_table(studio: Any) -> None:
    shots = {
        "ops": [
            {"frame_uuid": "u1", "fields": {"кадры": [{"id": "S1-K1"}]}},
            {"frame_uuid": "u2", "fields": {"кадры": [{"id": "S1-K2"}]}},
        ],
        "закадр_план": [{"номер": 1, "закадр": "раз"}, {"номер": 2, "закадр": "два"}],
        "секунд": 10,
    }
    _write(studio.upload("n_excel_gpt_pk_shots"), "shots.json", shots)

    response = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_shots/table"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["nodeKey"] == "n_excel_gpt_pk_shots"
    assert data["nodeType"] == "excel_gpt"
    assert data["label"] == "Шоты"
    assert [source["id"] for source in data["sources"]] == ["file:shots.json"]
    assert data["sources"][0]["kind"] == "json"
    assert data["sources"][0]["rows"] == 2
    assert data["sources"][0]["tables"] == 1
    table = data["tables"][0]
    assert table["id"] == "ops"
    assert [row["закадр_план.закадр"] for row in table["rows"]] == ["раз", "два"]
    assert table["columns"][0]["key"] == "frame_uuid"
    assert any(param["key"] == "секунд" and param["value"] == "10" for param in data["params"])
    assert data["warnings"] == []


def test_api_multisource_prefixes_table_ids(studio: Any) -> None:
    upload = studio.upload("n_excel_gpt_pk_shots")
    _write(
        upload,
        "shots.json",
        {
            "ops": [
                {"frame_uuid": f"u{index}", "fields": {"кадры": [{"id": f"S{index}"}]}}
                for index in range(3)
            ]
        },
    )
    _write(upload, "gpt_reply.txt", {"ops": [{"frame_uuid": "x1"}]})

    response = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_shots/table"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["sources"]) == 2
    # основной — самый крупный JSON-документ
    assert data["sources"][0]["id"] == "file:shots.json"
    assert [table["id"] for table in data["tables"]] == ["shots.ops", "gpt_reply.ops"]
    assert len(data["tables"][0]["rows"]) == 3
    # одинаковые таблицы не путаются: у каждой свой префикс источника
    assert {table["id"].split(".", 1)[0] for table in data["tables"]} == {"shots", "gpt_reply"}


def test_api_doc_param_limits_to_one_source(studio: Any) -> None:
    upload = studio.upload("n_excel_gpt_pk_shots")
    _write(upload, "shots.json", {"ops": [{"frame_uuid": "u1"}, {"frame_uuid": "u2"}]})
    _write(upload, "gpt_reply.txt", {"ops": [{"frame_uuid": "raw"}]})

    response = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_shots/table",
        params={"doc": "file:gpt_reply.txt"},
    )
    assert response.status_code == 200
    data = response.json()
    assert [source["id"] for source in data["sources"]] == ["file:gpt_reply.txt"]
    assert [table["id"] for table in data["tables"]] == ["ops"]
    assert data["tables"][0]["rows"] == [{"frame_uuid": "raw"}]


def test_api_full_param_returns_full_long_text(studio: Any) -> None:
    long_text = "ф" * 2500
    _write(studio.upload("n_excel_gpt_pk_qc"), "qc_report.json", {"сцены": [{"итог": long_text}]})
    base = f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_qc/table"

    trimmed = studio.client.get(base).json()["tables"][0]["rows"][0]["итог"]
    full = studio.client.get(base, params={"full": 1}).json()["tables"][0]["rows"][0]["итог"]
    assert len(trimmed) == 2000
    assert full == long_text


def test_api_unknown_project_node_or_doc_is_404(studio: Any) -> None:
    base = f"/api/projects/{studio.project_id}/node-llm"
    assert studio.client.get("/api/projects/9999/node-llm/n_plan/table").status_code == 404
    # ноды с таким ключом нет в canvas_graph
    assert studio.client.get(f"{base}/n_no_such_node/table").status_code == 404
    _write(studio.upload("n_excel_gpt_pk_qc"), "qc_report.json", {"сцены": []})
    assert studio.client.get(f"{base}/n_excel_gpt_pk_qc/table?doc=file:nope.json").status_code == 404


def test_api_node_without_documents_is_200(studio: Any) -> None:
    """n_images есть в графе, но документов ответа нет — 200 + warning, не 404."""
    response = studio.client.get(f"/api/projects/{studio.project_id}/node-llm/n_images/table")
    assert response.status_code == 200
    data = response.json()
    assert data["sources"] == []
    assert data["tables"] == []
    assert data["params"] == []
    assert data["warnings"] == ["нет документов ответа ЛЛМ для ноды n_images"]


def test_api_empty_document_is_200(studio: Any) -> None:
    _write(studio.upload("n_excel_gpt_pk_cast"), "gpt_reply.txt", "")
    response = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_cast/table"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["tables"] == []
    assert data["sources"][0]["kind"] == "text"
    assert data["warnings"] == ["документ пуст: gpt_reply.txt"]


def test_api_unreadable_document_is_400(studio: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(studio.upload("n_excel_gpt_pk_qc"), "qc_report.json", {"сцены": []})

    def _boom(project: Any, node_key: str, doc_id: str) -> dict[str, Any]:
        raise HTTPException(status_code=500, detail="не прочитать qc_report.json")

    monkeypatch.setattr(node_llm, "read_node_llm_document", _boom)
    response = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_qc/table"
    )
    assert response.status_code == 400
    assert "не читается" in response.json()["detail"]


def test_api_plan_prose_blocks(studio: Any) -> None:
    response = studio.client.get(f"/api/projects/{studio.project_id}/node-llm/n_plan/table")
    assert response.status_code == 200
    data = response.json()
    assert data["nodeType"] == "plan"
    assert data["label"] == "Сценарий"
    assert [source["id"] for source in data["sources"]] == ["project:general_plan"]
    table = data["tables"][0]
    assert table["id"] == "blocks"
    assert [row["заголовок"] for row in table["rows"]] == ["", "Глава I", "Глава II"]
    assert data["params"][0]["key"] == "исходный_текст"


def test_api_cast_json_fragment(studio: Any) -> None:
    _write(studio.upload("n_excel_gpt_pk_cast"), "gpt_reply.txt", _CAST_TEXT)
    response = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_excel_gpt_pk_cast/table"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["sources"][0]["kind"] == "json"
    table = data["tables"][0]
    assert table["id"] == "персонажи"
    assert [row["id"] for row in table["rows"]] == ["c01", "c02"]
    assert any(column["key"] == "внешность" for column in table["columns"])
    assert data["params"][0]["key"] == "преамбула"
    assert any("JSON-фрагмент" in warning for warning in data["warnings"])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _load_cli() -> Any:
    """CLI лежит в scripts/ (не пакет рядом с tests) — грузим по пути файла."""
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "scripts" / "node_results_tables.py"
    spec = importlib.util.spec_from_file_location("node_results_tables", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _api_payload(
    *,
    tables: list[dict[str, Any]] | None = None,
    params: list[dict[str, Any]] | None = None,
    sources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Ответ ручки /table в том виде, в котором его получает UI."""
    return {
        "nodeKey": "n_excel_gpt_pk_shots",
        "nodeType": "excel_gpt",
        "label": "Шоты",
        "sources": sources
        if sources is not None
        else [
            {"id": "file:shots.json", "name": "shots.json", "size": 120, "kind": "json", "rows": 2, "tables": 1},
            {"id": "file:gpt_reply.txt", "name": "gpt_reply.txt", "size": 20, "kind": "json", "rows": 1, "tables": 1},
        ],
        "tables": tables
        if tables is not None
        else [
            {
                "id": "ops",
                "title": "ops + закадр_план (склейка по индексу, 2 из 2)",
                "columns": [
                    {"key": "frame_uuid", "label": "frame_uuid", "type": "text"},
                    {"key": "закадр_план.номер", "label": "закадр_план.номер", "type": "number"},
                    {"key": "закадр_план.закадр", "label": "закадр_план.закадр", "type": "long_text"},
                ],
                "rows": [
                    {"frame_uuid": "u1", "закадр_план.номер": 1, "закадр_план.закадр": "раз"},
                    {"frame_uuid": "u2", "закадр_план.номер": 2, "закадр_план.закадр": "два"},
                ],
                "total": 2,
                "truncated": False,
            },
            {
                "id": "gpt_reply.ops",
                "title": "gpt_reply.txt · ops",
                "columns": [{"key": "frame_uuid", "label": "frame_uuid", "type": "text"}],
                "rows": [{"frame_uuid": "raw"}],
                "total": 1,
                "truncated": False,
            },
        ],
        "params": params if params is not None else [{"key": "секунд", "label": "секунд", "value": "10"}],
        "warnings": [],
    }


def _fake_http(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any],
    document: Any = None,
) -> Any:
    """HTTP-заглушка студии: /table отдаёт готовый ответ, /documents — фолбэк."""
    cli = _load_cli()
    fallback_document = document if document is not None else {"ops": [{"frame_uuid": "u1"}]}

    def _get_json(url: str, token: str | None = None) -> Any:
        if "/table" in url:
            return payload
        if url.endswith("/api/projects/2"):
            return {"id": 2, "meta": _graph()}
        if url.endswith("/documents"):
            return {
                "documents": [
                    {"id": "file:shots.json", "name": "shots.json", "size": 120, "isJson": True}
                ]
            }
        if "/documents/" in url:
            return {
                "text": fallback_document
                if isinstance(fallback_document, str)
                else _json(fallback_document)
            }
        raise AssertionError(f"неожиданный URL: {url}")

    monkeypatch.setattr(cli, "_get_json", _get_json)
    return cli


def _main_args(out: Path, *extra: str) -> list[str]:
    return ["--base-url", "http://studio.local", "--project", "2", "--out", str(out), *extra]


def test_cli_uses_table_endpoint_and_exports_csv(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """CLI берёт /table целиком: все источники ноды, как в UI, а не один документ."""
    cli = _fake_http(monkeypatch, _api_payload())
    out = tmp_path / "out"
    code = cli.main(_main_args(out, "--all", "--format", "csv"))
    assert code == 0

    files = sorted(out.glob("*.csv"))
    # --all берёт только ЛЛМ-ноды из canvas_graph; файл на КАЖДУЮ таблицу
    assert len(files) == 10
    assert {path.name.split("__")[0] for path in files} == {
        "n_plan",
        "n_excel_gpt_pk_shots",
        "n_excel_gpt_pk_qc",
        "n_excel_gpt_pk_cast",
        "n_excel_gpt_pk_report",
    }
    shots_files = {path.name for path in files if path.name.startswith("n_excel_gpt_pk_shots")}
    assert shots_files == {"n_excel_gpt_pk_shots__ops.csv", "n_excel_gpt_pk_shots__gpt_reply.ops.csv"}
    content = (out / "n_excel_gpt_pk_shots__ops.csv").read_text(encoding="utf-8-sig")
    assert "frame_uuid;закадр_план.номер;закадр_план.закадр" in content
    assert "раз" in content


def test_cli_exports_xlsx_sheets(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    payload = _api_payload(
        tables=[
            {
                "id": "ops",
                "title": "ops",
                "columns": [
                    {"key": "frame_uuid", "label": "frame_uuid", "type": "text"},
                    {"key": "fields.кадры", "label": "fields.кадры", "type": "json"},
                ],
                "rows": [{"frame_uuid": "u1", "fields.кадры": '[{"id":"S1-K1"}]'}],
                "total": 1,
                "truncated": False,
            }
        ],
        sources=[{"id": "file:shots.json", "name": "shots.json", "size": 120, "kind": "json", "rows": 1, "tables": 1}],
    )
    cli = _fake_http(monkeypatch, payload)
    out = tmp_path / "xlsx"
    code = cli.main(_main_args(out, "--node", "n_excel_gpt_pk_shots", "--format", "xlsx"))
    assert code == 0
    (path,) = list(out.glob("*.xlsx"))
    assert path.stat().st_size > 0

    from openpyxl import load_workbook

    workbook = load_workbook(path)
    assert workbook.sheetnames == ["ops", "Параметры"]
    sheet = workbook["ops"]
    assert [cell.value for cell in sheet[1]] == ["frame_uuid", "fields.кадры"]
    assert json.loads(sheet.cell(row=2, column=2).value) == [{"id": "S1-K1"}]


def test_cli_falls_back_to_documents_when_table_route_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Старый сервер без /table: CLI сам читает документ и нормализует локально."""
    import urllib.error

    cli = _fake_http(
        monkeypatch,
        _api_payload(),
        document={"ops": [{"frame_uuid": "u1"}], "закадр_план": [{"номер": 1, "закадр": "раз"}]},
    )
    original = cli._get_json

    def _get_json(url: str, token: str | None = None) -> Any:
        if "/table" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)  # type: ignore[arg-type]
        return original(url, token)

    monkeypatch.setattr(cli, "_get_json", _get_json)
    out = tmp_path / "fallback"
    code = cli.main(_main_args(out, "--node", "n_excel_gpt_pk_shots", "--format", "json"))
    assert code == 0
    (path,) = list(out.glob("*.json"))
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["kind"] == "json"
    table = data["tables"][0]
    assert table["id"] == "ops"
    assert len(table["rows"]) == 1
