"""Нода «Фоны» читает ШОТЫ, а не места сцен (``plan_backgrounds.md``).

Проверяем чистую сборку входа и разбор ответа модели: кадры одной сцены с
одной локацией — один фон; вставка с другим местом — свой фон; продолжение
берёт прежний код, второй ``Entity`` не заводится; одиночное место карточки не
получает. Сети и БД нет: всё на фейках.
"""

from __future__ import annotations

import asyncio

from app.services.plan_cinema import nodes


def _scene(
    number: int,
    place: str,
    *,
    uuid: str | None = None,
    plan_refs: tuple[str, ...] = (),
) -> dict:
    return {
        "id": uuid or f"uuid-{number}",
        "номер": number,
        "место": place,
        "id_плана": list(plan_refs),
        "событие": "",
        "сцена": "",
        "персонажи": [],
        "предметы": [],
        "фон": "",
    }


def _kadr(index: int) -> dict:
    return {
        "id": f"1.{index}",
        "план": "ОБЩИЙ",
        "где": "у ворот",
        "место": "двор, вечер",
        "фон": "мокрая брусчатка, стопка коробок у стены",
        "действие": "Иван ставит коробку",
        "кто": "Иван (c01)",
    }


# --- вход: кадры всех сцен -------------------------------------------------


def test_input_keeps_frames_of_every_scene_and_its_location_key() -> None:
    scenes = [
        _scene(1, "двор, вечер"),
        _scene(2, "двор, вечер"),
        _scene(3, "кухня, вечер"),
    ]
    kadry_by_scene = {
        "uuid-1": [_kadr(1), _kadr(2)],
        "uuid-2": [_kadr(1)],
        "uuid-3": [_kadr(1)],
    }
    built = nodes._backgrounds_input(scenes, kadry_by_scene, {})
    assert [row["сцена"] for row in built["сцены"]] == [1, 2, 3]
    assert [row["кадров"] for row in built["сцены"]] == [2, 1, 1]
    assert built["frames_total"] == 4
    # одна локация — один ключ, другое место — другой
    assert built["keys"][1] == built["keys"][2]
    assert built["keys"][1] != built["keys"][3]
    # в кадре модели — только кадры, без служебных полей
    assert set(built["сцены"][0]["кадры"][0]) == {
        "план",
        "где",
        "кто_где",
        "место",
        "фон",
        "действие",
        "кто",
    }


def test_input_sends_full_text_without_cutting_tail() -> None:
    """Хвост описания не отрезается: «…» на конце — это потерянные данные."""
    long_text = "кадр с длинным описанием " * 40
    kadr = {**_kadr(1), "действие": long_text.strip(), "фон": long_text.strip()}
    built = nodes._backgrounds_input(
        [_scene(1, "двор, вечер")], {"uuid-1": [kadr]}, {}
    )
    frame = built["сцены"][0]["кадры"][0]
    assert frame["действие"] == " ".join(long_text.split())
    assert frame["фон"] == " ".join(long_text.split())
    assert not frame["действие"].endswith("…")


def test_input_uses_plan_heading_as_location() -> None:
    scenes = [_scene(1, "двор, вечер", plan_refs=("P1",))]
    plan = {"P1": "НАТ. ДВОР У СКЛАДА — ВЕЧЕР"}
    built = nodes._backgrounds_input(scenes, {}, plan)
    assert "двор у склада" in built["keys"][1]


# --- разбор ответа модели --------------------------------------------------


def test_frames_of_one_scene_get_one_code() -> None:
    assigned = nodes._assign_backgrounds(
        [{"id": "f01", "место": "двор", "сцены": [1], "описание": "двор", "промт": "yard"}],
        scene_keys={1: "двор"},
        scene_frames={1: 3},
    )
    assert assigned["problems"] == []
    assert [card["id"] for card in assigned["cards"]] == ["f01"]
    assert assigned["code_by_scene"] == {1: "f01"}


def test_insert_scene_with_other_place_gets_own_code() -> None:
    assigned = nodes._assign_backgrounds(
        [
            {"id": "f01", "место": "двор", "сцены": [1, 3]},
            {"id": "f02", "место": "кухня", "сцены": [2]},
        ],
        scene_keys={1: "двор", 2: "кухня", 3: "двор"},
        scene_frames={1: 2, 2: 2, 3: 1},
    )
    assert assigned["problems"] == []
    assert assigned["code_by_scene"] == {1: "f01", 2: "f02", 3: "f01"}


def test_continuation_inherits_previous_code_without_second_card() -> None:
    # вставка (сцена 2) — одиночное место, карточки нет; продолжение (сцена 3)
    # возвращается в прежний двор и получает прежний код, а не новый фон.
    assigned = nodes._assign_backgrounds(
        [{"id": "f01", "место": "двор", "сцены": [1]}],
        scene_keys={1: "двор", 2: "кухня", 3: "двор"},
        scene_frames={1: 2, 2: 1, 3: 1},
    )
    assert assigned["problems"] == []
    assert assigned["code_by_scene"] == {1: "f01", 3: "f01"}
    assert 2 not in assigned["code_by_scene"]


def test_single_frame_location_card_is_dropped() -> None:
    assigned = nodes._assign_backgrounds(
        [{"id": "f01", "место": "кухня", "сцены": [1]}],
        scene_keys={1: "кухня"},
        scene_frames={1: 1},
    )
    assert assigned["cards"] == []
    assert assigned["code_by_scene"] == {}
    assert assigned["problems"] == []
    assert assigned["dropped"] and "одиночное место" in assigned["dropped"][0]


def test_empty_answer_is_ok_when_every_location_is_single() -> None:
    assigned = nodes._assign_backgrounds(
        [],
        scene_keys={1: "двор", 2: "кухня"},
        scene_frames={1: 1, 2: 1},
    )
    assert assigned["problems"] == []
    assert assigned["cards"] == []


def test_repeated_location_without_card_is_a_problem() -> None:
    assigned = nodes._assign_backgrounds(
        [],
        scene_keys={1: "двор", 2: "двор"},
        scene_frames={1: 1, 2: 1},
    )
    assert any("но фона нет" in problem for problem in assigned["problems"])


def test_two_cards_for_one_location_are_merged_into_one() -> None:
    # Модель иногда дробит одно место на две карточки. Шаг не падает: вторая
    # карточка склеивается в первую, её сцены переходят на первый код.
    assigned = nodes._assign_backgrounds(
        [
            {"id": "f01", "место": "двор", "сцены": [1]},
            {"id": "f02", "место": "двор", "сцены": [2]},
        ],
        scene_keys={1: "двор", 2: "двор"},
        scene_frames={1: 2, 2: 2},
    )
    assert assigned["problems"] == []
    assert assigned["warnings"]
    assert [card["id"] for card in assigned["cards"]] == ["f01"]
    assert assigned["cards"][0]["сцены"] == [1, 2]
    assert assigned["code_by_scene"] == {1: "f01", 2: "f01"}


def test_card_mixing_two_places_is_only_a_warning() -> None:
    # ключ локации — эвристика по тексту: «тот же двор» и «двор» дают разные
    # ключи, но модель вправе объединить кадры в один фон. Это не отказ шага.
    assigned = nodes._assign_backgrounds(
        [{"id": "f01", "место": "двор", "сцены": [1, 2]}],
        scene_keys={1: "двор", 2: "кухня"},
        scene_frames={1: 2, 2: 2},
    )
    assert assigned["problems"] == []
    assert assigned["warnings"]
    assert assigned["code_by_scene"] == {1: "f01", 2: "f01"}


def test_scene_in_two_cards_is_a_problem() -> None:
    assigned = nodes._assign_backgrounds(
        [
            {"id": "f01", "место": "двор", "сцены": [1]},
            {"id": "f02", "место": "кухня", "сцены": [1]},
        ],
        scene_keys={1: "двор"},
        scene_frames={1: 2},
    )
    assert any("в двух фонах" in problem for problem in assigned["problems"])


def test_unknown_scene_and_bad_code_are_problems() -> None:
    assigned = nodes._assign_backgrounds(
        [
            {"id": "M1", "место": "двор", "сцены": [1]},
            {"id": "f02", "место": "кухня", "сцены": [7]},
        ],
        scene_keys={1: "двор"},
        scene_frames={1: 2},
    )
    assert any("не по формату f0N" in problem for problem in assigned["problems"])
    assert any("нет во входе" in problem for problem in assigned["problems"])


# --- кадры: код фона берётся из сцены, а не из ответа модели --------------


def test_placeholder_background_has_place_but_no_code() -> None:
    background = nodes._background_placeholder(_scene(1, "двор, вечер"))
    assert background["id"] == ""
    assert background["место"] == "двор, вечер"
    assert background["нет_карточки"] is True


def test_kadr_code_comes_from_scene_and_can_be_empty() -> None:
    scene = {**_scene(1, "двор, вечер"), "фон": "f03"}
    kadry = nodes._normalize_kadry(
        [{"id": "1.1", "промт_картинки": "двор", "фон_код": "f99"}],
        {"тип": "нет", "реплики": []},
        scene,
    )
    assert kadry[0]["фон_код"] == "f03"
    single = nodes._normalize_kadry(
        [{"id": "1.1", "промт_картинки": "кухня", "фон_код": "f03"}],
        {"тип": "нет", "реплики": []},
        {**_scene(1, "кухня, вечер"), "фон": ""},
    )
    assert single[0]["фон_код"] == ""


# --- нода целиком: пишет коды сцене и кадру --------------------------------


class _FakeFrame:
    def __init__(self, uuid: str, number: int, attrs: dict) -> None:
        self.uuid = uuid
        self.number = number
        self.attrs = attrs


class _FakeApply:
    def __init__(self, frames: list[_FakeFrame], backgrounds: list[dict]) -> None:
        self.frames = frames
        self.backgrounds = backgrounds
        self.entities: list[dict] = []
        self.ops: list[dict] = []
        self.scene_attrs: list[tuple[str, dict]] = []
        self.artifact: dict | None = None

    async def load_scenes(self, _session, _project):
        return self.frames

    async def load_backgrounds(self, _session, _project):
        return self.backgrounds

    def read_artifact(self, _project, _node_key, _name):
        return self.artifact

    async def write_entities(self, _session, _project, *, backgrounds):
        self.entities = list(backgrounds)

    async def apply_plan_ops(self, _session, _project, ops):
        self.ops = list(ops)
        for op in ops:
            for frame in self.frames:
                if frame.uuid == op["frame_uuid"]:
                    frame.attrs["фон"] = op["fields"]["фон"]

    async def write_scene_attrs(self, _session, project, frame_uuid, attrs):
        self.scene_attrs.append((frame_uuid, attrs))
        for frame in self.frames:
            if frame.uuid == frame_uuid:
                frame.attrs.update(attrs)


def _fake_project():
    class _Project:
        id = 7

    return _Project()


def _run_node(
    monkeypatch, frames: list[_FakeFrame], cards: list[dict], artifact: dict | None = None
) -> _FakeApply:
    backgrounds: list[dict] = []
    fake_apply = _FakeApply(frames, backgrounds)
    fake_apply.artifact = artifact
    monkeypatch.setattr(nodes, "_apply", lambda: fake_apply)
    monkeypatch.setattr(nodes, "_read_master", lambda *_a, **_k: "{{КАДРЫ}}")
    monkeypatch.setattr(
        nodes, "_render", lambda master, **context: f"{master}\n{context['КАДРЫ']}"
    )
    monkeypatch.setattr(nodes, "_split", lambda: type("S", (), {"num_plan_points": staticmethod(lambda _t: {})}))
    monkeypatch.setattr(
        nodes, "_source", lambda: type("S", (), {"read_plan_text": staticmethod(lambda _p: "")})
    )

    async def _ask_json(_project, _node_key, _prompt, _accompanying):
        return {"фоны": cards}

    monkeypatch.setattr(nodes, "_ask_json", _ask_json)

    async def _render_missing(_session, _project, *, only=None):
        return (0, 0)

    from app.services.plan_cinema import backgrounds_render

    monkeypatch.setattr(backgrounds_render, "render_missing", _render_missing)
    return fake_apply


def test_node_writes_code_to_scenes_and_frames(monkeypatch) -> None:
    frames = [
        _FakeFrame("uuid-1", 1, {"место": "двор, вечер", "кадры": [_kadr(1), _kadr(2)]}),
        _FakeFrame("uuid-2", 2, {"место": "двор, вечер", "кадры": [_kadr(1)]}),
        _FakeFrame("uuid-3", 3, {"место": "кухня, вечер", "кадры": [_kadr(1)]}),
    ]
    cards = [
        {"id": "f01", "место": "двор", "сцены": [1, 2], "описание": "двор", "промт": "yard"},
    ]
    fake_apply = _run_node(monkeypatch, frames, cards)
    fake_apply.entities = cards
    fake_apply.backgrounds = [{"code": "f01"}]

    async def _load_backgrounds(_session, _project):
        return fake_apply.backgrounds

    fake_apply.load_backgrounds = _load_backgrounds  # type: ignore[method-assign]
    result = asyncio.run(
        nodes._run_backgrounds(None, _fake_project(), node_key="n_excel_gpt_pk_backgrounds")
    )
    assert [card["id"] for card in fake_apply.entities] == ["f01"]
    codes = {op["frame_uuid"]: op["fields"]["фон"] for op in fake_apply.ops}
    assert codes == {"uuid-1": "f01", "uuid-2": "f01", "uuid-3": ""}
    assert all(row["фон_код"] == "f01" for row in frames[0].attrs["кадры"])
    assert all(row["фон_код"] == "" for row in frames[2].attrs["кадры"])
    assert "фонов 1" in result.reply_text
    assert "сцен без карточки 1" in result.reply_text
    assert "R-BG-REF pass" in result.reply_text


def test_node_takes_frames_from_shots_artifact_when_db_is_empty(monkeypatch) -> None:
    frames = [
        _FakeFrame("uuid-1", 1, {"место": "двор, вечер"}),
        _FakeFrame("uuid-2", 2, {"место": "двор, вечер"}),
    ]
    artifact = {
        "ops": [
            {"frame_uuid": "uuid-1", "fields": {"кадры": [_kadr(1), _kadr(2)]}},
            {"frame_uuid": "uuid-2", "fields": {"кадры": [_kadr(1)]}},
        ]
    }
    cards = [{"id": "f01", "место": "двор", "сцены": [1, 2]}]
    fake_apply = _run_node(monkeypatch, frames, cards, artifact=artifact)
    fake_apply.backgrounds = [{"code": "f01"}]
    result = asyncio.run(
        nodes._run_backgrounds(None, _fake_project(), node_key="n_excel_gpt_pk_backgrounds")
    )
    assert "кадров 3" in result.reply_text
    codes = {op["frame_uuid"]: op["fields"]["фон"] for op in fake_apply.ops}
    assert codes == {"uuid-1": "f01", "uuid-2": "f01"}


def test_node_refuses_to_run_without_frames(monkeypatch) -> None:
    frames = [_FakeFrame("uuid-1", 1, {"место": "двор"})]
    fake_apply = _FakeApply(frames, [])
    monkeypatch.setattr(nodes, "_apply", lambda: fake_apply)
    try:
        asyncio.run(
            nodes._run_backgrounds(None, _fake_project(), node_key="n_excel_gpt_pk_backgrounds")
        )
    except RuntimeError as exc:
        assert "сначала «Шоты»" in str(exc)
    else:  # pragma: no cover - защита от молчаливого прохода
        raise AssertionError("без кадров шаг обязан падать")
