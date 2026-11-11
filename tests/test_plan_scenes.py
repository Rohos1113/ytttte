"""Резка плана на сцены и гейт R-PLAN-COVER (CONTRACT.md, раздел 4)."""

from __future__ import annotations

import json

import pytest

from app.services.plan_scenes import (
    MAX_SCENES,
    PlanScenesError,
    check_plan_coverage,
    format_plan_points,
    num_plan_points,
    parse_scenes_reply,
)

NUMBERED_PLAN = """План ролика:
1. Иван выносит коробки во двор.
2. Сосед замечает коробки и идёт к нему.
3. Они ссорятся у мусорных контейнеров.
"""

PARAGRAPH_PLAN = """
Иван выносит коробки во двор, вечер, мокрая брусчатка.

Сосед замечает коробки и идёт к нему через двор.

Они ссорятся у мусорных контейнеров.
"""


def _scene(number: int, refs: list[str] | None = None, **extra) -> dict:
    scene = {
        "номер": number,
        "id_плана": refs if refs is not None else [f"P{number}"],
        "место": "двор",
        "событие": "событие",
    }
    scene.update(extra)
    return scene


# --- разметка плана --------------------------------------------------------


def test_numbered_plan_points():
    points = num_plan_points(NUMBERED_PLAN)
    assert [code for code, _ in points] == ["P1", "P2", "P3"]
    assert points[0][1] == "Иван выносит коробки во двор."
    assert points[2][1] == "Они ссорятся у мусорных контейнеров."


def test_numbered_plan_keeps_continuation_lines():
    plan = "1. Первый пункт,\n   который продолжается тут.\n2. Второй пункт."
    points = num_plan_points(plan)
    assert points[0] == ("P1", "Первый пункт, который продолжается тут.")
    assert points[1] == ("P2", "Второй пункт.")


def test_numbered_plan_paren_style():
    points = num_plan_points("1) Первый.\n2) Второй.\n3) Третий.")
    assert [text for _, text in points] == ["Первый.", "Второй.", "Третий."]


def test_paragraph_plan_points():
    points = num_plan_points(PARAGRAPH_PLAN)
    assert [code for code, _ in points] == ["P1", "P2", "P3"]
    assert points[1][1] == "Сосед замечает коробки и идёт к нему через двор."


def test_paragraph_plan_drops_heading():
    points = num_plan_points("План ролика:\n\nПервый абзац.\n\nВторой абзац.")
    assert [text for _, text in points] == ["Первый абзац.", "Второй абзац."]


def test_empty_plan():
    assert num_plan_points("") == []
    assert num_plan_points("   \n\n  ") == []


def test_format_plan_points():
    points = num_plan_points(NUMBERED_PLAN)
    lines = format_plan_points(points).splitlines()
    assert lines[1] == "P2: Сосед замечает коробки и идёт к нему."


# --- парсинг ответа модели -------------------------------------------------


def test_parse_clean_json():
    raw = json.dumps({"сцены": [_scene(1, ["P1"]), _scene(2, ["P2", "P3"])]}, ensure_ascii=False)
    scenes = parse_scenes_reply(raw)
    assert len(scenes) == 2
    assert scenes[1]["id_плана"] == ["P2", "P3"]
    assert scenes[0]["место"] == "двор"
    assert set(scenes[0]) == {"номер", "id_плана", "место", "событие", "примечание"}


def test_parse_markdown_fence():
    raw = (
        "Готово, вот сцены:\n```json\n"
        + json.dumps({"сцены": [_scene(1, ["P1"])]}, ensure_ascii=False)
        + "\n```\nЧто-то ещё?"
    )
    scenes = parse_scenes_reply(raw)
    assert scenes == [
        {"номер": 1, "id_плана": ["P1"], "место": "двор", "событие": "событие", "примечание": ""}
    ]


def test_parse_json_without_fence_in_prose():
    raw = 'Вот ответ: {"сцены": [' + json.dumps(_scene(1, ["P1"]), ensure_ascii=False) + "]}"
    assert parse_scenes_reply(raw)[0]["id_плана"] == ["P1"]


def test_parse_normalizes_refs():
    raw = json.dumps({"сцены": [_scene(1, [" p1 ", "P2,"])]}, ensure_ascii=False)
    assert parse_scenes_reply(raw)[0]["id_плана"] == ["P1", "P2"]


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "не json вовсе",
        json.dumps({"сцены": "нет"}, ensure_ascii=False),
        json.dumps({"scene": []}, ensure_ascii=False),
        json.dumps({"сцены": [{"id_плана": ["P1"]}]}, ensure_ascii=False),
        json.dumps({"сцены": [{"номер": 1}]}, ensure_ascii=False),
        json.dumps({"сцены": [{"номер": 1, "id_плана": "P1"}]}, ensure_ascii=False),
        json.dumps({"сцены": [{"номер": "первая", "id_плана": ["P1"]}]}, ensure_ascii=False),
        json.dumps({"сцены": [{"номер": 0, "id_плана": ["P1"]}]}, ensure_ascii=False),
    ],
)
def test_parse_rejects_broken_reply(raw):
    with pytest.raises(PlanScenesError):
        parse_scenes_reply(raw)


def test_parse_number_as_string():
    raw = json.dumps({"сцены": [{"номер": "2", "id_плана": ["P1"]}]}, ensure_ascii=False)
    assert parse_scenes_reply(raw)[0]["номер"] == 2


# --- гейт R-PLAN-COVER -----------------------------------------------------


def _points(n: int) -> list[tuple[str, str]]:
    return [(f"P{i}", f"пункт {i}") for i in range(1, n + 1)]


def test_coverage_passed():
    verdict = check_plan_coverage(_points(3), [_scene(1, ["P1"]), _scene(2, ["P2", "P3"])])
    assert verdict == {
        "passed": True,
        "uncovered": [],
        "unknown": [],
        "errors": [],
        "scenes": 2,
    }


def test_coverage_uncovered_point():
    verdict = check_plan_coverage(_points(3), [_scene(1, ["P1"]), _scene(2, ["P2"])])
    assert verdict["passed"] is False
    assert verdict["uncovered"] == ["P3"]


def test_coverage_scene_without_refs_is_error():
    verdict = check_plan_coverage(_points(2), [_scene(1, ["P1", "P2"]), _scene(2, [])])
    assert verdict["passed"] is False
    assert any("нет ссылки на пункт плана" in err for err in verdict["errors"])


def test_coverage_scene_missing_refs_key_is_error():
    verdict = check_plan_coverage(_points(2), [{"номер": 1, "место": "двор"}, _scene(2, ["P1", "P2"])])
    assert verdict["passed"] is False
    assert any("id_плана" in err for err in verdict["errors"])


def test_coverage_decreasing_order():
    verdict = check_plan_coverage(_points(3), [_scene(1, ["P2"]), _scene(2, ["P1"]), _scene(3, ["P3"])])
    assert verdict["passed"] is False
    assert any("порядок ссылок убывает" in err for err in verdict["errors"])
    assert verdict["uncovered"] == []


def test_coverage_unknown_point():
    verdict = check_plan_coverage(_points(2), [_scene(1, ["P1", "P7"]), _scene(2, ["P2"])])
    assert verdict["passed"] is False
    assert verdict["unknown"] == ["P7"]


def test_coverage_too_many_scenes():
    scenes = [_scene(i, ["P1"]) for i in range(1, MAX_SCENES + 2)]
    verdict = check_plan_coverage(_points(1), scenes)
    assert verdict["passed"] is False
    assert any(str(MAX_SCENES) in err for err in verdict["errors"])


def test_coverage_exactly_max_scenes_ok():
    scenes = [_scene(i, ["P1"]) for i in range(1, MAX_SCENES + 1)]
    assert check_plan_coverage(_points(1), scenes)["passed"] is True


def test_coverage_no_scenes():
    verdict = check_plan_coverage(_points(2), [])
    assert verdict["passed"] is False
    assert verdict["uncovered"] == ["P1", "P2"]
    assert verdict["errors"]


def test_coverage_no_points():
    assert check_plan_coverage([], [_scene(1, ["P1"])])["passed"] is False


def test_coverage_end_to_end():
    points = num_plan_points(NUMBERED_PLAN)
    raw = (
        "```json\n"
        + json.dumps(
            {"сцены": [_scene(1, ["P1"]), _scene(2, ["P2"]), _scene(3, ["P3"])]},
            ensure_ascii=False,
        )
        + "\n```"
    )
    verdict = check_plan_coverage(points, parse_scenes_reply(raw))
    assert verdict["passed"] is True
    assert verdict["scenes"] == 3
