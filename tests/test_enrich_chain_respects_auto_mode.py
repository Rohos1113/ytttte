"""Автопродвижение выкл ⇒ цепочка группы excel_gpt не стартует сама.

Регресс на живой баг: при выключенном тумблере «Автозапуск шагов» после
завершения одной ноды группы («Кадры» fw_* / «Кино по плану» pk_*)
следующая нода запускалась без клика (в логе `enrich_xlsx auto-chain`).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from app.models import ProjectStatus
from app.orchestrator.steps import enrich_xlsx as ex


class _FakeSession:
    def __init__(self) -> None:
        self.flushed = 0

    async def flush(self) -> None:
        self.flushed += 1


def _project(*, auto_mode: bool, meta: dict) -> SimpleNamespace:
    return SimpleNamespace(id=7, auto_mode=auto_mode, meta=dict(meta), status=None)


def _run(
    project: SimpleNamespace,
    node_key: str = "n_excel_gpt_pk_scenes",
    monkeypatch=None,
) -> list[list]:
    """Прогнать _after_excel_gpt_done; вернуть аргументы вызова auto-chain."""
    calls: list[list] = []
    if monkeypatch is not None:
        # arm_auto_await_manual_start дергает ORM flag_modified — на SimpleNamespace не работает.
        monkeypatch.setattr(
            "app.services.project_control.arm_auto_await_manual_start",
            lambda *_a, **_k: None,
        )

    async def _spy(*args, **kwargs) -> None:  # noqa: ANN002, ANN003
        calls.append([args, kwargs])

    original = ex._maybe_auto_chain_excel_gpt
    ex._maybe_auto_chain_excel_gpt = _spy  # type: ignore[assignment]
    try:
        asyncio.run(
            ex._after_excel_gpt_done(
                _FakeSession(),
                project,
                node_key=node_key,
                slot_idx=1,
                ready_status=ProjectStatus.enrich_1_ready,
            )
        )
    finally:
        ex._maybe_auto_chain_excel_gpt = original  # type: ignore[assignment]
    return calls


def test_auto_mode_off_does_not_start_next_node(monkeypatch) -> None:
    project = _project(
        auto_mode=False,
        meta={
            "enrich_auto_chain_to": "n_excel_gpt_pk_dialogues",
            "active_excel_gpt_node_key": "n_excel_gpt_pk_dialogues",
        },
    )
    calls = _run(project, monkeypatch=monkeypatch)
    assert calls == [], "при auto_mode=False цепочка запускать следующую ноду не должна"
    assert "enrich_auto_chain_to" not in (project.meta or {})
    assert (project.meta or {}).get("active_excel_gpt_node_key") == "n_excel_gpt_pk_scenes"


def test_auto_mode_on_still_chains(monkeypatch) -> None:
    project = _project(auto_mode=True, meta={})
    calls = _run(project, monkeypatch=monkeypatch)
    assert calls, "при auto_mode=True цепочка группы должна работать как раньше"


def test_stop_after_key_still_stops_chain(monkeypatch) -> None:
    project = _project(
        auto_mode=True,
        meta={"excel_gpt_stop_after_key": "n_excel_gpt_pk_scenes"},
    )
    calls = _run(project, monkeypatch=monkeypatch)
    assert calls == []
    assert "excel_gpt_stop_after_key" not in (project.meta or {})
