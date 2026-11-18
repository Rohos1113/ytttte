"""Доска отдаёт запланированные шоты кадра (`attrs["кадры"]`) — колонка на шот."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base, Frame, Project
from app.services.montage_board import _planned_shots_payload, build_montage_board

SHOT_1 = {
    "id": "S1-K1",
    "parent_id": None,
    "порядок": 1,
    "сцена": 1,
    "действие": "Аделфус входит во двор и оглядывается",
    "фон": "двор у трактира",
    "фон_код": "f01",
    "кто": "Аделфус (c01)",
    "где": "у ворот",
    "место": "двор",
    "план": "средний",
    "старт": "0.0",
    "конец": "2.5",
    "длительность": 2.5,
    "закадр": "Аделфус вошёл во двор.",
    "предметы": ["i01"],
}

SHOT_2 = {
    "id": "S1-K2",
    "parent_id": "S1-K1",
    "порядок": 2,
    "сцена": 1,
    "действие": "Оглядывает двери трактира",
    "фон": "двор у трактира",
    "фон_код": "f01",
    "кто": "Аделфус (c01)",
    "где": "перед дверью",
    "план": "крупный",
    "старт": "2.5",
    "конец": "5.0",
    "длительность": 2.5,
    "закадр": "Двери были заперты.",
    "предметы": [],
}


@pytest.fixture
async def session(tmp_path: Path) -> AsyncSession:
    db_path = tmp_path / "shots.db"
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Project:
    data_root = tmp_path / "data"
    data_root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.settings.settings.data_dir", str(data_root))
    p = Project(id=43, slug="shots-test", topic="Тест", hero_mode="auto")
    p.data_dir.mkdir(parents=True, exist_ok=True)
    return p


@pytest.mark.asyncio
async def test_board_frames_carry_planned_shots(
    project: Project,
    session: AsyncSession,
) -> None:
    session.add(project)
    session.add(
        Frame(
            project_id=project.id,
            number=1,
            voiceover_text="Аделфус вошёл во двор. Двери были заперты.",
            attrs={"источник": "pk", "кадры": [SHOT_1, SHOT_2]},
            duration_seconds=5.0,
            status="planned",
        )
    )
    session.add(
        Frame(
            project_id=project.id,
            number=2,
            voiceover_text="Дальше по улице.",
            attrs={"источник": "pk"},
            status="planned",
        )
    )
    await session.flush()

    board = await build_montage_board(session, project)
    rows = board["frames"]

    assert len(rows) == 2
    first = rows[0]["planned_shots"]
    assert [shot["id"] for shot in first] == ["S1-K1", "S1-K2"]
    assert first[0]["действие"] == SHOT_1["действие"]
    assert first[0]["закадр"] == SHOT_1["закадр"]
    assert first[0]["фон_код"] == "f01"
    assert first[0]["parent_id"] is None
    assert first[1]["parent_id"] == "S1-K1"
    # Рефы шота: персонаж из «кто» и предмет из «предметы».
    assert [ref["id"] for ref in first[0]["character_refs"]] == ["c01"]
    assert [ref["id"] for ref in first[0]["item_refs"]] == ["i01"]
    assert first[0]["background_ref"]["code"] == "f01"

    # Кадр без плана шотов — пустой список, доска живёт по-старому.
    assert rows[1]["planned_shots"] == []
    assert board["shots_total"] == 2
    assert board["board_columns"] == 3


def test_planned_shots_image_from_images_dir(tmp_path: Path) -> None:
    """Still шота подхватывается из images/<id>.png, пока файла нет — None."""
    data_dir = tmp_path / "data"
    (data_dir / "images").mkdir(parents=True)
    (data_dir / "images" / "S1-K1.png").write_bytes(b"png")

    from types import SimpleNamespace

    frame = SimpleNamespace(attrs={"кадры": [SHOT_1]})
    payload = _planned_shots_payload(
        frame,
        data_dir=data_dir,
        chars_dir=data_dir / "characters",
        items_dir=data_dir / "items",
        backgrounds_dir=data_dir / "backgrounds",
        char_names={},
        item_names={},
    )
    assert payload[0]["image_url"]
    assert "S1-K1.png" in payload[0]["image_url"]
