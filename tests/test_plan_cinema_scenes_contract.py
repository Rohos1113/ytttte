"""Контракт сцен: врезка 1–2 кадра и правила промта «Сцены по плану».

Владелец (22.11) поправил промт: новая сцена — только при смене локации;
персонаж, вошедший не в первом кадре, обязан быть показан «как и откуда
пришёл»; длительные статичные действия (прошёл, протёр, смотрит) запрещены.
Код в этом месте спорил с промтом: стилевой гейт требовал ровно 2 кадра у
врезки, хотя промт и `insert_scene_problems` разрешают 1–2.
"""

from __future__ import annotations

from pathlib import Path

from app.services.plan_cinema import nodes

PROMPT = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "node_groups"
    / "plan_cinema"
    / "plan_to_scenes.md"
)

_INSERT_TEXT = " ".join(["л"] * 60)  # 60 слов: врезка 50–100
_NORMAL_TEXT = " ".join(["д"] * 100)  # 100 слов: обычная сцена 85–160


def _scene(**overrides: object) -> dict:
    scene: dict = {
        "номер": 1,
        "id_плана": ["P1"],
        "место": "узкий двор между складами, вечер",
        "персонажи": ["Иван"],
        "предметы": [],
        "событие": "Иван рвёт коробку",
        "примечание": "",
        "сцена": _NORMAL_TEXT,
        "сцена_вставка": False,
        "возврат_к_сцене": 0,
        "продолжение_фона": False,
        "кадров_макс": 6,
    }
    scene.update(overrides)
    return scene


def test_insert_scene_with_one_shot_is_valid() -> None:
    insert = _scene(сцена=_INSERT_TEXT, сцена_вставка=True, кадров_макс=1)

    assert nodes._scene_style_problems([insert]) == []


def test_insert_scene_with_two_shots_is_valid() -> None:
    insert = _scene(сцена=_INSERT_TEXT, сцена_вставка=True, кадров_макс=2)

    assert nodes._scene_style_problems([insert]) == []


def test_insert_scene_with_three_shots_is_rejected() -> None:
    insert = _scene(сцена=_INSERT_TEXT, сцена_вставка=True, кадров_макс=3)

    problems = nodes._scene_style_problems([insert])

    assert any("врезка" in item and "1–2" in item for item in problems)


def test_normal_scene_shot_budget_still_4_to_10() -> None:
    assert nodes._scene_style_problems([_scene(кадров_макс=4)]) == []
    assert nodes._scene_style_problems([_scene(кадров_макс=10)]) == []
    assert nodes._scene_style_problems([_scene(кадров_макс=3)])


def test_prompt_keeps_owner_wording() -> None:
    text = PROMPT.read_text(encoding="utf-8")

    assert "Новая сцена начинается при смене локации." in text
    assert "не допускай появления персонажа не в первом кадре сцены" in text
    assert "длительные действия с низкой динамикой запрещены" in text
    # Бит как единица действия остаётся: на него ссылается чек-лист.
    assert "Бит — один субъект, один активный глагол" in text
