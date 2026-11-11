"""Источник текста цепочки plan_cinema (CONTRACT §2, §6).

Работает поверх старой механики, ничего в ней не меняя: закадровый режим —
это ровно ``db_v2.resolve_full_voiceover_text``.
"""

from __future__ import annotations

from app.models import Project
from app.services import db_v2

SOURCE_MODE_KEY = "source_mode"
PLAN_MODE = "plan"
VOICEOVER_MODE = "voiceover"


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
    """План проекта (``project.general_plan``) в нормализованном виде."""
    return normalize_plan_text(getattr(project, "general_plan", None))


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
