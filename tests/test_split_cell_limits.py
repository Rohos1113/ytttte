"""Регрессии split: reconcile + params; GPT as-is (без fail-closed / enforce)."""

from __future__ import annotations

from pathlib import Path

from app.models import NodeRun, NodeRunStatus, Project, ProjectStatus
from app.services.node_step_params import (
    build_split_params_block,
    split_cell_limits_from_project,
    split_params_fingerprint,
)
from app.services.run_sync import _node_already_succeeded_for_project


def test_split_cell_limits_from_project() -> None:
    p = Project(topic="t")
    p.meta = {
        "node_step_params": {
            "split": {
                "cell_min_chars": 27,
                "cell_max_chars": 54,
                "cell_avg_min": 27,
                "cell_avg_max": 52,
            }
        }
    }
    lim = split_cell_limits_from_project(p)
    assert lim == (27, 54, 27, 52)
    assert split_params_fingerprint(p) == "27:54:27:52"
    block = build_split_params_block(p)
    assert "27" in block and "54" in block
    assert "отклонят" not in block
    assert "ЖЁСТКО" not in block


def test_split_fallback_limits_when_unconfigured() -> None:
    p = Project(topic="t")
    p.meta = {}
    p.general_plan = "Кадр 1: начало\nКадр 2: середина\nКадр 3: финал"
    p.script_text = "Короткий закадровый текст для проверки расчёта лимитов на кадр."
    block = build_split_params_block(p)
    assert "____" not in block
    assert "Минимальное количество символов в ячейке" in block
    assert "Максимальное количество символов в ячейке" in block


def test_split_not_succeeded_without_split_completed() -> None:
    """Reconcile не красит n_split в done без split_completed."""
    p = Project(topic="t", status=ProjectStatus.enrich_1_ready)
    p.meta = {}
    nr = NodeRun(
        workflow_run_id=1,
        node_key="n_split",
        node_type="split",
        status=NodeRunStatus.running,
    )
    assert _node_already_succeeded_for_project(p, nr) is False

    p.meta = {"split_completed": True}
    assert _node_already_succeeded_for_project(p, nr) is True


def test_split_pipeline_validates_configured_cell_limits() -> None:
    """Параметры ноды должны попадать в контрактный repair, а fallback их учитывает."""
    runners = Path("app/services/xlsx_step_runners.py").read_text(encoding="utf-8")
    local = Path("app/services/voiceover_split_local.py").read_text(encoding="utf-8")
    assert "split_cell_limits_from_project(project)" in runners
    assert "короче минимальных" in runners
    assert "превышают максимум" in runners
    assert "target_len=target_len, min_chars=min_chars, max_chars=max_chars" in runners
    assert "def split_voiceover_locally(" in local
