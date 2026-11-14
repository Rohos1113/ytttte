"""Ручки нового дока генерации (перенос из webtest2): items / hero / reply.

Здесь проверяем не только сами ручки, но и то, что перенос не испортил соседние
индексы: удаление предмета не задевает `predmet10`, сдвиг идёт числами, а путь к
ответу GPT из meta не читает файлы за пределами папки проекта.
"""

from __future__ import annotations

from pathlib import Path

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import (
    Artifact,
    ArtifactKind,
    Base,
    Entity,
    HITLDecision,
    HITLKind,
    HITLRequest,
    Project,
    ProjectStatus,
)
from app.settings import settings
from app.web.api import create_app
from app.web.deps import get_session

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "allow_unisolated_tenants", True)
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'port-api.db'}", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        s.add(
            Project(
                slug="port-api",
                topic="тема",
                status=ProjectStatus.new,
                meta={},
                item_descriptions=[],
            )
        )
        await s.commit()

    async def _gen():
        async with factory() as s:
            yield s

    app = create_app()
    app.dependency_overrides[get_session] = _gen
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.factory = factory  # type: ignore[attr-defined]
        yield c
    await engine.dispose()


async def _data_dir(client) -> Path:
    async with client.factory() as s:
        project = await s.get(Project, 1)
        return Path(project.data_dir)


async def _set_items(client, count: int) -> None:
    async with client.factory() as s:
        project = await s.get(Project, 1)
        project.item_descriptions = [f"предмет {i}" for i in range(1, count + 1)]
        await s.commit()


# --- замена референса -------------------------------------------------------


async def test_replace_hero_by_code_writes_character_file(client) -> None:
    res = await client.post(
        "/api/projects/1/assets/hero/replace?code=c02",
        files={"file": ("hero.png", PNG, "image/png")},
    )

    assert res.status_code == 200, res.text
    data_dir = await _data_dir(client)
    assert (data_dir / "characters" / "c02.png").is_file()


async def test_replace_hero_by_item_index_writes_item_file(client) -> None:
    res = await client.post(
        "/api/projects/1/assets/hero/replace?item_index=3",
        files={"file": ("predmet.png", PNG, "image/png")},
    )

    assert res.status_code == 200, res.text
    data_dir = await _data_dir(client)
    assert (data_dir / "items" / "predmet3.png").is_file()


# --- предметы ---------------------------------------------------------------


async def test_item_regenerate_removes_only_its_own_file(client) -> None:
    data_dir = await _data_dir(client)
    items = data_dir / "items"
    items.mkdir(parents=True, exist_ok=True)
    for num in (1, 2, 10, 11):
        (items / f"predmet{num}.png").write_bytes(PNG)

    res = await client.post("/api/projects/1/items/1/regenerate")

    assert res.status_code == 200, res.text
    assert not (items / "predmet1.png").exists()
    # `predmet1*` не должен захватить десятые номера.
    for num in (2, 10, 11):
        assert (items / f"predmet{num}.png").is_file(), f"predmet{num} должен остаться"


async def test_item_delete_shifts_numbers_numerically(client) -> None:
    data_dir = await _data_dir(client)
    items = data_dir / "items"
    items.mkdir(parents=True, exist_ok=True)
    for num in range(1, 13):
        (items / f"predmet{num}.png").write_bytes(PNG)
    await _set_items(client, 12)

    res = await client.delete("/api/projects/1/items/2")

    assert res.status_code == 200, res.text
    assert res.json()["remaining"] == 11
    # Сдвиг обязан идти от младших номеров к старшим, иначе predmet10 не сможет
    # стать predmet9, пока тот ещё занят.
    names = {f.name for f in items.glob("predmet*")}
    assert names == {f"predmet{num}.png" for num in range(1, 12)}


async def test_item_delete_moves_descriptions_and_meta_attrs(client) -> None:
    await _set_items(client, 3)
    async with client.factory() as s:
        project = await s.get(Project, 1)
        project.meta = {"item_attrs": {"1": {"look": "a"}, "2": {"look": "b"}, "3": {"look": "c"}}}
        await s.commit()

    res = await client.delete("/api/projects/1/items/2")

    assert res.status_code == 200, res.text
    async with client.factory() as s:
        project = await s.get(Project, 1)
        assert project.item_descriptions == ["предмет 1", "предмет 3"]
        assert project.meta["item_attrs"] == {"1": {"look": "a"}, "2": {"look": "c"}}


async def test_item_delete_missing_returns_404_and_zero_index_400(client) -> None:
    assert (await client.delete("/api/projects/1/items/7")).status_code == 404
    assert (await client.delete("/api/projects/1/items/0")).status_code == 400


# --- персонажи --------------------------------------------------------------


async def _add_character(client, code: str) -> Path:
    data_dir = await _data_dir(client)
    folder = data_dir / "characters"
    folder.mkdir(parents=True, exist_ok=True)
    image = folder / f"{code}.png"
    image.write_bytes(PNG)
    async with client.factory() as s:
        s.add(Entity(project_id=1, type="character", code=code, name="Герой", attrs={}))
        s.add(
            Artifact(
                project_id=1,
                kind=ArtifactKind.hero_reference,
                uuid=f"u-{code}",
                path=str(image),
                meta={"code": code},
            )
        )
        await s.commit()
    return image


async def test_hero_character_delete_removes_entity_file_and_artifact(client) -> None:
    image = await _add_character(client, "c01")

    res = await client.delete("/api/projects/1/hero/characters/c01")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["removed_entities"] == 1
    assert body["removed_artifacts"] == 1
    assert not image.exists()
    async with client.factory() as s:
        assert (await s.execute(select(Entity))).scalars().all() == []
        assert (await s.execute(select(Artifact))).scalars().all() == []


async def test_hero_character_regenerate_asks_hitl_and_removes_image(client) -> None:
    image = await _add_character(client, "c01")

    res = await client.post("/api/projects/1/hero/characters/c01/regenerate")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["excel_mode"] is False
    assert body["hero_index"] == 1
    assert not image.exists()
    async with client.factory() as s:
        request = (await s.execute(select(HITLRequest))).scalars().one()
        assert request.kind == HITLKind.approve_hero
        assert request.decision == HITLDecision.regenerate
        assert request.payload["hero_index"] == 1


async def test_hero_character_regenerate_rejects_non_character_code(client) -> None:
    res = await client.post("/api/projects/1/hero/characters/zz/regenerate")

    assert res.status_code == 400


# --- полный ответ GPT -------------------------------------------------------


async def test_gpt_operator_reply_returns_whole_file(client) -> None:
    data_dir = await _data_dir(client)
    folder = data_dir / "excel_gpt_uploads" / "n_excel_gpt_1"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "gpt_reply.txt").write_text("x" * 5000, encoding="utf-8")

    res = await client.get("/api/projects/1/gpt-operator/n_excel_gpt_1/reply")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["chars"] == 5000
    assert body["truncated"] is False
    assert body["path"] == "gpt_reply.txt"


async def test_gpt_operator_reply_reads_absolute_path_inside_project(client) -> None:
    data_dir = await _data_dir(client)
    answer = data_dir / "answers" / "reply.txt"
    answer.parent.mkdir(parents=True, exist_ok=True)
    answer.write_text("внутри проекта", encoding="utf-8")
    async with client.factory() as s:
        project = await s.get(Project, 1)
        project.meta = {"excel_gpt_nodes": {"n": {"lastReplyPath": str(answer)}}}
        await s.commit()

    body = (await client.get("/api/projects/1/gpt-operator/n/reply")).json()

    assert body["text"] == "внутри проекта"


async def test_gpt_operator_reply_ignores_path_outside_project(client, tmp_path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("чужой файл", encoding="utf-8")
    async with client.factory() as s:
        project = await s.get(Project, 1)
        project.meta = {"excel_gpt_nodes": {"n": {"lastReplyPath": str(secret)}}}
        await s.commit()

    res = await client.get("/api/projects/1/gpt-operator/n/reply")

    assert res.status_code == 200, res.text
    # meta правит клиент: абсолютный путь из неё не должен читать файлы системы.
    assert res.json()["text"] == ""
