"""Гейты режима «без закадра» из ``app.services.plan_cinema.gates``.

CONTRACT.md §5 группы ``plan_cinema``: VO-гейты (R-VO-*, ``SHOT_VO_MIN/MAX``,
``VO_SCENE_MAX``, ``vo_cut_problems``, ``reflow_vo_by_sentences``) в этом
режиме не применяются. Правила кадров остаются: канон плана/ракурса, 30°,
родитель, реестр, потолок кадров, дубли действия.

Старые модули в этих тестах не меняются — они вызываются как есть, чтобы
зафиксировать: поведение с закадром не тронуто.
"""

from __future__ import annotations

from app.services.plan_cinema.gates import (
    VO_CODES,
    background_ref_problems,
    cast_duplicate_problems,
    check_plan_coverage,
    dialog_problems,
    shots_dialogue_problems_plan,
    shots_gate_problems,
)

#: Кадр новой цепочки: полей ``закадр``/``voiceover_text`` нет (CONTRACT §3).
CLEAN_SHOT = {
    "id": "1-S1-K1",
    "сцена": "S1",
    "шаблон": "T4",
    "план": "ОБЩИЙ",
    "ракурс": "3/4",
    "высота": "уровень глаз",
    "объект": "место",
    "действие": "Иван открывает дверь и заходит в сени",
    "точность": "одна картинка",
    "промт_картинки": "тело промта без стиля",
}


def _shot(index: int = 1, **over) -> dict:
    data = dict(CLEAN_SHOT)
    data["id"] = f"1-S1-K{index}"
    data["действие"] = f"шаг {index}: персонаж двигается по площадке"
    data.update(over)
    return data


def _codes(problems: list[str]) -> set[str]:
    return {problem.split(" ", 1)[0] for problem in problems}


# --- Механика кадров без VO ----------------------------------------------


def test_shot_without_vo_passes_when_vo_mode_off() -> None:
    assert shots_gate_problems([CLEAN_SHOT], vo_mode=False) == []


def test_vo_rules_do_not_fire_without_scene_vo() -> None:
    """Сцена без VO и кадры без закадра: ни одного R-VO-* кода."""
    problems = shots_gate_problems(
        [_shot(1), _shot(2, план="СРЕДНИЙ", объект="тело")],
        vo_mode=False,
    )
    assert not (_codes(problems) & VO_CODES)


def test_non_vo_rules_still_work() -> None:
    """30° и канон плана ловятся и без закадра."""
    problems = shots_gate_problems(
        [_shot(1), _shot(2, план="СРЕДНИЙ", объект="тело")],
        vo_mode=False,
    )
    assert "R-CUT-ADJ" in _codes(problems)

    bad = shots_gate_problems([{"id": "1-S1-K1", "сцена": "S1", "план": "СРЕДНЕ-ОБЩИЙ"}])
    bad_codes = _codes(bad)
    assert "R-ENUM-PLAN" in bad_codes
    assert "R-FIELD-MISSING" in bad_codes


def test_vo_codes_filtered_even_with_legacy_vo_scene() -> None:
    """В режиме без закадра сцена с VO не включает VO-правила."""
    problems = shots_gate_problems(
        [_shot(1)],
        vo_mode=False,
        scenes=[{"id": "S1", "vo": "я" * 500}],
    )
    assert not (_codes(problems) & VO_CODES)


# --- R-PLAN-COVER ---------------------------------------------------------


def test_plan_coverage_passes() -> None:
    result = check_plan_coverage(
        ["P1", "P2"],
        [
            {"номер": 1, "id_плана": ["P1"]},
            {"номер": 2, "id_плана": ["P2"]},
        ],
    )
    assert result["passed"] is True
    assert result["scenes"] == 2


def test_plan_coverage_flags_uncovered_point() -> None:
    result = check_plan_coverage(["P1", "P2"], [{"номер": 1, "id_плана": ["P1"]}])
    assert result["passed"] is False
    assert result["uncovered"] == ["P2"]


# --- R-CAST-DUP -----------------------------------------------------------


def test_cast_duplicate_caught_after_normalization() -> None:
    problems = cast_duplicate_problems(
        [
            {"code": "c01", "имя": "Иван Петров"},
            {"code": "c02", "имя": "иван   петров"},
        ]
    )
    assert problems
    assert "c01" in problems[0] and "c02" in problems[0]


def test_cast_unique_names_pass() -> None:
    assert (
        cast_duplicate_problems(
            [{"code": "c01", "имя": "Иван"}, {"code": "c02", "имя": "Сосед"}]
        )
        == []
    )


# --- R-DLG-FORM + R-DLG-SPEAKER ------------------------------------------


def _dialog() -> dict:
    return {
        "тип": "диалог",
        "реплики": [
            {"кто": "c01", "текст": "Опять коробки?"},
            {"кто": "c02", "текст": "Да, опять."},
        ],
    }


def test_dialog_form_ok() -> None:
    assert dialog_problems(_dialog(), ["c01", "c02"], ["c01", "c02"]) == []


def test_monologue_with_two_replicas_caught() -> None:
    speech = {"тип": "монолог", "реплики": _dialog()["реплики"]}
    problems = dialog_problems(speech, ["c01", "c02"], ["c01", "c02"])
    assert any("монолог" in problem for problem in problems)


def test_dialog_single_speaker_caught() -> None:
    speech = {
        "тип": "диалог",
        "реплики": [
            {"кто": "c01", "текст": "Опять коробки?"},
            {"кто": "c01", "текст": "И снова."},
        ],
    }
    problems = dialog_problems(speech, ["c01"], ["c01"])
    assert any("двух разных" in problem for problem in problems)


def test_speaker_not_in_scene_caught() -> None:
    problems = dialog_problems(_dialog(), ["c01"], ["c01", "c02"])
    assert any("нет в персонажах сцены" in problem for problem in problems)


def test_speaker_not_in_registry_caught() -> None:
    problems = dialog_problems(_dialog(), ["c01", "c02"], ["c01"])
    assert any("нет в реестре" in problem for problem in problems)


# --- R-BG-REF -------------------------------------------------------------


def test_background_ref_ok() -> None:
    scenes = [{"номер": 1, "фон": "f01"}, {"номер": 2, "фон": "f01"}]
    assert background_ref_problems(scenes, ["f01"]) == []


def test_background_missing_and_foreign_caught() -> None:
    scenes = [
        {"номер": 1, "фон": ""},
        {"номер": 2, "фон": "f09"},
        {"номер": 3, "фон": "нормальный двор"},
    ]
    problems = background_ref_problems(scenes, ["f01"])
    # Пустой фон легален: одиночное место карточку не заводит («Фоны» из кадров).
    assert not any("сцена 1" in problem for problem in problems)
    assert any("f09 не существует" in problem for problem in problems)
    assert any("не код f0N" in problem for problem in problems)


def test_background_empty_allowed_without_registry() -> None:
    scenes = [{"номер": 1, "фон": ""}, {"номер": 2, "фон": ""}]
    assert background_ref_problems(scenes, []) == []


# --- R-DLG-SHOT -----------------------------------------------------------


def test_shots_dialogue_ok() -> None:
    shots = [
        _shot(1),  # установочный ОБЩИЙ до реплик
        _shot(2, реплика="Опять коробки?", говорит="c01", план="КРУПНЫЙ", ракурс="с плеча"),
        _shot(3, реплика="Да, опять.", говорит="c02", план="КРУПНЫЙ", ракурс="с плеча"),
    ]
    assert shots_dialogue_problems_plan(shots, _dialog()) == []


def test_shots_dialogue_missing_replica_caught() -> None:
    shots = [
        _shot(1),
        _shot(2, реплика="Опять коробки?", говорит="c01", план="КРУПНЫЙ", ракурс="фронт"),
    ]
    problems = shots_dialogue_problems_plan(shots, _dialog())
    assert any("кадров с репликой" in problem for problem in problems)
