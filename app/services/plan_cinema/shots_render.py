"""Картинки по кадрам-шотам: ``shots/<S1-K1>.png``.

Кадры-шоты (``attrs["кадры"]`` у сцены, например ``S12-K3``) — единица
монтажа и видео: у каждого свой ``промт_картинки`` со стилем. Нода
«Картинки» раньше рисовала одну картинку на сцену (22 PNG на 129 кадров),
из-за чего на доске монтажа у кадров не было картинок. Здесь добиваем PNG
по каждой карточке кадра.

Путь ``shots/<id>.png`` уже ищет доска монтажа
(``montage_board._shot_still_path`` → images/, shots/, scenes/), поэтому
отдельная интеграция в UI не нужна.

Пропуск при повторе: отпечаток промта и референсов в ``meta.fingerprint``
артефакта — перерисовака только когда промт/рефы реально поменялись.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from app.models import Artifact, ArtifactKind

SHOTS_SUBDIR = "shots"
_FAILURES_KEY = "shot_render_failures"


def shots_dir(project: Any) -> Path:
    return Path(project.data_dir) / SHOTS_SUBDIR


def shot_path(project: Any, shot_id: str) -> Path:
    return shots_dir(project) / f"{shot_id}.png"


def iter_shot_cards(frames: list[Any]) -> list[tuple[int, dict[str, Any]]]:
    """(номер сцены, карточка кадра) для всех кадров с промтом картинки."""
    out: list[tuple[int, dict[str, Any]]] = []
    for frame in frames:
        attrs = dict(getattr(frame, "attrs", None) or {})
        for card in attrs.get("кадры") or []:
            if not isinstance(card, dict):
                continue
            shot_id = str(card.get("id") or "").strip()
            prompt = str(card.get("промт_картинки") or "").strip()
            if not shot_id or not prompt:
                continue
            if card.get("активен") is False:
                continue
            out.append((int(getattr(frame, "number", 0) or 0), card))
    return out


def _ref_files(project: Any, card: dict[str, Any]) -> list[Path]:
    """Референсы кадра: персонажи из «кто» + фон из ``фон_код`` (максимум 2)."""
    base = Path(project.data_dir)
    refs: list[Path] = []
    import re

    codes = re.findall(r"\b([ci]\d{2})\b", str(card.get("кто") or ""), re.IGNORECASE)
    for code in codes:
        fp = base / "characters" / f"{code.lower()}.png"
        if fp.is_file():
            refs.append(fp)
            break
    bg_code = str(card.get("фон_код") or "").strip()
    if bg_code:
        fp = base / "backgrounds" / f"{bg_code}.png"
        if fp.is_file():
            refs.append(fp)
    items = card.get("предметы") or []
    if isinstance(items, list):
        for code in items:
            fp = base / "items" / f"{str(code).strip().lower()}.png"
            if fp.is_file():
                refs.append(fp)
                break
    return refs[:2]


def _model_settings(project: Any) -> dict[str, Any]:
    from app.services.plan_cinema.backgrounds_render import _model_settings as _bg_settings

    return _bg_settings(project)


async def _record(
    session: Any,
    project: Any,
    *,
    shot_id: str,
    frame_number: int,
    path: Path,
    prompt: str,
    refs: list[Path],
) -> None:
    from sqlalchemy import select

    fingerprint = hashlib.sha1(
        f"{prompt}|{'|'.join(str(r) for r in refs)}".encode()
    ).hexdigest()[:16]
    meta = {
        "shot_id": shot_id,
        "frame_number": frame_number,
        "description": shot_id,
        "source": "plan_cinema.shots",
        "prompt_chars": len(prompt),
        "fingerprint": fingerprint,
        "mtime": int(path.stat().st_mtime),
        "refs": [str(r.name) for r in refs],
    }
    rows = (
        (
            await session.execute(
                select(Artifact).where(
                    Artifact.project_id == project.id,
                    Artifact.kind == ArtifactKind.scene_image,
                )
            )
        )
        .scalars()
        .all()
    )
    for art in rows:
        if (art.meta or {}).get("shot_id") == shot_id:
            art.path = str(path)
            art.meta = {**(art.meta or {}), **meta}
            return
    import uuid

    session.add(
        Artifact(
            project_id=project.id,
            kind=ArtifactKind.scene_image,
            uuid=uuid.uuid4().hex,
            path=str(path),
            storage_key="",
            meta=meta,
        )
    )


async def render_one(
    session: Any,
    project: Any,
    *,
    shot_id: str,
    frame_number: int,
    prompt: str,
    refs: list[Path],
    force: bool = False,
    record: bool = True,
    gpt: Any | None = None,
    gpt_rewrite: bool = False,
) -> Path | None:
    path = shot_path(project, shot_id)
    if path.is_file() and path.stat().st_size > 32 and not force:
        if record:
            await _record(
                session,
                project,
                shot_id=shot_id,
                frame_number=frame_number,
                path=path,
                prompt=prompt,
                refs=refs,
            )
        return path
    text = (prompt or "").strip()
    if not text:
        return None
    cfg = _model_settings(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    if tmp.exists():
        tmp.unlink()
    from app.services.outsee_retry import generate_image_with_retries

    logger.info(
        "[#{}] кадр {}: рисую ({}, стиль карточки)",
        getattr(project, "id", "?"),
        shot_id,
        cfg["aspect_slug"],
    )
    try:
        await generate_image_with_retries(
            None,
            gpt if gpt_rewrite else None,
            prompt=text,
            out_path=tmp,
            max_attempts_per_prompt=2,
            gpt_rewrite=bool(gpt_rewrite and gpt is not None),
            aspect_ratio=cfg["aspect_slug"],
            model_slug=cfg["model_slug"],
            resolution=cfg["resolution_slug"],
            quality=cfg["quality_slug"],
            reference_image=refs or None,
            project_id=getattr(project, "id", None),
        )
    except Exception:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise
    if not tmp.is_file() or tmp.stat().st_size <= 32:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise RuntimeError("провайдер не вернул файл картинки")
    os.replace(tmp, path)
    if record:
        await _record(
            session,
            project,
            shot_id=shot_id,
            frame_number=frame_number,
            path=path,
            prompt=prompt,
            refs=refs,
        )
    return path


async def render_missing(
    session: Any,
    project: Any,
    frames: list[Any],
    *,
    force: bool = False,
    concurrency: int | None = None,
) -> tuple[int, int]:
    """Дорисовать PNG по кадрам-шотам. Возврат: (нарисовано, уже было)."""
    cards = iter_shot_cards(frames)
    if not cards:
        return 0, 0
    limit = concurrency or int(os.getenv("SHOTS_CONCURRENCY", "3") or "3")
    sem = asyncio.Semaphore(max(1, limit))
    lock = asyncio.Lock()
    drawn = 0
    skipped = 0
    failures: dict[str, str] = {}

    async def one(frame_number: int, card: dict[str, Any]) -> None:
        nonlocal drawn, skipped
        shot_id = str(card.get("id") or "").strip()
        prompt = str(card.get("промт_картинки") or "").strip()
        refs = _ref_files(project, card)
        path = shot_path(project, shot_id)
        if path.is_file() and path.stat().st_size > 32 and not force:
            async with lock:
                await _record(
                    session,
                    project,
                    shot_id=shot_id,
                    frame_number=frame_number,
                    path=path,
                    prompt=prompt,
                    refs=refs,
                )
                skipped += 1
            return
        async with sem:
            try:
                await render_one(
                    session,
                    project,
                    shot_id=shot_id,
                    frame_number=frame_number,
                    prompt=prompt,
                    refs=refs,
                    force=force,
                    record=False,
                )
                async with lock:
                    await _record(
                        session,
                        project,
                        shot_id=shot_id,
                        frame_number=frame_number,
                        path=path,
                        prompt=prompt,
                        refs=refs,
                    )
                    drawn += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[#{}] кадр {}: не нарисован — {}",
                    getattr(project, "id", "?"),
                    shot_id,
                    exc,
                )
                failures[shot_id] = str(exc)[:300]

    await asyncio.gather(*(one(fn, card) for fn, card in cards))

    meta = dict(project.meta or {})
    if failures:
        meta[_FAILURES_KEY] = {
            "codes": sorted(failures),
            "errors": failures,
            "at": datetime.utcnow().isoformat(timespec="seconds"),
        }
    else:
        meta.pop(_FAILURES_KEY, None)
    project.meta = meta
    await session.flush()
    logger.info(
        "[#{}] generate_images: кадры-шоты — нарисовано {}, готовых {}, провалов {}",
        getattr(project, "id", "?"),
        drawn,
        skipped,
        len(failures),
    )
    return drawn, skipped
