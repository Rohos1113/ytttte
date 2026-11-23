"""Вход «Сцен по плану» — выход подведённой ноды канваса, а не старый план.

Баг владельца: на канвасе «Тема» подведена прямо к «Сценам по плану», но нода
читала ``project.general_plan`` — старый сценарий от прежней темы. Заменил
тему, перезапустил ноду — сцены снова про старую тему. Теперь вход берётся
по стрелке графа: «Тема» → ``project.topic``, «Сценарий» → ``general_plan``.
"""

from __future__ import annotations

from app.services.plan_cinema import source

TOPIC = "Моё имя Аделфус. Оборона планеты Фригус."
PLAN = "Сценарий про Тесенну Старн и её побег."


class _Project:
    def __init__(self, *, topic: str = "", general_plan: str = "", graph=None) -> None:
        self.topic = topic
        self.general_plan = general_plan
        self.meta = {"canvas_graph": graph} if graph is not None else {}


def _graph(*pairs: tuple[str, str, str]) -> dict:
    """(id, type, label) — линейная цепочка: каждое ребро на следующую ноду."""
    nodes = [{"id": nid, "type": typ, "data": {"label": label}} for nid, typ, label in pairs]
    edges = [
        {"id": f"e{i}", "source": pairs[i][0], "target": pairs[i + 1][0]}
        for i in range(len(pairs) - 1)
    ]
    return {"nodes": nodes, "edges": edges}


def test_topic_edge_wins_over_stale_general_plan() -> None:
    graph = _graph(
        ("n_topic_2", "topic", "Тема"),
        ("n_excel_gpt_pk_scenes", "excel_gpt", "Сцены по плану"),
    )
    project = _Project(topic=TOPIC, general_plan=PLAN, graph=graph)

    text, kind = source.read_node_input_text(project, "n_excel_gpt_pk_scenes")

    assert kind == "topic"
    assert text == TOPIC
    assert PLAN not in text


def test_plan_edge_still_reads_general_plan() -> None:
    graph = _graph(
        ("n_plan_2", "plan", "Сценарий"),
        ("n_excel_gpt_pk_scenes", "excel_gpt", "Сцены по плану"),
    )
    project = _Project(topic=TOPIC, general_plan=PLAN, graph=graph)

    text, kind = source.read_node_input_text(project, "n_excel_gpt_pk_scenes")

    assert kind == "plan"
    assert text == PLAN


def test_no_edge_falls_back_to_project_plan() -> None:
    project = _Project(topic=TOPIC, general_plan=PLAN)

    text, kind = source.read_node_input_text(project, "n_excel_gpt_pk_scenes")

    assert kind == "project_plan"
    assert text == PLAN


def test_empty_topic_falls_back_to_plan() -> None:
    """Пустая тема не должна оставлять ноду без входа, если план есть."""
    graph = _graph(
        ("n_topic_2", "topic", "Тема"),
        ("n_excel_gpt_pk_scenes", "excel_gpt", "Сцены по плану"),
    )
    project = _Project(topic="   ", general_plan=PLAN, graph=graph)

    text, kind = source.read_node_input_text(project, "n_excel_gpt_pk_scenes")

    assert kind == "project_plan"
    assert text == PLAN


def test_edge_from_foreign_node_is_ignored() -> None:
    graph = _graph(
        ("n_images_2", "images", "Картинки"),
        ("n_excel_gpt_pk_scenes", "excel_gpt", "Сцены по плану"),
    )
    project = _Project(topic=TOPIC, general_plan=PLAN, graph=graph)

    text, kind = source.read_node_input_text(project, "n_excel_gpt_pk_scenes")

    assert kind == "project_plan"
    assert text == PLAN
