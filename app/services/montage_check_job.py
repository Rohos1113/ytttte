"""Фоновая проверка картинок монтажа (листы 4К → vision-агент) — HTTP не блокируется.

Статус живёт в ``meta.montage_board["image_check_job"]`` и пишется самим
``run_image_check`` (``montage_check_meta.write_job``). Джоба ставит только
``running`` перед стартом, ``cancelled``/``error`` — на отказе, и публикует
событие ``image_check`` для доски.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from typing import Any

from loguru import logger

from app.db import session_scope
from app.models import Project
from app.services.db_busy import is_db_busy
from app.services.event_bus import publish_project_event
from app.services.montage_board_job_state import resolve_job_status
from app.services.montage_board_meta import montage_meta, set_montage_meta
from app.services.montage_check_meta import IMAGE_CHECK_JOB_KEY

_JOB_KEY = IMAGE_CHECK_JOB_KEY
_tasks: dict[int, asyncio.Task[None]] = {}


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _is_sqlite_locked(exc: BaseException) -> bool:
    """Конкурент держит базу (на Postgres — SQLSTATE через ``db_busy``)."""
    return is_db_busy(exc)


def get_image_check_job(project: Project) -> dict[str, Any]:
    board = montage_meta(project)
    job = board.get(_JOB_KEY)
    raw = dict(job) if isinstance(job, dict) else {"status": "idle"}
    return resolve_job_status(project.id, raw, live_tasks=_tasks)


def _set_job(project: Project, patch: dict[str, Any]) -> dict[str, Any]:
    board = montage_meta(project)
    job = dict(board.get(_JOB_KEY) or {})
    job.update(patch)
    board[_JOB_KEY] = job
    set_montage_meta(project, board)
    return job


async def _set_job_retry(project_id: int, patch: dict[str, Any]) -> None:
    """Короткая сессия на запись статуса + retry на database lock."""
    last: BaseException | None = None
    for attempt in range(1, 8):
        try:
            async with session_scope() as session:
                project = await session.get(Project, project_id)
                if project is None:
                    return
                _set_job(project, patch)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            if _is_sqlite_locked(exc) and attempt < 7:
                await asyncio.sleep(min(1.5 * attempt, 8.0))
                continue
            raise
    if last is not None:
        raise last


async def _publish(project_id: int, status: str) -> None:
    await publish_project_event(
        project_id,
        event_type="project_updated",
        payload={"image_check": True, "status": status, "refresh_board": True},
    )


def spawn_image_check_job(
    project_id: int,
    *,
    frame_numbers: list[int] | None = None,
    scene: int | None = None,
) -> asyncio.Task[None]:
    prev = _tasks.get(project_id)
    if prev is not None and not prev.done():
        return prev
    task = asyncio.create_task(
        _run_job(project_id, frame_numbers=frame_numbers, scene=scene),
        name=f"image-check-{project_id}",
    )
    _tasks[project_id] = task
    return task


def is_image_check_job_live(project_id: int) -> bool:
    task = _tasks.get(project_id)
    return task is not None and not task.done()


async def _run_job(
    project_id: int,
    *,
    frame_numbers: list[int] | None,
    scene: int | None,
) -> None:
    await _set_job_retry(
        project_id,
        {
            "status": "running",
            "phase": "prepare",
            "phase_detail": "подготовка",
            "done": 0,
            "total": 0,
            "error": None,
            "started_at": _utc_now(),
            "finished_at": None,
            "result": None,
        },
    )
    await _publish(project_id, "running")

    try:
        from app.services.montage_check_images import run_image_check

        result = await run_image_check(
            project_id,
            frame_numbers=frame_numbers,
            scene=scene,
        )
        if result.get("cancelled"):
            status = "cancelled"
        elif result.get("error"):
            status = "error"
        else:
            status = "done"
        # done/error/last_run пишет сам run_image_check — здесь только событие.
        await _publish(project_id, status)
    except asyncio.CancelledError:
        logger.info("image_check_job #{} cancelled", project_id)
        with contextlib.suppress(Exception):
            await _set_job_retry(
                project_id,
                {
                    "status": "cancelled",
                    "error": "остановлено пользователем",
                    "finished_at": _utc_now(),
                },
            )
        with contextlib.suppress(Exception):
            await _publish(project_id, "cancelled")
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("image_check_job #{} failed", project_id)
        msg = str(exc)
        if _is_sqlite_locked(exc):
            msg = "database is locked — повтори через пару секунд (база занята доской)"
        with contextlib.suppress(Exception):
            await _set_job_retry(
                project_id,
                {"status": "error", "error": msg, "finished_at": _utc_now()},
            )
        with contextlib.suppress(Exception):
            await _publish(project_id, "error")
    finally:
        _tasks.pop(project_id, None)


async def cancel_image_check_job(project_id: int) -> bool:
    """Остановить прогон: cancel живой задачи + статус ``cancelled`` в meta."""
    task = _tasks.get(project_id)
    cancelled = False
    if task is not None and not task.done():
        task.cancel()
        cancelled = True
    try:
        async with session_scope() as session:
            project = await session.get(Project, project_id)
            if project is None:
                return cancelled
            board = montage_meta(project)
            job = board.get(_JOB_KEY)
            raw = dict(job) if isinstance(job, dict) else {}
            if raw.get("status") != "running":
                return cancelled
            _set_job(
                project,
                {
                    "status": "cancelled",
                    "error": "остановлено пользователем",
                    "finished_at": _utc_now(),
                },
            )
        cancelled = True
    except Exception as exc:  # noqa: BLE001
        logger.warning("cancel_image_check_job #{}: {}", project_id, exc)
        return cancelled
    if cancelled:
        with contextlib.suppress(Exception):
            await _publish(project_id, "cancelled")
    return cancelled
