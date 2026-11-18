"""Тесты панели «Переменные проекта»: ``GET /api/projects/{id}/montage/variables``.

Ручка собирает всё, что произвели ноды проекта, и отдаёт одним ответом. Здесь
проверяется настоящий HTTP-круг (роут → сервис → БД → диск), в том числе на
пустом проекте: панель обязана открыться и на нём, показав «не готово», а не
упасть 500.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Artifact, ArtifactKind, Base, Frame, Project, ProjectStatus
from app.web.deps import get_session
from app.web.routers import project_ops

#: Граф маленького проекта: две рабочие ноды, слот «Работа с GPT» и HITL-гейт,
#: который в панель попадать не должен (он ничего не производит).
GRAPH = {
    "canvas_graph": {
        "nodes": [
            {"id": "n_topic", "type": "topic", "data": {"label": "Тема"}},
            {"id": "n_plan", "type": "plan", "data": {"label": "Сценарий"}},
            {"id": "n_split", "type": "split", "data": {"label": "Разбивка на кадры"}},
            {
                "id": "n_excel_gpt_pk_scenes",
                "type": "excel_gpt",
                "data": {"label": "Сцены по плану"},
            },
            {"id": "n_hitl_gate", "type": "hitl_gate", "data": {"label": "Проверка человеком"}},
        ],
        "edges": [
            {"id": "e1", "source": "n_topic", "target": "n_plan"},
            {"id": "e2", "source": "n_plan", "target": "n_split"},
            {"id": "e3", "source": "n_split", "target": "n_excel_gpt_pk_scenes"},
        ],
    }
}

LONG_PLAN = "План ролика. " * 40  # 520 символов — длиннее preview, короче лимита


def _app(factory: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = FastAPI()
    app.include_router(project_ops.router, prefix="/api")

    async def _session():  # noqa: ANN202 — генератор сессии
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = _session
    return app


async def _make_engine(tmp_path: Path):  # noqa: ANN202 — движок + фабрика
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'variables.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


@pytest.fixture
async def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    """Проект с данными: план, кадры, картинки, ответ GPT, снимок Excel."""
    data_root = tmp_path / "data"
    monkeypatch.setattr("app.settings.settings.data_dir", str(data_root))

    engine, factory = await _make_engine(tmp_path)
    project = Project(
        id=7,
        slug="variables-test",
        topic="Ролик про кота",
        hero_mode="auto",
        general_plan=LONG_PLAN,
        hero_descriptions=["кот в шляпе"],
        hero_count=1,
        meta={
            **GRAPH,
            "gpt_operator_results": {
                "n_excel_gpt_pk_scenes": {
                    "replyPreview": "сцен 32, покрытие pass",
                    "gateStatus": "pass",
                    "outputPaths": [],
                }
            },
            "xlsx_snapshots_by_node": {"n_plan": {"rel": "old/20261115_n_plan_result_project.xlsx"}},
            "background_style": {"name": "style_noir", "chars": 696},
        },
    )
    project.status = ProjectStatus.images_ready
    project.data_dir.mkdir(parents=True, exist_ok=True)
    (project.data_dir / "old").mkdir(parents=True, exist_ok=True)
    (project.data_dir / "old" / "20261115_n_plan_result_project.xlsx").write_bytes(b"xlsx")
    chars = project.data_dir / "characters"
    chars.mkdir(parents=True, exist_ok=True)
    (chars / "c01.png").write_bytes(b"png")

    frames = [
        Frame(
            project_id=project.id,
            number=1,
            voiceover_text="первый",
            start_ts=0.0,
            end_ts=4.0,
            duration_seconds=4.0,
            image_prompt="промт кадра 1",
            animation_prompt="анимация кадра 1",
            status="planned",
            attrs={"место": "кухня", "персонажи": "кот"},
        ),
        Frame(
            project_id=project.id,
            number=2,
            voiceover_text="второй",
            image_prompt="",
            status="planned",
        ),
    ]
    scene_png = project.data_dir / "scenes" / "frame_001_aabbcc.png"
    scene_png.parent.mkdir(parents=True, exist_ok=True)
    scene_png.write_bytes(b"png")
    artifact = Artifact(
        project_id=project.id,
        frame_id=None,
        kind=ArtifactKind.scene_image,
        uuid="art-scene-1",
        path=str(scene_png),
    )

    async with factory() as session:
        session.add(project)
        session.add_all(frames)
        session.add(artifact)
        await session.commit()

    with TestClient(_app(factory)) as test_client:
        yield test_client
    await engine.dispose()


@pytest.fixture
async def empty_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # noqa: ANN201
    """Пустой проект: ни графа, ни кадров, ни meta — панель всё равно отвечает."""
    data_root = tmp_path / "data-empty"
    monkeypatch.setattr("app.settings.settings.data_dir", str(data_root))

    engine, factory = await _make_engine(tmp_path)
    project = Project(id=8, slug="variables-empty", topic="", hero_mode="auto")
    project.data_dir.mkdir(parents=True, exist_ok=True)

    async with factory() as session:
        session.add(project)
        await session.commit()

    with TestClient(_app(factory)) as test_client:
        yield test_client
    await engine.dispose()


def _nodes_by_key(body: dict) -> dict[str, dict]:
    return {str(node["node_key"]): node for node in body["nodes"]}


def _var(node: dict, key: str) -> dict:
    for item in node["vars"]:
        if item["key"] == key:
            return item
    raise AssertionError(f"у ноды {node['node_key']} нет переменной {key}")


def test_variables_endpoint_returns_nodes_and_values(client: TestClient) -> None:
    r = client.get("/api/projects/7/montage/variables")
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["project_id"] == 7
    assert body["slug"] == "variables-test"
    assert body["status"] == "images_ready"
    assert body["frames_total"] == 2
    assert body["generated_at"]

    nodes = _nodes_by_key(body)
    # HITL-гейт ничего не производит — в панели его нет.
    assert "n_hitl_gate" not in nodes
    assert {"n_topic", "n_plan", "n_excel_gpt_pk_scenes"} <= set(nodes)

    topic = nodes["n_topic"]
    assert topic["label"] == "Тема"
    assert _var(topic, "topic")["value"] == "Ролик про кота"
    assert topic["state"] in {"done", "running", "pending", "error", "disabled"}
    # Тема не рисуется строкой доски — у шага только данные панели.
    assert topic["montage_rows"] == []

    plan = nodes["n_plan"]
    # План раскладывается на кадры (attrs кадров) — это строка «Действие кадра».
    assert plan["montage_rows"] == ["action"]
    plan_var = _var(plan, "general_plan")
    assert plan_var["kind"] == "longtext"
    assert plan_var["count"] == len(LONG_PLAN.strip())
    assert plan_var["preview"].startswith("План ролика")
    assert plan_var["value"] == LONG_PLAN.strip()
    # Снимок Excel лежит в meta — отдаём ссылкой на /api/files.
    snapshot = _var(plan, "xlsx_snapshot")
    assert snapshot["count"] == 1
    assert snapshot["value"][0]["url"].startswith("/api/files?path=")

    gpt = nodes["n_excel_gpt_pk_scenes"]
    # Слот excel_gpt получает в подписи имя слота: иначе в панели два «Персонажи»
    # (нода hero и слот cast) и два «Фоны» — не выбрать нужную.
    assert gpt["label"] == "Сцены по плану · слот scenes"
    labels = [node["label"] for node in body["nodes"]]
    assert len(labels) == len(set(labels)), f"подписи нод дублируются: {labels}"
    # Слот «Работы с GPT» получает код шага enrich_N (см. node_step_code) —
    # подпись ноды при этом своя, из data.label.
    assert gpt["step_code"] in {"excel_gpt", "enrich_1"}
    # Слот «Сцены по плану» раскладывает план на кадры → строка «Действие кадра».
    assert gpt["montage_rows"] == ["action"]
    assert _var(gpt, "reply")["value"] == "сцен 32, покрытие pass"
    assert _var(gpt, "gate")["value"] == "pass"

    assert body["totals"]["frames"] == 2
    assert body["totals"]["images"] == 1
    assert body["totals"]["heroes"] == 1


def test_variables_endpoint_shows_frames_and_media(client: TestClient) -> None:
    body = client.get("/api/projects/7/montage/variables").json()
    nodes = _nodes_by_key(body)

    # Таблица «кадр → значение»: строки по кадрам, пустое значение тоже видно.
    split = nodes["n_split"]
    assert split["label"] == "Разбивка на кадры"
    frames_var = _var(split, "frames")
    assert frames_var["kind"] == "frames"
    assert frames_var["count"] == 2
    assert frames_var["value"][0]["frame"] == 1
    assert "0.00–4.00" in frames_var["value"][0]["value"]

    # Карточки промтов по кадрам живут на своей ноде — здесь её нет в графе,
    # поэтому проверяем, что чужие ноды не подмешиваются.
    assert "n_image_prompts" not in nodes


def test_variables_endpoint_unknown_project_is_404(client: TestClient) -> None:
    r = client.get("/api/projects/9999/montage/variables")
    assert r.status_code == 404


def test_variables_endpoint_survives_empty_project(empty_client: TestClient) -> None:
    r = empty_client.get("/api/projects/8/montage/variables")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["frames_total"] == 0
    assert body["totals"]["frames"] == 0
    assert isinstance(body["nodes"], list)
    # У проекта без своего графа работает штатная схема — ноды не пустые.
    assert body["nodes"], "пустой проект без nodes: панель покажет пустоту"
    for node in body["nodes"]:
        assert node["vars"], f"у ноды {node['node_key']} нет ни одной переменной"
        assert isinstance(node["montage_rows"], list)
        for var in node["vars"]:
            assert var["kind"] in {
                "text", "longtext", "list", "frames", "image",
                "video", "audio", "json", "number", "bool",
            }, var
