"""Механика закадрового текста (VO) для ноды «Шоты» (CONTRACT 2026-11-17).

Чистые функции без записи в БД и без сети. Правило одно: 13.5 знака в
секунду, весь закадр раскладывается по сценам и кадрам без потерь, дублей и
пересказа. Единственное касание базы — резолв текста проекта через
``db_v2``; импорт локальный, чтобы модуль оставался лёгким.

Термины:
* сцена — строка ``Frame`` с ``attrs["источник"] == "pk"``;
* кадр (шот) — элемент ``attrs["кадры"]`` сцены;
* кусок — непрерывная дословная часть закадра.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

#: Темп озвучки: знаков в секунду (правило владельца).
VO_CHARS_PER_SEC = 13.5

#: Минимальная длительность кадра, сек: визуальный шот без закадра не схлопывается в ноль.
MIN_KADR_SECONDS = 0.5

#: Слово в сравнимом виде: буквы и цифры, всё остальное (пунктуация, тире, кавычки) — разделитель.
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


@dataclass(frozen=True)
class VoSource:
    """Источник закадра для ноды шотов: от какой script-ноды пришло ребро и какой текст."""

    node_key: str
    text: str


def shots_node_vo_source(project: Any, shots_node_key: str) -> VoSource | None:
    """Источник закадра для ноды «Шоты»: ``None`` — ребра от «Закадрового текста» нет.

    Ищет в ``project.meta.canvas_graph`` входящее в ``shots_node_key`` ребро,
    у которого источник — узел ``type == "script"``. Текст резолвит
    ``db_v2.resolve_full_voiceover_text`` (он сам решает: ``script_text``,
    ``voiceover.txt``), пустой текст — fallback на ``project.script_text``.
    Ребро есть, а текста нет — возвращаем ``VoSource(text="")``: ошибку
    поднимает вызывающий, молчаливая подмена запрещена.
    """
    target = str(shots_node_key or "").strip()
    if not target:
        return None
    meta = getattr(project, "meta", None)
    if not isinstance(meta, dict):
        return None

    from app.services.canvas_graph import canvas_graph_from_meta

    graph = canvas_graph_from_meta(meta)
    if not graph:
        return None

    script_ids: set[str] = set()
    for node in graph.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        if str(node.get("type") or "").strip() != "script":
            continue
        node_id = str(node.get("id") or "").strip()
        if node_id:
            script_ids.add(node_id)
    if not script_ids:
        return None

    for edge in graph.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        if str(edge.get("target") or "").strip() != target:
            continue
        source_key = str(edge.get("source") or "").strip()
        if source_key in script_ids:
            return VoSource(node_key=source_key, text=resolve_project_vo_text(project))
    return None


def resolve_project_vo_text(project: Any) -> str:
    """Полный закадровый текст проекта с пробелами, схлопнутыми в один.

    ``db_v2.resolve_full_voiceover_text`` — основной резолвер (``script_text``,
    иначе актуальный ``voiceover.txt``); пустой ответ добираем из
    ``project.script_text`` напрямую, чтобы поведение не зависело от версии
    резолвера.
    """
    from app.services import db_v2

    text = ""
    try:
        text = db_v2.resolve_full_voiceover_text(project) or ""
    except Exception:  # noqa: BLE001 — проект без файлов/сессии не должен ронять резолв
        text = ""
    text = " ".join(str(text).split())
    if text:
        return text
    return " ".join(str(getattr(project, "script_text", "") or "").split())


def normalize_words(text: str) -> list[str]:
    """Слова текста в сравнимом виде.

    Не значимы: регистр, «ё/е», пробелы, кавычки («» „“ " "), тире (— – -)
    и любая пунктуация. ``"Ёжик — «в тумане»!"`` → ``["ежик", "в", "тумане"]``.
    """
    return _WORD_RE.findall((text or "").lower().replace("ё", "е"))


def same_words(a: str, b: str) -> bool:
    """Тексты совпадают слово в слово после ``normalize_words``."""
    return normalize_words(a) == normalize_words(b)


def _norm_char_count(text: str) -> int:
    """Знаков в тексте после схлопывания пробелов (переводы строк не считаются)."""
    return len(" ".join((text or "").split()))


def _text_mismatch_problems(expected: str, got: str, what: str) -> list[str]:
    """Сравнить склейку кусков с закадром и назвать расхождение по-русски."""
    expected_words = normalize_words(expected)
    got_words = normalize_words(got)
    if expected_words == got_words:
        return []
    if Counter(expected_words) == Counter(got_words):
        return [f"{what} не совпадает с закадром: слова переставлены"]
    over = Counter(got_words) - Counter(expected_words)
    under = Counter(expected_words) - Counter(got_words)
    if over and not under and set(over) <= set(expected_words):
        return [f"{what} не совпадает с закадром: дубль слов ({sum(over.values())})"]
    prefix = 0
    limit = min(len(expected_words), len(got_words))
    while prefix < limit and expected_words[prefix] == got_words[prefix]:
        prefix += 1
    lost = len(expected_words) - prefix
    extra = len(got_words) - prefix
    if lost and not extra:
        return [f"{what} короче закадра: потерян хвост ({lost} сл.)"]
    if extra and not lost:
        return [f"{what} длиннее закадра: лишний текст ({extra} сл.)"]
    return [f"{what} не совпадает с закадром: потеряно {lost} сл., лишних {extra} сл."]


def scene_chunk_problems(scene_numbers: list[int], chunks: list[dict], vo: str) -> list[str]:
    """Проверить деление закадра по сценам: ``chunks = [{"номер": 1, "закадр": "…"}]``.

    Требования: номера 1:1 с ``scene_numbers`` (без пропусков, дублей и
    лишних), порядок по возрастанию, каждый кусок непустой, склейка кусков
    по порядку — весь закадр слово в слово. Пустой список — всё сошлось.
    """
    problems: list[str] = []
    expected_numbers = [int(number) for number in scene_numbers or []]
    chunks = list(chunks or [])

    found: list[int] = []
    for index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            problems.append(f"кусок {index + 1} не объект: нет «номер» и «закадр»")
            continue
        raw_number = chunk.get("номер")
        try:
            number = int(str(raw_number).strip())
        except (TypeError, ValueError):
            problems.append(f"у куска {index + 1} нет целого «номер»")
            continue
        found.append(number)
        if number not in expected_numbers:
            problems.append(f"кусок для сцены {number} лишний: такой сцены нет")
        if not str(chunk.get("закадр") or "").strip():
            problems.append(f"пустой закадр у куска сцены {number}")

    seen: set[int] = set()
    for number in found:
        if number in seen:
            problems.append(f"сцена {number} повторяется в кусках")
        seen.add(number)
    for number in expected_numbers:
        if number not in seen:
            problems.append(f"нет куска для сцены {number}")

    for previous, current in zip(found, found[1:], strict=False):
        if current <= previous:
            problems.append("нарушен порядок сцен: номера кусков идут не по возрастанию")

    glued = " ".join(str(chunk.get("закадр") or "") for chunk in chunks if isinstance(chunk, dict))
    problems.extend(_text_mismatch_problems(vo, glued, "склейка кусков"))
    return problems


def shots_partition_problems(scene_vo: str, kadry: list[dict]) -> list[str]:
    """Проверить раскладку куска сцены по кадрам.

    Требования: у каждого кадра непустое поле ``закадр``, склейка по порядку
    кадров — весь кусок сцены слово в слово. Пустой список — всё сошлось.
    """
    problems: list[str] = []
    frames: list[dict] = []
    for index, frame in enumerate(kadry or []):
        if not isinstance(frame, dict):
            problems.append(f"кадр {index + 1} не объект")
            continue
        frames.append(frame)
        label = frame.get("id") or frame.get("порядок") or index + 1
        if not str(frame.get("закадр") or "").strip():
            problems.append(f"кадр {label} без закадрового текста")

    glued = " ".join(str(frame.get("закадр") or "") for frame in frames)
    problems.extend(_text_mismatch_problems(scene_vo, glued, "склейка кадров"))
    return problems


def distribute_scene_vo(scene_vo: str, kadry: list[dict]) -> list[dict]:
    """Детерминированно разложить кусок сцены по кадрам.

    Копии строк кадров с полем ``закадр``; режет штатная
    ``camera_expand.split_text_into_parts`` — она держит инвариант «сумма
    кусков = исходный текст». Кадров больше, чем клауз, — хвост получает
    ``""``, текст не выдумываем. Исходный список не мутируется.
    """
    frames = [dict(frame) for frame in (kadry or []) if isinstance(frame, dict)]
    if not frames:
        return []

    from app.services.scene_design.camera_expand import split_text_into_parts

    parts = split_text_into_parts(scene_vo or "", len(frames))
    for frame, part in zip(frames, parts, strict=False):
        frame["закадр"] = part
    return frames


def with_durations(kadry: list[dict]) -> list[dict]:
    """Проставить ``длительность`` по правилу 13.5 знака в секунду.

    Длительность кадра = ``round(знаков / 13.5, 2)``, но не меньше
    ``MIN_KADR_SECONDS``. Последний кадр подгоняется так, чтобы сумма по
    кадрам = ``round(знаков полного текста / 13.5, 2)`` (полный текст —
    склейка закадров). Если текст настолько короткий, что минимум у каждого
    кадра уже превышает расчётную сумму, побеждает минимум: сумма будет чуть
    больше — ноль-кадров не отдаём.
    """
    frames = [dict(frame) for frame in (kadry or []) if isinstance(frame, dict)]
    if not frames:
        return []

    full_text = " ".join(
        str(frame.get("закадр") or "").strip() for frame in frames if str(frame.get("закадр") or "").strip()
    )
    target = round(_norm_char_count(full_text) / VO_CHARS_PER_SEC, 2)
    durations = [
        max(MIN_KADR_SECONDS, round(_norm_char_count(str(frame.get("закадр") or "")) / VO_CHARS_PER_SEC, 2))
        for frame in frames
    ]

    if len(frames) > 1:
        # Считаем в сотых, чтобы сумма не уплыла на двоичной арифметике.
        head_cents = sum(round(value * 100) for value in durations[:-1])
        tail = (round(target * 100) - head_cents) / 100
        durations[-1] = tail if tail >= MIN_KADR_SECONDS else MIN_KADR_SECONDS
    else:
        durations[0] = max(MIN_KADR_SECONDS, target)

    for frame, duration in zip(frames, durations, strict=True):
        frame["длительность"] = duration
    return frames


def vo_rate_summary(vo: str, scene_chunks: list[dict]) -> dict:
    """Сводка по закадру и разложенным кускам сцен.

    ``chars`` — знаков в закадре (пробелы схлопнуты), ``seconds`` — расчётная
    длительность ролика, ``rate`` — темп 13.5, ``"сцен"`` — сколько кусков
    пришло, ``"потерь"`` — сколько знаков закадра не попало в склейку кусков.
    """
    expected = normalize_words(vo)
    covered: list[str] = []
    for chunk in scene_chunks or []:
        if isinstance(chunk, dict):
            covered.extend(normalize_words(str(chunk.get("закадр") or "")))
    missing = Counter(expected) - Counter(covered)
    lost = sum(len(word) * count for word, count in missing.items())
    chars = _norm_char_count(vo)
    return {
        "chars": chars,
        "seconds": round(chars / VO_CHARS_PER_SEC, 2),
        "rate": VO_CHARS_PER_SEC,
        "сцен": len([chunk for chunk in scene_chunks or [] if isinstance(chunk, dict)]),
        "потерь": lost,
    }
