"""Проверка картинок на панели монтажа: листы 4×4К → агент → вердикты → авто-реген → история.

Механика (``docs/MONTAGE-IMAGE-CHECK.md``):

1. Кадры проекта группируются по сценам (VO-ячейка, как на доске), внутри сцены
   режутся на листы по ``frames_per_sheet`` (4) кадра.
2. Каждый лист — сетка 2×2 из **уже сгенерированных** картинок кадров, длинная
   сторона 3840 (4К), на каждой клетке выжжен ярлык «клетка · номер кадра».
3. Лист уходит агенту-проверке вместе с промтом каждого кадра; ответ —
   JSON по контракту ``vp.montage_check.v1`` (``app/contracts/montage_check.py``).
4. Режим ``notify`` — только вердикты и проблемы; режим ``auto`` — плохие кадры
   перегенерируются (``montage_board_regen``), лист пересобирается и
   перепроверяется, пока кадр не станет ``pass`` или не кончатся лимиты.
5. Каждая версия картинки кадра пишется в историю (``montage_check_meta``), из
   истории можно поставить любую активной (``apply_history_image``).

Почему лист, а не по одной картинке: провайдер режет вложения молча
(``gpt_api._MAX_VISION_IMAGES = 8``, ``_MAX_VISION_BYTES = 4 МБ``), а лист 2×2
даёт и вес в лимите, и контекст «соседние кадры сцены» — агенту видно
последовательность, а не одиночный кадр (тот же приём в ``vision_check_media``).

Модуль работает короткими сессиями: LLM/генерация — сетевые, держать транзакцию
SQLite через них нельзя.
"""

from __future__ import annotations

import asyncio
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from loguru import logger
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import select

from app.db import session_scope
from app.models import Frame, Project
from app.services.montage_board_assets import finalize_scene_image
from app.services.montage_board_regen import (
    execute_image_regen,
    finalize_image_regen,
    prepare_image_regen,
    resolve_image_prompt,
)
from app.services.montage_check_meta import (
    IMAGE_CHECK_JOB_KEY,
    append_history,
    list_agents,
    load_agent_prompt,
    read_history,
    read_job,
    read_last_run,
    read_results,
    read_settings,
    utc_now,
    write_job,
    write_last_run,
    write_results,
)
from app.services.plan_shot2 import find_parent_still_image, find_shot1_image, find_shot2_image

_JOB_KEY = IMAGE_CHECK_JOB_KEY

IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
#: Толщина белых разделителей между клетками листа.
GUTTER_PX = 8
#: Высота чёрной плашки с ярлыком клетки (чтобы агент не путал клетки).
LABEL_BAR_H = 46
#: Меньше двух картинок — лист не собираем, кадры уходят в skip.
MIN_SHEET_FRAMES = 2
#: Сколько архивных версий кадра показывать в истории.
HISTORY_ARCHIVE_LIMIT = 40
#: Потолок ожидания одного vision-ответа.
VISION_TIMEOUT_S = 300.0


# ------------------------------------------------------------------ данные кадра


@dataclass
class FrameCtx:
    """Кадр в листе: номер, промт картинки и путь к текущей картинке."""

    number: int
    frame_id: int
    scene_no: int
    prompt: str
    image: Path | None
    regen_round: int = 0


@dataclass
class Sheet:
    """Один лист 2×2 (или 1×2) с занятыми клетками."""

    scene_no: int
    index: int
    path: Path
    cells: list[FrameCtx] = field(default_factory=list)


# --------------------------------------------------------------------- утилиты


def _utc_now() -> str:
    return utc_now()


def _file_url(path: Path | None) -> str | None:
    """URL превью — ровно как у доски (``/api/files`` + mtime в ``v``)."""
    if path is None or not path.is_file():
        return None
    try:
        mtime_i = int(path.stat().st_mtime)
    except OSError:
        mtime_i = 0
    return f"/api/files?path={quote(str(path), safe='')}&v={mtime_i}"


def _is_inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


def _frame_image(data_dir: Path, number: int) -> Path | None:
    """Активная картинка кадра: shot1 → still родителя → shot2."""
    scenes = data_dir / "scenes"
    return (
        find_shot1_image(scenes, number)
        or find_parent_still_image(scenes, number)
        or find_shot2_image(scenes, number)
    )


def _panel_font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    for name in ("arial.ttf", "Arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _blank_cell(width: int, height: int) -> Image.Image:
    cell = Image.new("RGB", (width, height), (38, 38, 42))
    draw = ImageDraw.Draw(cell)
    font = _panel_font(max(18, height // 28))
    text = "нет кадра"
    try:
        box = draw.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
    except (AttributeError, OSError):
        tw, th = len(text) * 10, 18
    draw.text(((width - tw) // 2, (height - th) // 2), text, fill=(150, 150, 155), font=font)
    return cell


def _fit_cell(img: Image.Image, width: int, height: int) -> Image.Image:
    """Вписать картинку в клетку с сохранением пропорций (поля — тёмно-серые)."""
    cell = Image.new("RGB", (width, height), (24, 24, 26))
    scale = min(width / max(img.width, 1), height / max(img.height, 1))
    new_w = max(1, int(img.width * scale))
    new_h = max(1, int(img.height * scale))
    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    cell.paste(resized, ((width - new_w) // 2, (height - new_h) // 2))
    resized.close()
    return cell


def _burn_label(cell: Image.Image, label: str) -> None:
    """Чёрная плашка сверху клетки с номером клетки и кадра — против путаницы панелей."""
    if not label:
        return
    draw = ImageDraw.Draw(cell)
    bar_h = min(LABEL_BAR_H, max(20, cell.height // 20))
    draw.rectangle((0, 0, min(cell.width, 14 + 12 * len(label)), bar_h), fill=(0, 0, 0))
    font = _panel_font(max(16, bar_h - 14))
    draw.text((7, max(2, (bar_h - 22) // 2)), label, fill=(255, 255, 255), font=font)


def _native_cell_size(cells: list[tuple[Path | None, str]]) -> tuple[int, int]:
    """Размер клетки = родной размер первой картинки. Никакого апскейла/даунскейла."""
    for path, _label in cells:
        if path is None or not path.is_file():
            continue
        try:
            with Image.open(path) as img:
                return max(1, img.width), max(1, img.height)
        except (OSError, ValueError):
            continue
    return 1080, 1920


def compose_sheet(
    cells: list[tuple[Path | None, str]],
    out_path: Path,
    *,
    cell_size: tuple[int, int] | None = None,
) -> Path:
    """Склейка кадров в одну картинку: 4 кадра → 2×2, 3 → 2×2 с пустой клеткой, 2 → 1×2.

    Размер клетки — родной размер кадра (без растяжки до 4К): «4 изображения в одно»,
    а не отдельный 4К-рендер. Нестандартные пропорции вписываются с полями.
    """
    if not cells:
        raise ValueError("compose_sheet: пустой список клеток")
    if len(cells) > 4:
        raise ValueError(f"compose_sheet: больше 4 клеток ({len(cells)})")
    cols, rows = (2, 2) if len(cells) >= 3 else (1, 2)
    gutter = GUTTER_PX
    cell_w, cell_h = cell_size or _native_cell_size(cells)
    total_w = cell_w * cols + gutter * (cols - 1)
    total_h = cell_h * rows + gutter * (rows - 1)
    canvas = Image.new("RGB", (total_w, total_h), (255, 255, 255))
    try:
        for idx, (path, label) in enumerate(cells):
            row, col = divmod(idx, cols)
            if path is not None and path.is_file():
                try:
                    with Image.open(path) as src:
                        img = src.convert("RGB")
                    cell = _fit_cell(img, cell_w, cell_h)
                    img.close()
                except (OSError, ValueError):
                    logger.warning("compose_sheet: не открылась картинка {}", path)
                    cell = _blank_cell(cell_w, cell_h)
            else:
                cell = _blank_cell(cell_w, cell_h)
            _burn_label(cell, label)
            canvas.paste(cell, (col * (cell_w + gutter), row * (cell_h + gutter)))
            cell.close()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(out_path, format="PNG", optimize=True)
        logger.info(
            "montage check sheet: {} ({}×{} px, {} клеток)",
            out_path.name,
            total_w,
            total_h,
            len(cells),
        )
        return out_path
    finally:
        canvas.close()


# ------------------------------------------------------------ короткие сессии


def _is_db_busy(exc: BaseException) -> bool:
    from app.services.db_busy import is_db_busy

    return is_db_busy(exc)


async def _patch_job(project_id: int, patch: dict[str, Any], *, retries: int = 6) -> None:
    """Обновить прогресс в meta с ретраями на занятую базу."""
    last: BaseException | None = None
    for attempt in range(1, retries + 1):
        try:
            async with session_scope() as session:
                project = await session.get(Project, project_id)
                if project is None:
                    return
                write_job(project, patch)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            if _is_db_busy(exc) and attempt < retries:
                await asyncio.sleep(min(1.2 * attempt, 6.0))
                continue
            raise
    if last is not None:
        raise last


async def _read_settings_for(project_id: int) -> dict[str, Any]:
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise RuntimeError(f"проект #{project_id} не найден")
        return read_settings(project)


async def _store_results(project_id: int, results: dict[int, dict[str, Any]]) -> None:
    if not results:
        return
    payload = {str(k): v for k, v in results.items()}
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is not None:
            write_results(project, payload)


async def _store_history(project_id: int, entries: list[dict[str, Any]]) -> None:
    if not entries:
        return
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is not None:
            append_history(project, entries)


async def _frame_data(project_id: int) -> tuple[Path, dict[int, FrameCtx]]:
    """Все кадры проекта (с промтами и картинками) + группа-сцена для каждого."""
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise RuntimeError(f"проект #{project_id} не найден")
        data_dir = Path(project.data_dir)
        frames = list(
            (
                await session.execute(
                    select(Frame)
                    .where(Frame.project_id == project_id)
                    .order_by(Frame.sort_key, Frame.number)
                )
            )
            .scalars()
            .all()
        )
        order = {int(fr.number): idx for idx, fr in enumerate(frames)}
        by_number: dict[int, FrameCtx] = {}
        for fr in frames:
            prompt = await resolve_image_prompt(session, project, fr, 1)
            by_number[int(fr.number)] = FrameCtx(
                number=int(fr.number),
                frame_id=int(fr.id),
                scene_no=int(fr.number),
                prompt=prompt,
                image=_frame_image(data_dir, int(fr.number)),
            )
    # Сцены — та же группировка, что на доске: VO-родитель ячейки.
    from app.services.montage_scene_editor import scene_group

    parent_of: dict[int, int] = {}
    for fr in frames:
        parent, _members = scene_group(frames, fr)
        parent_of[int(fr.number)] = int(parent.number)
    for number, ctx in by_number.items():
        ctx.scene_no = parent_of.get(number, number)
    ordered = {n: by_number[n] for n in sorted(by_number, key=lambda n: order.get(n, n))}
    return data_dir, ordered


# -------------------------------------------------------------- сборка листов


def _split_sheets(
    data_dir: Path,
    frames: dict[int, FrameCtx],
    *,
    frame_numbers: list[int] | None = None,
    scene: int | None = None,
    frames_per_sheet: int = 4,
) -> tuple[list[Sheet], dict[int, dict[str, Any]]]:
    """Сцены → листы + карточки skip для кадров, которые в лист не попали."""
    selected = set(frame_numbers or [])
    per_scene: dict[int, list[FrameCtx]] = {}
    for number, ctx in frames.items():
        if selected and number not in selected:
            continue
        if scene is not None and ctx.scene_no != int(scene):
            continue
        per_scene.setdefault(ctx.scene_no, []).append(ctx)

    sheets: list[Sheet] = []
    skipped: dict[int, dict[str, Any]] = {}
    chunk_size = max(2, min(4, int(frames_per_sheet or 4)))
    check_dir = data_dir / "check"

    # Блоки под листы: сцена из 2+ кадров режется как есть; одиночные сцены
    # пакуем по 4 соседних кадра. Типовой проект — сцена = один кадр, иначе
    # лист 2×2 не набрать никогда, а «четыре кадра в картинке» — требование.
    units: list[list[FrameCtx]] = []
    singles: list[FrameCtx] = []
    for scene_no in sorted(per_scene):
        scene_frames = sorted(per_scene[scene_no], key=lambda c: c.number)
        for ctx in scene_frames:
            if ctx.image is None:
                skipped[ctx.number] = {
                    "verdict": "skip",
                    "score": None,
                    "prompt_match": True,
                    "problems": ["нет картинки кадра"],
                    "sheet": None,
                    "cell": None,
                    "checked_at": _utc_now(),
                    "regen_round": ctx.regen_round,
                }
        ready = [c for c in scene_frames if c.image is not None]
        if not ready:
            continue
        if len(ready) >= 2:
            if singles:
                units.append(singles)
                singles = []
            units.append(ready)
        else:
            singles.extend(ready)
            while len(singles) >= chunk_size:
                units.append(singles[:chunk_size])
                singles = singles[chunk_size:]
    if singles:
        units.append(singles)

    for unit in units:
        label_no = unit[0].number
        for start in range(0, len(unit), chunk_size):
            chunk = unit[start : start + chunk_size]
            if len(chunk) < MIN_SHEET_FRAMES:
                for ctx in chunk:
                    skipped[ctx.number] = {
                        "verdict": "skip",
                        "score": None,
                        "prompt_match": True,
                        "problems": ["мало картинок для листа"],
                        "sheet": None,
                        "cell": None,
                        "checked_at": _utc_now(),
                        "regen_round": ctx.regen_round,
                    }
                continue
            index = start // chunk_size + 1
            path = check_dir / f"sheet_{label_no:03d}_{index:02d}.png"
            cells = [(ctx.image, f"{i} · кадр #{ctx.number}") for i, ctx in enumerate(chunk, start=1)]
            # Пустые клетки нужны, чтобы лист был 2×2 даже на трёх кадрах.
            while len(cells) < 4:
                cells.append((None, ""))
            compose_sheet(cells, path)
            sheets.append(Sheet(scene_no=label_no, index=index, path=path, cells=chunk))
    return sheets, skipped


# ------------------------------------------------------------- агент-проверка


def build_sheet_prompt(
    agent_prompt: str,
    *,
    task: str,
    sheet: Sheet,
    cols: int = 2,
    rows: int = 2,
) -> str:
    """Промт одного листа: тело варианта + задача + ярлыки клеток + промты кадров."""
    lines: list[str] = [agent_prompt.strip(), ""]
    lines.append("# ЗАДАЧА ОТ ОПЕРАТОРА")
    lines.append(task.strip() or "(задача не задана — проверяй по промтам кадров и общим правилам)")
    lines.append("")
    lines.append("# ЛИСТ")
    lines.append(
        f"Лист {sheet.index}: сетка {cols}×{rows}, клетки идут слева направо, сверху вниз. "
        "В левом верхнем углу каждой картинки выжжен служебный ярлык «клетка · номер кадра» — "
        "это НЕ часть кадра: не считай его текстом/водяным знаком на изображении."
    )
    for idx, ctx in enumerate(sheet.cells, start=1):
        lines.append(f"- клетка {idx}: кадр #{ctx.number}")
    lines.append("")
    lines.append("# ПРОМТЫ КАДРОВ")
    for idx, ctx in enumerate(sheet.cells, start=1):
        lines.append(f"## Клетка {idx} — кадр #{ctx.number}")
        lines.append(ctx.prompt.strip() or "(промт кадра не задан)")
        lines.append("")
    lines.append("# ЧТО ВЕРНУТЬ")
    lines.append(
        "Верни ТОЛЬКО JSON-объект без markdown:\n"
        '{"cells":[{"frame":1,"verdict":"pass|fail","score":0.0,"prompt_match":true,'
        '"problems":["..."]}],"summary":"..."}\n'
        "Поле frame — НОМЕР КЛЕТКИ (1..N), не номер кадра проекта. verdict=fail, если "
        "картинка не соответствует промту кадра или есть брак (лишние/не те персонажи, "
        "не тот фон/место, обрезанные лица, артефакты, текст/водяные знаки, коллаж). "
        "problems — короткие фразы по-русски, без общих слов."
    )
    return "\n".join(lines)


def _map_report(sheet: Sheet, report: Any) -> dict[int, dict[str, Any]]:
    """Ответ агента (клетки) → вердикты по номерам кадров проекта."""
    by_cell: dict[int, Any] = {}
    for cell in getattr(report, "cells", []) or []:
        try:
            by_cell[int(cell.frame)] = cell
        except (TypeError, ValueError):
            continue
    out: dict[int, dict[str, Any]] = {}
    for idx, ctx in enumerate(sheet.cells, start=1):
        cell = by_cell.get(idx)
        now = _utc_now()
        if cell is None:
            out[ctx.number] = {
                "verdict": "fail",
                "score": None,
                "prompt_match": False,
                "problems": ["агент не вернул вердикт по клетке"],
                "sheet": sheet.path.name,
                "cell": idx,
                "checked_at": now,
                "regen_round": ctx.regen_round,
            }
            continue
        problems = [str(p).strip() for p in (getattr(cell, "problems", None) or []) if str(p).strip()]
        prompt_match = bool(getattr(cell, "prompt_match", True))
        verdict = str(getattr(cell, "verdict", "fail") or "fail")
        if not prompt_match and verdict == "pass":
            verdict = "fail"
            if not any("промт" in p.lower() for p in problems):
                problems.append("картинка не соответствует промту кадра")
        out[ctx.number] = {
            "verdict": verdict if verdict in {"pass", "fail"} else "fail",
            "score": getattr(cell, "score", None),
            "prompt_match": prompt_match,
            "problems": problems[:12],
            "sheet": sheet.path.name,
            "cell": idx,
            "checked_at": now,
            "regen_round": ctx.regen_round,
        }
    return out


async def _ask_sheet(project_id: int, prompt: str, sheet: Sheet) -> Any:
    """Один vision-вызов по листу + контракт + один repair-ретрай. Битый ответ — исключение."""
    from app.contracts.errors import LlmContractError
    from app.contracts.montage_check import MONTAGE_CHECK
    from app.services.gpt_client import get_gpt_client

    client = get_gpt_client()
    reply = await client.ask_with_files(
        prompt,
        [sheet.path],
        project_id=project_id,
        timeout=VISION_TIMEOUT_S,
        response_schema=MONTAGE_CHECK.response_schema(),
    )
    try:
        return MONTAGE_CHECK.parse(reply or "").payload
    except LlmContractError as exc:
        logger.warning(
            "montage check: лист {} не прошёл контракт ({}), repair-ретрай",
            sheet.path.name,
            exc,
        )
        repair = (
            f"{prompt}\n\n# ПОВТОР\nПредыдущий ответ не прошёл схему ответа:\n{exc}\n"
            "Верни строго JSON-объект по описанной схеме, без markdown и текста вокруг."
        )
        reply2 = await client.ask_with_files(
            repair,
            [sheet.path],
            project_id=project_id,
            timeout=VISION_TIMEOUT_S,
            response_schema=MONTAGE_CHECK.response_schema(),
        )
        return MONTAGE_CHECK.parse(reply2 or "").payload


async def _check_sheet(project_id: int, sheet: Sheet, *, agent_prompt: str, task: str) -> dict[int, dict[str, Any]]:
    prompt = build_sheet_prompt(agent_prompt, task=task, sheet=sheet)
    report = await _ask_sheet(project_id, prompt, sheet)
    return _map_report(sheet, report)


# --------------------------------------------------------------- авто-реген


async def _regen_frame(project_id: int, number: int) -> Path:
    """Перегенерация картинки кадра (same_prompt) без удержания сессии на время сети."""
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise RuntimeError(f"проект #{project_id} не найден")
        prep = await prepare_image_regen(session, project, number, shot=1, mode="same_prompt")
    new_path = await execute_image_regen(prep)
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is None:
            raise RuntimeError(f"проект #{project_id} не найден")
        await finalize_image_regen(session, project, prep, new_path)
    return new_path


def _history_entry(ctx: FrameCtx, result: dict[str, Any], *, source: str, active: bool = True) -> dict[str, Any]:
    image = ctx.image
    return {
        "frame_number": ctx.number,
        "shot": 1,
        "file": image.name if image is not None else "",
        "path": str(image) if image is not None else "",
        "created_at": _utc_now(),
        "source": source,
        "verdict": str(result.get("verdict") or "unknown"),
        "problems": list(result.get("problems") or []),
        "active": active,
    }


async def _regen_and_recheck(
    project_id: int,
    data_dir: Path,
    sheet: Sheet,
    ctx: FrameCtx,
    results: dict[int, dict[str, Any]],
    *,
    settings: dict[str, Any],
    agent_prompt: str,
    on_progress: Callable[[str, str, int, int], None] | None,
    counters: dict[str, int],
    phase_done: int,
    phase_total: int,
) -> None:
    """Плохой кадр: до ``max_regens`` регенераций, после каждой — перепроверка листа."""
    max_regens = int(settings.get("max_regens") or 0)
    max_rechecks = int(settings.get("max_rechecks") or 0)
    if max_regens <= 0:
        return
    # Все клетки листа живут вместе: перепроверяем весь лист, чтобы вердикты соседей
    # тоже обновились (картинка кадра могла поменяться только у него).
    for attempt in range(1, max_regens + 1):
        if _stop_requested(project_id):
            return
        ctx.regen_round = attempt
        if on_progress is not None:
            on_progress(
                "regen",
                f"кадр #{ctx.number}: перегенерация {attempt}/{max_regens}",
                phase_done,
                phase_total,
            )
        try:
            await _regen_frame(project_id, ctx.number)
        except Exception as exc:  # noqa: BLE001 — один кадр не должен ронять прогон
            logger.exception("montage check: регенерация кадра #{} не удалась", ctx.number)
            results[ctx.number] = {
                **(results.get(ctx.number) or {}),
                "verdict": "fail",
                "problems": [
                    *list((results.get(ctx.number) or {}).get("problems") or []),
                    f"перегенерация не удалась: {exc}",
                ],
                "regen_round": attempt,
                "checked_at": _utc_now(),
            }
            await _store_results(project_id, {ctx.number: results[ctx.number]})
            return
        counters["regenerated"] += 1
        ctx.image = _frame_image(data_dir, ctx.number)
        await _store_history(
            project_id,
            [
                _history_entry(
                    ctx,
                    {"verdict": "unknown", "problems": []},
                    source="regen",
                )
            ],
        )
        # Перепроверка: пересобрать лист (картинки могли обновиться) и спросить агента.
        for _ in range(max_rechecks):
            if _stop_requested(project_id):
                return
            cells = [(c.image, f"{i} · кадр #{c.number}") for i, c in enumerate(sheet.cells, start=1)]
            while len(cells) < 4:
                cells.append((None, ""))
            compose_sheet(cells, sheet.path)
            fresh = await _check_sheet(
                project_id,
                sheet,
                agent_prompt=agent_prompt,
                task=str(settings.get("task") or ""),
            )
            counters["rechecks"] += 1
            results.update(fresh)
            await _store_results(project_id, fresh)
            if str((fresh.get(ctx.number) or {}).get("verdict")) == "pass":
                return
    return


def _stop_requested(project_id: int) -> bool:
    from app.services.step_cancel import is_stop_requested

    try:
        return bool(is_stop_requested(project_id))
    except Exception:  # noqa: BLE001 — проверка стопа не должна ронять прогон
        return False


# ------------------------------------------------------------------ прогон


async def run_image_check(
    project_id: int,
    *,
    frame_numbers: list[int] | None = None,
    scene: int | None = None,
    progress: Callable[[str, str, int, int], None] | None = None,
) -> dict[str, Any]:
    """Полный прогон проверки картинок. Пишет прогресс/результаты/историю в meta."""
    try:
        return await _run(project_id, frame_numbers=frame_numbers, scene=scene, progress=progress)
    except asyncio.CancelledError:
        await _patch_job(
            project_id,
            {"status": "cancelled", "finished_at": _utc_now(), "phase_detail": "остановлено"},
        )
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("montage check #{} упал", project_id)
        await _patch_job(
            project_id,
            {"status": "error", "finished_at": _utc_now(), "error": str(exc)},
        )
        return {"error": str(exc), "cancelled": False}


async def _run(
    project_id: int,
    *,
    frame_numbers: list[int] | None,
    scene: int | None,
    progress: Callable[[str, str, int, int], None] | None,
) -> dict[str, Any]:
    settings = await _read_settings_for(project_id)
    if settings.get("kind") != "images":
        raise RuntimeError("проверка видео ещё не включена")
    agent_prompt = load_agent_prompt(str(settings.get("agent") or "default"))

    data_dir, frames = await _frame_data(project_id)
    if not frames:
        raise RuntimeError("в проекте нет кадров")

    sheets, skipped = _split_sheets(
        data_dir,
        frames,
        frame_numbers=frame_numbers,
        scene=scene,
        frames_per_sheet=int(settings.get("frames_per_sheet") or 4),
    )
    total_frames = len([n for n in frames if (not frame_numbers or n in set(frame_numbers))])
    total_steps = max(1, len(sheets))
    await _patch_job(
        project_id,
        {
            "status": "running",
            "phase": "check",
            "phase_detail": "листы собраны",
            "done": 0,
            "total": total_steps,
            "error": None,
            "started_at": _utc_now(),
            "finished_at": None,
            "result": None,
        },
    )
    if progress is not None:
        progress("check", "листы собраны", 0, total_steps)

    results: dict[int, dict[str, Any]] = dict(skipped)
    if results:
        await _store_results(project_id, results)

    counters = {"regenerated": 0, "rechecks": 0}
    cancelled = False
    error: str | None = None
    history_batch: list[dict[str, Any]] = []

    for idx, sheet in enumerate(sheets, start=1):
        if _stop_requested(project_id):
            cancelled = True
            break
        try:
            verdicts = await _check_sheet(
                project_id,
                sheet,
                agent_prompt=agent_prompt,
                task=str(settings.get("task") or ""),
            )
        except Exception as exc:  # noqa: BLE001 — битый ответ не превращаем в fail
            logger.exception("montage check: лист {} не проверен", sheet.path.name)
            error = f"проверка листа {sheet.path.name}: {exc}"
            break
        results.update(verdicts)
        await _store_results(project_id, verdicts)
        for ctx in sheet.cells:
            result = results.get(ctx.number) or {}
            history_batch.append(_history_entry(ctx, result, source="generated"))
        await _store_history(project_id, history_batch)
        history_batch = []
        await _patch_job(
            project_id,
            {
                "phase": "check",
                "phase_detail": f"лист {idx}/{total_steps} (сцена {sheet.scene_no})",
                "done": idx,
                "total": total_steps,
            },
        )
        if progress is not None:
            progress("check", f"лист {idx}/{total_steps}", idx, total_steps)

    if not cancelled and error is None and str(settings.get("mode") or "notify") == "auto":
        failed = [n for n, r in results.items() if str(r.get("verdict")) == "fail"]
        by_number = {ctx.number: (sheet, ctx) for sheet in sheets for ctx in sheet.cells}
        for done_idx, number in enumerate(failed, start=1):
            if _stop_requested(project_id):
                cancelled = True
                break
            pair = by_number.get(number)
            if pair is None:
                continue
            sheet, ctx = pair
            await _regen_and_recheck(
                project_id,
                data_dir,
                sheet,
                ctx,
                results,
                settings=settings,
                agent_prompt=agent_prompt,
                on_progress=progress,
                counters=counters,
                phase_done=done_idx,
                phase_total=len(failed),
            )
            await _patch_job(
                project_id,
                {
                    "phase": "regen",
                    "phase_detail": f"кадр #{number} ({done_idx}/{len(failed)})",
                    "done": done_idx,
                    "total": len(failed),
                },
            )

    summary = {
        "total": total_frames,
        "pass": sum(1 for r in results.values() if str(r.get("verdict")) == "pass"),
        "fail": sum(1 for r in results.values() if str(r.get("verdict")) == "fail"),
        "skip": sum(1 for r in results.values() if str(r.get("verdict")) == "skip"),
        "sheets": len(sheets),
        "regenerated": counters["regenerated"],
        "rechecks": counters["rechecks"],
    }
    async with session_scope() as session:
        project = await session.get(Project, project_id)
        if project is not None:
            write_last_run(project, {"at": _utc_now(), **summary})
    status = "cancelled" if cancelled else ("error" if error else "done")
    await _patch_job(
        project_id,
        {
            "status": status,
            "phase": "done" if status == "done" else status,
            "phase_detail": "остановлено" if cancelled else (error or f"готово: {len(sheets)} листов"),
            "done": total_steps,
            "total": total_steps,
            "error": error,
            "finished_at": _utc_now(),
            "result": summary,
        },
    )
    logger.info(
        "montage check #{}: {} (листов {}, pass {}, fail {}, skip {}, regen {}, recheck {})",
        project_id,
        status,
        summary["sheets"],
        summary["pass"],
        summary["fail"],
        summary["skip"],
        summary["regenerated"],
        summary["rechecks"],
    )
    return {**summary, "cancelled": cancelled, "error": error, "frames": results}


# --------------------------------------------------- история версий картинки


def _archive_images(data_dir: Path, number: int) -> list[Path]:
    """Архивные версии картинки кадра из ``old/scenes`` (плоский layout и папки)."""
    root = data_dir / "old" / "scenes"
    if not root.is_dir():
        return []
    needle = f"frame_{number:03d}_"
    out: list[Path] = []
    for path in root.rglob("*"):
        try:
            if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
                continue
            if needle not in path.name:
                continue
            out.append(path)
        except OSError:
            continue
    out.sort(key=lambda p: _mtime(p), reverse=True)
    return out[:HISTORY_ARCHIVE_LIMIT]


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def list_frame_history(project, frame_number: int) -> list[dict[str, Any]]:
    """Версии картинки кадра: индекс из meta (свежие) + архив ``old/scenes`` + текущая."""
    number = int(frame_number)
    data_dir = Path(project.data_dir)
    current = _frame_image(data_dir, number)
    indexed = [dict(e) for e in read_history(project) if int(e.get("frame_number") or 0) == number]
    seen = {str(e.get("path") or ""): e for e in indexed}
    items: list[dict[str, Any]] = []
    for entry in indexed:
        path = Path(str(entry.get("path") or ""))
        items.append(
            {
                "frame_number": number,
                "shot": 1,
                "file": str(entry.get("file") or path.name),
                "path": str(path),
                "url": _file_url(path) if path.is_file() else None,
                "created_at": entry.get("created_at"),
                "source": str(entry.get("source") or "regen"),
                "verdict": str(entry.get("verdict") or "unknown"),
                "problems": list(entry.get("problems") or []),
                "active": False,
            }
        )
    for path in _archive_images(data_dir, number):
        if str(path) in seen:
            continue
        items.append(
            {
                "frame_number": number,
                "shot": 1,
                "file": path.name,
                "path": str(path),
                "url": _file_url(path),
                "created_at": datetime.fromtimestamp(_mtime(path), tz=UTC).isoformat(),
                "source": "archive",
                "verdict": "unknown",
                "problems": [],
                "active": False,
            }
        )
    if current is not None:
        known = next((item for item in items if str(item["path"]) == str(current)), None)
        if known is None:
            items.insert(
                0,
                {
                    "frame_number": number,
                    "shot": 1,
                    "file": current.name,
                    "path": str(current),
                    "url": _file_url(current),
                    "created_at": datetime.fromtimestamp(_mtime(current), tz=UTC).isoformat(),
                    "source": "generated",
                    "verdict": "unknown",
                    "problems": [],
                    "active": True,
                },
            )
        else:
            known["active"] = True
    return items


async def apply_history_image(session, project, frame_number: int, file: str) -> dict[str, Any]:
    """Поставить выбранную версию картинки активной (текущая уезжает в архив)."""
    number = int(frame_number)
    name = str(file or "").strip()
    if not name or Path(name).name != name:
        raise ValueError("ожидается имя файла из истории кадра")
    candidates = list_frame_history(project, number)
    entry = next((e for e in candidates if str(e.get("file") or "") == name), None)
    if entry is None:
        raise ValueError(f"файл «{name}» не найден в истории кадра #{number}")
    if entry.get("active"):
        return {"ok": True, "frame_number": number, "image_url": entry.get("url")}
    src = Path(str(entry.get("path") or ""))
    data_dir = Path(project.data_dir)
    if not src.is_file():
        raise ValueError("файл истории исчез с диска")
    if not _is_inside(src, data_dir):
        raise ValueError("файл вне папки проекта")
    scenes = data_dir / "scenes"
    scenes.mkdir(parents=True, exist_ok=True)
    suffix = src.suffix.lower() if src.suffix.lower() in IMAGE_SUFFIXES else ".png"
    dest = scenes / f"frame_{number:03d}_{uuid.uuid4().hex[:8]}{suffix}"
    shutil.copy2(src, dest)
    await finalize_scene_image(session, project, number, shot=1, new_path=dest)
    append_history(
        project,
        [
            {
                "frame_number": number,
                "shot": 1,
                "file": dest.name,
                "path": str(dest),
                "created_at": _utc_now(),
                "source": "regen",
                "verdict": str(entry.get("verdict") or "unknown"),
                "problems": list(entry.get("problems") or []),
                "active": True,
            }
        ],
    )
    return {"ok": True, "frame_number": number, "image_url": _file_url(dest)}


__all__ = [
    "apply_history_image",
    "build_sheet_prompt",
    "compose_sheet",
    "list_agents",
    "list_frame_history",
    "read_job",
    "read_last_run",
    "read_results",
    "read_settings",
    "run_image_check",
]
