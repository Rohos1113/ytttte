"""Скачивание и загрузка таблиц ответа ЛЛМ-ноды (xlsx/json/csv).

Контракт:

* ``GET .../table/xlsx`` — файл с листом на каждую таблицу, шапка как в UI,
  значения полные (без обрезки long_text до 2000);
* ``POST .../table/upload`` — правки из файла возвращаются в исходный
  JSON-документ: только значения, структура сохраняется, прежняя версия файла
  уходит в ``.bak``; неизвестные колонки — 400, неизвестные строки — warning.

Модуль под тестом: ``app/web/table_import.py`` + ручки в
``app/web/routers/node_llm.py``.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session as SyncSession
from sqlalchemy.pool import NullPool

from app.models import Base, Project
from app.settings import settings
from app.web import table_import
from app.web.deps import get_session
from app.web.routers import node_llm

_NODES: tuple[tuple[str, str, str], ...] = (
    ("n_plan", "plan", "Сценарий"),
    ("n_excel_gpt_pk_shots", "excel_gpt", "Шоты"),
    ("n_excel_gpt_pk_qc", "excel_gpt", "QC"),
    ("n_excel_gpt_pk_cast", "excel_gpt", "Персонажи"),
)
_PLAN_TEXT = "Вступление без заголовка.\n\nГлава I\n\nПервый абзац.\nВторая строка.\n\nГлава II\n\nЕщё абзац."


def _graph() -> dict[str, Any]:
    return {
        "canvas_graph": {
            "nodes": [
                {"id": node_id, "type": node_type, "data": {"label": label}}
                for node_id, node_type, label in _NODES
            ]
        }
    }


@pytest.fixture()
def studio(tmp_path: Path) -> Any:
    """Проект во временной БД + клиент роутера + папки документов нод."""
    db_path = tmp_path / "upload.db"
    sync_engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(sync_engine)
    with SyncSession(sync_engine) as session:
        project = Project(
            slug="upload-test",
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

    data_dir = Path(settings.data_dir) / "videos" / "upload-test"

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
        payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )


def _shots_doc() -> dict[str, Any]:
    return {
        "ops": [
            {
                "frame_uuid": "u1",
                "порядок": 1,
                "важно": True,
                "fields": {"кадры": [{"id": "S1-K1", "место": "кухня"}, {"id": "S1-K2"}]},
            },
            {"frame_uuid": "u2", "порядок": 2, "важно": False, "fields": {"кадры": [{"id": "S2-K1"}]}},
        ],
        "закадр_план": [{"номер": 1, "закадр": "раз"}, {"номер": 2, "закадр": "два"}],
        "секунд": 10,
    }


def _table_url(studio: Any, node_key: str, suffix: str = "") -> str:
    return f"/api/projects/{studio.project_id}/node-llm/{node_key}/table{suffix}"


def _load_xlsx(data: bytes) -> Any:
    from openpyxl import load_workbook

    return load_workbook(io.BytesIO(data))


def _save_xlsx(workbook: Any) -> bytes:
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _header_column(sheet: Any, header: str) -> int:
    for cell in sheet[1]:
        if cell.value == header:
            return int(cell.column)
    raise AssertionError(f"нет колонки {header!r}: {[cell.value for cell in sheet[1]]}")


def _column_header(table: dict[str, Any], column_key: str) -> str:
    for column in table["columns"]:
        if column["key"] == column_key:
            return table_import.humanize_column_label(column.get("label"), column["key"])
    raise AssertionError(f"нет колонки {column_key!r}")


def _download(studio: Any, node_key: str, query: str = "") -> bytes:
    response = studio.client.get(_table_url(studio, node_key, "/xlsx") + query)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    return response.content


def _table(studio: Any, node_key: str, query: str = "") -> dict[str, Any]:
    response = studio.client.get(_table_url(studio, node_key) + query)
    assert response.status_code == 200, response.text
    return response.json()


def _upload(studio: Any, node_key: str, filename: str, data: bytes, query: str = "") -> Any:
    return studio.client.post(
        _table_url(studio, node_key, "/upload") + query,
        files={
            "file": (
                filename,
                data,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )


def _read_json(upload_dir: Path, name: str) -> Any:
    return json.loads((upload_dir / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Скачивание xlsx
# ---------------------------------------------------------------------------


def test_xlsx_has_sheet_per_table_and_ui_headers(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())

    workbook = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    assert workbook.sheetnames == ["ops"]
    headers = [cell.value for cell in workbook["ops"][1]]
    assert set(headers) == {
        "Frame uuid",
        "Порядок",
        "Важно",
        "Закадр план · номер",
        "Fields · кадры · id",
        "Закадр план · закадр",
        "Fields · кадры · место",
    }
    rows = list(workbook["ops"].iter_rows(min_row=2, values_only=True))

    def _col(name: str) -> int:
        return headers.index(name)

    assert [row[_col("Frame uuid")] for row in rows] == ["u1", "u1", "u2"]
    assert rows[0][_col("Важно")] is True  # bool остаётся bool, а не строкой
    assert rows[0][_col("Порядок")] == 1  # число остаётся числом
    assert rows[0][_col("Fields · кадры · id")] == "S1-K1"
    assert rows[1][_col("Fields · кадры · место")] in (None, "")  # поля нет — пустая ячейка


def test_xlsx_keeps_full_long_text(studio: Any) -> None:
    long_text = "Очень длинное описание кадра. " * 300
    doc = {"ops": [{"frame_uuid": "u1", "fields": {"кадры": [{"id": "S1-K1", "описание": long_text}]}}]}
    _write(studio.upload("n_excel_gpt_pk_shots"), "shots.json", doc)

    table = _table(studio, "n_excel_gpt_pk_shots")["tables"][0]
    assert table["rows"][0]["fields.кадры.описание"].endswith("…")

    workbook = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    header = _column_header(table, "fields.кадры.описание")
    cell = workbook["ops"].cell(row=2, column=_header_column(workbook["ops"], header))
    assert cell.value == long_text


def test_xlsx_unknown_node_404(studio: Any) -> None:
    response = studio.client.get(_table_url(studio, "n_no_such_node", "/xlsx"))
    assert response.status_code == 404


def test_xlsx_doc_filter(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    _write(upload_dir, "gpt_reply.txt", json.dumps(_shots_doc(), ensure_ascii=False))
    response = studio.client.get(_table_url(studio, "n_excel_gpt_pk_shots", "/xlsx") + "?doc=file:shots.json")
    assert response.status_code == 200
    workbook = _load_xlsx(response.content)
    assert workbook.sheetnames == ["ops"]
    bad = studio.client.get(_table_url(studio, "n_excel_gpt_pk_shots", "/xlsx") + "?doc=file:nope.json")
    assert bad.status_code == 404


# ---------------------------------------------------------------------------
# Круговой рейс xlsx: скачали, поправили две ячейки, загрузили
# ---------------------------------------------------------------------------


def test_xlsx_roundtrip_updates_cells_and_keeps_structure(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    table = _table(studio, "n_excel_gpt_pk_shots")["tables"][0]

    workbook = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    sheet = workbook["ops"]
    place = _header_column(sheet, _column_header(table, "fields.кадры.место"))
    zakadr = _header_column(sheet, _column_header(table, "закадр_план.закадр"))
    sheet.cell(row=2, column=place, value="кухня-правка")
    sheet.cell(row=3, column=zakadr, value="раз-правка")

    response = _upload(studio, "n_excel_gpt_pk_shots", "download.xlsx", _save_xlsx(workbook))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["updatedRows"] == 2
    assert data["updatedCells"] == 2
    assert data["warnings"] == []
    assert data["document"] == "file:shots.json"

    root = _read_json(upload_dir, "shots.json")
    # значения поменялись ровно там, где правили
    assert root["ops"][0]["fields"]["кадры"][0]["место"] == "кухня-правка"
    assert root["закадр_план"][0]["закадр"] == "раз-правка"
    assert root["закадр_план"][1]["закадр"] == "два"
    # структура документа не переписана: те же ключи, массивы, параметры
    assert set(root) == {"ops", "закадр_план", "секунд"}
    assert root["секунд"] == 10
    assert [set(op) for op in root["ops"]] == [
        {"frame_uuid", "порядок", "важно", "fields"},
        {"frame_uuid", "порядок", "важно", "fields"},
    ]
    assert len(root["ops"][0]["fields"]["кадры"]) == 2
    assert root["ops"][0]["fields"]["кадры"][1] == {"id": "S1-K2"}
    # прежняя версия файла сохранена
    assert list(upload_dir.glob("shots.json.bak_llmjson_*")), "должен появиться .bak"

    fresh = _table(studio, "n_excel_gpt_pk_shots")["tables"][0]
    assert fresh["rows"][0]["fields.кадры.место"] == "кухня-правка"
    assert fresh["rows"][1]["закадр_план.закадр"] == "раз-правка"

    # повторное скачивание и загрузка без правок — ноль изменений
    again = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    repeat = _upload(studio, "n_excel_gpt_pk_shots", "again.xlsx", _save_xlsx(again))
    assert repeat.status_code == 200, repeat.text
    assert repeat.json()["updatedCells"] == 0
    assert repeat.json()["updatedRows"] == 0


def test_upload_preserves_number_and_bool_types(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    table = _table(studio, "n_excel_gpt_pk_shots")["tables"][0]
    workbook = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    sheet = workbook["ops"]
    sheet.cell(row=2, column=_header_column(sheet, _column_header(table, "порядок")), value=7)
    sheet.cell(row=2, column=_header_column(sheet, _column_header(table, "важно")), value=False)

    response = _upload(studio, "n_excel_gpt_pk_shots", "types.xlsx", _save_xlsx(workbook))
    assert response.status_code == 200, response.text
    assert response.json()["updatedCells"] == 2

    root = _read_json(upload_dir, "shots.json")
    assert root["ops"][0]["порядок"] == 7
    assert isinstance(root["ops"][0]["порядок"], int)
    assert root["ops"][0]["важно"] is False


def test_xlsx_roundtrip_keeps_null_cells(studio: Any) -> None:
    """null в JSON и пустая ячейка Excel — не правка (раньше давало ложные изменения)."""
    doc = {"ops": [{"frame_uuid": "u1", "fields": {"кадры": [{"id": "S1-K1", "parent_id": None}]}}]}
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", doc)
    workbook = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    response = _upload(studio, "n_excel_gpt_pk_shots", "same.xlsx", _save_xlsx(workbook))
    assert response.status_code == 200, response.text
    assert response.json()["updatedCells"] == 0
    assert _read_json(upload_dir, "shots.json") == doc


def test_xlsx_multiple_tables_sheet_per_table(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(
        upload_dir,
        "shots.json",
        {
            "shots": [{"frame_uuid": "u1", "кадр": "S1-K1", "описание": "исходно"}],
            "notes": [{"id": "n1", "текст": "заметка"}],
        },
    )
    workbook = _load_xlsx(_download(studio, "n_excel_gpt_pk_shots"))
    assert workbook.sheetnames == ["shots", "notes"]
    assert [cell.value for cell in workbook["notes"][1]] == ["Id", "Текст"]

    # Загрузка читает первый лист (контракт): правим основную таблицу.
    sheet = workbook["shots"]
    headers = [cell.value for cell in sheet[1]]
    sheet.cell(row=2, column=headers.index("Описание") + 1, value="правка")
    response = _upload(studio, "n_excel_gpt_pk_shots", "notes.xlsx", _save_xlsx(workbook))
    assert response.status_code == 200, response.text
    assert response.json()["document"] == "file:shots.json"
    root = _read_json(upload_dir, "shots.json")
    assert root["shots"][0]["описание"] == "правка"
    assert root["notes"][0]["текст"] == "заметка"  # другая таблица не тронута


# ---------------------------------------------------------------------------
# json и csv
# ---------------------------------------------------------------------------


def test_upload_json_rows_by_key(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    rows = [{"frame_uuid": "u2", "fields.кадры.место": "лес-json"}]
    response = _upload(
        studio,
        "n_excel_gpt_pk_shots",
        "rows.json",
        json.dumps(rows, ensure_ascii=False).encode("utf-8"),
    )
    assert response.status_code == 200, response.text
    assert response.json()["updatedCells"] == 1
    root = _read_json(upload_dir, "shots.json")
    assert root["ops"][1]["fields"]["кадры"][0]["место"] == "лес-json"
    # значение строки u1 не изменилось
    assert root["ops"][0]["fields"]["кадры"][0]["место"] == "кухня"


def test_upload_csv_semicolon(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    csv_bytes = "frame_uuid;fields.кадры.id;fields.кадры.место\nu2;S2-K1;лес-csv\n".encode()
    response = _upload(studio, "n_excel_gpt_pk_shots", "rows.csv", csv_bytes)
    assert response.status_code == 200, response.text
    assert response.json()["updatedCells"] == 1
    root = _read_json(upload_dir, "shots.json")
    assert root["ops"][1]["fields"]["кадры"][0]["место"] == "лес-csv"


def test_upload_csv_comma(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    csv_bytes = "frame_uuid,fields.кадры.место\nu2,лес-запятая\n".encode()
    response = _upload(studio, "n_excel_gpt_pk_shots", "rows.csv", csv_bytes)
    assert response.status_code == 200, response.text
    root = _read_json(upload_dir, "shots.json")
    assert root["ops"][1]["fields"]["кадры"][0]["место"] == "лес-запятая"


# ---------------------------------------------------------------------------
# Ошибки и предупреждения
# ---------------------------------------------------------------------------


def test_upload_unknown_header_is_400(studio: Any) -> None:
    from openpyxl import Workbook

    _write(studio.upload("n_excel_gpt_pk_shots"), "shots.json", _shots_doc())
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["Frame uuid", "Нет такой колонки"])
    sheet.append(["u1", "x"])
    response = _upload(studio, "n_excel_gpt_pk_shots", "bad.xlsx", _save_xlsx(workbook))
    assert response.status_code == 400, response.text
    assert response.json()["detail"].startswith("неизвестные колонки:")


def test_upload_unknown_row_warns(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    csv_bytes = "frame_uuid;fields.кадры.место\nu9;нет-строки\n"
    response = _upload(studio, "n_excel_gpt_pk_shots", "rows.csv", csv_bytes.encode())
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["updatedCells"] == 0
    assert any("u9 не найдена, пропущена" in warning for warning in data["warnings"])


def test_upload_broken_file_is_400(studio: Any) -> None:
    _write(studio.upload("n_excel_gpt_pk_shots"), "shots.json", _shots_doc())
    response = _upload(studio, "n_excel_gpt_pk_shots", "broken.xlsx", b"not a zip at all")
    assert response.status_code == 400, response.text
    assert "xlsx" in response.json()["detail"]

    broken_json = _upload(studio, "n_excel_gpt_pk_shots", "broken.json", b"{oops")
    assert broken_json.status_code == 400
    assert "JSON" in broken_json.json()["detail"]

    unknown = _upload(studio, "n_excel_gpt_pk_shots", "rows.xls", b"whatever")
    assert unknown.status_code == 400
    assert "поддерживаются" in unknown.json()["detail"]


def test_upload_prose_table_is_400(studio: Any) -> None:
    workbook = _load_xlsx(_download(studio, "n_plan"))
    response = _upload(studio, "n_plan", "plan.xlsx", _save_xlsx(workbook))
    assert response.status_code == 400, response.text
    assert "не привязана к JSON" in response.json()["detail"]


def test_upload_mismatched_key_does_not_touch_document(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "shots.json", _shots_doc())
    before = (upload_dir / "shots.json").read_text(encoding="utf-8")
    response = _upload(
        studio,
        "n_excel_gpt_pk_shots",
        "rows.json",
        json.dumps([{"frame_uuid": "nope", "fields.кадры.место": "x"}]).encode(),
    )
    assert response.status_code == 200, response.text
    assert response.json()["updatedCells"] == 0
    assert (upload_dir / "shots.json").read_text(encoding="utf-8") == before


# ---------------------------------------------------------------------------
# Вспомогательные функции модуля
# ---------------------------------------------------------------------------


def test_humanize_matches_ui_examples() -> None:
    assert table_import.humanize_column_label("frame_uuid", "frame_uuid") == "Frame uuid"
    assert table_import.humanize_column_label("", "fields.кадры.место") == ("Fields · кадры · место")
    # готовый человеческий label не переделываем
    assert table_import.humanize_column_label("Номер кадра", "frame_index") == "Номер кадра"


def test_sheet_title_is_excel_safe() -> None:
    used: set[str] = set()
    first = table_import.sheet_title("ops/кадры:1", used)
    second = table_import.sheet_title("ops/кадры:1", used)
    assert first == "ops_кадры_1"
    assert second != first
    assert len(table_import.sheet_title("x" * 60, set())) == 31


# ---------------------------------------------------------------------------
# Правка одной ячейки (POST /table/cell)
# ---------------------------------------------------------------------------


def test_cell_edit_writes_value_into_document(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "gpt_reply.txt", _shots_doc())
    table_response = studio.client.get(_table_url(studio, "n_excel_gpt_pk_shots")).json()
    table = next(item for item in table_response["tables"] if item["id"] == "ops")
    column = next(item for item in table["columns"] if item["key"] == "порядок")

    response = studio.client.post(
        _table_url(studio, "n_excel_gpt_pk_shots", "/cell"),
        json={"table": "ops", "row": 0, "column": column["key"], "value": 7},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["changed"] is True and payload["saved"] is True
    assert payload["value"] == 7

    saved = json.loads((upload_dir / "gpt_reply.txt").read_text(encoding="utf-8"))
    assert saved["ops"][0]["порядок"] == 7
    assert any(path.name.startswith("gpt_reply.txt.bak") for path in upload_dir.iterdir())


def test_cell_edit_unknown_column_is_400(studio: Any) -> None:
    upload_dir = studio.upload("n_excel_gpt_pk_shots")
    _write(upload_dir, "gpt_reply.txt", _shots_doc())
    response = studio.client.post(
        _table_url(studio, "n_excel_gpt_pk_shots", "/cell"),
        json={"table": "ops", "row": 0, "column": "нет-такой", "value": "x"},
    )
    assert response.status_code == 400, response.text


def test_cell_edit_prose_block_updates_project_text(studio: Any) -> None:
    table_response = studio.client.get(_table_url(studio, "n_plan")).json()
    table = next(item for item in table_response["tables"] if item["id"] == "blocks")
    assert [row["заголовок"] for row in table["rows"]][:2] == ["", "Глава I"]

    response = studio.client.post(
        _table_url(studio, "n_plan", "/cell"),
        json={"table": "blocks", "row": 1, "column": "текст", "value": "Новый абзац.\nВторая строка."},
    )
    assert response.status_code == 200, response.text
    assert response.json()["changed"] is True

    fresh = studio.client.get(_table_url(studio, "n_plan")).json()
    blocks = next(item for item in fresh["tables"] if item["id"] == "blocks")
    assert blocks["rows"][1]["текст"] == "Новый абзац.\nВторая строка."
    # проза живёт в поле проекта — проверяем сам документ
    docs = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_plan/documents"
    ).json()["documents"]
    doc_id = docs[0]["id"]
    text = studio.client.get(
        f"/api/projects/{studio.project_id}/node-llm/n_plan/documents/{doc_id}"
    ).json()["text"]
    assert "Новый абзац." in text


def test_cell_edit_prose_type_column_is_400(studio: Any) -> None:
    response = studio.client.post(
        _table_url(studio, "n_plan", "/cell"),
        json={"table": "blocks", "row": 1, "column": "тип", "value": "раздел"},
    )
    assert response.status_code == 400, response.text
