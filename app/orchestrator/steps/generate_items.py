"""Шаг 4b «Предметы» — генерация реф-картинок предметов.

Параллельная ветвь шага 4 «Объекты»: если шаг 4a «Персонажи» делает
hero_reference, то 4b делает item_reference. Логика проще, чем у Hero:
без HITL, без вариаций (1 картинка на предмет).

Источник списка предметов: `project.item_descriptions: list[str]`, а если он
пуст — сущности `Entity(type="prop"|"item")` того же проекта (их описания
переезжают в `item_descriptions`, чтобы дальше был один источник). Если нет и
сущностей — предметы собираются из карточек сцен «Кино по плану»: берутся
только те вещи, которые используются минимум в двух кадрах, и рядом с каждой
сохраняются кадры её появления (`attrs["кадры"]`).
По одному непустому описанию = один сгенерированный предмет.
Файлы кладутся в `data/videos/<slug>/items/predmet<N>_<uuid>.png`,
где N — 1-based индекс предмета.

Если шаг падает на каком-то предмете — статус откатывается на
hero_ready (предметы опциональны), юзер правит описание и жмёт
«Предметы» снова.
"""

from __future__ import annotations

import re
import uuid
from contextlib import asynccontextmanager
from typing import Any

from loguru import logger
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.bots.browser import browser_session
from app.services.image_transport import http_image_primary


@asynccontextmanager
async def _optional_browser(need_cdp: bool):
    if not need_cdp:
        yield None
        return
    async with browser_session() as bs:
        yield bs


from app.bots.outsee import (
    OutseeBot,
    OutseeContentRejectedError,
    OutseeImageError,
)
from app.generation_options import (
    IMAGE_GENERATORS_BY_ID,
    IMAGE_RESOLUTIONS_BY_ID,
)
from app.models import Artifact, ArtifactKind, Entity, Frame, Project, ProjectStatus
from app.services.gpt_client import get_gpt_client
from app.services.img_streams import acquire_image_slot
from app.services.outsee_retry import generate_image_with_retries
from app.services.prompt_library import get_project_prompt
from app.services.step_cancel import raise_if_cancelled

# Aspect ratio и Relax для предметов — как у hero (16:9 + Relax), потому
# что предметы тоже идут как реф-листы.
ITEM_ASPECT_RATIO = "16:9"
ITEM_RELAX = True


async def _existing_item_indices(session: AsyncSession, project: Project) -> set[int]:
    """Какие индексы предметов уже имеют артефакт kind=item_reference."""
    rows = (
        (
            await session.execute(
                select(Artifact)
                .where(
                    Artifact.project_id == project.id,
                    Artifact.kind == ArtifactKind.item_reference,
                )
                .order_by(desc(Artifact.id))
            )
        )
        .scalars()
        .all()
    )
    out: set[int] = set()
    for a in rows:
        m = a.meta or {}
        idx = m.get("item_index")
        if isinstance(idx, int):
            out.add(idx)

    # Файл на диске без Artifact (откат БД / сбой сессии) — тоже «готов»,
    # иначе шаг перерисует уже нарисованный предмет.
    items_dir = project.data_dir / "items"
    if items_dir.is_dir():
        for p in items_dir.glob("predmet*.png"):
            try:
                if not p.is_file() or p.stat().st_size <= 1000:
                    continue
            except OSError:
                continue
            num_part = p.stem.split("_")[0][len("predmet") :]
            if num_part.isdigit():
                out.add(int(num_part))
    return out


#: Сколько кадров должны использовать вещь, чтобы она попала в реестр предметов.
MIN_PROP_FRAMES = 2
#: Сколько предметов максимум заводим за прогон: каждый — отдельная картинка,
#: то есть деньги.
MAX_PROPS = 8

#: Промт по умолчанию для разбора раскадровки. Живёт в коде, потому что
#: библиотеки промтов на сервере может не быть вовсе.
PROPS_EXTRACT_PROMPT = """\
Ты разбираешь раскадровку короткого ролика и выписываешь ПРЕДМЕТЫ — отдельные
вещи, которые персонаж держит, берёт или использует по сюжету.

Ответь строго списком, по строке на предмет, без вступления и пояснений:
- <название> | <как выглядит: цвет, материал, форма, приметы> | <кадры, где виден, через запятую: S1-K1, S2-K4>

Что считается предметом:
* Оружие, документ, письмо, инструмент, прибор, артефакт, вещь в руках или на
  поясе, единичная ценная вещь, которую передают из рук в руки.
* Одна конкретная вещь, а не всё, что видно в кадре.

Что предметом НЕ является и в ответ не идёт:
* Место и архитектура, декорации и части фона: возвышение, ложе, трон, стол,
  панель управления, кольца и проходы, входы и арки, стены, пол, окна, колонны,
  статуи и изображения на стене, витражи, мебель, транспорт.
* Свет, погода, толпа, легионы, любые «массы» людей.
* Части тел и одежда персонажа.

Правила:
* Один предмет — одна строка; название короткое, как в тексте кадра.
* В третьей графе — только те кадры, где предмет реально виден. Не выдумывай.
* Не больше {max_props} предметов: оставь те, что важнее для сюжета.
* Сомневаешься, предмет это или часть обстановки, — не включай.
* Пиши по-русски.

РАСКАДРОВКА:
{frames}
"""

#: Маркеры фона и декораций. Даже если модель назвала их предметами, в реестр
#: они не идут: часть кадра — не предмет (владелец 23.11.2026).
_SCENERY_MARKERS = (
    "возвышен", "ложе", "стол", "кольц", "проход", "вход", "выход", "стен", "пол",
    "потолок", "лестниц", "арк", "окно", "двер", "площад", "зал", "храм", "панел",
    "изображени", "стату", "трон", "фон", "неб", "толп", "колонн", "кресл", "полк",
    "прилав", "сцен", "подиум", "мост", "коридор", "галере", "витраж", "портал",
)

#: Строка списка: «- », «* », «1. », «1) ».
_BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$")
_FRAME_SPLIT_RE = re.compile(r"[,;]")


def _prop_name(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("название") or value.get("name") or value.get("предмет") or ""
    return str(value or "").strip()


def is_scenery(name: str) -> bool:
    """Похоже ли название на часть фона/декорацию, а не на предмет."""
    low = (name or "").strip().casefold()
    if not low:
        return False
    return any(marker in low for marker in _SCENERY_MARKERS)


def _prop_usage_from_cards(cards: list[Any]) -> dict[str, dict[str, Any]]:
    """Предмет → кадры, где он появляется, и его вид (из карточек сцен).

    «Сцены по плану» несут сквозные предметы в поле ``предметы`` карточки, а
    «Шоты» — в ``предметы`` каждого кадра внутри ``кадры``. В реестр идут только
    вещи, которые используются не меньше чем в двух кадрах (владелец
    22.11.2026): одиночный реквизит реф-листа не заводит, а кадры использования
    сохраняем рядом с предметом — видно, где он снимается.
    """
    usage: dict[str, dict[str, str]] = {}
    display: dict[str, str] = {}

    def push(value: Any, label: str) -> None:
        name = _prop_name(value)
        if not name:
            return
        key = name.casefold()
        display.setdefault(key, name)
        usage.setdefault(key, {}).setdefault(label, name)

    for card in cards:
        if not isinstance(card, dict):
            continue
        scene_no = str(card.get("номер") or "").strip()
        scene_label = f"сцена {scene_no}" if scene_no else "сцена"
        for value in card.get("предметы") or []:
            push(value, scene_label)
        for shot in card.get("кадры") or []:
            if not isinstance(shot, dict):
                continue
            shot_no = str(shot.get("номер") or shot.get("порядок") or "").strip()
            frame_label = f"сцена {scene_no}, кадр {shot_no}" if shot_no else scene_label
            for value in shot.get("предметы") or []:
                push(value, frame_label)

    found: dict[str, dict[str, Any]] = {}
    for key, labels in usage.items():
        if len(labels) < MIN_PROP_FRAMES:
            continue
        found[display[key]] = {"frames": list(labels), "description": ""}
    return found


def _frames_digest(cards: list[Any]) -> str:
    """Текст раскадровки для модели: по строке на кадр, с ярлыком вида S1-K2."""
    lines: list[str] = []
    for card in cards:
        if not isinstance(card, dict):
            continue
        scene_no = str(card.get("номер") or "").strip()
        shots = [s for s in (card.get("кадры") or []) if isinstance(s, dict)]
        if not shots:
            text = " ".join(
                str(card.get(k) or "").strip() for k in ("сцена", "место", "событие")
            ).strip()
            if text:
                lines.append(f"сцена {scene_no}: {text}")
            continue
        for shot in shots:
            shot_no = str(shot.get("номер") or shot.get("порядок") or "").strip()
            label = str(shot.get("id") or "").strip() or f"S{scene_no}-K{shot_no}"
            parts = [
                str(shot.get(k) or "").strip()
                for k in ("действие", "кто_где", "позы", "эмоции")
            ]
            text = " ".join(p for p in parts if p)
            props = [p for p in (_prop_name(v) for v in (shot.get("предметы") or [])) if p]
            if props:
                text = f"{text} Предметы: {', '.join(props)}".strip()
            if text:
                lines.append(f"{label}: {text}")
    return "\n".join(lines)[:12000]


def parse_props_reply(reply: str) -> dict[str, dict[str, Any]]:
    """Ответ модели → {название: {description, frames}}. Разбор снисходительный.

    Модель ставит дефисы и нумерацию по-разному и любит обёртки вроде «вот
    список», поэтому строку списка вытаскиваем регуляркой, а не жёстким форматом.
    """
    props: dict[str, dict[str, Any]] = {}
    for raw in (reply or "").splitlines():
        line = raw.replace("**", "").replace("__", "").strip()
        if not line:
            continue
        match = _BULLET_RE.match(line)
        if not match:
            continue
        parts = [part.strip() for part in match.group(1).split("|")]
        name = parts[0].strip().strip("«»\"'").strip()
        if not name:
            continue
        description = parts[1].strip() if len(parts) > 1 else ""
        frames: list[str] = []
        if len(parts) > 2:
            frames = [f.strip() for f in _FRAME_SPLIT_RE.split(parts[2]) if f.strip()]
        props[name] = {"description": description, "frames": frames}
    return props


async def _extract_props_from_frames(
    project: Project,
    cards: list[Any],
) -> dict[str, dict[str, Any]]:
    """Спросить модель, какие предметы видны в кадрах и где именно."""
    digest = _frames_digest(cards)
    if not digest:
        return {}
    prompt = PROPS_EXTRACT_PROMPT.replace("{max_props}", str(MAX_PROPS)).replace(
        "{frames}", digest
    )
    try:
        reply = await get_gpt_client().ask_fresh(prompt, project_id=project.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "[#{}] items: модель не разобрала кадры ({}) — предметов нет",
            project.id,
            exc,
        )
        return {}
    found: dict[str, dict[str, Any]] = {}
    dropped: list[str] = []
    for name, data in parse_props_reply(reply).items():
        if is_scenery(name):
            dropped.append(name)
            continue
        frames = list(dict.fromkeys(data.get("frames") or []))
        if len(frames) < MIN_PROP_FRAMES:
            continue
        found[name] = {"description": data.get("description") or "", "frames": frames}
        if len(found) >= MAX_PROPS:
            break
    if dropped:
        logger.info(
            "[#{}] items: отброшены части фона, а не предметы: {}",
            project.id,
            ", ".join(dropped)[:300],
        )
    logger.info(
        "[#{}] items: модель нашла предметов={} (в кадрах не меньше {}): {}",
        project.id,
        len(found),
        MIN_PROP_FRAMES,
        "; ".join(f"{n} — {', '.join(d['frames'])}" for n, d in found.items())[:600],
    )
    return found


async def _pk_scene_cards(session: AsyncSession, project: Project) -> list[dict[str, Any]]:
    """Карточки активных сцен «Кино по плану» (``attrs.источник == "pk"``)."""
    try:
        frames = (
            (
                await session.execute(
                    select(Frame)
                    .where(Frame.project_id == project.id)
                    .order_by(Frame.number, Frame.id)
                )
            )
            .scalars()
            .all()
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[#{}] items: сцены не прочитались: {}", project.id, exc)
        return []
    cards: list[dict[str, Any]] = []
    for frame in frames:
        attrs = frame.attrs if isinstance(frame.attrs, dict) else {}
        if str(attrs.get("источник") or "") != "pk":
            continue
        if attrs.get("удалён"):
            continue
        cards.append(attrs)
    return cards


async def _sync_prop_entities(
    session: AsyncSession,
    project: Project,
    props: dict[str, dict[str, Any]],
) -> None:
    """Завести/обновить ``Entity(type="prop")``: имя, описание и кадры появления."""
    if not props:
        return
    try:
        ents = (
            (
                await session.execute(
                    select(Entity)
                    .where(Entity.project_id == project.id, Entity.type.in_(["prop", "item"]))
                    .order_by(Entity.sort_key, Entity.id)
                )
            )
            .scalars()
            .all()
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[#{}] items: реестр предметов не прочитался: {}", project.id, exc)
        return
    by_name = {(e.name or "").strip().casefold(): e for e in ents if (e.name or "").strip()}
    used_codes = {str(e.code or "").strip() for e in ents if (e.code or "").strip()}
    taken_numbers = {int(c[1:]) for c in used_codes if c.startswith("p") and c[1:].isdigit()}
    max_key = max((float(e.sort_key or 0) for e in ents), default=0.0)
    next_number = 1
    for name, data in props.items():
        frames = list(data.get("frames") or [])
        attrs = {
            "description": str(data.get("description") or "").strip(),
            "кадры": frames,
            "кадров": len(frames),
        }
        entity = by_name.get(name.casefold())
        if entity is not None:
            merged = dict(entity.attrs or {})
            merged.update(attrs)
            entity.attrs = merged
            continue
        while next_number in taken_numbers:
            next_number += 1
        code = f"p{next_number:02d}"
        taken_numbers.add(next_number)
        max_key += 10.0
        created = Entity(
            project_id=project.id,
            type="prop",
            code=code,
            name=name,
            attrs=attrs,
            sort_key=max_key,
        )
        session.add(created)
        by_name[name.casefold()] = created
    await session.flush()


async def _write_props(
    session: AsyncSession,
    project: Project,
    props: dict[str, dict[str, Any]],
) -> list[str]:
    """Записать найденные предметы: описания в проект, кадры — в реестр."""
    descriptions: list[str] = []
    for name, data in props.items():
        description = str(data.get("description") or "").strip()
        descriptions.append(f"{name} — {description}" if description else name)
    project.item_descriptions = descriptions
    flag_modified(project, "item_descriptions")
    await _sync_prop_entities(session, project, props)
    await session.flush()
    return descriptions


async def _resolve_item_descriptions(session: AsyncSession, project: Project) -> list[str]:
    """Описания предметов: поле проекта, сущности, карточки сцен, разбор кадров.

    Состав предметов заводят сущностями (тот же источник, что и каст), поле
    проекта заполняют руками, а «Кино по плану» кладёт предметы в карточки сцен.
    Если в карточках пусто (короткая карточка их не пишет), кадры разбирает
    модель: в реестр идут вещи, видимые минимум в двух кадрах, вместе с кадрами.
    Что нашли, переносим в поле проекта, чтобы дальше по шагу был один источник.
    """
    raw = list(project.item_descriptions or [])
    descriptions = [d.strip() for d in raw if isinstance(d, str) and d.strip()]
    if descriptions:
        return descriptions

    try:
        ents = (
            (
                await session.execute(
                    select(Entity)
                    .where(
                        Entity.project_id == project.id,
                        Entity.type.in_(["prop", "item"]),
                    )
                    .order_by(Entity.sort_key, Entity.id)
                )
            )
            .scalars()
            .all()
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[#{}] items: Entity fallback failed: {}", project.id, exc)
        ents = []

    for e in ents:
        attrs = e.attrs or {}
        desc_val = str(attrs.get("description") or attrs.get("описание") or "").strip()
        name_val = (e.name or "").strip()
        text = f"{name_val}: {desc_val}" if name_val and desc_val else (desc_val or name_val)
        if text and text not in descriptions:
            descriptions.append(text)

    if descriptions:
        project.item_descriptions = descriptions
        flag_modified(project, "item_descriptions")
        await session.flush()
        logger.info(
            "[#{}] items: описания взяты из сущностей ({} шт.)",
            project.id,
            len(descriptions),
        )
        return descriptions

    cards = await _pk_scene_cards(session, project)
    usage = _prop_usage_from_cards(cards)
    if usage:
        descriptions = await _write_props(session, project, usage)
        logger.info(
            "[#{}] items: предметы из карточек сцен, минимум {} кадра: {}",
            project.id,
            MIN_PROP_FRAMES,
            "; ".join(f"{n} — {', '.join(d['frames'])}" for n, d in usage.items())[:600],
        )
        return descriptions

    # В карточках предметов нет — короткая карточка сцены их не пишет. Разбираем
    # сами кадры: годятся вещи, которые видны минимум в двух кадрах, и рядом с
    # каждой сохраняем кадры её появления.
    extracted = await _extract_props_from_frames(project, cards)
    if not extracted:
        return []
    return await _write_props(session, project, extracted)


def _items_style_prompt(project: Project) -> str:
    """Мастер-промт для генерации предметов (prompts/04b_items/<name>.md).
    Если ничего не выбрано/нет файла — пустая строка (юзер должен
    положить хотя бы default.md)."""
    try:
        return get_project_prompt(project, "items").strip()
    except FileNotFoundError:
        logger.warning(
            "[#{}] items: стиля предметов нет ни в базе, ни на диске — генерирую из описаний без стиля",
            project.id,
        )
        return ""


async def run(session: AsyncSession, project: Project, bot: Any = None) -> None:
    if project.status is not ProjectStatus.generating_items:
        return

    descriptions = await _resolve_item_descriptions(session, project)
    if not descriptions:
        # Метка обязательна, иначе получается вечный цикл — ровно тот, что уже
        # чинили для героя (см. `hero_skipped_empty` в generate_hero).
        #
        # Без неё стороны читают одно и то же поле и расходятся во мнении:
        # шаг видит пустой `item_descriptions` и считает работу сделанной, а
        # `_items_step_required` из того же пустого списка заключает, что шага
        # нет вовсе — и `compute_actual_status` НИКОГДА не возвращает
        # `items_ready`, только `hero_ready`. Дальше страж откатывает статус,
        # авто-продвижение снова одобряет `hero_ready` → `generating_items`, и
        # так каждые пять секунд без конца.
        #
        # Отказом это не считается: формально ничего не падает, счётчик
        # `step_failure_policy` не растёт, паузы не наступает. Поймано живым
        # прогоном 2026-08-25 — проект крутился семь минут, пока не посмотрели
        # в журнал.
        meta = dict(project.meta or {})
        meta["items_skipped_empty"] = True
        project.meta = meta
        flag_modified(project, "meta")
        logger.info(
            "[#{}] items: item_descriptions пуст — items_ready без работы (items_skipped_empty)",
            project.id,
        )
        project.status = ProjectStatus.items_ready
        await session.flush()
        return

    style = _items_style_prompt(project)
    from app.services.vibecode_catalog import resolve_node_media_settings

    media = resolve_node_media_settings(project, node_type="items")
    img_gid = media["image_generator_id"]
    img_gen = IMAGE_GENERATORS_BY_ID.get(img_gid)
    ir = IMAGE_RESOLUTIONS_BY_ID.get(media["resolution_id"])
    quality_slug = media["quality_slug"]
    # items historically force square; нода может задать своё соотношение.
    item_aspect = media["aspect_slug"] or ITEM_ASPECT_RATIO

    already_done = await _existing_item_indices(session, project)
    out_dir = project.data_dir / "items"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Идём по предметам последовательно, пропускаем уже сгенерированные.
    for idx, desc_text in enumerate(descriptions, start=1):
        raise_if_cancelled(project.id)
        if idx in already_done:
            logger.info(
                "[#{}] items: predmet{} уже есть, пропускаю",
                project.id,
                idx,
            )
            continue
        logger.info(
            "[#{}] items: предмет {}/{} — '{}'",
            project.id,
            idx,
            len(descriptions),
            desc_text[:60],
        )

        full_prompt = (
            style + "\n\n---\n\n" if style else ""
        ) + f"Описание предмета (predmet{idx}): {desc_text}"

        short_uuid = uuid.uuid4().hex[:8]
        file_name = f"predmet{idx}_{short_uuid}.png"
        out_path = out_dir / file_name
        prompt_id_prefix = f"[ID: P{project.id}-ITEM{idx}-{short_uuid}]"

        try:
            # Chrome — только если нет HTTP-провайдера (см. image_transport).
            async with _optional_browser(need_cdp=not http_image_primary()) as bs:
                outsee = OutseeBot(bs) if bs is not None else None
                gpt = get_gpt_client()
                # Слот общего пула провайдера: предметы идут наравне с
                # кадрами и героем, иначе шаг обходит лимит параллели.
                async with acquire_image_slot():
                    result = await generate_image_with_retries(
                        outsee,
                        gpt,
                        prompt=full_prompt,
                        out_path=out_path,
                        max_attempts_per_prompt=3,
                        gpt_rewrite=True,
                        aspect_ratio=item_aspect,
                        model_slug=img_gen.outsee_slug if img_gen else None,
                        resolution=ir.outsee_slug if ir else None,
                        quality=quality_slug,
                        relax=ITEM_RELAX,
                        prompt_id_prefix=prompt_id_prefix,
                        reference_image=None,
                        timeout=600,
                        project_id=project.id,
                    )
        except OutseeImageError as e:
            is_moderation = isinstance(e, OutseeContentRejectedError)
            logger.error(
                "[#{}] items: predmet{} 6 попыток провалились (moderation={}): {}",
                project.id,
                idx,
                is_moderation,
                getattr(e, "reason", None) or str(e),
            )
            # Откат на hero_ready: предметы опциональны, юзер может
            # пропустить и идти дальше.
            project.status = ProjectStatus.hero_ready
            await session.flush()
            raise RuntimeError(
                f"items: predmet{idx} не удалось сгенерить "
                f"(см. логи). Статус откатил на hero_ready — поправь "
                f"описание предмета и жми «Предметы» снова."
            ) from e

        # Сохраняем артефакт.
        a = Artifact(
            project_id=project.id,
            frame_id=None,
            kind=ArtifactKind.item_reference,
            uuid=uuid.uuid4().hex,
            path=str(result.file_path),
            meta={
                "item_index": idx,
                "item_id": f"predmet{idx}",
                "description": desc_text,
                "prompt": full_prompt,
            },
        )
        session.add(a)
        await session.flush()
        logger.info(
            "[#{}] items: predmet{} → {}",
            project.id,
            idx,
            result.file_path,
        )

    # Все предметы готовы.
    project.status = ProjectStatus.items_ready
    await session.flush()
    logger.info(
        "[#{}] items: все {} предметов готовы → items_ready",
        project.id,
        len(descriptions),
    )
