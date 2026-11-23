"""«Предметы» собирают вещи, которые используются минимум в двух кадрах.

Живой прогон 22.11.2026: сцены «Кино по плану» несли ``предметы``, а шаг
«Предметы» сразу ушёл в ``items_ready`` с записью «item_descriptions пуст —
items_ready без работы»: шаг смотрел только ``project.item_descriptions`` и
``Entity(prop|item)``, карточки сцен не читал.

Правило владельца: брать вещи, которые появляются минимум в двух кадрах,
заводить их в реестр и указывать кадры появления. Если структурированных
предметов в карточках нет (короткая карточка сцены их не пишет) — кадры
разбирает модель.
"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base, Entity, Project, ProjectStatus


@pytest.fixture
async def mem_db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    @asynccontextmanager
    async def _scope():
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    monkeypatch.setattr("app.db.session_scope", _scope)
    yield _scope
    await engine.dispose()


def _project(**kw) -> Project:
    base = {
        "slug": f"items-{uuid.uuid4().hex[:8]}",
        "topic": "тема",
        "status": ProjectStatus.generating_items,
        "hero_mode": "no_hero",
        "item_descriptions": [],
        "general_plan": "крючок, развитие, финал" * 20,
        "script_text": "закадровый текст" * 20,
        "meta": {"split_completed": True},
    }
    base.update(kw)
    return Project(**base)


def _scene(number: int, props=None, shots=None, source: str = "pk", **attrs) -> dict:
    return {
        "источник": source,
        "номер": number,
        "предметы": props or [],
        "кадры": shots or [],
        **attrs,
    }


class _FakeGpt:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.prompts: list[str] = []

    async def ask_fresh(self, prompt: str, **_kw) -> str:
        self.prompts.append(prompt)
        return self.reply


def test_scenery_is_not_a_prop() -> None:
    """Часть фона предметом не считается — иначе реф-лист рисует декорации."""
    from app.orchestrator.steps.generate_items import is_scenery

    for name in (
        "Возвышение",
        "Каменное ложе",
        "Тактический стол",
        "Защитные кольца",
        "Вход в Паутину",
        "Изображение Императора",
        "Стена зала",
        "Трон",
    ):
        assert is_scenery(name), name

    for name in (
        "Меч Хоруса",
        "Печать Воителя",
        "Передатчик",
        "Астропатическое сообщение",
        "ритуальный кинжал",
    ):
        assert not is_scenery(name), name


@pytest.mark.asyncio
async def test_scenery_from_reply_never_reaches_registry(mem_db, monkeypatch) -> None:
    from app.models import Frame
    from app.orchestrator.steps import generate_items

    fake = _FakeGpt(
        "1. Возвышение | приподнятая площадка | S1-K1, S1-K2\n"
        "2. Меч Хоруса | чёрный клинок | S1-K1, S2-K2\n"
    )
    monkeypatch.setattr(generate_items, "get_gpt_client", lambda: fake)

    async with mem_db() as session:
        p = _project()
        session.add(p)
        await session.flush()
        session.add(
            Frame(
                project_id=p.id,
                voiceover_text="",
                number=1,
                attrs=_scene(1, [], shots=[{"id": "S1-K1", "номер": 1, "действие": "Хорус держит меч"}]),
            )
        )
        await session.flush()

        descriptions = await generate_items._resolve_item_descriptions(session, p)

        assert descriptions == ["Меч Хоруса — чёрный клинок"]
        props = (
            (await session.execute(select(Entity).where(Entity.project_id == p.id, Entity.type == "prop")))
            .scalars()
            .all()
        )
        assert [e.name for e in props] == ["Меч Хоруса"]


def test_usage_keeps_props_from_two_or_more_frames() -> None:
    from app.orchestrator.steps.generate_items import _prop_usage_from_cards

    cards = [
        _scene(
            1,
            ["меч Хоруса", "печать Воителя"],
            shots=[
                {"номер": 1, "предметы": ["меч Хоруса"]},
                {"номер": 2, "предметы": ["меч Хоруса", "печать Воителя"]},
            ],
        ),
        _scene(2, [], shots=[{"номер": 1, "предметы": ["ритуальный кинжал"]}]),
    ]

    usage = _prop_usage_from_cards(cards)

    assert usage == {
        "меч Хоруса": {
            "description": "",
            "frames": ["сцена 1", "сцена 1, кадр 1", "сцена 1, кадр 2"],
        },
        "печать Воителя": {"description": "", "frames": ["сцена 1", "сцена 1, кадр 2"]},
    }
    assert "ритуальный кинжал" not in usage, "вещь из одного кадра реф-листа не заводит"


def test_usage_dedupes_case_and_collects_frames_across_scenes() -> None:
    from app.orchestrator.steps.generate_items import _prop_usage_from_cards

    cards = [
        _scene(1, ["Печать Воителя"]),
        _scene(2, ["печать воителя"], shots=[{"номер": 3, "предметы": [{"название": "Печать Воителя"}]}]),
    ]

    usage = _prop_usage_from_cards(cards)

    assert usage == {
        "Печать Воителя": {
            "description": "",
            "frames": ["сцена 1", "сцена 2", "сцена 2, кадр 3"],
        }
    }


def test_parse_props_reply_reads_name_appearance_and_frames() -> None:
    from app.orchestrator.steps.generate_items import parse_props_reply

    reply = """Вот список:
1. **Меч Хоруса** | чёрный клинок, золотая гравировка | S1-K1, S2-K4
- печать Воителя | тяжёлая золотая печать | S3-K2; S5-K1
"""

    assert parse_props_reply(reply) == {
        "Меч Хоруса": {"description": "чёрный клинок, золотая гравировка", "frames": ["S1-K1", "S2-K4"]},
        "печать Воителя": {"description": "тяжёлая золотая печать", "frames": ["S3-K2", "S5-K1"]},
    }


@pytest.mark.asyncio
async def test_props_from_scene_cards_are_written_with_frames(mem_db) -> None:
    """Структурированные предметы: пишем имена и сохраняем кадры в реестре."""
    from app.models import Frame
    from app.orchestrator.steps.generate_items import _resolve_item_descriptions

    async with mem_db() as session:
        p = _project()
        session.add(p)
        await session.flush()
        session.add_all(
            [
                Frame(
                    project_id=p.id,
                    voiceover_text="",
                    number=1,
                    attrs=_scene(
                        1,
                        ["меч Хоруса"],
                        shots=[
                            {"номер": 1, "предметы": ["меч Хоруса"]},
                            {"номер": 2, "предметы": ["меч Хоруса"]},
                        ],
                    ),
                ),
                Frame(
                    project_id=p.id,
                    voiceover_text="",
                    number=2,
                    attrs=_scene(2, [], shots=[{"номер": 1, "предметы": ["осадные орудия"]}]),
                ),
            ]
        )
        await session.flush()

        descriptions = await _resolve_item_descriptions(session, p)

        assert descriptions == ["меч Хоруса"], "из одного кадра предмет в реестр не идёт"
        assert p.item_descriptions == ["меч Хоруса"]

        prop = (
            (await session.execute(select(Entity).where(Entity.project_id == p.id, Entity.type == "prop")))
            .scalars()
            .one()
        )
        assert prop.name == "меч Хоруса"
        assert prop.code == "p01"
        assert prop.attrs["кадры"] == ["сцена 1", "сцена 1, кадр 1", "сцена 1, кадр 2"]
        assert prop.attrs["кадров"] == 3


@pytest.mark.asyncio
async def test_model_finds_props_in_frames_when_cards_are_empty(mem_db, monkeypatch) -> None:
    """Короткая карточка предметов не несёт — предметы и кадры достаёт модель."""
    from app.models import Frame
    from app.orchestrator.steps import generate_items

    fake = _FakeGpt(
        "1. Меч Хоруса | чёрный клинок с золотой гравировкой | S1-K1, S2-K3\n"
        "2. Печать Воителя | тяжёлая золотая печать | S1-K2, S3-K1\n"
        "3. Случайный ящик | деревянный ящик | S2-K3\n"
    )
    monkeypatch.setattr(generate_items, "get_gpt_client", lambda: fake)

    async with mem_db() as session:
        p = _project()
        session.add(p)
        await session.flush()
        session.add(
            Frame(
                project_id=p.id,
                voiceover_text="",
                number=1,
                attrs=_scene(
                    1,
                    [],
                    shots=[
                        {"id": "S1-K1", "номер": 1, "действие": "Хорус поднимает меч"},
                        {"id": "S1-K2", "номер": 2, "действие": "Хорус прижимает печать к груди"},
                    ],
                ),
            )
        )
        await session.flush()

        descriptions = await generate_items._resolve_item_descriptions(session, p)

        assert descriptions == [
            "Меч Хоруса — чёрный клинок с золотой гравировкой",
            "Печать Воителя — тяжёлая золотая печать",
        ], "ящик виден в одном кадре и в реестр идти не должен"
        assert fake.prompts, "модель должна была получить раскадровку"
        assert "S1-K1: Хорус поднимает меч" in fake.prompts[0]

        props = (
            (await session.execute(select(Entity).where(Entity.project_id == p.id, Entity.type == "prop")))
            .scalars()
            .all()
        )
        by_name = {e.name: e.attrs for e in props}
        assert by_name["Меч Хоруса"]["кадры"] == ["S1-K1", "S2-K3"]
        assert by_name["Меч Хоруса"]["кадров"] == 2
        assert "Случайный ящик" not in by_name


@pytest.mark.asyncio
async def test_archived_and_foreign_frames_are_ignored(mem_db, monkeypatch) -> None:
    from app.models import Frame
    from app.orchestrator.steps import generate_items

    fake = _FakeGpt("- призрак | пусто | S1-K1, S1-K2")
    monkeypatch.setattr(generate_items, "get_gpt_client", lambda: fake)

    async with mem_db() as session:
        p = _project()
        session.add(p)
        await session.flush()
        session.add_all(
            [
                Frame(
                    project_id=p.id,
                    voiceover_text="",
                    number=1,
                    attrs=_scene(1, ["старый меч"], source="pk_archived", **{"удалён": True}),
                ),
                Frame(
                    project_id=p.id,
                    voiceover_text="",
                    number=2,
                    attrs=_scene(2, ["чужой реквизит"], source="fw"),
                ),
            ]
        )
        await session.flush()

        assert await generate_items._resolve_item_descriptions(session, p) == []
        assert fake.prompts == [], "нечего разбирать — модель не зовём"


@pytest.mark.asyncio
async def test_manual_item_descriptions_win(mem_db, monkeypatch) -> None:
    from app.models import Frame
    from app.orchestrator.steps import generate_items

    fake = _FakeGpt("- призрак | пусто | S1-K1, S1-K2")
    monkeypatch.setattr(generate_items, "get_gpt_client", lambda: fake)

    async with mem_db() as session:
        p = _project(item_descriptions=["ржавая банка кротовухи"])
        session.add(p)
        await session.flush()
        session.add(Frame(project_id=p.id, number=1, voiceover_text="", attrs=_scene(1, ["меч Хоруса"])))
        await session.flush()

        assert await generate_items._resolve_item_descriptions(session, p) == ["ржавая банка кротовухи"]
        assert fake.prompts == []
