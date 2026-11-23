"""Контракт ответа агента проверки картинок монтажа (``vp.montage_check.v1``).

Один лист 2×2 = один ответ: ``cells`` ровно по клеткам листа. ``frame`` — позиция
клетки (1..4, слева сверху → справа снизу), а НЕ номер кадра проекта: номера
проекта уходят в промт, а вердикт привязывается к клетке. Так ответ нельзя
перепутать между листами.

Почему контракт, а не «что вернула модель»: мусор/эхо/пустой JSON не должны
превращаться в «fail» и запускать платную перегенерацию (спека
``contracts/check_report.py``: битый ответ проверки ≠ вердикт fail).

См. ``docs/MONTAGE-IMAGE-CHECK.md`` §5-§6.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.contracts.base import LlmContract

#: Максимум клеток в листе (2×2).
MAX_CELLS = 4


class MontageCheckCell(BaseModel):
    """Вердикт по одной клетке листа."""

    frame: int = Field(description="Позиция клетки в листе: 1..4 (не номер кадра проекта)")
    verdict: Literal["pass", "fail"]
    # 0..1; None — модель не оценивала числом.
    score: float | None = Field(default=None, ge=0.0, le=1.0)
    prompt_match: bool = Field(
        default=True,
        description="Совпадает ли картинка с промтом кадра (композиция/герой/фон/реквизит)",
    )
    problems: list[str] = Field(
        default_factory=list,
        description="Короткие фразы по-русски: что не так на картинке",
    )


class MontageCheckReport(BaseModel):
    """Ответ проверки одного листа."""

    cells: list[MontageCheckCell]
    summary: str = ""

    @field_validator("cells")
    @classmethod
    def _cells_bounds(cls, value: list[MontageCheckCell]) -> list[MontageCheckCell]:
        if not value:
            raise ValueError("cells пуст — нужен вердикт хотя бы по одной клетке листа")
        if len(value) > MAX_CELLS:
            raise ValueError(f"cells: {len(value)} > {MAX_CELLS} клеток в листе 2×2")
        return value


MONTAGE_CHECK = LlmContract(name="vp.montage_check.v1", model=MontageCheckReport)
