"""Кадры «Шотов»: очистка от пары старт/конец, непрерывность, камера реплик.

Проверяем детерминированную часть ноды «Шоты» (``plan_cinema.nodes``):
- П2: пара «старт/конец» этой цепочке не принадлежит — её делает отдельная нода,
  поэтому поля пары вычищаются из карточки;
- П4: состояние кадров не телепортируется между кадрами;
- П8: камера кадра с репликой задаётся правилом (диалог — «с плеча»,
  монолог — КРУПНЫЙ фронт), а не «глухим фронтом» модели.

Сети и БД нет: только чистые функции нормализации и разбора.
"""

from __future__ import annotations

from pathlib import Path

from app.services.plan_cinema import nodes

ROOT = Path(__file__).resolve().parents[1]
PROMPTS = ROOT / "templates" / "node_groups" / "plan_cinema"


def _scene(number: int = 1, place: str = "двор, вечер", *, background: str = "f01") -> dict:
    return {
        "id": f"uuid-{number}",
        "номер": number,
        "место": place,
        "персонажи": ["c01", "c05"],
        "предметы": [],
        "событие": "Иван входит во двор и ставит коробку",
        "сцена": "Иван входит во двор.",
        "id_плана": [],
        "фон": background,
    }


def _card(index: int, **overrides) -> dict:
    card = {
        "id": f"S1-K{index}",
        "parent_id": None,
        "порядок": index,
        "сцена": 1,
        "место": "двор, вечер",
        "действие": "Иван (c01) ставит коробку — коробка на земле",
        "фон": "мокрый двор, стопка коробок у стены",
        "кто": "Иван (c01)",
        "где": "Иван (c01) стоит справа у стола",
        "позы": "стоит, в руках коробка",
        "эмоции": "",
        "старт": "",
        "конец": "",
        "точность": "одна картинка",
        "причина": "",
        "промт_картинки": (
            "Линза 35 мм, план ОБЩИЙ, ракурс фронт, высота уровень глаз. "
            "Фон: f01, мокрый двор. Иван (c01) ставит коробку."
        ),
        "предметы": [],
        "план": "ОБЩИЙ",
        "ракурс": "фронт",
        "высота": "уровень глаз",
        "объект": "место",
        "говорит": "",
        "реплика": "",
        "звук": "",
        "фон_код": "",
    }
    card.update(overrides)
    return card


def _normalize(cards: list[dict], speech: dict | None = None, scene: dict | None = None) -> list[dict]:
    return nodes._normalize_kadry(
        cards, speech or {"тип": "нет", "реплики": []}, scene or _scene()
    )


# --- П2: полей пары «старт/конец» в карточке быть не должно ------------------


def test_pair_fields_are_stripped_from_card() -> None:
    card = _card(
        1,
        точность="старт/конец",
        старт="двор пуст",
        конец="Иван внутри",
        причина="вход в сцену",
        промт_старт="вход: двор пуст",
        промт_конец="выход: Иван внутри",
    )
    cards = _normalize([card, _card(2, план="СРЕДНИЙ")])
    first = cards[0]
    for field in ("старт", "конец", "точность", "причина", "промт_старт", "промт_конец"):
        assert field not in first, field
    assert first["промт_картинки"]


def test_pair_fields_are_stripped_even_when_only_pair_prompt_exists() -> None:
    card = _card(1, промт_картинки="")
    card.pop("промт_картинки")
    card["промт_конец"] = "Конец: дверь открыта"
    normalized = _normalize([card])[0]
    assert "промт_конец" not in normalized
    assert normalized["промт_картинки"]


def test_both_shot_prompts_forbid_pair_fields() -> None:
    for name in ("scenes_to_frames_plan_vo.md", "scenes_to_frames_plan_ru.md"):
        text = (PROMPTS / name).read_text(encoding="utf-8")
        assert "полей пары «старт/конец»" in text
        # пара не описана как поле карточки — только как запрет
        for field in ("старт", "конец", "точность", "причина", "промт_старт", "промт_конец"):
            assert f"| `{field}` |" not in text, field


# --- П4: непрерывность ------------------------------------------------------


def test_scene_fields_are_filled_when_model_omits_them() -> None:
    card = _card(1)
    card.pop("сцена")
    card.pop("место")
    normalized = _normalize([card])[0]
    assert normalized["сцена"] == 1
    assert normalized["место"] == "двор, вечер"


def test_mechanics_do_not_require_entry_pair() -> None:
    cards = _normalize([_card(1), _card(2, план="СРЕДНИЙ")])
    problems = nodes._shot_mechanics(cards, vo_mode=True, scene=_scene())
    assert not any("вход в сцену" in item for item in problems)


# --- П8: камера кадров с репликой ------------------------------------------


def _dialog_speech() -> dict:
    return {
        "тип": "диалог",
        "реплики": [
            {"кто": "c01", "текст": "Начинаем.", "эмоция": "спокойно"},
            {"кто": "c05", "текст": "Ждём приказ.", "эмоция": ""},
        ],
    }


def test_dialogue_reply_gets_over_the_shoulder_camera() -> None:
    cards = _normalize(
        [
            _card(1),
            _card(
                2,
                кто="Иван (c01), Пётр (c05)",
                где="Иван (c01) слева, Пётр (c05) справа",
                говорит="c01",
                реплика="Начинаем.",
                объект="двое",
            ),
            _card(
                3,
                кто="Иван (c01), Пётр (c05)",
                где="Иван (c01) слева, Пётр (c05) справа",
                говорит="c05",
                реплика="Ждём приказ.",
                объект="двое",
            ),
        ],
        _dialog_speech(),
    )
    for shot in cards[1:]:
        assert shot["план"] == "СРЕДНЕ-КРУПНЫЙ"
        assert shot["ракурс"] == "с плеча"
        assert shot["высота"] == "уровень глаз"
        assert "план СРЕДНЕ-КРУПНЫЙ, ракурс с плеча, высота уровень глаз" in shot["промт_картинки"]
    assert cards[1]["объект"] == "двое"


def test_monologue_reply_gets_close_up_camera() -> None:
    speech = {"тип": "монолог", "реплики": [{"кто": "c01", "текст": "Я вернусь."}]}
    cards = _normalize(
        [_card(1, кто="Иван (c01)", говорит="c01", реплика="Я вернусь.")],
        speech,
    )
    shot = cards[0]
    assert shot["план"] == "КРУПНЫЙ"
    assert shot["ракурс"] == "фронт"
    assert shot["объект"] == "лицо"
    assert "план КРУПНЫЙ, ракурс фронт" in shot["промт_картинки"]


def test_reply_card_has_no_pair_fields() -> None:
    speech = _dialog_speech()
    reply = _card(
        2,
        точность="старт/конец",
        старт="отвернулся",
        конец="повернулся",
        причина="повернулся",
        говорит="c01",
        реплика="Начинаем.",
        кто="Иван (c01), Пётр (c05)",
        объект="двое",
    )
    cards = _normalize([_card(1), reply], speech)
    for field in ("старт", "конец", "точность", "причина", "промт_старт", "промт_конец"):
        assert field not in cards[1], field


def test_counter_shot_pair_is_not_reported_as_same_plan() -> None:
    first = _card(
        1,
        кто="Иван (c01), Пётр (c05)",
        где="Иван (c01) слева, Пётр (c05) справа",
        говорит="c01",
        реплика="Начинаем.",
        объект="двое",
        план="СРЕДНЕ-КРУПНЫЙ",
        ракурс="с плеча",
    )
    second = _card(
        2,
        кто="Иван (c01), Пётр (c05)",
        где="Иван (c01) слева, Пётр (c05) справа",
        говорит="c05",
        реплика="Ждём приказ.",
        объект="двое",
        план="СРЕДНЕ-КРУПНЫЙ",
        ракурс="с плеча",
    )
    assert nodes._reply_pair_shot_ids([first, second]) == {"S1-K1", "S1-K2"}
    assert nodes._reply_pair_shot_ids([first, _card(2)]) == set()
    problems = nodes._shot_mechanics([first, second], vo_mode=False, scene=_scene())
    assert not any(item.startswith("R-PLAN-SAME") for item in problems)


# --- Реестр персонажей во входе «Шотов» -------------------------------------


def test_vo_prompt_asks_for_character_registry() -> None:
    text = (PROMPTS / "scenes_to_frames_plan_vo.md").read_text(encoding="utf-8")
    assert "{{РЕЕСТР}}" in text
    assert "РЕЕСТР" in nodes.VO_PLACEHOLDER_ALIASES
    assert "имя, внешность и одежда" in text


def test_registry_is_substituted_once_then_referenced() -> None:
    rendered = nodes._render_vo("A {{РЕЕСТР}} B {{РЕЕСТР}}", РЕЕСТР="[{R}]")
    assert rendered == "A [{R}] B ‹реестр персонажей выше›"


def test_anonymous_character_in_shot_is_a_problem() -> None:
    problems = nodes._shot_contract_problems([_card(1, кто="Персонаж c01")])
    assert any("без имени" in item for item in problems)


def test_named_character_in_shot_passes_registry_check() -> None:
    problems = nodes._shot_contract_problems([_card(1)])
    assert not any("без имени" in item for item in problems)
    assert not any("нет пары «имя (код)»" in item for item in problems)

