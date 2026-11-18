"""Архивные кадры прежнего разбиения по плану не попадают на доску."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base, Frame, Project
from app.services.db_v2 import count_live_frames, frame_is_archived, live_frames
from app.services.montage_board import build_montage_board

ARCHIVED_ATTRS = {
    "источник": "pk_archived",
    "архив_номер": 1,
    "удалён": True,
    "пометка": "архив прежнего разбиения по плану",
}


@pytest.fixture
async def session(tmp_path: Path) -> AsyncSession:
    db_path = tmp_path / "archived.db"
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
    p = Project(id=42, slug="archived-test", topic="Тест", hero_mode="auto")
    p.data_dir.mkdir(parents=True, exist_ok=True)
    return p


def test_frame_is_archived_by_pk_source() -> None:
    """Архив ловится по attrs, хотя номер 1000xx ниже парковочного порога."""
    archived = {"number": 100004, "attrs": ARCHIVED_ATTRS}
    live = {"number": 4, "attrs": {"источник": "pk"}}
    trashed = {"number": 4, "attrs": {"удалён": True}}  # корзина — не архив
    assert frame_is_archived(archived) is True
    assert frame_is_archived(live) is False
    assert frame_is_archived(trashed) is False
    assert len(live_frames([archived, live, trashed])) == 2


@pytest.mark.asyncio
async def test_montage_board_skips_archived_frames(
    project: Project,
    session: AsyncSession,
) -> None:
    """3 живых + 2 архивных: доска отдаёт 3 кадра, архивных номеров нет."""
    session.add(project)
    for number in (1, 2, 3):
        session.add(
            Frame(
                project_id=project.id,
                number=number,
                voiceover_text=f"кадр {number}",
                attrs={"источник": "pk"},
                status="planned",
            )
        )
    for number in (100004, 100005):
        session.add(
            Frame(
                project_id=project.id,
                number=number,
                voiceover_text="старый кадр",
                attrs=dict(ARCHIVED_ATTRS),
                status="planned",
            )
        )
    await session.flush()

    assert await count_live_frames(session, project.id) == 3

    board = await build_montage_board(session, project)
    numbers = [row["number"] for row in board["frames"]]

    assert board["frame_count"] == 3
    assert numbers == [1, 2, 3]
    assert all(number < 100000 for number in numbers)
    # Каждый кадр — своя сцена: ширина доски = 1 (th) + 3*(1 кадр + 1 сцена) + 1 = 8.
    assert len(numbers) * 2 + 2 == 8

    # Корзина пользователя (удалён без архива) на доске остаётся.
    session.add(
        Frame(
            project_id=project.id,
            number=4,
            voiceover_text="в корзине",
            attrs={"источник": "pk", "удалён": True},
            status="planned",
        )
    )
    await session.flush()
    board2 = await build_montage_board(session, project)
    assert [row["number"] for row in board2["frames"]] == [1, 2, 3, 4]
