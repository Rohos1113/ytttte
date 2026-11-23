"""«Сцены по плану» читают тему, делают врезки; «Фоны» рисуют статистов.

Три пункта владельца:

* П6 — нода «Сцены по плану» берёт данные ещё и из ноды «Тема»: в промте
  ``plan_to_scenes.md`` есть ``{{TOPIC}}``, и общий читатель промтов группы
  подставляет туда ``project.topic``.
* П3 — резкое или важное место показывается отдельной сценой на 1–2 кадра,
  после неё продолжается прерванная сцена на прежнем месте (и с прежним фоном).
* П5 — массовка и статисты стоят сразу на фоне, у каждого своё «где»;
  движущиеся помечены как переместившиеся и куда.

Сети и БД нет: только текст промтов и чистые функции разбора и проверки.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.services.plan_scenes import (
    INSERT_SCENE_KEYS,
    MAX_INSERT_SHOTS,
    SCENE_INSERT,
    SCENE_KEEP_BACKGROUND,
    SCENE_MAX_SHOTS,
    SCENE_RETURN_TO,
    check_plan_coverage,
    insert_scene_problems,
    parse_scenes_reply,
)

PROMPT_DIR = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "node_groups"
    / "plan_cinema"
)
SCENES_PROMPT = PROMPT_DIR / "plan_to_scenes.md"
BACKGROUNDS_PROMPT = PROMPT_DIR / "plan_backgrounds.md"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class _Project:
    """Мини-проект: только то, что читает ``_read_group_prompt``."""

    def __init__(self, topic: str = "") -> None:
        self.topic = topic
        self.meta: dict = {}


def _reply(*scenes: dict) -> str:
    return json.dumps({"сцены": list(scenes)}, ensure_ascii=False)


def _scene(
    number: int,
    refs: list[str],
    place: str,
    event: str = "",
    **extra: object,
) -> dict:
    scene: dict = {
        "номер": number,
        "id_плана": refs,
        "место": place,
        "событие": event,
        "примечание": "",
    }
    scene.update(extra)
    return scene


def _insert(number: int, refs: list[str], place: str) -> dict:
    return _scene(
        number,
        refs,
        place,
        "Хозяин приказывает закрыть ворота",
        **{SCENE_INSERT: True, SCENE_MAX_SHOTS: 2},
    )


def _return(number: int, refs: list[str], place: str, to: int = 1) -> dict:
    return _scene(
        number,
        refs,
        place,
        "Сосед запирает ворота, Иван остаётся с коробками",
        **{SCENE_RETURN_TO: to, SCENE_KEEP_BACKGROUND: True},
    )


def _good_pair() -> list[dict]:
    return parse_scenes_reply(
        _reply(
            _scene(
                1,
                ["P1"],
                "двор у склада, вечер",
                "Иван выносит коробки",
                **{
                    SCENE_INSERT: False,
                    SCENE_RETURN_TO: 0,
                    SCENE_KEEP_BACKGROUND: False,
                    SCENE_MAX_SHOTS: 0,
                },
            ),
            _insert(2, ["P1"], "кабинет хозяина склада, вечер"),
            _return(3, ["P1", "P2"], "двор у склада, вечер"),
        )
    )


# --- П6: тема из ноды «Тема» ------------------------------------------------


def test_scenes_prompt_asks_for_raw_plan() -> None:
    text = _read(SCENES_PROMPT)
    assert "{{ПЛАН}}" in text, "вход — сырой сценарий, плейсхолдер {{ПЛАН}}"
    assert "{{ПЛАН_С_НОМЕРАМИ}}" not in text, "код больше не режет план заранее"
    assert "{{TOPIC}}" not in text, "на входе только исходный текст"
    assert "сформулируй 4–10 опорных точек сценария" in text


def test_group_prompt_keeps_plan_placeholder(monkeypatch) -> None:
    from app.services import prompt_library
    from app.services.plan_cinema import nodes

    monkeypatch.setattr(
        prompt_library, "node_group_prompts_dir", lambda group_id: PROMPT_DIR
    )
    text = nodes._read_group_prompt(_Project("Долг брата"), "plan_to_scenes")
    assert "{{ПЛАН}}" in text, "подстановка плана — в рендере ноды, не в чтении файла"


def test_legacy_prompt_rules_are_kept() -> None:
    text = _read(SCENES_PROMPT)
    for phrase in (
        "Точки нужны для контроля порядка и полноты",
        "Каждая точка попадает хотя бы в одну сцену",
        "Текст входа не копируй",
    ):
        assert phrase in text, f"потеряно правило промта: {phrase}"


# --- П3: сцена-врезка и возврат --------------------------------------------


def test_scenes_prompt_describes_insert_scene() -> None:
    text = _read(SCENES_PROMPT)
    # Контракт держится за само правило врезки, а не за его номер.
    assert "### Врезка" in text
    assert "1–2 кадра" in text
    for field in (
        "сцена_вставка",
        "возврат_к_сцене",
        "продолжение_фона",
        "кадров_макс",
    ):
        assert field in text, f"в промте нет поля врезки {field}"
    assert "дословно повторяет место прерванной сцены" in text


def test_parse_keeps_insert_fields() -> None:
    scenes = _good_pair()
    assert scenes[0][SCENE_INSERT] is False
    assert scenes[0][SCENE_RETURN_TO] == 0
    assert scenes[1][SCENE_INSERT] is True
    assert scenes[1][SCENE_MAX_SHOTS] == 2
    assert scenes[2][SCENE_RETURN_TO] == 1
    assert scenes[2][SCENE_KEEP_BACKGROUND] is True


def test_insert_without_shot_limit_gets_two() -> None:
    scenes = parse_scenes_reply(
        _reply(_scene(2, ["P1"], "кабинет хозяина, вечер", **{SCENE_INSERT: True}))
    )
    assert MAX_INSERT_SHOTS == 2
    assert scenes[0][SCENE_MAX_SHOTS] == MAX_INSERT_SHOTS


def test_good_insert_pair_has_no_problems() -> None:
    assert insert_scene_problems(_good_pair()) == []


def test_insert_without_return_is_caught() -> None:
    scenes = parse_scenes_reply(
        _reply(
            _scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"),
            _insert(2, ["P1"], "кабинет хозяина склада, вечер"),
        )
    )
    problems = insert_scene_problems(scenes)
    assert any("нет возврата" in item for item in problems)


def test_return_must_point_to_interrupted_scene() -> None:
    scenes = parse_scenes_reply(
        _reply(
            _scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"),
            _insert(2, ["P1"], "кабинет хозяина склада, вечер"),
            _return(3, ["P1", "P2"], "двор у склада, вечер", to=2),
        )
    )
    problems = insert_scene_problems(scenes)
    assert any("а прервана была сцена 1" in item for item in problems)


def test_return_must_keep_place_and_time_of_day() -> None:
    other_place = parse_scenes_reply(
        _reply(
            _scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"),
            _insert(2, ["P1"], "кабинет хозяина склада, вечер"),
            _return(3, ["P1"], "чёрный ход склада, вечер"),
        )
    )
    assert any("второй фон" in item for item in insert_scene_problems(other_place))
    other_time = parse_scenes_reply(
        _reply(
            _scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"),
            _insert(2, ["P1"], "кабинет хозяина склада, вечер"),
            _return(3, ["P1"], "двор у склада, ночь"),
        )
    )
    assert any("время суток" in item for item in insert_scene_problems(other_time))


def test_insert_must_be_short() -> None:
    scenes = parse_scenes_reply(
        _reply(
            _scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"),
            _scene(
                2,
                ["P1"],
                "кабинет хозяина склада, вечер",
                "Хозяин приказывает закрыть ворота",
                **{SCENE_INSERT: True, SCENE_MAX_SHOTS: 4},
            ),
            _return(3, ["P1", "P2"], "двор у склада, вечер"),
        )
    )
    assert any("нужно 1–2" in item for item in insert_scene_problems(scenes))


def test_ordinary_scene_keeps_old_key_set() -> None:
    """Без полей врезки ответ разбирается ровно как раньше — старые голдены живы."""

    scenes = parse_scenes_reply(
        _reply(_scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"))
    )
    assert set(scenes[0]) == {
        "номер",
        "id_плана",
        "место",
        "событие",
        "примечание",
    }


def test_coverage_passes_with_insert_pair() -> None:
    points = [("P1", "Иван выносит коробки."), ("P2", "Сосед запирает ворота.")]
    good = check_plan_coverage(points, _good_pair())
    assert good["passed"] is True, "врезка повторяет P — покрытие не ломается"
    assert good["scenes"] == 3
    assert insert_scene_problems(_good_pair()) == []

    only_first = [("P1", "Иван выносит коробки.")]
    bad = parse_scenes_reply(
        _reply(
            _scene(1, ["P1"], "двор у склада, вечер", "Иван выносит коробки"),
            _insert(2, ["P1"], "кабинет хозяина склада, вечер"),
        )
    )
    assert check_plan_coverage(only_first, bad)["passed"] is True
    assert any("нет возврата" in item for item in insert_scene_problems(bad))


def _json_example(text: str) -> dict:
    match = re.search(r"```json\s*(.*?)```", text, re.S)
    assert match, "в промте нет JSON-примера"
    return json.loads(match.group(1))


def test_scenes_prompt_json_example_has_insert_fields() -> None:
    payload = _json_example(_read(SCENES_PROMPT))
    scenes = payload["сцены"]
    assert len(scenes) >= 3
    for scene in scenes:
        assert set(INSERT_SCENE_KEYS) <= set(scene)
    insert = [scene for scene in scenes if scene[SCENE_INSERT]]
    returned = [scene for scene in scenes if scene[SCENE_RETURN_TO]]
    assert insert and returned
    assert insert[0][SCENE_MAX_SHOTS] == MAX_INSERT_SHOTS
    assert returned[0][SCENE_KEEP_BACKGROUND] is True


def test_backgrounds_json_example_has_statics_and_moves() -> None:
    payload = _json_example(_read(BACKGROUNDS_PROMPT))
    card = payload["фоны"][0]
    assert "статисты" in card and "перемещения" in card
    assert card["статисты"].strip()
    assert "guard" in card["промт"].lower()


# --- П5: массовка и статисты на фоне ---------------------------------------


def test_backgrounds_prompt_draws_statics_on_background() -> None:
    text = _read(BACKGROUNDS_PROMPT)
    assert "## Люди на фоне" in text
    assert "Массовка и статисты — часть локации" in text
    assert "У каждого статиста своё «где»" in text
    assert "Героев сцен на фон не ставим" in text


def test_backgrounds_prompt_marks_moving_characters() -> None:
    text = _read(BACKGROUNDS_PROMPT)
    assert "Движущиеся в фон не рисуются" in text
    assert "перемещения" in text
    assert "откуда и куда" in text


def test_backgrounds_prompt_no_longer_forbids_people_completely() -> None:
    text = _read(BACKGROUNDS_PROMPT)
    assert "Без людей. Ни героев" not in text
    assert "Описывай пустое место" not in text
    assert "только декорация" not in text.lower()


def test_backgrounds_card_has_statics_and_moves_fields() -> None:
    text = _read(BACKGROUNDS_PROMPT)
    assert '"статисты":' in text
    assert '"перемещения":' in text
    assert "до 600 знаков" in text
