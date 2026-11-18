"""Детерминированный валидатор кадров v2 — второй контур QC без LLM.

Правила и коды: ``docs/new-nodes-v2/CODES.md``. Контракт полей кадра и сцены:
``docs/new-nodes-v2/PLAN.md`` §3. Канон значений берётся из
``app.services.shot_canon_v2`` (импорт последним слоем, модуль может появиться
позже — тогда работает локальный fallback с тем же API).

Модуль ничего не чинит и никуда не пишет: на вход сцены и кадры (v2-словари),
на выход список :class:`Violation`. Порядок нарушений — по сцене, по порядку
кадров в сцене, затем по коду.

Что проверяется (и на чём именно):

* ``R-ENUM-PLAN/ANGLE/HEIGHT/OBJECT/TEMPLATE`` — значение не из канона.
  План и ракурс обязательные: пустое значение каноном не считается.
* ``R-CUT-ADJ`` — соседняя пара кадров из ``FORBIDDEN_ADJACENT`` (по рангам).
* ``R-PLAN-JUMP`` — ``|Δrank| >= 3`` у соседних активных кадров.
* ``R-PLAN-SAME`` — тот же план и тот же непустой объект у соседних кадров.
* ``R-SCENE-OPEN`` — первое место сцены сменилось, а её первый кадр не
  ДАЛЬНИЙ/ОБЩИЙ.
* ``R-VO-SHORT/LONG/CUTAWAY`` — длина куска по offsets или по тексту ``закадр``.
* ``R-VO-COVER`` — offsets кадров сцены не покрывают VO сцены без дыр/нахлёстов.
* ``R-VO-SCENE-LEN`` — VO сцены > 480.
* ``R-PARENT-MISSING/FOREIGN/CYCLE/SELF`` — ссылка на родителя.
* ``R-PROMPT-LEN`` — тело промта (минус ``style_block_len``) > 4000.
* ``R-STYLE-LEN`` — ``style_block_len`` > 700.
* ``R-PLACEHOLDER`` — служебная заглушка в действии/промте/закадре.
* ``R-FIELD-MISSING`` — пустые обязательные поля кадра.
* ``R-DUP-ACTION`` — одинаковое действие у двух активных кадров сцены.
* ``R-SHOT-CEILING`` — больше 6 активных кадров в сцене.
* ``R-REGISTRY-UNKNOWN`` — код персонажа/предмета не из реестра.
* ``R-STARTEND-MISSING`` — ``точность: старт/конец`` без блока или промта.

Границы: правила, которые в CODES.md считает LLM (``R-SEM-*``), здесь не
реализованы. ``R-STYLE-DRIFT`` включается только когда передан
``style_marker``: без маркера блок стиля не отличить от текста сцены.
"""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

try:  # канон делает параллельный агент; fallback — на случай его отсутствия
    from app.services.shot_canon_v2 import (
        ANGLE_CANON,
        FORBIDDEN_ADJACENT,
        HEIGHT_CANON,
        OBJECT_CANON,
        PLAN_CANON,
        PLAN_RANK,
        STEP_OVER_PAIRS,
        TEMPLATE_CANON,
        normalize_angle,
        normalize_height,
        normalize_plan,
        normalize_template,
        plan_rank,
    )

    CANON_FALLBACK = False
except ImportError:  # pragma: no cover - срабатывает только без модуля канона
    CANON_FALLBACK = True

    PLAN_CANON = (
        "ДАЛЬНИЙ",
        "ОБЩИЙ",
        "СРЕДНИЙ",
        "СРЕДНЕ-КРУПНЫЙ",
        "КРУПНЫЙ",
        "ДЕТАЛЬ",
    )
    PLAN_RANK = {name: rank for rank, name in enumerate(PLAN_CANON)}
    ANGLE_CANON = ("фронт", "3/4", "с плеча", "сверху", "снизу", "макро")
    HEIGHT_CANON = ("уровень глаз", "снизу вверх", "сверху вниз", "—")
    OBJECT_CANON = ("место", "тело", "двое", "предмет", "лицо", "взгляд")
    TEMPLATE_CANON = ("T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "X1", "X2")
    FORBIDDEN_ADJACENT = frozenset({(1, 2), (2, 1), (2, 3), (3, 2)})
    STEP_OVER_PAIRS = frozenset({(0, 2), (2, 0), (1, 3), (3, 1), (2, 4), (4, 2), (3, 5), (5, 3)})

    def _fallback_norm(value: Any) -> str:
        text = " ".join(str(value if value is not None else "").split())
        return text.replace("ё", "е").replace("Ё", "Е").casefold()

    def _fallback_lookup(value: Any, canon: Sequence[str]) -> str | None:
        key = _fallback_norm(value)
        for name in canon:
            if _fallback_norm(name) == key:
                return name
        return None

    def normalize_plan(value: Any) -> str | None:
        return _fallback_lookup(value, PLAN_CANON)

    def normalize_angle(value: Any) -> str | None:
        return _fallback_lookup(value, ANGLE_CANON)

    def normalize_height(value: Any) -> str | None:
        return _fallback_lookup(value, HEIGHT_CANON)

    def normalize_template(value: Any) -> str | None:
        return _fallback_lookup(value, TEMPLATE_CANON)

    def plan_rank(value: Any) -> int | None:
        name = normalize_plan(value)
        return PLAN_RANK.get(name) if name is not None else None


# --- Коды -----------------------------------------------------------------

#: 26 механических кодов из таблицы CODES.md (ровно в порядке документа).
CODES_V2_FROM_DOC: tuple[str, ...] = (
    "R-ENUM-PLAN",
    "R-ENUM-ANGLE",
    "R-ENUM-HEIGHT",
    "R-ENUM-OBJECT",
    "R-CUT-ADJ",
    "R-PLAN-JUMP",
    "R-PLAN-SAME",
    "R-SCENE-OPEN",
    "R-VO-SHORT",
    "R-VO-LONG",
    "R-VO-CUTAWAY",
    "R-VO-COVER",
    "R-VO-SCENE-LEN",
    "R-PARENT-MISSING",
    "R-PARENT-FOREIGN",
    "R-PARENT-CYCLE",
    "R-PARENT-SELF",
    "R-REGISTRY-UNKNOWN",
    "R-SHOT-CEILING",
    "R-PLACEHOLDER",
    "R-DUP-ACTION",
    "R-PROMPT-LEN",
    "R-STARTEND-MISSING",
    "R-FIELD-MISSING",
    "R-STYLE-LEN",
    "R-STYLE-DRIFT",
)

#: Коды из контракта задачи, которых нет в CODES.md.
EXTRA_CODES_V2: tuple[str, ...] = ("R-ENUM-TEMPLATE",)

#: Все коды, которые валидатор понимает: 26 документальных + R-ENUM-TEMPLATE.
ALL_CODES_V2: tuple[str, ...] = CODES_V2_FROM_DOC + EXTRA_CODES_V2

#: Коды CODES.md, которые сознательно не реализует этот модуль (пока нет).
NOT_IMPLEMENTED_CODES_V2: tuple[str, ...] = ()

#: Коды, которые реально проверяет :func:`validate` (27 штук).
IMPLEMENTED_CODES_V2: frozenset[str] = frozenset(ALL_CODES_V2) - frozenset(
    NOT_IMPLEMENTED_CODES_V2
)

#: Переэкспорт канона «через шаг»: пара разрешена только из этого списка.
ALLOWED_STEP_OVER_PAIRS = STEP_OVER_PAIRS

_RANK_TO_PLAN: dict[int, str] = {rank: name for name, rank in PLAN_RANK.items()}

# --- Лимиты из PLAN.md §4 -------------------------------------------------

VO_CHUNK_MIN = 26
VO_CHUNK_MAX = 80
VO_CUTAWAY_MIN = 10
VO_CUTAWAY_MAX = 30
VO_SCENE_MAX = 480
PROMPT_BODY_MAX = 4000
STYLE_BLOCK_MAX = 700
SHOTS_PER_SCENE_MAX = 6

#: Обязательные поля кадра по контракту PLAN.md §3.
REQUIRED_SHOT_FIELDS: tuple[str, ...] = (
    "id",
    "сцена",
    "план",
    "ракурс",
    "действие",
    "промт_картинки",
)

_PROMPT_FIELDS: tuple[str, ...] = ("промт_картинки", "промт_старт", "промт_конец")
_PLACEHOLDER_FIELDS: tuple[str, ...] = ("действие",) + _PROMPT_FIELDS + ("закадр",)
_PLACEHOLDER_TEXT_MARKERS: tuple[str, ...] = (
    "нет исходных данных",
    "нет данных",
    "не_заполнено",
    "не заполнено",
    "не указана",
    "не указано",
    "tbd",
    "todo",
    "placeholder",
    "заглушка",
)
_PLACEHOLDER_LINE = re.compile(
    r"(?:^|\n)\s*(?:картинка|промт|действие|закадр)\s*:\s*[—–-]\s*$",
    re.IGNORECASE,
)
_TRUE_TOKENS = frozenset({"1", "true", "да", "yes", "on", "истина"})
_FALSE_TOKENS = frozenset({"0", "false", "нет", "no", "off", "ложь"})
_HIDE_MARKS = ("удалён", "удален", "карантин")
_ACTIVE_MARK = "активен"
_NUMERIC = re.compile(r"^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$")


# --- Модель нарушения -----------------------------------------------------


@dataclass(frozen=True)
class Violation:
    """Одно механическое нарушение кадра или сцены."""

    code: str
    shot_id: str
    scene_id: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {
            "code": self.code,
            "shot_id": self.shot_id,
            "scene_id": self.scene_id,
            "detail": self.detail,
        }


# --- Мелкие утилиты -------------------------------------------------------


def _text(value: Any) -> str:
    """Строка без крайних пробелов; None → «». Числа и списки — как есть строкой."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value).strip()


def _norm(value: Any) -> str:
    """Ключ сравнения: пробелы схлопнуты, ё→е, регистр снят."""
    text = " ".join(_text(value).split())
    return text.replace("ё", "е").replace("Ё", "Е").casefold()


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    if isinstance(value, bool):
        return False
    return False


def _as_int(value: Any) -> int | None:
    """Целое из int/float/числовой строки; bool и мусор — None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value == value and abs(value) != float("inf") else None
    text = str(value).strip()
    if not text or _NUMERIC.match(text) is None:
        return None
    try:
        return int(float(text.replace(",", ".")))
    except (TypeError, ValueError):
        return None


def _flag(value: Any, *, default: bool = False) -> bool:
    """Флаг в стиле activity_flags: да/1/true → True, нет/0/false → False."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, float):
        return value != 0 and value == value
    text = str(value).strip().casefold()
    if not text:
        return default
    if text in _TRUE_TOKENS:
        return True
    if text in _FALSE_TOKENS:
        return False
    if _NUMERIC.match(text):
        try:
            return float(text.replace(",", ".")) != 0
        except ValueError:
            return default
    return default


def _first_value(record: Mapping[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        value = record.get(key)
        if not _blank(value):
            return value
    return None


# --- Активность кадра -----------------------------------------------------


def _explicitly_false(value: Any) -> bool:
    """Флаг явно выключен: False, 0, «0», «false», «нет»… Неизвестное — не выключен."""
    if value is None:
        return False
    if isinstance(value, bool):
        return not value
    if isinstance(value, (int, float)):
        return value == 0
    text = str(value).strip().casefold()
    if not text:
        return False
    if text in _FALSE_TOKENS:
        return True
    if _NUMERIC.match(text):
        try:
            return float(text.replace(",", ".")) == 0
        except ValueError:
            return False
    return False


def is_active_shot(shot: Any) -> bool:
    """Активный кадр — как ``shot_is_active`` в проекте, плюс непустое действие.

    Активен, если это словарь, у него непустое ``действие`` и он не скрыт:
    нет ``удалён: true`` / ``карантин: true`` / ``активен: false``.
    """
    if not isinstance(shot, Mapping):
        return False
    for mark in _HIDE_MARKS:
        if _flag(shot.get(mark)):
            return False
    if _ACTIVE_MARK in shot and _explicitly_false(shot.get(_ACTIVE_MARK)):
        return False
    return bool(_text(shot.get("действие")))


def _shot_id(shot: Mapping[str, Any]) -> str:
    return _text(shot.get("id"))


def _scene_ref(record: Mapping[str, Any]) -> str:
    return _text(_first_value(record, ("сцена", "scene", "scene_id")))


def _scene_key(record: Mapping[str, Any]) -> str:
    """Ключ сцены без учёта регистра/пробелов и ведущей «S» у «S3»."""
    key = _norm(_scene_ref(record))
    return re.sub(r"^s(?=\d)", "", key)


def _parent_ref(shot: Mapping[str, Any]) -> str:
    return _text(_first_value(shot, ("родитель", "parent_id", "parent")))


def _shot_place(shot: Mapping[str, Any]) -> str:
    return _text(_first_value(shot, ("место", "place")))


# --- Канон значений -------------------------------------------------------


def _normalize_object(value: Any) -> str | None:
    """Канон объекта: в shot_canon_v2 отдельного normalize_object нет."""
    key = _norm(value).replace("_", " ")
    for name in OBJECT_CANON:
        if _norm(name) == key:
            return name
    return None


def _canon_value(value: Any, canon: Sequence[str], normalizer: Any) -> str | None:
    """Канонное значение или None. Заглушки («—», «n/a») каноном не считаются."""
    text = _text(value)
    if not text:
        return None
    canonical = normalizer(text)
    if canonical is not None and canonical in canon:
        return canonical
    return None


def _adjacent_pair(
    records: Sequence[Mapping[str, Any]],
) -> Iterable[tuple[Mapping[str, Any], Mapping[str, Any]]]:
    """Соседние пары в исходном порядке без рекурсии и без strict-проверок."""
    return zip(records, records[1:], strict=False)


# --- Поля кадра -----------------------------------------------------------


def _chunk_offsets(shot: Mapping[str, Any]) -> tuple[int, int] | None:
    """Offsets куска закадра: ``закадр``/``vo``/``offsets`` → (start, end)."""
    raw = _first_value(shot, ("закадр", "vo", "offsets", "vo_offsets"))
    if not isinstance(raw, Mapping):
        return None
    start = _as_int(_first_value(raw, ("start_char", "start", "from", "начало")))
    end = _as_int(_first_value(raw, ("end_char", "end", "to", "конец")))
    if start is None or end is None:
        return None
    return start, end


def _chunk_length(shot: Mapping[str, Any]) -> int | None:
    """Длина куска: из offsets, иначе из текста ``закадр``/``vo_текст``."""
    offsets = _chunk_offsets(shot)
    if offsets is not None:
        return max(0, offsets[1] - offsets[0])
    raw = _first_value(shot, ("закадр", "vo_текст", "vo_text", "во"))
    if isinstance(raw, str):
        return len(raw)
    return None


def _scene_vo_bounds(scene: Mapping[str, Any]) -> tuple[int, int] | None:
    """Границы VO сцены: абсолютные offsets или 0..длина."""
    vo = scene.get("vo")
    if isinstance(vo, Mapping):
        start = _as_int(_first_value(vo, ("start_char", "start", "from")))
        end = _as_int(_first_value(vo, ("end_char", "end", "to")))
        if start is not None and end is not None:
            return start, end
        text = _first_value(vo, ("текст", "text"))
        if isinstance(text, str):
            return 0, len(text)
    length = _as_int(_first_value(scene, ("длина_vo", "длина закадра", "vo_len")))
    if length is not None:
        return 0, length
    if isinstance(vo, str):
        return 0, len(vo)
    if isinstance(vo, int) and not isinstance(vo, bool):
        return 0, vo
    text = _first_value(scene, ("закадр", "vo_текст", "vo_text"))
    if isinstance(text, str):
        return 0, len(text)
    return None


def _has_placeholder(value: Any) -> bool:
    """Служебная заглушка в поле: пустое значение не заглушка (это R-FIELD-MISSING)."""
    text = _text(value)
    if not text:
        return False
    key = _norm(text)
    if key in {"—", "–", "-", "…", "...", "n/a", "nan", "none", "null"}:
        return True
    folded = text.casefold()
    if any(marker in folded for marker in _PLACEHOLDER_TEXT_MARKERS):
        return True
    return bool(_PLACEHOLDER_LINE.search(text))


# --- Валидация ------------------------------------------------------------


def validate(
    scenes: list[dict] | None,
    shots: list[dict] | None,
    *,
    style_block_len: int | None = None,
    registry: dict | None = None,
    style_marker: str | None = None,
) -> list[Violation]:
    """Проверить кадры v2 механическими правилами.

    :param scenes: сцены по контракту PLAN.md §3 (``id``, ``vo``/``длина_vo``, ``место``).
    :param shots: кадры по контракту PLAN.md §3.
    :param style_block_len: длина STYLE-блока проекта; если передана, вычитается
        из тела промтов и проверяется лимит R-STYLE-LEN.
    :param registry: ``{"персонажи": [...], "предметы": [...]}`` с ``code`` у элементов.
    :param style_marker: строка-маркер STYLE-блока (например ``"Final style lock:"``);
        если передана, в каждом непустом промте ищется блок, иначе — ``R-STYLE-DRIFT``.
    :return: список нарушений, отсортированный по сцене, порядку кадров, коду.
    """
    scene_list = [scene for scene in (scenes or []) if isinstance(scene, Mapping)]
    shot_list = [shot for shot in (shots or []) if isinstance(shot, Mapping)]

    scene_order: dict[str, int] = {}
    scene_by_key: dict[str, Mapping[str, Any]] = {}
    for position, scene in enumerate(scene_list):
        key = _scene_key({"сцена": scene.get("id", scene.get("scene_id"))})
        if key and key not in scene_order:
            scene_order[key] = position
            scene_by_key[key] = scene

    grouped: dict[str, list[tuple[int, Mapping[str, Any]]]] = defaultdict(list)
    appearance: list[str] = []
    for position, shot in enumerate(shot_list):
        key = _scene_key(shot)
        if key not in grouped:
            appearance.append(key)
        grouped[key].append((position, shot))

    ordered_keys = [key for key in scene_order] + [key for key in appearance if key not in scene_order]
    scene_position = {key: index for index, key in enumerate(ordered_keys)}

    found: list[tuple[tuple[int, int, str, int], Violation]] = []
    sequence = 0

    def report(
        code: str,
        scene_pos: int,
        shot_pos: int,
        *,
        shot_id: str = "",
        scene_id: str = "",
        detail: str = "",
    ) -> None:
        nonlocal sequence
        found.append(
            (
                (scene_pos, shot_pos, code, sequence),
                Violation(code=code, shot_id=shot_id, scene_id=scene_id, detail=detail),
            )
        )
        sequence += 1

    shots_by_id: dict[str, Mapping[str, Any]] = {}
    for shot in shot_list:
        shot_id = _shot_id(shot)
        if shot_id and shot_id not in shots_by_id:
            shots_by_id[shot_id] = shot

    # Позиции кадров внутри сцены нужны всем проверкам: считаем один раз.
    shot_positions: dict[int, int] = {}
    for key in ordered_keys:
        for index, (_, shot) in enumerate(grouped.get(key, [])):
            shot_positions[id(shot)] = index

    previous_place: str | None = None
    for key in ordered_keys:
        scene_position_value = scene_position[key]
        items = grouped.get(key, [])
        scene = scene_by_key.get(key)
        scene_id = _text(scene.get("id")) if scene is not None else key
        active = [(position, shot) for position, shot in items if is_active_shot(shot)]

        for _, shot in items:
            shot_id = _shot_id(shot)
            shot_pos = shot_positions.get(id(shot), 0)

            # --- пустые обязательные поля ---
            for field in REQUIRED_SHOT_FIELDS:
                if _blank(shot.get(field)):
                    report(
                        "R-FIELD-MISSING",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="пустое обязательное поле: %s" % field,
                    )

            # --- enum ---
            if "план" in shot:
                canonical = _canon_value(shot.get("план"), PLAN_CANON, normalize_plan)
                if canonical is None:
                    report(
                        "R-ENUM-PLAN",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="план «%s» не из канона" % _text(shot.get("план")),
                    )
            if "ракурс" in shot:
                canonical = _canon_value(shot.get("ракурс"), ANGLE_CANON, normalize_angle)
                if canonical is None:
                    report(
                        "R-ENUM-ANGLE",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="ракурс «%s» не из канона" % _text(shot.get("ракурс")),
                    )
            if not _blank(shot.get("высота")):
                canonical = _canon_value(shot.get("высота"), HEIGHT_CANON, normalize_height)
                if canonical is None:
                    report(
                        "R-ENUM-HEIGHT",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="высота «%s» не из канона" % _text(shot.get("высота")),
                    )
            if not _blank(shot.get("объект")):
                canonical = _canon_value(shot.get("объект"), OBJECT_CANON, _normalize_object)
                if canonical is None:
                    report(
                        "R-ENUM-OBJECT",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="объект «%s» не из канона" % _text(shot.get("объект")),
                    )
            if not _blank(shot.get("шаблон")):
                canonical = _canon_value(shot.get("шаблон"), TEMPLATE_CANON, normalize_template)
                if canonical is None:
                    report(
                        "R-ENUM-TEMPLATE",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="шаблон «%s» не из канона" % _text(shot.get("шаблон")),
                    )

            # --- длина тела промта (минус style-блок) ---
            for field in _PROMPT_FIELDS:
                prompt = shot.get(field)
                if not isinstance(prompt, str) or not prompt.strip():
                    continue
                body_len = len(prompt)
                if style_block_len:
                    body_len = max(0, body_len - int(style_block_len))
                if body_len > PROMPT_BODY_MAX:
                    report(
                        "R-PROMPT-LEN",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="%s: тело %d символов > %d" % (field, body_len, PROMPT_BODY_MAX),
                    )

            # --- дрейф стиля у детей и мастера ---
            if style_marker:
                marker = str(style_marker)
                missing = [
                    field
                    for field in _PROMPT_FIELDS
                    if isinstance(shot.get(field), str)
                    and shot.get(field).strip()
                    and marker not in shot[field]
                ]
                if missing:
                    report(
                        "R-STYLE-DRIFT",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="в промте нет STYLE-блока (%s): %s"
                        % (marker, ", ".join(missing)),
                    )

            # --- заглушки ---
            for field in _PLACEHOLDER_FIELDS:
                if _has_placeholder(shot.get(field)):
                    report(
                        "R-PLACEHOLDER",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="заглушка в поле %s" % field,
                    )

            # --- точность старт/конец ---
            precision = _norm(shot.get("точность")).replace(" / ", "/")
            if precision == "старт/конец":
                missing = [
                    field
                    for field in ("старт", "конец", "промт_старт", "промт_конец")
                    if _blank(shot.get(field))
                ]
                if missing:
                    report(
                        "R-STARTEND-MISSING",
                        scene_position_value,
                        shot_pos,
                        shot_id=shot_id,
                        scene_id=scene_id,
                        detail="точность старт/конец, пусто: %s" % ", ".join(missing),
                    )

        # --- закадр: длины кусков, перебивки, длина сцены ---
        for _, shot in active:
            shot_id = _shot_id(shot)
            shot_pos = shot_positions.get(id(shot), 0)
            length = _chunk_length(shot)
            if length is not None:
                cutaway = _flag(shot.get("перебивка"))
                if cutaway:
                    if length and not (VO_CUTAWAY_MIN <= length <= VO_CUTAWAY_MAX):
                        report(
                            "R-VO-CUTAWAY",
                            scene_position_value,
                            shot_pos,
                            shot_id=shot_id,
                            scene_id=scene_id,
                            detail="кусок перебивки %d символов, нужно %d–%d"
                            % (length, VO_CUTAWAY_MIN, VO_CUTAWAY_MAX),
                        )
                else:
                    if length < VO_CHUNK_MIN:
                        report(
                            "R-VO-SHORT",
                            scene_position_value,
                            shot_pos,
                            shot_id=shot_id,
                            scene_id=scene_id,
                            detail="кусок %d символов < %d" % (length, VO_CHUNK_MIN),
                        )
                    if length > VO_CHUNK_MAX:
                        report(
                            "R-VO-LONG",
                            scene_position_value,
                            shot_pos,
                            shot_id=shot_id,
                            scene_id=scene_id,
                            detail="кусок %d символов > %d" % (length, VO_CHUNK_MAX),
                        )

        bounds = _scene_vo_bounds(scene) if scene is not None else None
        if bounds is not None and bounds[1] - bounds[0] > VO_SCENE_MAX:
            report(
                "R-VO-SCENE-LEN",
                scene_position_value,
                -1,
                scene_id=scene_id,
                detail="VO сцены %d символов > %d" % (bounds[1] - bounds[0], VO_SCENE_MAX),
            )

        # --- покрытие VO сцены offsets -----
        if bounds is not None and active:
            offsets = [_chunk_offsets(shot) for _, shot in active]
            if all(offset is not None for offset in offsets):
                intervals = sorted((start, end) for start, end in offsets)  # type: ignore[misc]
                vo_start, vo_end = bounds
                problems: list[str] = []
                cursor = vo_start
                for start, end in intervals:
                    if start > cursor:
                        problems.append("дыра %d..%d" % (cursor, start))
                    elif start < cursor:
                        problems.append("нахлёст %d..%d" % (start, cursor))
                    cursor = max(cursor, end)
                if cursor < vo_end:
                    problems.append("не покрыт хвост %d..%d" % (cursor, vo_end))
                if cursor > vo_end:
                    problems.append("выход за VO до %d" % cursor)
                if problems:
                    report(
                        "R-VO-COVER",
                        scene_position_value,
                        -1,
                        scene_id=scene_id,
                        detail="покрытие VO: %s" % "; ".join(problems),
                    )

        # --- потолок кадров ---
        if len(active) > SHOTS_PER_SCENE_MAX:
            report(
                "R-SHOT-CEILING",
                scene_position_value,
                -1,
                scene_id=scene_id,
                detail="активных кадров %d > %d" % (len(active), SHOTS_PER_SCENE_MAX),
            )

        # --- монтажные пары ---
        active_shots = [shot for _, shot in active]
        for previous, current in _adjacent_pair(active_shots):
            previous_rank = plan_rank(previous.get("план"))
            current_rank = plan_rank(current.get("план"))
            current_id = _shot_id(current)
            current_pos = shot_positions.get(id(current), 0)
            if previous_rank is None or current_rank is None:
                continue
            if (previous_rank, current_rank) in FORBIDDEN_ADJACENT:
                report(
                    "R-CUT-ADJ",
                    scene_position_value,
                    current_pos,
                    shot_id=current_id,
                    scene_id=scene_id,
                    detail="запрещённая склейка %s → %s"
                    % (
                        _RANK_TO_PLAN.get(previous_rank, previous_rank),
                        _RANK_TO_PLAN.get(current_rank, current_rank),
                    ),
                )
            if abs(current_rank - previous_rank) >= 3:
                report(
                    "R-PLAN-JUMP",
                    scene_position_value,
                    current_pos,
                    shot_id=current_id,
                    scene_id=scene_id,
                    detail="прыжок %s → %s: |Δrank| = %d"
                    % (
                        _RANK_TO_PLAN.get(previous_rank, previous_rank),
                        _RANK_TO_PLAN.get(current_rank, current_rank),
                        abs(current_rank - previous_rank),
                    ),
                )
            previous_object = _norm(previous.get("объект"))
            current_object = _norm(current.get("объект"))
            if previous_rank == current_rank and previous_object and previous_object == current_object:
                report(
                    "R-PLAN-SAME",
                    scene_position_value,
                    current_pos,
                    shot_id=current_id,
                    scene_id=scene_id,
                    detail="два раза подряд %s при объекте «%s»"
                    % (_RANK_TO_PLAN.get(current_rank, current_rank), current_object),
                )

        # --- одинаковое действие в сцене ---
        seen_actions: dict[str, str] = {}
        for _, shot in active:
            action_key = _norm(shot.get("действие"))
            shot_id = _shot_id(shot)
            shot_pos = shot_positions.get(id(shot), 0)
            if not action_key:
                continue
            if action_key in seen_actions:
                report(
                    "R-DUP-ACTION",
                    scene_position_value,
                    shot_pos,
                    shot_id=shot_id,
                    scene_id=scene_id,
                    detail="действие повторяет кадр %s" % seen_actions[action_key],
                )
            else:
                seen_actions[action_key] = shot_id

        # --- родитель ---
        for _, shot in active:
            shot_id = _shot_id(shot)
            shot_pos = shot_positions.get(id(shot), 0)
            parent_id = _parent_ref(shot)
            if not parent_id:
                continue
            if parent_id == shot_id:
                report(
                    "R-PARENT-SELF",
                    scene_position_value,
                    shot_pos,
                    shot_id=shot_id,
                    scene_id=scene_id,
                    detail="кадр %s ссылается сам на себя" % shot_id,
                )
                continue
            parent = shots_by_id.get(parent_id)
            if parent is None:
                report(
                    "R-PARENT-MISSING",
                    scene_position_value,
                    shot_pos,
                    shot_id=shot_id,
                    scene_id=scene_id,
                    detail="родитель %s не найден" % parent_id,
                )
                continue
            if _scene_key(parent) != _scene_key(shot):
                report(
                    "R-PARENT-FOREIGN",
                    scene_position_value,
                    shot_pos,
                    shot_id=shot_id,
                    scene_id=scene_id,
                    detail="родитель %s из чужой сцены %s" % (parent_id, _scene_ref(parent) or "?"),
                )
            if _in_parent_cycle(shot_id, shots_by_id):
                report(
                    "R-PARENT-CYCLE",
                    scene_position_value,
                    shot_pos,
                    shot_id=shot_id,
                    scene_id=scene_id,
                    detail="цикл по родителям от %s" % shot_id,
                )

        # --- реестр персонажей и предметов ---
        if registry is not None:
            character_codes = _registry_codes(registry.get("персонажи"))
            item_codes = _registry_codes(registry.get("предметы"))
            for _, shot in active:
                shot_id = _shot_id(shot)
                shot_pos = shot_positions.get(id(shot), 0)
                if character_codes is not None:
                    for code in _shot_codes(shot.get("персонажи")):
                        if code.casefold() not in character_codes:
                            report(
                                "R-REGISTRY-UNKNOWN",
                                scene_position_value,
                                shot_pos,
                                shot_id=shot_id,
                                scene_id=scene_id,
                                detail="персонаж %s не из реестра" % code,
                            )
                if item_codes is not None:
                    for code in _shot_codes(shot.get("предметы")):
                        if code.casefold() not in item_codes:
                            report(
                                "R-REGISTRY-UNKNOWN",
                                scene_position_value,
                                shot_pos,
                                shot_id=shot_id,
                                scene_id=scene_id,
                                detail="предмет %s не из реестра" % code,
                            )

        # --- открытие сцены на новом месте ---
        if scene is not None:
            place = _text(scene.get("место")) or (_shot_place(active[0][1]) if active else "")
            new_place = previous_place is not None and bool(place) and _norm(place) != _norm(previous_place)
            if new_place and active:
                first = active[0][1]
                first_rank = plan_rank(first.get("план"))
                if first_rank is not None and first_rank >= 2:
                    report(
                        "R-SCENE-OPEN",
                        scene_position_value,
                        shot_positions.get(id(first), 0),
                        shot_id=_shot_id(first),
                        scene_id=scene_id,
                        detail="новое место «%s» открыто планом %s"
                        % (place, _RANK_TO_PLAN.get(first_rank, first_rank)),
                    )
            if place:
                previous_place = place

    # --- стиль проекта ---
    if style_block_len is not None and int(style_block_len) > STYLE_BLOCK_MAX:
        report(
            "R-STYLE-LEN",
            len(ordered_keys),
            -1,
            detail="STYLE-блок %d символов > %d" % (int(style_block_len), STYLE_BLOCK_MAX),
        )

    found.sort(key=lambda item: item[0])
    return [violation for _, violation in found]


def _in_parent_cycle(shot_id: str, shots_by_id: Mapping[str, Mapping[str, Any]]) -> bool:
    """Есть ли цикл в цепочке родителей, начиная с кадра ``shot_id``."""
    seen = {shot_id}
    current = shots_by_id.get(shot_id)
    while current is not None:
        parent_id = _parent_ref(current)
        if not parent_id:
            return False
        if parent_id in seen:
            return True
        seen.add(parent_id)
        current = shots_by_id.get(parent_id)
    return False


def _registry_codes(entries: Any) -> frozenset[str] | None:
    """Множество кодов реестра в casefold или None, если раздела нет."""
    if entries is None:
        return None
    codes: set[str] = set()
    if isinstance(entries, Mapping):
        iterable: Iterable[Any] = list(entries.keys())
    elif isinstance(entries, (str, bytes)):
        iterable = [entries]
    elif isinstance(entries, Iterable):
        iterable = entries
    else:
        iterable = []
    for entry in iterable:
        code = _first_value(entry, ("code", "код", "id")) if isinstance(entry, Mapping) else entry
        text = _text(code)
        if text:
            codes.add(text.casefold())
    return frozenset(codes)


def _shot_codes(values: Any) -> list[str]:
    """Коды персонажей/предметов кадра: list[dict], list[str], одна строка."""
    if values is None:
        return []
    if isinstance(values, (Mapping, str)):
        values = [values]
    codes: list[str] = []
    for value in values:
        code = _first_value(value, ("code", "код", "id")) if isinstance(value, Mapping) else value
        text = _text(code)
        if text:
            codes.append(text)
    return codes
