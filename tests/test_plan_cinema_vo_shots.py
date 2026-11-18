"""Механика VO для ноды «Шоты»: чистые unit-тесты ``vo_shots``.

Ни БД, ни сети: проверяем нормализацию, деление закадра по сценам и кадрам,
детерминированную раскладку и правило 13.5 знака в секунду.
"""

from __future__ import annotations

import pytest

from app.services.plan_cinema import vo_shots

VO = "Первая сцена начинается здесь. Вторая сцена продолжает рассказ."

CHUNKS = [
    {"номер": 1, "закадр": "Первая сцена начинается здесь."},
    {"номер": 2, "закадр": "Вторая сцена продолжает рассказ."},
]


def _glued(chunks: list[dict]) -> str:
    return " ".join(str(chunk.get("закадр") or "") for chunk in chunks)


# ── Нормализация ────────────────────────────────────────────────────────────


def test_normalize_words_ignores_case_yo_quotes_dashes():
    text = "Ёжик — «в тумане»!  Кто-то: „да“ — и всё."
    assert vo_shots.normalize_words(text) == [
        "ежик",
        "в",
        "тумане",
        "кто",
        "то",
        "да",
        "и",
        "все",
    ]


def test_same_words_ignores_yo_quotes_and_dashes():
    assert vo_shots.same_words("Ёжик — «в тумане»!", "ежик в тумане")
    assert vo_shots.same_words("кот-пёс", "Кот пёс")


def test_same_words_sees_difference():
    assert not vo_shots.same_words("кот пёс", "кот пёс и лиса")
    assert not vo_shots.same_words("", "слово")


# ── Деление закадра по сценам ───────────────────────────────────────────────


def test_scene_chunks_exact_split_has_no_problems():
    assert vo_shots.scene_chunk_problems([1, 2], CHUNKS, VO) == []


def test_scene_chunks_lost_tail():
    chunks = [CHUNKS[0], {"номер": 2, "закадр": "Вторая сцена продолжает"}]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("потерян хвост" in problem for problem in problems), problems


def test_scene_chunks_duplicate_word():
    chunks = [CHUNKS[0], {"номер": 2, "закадр": "Вторая сцена продолжает продолжает рассказ."}]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("дубль" in problem for problem in problems), problems


def test_scene_chunks_reordered_scenes():
    chunks = [
        {"номер": 1, "закадр": CHUNKS[1]["закадр"]},
        {"номер": 2, "закадр": CHUNKS[0]["закадр"]},
    ]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("переставлены" in problem for problem in problems), problems


def test_scene_chunks_extra_text():
    chunks = [CHUNKS[0], {"номер": 2, "закадр": CHUNKS[1]["закадр"] + " И ещё немного текста."}]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("лишний текст" in problem for problem in problems), problems


def test_scene_chunks_empty_chunk():
    chunks = [CHUNKS[0], {"номер": 2, "закадр": "   "}]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("пустой закадр" in problem for problem in problems), problems
    assert any("потерян хвост" in problem for problem in problems), problems


def test_scene_chunks_missing_extra_and_duplicate_numbers():
    chunks = [{"номер": 1, "закадр": VO}, {"номер": 1, "закадр": ""}, {"номер": 3, "закадр": ""}]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("нет куска для сцены 2" in problem for problem in problems), problems
    assert any("повторяется" in problem for problem in problems), problems
    assert any("лишний" in problem for problem in problems), problems


def test_scene_chunks_order_violation():
    chunks = [
        {"номер": 2, "закадр": CHUNKS[1]["закадр"]},
        {"номер": 1, "закадр": CHUNKS[0]["закадр"]},
    ]
    problems = vo_shots.scene_chunk_problems([1, 2], chunks, VO)
    assert any("нарушен порядок сцен" in problem for problem in problems), problems


def test_scene_chunks_number_not_int():
    problems = vo_shots.scene_chunk_problems([1], [{"номер": "один", "закадр": "текст"}], "текст")
    assert any("нет целого «номер»" in problem for problem in problems), problems


# ── Раскладка по кадрам сцены ───────────────────────────────────────────────


def test_shots_partition_exact():
    scene_vo = "Первая сцена начинается здесь."
    kadry = [
        {"id": "1.1", "закадр": "Первая сцена"},
        {"id": "1.2", "закадр": "начинается здесь."},
    ]
    assert vo_shots.shots_partition_problems(scene_vo, kadry) == []


def test_shots_partition_lost_tail():
    scene_vo = "Первая сцена начинается здесь."
    kadry = [{"id": "1.1", "закадр": "Первая сцена"}]
    problems = vo_shots.shots_partition_problems(scene_vo, kadry)
    assert any("потерян хвост" in problem for problem in problems), problems


def test_shots_partition_empty_frame():
    scene_vo = "Первая сцена начинается здесь."
    kadry = [{"id": "1.1", "закадр": "Первая сцена"}, {"id": "1.2", "закадр": ""}]
    problems = vo_shots.shots_partition_problems(scene_vo, kadry)
    assert any("кадр 1.2 без закадрового текста" in problem for problem in problems), problems


# ── Детерминированная раскладка ─────────────────────────────────────────────


def test_distribute_scene_vo_keeps_whole_text():
    text = "Первая фраза. Вторая фраза. Третья фраза."
    kadry = [{"id": "1.1", "порядок": 1}, {"id": "1.2", "порядок": 2}, {"id": "1.3", "порядок": 3}]
    distributed = vo_shots.distribute_scene_vo(text, kadry)
    assert [frame["id"] for frame in distributed] == ["1.1", "1.2", "1.3"]
    assert vo_shots.same_words(_glued(distributed), text)
    assert vo_shots.shots_partition_problems(text, distributed) == []


def test_distribute_scene_vo_does_not_mutate_input():
    kadry = [{"id": "1.1"}, {"id": "1.2"}]
    vo_shots.distribute_scene_vo("Первая фраза. Вторая фраза.", kadry)
    assert "закадр" not in kadry[0]
    assert kadry == [{"id": "1.1"}, {"id": "1.2"}]


def test_distribute_scene_vo_empty_tail_gets_empty_text():
    text = "Одна короткая фраза"
    kadry = [{"id": "1.1"}, {"id": "1.2"}, {"id": "1.3"}]
    distributed = vo_shots.distribute_scene_vo(text, kadry)
    assert [frame["закадр"] for frame in distributed] == ["Одна короткая фраза", "", ""]
    assert vo_shots.same_words(_glued(distributed), text)


def test_distribute_scene_vo_no_frames():
    assert vo_shots.distribute_scene_vo("Любой текст", []) == []


# ── Длительности и темп 13.5 ────────────────────────────────────────────────


def test_with_durations_tempo_and_exact_sum():
    kadry = [{"id": "1.1", "закадр": "а" * 135}, {"id": "1.2", "закадр": "б" * 108}]
    timed = vo_shots.with_durations(kadry)
    assert timed[0]["длительность"] == 10.0
    assert timed[0]["длительность"] == pytest.approx(135 / 13.5, abs=0.01)
    full_chars = len(" ".join(frame["закадр"] for frame in kadry))
    target = round(full_chars / 13.5, 2)
    assert round(sum(frame["длительность"] for frame in timed), 2) == target


def test_with_durations_three_frames_tempo():
    kadry = [{"закадр": "а" * 27}, {"закадр": "б" * 54}, {"закадр": "в" * 27}]
    timed = vo_shots.with_durations(kadry)
    assert timed[0]["длительность"] == 2.0
    assert timed[1]["длительность"] == 4.0
    full = " ".join(frame["закадр"] for frame in kadry)
    assert round(sum(frame["длительность"] for frame in timed), 2) == round(len(full) / 13.5, 2)


def test_with_durations_empty_chunk_minimum():
    timed = vo_shots.with_durations([{"закадр": "привет"}, {"закадр": ""}])
    assert timed[0]["длительность"] == 0.5
    assert timed[1]["длительность"] == 0.5


def test_with_durations_single_frame():
    timed = vo_shots.with_durations([{"закадр": "а" * 27}])
    assert timed[0]["длительность"] == 2.0


def test_with_durations_empty_list():
    assert vo_shots.with_durations([]) == []


# ── Сводка темпа ────────────────────────────────────────────────────────────


def test_vo_rate_summary_exact_chunks():
    summary = vo_shots.vo_rate_summary(VO, CHUNKS)
    chars = len(" ".join(VO.split()))
    assert summary == {
        "chars": chars,
        "seconds": round(chars / 13.5, 2),
        "rate": 13.5,
        "сцен": 2,
        "потерь": 0,
    }


def test_vo_rate_summary_counts_losses():
    chunks = [CHUNKS[0], {"номер": 2, "закадр": "Вторая сцена продолжает"}]
    summary = vo_shots.vo_rate_summary(VO, chunks)
    assert summary["потерь"] == len("рассказ")
    assert summary["сцен"] == 2


def test_vo_rate_summary_empty_vo():
    summary = vo_shots.vo_rate_summary("", [])
    assert summary["chars"] == 0
    assert summary["seconds"] == 0.0
    assert summary["rate"] == 13.5
    assert summary["сцен"] == 0
    assert summary["потерь"] == 0


# ── Ребро script-ноды → нода «Шоты» ─────────────────────────────────────────


class _FakeProject:
    def __init__(self, meta: dict | None, script_text: str = "") -> None:
        self.meta = meta
        self.script_text = script_text


def _graph(nodes: list[dict], edges: list[dict]) -> dict:
    return {"canvas_graph": {"nodes": nodes, "edges": edges}}


def _shots_graph() -> dict:
    return _graph(
        [
            {"id": "n_script_1794875142991", "type": "script"},
            {"id": "n_plan", "type": "plan"},
            {"id": "n_excel_gpt_pk_shots", "type": "excel_gpt"},
        ],
        [
            {"source": "n_plan", "target": "n_excel_gpt_pk_shots"},
            {"source": "n_script_1794875142991", "target": "n_excel_gpt_pk_shots"},
        ],
    )


def test_shots_node_vo_source_edge_from_script_node():
    project = _FakeProject(_shots_graph(), script_text="Первый абзац.\nВторой абзац.")
    source = vo_shots.shots_node_vo_source(project, "n_excel_gpt_pk_shots")
    assert source == vo_shots.VoSource(
        node_key="n_script_1794875142991",
        text="Первый абзац. Второй абзац.",
    )


def test_shots_node_vo_source_no_script_edge():
    meta = _graph(
        [
            {"id": "n_plan", "type": "plan"},
            {"id": "n_excel_gpt_pk_shots", "type": "excel_gpt"},
        ],
        [{"source": "n_plan", "target": "n_excel_gpt_pk_shots"}],
    )
    assert vo_shots.shots_node_vo_source(_FakeProject(meta, "текст"), "n_excel_gpt_pk_shots") is None


def test_shots_node_vo_source_without_canvas_graph():
    assert vo_shots.shots_node_vo_source(_FakeProject({}, "текст"), "n_excel_gpt_pk_shots") is None
    assert vo_shots.shots_node_vo_source(_FakeProject(None, "текст"), "n_excel_gpt_pk_shots") is None


def test_shots_node_vo_source_edge_reversed_is_not_incoming():
    meta = _graph(
        [
            {"id": "n_script_1", "type": "script"},
            {"id": "n_excel_gpt_pk_shots", "type": "excel_gpt"},
        ],
        [{"source": "n_excel_gpt_pk_shots", "target": "n_script_1"}],
    )
    assert vo_shots.shots_node_vo_source(_FakeProject(meta, "текст"), "n_excel_gpt_pk_shots") is None


def test_shots_node_vo_source_empty_text_returns_empty_source(monkeypatch):
    from app.services import db_v2

    monkeypatch.setattr(db_v2, "resolve_full_voiceover_text", lambda project: "")
    project = _FakeProject(_shots_graph(), script_text="")
    source = vo_shots.shots_node_vo_source(project, "n_excel_gpt_pk_shots")
    assert source is not None
    assert source.node_key == "n_script_1794875142991"
    assert source.text == ""


def test_shots_node_vo_source_text_from_script_text_fallback(monkeypatch):
    from app.services import db_v2

    monkeypatch.setattr(db_v2, "resolve_full_voiceover_text", lambda project: "")
    project = _FakeProject(_shots_graph(), script_text="  Запасной\nтекст  ")
    source = vo_shots.shots_node_vo_source(project, "n_excel_gpt_pk_shots")
    assert source is not None
    assert source.text == "Запасной текст"
