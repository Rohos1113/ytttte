"""Источник текста цепочки plan_cinema (CONTRACT §2, §6).

Работает поверх старой механики, ничего в ней не меняя: закадровый режим —
это ровно ``db_v2.resolve_full_voiceover_text``.
"""

from __future__ import annotations

from typing import Any

from app.models import Project
from app.services import db_v2

SOURCE_MODE_KEY = "source_mode"
PLAN_MODE = "plan"
VOICEOVER_MODE = "voiceover"

#: Типы нод канваса, чей выход становится входом «Сцен по плану».
TOPIC_NODE_TYPES = frozenset({"topic"})
PLAN_NODE_TYPES = frozenset({"plan", "script"})


def source_mode(project: Project) -> str:
    """Режим проекта: ``"plan"`` или ``"voiceover"`` (по умолчанию — закадр)."""
    meta = getattr(project, "meta", None)
    if isinstance(meta, dict) and meta.get(SOURCE_MODE_KEY) == PLAN_MODE:
        return PLAN_MODE
    return VOICEOVER_MODE


def normalize_plan_text(plan_text: str | None) -> str:
    """Текст плана для резки: обрезка краёв, внутренние переводы строк как есть.

    Пробелы внутри абзаца не схлопываются: по строкам режется нумерация
    ``P1…Pn``, а склейка убила бы границы пунктов.
    """
    return (plan_text or "").strip()


def read_plan_text(project: Project) -> str:
    """План проекта: ``meta.general_plan`` (сценарий из UI), иначе старая колонка.

    Владелец правит план в студии — он уезжает в ``meta.general_plan``, а
    колонка ``projects.general_plan`` остаётся от старого импорта xlsx. Нода,
    читавшая колонку, брала чужой текст (так «Сцены» написали 17 сцен по
    старому рассказу вместо нового сценария). Порядок: мета, потом колонка.
    """
    meta = getattr(project, "meta", None)
    if isinstance(meta, dict):
        text = normalize_plan_text(str(meta.get("general_plan") or ""))
        if text:
            return text
    return normalize_plan_text(getattr(project, "general_plan", None))


def _canvas(project: Project) -> dict[str, Any]:
    from app.services.canvas_graph import canvas_graph_from_meta

    meta = getattr(project, "meta", None)
    if not isinstance(meta, dict):
        return {}
    return canvas_graph_from_meta(meta) or {}


def read_node_input_text(
    project: Project,
    node_key: str | None = None,
) -> tuple[str, str]:
    """Текст на входе ноды — выход ноды, подведённой к ней стрелкой канваса.

    Что подведено, то и читаем (владелец 22.11.2026): «Тема» → ``project.topic``,
    «Сценарий» → план проекта. План из меты — только запасной вход, когда к ноде
    ничего не подведено: раньше он перебивал «Тему», и нода писала сцены по
    старому сценарию вместо нового текста в подведённой ноде.
    Возвращает ``(text, kind)``, где ``kind`` — ``"topic"``, ``"plan"`` или
    ``"project_plan"`` (запасной план без стрелки).
    """
    if node_key:
        canvas = _canvas(project)
        types = {
            str(item.get("id") or ""): str(item.get("type") or "")
            for item in canvas.get("nodes") or ()
            if isinstance(item, dict)
        }
        for edge in canvas.get("edges") or ():
            if not isinstance(edge, dict):
                continue
            if str(edge.get("target") or "") != node_key:
                continue
            kind = types.get(str(edge.get("source") or ""), "")
            if kind in TOPIC_NODE_TYPES:
                text = normalize_plan_text(getattr(project, "topic", None))
                if text:
                    return text, "topic"
            elif kind in PLAN_NODE_TYPES:
                text = read_plan_text(project)
                if text:
                    return text, "plan"
    plan_text = read_plan_text(project)
    if plan_text:
        return plan_text, "project_plan"
    return "", "project_plan"


def resolve_chain_source(project: Project) -> tuple[str, str]:
    """Источник текста цепочки: ``(text, mode)``.

    ``meta.source_mode == "plan"`` → ``(text плана, "plan")``; пустой план
    даёт ``("", "plan")`` без подстановки закадра. Иначе — старый
    ``resolve_full_voiceover_text`` и ``"voiceover"``: проекты без флага
    получают ровно то, что получали раньше (CONTRACT §6).
    """
    if source_mode(project) == PLAN_MODE:
        return read_plan_text(project), PLAN_MODE
    return db_v2.resolve_full_voiceover_text(project), VOICEOVER_MODE
