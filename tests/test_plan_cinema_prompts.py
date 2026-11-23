"""Нода «Промты картинок» (``pk_prompts``): детерминированная часть.

Проверяем то, что не требует модели и денег:

* панели листа фона: кадры 1–4 фона → панели 1–4, кадры 5+ → панель по логике
  первых четырёх (тот же ракурс, при равенстве — ближайшая крупность);
* карта панелей уходит модели готовой (``{{панели_фона}}``), а не считается ею;
* сборка карточки: номер панели берётся из карты кода, блок «Референсы»
  вставляется дословно и не срезается обрезкой, стиль стоит последним блоком,
  тело промта ≤ 4000, стиль ≤ 700.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.services.plan_cinema import nodes


def _scene(number: int, shots: list[dict]) -> SimpleNamespace:
    return SimpleNamespace(
        uuid=f"uuid-{number}",
        number=number,
        attrs={"кадры": shots},
        image_prompt=None,
    )


def _shot(shot_id: str, code: str, ракурс: str, план: str = "СРЕДНИЙ") -> dict:
    return {"id": shot_id, "фон_код": code, "ракурс": ракурс, "план": план}


def test_panels_first_four_follow_shot_order():
    scenes = [
        _scene(
            1,
            [
                _shot("S1-K1", "f01", "фронт"),
                _shot("S1-K2", "f01", "3/4"),
                _shot("S1-K3", "f01", "сверху"),
                _shot("S1-K4", "f01", "3/4"),
            ],
        )
    ]
    frames_by_bg, shot_panel = nodes._shot_panels(scenes, {s.uuid: s.attrs["кадры"] for s in scenes})
    assert list(frames_by_bg) == ["f01"]
    assert [p["id"] for p in frames_by_bg["f01"]] == ["S1-K1", "S1-K2", "S1-K3", "S1-K4"]
    assert shot_panel == {"S1-K1": 1, "S1-K2": 2, "S1-K3": 3, "S1-K4": 4}


def test_panels_from_fifth_shot_follow_first_four():
    scenes = [
        _scene(
            2,
            [
                _shot("S2-K1", "f02", "фронт", "ОБЩИЙ"),
                _shot("S2-K2", "f02", "3/4", "СРЕДНЕ-КРУПНЫЙ"),
                _shot("S2-K3", "f02", "сверху", "КРУПНЫЙ"),
                _shot("S2-K4", "f02", "3/4", "СРЕДНЕ-КРУПНЫЙ"),
                _shot("S2-K5", "f02", "фронт", "КРУПНЫЙ"),
                _shot("S2-K6", "f02", "3/4", "СРЕДНИЙ"),
            ],
        )
    ]
    _, shot_panel = nodes._shot_panels(scenes, {s.uuid: s.attrs["кадры"] for s in scenes})
    assert shot_panel["S2-K5"] == 1, "кадр 5 фронт → панель 1"
    assert shot_panel["S2-K6"] == 2, "кадр 6 3/4 → панель 2"
    # В лист попадают только первые четыре кадра фона.
    assert [sid for sid, panel in shot_panel.items() if panel == 4] == ["S2-K4"]


def test_panels_unknown_angle_falls_back_to_nearest():
    scenes = [
        _scene(
            3,
            [
                _shot("S3-K1", "f03", "фронт"),
                _shot("S3-K2", "f03", "3/4"),
                _shot("S3-K3", "f03", "снизу"),
                _shot("S3-K4", "f03", "с плеча"),
                _shot("S3-K5", "f03", "макро"),
                _shot("S3-K6", "f03", "профиль"),
            ],
        )
    ]
    _, shot_panel = nodes._shot_panels(scenes, {s.uuid: s.attrs["кадры"] for s in scenes})
    assert shot_panel["S3-K5"] == 2, "макро ближе к 3/4"
    assert shot_panel["S3-K6"] == 2, "профиль ближе к 3/4"
    assert set(shot_panel) == {f"S3-K{i}" for i in range(1, 7)}


def test_panels_payload_carries_map_and_places():
    scenes = [
        _scene(
            4,
            [
                _shot("S4-K1", "f04", "фронт"),
                _shot("S4-K2", "f04", "3/4"),
                _shot("S4-K3", "f04", "макро"),
                _shot("S4-K4", "f04", "3/4"),
                _shot("S4-K5", "f04", "макро"),
            ],
        )
    ]
    frames_by_bg, shot_panel = nodes._shot_panels(scenes, {s.uuid: s.attrs["кадры"] for s in scenes})
    payload = nodes._panels_payload(frames_by_bg, shot_panel)
    assert payload["фоны"]["f04"] == {
        "1": "S4-K1",
        "2": "S4-K2",
        "3": "S4-K3",
        "4": "S4-K4",
    }
    assert payload["кадры"]["S4-K5"] == 3
    assert payload["места"]["1"] == "верхний левый"
    assert payload["места"]["4"] == "нижний правый"


def _style() -> str:
    return "**Style: test** " + "x" * 200


def test_merge_sets_panel_from_code_and_keeps_style_last():
    kadry = [{"id": "S5-K1"}, {"id": "S5-K2"}]
    cards = [
        {"id": "S5-K1", "промт_картинки": "Линза 35 мм. План ОБЩИЙ."},
        {"id": "S5-K2", "промт_картинки": "Линза 35 мм. План КРУПНЫЙ."},
    ]
    shot_panel = {"S5-K1": 1, "S5-K2": 3, "S5-K9": 4}
    merged, trimmed, defects = nodes._prompts_cards_merge(
        kadry, cards, shot_panel, _style()
    )
    assert defects == [] and trimmed == 0
    assert [row["панель_фона"] for row in merged] == [1, 3]
    for row, panel in zip(merged, (1, 3), strict=True):
        text = row["промт_картинки"]
        assert nodes._ref_block(panel) in text
        assert text.endswith(nodes._style_tail_split(_style(), _style())[1])
        assert "панель" in text


def test_merge_does_not_cut_reference_block():
    long_body = "Линза 35 мм. " + "Тело промта кадра. " * 400
    kadry = [{"id": "S6-K1"}]
    cards = [{"id": "S6-K1", "промт_картинки": long_body}]
    merged, trimmed, defects = nodes._prompts_cards_merge(
        kadry, cards, {"S6-K1": 2}, _style()
    )
    text = merged[0]["промт_картинки"]
    assert defects == [] and trimmed == 1
    assert nodes._ref_block(2) in text, "блок референсов не режется"
    assert text.endswith(_style())
    body = text[: -len(_style())].strip()
    assert len(body) <= nodes._CADR_BODY_MAX


def test_problems_reject_lost_and_empty_cards():
    kadry = [{"id": "S7-K1"}, {"id": "S7-K2"}]
    assert nodes._prompts_cards_problems(kadry, [{"id": "S7-K1"}]) == ["кадров 1 вместо 2"]
    assert nodes._prompts_cards_problems(kadry, None) == ["поле «кадры» — не список"]
    problems = nodes._prompts_cards_problems(
        kadry, [{"id": "S7-K1", "промт_картинки": ""}, {"id": "S7-X", "промт_картинки": "ок"}]
    )
    assert any("пустой промт" in item for item in problems)
    assert any("id изменился" in item for item in problems)


def test_node_spec_registered_after_fix():
    kinds = [spec.kind for spec in nodes.plan_cinema_node_specs()]
    assert kinds[-1] == "prompts"
    spec = nodes.plan_cinema_node_spec("n_excel_gpt_pk_prompts")
    assert spec is not None
    assert spec.label == "Промты картинок"
    assert spec.prompt_variant == "image_prompts_plan_ru"
    assert spec.uses_model is True
    assert nodes.is_plan_cinema_node("pk_prompts") is True
