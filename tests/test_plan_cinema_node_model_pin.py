"""Модель, закреплённая на канвасе, доезжает до запроса ноды группы.

Баг владельца (22.11): он поставил на «Сцены по плану» Claude Opus 5.5,
нажал запуск — в журнале `bind_project_llm` Opus 5.5 есть, а фактический
запрос ушёл в `gpt-6.1-sol` через vibecode. Причины были две: белый список
`ALLOWED_MODEL_IDS` (только два id Sol) и аварийный `PLAN_CINEMA_TEXT_PROVIDER`,
который подменял модель на gpt-6.1-sol для всех нод группы.
"""

from __future__ import annotations

from app.services.plan_cinema import nodes


def _project(model_id: str, *, pinned: bool = False, effort: str | None = None) -> object:
    data: dict = {"modelId": model_id}
    if pinned:
        data["modelPinned"] = True
    if effort:
        data["reasoningEffort"] = effort
    graph = {
        "nodes": [
            {"id": "n_topic_2", "type": "topic", "data": {"label": "Тема"}},
            {
                "id": "n_excel_gpt_pk_scenes",
                "type": "excel_gpt",
                "data": {"label": "Сцены по плану", **data},
            },
            {
                "id": "n_excel_gpt_pk_dialogues",
                "type": "excel_gpt",
                "data": {"label": "Диалоги", "modelId": "gpt-6.1-sol"},
            },
        ],
        "edges": [
            {"id": "e1", "source": "n_topic_2", "target": "n_excel_gpt_pk_scenes"},
            {"id": "e2", "source": "n_excel_gpt_pk_scenes", "target": "n_excel_gpt_pk_dialogues"},
        ],
    }

    class _P:
        id = 3
        meta = {"canvas_graph": graph}

    return _P()


def test_pinned_opus_is_used_instead_of_default() -> None:
    project = _project("claude-opus-5-5", pinned=True)

    model_id, effort = nodes.node_llm_choice(project, "n_excel_gpt_pk_scenes")

    assert model_id == "claude-opus-5-5"
    assert effort == nodes.DEFAULT_REASONING_EFFORT


def test_pin_keeps_explicit_reasoning_effort() -> None:
    project = _project("claude-opus-5-5", pinned=True, effort="high")

    model_id, effort = nodes.node_llm_choice(project, "n_excel_gpt_pk_scenes")

    assert (model_id, effort) == ("claude-opus-5-5", "high")


def test_foreign_model_without_pin_still_falls_back() -> None:
    """UI-дефолт канваса не должен перебивать модель группы (старое правило)."""
    project = _project("gpt-5.6-sol")

    model_id, _ = nodes.node_llm_choice(project, "n_excel_gpt_pk_scenes")

    assert model_id == nodes.DEFAULT_MODEL_ID


def test_allowed_sol_model_works_without_pin() -> None:
    project = _project("gpt-6.1-sol")

    model_id, _ = nodes.node_llm_choice(project, "n_excel_gpt_pk_scenes")

    assert model_id == "gpt-6.1-sol"


def test_node_without_canvas_entry_uses_default() -> None:
    project = _project("claude-opus-5-5", pinned=True)

    model_id, _ = nodes.node_llm_choice(project, "n_excel_gpt_pk_unknown")

    assert model_id == nodes.DEFAULT_MODEL_ID


def test_pin_flag_read_from_canvas() -> None:
    assert nodes.node_model_pinned(_project("claude-opus-5-5", pinned=True), "n_excel_gpt_pk_scenes")
    assert not nodes.node_model_pinned(_project("claude-opus-5-5"), "n_excel_gpt_pk_scenes")
    # Соседняя нода без пина — не закреплена.
    assert not nodes.node_model_pinned(_project("claude-opus-5-5", pinned=True), "n_excel_gpt_pk_dialogues")


def test_image_model_never_accepted_as_text_choice() -> None:
    """Пин картинки на текстовой ноде не должен уехать в текстовый запрос."""
    project = _project("gpt-image-2", pinned=True)

    model_id, _ = nodes.node_llm_choice(project, "n_excel_gpt_pk_scenes")

    assert model_id == nodes.DEFAULT_MODEL_ID
