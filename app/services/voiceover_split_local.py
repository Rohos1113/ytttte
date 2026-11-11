"""Локальная разбивка voiceover → xlsx (fallback если GPT не записал R49).

GPT часто кладёт блоки в текст ответа (через «-»), а xlsx возвращает
без изменений — особенно со старым default.md. Тогда пишем блоки сами.
"""

from __future__ import annotations

import re
from pathlib import Path

_MIN_BLOCK_LEN = 8


def parse_dash_separated_blocks(text: str) -> list[str]:
    """Блоки из ответа GPT: разделитель «-» на отдельной строке или inline."""
    raw = (text or "").strip()
    if not raw:
        return []
    parts = re.split(r"(?:\n\s*-\s*\n|\n\s*-\s+|\r\n\s*-\s+)", raw)
    if len(parts) <= 1 and " - " in raw:
        parts = raw.split(" - ")
    out: list[str] = []
    for p in parts:
        s = " ".join(p.split())
        if len(s) >= _MIN_BLOCK_LEN:
            out.append(s)
    return out


def split_voiceover_locally(
    text: str,
    *,
    target_len: int = 70,
    min_chars: int | None = None,
    max_chars: int | None = None,
) -> list[str]:
    """Резервная смысловая разбивка с сохранением текста и заданных размеров."""
    raw = " ".join((text or "").split())
    if len(raw) < _MIN_BLOCK_LEN:
        return []
    target = max(1, int(target_len))
    lower = max(_MIN_BLOCK_LEN, int(min_chars or _MIN_BLOCK_LEN))
    upper = max(lower, int(max_chars or (target + 30)))
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+", raw) if s.strip()]
    blocks: list[str] = []
    buf = ""
    for sent in sentences:
        while len(sent) > upper:
            cut = sent.rfind(" ", 0, upper + 1)
            if cut < lower:
                cut = sent.find(" ", upper)
            if cut <= 0:
                break
            piece, sent = sent[:cut].strip(), sent[cut:].strip()
            if piece:
                if buf and len(buf) + 1 + len(piece) <= upper:
                    buf = f"{buf} {piece}"
                else:
                    if buf:
                        blocks.append(buf)
                    buf = piece
                if len(buf) >= lower:
                    blocks.append(buf)
                    buf = ""
        if not buf:
            buf = sent
        elif len(buf) + 1 + len(sent) <= upper:
            buf = f"{buf} {sent}"
        else:
            blocks.append(buf)
            buf = sent
    if buf:
        blocks.append(buf)

    # Сливаем слишком короткие хвосты с соседями без изменения порядка/содержимого.
    i = 0
    while len(blocks) > 1 and i < len(blocks):
        if len(blocks[i]) >= lower:
            i += 1
            continue
        if i == 0:
            if len(blocks[0]) + 1 + len(blocks[1]) <= upper:
                blocks[1] = f"{blocks[0]} {blocks[1]}"
                blocks.pop(0)
            else:
                i += 1
        elif len(blocks[i - 1]) + 1 + len(blocks[i]) <= upper:
            blocks[i - 1] = f"{blocks[i - 1]} {blocks[i]}"
            blocks.pop(i)
            i -= 1
        else:
            i += 1
    return [block for block in blocks if block]


def write_voiceover_blocks_to_xlsx(xlsx_path: Path, blocks: list[str]) -> int:
    """Пишет блоки в строку 49 листа «план», колонки C..N."""
    from loguru import logger
    from openpyxl import load_workbook

    from app.services.xlsx_v8_import import ROW_VOICEOVER_V8, SHEET_PLAN_V8, _resolve_plan_sheet

    if not blocks:
        return 0
    path = Path(xlsx_path)
    wb = load_workbook(filename=str(path))
    ws = _resolve_plan_sheet(wb)
    if ws is None:
        if SHEET_PLAN_V8 in wb.sheetnames:
            ws = wb[SHEET_PLAN_V8]
        else:
            ws = wb.active
            ws.title = SHEET_PLAN_V8
    for i, block in enumerate(blocks):
        ws.cell(row=ROW_VOICEOVER_V8, column=3 + i, value=block)
    wb.save(path)
    logger.info(
        "voiceover_split_local: wrote {} blocks to {} R{}",
        len(blocks),
        path.name,
        ROW_VOICEOVER_V8,
    )
    return len(blocks)
