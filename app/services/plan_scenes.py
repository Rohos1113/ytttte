"""Резка плана на сцены: разметка пунктов, парсинг ответа модели, гейт R-PLAN-COVER.

Модуль — только чистые функции: модель здесь не вызывается. Вызов модели делает
агент группы «Кино по плану» (CONTRACT.md, раздел 4).
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Sequence
from typing import Any

logger = logging.getLogger(__name__)

# Контракт: число сцен 1..40 (CONTRACT.md, раздел 4).
MAX_SCENES = 40

# Сцена-врезка (``plan_to_scenes.md``, правило 13): резкое или важное место
# внутри сцены показывается отдельной сценой на 1–2 кадра, после неё идёт
# продолжение прерванной сцены с прежним местом и прежним фоном.
SCENE_INSERT = "сцена_вставка"
SCENE_RETURN_TO = "возврат_к_сцене"
SCENE_KEEP_BACKGROUND = "продолжение_фона"
SCENE_MAX_SHOTS = "кадров_макс"
INSERT_SCENE_KEYS: tuple[str, ...] = (
    SCENE_INSERT,
    SCENE_RETURN_TO,
    SCENE_KEEP_BACKGROUND,
    SCENE_MAX_SHOTS,
)
MAX_INSERT_SHOTS = 2

# Время суток — часть локации: то же место днём и ночью дают разные фоны.
# Список повторяет ``plan_cinema/nodes.py:_TIME_WORDS``; здесь он нужен только
# мягкой проверке пары «врезка → возврат».
_TIME_WORDS: tuple[str, ...] = (
    "рассвет",
    "утро",
    "день",
    "полдень",
    "вечер",
    "сумерки",
    "закат",
    "ночь",
    "полночь",
)

_NUMBERED_RE = re.compile(r"^\s*\d+[.)]\s*(.*)$")
_BULLET_RE = re.compile(r"^\s*[-–—•*]\s+(.*)$")
_TERMINAL = (".", "!", "?", "…")


class PlanScenesError(ValueError):
    """Ответ модели не соответствует контракту раздела 4."""


# ---------------------------------------------------------------------------
# Разметка плана
# ---------------------------------------------------------------------------


def num_plan_points(plan_text: str) -> list[tuple[str, str]]:
    """Детерминированно разметить план на пункты ``P1…Pn``.

    Режим выбирается по тексту, пунктуация не выдумывается:
    * нумерованный список (≥2 строки вида ``1.`` / ``1)``) — режем по номерам,
      строки-продолжения и подпункты приклеиваются к текущему пункту;
    * маркированный список (≥2 строки вида ``-``) — режем по маркерам;
    * иначе — по абзацам (пустая строка), абзац из строк-предложений
      (каждая кончается точкой/восклицанием) режется построчно.

    Пустые абзацы пропускаются, заголовок перед списком (строка с ``:``)
    пунктом не считается. Служебные абзацы (заголовки глав, «Пролог», титр,
    название произведения, подпись, авторская ремарка) в пункты не попадают
    и кодов ``P*`` не получают — см. :func:`split_plan_items`.
    Возвращает ``[(код, текст), ...]``.
    """

    _, content = split_plan_items(plan_text)
    return [(f"P{pos}", text) for pos, text in enumerate(content, 1)]


def split_plan_items(plan_text: str) -> tuple[list[str], list[str]]:
    """Разделить пункты плана на служебные и содержательные.

    Служебные абзацы — заголовки глав/частей и «Пролог», «Картинка для
    привлечения внимания», название произведения в кавычках, подпись/эпиграф,
    строка метаданных и авторская ремарка в начале текста (см.
    :func:`is_service_paragraph`). Возвращает ``(служебные, содержательные)``
    в исходном порядке текста. Именно содержательные пункты получают
    коды ``P1…Pn``.
    """

    text = (plan_text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return [], []

    service: list[str] = []
    content: list[str] = []
    in_preface = True
    for item in _raw_plan_items(text.split("\n")):
        cleaned = _collapse(item)
        if not cleaned:
            continue
        if is_service_paragraph(cleaned, in_preface=in_preface):
            service.append(cleaned)
            if _is_chapter_heading(cleaned):
                in_preface = False
            continue
        in_preface = False
        content.append(cleaned)
    return service, content


def _raw_plan_items(lines: Sequence[str]) -> list[str]:
    """Выбрать режим разбиения по тексту: номера, маркеры или абзацы."""

    numbered = sum(1 for line in lines if _numbered_text(line))
    if numbered >= 2:
        return _numbered_items(lines)
    bullets = sum(1 for line in lines if _BULLET_RE.match(line))
    if bullets >= 2:
        return _bullet_items(lines)
    return _paragraph_items(lines)


def format_plan_points(points: Sequence[tuple[str, str]]) -> str:
    """Готовый текст плана с номерами — его отдаём модели в запросе."""

    return "\n".join(f"{code}: {text}" for code, text in points)


def _numbered_text(line: str) -> str:
    match = _NUMBERED_RE.match(line)
    return match.group(1).strip() if match else ""


def _numbered_items(lines: Sequence[str]) -> list[str]:
    items: list[str] = []
    current: list[str] | None = None
    preamble: list[str] = []
    for line in lines:
        text = _numbered_text(line)
        if text or (current is not None and _NUMBERED_RE.match(line)):
            if current is not None:
                items.append(" ".join(current))
            current = [text]
            continue
        if current is None:
            if line.strip():
                preamble.append(line.strip())
            continue
        bullet = _BULLET_RE.match(line)
        if bullet:
            current.append(bullet.group(1).strip())
        elif line.strip():
            current.append(line.strip())
    if current is not None:
        items.append(" ".join(current))
    preamble_text = " ".join(preamble).strip()
    if preamble_text and not _looks_like_heading(preamble_text):
        items.insert(0, preamble_text)
    return items


def _bullet_items(lines: Sequence[str]) -> list[str]:
    items: list[str] = []
    current: list[str] | None = None
    preamble: list[str] = []
    for line in lines:
        bullet = _BULLET_RE.match(line)
        if bullet:
            if current is not None:
                items.append(" ".join(current))
            current = [bullet.group(1).strip()]
            continue
        if current is None:
            if line.strip():
                preamble.append(line.strip())
            continue
        if line.strip():
            current.append(line.strip())
    if current is not None:
        items.append(" ".join(current))
    preamble_text = " ".join(preamble).strip()
    if preamble_text and not _looks_like_heading(preamble_text):
        items.insert(0, preamble_text)
    return items


def _paragraph_items(lines: Sequence[str]) -> list[str]:
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if line.strip():
            current.append(line.strip())
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)
    if blocks and _looks_like_heading(" ".join(blocks[0])):
        blocks.pop(0)
    items: list[str] = []
    for block in blocks:
        if _line_per_point(block):
            items.extend(block)
        else:
            items.append(" ".join(block))
    return items


def _line_per_point(block: Sequence[str]) -> bool:
    return len(block) >= 2 and all(line.rstrip().endswith(_TERMINAL) for line in block)


def _looks_like_heading(text: str) -> bool:
    return text.rstrip().endswith(":") and len(text.split()) <= 8


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


# ---------------------------------------------------------------------------
# Служебные абзацы: заголовки, титры, название, подпись, ремарка автора
# ---------------------------------------------------------------------------

# «Глава I», «Глава 3. Маледиктус», «Часть вторая», «Пролог», «Эпилог»,
# «Предисловие автора». После ключевого слова допускается только номер
# (римский/арабский/порядковое слово) и короткий заголовок без точки.
_CHAPTER_HEAD_RE = re.compile(
    r"^(?:глава|часть|книга|том|пролог|эпилог|вступление|предисловие|послесловие|"
    r"интерлюдия|эпиграф|от автора)"
    r"(?:\s+(?:[ivxlcdm]+|\d+|"
    r"[а-яё]*(?:перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят|надцат|дцат)[а-яё]*))?"
    r"(?:\s*[.:—–-]\s*[^.!?…]*)?"
    r"(?:\s+(?:автора|переводчика|редактора|составителя))?"
    r"\s*[.!:…]?$",
    re.IGNORECASE,
)
# Титр-картинка: так в планах помечают кадр-приманку, а не событие.
_IMAGE_MARKER_RE = re.compile(
    r"^(?:картинк[аи]\s+для\s+привлечения\s+внимания|обложка|титр|постер|заставка|интро)\b",
    re.IGNORECASE,
)
_QUOTED_RE = re.compile(r'^[«"“„\'‘](?P<inner>.+)[»"”“\'’]$', re.S)
_METADATA_LINE_RE = re.compile(
    r"^(?:автор|подпись|эпиграф|источник|источники|тема|жанр|продолжительность|"
    r"хронометраж|формат|название|title|author)\s*[:—–-]",
    re.IGNORECASE,
)
# Подпись: «— Иван Петров», «© 2026». Диалог так выглядит редко — в нём есть
# глагол или знак конца предложения, поэтому короткий шаблон его не ловит.
_SIGNATURE_RE = re.compile(r"^[—–-]\s*[А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){1,2}\s*$")
_COPYRIGHT_RE = re.compile(r"^(?:©|\(с\)|\(c\)|copyright)\s", re.IGNORECASE)
# Авторская ремарка: «это мой первый рассказ…», «прошу строго не судить».
# Первое лицо в тексте обязательно — иначе фраза «не судите его строго»
# из самого сюжета считалась бы служебной.
_AUTHOR_NOTE_RE = re.compile(
    r"перв(?:ый|ая|ое|ые)\s+(?:рассказ|роман|повесть|книга|текст|проба|опыт)"
    r"|прошу\s+(?:прощения|снисхождения|не\s+судить)"
    r"|заранее\s+извиняюсь"
    r"|критик\w*\s+приветству\w*"
    r"|приятного\s+(?:чтения|просмотра)"
    r"|спасибо\s+за\s+(?:чтение|внимание)",
    re.IGNORECASE,
)
_SOFT_PLEA_RE = re.compile(r"не\s+суди(?:те)?", re.IGNORECASE)
_FIRST_PERSON_RE = re.compile(r"\b(?:я|меня|мне|мой|моя|моё|мое|мои|моих|мной)\b", re.IGNORECASE)
_MAX_HEADING_WORDS = 12
_MAX_TITLE_WORDS = 12
_MAX_AUTHOR_NOTE_WORDS = 30


def is_service_paragraph(text: str, *, in_preface: bool = False) -> bool:
    """Служебный абзац плана — не событие и не сцена.

    Служебными считаются заголовки глав и частей, «Пролог»/«Эпилог»,
    «Картинка для привлечения внимания» и прочие титры, название
    произведения в кавычках, подпись/эпиграф и строка метаданных вида
    ``Автор:``. Такие абзацы не должны получать код ``P*``: иначе гейт
    R-PLAN-COVER требует «покрыть» заголовок сценой, и модель сочиняет
    кадры, которых в сценарии нет.

    ``in_preface=True`` (абзац стоит до первого заголовка главы) дополнительно
    разрешает отбросить название произведения в кавычках и авторскую ремарку
    вроде «это мой первый рассказ, не судите строго».
    """

    cleaned = _collapse(text)
    if not cleaned:
        return False
    if (
        _is_chapter_heading(cleaned)
        or _is_image_marker(cleaned)
        or _is_metadata_line(cleaned)
        or _is_signature(cleaned)
    ):
        return True
    if not in_preface:
        return False
    # Название произведения и авторская ремарка живут в шапке текста, до
    # первого заголовка главы. В середине сценария кавычки — это реплика
    # или приказ, их терять нельзя.
    return _is_quoted_title(cleaned) or _is_author_note(cleaned)


def _is_chapter_heading(text: str) -> bool:
    if len(text.split()) > _MAX_HEADING_WORDS:
        return False
    return bool(_CHAPTER_HEAD_RE.match(text))


def _is_image_marker(text: str) -> bool:
    return bool(_IMAGE_MARKER_RE.match(text))


def _is_quoted_title(text: str) -> bool:
    match = _QUOTED_RE.match(text)
    if not match:
        return False
    inner = match.group("inner").strip()
    if not inner or len(inner.split()) > _MAX_TITLE_WORDS:
        return False
    if inner.startswith(("-", "—", "–")):
        return False
    return not any(char in inner for char in ".!?…,;:")


def _is_metadata_line(text: str) -> bool:
    if len(text.split()) > _MAX_HEADING_WORDS:
        return False
    return bool(_METADATA_LINE_RE.match(text))


def _is_signature(text: str) -> bool:
    return bool(_COPYRIGHT_RE.match(text) or _SIGNATURE_RE.match(text))


def _is_author_note(text: str) -> bool:
    if len(text.split()) > _MAX_AUTHOR_NOTE_WORDS:
        return False
    if _AUTHOR_NOTE_RE.search(text):
        return True
    return bool(_SOFT_PLEA_RE.search(text) and _FIRST_PERSON_RE.search(text))


# ---------------------------------------------------------------------------
# Парсинг ответа модели
# ---------------------------------------------------------------------------


def parse_scenes_reply(raw: str) -> list[dict]:
    """Вытащить ``{"сцены": [...]}`` из ответа модели и провалидировать поля.

    Терпимо к markdown-обёртке (```json … ```) и тексту вокруг JSON.
    Возвращает нормализованные сцены с ключами
    ``номер, id_плана, место, событие, примечание``. Если модель прислала поля
    врезки (:data:`INSERT_SCENE_KEYS` — ``сцена_вставка``, ``возврат_к_сцене``,
    ``продолжение_фона``, ``кадров_макс``), они сохраняются как есть; у сцены
    без них набор ключей прежний.
    Нарушение контракта — :class:`PlanScenesError`.
    """

    payload = _loads_first_json(raw)
    if isinstance(payload, list):
        scenes_raw: Any = payload
    elif isinstance(payload, dict):
        scenes_raw = payload.get("сцены")
        if scenes_raw is None:
            raise PlanScenesError("в ответе модели нет ключа «сцены»")
    else:
        raise PlanScenesError("ответ модели — не JSON-объект с ключом «сцены»")
    if not isinstance(scenes_raw, list):
        raise PlanScenesError("«сцены» должен быть списком")
    return [_normalize_scene(item, pos) for pos, item in enumerate(scenes_raw, 1)]


def _scene_count(value: Any) -> int:
    """Сколько сцен в JSON-документе ответа (для выбора полного документа)."""
    if isinstance(value, list):
        return len(value)
    if isinstance(value, dict) and isinstance(value.get("сцены"), list):
        return len(value["сцены"])
    return 0


def _loads_first_json(raw: str) -> Any:
    text = (raw or "").strip()
    if not text:
        raise PlanScenesError("пустой ответ модели")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    docs: list[Any] = []
    for block in re.findall(r"```[a-zA-Z]*\s*(.*?)```", text, re.S):
        block = block.strip()
        if not block:
            continue
        try:
            docs.append(json.loads(block))
        except json.JSONDecodeError:
            continue
    if not docs:
        # Ответ мог прийти двумя JSON-документами подряд (дубль или продолжение):
        # берём не первый попавшийся, а самый полный, иначе половина сцен молча
        # терялась бы в хвосте ответа.
        decoder = json.JSONDecoder()
        pos = 0
        while pos < len(text):
            start = next((i for i in range(pos, len(text)) if text[i] in "{["), None)
            if start is None:
                break
            try:
                value, end = decoder.raw_decode(text, start)
            except json.JSONDecodeError:
                pos = start + 1
                continue
            docs.append(value)
            pos = end
    if not docs:
        raise PlanScenesError("в ответе модели не нашёл JSON")
    if len(docs) > 1:
        best = max(docs, key=_scene_count)
        logger.warning(
            "ответ модели содержит %d JSON-документов; беру документ с %d сценами (первый — с %d)",
            len(docs),
            _scene_count(best),
            _scene_count(docs[0]),
        )
        return best
    return docs[0]


#: Латинские буквы, которыми модель иногда подменяет кириллицу в слове
#: («лачугa» с латинской a). Такая подмена ломает группировку мест и имён.
_HOMOGLYPH_LAT = str.maketrans(
    {
        "a": "а",
        "e": "е",
        "o": "о",
        "p": "р",
        "c": "с",
        "x": "х",
        "y": "у",
        "k": "к",
        "m": "м",
        "t": "т",
        "b": "в",
        "h": "н",
        "i": "и",
        "j": "й",
        "l": "л",
        "n": "п",
        "r": "г",
        "s": "с",
        "u": "и",
        "v": "в",
        "w": "ш",
        "z": "з",
        "g": "г",
        "d": "д",
        "f": "ф",
        "q": "й",
    }
)
_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё]+")
_CYR_RE = re.compile(r"[А-Яа-яЁё]")
_LAT_RE = re.compile(r"[A-Za-z]")


def fix_homoglyphs(text: str) -> str:
    """Убрать латинские буквы внутри русских слов: «лачугa» → «лачуга».

    Чисто латинские слова (бренды, латиница в названиях) не трогаем: правило
    срабатывает, только если в токене есть и кириллица, и латиница.
    """

    def replace_word(match: re.Match[str]) -> str:
        token = match.group(0)
        if _CYR_RE.search(token) and _LAT_RE.search(token):
            return token.translate(_HOMOGLYPH_LAT)
        return token

    return _WORD_RE.sub(replace_word, str(text or ""))


def fix_scene_homoglyphs(scene: dict) -> dict:
    """Применить :func:`fix_homoglyphs` ко всем текстовым полям сцены."""

    fixed = dict(scene)
    for key in ("место", "событие", "примечание", "сцена"):
        if isinstance(fixed.get(key), str):
            fixed[key] = fix_homoglyphs(fixed[key])
    for key in ("персонажи", "предметы"):
        if isinstance(fixed.get(key), list):
            fixed[key] = [fix_homoglyphs(str(item)) for item in fixed[key]]
    return fixed


def _normalize_scene(item: Any, pos: int) -> dict:
    if not isinstance(item, dict):
        raise PlanScenesError(f"сцена {pos}: элемент списка — не объект")
    number = _normalize_number(item.get("номер"), pos)
    refs = _normalize_refs(item.get("id_плана"), pos)
    scene = {
        "номер": number,
        "id_плана": refs,
        "место": _as_text(item, "место", pos),
        "событие": _as_text(item, "событие", pos),
        "примечание": _as_text(item, "примечание", pos),
    }
    # Поля врезки добавляем, только если модель их прислала: у обычной сцены
    # ответ остаётся ровно прежним (старые голдены и контракт не меняются).
    # Работу удалённой ноды «Каркас» («Сцены по плану» пишут действие сцены,
    # персонажей и предметы) тоже пропускаем только когда модель их прислала:
    # старый ответ без них остаётся валидным.
    if "сцена" in item:
        scene["сцена"] = _as_text(item, "сцена", pos)
    for key in ("персонажи", "предметы"):
        if key in item:
            scene[key] = _as_str_list(item, key, pos)
    if any(key in item for key in INSERT_SCENE_KEYS):
        insert = _as_flag(item, SCENE_INSERT, pos)
        max_shots = _as_count(item, SCENE_MAX_SHOTS, pos)
        if insert and max_shots <= 0:
            # Врезка всегда короткая: модель вправе не указывать число кадров.
            max_shots = MAX_INSERT_SHOTS
        scene[SCENE_INSERT] = insert
        scene[SCENE_RETURN_TO] = _as_count(item, SCENE_RETURN_TO, pos)
        scene[SCENE_KEEP_BACKGROUND] = _as_flag(item, SCENE_KEEP_BACKGROUND, pos)
        scene[SCENE_MAX_SHOTS] = max_shots
    return scene


def _normalize_number(value: Any, pos: int) -> int:
    if isinstance(value, bool):
        raise PlanScenesError(f"сцена {pos}: номер должен быть целым числом")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
    else:
        raise PlanScenesError(f"сцена {pos}: номер должен быть целым числом")
    if number < 1:
        raise PlanScenesError(f"сцена {pos}: номер должен быть больше нуля")
    return number


def _normalize_refs(value: Any, pos: int) -> list[str]:
    if value is None:
        raise PlanScenesError(f"сцена {pos}: нет поля id_плана")
    if isinstance(value, str) or not isinstance(value, (list, tuple)):
        raise PlanScenesError(f"сцена {pos}: id_плана должен быть списком кодов")
    refs: list[str] = []
    for ref in value:
        if not isinstance(ref, str):
            raise PlanScenesError(f"сцена {pos}: в id_плана не строка")
        code = ref.strip().upper().rstrip(":;,")
        if code:
            refs.append(code)
    return refs


def _as_text(item: dict, key: str, pos: int) -> str:
    value = item.get(key, "")
    if value is None:
        return ""
    if not isinstance(value, str):
        raise PlanScenesError(f"сцена {pos}: поле «{key}» должно быть строкой")
    return _collapse(value)


def _as_str_list(item: dict, key: str, pos: int) -> list[str]:
    """Список непустых строк (персонажи/предметы именами до реестра)."""
    value = item.get(key, [])
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise PlanScenesError(f"сцена {pos}: поле «{key}» должно быть списком строк")
    result: list[str] = []
    for element in value:
        if element is None:
            continue
        if not isinstance(element, str):
            raise PlanScenesError(f"сцена {pos}: «{key}» — только строки")
        text = _collapse(element)
        if text:
            result.append(text)
    return result


_TRUE_WORDS = frozenset({"true", "да", "1", "yes"})
_FALSE_WORDS = frozenset({"false", "нет", "0", "no", ""})


def _as_flag(item: dict, key: str, pos: int) -> bool:
    """Флаг сцены: ``true``/``false``; отсутствие поля — ``False``."""
    value = item.get(key, False)
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    if isinstance(value, str):
        word = value.strip().lower()
        if word in _TRUE_WORDS:
            return True
        if word in _FALSE_WORDS:
            return False
    raise PlanScenesError(f"сцена {pos}: поле «{key}» должно быть true или false")


def _as_count(item: dict, key: str, pos: int) -> int:
    """Целое ≥ 0 (номер сцены или число кадров); отсутствие поля — ``0``."""
    value = item.get(key, 0)
    if value is None or value == "":
        return 0
    if isinstance(value, bool):
        raise PlanScenesError(f"сцена {pos}: поле «{key}» должно быть целым числом")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
    else:
        raise PlanScenesError(f"сцена {pos}: поле «{key}» должно быть целым числом")
    if number < 0:
        raise PlanScenesError(f"сцена {pos}: поле «{key}» не может быть отрицательным")
    return number


# ---------------------------------------------------------------------------
# Мягкая проверка сцен-врезок (правило 13 «Сцен по плану»)
# ---------------------------------------------------------------------------


def _place_head(place: Any) -> str:
    """Первый отрезок места до запятой — ключ группировки фонов.

    Совпадает с правилом 8 ``plan_to_scenes.md`` и с
    ``plan_cinema/nodes.py:_place_group_key``: возврат к прерванной сцене обязан
    писать то же начало места, иначе «Фоны» заведут вторую карточку.
    """
    head = " ".join(str(place or "").split()).lower()
    return head.split(",")[0].strip(" «»\"'")


def _time_word(place: Any) -> str:
    text = str(place or "").lower()
    for word in _TIME_WORDS:
        if word in text:
            return word
    return ""


def insert_scene_problems(scenes: Sequence[dict] | None) -> list[str]:
    """Замечания к врезкам: пара «врезка → возврат к прерванной сцене».

    Проверка мягкая: это не отказ шага, а список того, что стоит показать
    человеку и что ловят тесты. Жёсткие требования гейта R-PLAN-COVER не
    меняются — врезка повторяет ``P`` прерванной сцены и покрытие не ломает.

    Ловится: врезка без возврата, возврат не к той сцене, возврат без
    ``продолжение_фона``, разошедшееся место (другой первый отрезок или другое
    время суток), ``кадров_макс`` вне 1–2, врезка в самом начале и две врезки
    подряд.
    """
    scene_list = [scene for scene in (scenes or []) if isinstance(scene, dict)]
    problems: list[str] = []
    for pos, scene in enumerate(scene_list):
        if not scene.get(SCENE_INSERT):
            continue
        number = int(scene.get("номер") or pos + 1)
        if pos == 0:
            problems.append(f"врезка {number}: она первая — прерывать нечего")
        max_shots = int(scene.get(SCENE_MAX_SHOTS) or 0)
        if not 1 <= max_shots <= MAX_INSERT_SHOTS:
            problems.append(f"врезка {number}: кадров_макс {max_shots}, нужно 1–2")
        if pos + 1 >= len(scene_list):
            problems.append(f"врезка {number}: после неё нет возврата к прерванной сцене")
            continue
        back = scene_list[pos + 1]
        back_number = int(back.get("номер") or number + 1)
        if back.get(SCENE_INSERT):
            problems.append(f"сцена {back_number}: врезка сразу за врезкой")
        interrupted = int(scene_list[pos - 1].get("номер") or number - 1) if pos else 0
        back_to = int(back.get(SCENE_RETURN_TO) or 0)
        if interrupted and back_to != interrupted:
            problems.append(
                f"сцена {back_number}: возврат_к_сцене {back_to}, "
                f"а прервана была сцена {interrupted}"
            )
        if not back.get(SCENE_KEEP_BACKGROUND):
            problems.append(f"сцена {back_number}: не отмечено продолжение_фона")
        if pos:
            before = scene_list[pos - 1]
            if _place_head(back.get("место")) != _place_head(before.get("место")):
                problems.append(
                    f"сцена {back_number}: место не как у прерванной сцены {interrupted} — "
                    "«Фоны» заведут второй фон"
                )
            elif _time_word(back.get("место")) != _time_word(before.get("место")):
                problems.append(
                    f"сцена {back_number}: время суток не как у прерванной сцены {interrupted} — "
                    "«Фоны» заведут второй фон"
                )
    return problems


# ---------------------------------------------------------------------------
# Гейт R-PLAN-COVER
# ---------------------------------------------------------------------------


def check_plan_coverage(
    points: Sequence[tuple[str, str] | str],
    scenes: Sequence[dict] | None,
) -> dict:
    """Гейт R-PLAN-COVER: каждый пункт плана покрыт сценой, ссылки не убывают.

    Проверяется: покрытие всех ``P``, неубывающий порядок ссылок, отсутствие
    ссылок на несуществующие пункты, число сцен 1..40. Сцена без ссылки на
    пункт — ошибка, автопокрытия нет.

    Пара «врезка → возврат» (правило 13 ``plan_to_scenes.md``) сюда не входит:
    врезка повторяет ``P`` прерванной сцены, поэтому порядок ссылок и покрытие
    остаются в силе, а замечания по паре даёт :func:`insert_scene_problems`.

    Возвращает ``{"passed", "uncovered", "unknown", "errors", "scenes"}``.
    """

    codes = _point_codes(points)
    index = {code: pos for pos, code in enumerate(codes)}
    errors: list[str] = []
    unknown: list[str] = []
    covered: list[str] = []
    scene_list = list(scenes or [])

    if not codes:
        errors.append("нет пунктов плана")
    if not scene_list:
        errors.append("в ответе нет ни одной сцены")
    elif len(scene_list) > MAX_SCENES:
        errors.append(f"сцен больше {MAX_SCENES}: {len(scene_list)}")

    prev = -1
    for pos, scene in enumerate(scene_list, 1):
        if not isinstance(scene, dict):
            errors.append(f"сцена {pos}: элемент — не объект")
            continue
        number = scene.get("номер", pos)
        refs = scene.get("id_плана")
        if not isinstance(refs, (list, tuple)):
            errors.append(f"сцена {number}: id_плана отсутствует или не список")
            continue
        cleaned = [str(ref).strip().upper() for ref in refs if str(ref).strip()]
        if not cleaned:
            errors.append(f"сцена {number}: нет ссылки на пункт плана")
            continue
        for code in cleaned:
            index_pos = index.get(code)
            if index_pos is None:
                if code not in unknown:
                    unknown.append(code)
                continue
            if index_pos < prev:
                errors.append(
                    f"сцена {number}: ссылка {code} идёт после {codes[prev]} — порядок ссылок убывает"
                )
            prev = max(prev, index_pos)
            if code not in covered:
                covered.append(code)

    uncovered = [code for code in codes if code not in set(covered)]
    passed = not errors and not uncovered and not unknown
    return {
        "passed": passed,
        "uncovered": uncovered,
        "unknown": unknown,
        "errors": errors,
        "scenes": len(scene_list),
    }


def _point_codes(points: Sequence[tuple[str, str] | str]) -> list[str]:
    codes: list[str] = []
    for item in points or []:
        if isinstance(item, str):
            code = item
        elif isinstance(item, (tuple, list)) and item:
            code = item[0]
        else:
            continue
        code = str(code).strip().upper()
        if code and code not in codes:
            codes.append(code)
    return codes


# ---------------------------------------------------------------------------
# Пункты плана выделяет сама нода «Сцены по плану»
# ---------------------------------------------------------------------------

_POINT_CODE_RE = re.compile(r"^P[1-9]\d*$")


def parse_plan_reply(raw: str) -> tuple[list[tuple[str, str]], list[dict]]:
    """Разобрать ответ ноды «Сцены по плану»: пункты (её разбивка) и сцены.

    Контракт ответа: ``{"пункты": [{"код": "P1", "текст": "…"}, …],
    "сцены": [...]}``. Пункты — это разбивка сценария, которую делает сама
    нода: коды P1…Pn подряд, текст пункта — дословный кусок входного текста.
    Терпимо к markdown-обёртке и тексту вокруг JSON.
    """

    payload = _loads_first_json(raw)
    if not isinstance(payload, dict):
        raise PlanScenesError(
            "ответ модели — не JSON-объект с ключами «пункты» и «сцены»"
        )
    points_raw = payload.get("пункты")
    if points_raw is None:
        raise PlanScenesError("в ответе модели нет ключа «пункты»")
    if not isinstance(points_raw, list) or not points_raw:
        raise PlanScenesError("«пункты» должен быть непустым списком")
    points: list[tuple[str, str]] = []
    for pos, item in enumerate(points_raw, 1):
        if not isinstance(item, dict):
            raise PlanScenesError(f"пункт {pos}: элемент списка — не объект")
        code = str(item.get("код") or item.get("code") or "").strip().upper()
        text = str(item.get("текст") or item.get("text") or "").strip()
        if not _POINT_CODE_RE.match(code):
            raise PlanScenesError(f"пункт {pos}: код «{code}» — не вида P1…Pn")
        if not text:
            raise PlanScenesError(f"пункт {code}: пустой текст")
        points.append((code, text))
    codes = [code for code, _ in points]
    expected = [f"P{pos}" for pos in range(1, len(points) + 1)]
    if codes != expected:
        raise PlanScenesError(
            "коды пунктов должны идти P1…Pn подряд без пропусков и повторов"
        )
    scenes_raw = payload.get("сцены")
    if scenes_raw is None:
        raise PlanScenesError("в ответе модели нет ключа «сцены»")
    if not isinstance(scenes_raw, list):
        raise PlanScenesError("«сцены» должен быть списком")
    scenes = [_normalize_scene(item, pos) for pos, item in enumerate(scenes_raw, 1)]
    return points, scenes


def _flat_text(text: Any) -> str:
    """Сверка дословности: одна строка, сжатые пробелы, без крайних."""
    return re.sub(r"\s+", " ", str(text or "")).strip()


def check_points_cover_plan(
    plan_text: str,
    points: Sequence[tuple[str, str]],
) -> list[str]:
    """Проверить опорные точки ответа ноды.

    Нода не делит входной текст: она читает сценарий целиком и пишет
    последовательные сцены, а ``пункты`` — её собственные опорные точки
    (короткие формулировки шагов), нужные гейту покрытия. Поэтому дословность
    текста пунктов не требуется: проверяем только, что точки есть, идут
    P1…Pn подряд и не пустые. Покрытие входа сценами держит R-PLAN-COVER.
    """

    problems: list[str] = []
    if not points:
        return ["пунктов нет"]
    if not _flat_text(plan_text):
        return ["план пуст — писать сцены не из чего"]
    codes = [str(code).strip().upper() for code, _ in points]
    expected = [f"P{pos}" for pos in range(1, len(points) + 1)]
    if codes != expected:
        problems.append("коды пунктов должны идти P1…Pn подряд")
    for code, text in points:
        if not _flat_text(text):
            problems.append(f"{code}: пустой текст пункта")
    return problems
