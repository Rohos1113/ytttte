"""PNG-фоны «Кино по плану»: шаг «Фоны» рисует локации до генерации кадров.

Зачем отдельный модуль. Нода ``pk_backgrounds`` до 2026-11-16 писала только
текстовые карточки локаций (``описание``/``свет``/``время``/``промт``), и
картинок фонов не появлялось ни у кого: кадры рисовались «в пустоте», а шаг
«Картинки» стартовал, не имея ни одного фона на диске. Владелец сформулировал
требование прямо: «Фоны должны генерироваться перед генерацией картинок» и
«результаты показывать как в персонажах».

Механика та же, что у референсов персонажей (``generate_hero``):

- одна PNG на локацию, имя — код фона (``f01.png``) в ``data_dir/backgrounds``;
- артефакт ``ArtifactKind.background_reference`` с ``meta={"background": "f01"}``
  — по нему UI и /assets показывают карточку так же, как карточку персонажа;
- промт берётся из поля ``промт`` карточки фона (английский, без людей);
- повторный прогон не перерисовывает готовые PNG: существует файл — пропуск.

Стиль проекта (2026-11-17). Раньше промт фона собирался только из карточки
(``_card_prompt``), поэтому фоны выходили в реализме, хотя у проекта выбран
другой стиль. Теперь промт фона = карточка + **тот же STYLE-блок**, которым
нода «Стиль» (``n_excel_gpt_pk_style``) стилизует кадры. Источник стиля один и
тот же — :func:`project_style`: своя привязка на ноде «Фоны» (слот ``style``,
как у «Персонажей»), иначе выбранный вариант ноды «Стиль» через
``plan_cinema.nodes._resolve_style``. Своего списка стилей и своего резолва
здесь нет намеренно: два источника стиля разъедутся на первом же переименовании
файла, и фоны снова начнут рисоваться «не в том визуале».
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from loguru import logger

#: Слот привязки стиля на ноде «Фоны» — тот же id, что у слота ``style``
#: ноды «Персонажи» (``web/src/lib/node-prompts.ts``).
STYLE_SLOT_ID = "style"

#: Шаг промт-библиотеки, из которого «Фоны» берут привязанный стиль, если это
#: не файл ``styles/style_*.md``. Тот же шаг, что у ноды «Стиль»: в пикере ноды
#: «Фоны» показывается ровно этот список, поэтому имя из привязки ищем здесь.
STYLE_PROMPT_STEP = "excel_gpt"

#: Кэш действующего стиля в ``project.meta``: по нему UI показывает стиль в
#: результатах ноды, не дожидаясь перегенерации всех карточек.
PROJECT_STYLE_META_KEY = "background_style"

#: id ноды «Стиль» группы plan_cinema (``nodes.NODE_SPECS`` → ``pk_style``).
PLAN_CINEMA_STYLE_NODE_KEY = "n_excel_gpt_pk_style"

#: id ноды «Фоны» по умолчанию (если графа под рукой нет).
DEFAULT_BACKGROUNDS_NODE_KEY = "n_backgrounds"

#: Канон ракурсов кадров (``scenes_to_frames_plan_ru.md``, поле ``ракурс``) →
#: английский вид квадранта. Ключи в нижнем регистре: ракурс приходит из БД как есть.
SHEET_ANGLE_EN: dict[str, str] = {
    "фронт": "front view",
    "3/4": "three-quarter view",
    "с плеча": "over-the-shoulder view",
    "сверху": "high-angle view",
    "снизу": "low-angle view",
    "макро": "macro detail view",
}

#: Пустой или незнакомый ракурс — общий вид локации (первый кадр обычно он и есть).
SHEET_ANGLE_DEFAULT = "wide establishing view of the location"

#: Панели листа в порядке чтения → их место на картинке.
SHEET_QUADRANTS: tuple[tuple[int, str], ...] = (
    (1, "top-left"),
    (2, "top-right"),
    (3, "bottom-left"),
    (4, "bottom-right"),
)

#: Сколько ракурсов в листе: лист 2×2, всегда четыре.
SHEET_ANGLES_COUNT = len(SHEET_QUADRANTS)


def backgrounds_dir(project: Any) -> Path:
    return Path(project.data_dir) / "backgrounds"


#: Имя PNG фона: строго код ``f0N`` (плюс сайдкар ``f0N.png.json`` с промтом).
_BACKGROUND_PNG_RE = re.compile(r"^f\d+$", re.IGNORECASE)


def _background_file_code(name: str) -> str:
    """Код фона из имени файла: ``f01.png`` и ``f01.png.json`` → ``f01``."""
    low = str(name or "").strip().lower()
    for suffix in (".png.json", ".png"):
        if low.endswith(suffix):
            code = low[: -len(suffix)]
            return code if _BACKGROUND_PNG_RE.match(code) else ""
    return ""


async def prune_backgrounds(
    session: Any,
    project: Any,
    keep_codes: Sequence[str],
) -> dict[str, int]:
    """Снять с учёта фоны прошлого прогона: карточки, артефакты и PNG.

    UPSERT по коду перезаписывает совпавшие ``f0N`` и добавляет новые, а коды
    прежней группировки оставляет живыми. После перезапуска «Фонов» в реестре
    висели локации прошлого ролика (f10…f16) — их промты и картинки попадали в
    «Результаты» и в следующие ноды. Здесь всё, чего нет в ``keep_codes``,
    помечается архивом, артефакт удаляется, PNG стирается с диска.
    """
    from sqlalchemy import select

    from app.models import Artifact, ArtifactKind, Entity
    from app.services.db_v2 import entity_is_archived

    keep = {str(code or "").strip().lower() for code in keep_codes if str(code or "").strip()}
    stats = {"archived": 0, "artifacts_removed": 0, "files_removed": 0}

    cards = (
        (
            await session.execute(
                select(Entity).where(
                    Entity.project_id == project.id, Entity.type == "background"
                )
            )
        )
        .scalars()
        .all()
    )
    for entity in cards:
        code = str(entity.code or "").strip()
        if not code or code.lower() in keep or entity_is_archived(entity):
            continue
        attrs = dict(entity.attrs or {})
        attrs["archived"] = True
        attrs["inactive"] = True
        entity.attrs = attrs
        stats["archived"] += 1

    artifacts = (
        (
            await session.execute(
                select(Artifact).where(
                    Artifact.project_id == project.id,
                    Artifact.kind == ArtifactKind.background_reference,
                )
            )
        )
        .scalars()
        .all()
    )
    for artifact in artifacts:
        code = str((artifact.meta or {}).get("background") or "").strip().lower()
        if code and code in keep:
            continue
        await session.delete(artifact)
        stats["artifacts_removed"] += 1

    folder = backgrounds_dir(project)
    if folder.is_dir():
        for path in folder.iterdir():
            if not path.is_file():
                continue
            code = _background_file_code(path.name)
            if not code or code in keep:
                continue
            try:
                path.unlink()
                stats["files_removed"] += 1
            except OSError as exc:
                logger.warning("#{} фоны: не удалил {}: {}", getattr(project, "id", "?"), path, exc)
    return stats


def background_path(project: Any, code: str) -> Path:
    return backgrounds_dir(project) / f"{(code or '').strip()}.png"


def _card_prompt(attrs: dict[str, Any]) -> str:
    for key in ("промт", "prompt", "описание"):
        text = str(attrs.get(key) or "").strip()
        if text:
            return text
    return ""


# ── Лист 2×2: четыре ракурса одной локации ───────────────────────────────


def angle_en(raw: Any) -> str:
    """Ракурс кадра (``фронт``/``3/4``/``с плеча``…) → английский вид квадранта."""
    text = " ".join(str(raw or "").split()).lower()
    text = text.replace("\\", "/")
    return SHEET_ANGLE_EN.get(text, SHEET_ANGLE_DEFAULT)


def sheet_angles(angles: Sequence[Any]) -> list[str]:
    """Ровно 4 английских вида: первые четыре ракурса кадров, остальное — общий.

    Кадров меньше четырёх — недостающие панели заполняет общий вид локации;
    ракурсы кадров 5+ в лист не попадают (лист всегда 2×2).
    """
    views = [angle_en(raw) for raw in list(angles)[:SHEET_ANGLES_COUNT]]
    while len(views) < SHEET_ANGLES_COUNT:
        views.append(SHEET_ANGLE_DEFAULT)
    return views


def sheet_prompt_block(views: Sequence[Any]) -> str:
    """Блок «квадранты листа»: четыре вида по очереди, каждый — съёмочная задача.

    Пишется в промт фона после текста карточки: карточка описывает локацию,
    блок задаёт раскладку листа. Вид панели — не название ракурса, а текст про
    то, что перед камерой и на чём акцент (его пишет модель в ``кадры_листа``);
    если вида нет, панель получает общий вид локации. Порядок жёсткий (верхний
    левый → нижний правый), потому что кадр ссылается на панель по её номеру.
    """
    texts: list[str] = []
    for raw in list(views)[:SHEET_ANGLES_COUNT]:
        text = " ".join(str(raw or "").split())
        if text and text[-1] not in ".!?":
            text = f"{text}."
        texts.append(text)
    while len(texts) < SHEET_ANGLES_COUNT:
        texts.append(f"{SHEET_ANGLE_DEFAULT}.")
    panels = " ".join(
        f"Quadrant {number} ({name}): {text or SHEET_ANGLE_DEFAULT + '.'}"
        for (number, name), text in zip(SHEET_QUADRANTS, texts, strict=True)
    )
    return (
        "Turnaround sheet: one image, a 2x2 grid of four panels of THE SAME "
        "location — identical layout, the same objects and materials, the same light "
        "and time of day in all four panels; only the camera position and framing change. "
        f"{panels} Four equal panels of the same empty location — the same standing "
        "figures and objects in every panel, no moving people, no text, no labels, no borders."
    )


def compose_sheet_prompt(base: str, views: Sequence[Any]) -> str:
    """Промт фона = текст карточки + блок листа 2×2 из четырёх ракурсов кадров.

    Виды панелей берёт код из карточки фона (``кадры_листа``, пишет модель) в
    жёстком порядке кадров фона: модель не выбирает раскладку и не может
    переставить панели — иначе лист разъедется с кадрами, которые ссылаются на
    панели по порядку. Пустой список видов — промт не трогаем.
    """
    text = " ".join(str(base or "").split())
    views = list(views)[:SHEET_ANGLES_COUNT]
    if not views:
        return text
    block = sheet_prompt_block(views)
    return f"{text}\n\n{block}" if text else block


# ── Стиль проекта ────────────────────────────────────────────────────────


def backgrounds_node_key(project: Any) -> str | None:
    """id ноды «Фоны» в графе проекта (``n_backgrounds``)."""
    from app.services.node_config import graph_nodes

    meta = getattr(project, "meta", None) or {}
    for node in graph_nodes(meta):
        if str(node.get("type") or "").strip() != "backgrounds":
            continue
        key = str(node.get("id") or "").strip()
        if key:
            return key
    return DEFAULT_BACKGROUNDS_NODE_KEY if isinstance(meta, dict) and meta else None


def style_node_key(project: Any) -> str | None:
    """Узел, на котором выбран стиль проекта: нода «Стиль», иначе по привязке.

    Сначала смотрим штатную ноду группы plan_cinema, потом любой узел, чей слот
    привязан к имени файла стиля (``styles/style_*.md``).
    """
    from app.services import frame_style
    from app.services.node_config import all_prompt_slots

    meta = getattr(project, "meta", None) or {}
    slots = all_prompt_slots(meta)
    if not slots:
        return None
    if PLAN_CINEMA_STYLE_NODE_KEY in slots:
        return PLAN_CINEMA_STYLE_NODE_KEY

    best: tuple[tuple[int, int], str] | None = None
    for node_key, node_slots in slots.items():
        if not isinstance(node_slots, dict):
            continue
        for slot_id, variant in node_slots.items():
            clean = frame_style.clean_style_name(str(variant or ""))
            if not clean or not frame_style.is_style_name(clean):
                continue
            score = (
                0 if slot_id == "main" else 1,
                0 if "style" in str(node_key).lower() else 1,
            )
            if best is None or score < best[0]:
                best = (score, str(node_key))
    return best[1] if best else None


def _bound_prompt_style(project: Any, node_key: str, bound: str) -> tuple[str, str]:
    """Стиль, привязанный на ноде «Фоны», если это имя промта, а не файл стилей.

    Пикер ноды показывает ту же библиотеку, что у ноды «Стиль» (`05_excel_gpt`):
    выбранный там файл живёт в `prompt_store`/на диске, а не в `styles/`. Текст
    берём обычным резолвом проекта — тем же, что у шагов, поэтому правка файла
    в редакторе промтов сразу меняет фон. Пустая строка — привязка не
    прочиталась, тогда работает наследование стиля проекта.
    """
    from app.services import frame_style
    from app.services.prompt_library import read_resolved_project_prompt

    try:
        _name, _path, text, _source = read_resolved_project_prompt(
            project,
            STYLE_PROMPT_STEP,
            node_key=node_key,
            slot_id=STYLE_SLOT_ID,
        )
    except Exception as exc:  # noqa: BLE001 — стиль не критичен, фон нарисуем без него
        logger.warning(
            "[#{}] фон: привязка {!r} на ноде {} не прочитана ({})",
            getattr(project, "id", "?"),
            bound,
            node_key,
            exc,
        )
        return "", ""
    clean = frame_style.normalize_style_text(text or "")
    if not clean:
        return "", ""
    logger.info(
        "[#{}] фон: стиль {!r} из промта шага {} (привязка ноды {})",
        getattr(project, "id", "?"),
        bound,
        STYLE_PROMPT_STEP,
        node_key,
    )
    return bound, clean


def project_style(project: Any) -> tuple[str, str, str]:
    """(имя стиля, текст, источник) — ровно стиль, которым стилизуются кадры.

    Порядок источников:

    1. своя привязка на ноде «Фоны» — слот ``style`` (как у «Персонажей»):
       ``meta.prompt_slot_variants[bgnode]["style"]`` либо ``data.config.promptSlots``;
    2. выбранный вариант ноды «Стиль» — тот же резолв, что в
       ``n_excel_gpt_pk_style`` (``plan_cinema.nodes._resolve_style``).

    Пустые строки — стиль не настроен; тогда фон рисуется по карточке как раньше.
    """
    from app.services import frame_style
    from app.services.node_config import prompt_slots_for_node

    meta = getattr(project, "meta", None) or {}

    bg_key = backgrounds_node_key(project)
    if bg_key:
        bound = frame_style.clean_style_name(
            (prompt_slots_for_node(meta, bg_key) or {}).get(STYLE_SLOT_ID)
        )
        if bound:
            path = frame_style.style_path(bound)
            if path is not None:
                text = frame_style.normalize_style_text(
                    path.read_text(encoding="utf-8", errors="replace")
                )
                logger.info(
                    "[#{}] фон: стиль {!r} из привязки ноды {}",
                    getattr(project, "id", "?"),
                    path.stem,
                    bg_key,
                )
                return path.stem, text, f"bg-slot:{bg_key}"
            # Привязка — имя промта из библиотеки (пикер как у «Стиля»), а не
            # файл styles/*.md: текст берём из промт-библиотеки.
            prompt_name, prompt_text = _bound_prompt_style(project, bg_key, bound)
            if prompt_text:
                return prompt_name, prompt_text, f"bg-slot:{bg_key}"
            logger.warning(
                "[#{}] фон: привязка {!r} на ноде {} не найдена в {} — беру стиль проекта",
                getattr(project, "id", "?"),
                bound,
                bg_key,
                frame_style.styles_dir(),
            )

    node_key = style_node_key(project)
    if not node_key:
        return "", "", ""
    from app.services.plan_cinema import nodes as plan_nodes

    try:
        name, text = plan_nodes._resolve_style(project, node_key)  # noqa: SLF001
    except Exception as exc:  # noqa: BLE001 — стиль не критичен, фон нарисуем без него
        logger.warning(
            "[#{}] фон: стиль проекта {} не прочитан ({})",
            getattr(project, "id", "?"),
            node_key,
            exc,
        )
        return "", "", ""
    if not text:
        return "", "", ""
    return name, text, f"project:{node_key}"


def _compact_style(text: str, limit: int) -> str:
    """Сжать стиль до бюджета — тем же правилом, что у кадров."""
    from app.services.plan_cinema.nodes import _compact_style as compact  # noqa: SLF001

    return compact(text, limit)


#: Хвост файла стиля, который описывает не визуал, а «замок» поверх готовой
#: картинки. Фону он не нужен: фон рисуется с нуля.
_STYLE_LOCK_RE = re.compile(r"(?i)\b(?:Final style lock|Negative)\s*:")


def _style_block(style_text: str) -> str:
    """STYLE-блок фона = ровно тот блок, который уходит в кадры.

    Нода «Стиль» сжимает файл стиля до ``_max_style_chars_v2()`` (≤700): в
    кадры идёт только первая, «визуальная» часть файла. Фоны берут тот же блок,
    и не только ради единообразия: полный файл кончается секциями
    ``Final style lock``/``Negative``, и GPT-image на них отвечает как на
    задание перерисовать присланный референс («upload the reference image»,
    52pay 400 — живой прогон 2026-11-17). Хвост срезаем и у коротких стилей,
    которые лимит не режет: описание визуала («STYLE: …») остаётся, команды
    «Improve only inside this style» и списки запретов — нет.
    """
    from app.services.plan_cinema.nodes import _max_style_chars_v2  # noqa: SLF001

    try:
        limit = _max_style_chars_v2()
    except Exception:  # noqa: BLE001 — лимит достанем из frame_style
        from app.services import frame_style

        limit = max(0, frame_style.body_limit() - frame_style.MIN_SCENE_BUDGET)
    block = _compact_style(style_text, limit)
    match = _STYLE_LOCK_RE.search(block)
    if match:
        block = block[: match.start()].strip()
    return block


def build_background_prompt(project: Any, attrs: dict[str, Any]) -> dict[str, Any]:
    """Промт фона = карточка + STYLE-блок стиля проекта.

    Возвращает словарь: ``prompt`` (итог), ``card`` (карточка как есть),
    ``style`` (имя), ``style_source``, ``style_chars`` (длина STYLE-блока),
    ``style_full_chars`` (длина файла стиля), ``trimmed`` (обрезана ли карточка
    под лимит Outsee) и ``limit``. Стиль не режется никогда — бюджет подгоняется
    обрезкой карточки по границе предложения
    (``frame_style.compose_styled_prompt``), как у кадров.
    """
    from app.services import frame_style

    card = _card_prompt(attrs)
    style_name, style_text, style_source = project_style(project)
    block = _style_block(style_text) if style_text else ""
    info: dict[str, Any] = {
        "prompt": card,
        "card": card,
        "card_chars": len(card),
        "style": style_name,
        "style_source": style_source,
        "style_chars": len(block),
        "style_full_chars": len(style_text),
        "trimmed": False,
        "limit": frame_style.body_limit(),
    }
    if not card or not block:
        return info
    try:
        final, scene_cut, trimmed = frame_style.compose_styled_prompt(card, block)
    except frame_style.StyleError as exc:
        logger.warning(
            "[#{}] фон: STYLE-блок {} не влезает в промт — рисую без стиля ({})",
            getattr(project, "id", "?"),
            style_name,
            exc,
        )
        return info
    info.update(
        {
            "prompt": final,
            "card_used_chars": len(scene_cut),
            "trimmed": bool(trimmed),
        }
    )
    return info


def remember_style(project: Any, info: dict[str, Any]) -> None:
    """Запомнить действующий стиль в ``meta`` — UI показывает его в результатах."""
    name = str(info.get("style") or "").strip()
    meta = getattr(project, "meta", None)
    if not name or not isinstance(meta, dict):
        return
    payload = {
        "name": name,
        "source": str(info.get("style_source") or ""),
        "chars": int(info.get("style_chars") or 0),
        "updated_at": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    existing = meta.get(PROJECT_STYLE_META_KEY)
    if isinstance(existing, dict):
        if existing.get("name") == payload["name"] and existing.get("chars") == payload["chars"]:
            return  # не шумим в meta на каждом прогоне
    project.meta = {**meta, PROJECT_STYLE_META_KEY: payload}


def style_state(project: Any) -> dict[str, Any]:
    """Что сейчас известно о стиле фонов: для API и логов (без записи)."""
    from app.services import frame_style
    from app.services.node_config import prompt_slots_for_node

    meta = getattr(project, "meta", None) or {}
    node_key = backgrounds_node_key(project)
    bound = ""
    if node_key:
        bound = frame_style.clean_style_name(
            (prompt_slots_for_node(meta, node_key) or {}).get(STYLE_SLOT_ID)
        )
    name, text, source = project_style(project)
    return {
        "node_key": node_key,
        "bound_variant": bound or None,
        "name": name or None,
        "source": source or None,
        "chars": len(text),
        "block_chars": len(_style_block(text)) if text else 0,
        "file": str(frame_style.style_path(name) or "") if name else "",
        "styles_dir": str(frame_style.styles_dir()),
    }


def _model_settings(project: Any, *, node_type: str = "images") -> dict[str, Any]:
    from app.generation_options import IMAGE_GENERATORS_BY_ID
    from app.services.vibecode_catalog import resolve_node_media_settings

    media = resolve_node_media_settings(project, node_type=node_type)
    gen = IMAGE_GENERATORS_BY_ID.get(str(media.get("image_generator_id") or ""))
    return {
        "model_slug": getattr(gen, "outsee_slug", None),
        "aspect_slug": media.get("aspect_slug") or "3:2",
        "resolution_slug": media.get("resolution_slug") or "2K",
        "quality_slug": media.get("quality_slug"),
    }


def _background_media_settings(project: Any) -> dict[str, Any]:
    """Медиа-настройки листа фона — ровно те, что человек выбрал.

    Аспект, разрешение, качество и модель берутся из настроек ноды «Фоны»
    (а если на ноде не заданы — из проекта). Никаких зашитых значений: лист
    рисуется в том соотношении, которое выбрано при генерации.
    """
    return _model_settings(project, node_type="backgrounds")


async def record_artifact(
    session: Any,
    project: Any,
    *,
    code: str,
    path: Path,
    extra: dict[str, Any] | None = None,
) -> None:
    """Артефакт фона — тем же видом, что референс персонажа, но со своим kind.

    ``extra`` уходит в ``meta`` (стиль и итоговый промт) — так UI и API видят,
    чем именно нарисован фон, не заглядывая в карточку локации.
    """
    from sqlalchemy import select

    from app.models import Artifact, ArtifactKind

    # Версия картинки для URL: UI строит превью из uuid, а он не меняется при
    # перерисовке — без mtime браузер отдаёт старый фон из кэша.
    extra = dict(extra or {})
    try:
        extra["mtime"] = int(path.stat().st_mtime)
    except OSError:
        pass

    existing = (
        (
            await session.execute(
                select(Artifact).where(
                    Artifact.project_id == project.id,
                    Artifact.kind == ArtifactKind.background_reference,
                )
            )
        )
        .scalars()
        .all()
    )
    for art in existing:
        if (art.meta or {}).get("background") == code:
            art.path = str(path)
            if extra:
                art.meta = {**(art.meta or {}), **extra}
            return
    session.add(
        Artifact(
            project_id=project.id,
            kind=ArtifactKind.background_reference,
            uuid=uuid.uuid4().hex,
            path=str(path),
            storage_key="",
            meta={"background": code, "source": "plan_cinema.backgrounds", **(extra or {})},
        )
    )


async def render_one(
    session: Any,
    project: Any,
    *,
    code: str,
    prompt: str,
    force: bool = False,
    style: str | None = None,
    record: bool = True,
) -> Path | None:
    """Одна PNG фона. ``force`` — перерисовать поверх готовой.

    ``record=False`` — только файл, без записи артефакта: так параллельные
    отрисовки не дёргают общую сессию (её пишет вызывающий под замком).
    """
    path = background_path(project, code)
    if path.is_file() and path.stat().st_size > 32 and not force:
        return path
    text = (prompt or "").strip()
    if not text:
        logger.warning("[#{}] фон {}: пустой промт — рисовать нечем", getattr(project, "id", "?"), code)
        return None
    cfg = _background_media_settings(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Рисуем в соседний .part и подменяем готовую PNG только после успеха:
    # иначе на время генерации (45–130 с) карточка пустая, а если провайдер
    # отказал или прогон отменили — старый фон терялся вовсе.
    tmp = path.with_name(path.name + ".part")
    if tmp.exists():
        tmp.unlink()
    from app.services.outsee_retry import generate_image_with_retries

    logger.info(
        "[#{}] фон {}: рисую через {} ({}, стиль {})",
        getattr(project, "id", "?"),
        code,
        cfg["model_slug"] or "provider default",
        cfg["aspect_slug"],
        style or "без стиля",
    )
    try:
        await generate_image_with_retries(
            None,
            None,
            prompt=text,
            out_path=tmp,
            max_attempts_per_prompt=2,
            gpt_rewrite=False,
            aspect_ratio=cfg["aspect_slug"],
            model_slug=cfg["model_slug"],
            resolution=cfg["resolution_slug"],
            quality=cfg["quality_slug"],
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
        await record_artifact(
            session,
            project,
            code=code,
            path=path,
            extra={"prompt": text, "style": style or "", "prompt_chars": len(text)},
        )
    return path


async def render_missing(
    session: Any,
    project: Any,
    *,
    only: list[str] | None = None,
    force: bool = False,
    concurrency: int | None = None,
) -> tuple[int, int]:
    """Дорисовать фоны без PNG. Возврат: (нарисовано, уже было).

    Рисуем параллельно (по умолчанию 3 фона одновременно): один PNG у
    провайдера идёт 45–130 с, последовательно 20+ локаций — это 15–20 минут,
    и человеку кажется, что шаг «встал». Запись артефактов в сессию
    сериализуется замком: ``AsyncSession`` не терпит одновременных запросов.
    Провалившиеся фоны не теряются молча — они возвращаются в
    ``project.meta["background_render_failures"]`` и попадают в лог.

    Пропуск вместо перерисовки — только когда картинка уже нарисована **тем
    же** промтом и стилем (отпечаток в ``meta.fingerprint`` артефакта). Сменил
    стиль или текст карточки — фон перерисуется, повторное ▶ на неизменённых
    карточках больше не жжёт по 20 картинок за нажатие.
    """
    import asyncio
    import hashlib
    import os

    from app.services.plan_cinema import apply as apply

    backgrounds = await apply.load_backgrounds(session, project)
    rendered = 0
    skipped = 0
    styled = 0
    style_info: dict[str, Any] = {}
    wanted = {c.strip() for c in (only or []) if c and c.strip()}
    # Отпечатки уже нарисованных фонов: код → что было в промте и стиле.
    # У старых артефактов отпечатка нет — сверяем сам текст промта и стиль.
    old_fingerprints: dict[str, str] = {}
    old_prompts: dict[str, tuple[str, str]] = {}
    if not force:
        from sqlalchemy import select

        from app.models import Artifact, ArtifactKind

        arts = (
            (
                await session.execute(
                    select(Artifact).where(
                        Artifact.project_id == project.id,
                        Artifact.kind == ArtifactKind.background_reference,
                    )
                )
            )
            .scalars()
            .all()
        )
        for art in arts:
            meta = art.meta or {}
            code_key = str(meta.get("background") or "")
            if not code_key:
                continue
            fp = str(meta.get("fingerprint") or "")
            if fp:
                old_fingerprints[code_key] = fp
            old_prompts[code_key] = (
                str(meta.get("style") or ""),
                str(meta.get("prompt") or ""),
            )
    todo: list[tuple[str, dict[str, Any]]] = []
    for code, attrs in (backgrounds or {}).items():
        code = str(code or "").strip()
        if not code:
            continue
        if wanted and code not in wanted:
            continue
        attrs = dict(attrs or {})
        info = build_background_prompt(project, attrs)
        if info.get("style"):
            styled += 1
        if not style_info:
            style_info = info
        fingerprint = hashlib.sha1(
            f"{info.get('style') or ''}|{info['prompt']}".encode()
        ).hexdigest()
        info["fingerprint"] = fingerprint
        path = background_path(project, code)
        old_style, old_prompt = old_prompts.get(code, ("", ""))
        same = old_fingerprints.get(code) == fingerprint or (
            code not in old_fingerprints
            and bool(old_prompt)
            and old_prompt == info["prompt"]
            and old_style == (info.get("style") or "")
        )
        if path.is_file() and path.stat().st_size > 32 and not force and same:
            skipped += 1
            continue
        todo.append((code, info))

    failures: dict[str, str] = {}
    if todo:
        limit = concurrency or int(os.getenv("BACKGROUNDS_CONCURRENCY", "3") or "3")
        sem = asyncio.Semaphore(max(1, limit))
        db_lock = asyncio.Lock()

        async def _draw(code: str, info: dict[str, Any]) -> None:
            nonlocal rendered
            async with sem:
                try:
                    made = await render_one(
                        session,
                        project,
                        code=code,
                        prompt=info["prompt"],
                        force=True,
                        style=info.get("style") or None,
                        record=False,
                    )
                except Exception as exc:  # noqa: BLE001
                    failures[code] = str(exc)[:300]
                    logger.warning("[#{}] фон {}: генерация не удалась ({})", project.id, code, exc)
                    return
            if made is None:
                failures[code] = "пустой промт"
                return
            async with db_lock:
                await record_artifact(
                    session,
                    project,
                    code=code,
                    path=made,
                    extra={
                        "prompt": info["prompt"],
                        "style": info.get("style") or "",
                        "prompt_chars": len(info["prompt"]),
                        "fingerprint": info["fingerprint"],
                    },
                )
                rendered += 1

        await asyncio.gather(*(_draw(code, info) for code, info in todo))
        if failures:
            logger.warning(
                "[#{}] фоны: не удалось {} из {} ({}), остальные готовы",
                project.id,
                len(failures),
                len(todo),
                ", ".join(sorted(failures)),
            )
        if isinstance(getattr(project, "meta", None), dict):
            meta = dict(project.meta or {})
            if failures:
                meta["background_render_failures"] = {
                    "codes": sorted(failures),
                    "errors": failures,
                    "at": datetime.now(UTC).isoformat(timespec="seconds"),
                }
            else:
                meta.pop("background_render_failures", None)
            project.meta = meta

    if style_info:
        remember_style(project, style_info)
    if styled:
        logger.info(
            "[#{}] фоны: стиль {!r} лёг на {}/{} карточек",
            getattr(project, "id", "?"),
            style_info.get("style"),
            styled,
            len(backgrounds or {}),
        )
    else:
        logger.warning(
            "[#{}] фоны: стиль проекта не настроен — карточки рисуются без STYLE-блока",
            getattr(project, "id", "?"),
        )
    return rendered, skipped
