"""Шаг 4c «Фоны» — PNG локаций до генерации кадров.

Нода ``backgrounds`` (тип ``backgrounds``, шаг ``bg``) в главной линии
канваса перед «Картинками». Карточки локаций пишет нода группы «Кино по
плану» (``pk_backgrounds``): ``описание``/``свет``/``время``/``промт`` в
``Entity(type="background")``. Здесь каждая карточка превращается в готовую
PNG (``data/videos/<slug>/backgrounds/f0N.png``) — с той же механикой, что у
персонажей: файл + артефакт ``background_reference`` + карточка в UI.

Готовые PNG повторно не рисуются: шаг идемпотентен, повторный ▶ дорисовывает
только недостающие фоны.

Стиль — как у «Персонажей»: промт каждой карточки собирается с STYLE-блоком
стиля проекта (``backgrounds_render.build_background_prompt``), выбранный стиль
кэшируется в ``project.meta["background_style"]`` — по нему UI показывает
стиль в результатах ноды.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Project, ProjectStatus


async def run(session: AsyncSession, project: Project, bot: object | None = None) -> None:
    """Отрисовать фоны и перевести проект дальше по цепочке.

    ▶ из студии (ручной режим) перерисовывает все фоны — иначе нода выглядит
    «мёртвой»: все PNG уже есть, шаг мгновенно выходит, и человек не видит
    никакой работы. В авто-режиме наоборот: дорисовываем только недостающие,
    чтобы цепочка не жгла деньги на повторной генерации.

    Статус не откатывается: если кадры уже готовы, проект остаётся
    ``images_ready``, а не падает в ``backgrounds_ready``.
    """
    from loguru import logger
    from sqlalchemy import func, select

    from app.models import Artifact, ArtifactKind
    from app.services.plan_cinema.backgrounds_render import render_missing

    meta = project.meta or {}
    # Обычный ▶ не жжёт деньги на повторной отрисовке: render_missing перерисует
    # только те карточки, у которых сменился промт или стиль (сверка отпечатка).
    # Полная перерисовка — явный флаг в meta (для ручной кнопки/скрипта).
    force = bool(meta.get("backgrounds_force_redraw")) and not bool(meta.get("auto_mode"))
    rendered, already = await render_missing(session, project, force=force)
    if force:
        # Флаг — разовый: его ставит wipe/«Перезапустить ноду», чтобы этот
        # прогон перерисовал всё. Если оставить его в meta, каждый следующий
        # ручной ▶ снова жёг бы деньги на полной перерисовке.
        fresh = dict(project.meta or {})
        fresh.pop("backgrounds_force_redraw", None)
        project.meta = fresh
    style_cache = (project.meta or {}).get("background_style")
    style_name = str(style_cache.get("name") or "") if isinstance(style_cache, dict) else ""
    failed = (project.meta or {}).get("background_render_failures") or {}
    failed_codes = failed.get("codes") if isinstance(failed, dict) else None
    await session.commit()
    logger.info(
        "[#{}] generate_backgrounds: нарисовано {}, готовых {} (force={}, стиль {})",
        project.id,
        rendered,
        already,
        force,
        style_name or "без стиля",
    )
    if failed_codes:
        logger.warning(
            "[#{}] generate_backgrounds: не перерисованы {} — провайдер отказал, "
            "старые PNG остались на месте; перезапусти шаг или нажми «Перерисовать этот фон» на карточке",
            project.id,
            ", ".join(str(c) for c in failed_codes),
        )

    from app.services.db_v2 import count_live_frames

    frames_total = await count_live_frames(session, project.id)
    images_done = (
        await session.execute(
            select(func.count(Artifact.id)).where(
                Artifact.project_id == project.id,
                Artifact.kind == ArtifactKind.scene_image,
            )
        )
    ).scalar_one()
    if frames_total and images_done >= frames_total:
        project.status = ProjectStatus.images_ready
    else:
        project.status = ProjectStatus.backgrounds_ready
    await session.commit()
