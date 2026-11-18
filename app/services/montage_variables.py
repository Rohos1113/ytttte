"""Переменные проекта по нодам графа — данные для панели «Переменные проекта».

Кнопка «+» над доской монтажа открывает список того, что произвели ноды
проекта. Значения собирает сервер: фронт не знает, где что лежит, и ничего не
хардкодит. Здесь единственное место, где описано соответствие
«нода → переменные» — декларативный реестр :data:`NODE_VARIABLE_SPECS`.

**Почему реестр, а не разбор по месту.** Нод десятки, источников ещё больше:
поля ``projects``, ``projects.meta``, ``frames`` / ``frames.attrs``,
``artifacts``, файлы ``data/<slug>/…``. Разложенное по вёрстке соответствие
разъехалось бы с бэкендом на первой же новой ноде. Одна таблица — одна правка.

**Почему отдельный endpoint, а не поле доски.** Доска на 32 кадрах уже 175 КБ
и перезапрашивается на каждое «Применить правки», а переменные нужны только по
клику. Отдельный ответ живёт в своём кэше react-query.

Тяжёлое целиком не отдаём: у текста есть ``preview`` (первые
``PREVIEW_CHARS``) и ``count`` (длина в символах); у списков и медиа —
``count``; картинки/видео/аудио и файлы идут ссылками ``/api/files`` /
``/api/artifacts``. Текст длиннее ``LONG_TEXT_LIMIT`` остаётся без ``value``
(``truncated``), чтобы один ответ не раздувался до мегабайт.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from loguru import logger
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Artifact, ArtifactKind, AsrWord, Frame, Project, PromptVersion

#: Сколько символов текста показываем в свёрнутом виде.
PREVIEW_CHARS = 300

#: Текст длиннее этого не отдаём в ``value`` — только preview + count.
LONG_TEXT_LIMIT = 100_000

#: Сколько файлов максимум в одной медиа-переменной.
MEDIA_LIMIT = 60

_IMAGE_SUFFIXES: frozenset[str] = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_VIDEO_SUFFIXES: frozenset[str] = frozenset({".mp4", ".webm", ".mov"})
_AUDIO_SUFFIXES: frozenset[str] = frozenset({".mp3", ".wav", ".m4a", ".ogg", ".flac"})

#: Состояния графа → пять состояний панели.
_STATE_MAP: dict[str, str] = {
    "done": "done",
    "running": "running",
    "queued": "running",
    "waiting_hitl": "running",
    "failed": "error",
    "error": "error",
    "skipped": "disabled",
    "disabled": "disabled",
    "pending": "pending",
}


#: Имя слота из ключа ноды группы ``script_frames_qc``: ``n_excel_gpt_pk_cast``.
_PK_SLOT_RE = re.compile(r"pk_([a-z0-9_]+)$", re.IGNORECASE)


@dataclass
class VarCtx:
    """Всё, что нужно геттеру переменной: проект, его данные и его нода."""

    project: Project
    meta: dict[str, Any]
    frames: list[Frame]
    artifacts: list[Artifact]
    data_dir: Path
    node_key: str
    node: dict[str, Any]
    prompt_versions: dict[str, int]
    asr_words: int


@dataclass(frozen=True)
class VarSpec:
    """Одна переменная ноды: что показать и откуда взять.

    ``get`` получает :class:`VarCtx` и возвращает сырое значение; форму
    ответа выбирает :func:`_var_payload` по ``kind``.
    """

    key: str
    label: str
    kind: str
    source: str
    get: Callable[[VarCtx], Any]


# ── Помощники ────────────────────────────────────────────────────────────


def _text_of(value: Any) -> str:
    """Строка из чего угодно; None/пусто → «». Словари — компактным JSON."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (dict, list, tuple)):
        try:
            return json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            return str(value)
    return str(value).strip()


def _file_entry(path: Path | None) -> dict[str, Any] | None:
    """Ссылка на файл через ``/api/files``; ``None`` — файла нет."""
    if path is None or not path.is_file():
        return None
    try:
        stamp = int(path.stat().st_mtime)
    except OSError:
        stamp = 0
    return {
        "label": path.name,
        "url": f"/api/files?path={quote(str(path), safe='')}&v={stamp}",
    }


def _disk_files(base: Path, suffixes: frozenset[str] | set[str] | None = None) -> list[Path]:
    """Файлы папки (без рекурсии), отсортированные по имени — стабильный порядок."""
    if not base.is_dir():
        return []
    found = [p for p in base.iterdir() if p.is_file()]
    if suffixes is not None:
        found = [p for p in found if p.suffix.lower() in suffixes]
    return sorted(found, key=lambda p: p.name)


def _artifact_entries(ctx: VarCtx, kinds: tuple[ArtifactKind, ...]) -> list[dict[str, Any]]:
    """Ссылки на артефакты нужных видов (``/api/artifacts/<uuid>/file``)."""
    wanted = set(kinds)
    out: list[dict[str, Any]] = []
    for art in ctx.artifacts:
        if art.kind not in wanted:
            continue
        if art.uuid:
            label = Path(art.path).name if art.path else art.uuid
            out.append({"label": label, "url": f"/api/artifacts/{art.uuid}/file"})
            continue
        entry = _file_entry(Path(art.path) if art.path else None)
        if entry is not None:
            out.append(entry)
    out.sort(key=lambda item: str(item.get("label") or ""))
    return out


def _disk_entries(paths: list[Path], seen: set[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in paths:
        entry = _file_entry(path)
        if entry is None or entry["label"] in seen:
            continue
        seen.add(entry["label"])
        out.append(entry)
    return out


def _media(
    ctx: VarCtx,
    *,
    artifacts: tuple[ArtifactKind, ...] = (),
    dirs: tuple[str, ...] = (),
    suffixes: frozenset[str] = _IMAGE_SUFFIXES,
) -> list[dict[str, Any]]:
    """Медиа-переменная: сначала актуальные артефакты, потом файлы на диске."""
    entries = _artifact_entries(ctx, artifacts)
    seen = {str(item.get("label") or "") for item in entries}
    files: list[Path] = []
    for name in dirs:
        files.extend(_disk_files(ctx.data_dir / name, suffixes))
    entries.extend(_disk_entries(files, seen))
    return entries[:MEDIA_LIMIT]


def _scene_images(ctx: VarCtx) -> list[dict[str, Any]]:
    """Картинки кадров: артефакты + по одной (последней по имени) на кадр с диска."""
    entries = _artifact_entries(ctx, (ArtifactKind.scene_image,))
    seen = {str(item.get("label") or "") for item in entries}
    latest: dict[str, Path] = {}
    for path in _disk_files(ctx.data_dir / "scenes", _IMAGE_SUFFIXES):
        parts = path.stem.split("_")
        key = "_".join(parts[:2]) if len(parts) >= 2 else path.stem
        latest[key] = path
    entries.extend(_disk_entries([latest[key] for key in sorted(latest)], seen))
    return entries[:MEDIA_LIMIT]


def _frame_rows(frames: list[Frame], getter: Callable[[Frame], str]) -> list[dict[str, Any]]:
    """Таблица «кадр → значение» для переменной вида ``frames``."""
    return [{"frame": fr.number, "value": getter(fr)} for fr in frames]


def _frame_timing(fr: Frame) -> str:
    parts: list[str] = []
    if fr.start_ts is not None and fr.end_ts is not None:
        parts.append(f"{fr.start_ts:.2f}–{fr.end_ts:.2f} с")
    if fr.duration_seconds is not None:
        parts.append(f"длительность {fr.duration_seconds:.2f} с")
    return " · ".join(parts)


def _frame_scene(fr: Frame) -> str:
    attrs = fr.attrs if isinstance(fr.attrs, dict) else {}
    parts = [
        _text_of(attrs.get("место")),
        _text_of(attrs.get("персонажи")),
        _text_of(attrs.get("предметы")),
        _text_of(attrs.get("событие") or attrs.get("сцена")),
    ]
    return " · ".join(part for part in parts if part)


def _result_entry(ctx: VarCtx) -> dict[str, Any]:
    results = ctx.meta.get("gpt_operator_results")
    if not isinstance(results, dict):
        return {}
    entry = results.get(ctx.node_key)
    return dict(entry) if isinstance(entry, dict) else {}


def _get_reply(ctx: VarCtx) -> str:
    return _text_of(_result_entry(ctx).get("replyPreview"))


def _get_gate(ctx: VarCtx) -> str:
    return _text_of(_result_entry(ctx).get("gateStatus"))


def _get_output_files(ctx: VarCtx) -> list[dict[str, Any]]:
    raw = _result_entry(ctx).get("outputPaths")
    paths = raw if isinstance(raw, list) else []
    out: list[dict[str, Any]] = []
    for item in paths:
        text = _text_of(item)
        if not text:
            continue
        path = Path(text)
        if not path.is_absolute():
            path = ctx.data_dir / text
        entry = _file_entry(path)
        if entry is not None:
            out.append(entry)
    return out


def _get_xlsx_snapshot(ctx: VarCtx) -> list[dict[str, Any]]:
    snapshots = ctx.meta.get("xlsx_snapshots_by_node")
    if not isinstance(snapshots, dict):
        return []
    entry = snapshots.get(ctx.node_key)
    rel = ""
    if isinstance(entry, dict):
        rel = _text_of(entry.get("rel"))
    elif isinstance(entry, str):
        rel = entry.strip()
    if not rel:
        return []
    path = Path(rel)
    if not path.is_absolute():
        path = ctx.data_dir / rel
    file_entry = _file_entry(path)
    return [file_entry] if file_entry is not None else []


def _get_general_plan_file(ctx: VarCtx) -> list[dict[str, Any]]:
    entry = _file_entry(ctx.data_dir / "general_plan.txt")
    return [entry] if entry is not None else []


def _get_voiceover_file(ctx: VarCtx) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for name in ("voiceover.txt", "script.txt"):
        entry = _file_entry(ctx.data_dir / name)
        if entry is not None:
            out.append(entry)
    return out


def _get_plan_xlsx(ctx: VarCtx) -> list[dict[str, Any]]:
    entry = _file_entry(ctx.data_dir / "project.xlsx")
    return [entry] if entry is not None else []


def _get_scene_design_meta(ctx: VarCtx) -> Any:
    return ctx.meta.get("scene_design")


def _get_background_style(ctx: VarCtx) -> Any:
    return ctx.meta.get("background_style")


def _get_videos_meta(ctx: VarCtx) -> dict[str, Any]:
    meta = ctx.meta.get("montage_board")
    return dict(meta) if isinstance(meta, dict) else {}


def _get_stale_videos(ctx: VarCtx) -> list[str]:
    raw = _get_videos_meta(ctx).get("stale_videos")
    return [_text_of(item) for item in raw if _text_of(item)] if isinstance(raw, list) else []


def _get_sfx_plan(ctx: VarCtx) -> Any:
    return ctx.meta.get("sfx_plan")


def _get_sfx_plan_file(ctx: VarCtx) -> list[dict[str, Any]]:
    entry = _file_entry(ctx.data_dir / "sfx_plan.json")
    return [entry] if entry is not None else []


def _get_bgm_path(ctx: VarCtx) -> str:
    return _text_of(ctx.meta.get("bgm_path"))


def _get_subtitles(ctx: VarCtx) -> list[dict[str, Any]]:
    entries = _artifact_entries(ctx, (ArtifactKind.subtitle,))
    seen = {str(item.get("label") or "") for item in entries}
    entries.extend(_disk_entries(_disk_files(ctx.data_dir / "subs"), seen))
    return entries[:MEDIA_LIMIT]


def _get_final_files(ctx: VarCtx) -> list[dict[str, Any]]:
    entries = _artifact_entries(ctx, (ArtifactKind.final_video,))
    seen = {str(item.get("label") or "") for item in entries}
    entries.extend(_disk_entries(_disk_files(ctx.data_dir / "final"), seen))
    return entries[:MEDIA_LIMIT]


def _get_hero_count(ctx: VarCtx) -> int:
    raw = ctx.project.hero_count
    return int(raw) if isinstance(raw, int) else 0


def _get_descriptions(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [_text_of(item) for item in value if _text_of(item)]


# ── Реестр «нода → переменные» ───────────────────────────────────────────

_SCENE_SPECS: list[VarSpec] = [
    VarSpec(
        "scene_design_meta",
        "Состояние дизайна сцен",
        "json",
        "projects.meta.scene_design",
        _get_scene_design_meta,
    ),
    VarSpec(
        "scene_attrs",
        "Сцена по кадрам (место · персонажи · предметы · событие)",
        "frames",
        "frames.attrs",
        lambda c: _frame_rows(c.frames, _frame_scene),
    ),
    VarSpec(
        "scene_chain",
        "Связка кадров внутри сцены",
        "frames",
        "frames.attrs.кадры",
        lambda c: _frame_rows(
            c.frames,
            lambda fr: _text_of((fr.attrs or {}).get("кадры")) if isinstance(fr.attrs, dict) else "",
        ),
    ),
]

#: Какие строки доски монтажа питает нода — чтобы клик по шагу в панели мог
#: показать его данные строкой на доске. Ключи совпадают с ``RowKey`` доски
#: (``web/src/components/canvas/assemble-montage-board.tsx``): ``image1`` —
#: «Кадры», ``video1`` — «Видео 1», ``voiceover`` — «Закадр кадра/Закадровый
#: текст», ``action`` — «Действие кадра», ``timestamps`` — «Таймкоды».
#: Пусто — шаг кормит только данные панели, строки на доске у него нет.
_MONTAGE_ROWS_BY_TYPE: dict[str, tuple[str, ...]] = {
    "images": ("image1",),
    "videos": ("video1",),
    "audio": ("voiceover", "timestamps"),
    "script": ("voiceover",),
    "plan": ("action",),
}

NODE_VARIABLE_SPECS: dict[str, list[VarSpec]] = {
    "topic": [
        VarSpec("topic", "Тема ролика", "text", "projects.topic", lambda c: c.project.topic),
    ],
    "plan": [
        VarSpec(
            "general_plan",
            "Режиссёрский сценарий",
            "longtext",
            "projects.general_plan",
            lambda c: c.project.general_plan,
        ),
        VarSpec(
            "general_plan_meta",
            "Сценарий в meta.general_plan",
            "longtext",
            "projects.meta.general_plan",
            lambda c: c.meta.get("general_plan"),
        ),
        VarSpec("general_plan_file", "Файл general_plan.txt", "list", "disk:general_plan.txt", _get_general_plan_file),
        VarSpec(
            "xlsx_snapshot",
            "Снимок Excel после ноды",
            "list",
            "meta.xlsx_snapshots_by_node[node]",
            _get_xlsx_snapshot,
        ),
    ],
    "script": [
        VarSpec(
            "script_text",
            "Закадровый текст",
            "longtext",
            "projects.script_text",
            lambda c: c.project.script_text,
        ),
        VarSpec("voiceover_file", "Файл озвучки", "list", "disk:voiceover.txt", _get_voiceover_file),
    ],
    "split": [
        VarSpec(
            "frames",
            "Кадры раскадровки и тайминги",
            "frames",
            "frames.start_ts/end_ts/duration_seconds",
            lambda c: _frame_rows(c.frames, _frame_timing),
        ),
        VarSpec(
            "plan_xlsx",
            "Таблица проекта (лист «план»)",
            "list",
            "disk:project.xlsx",
            _get_plan_xlsx,
        ),
    ],
    "scene_design": _SCENE_SPECS,
    "sd_agent": _SCENE_SPECS,
    "sd_assemble": _SCENE_SPECS,
    "excel_gpt": [
        VarSpec("reply", "Ответ GPT", "text", "meta.gpt_operator_results[node].replyPreview", _get_reply),
        VarSpec("gate", "Вердикт проверки", "text", "meta.gpt_operator_results[node].gateStatus", _get_gate),
        VarSpec(
            "output_files",
            "Выходные файлы",
            "list",
            "meta.gpt_operator_results[node].outputPaths",
            _get_output_files,
        ),
        VarSpec(
            "xlsx_snapshot",
            "Снимок Excel после ноды",
            "list",
            "meta.xlsx_snapshots_by_node[node]",
            _get_xlsx_snapshot,
        ),
    ],
    "hero": [
        VarSpec(
            "hero_descriptions",
            "Описания персонажей",
            "list",
            "projects.hero_descriptions",
            lambda c: _get_descriptions(c.project.hero_descriptions),
        ),
        VarSpec("hero_count", "Сколько персонажей", "number", "projects.hero_count", _get_hero_count),
        VarSpec(
            "hero_refs",
            "Референсы персонажей",
            "image",
            "artifacts(hero_reference), disk:characters",
            lambda c: _media(c, artifacts=(ArtifactKind.hero_reference,), dirs=("characters",)),
        ),
    ],
    "items": [
        VarSpec(
            "item_descriptions",
            "Описания предметов",
            "list",
            "projects.item_descriptions",
            lambda c: _get_descriptions(c.project.item_descriptions),
        ),
        VarSpec(
            "item_refs",
            "Референсы предметов",
            "image",
            "artifacts(item_reference), disk:items",
            lambda c: _media(c, artifacts=(ArtifactKind.item_reference,), dirs=("items",)),
        ),
    ],
    "backgrounds": [
        VarSpec("background_style", "Стиль фонов", "json", "projects.meta.background_style", _get_background_style),
        VarSpec(
            "background_refs",
            "Фоны локаций",
            "image",
            "artifacts(background_reference), disk:backgrounds",
            lambda c: _media(c, artifacts=(ArtifactKind.background_reference,), dirs=("backgrounds",)),
        ),
    ],
    "image_prompts": [
        VarSpec(
            "image_prompts",
            "Промты картинок по кадрам",
            "frames",
            "frames.image_prompt",
            lambda c: _frame_rows(c.frames, lambda fr: _text_of(fr.image_prompt)),
        ),
        VarSpec(
            "prompt_versions",
            "Версий промтов (картинки)",
            "number",
            "prompt_versions(kind=img)",
            lambda c: c.prompt_versions.get("img", 0),
        ),
    ],
    "images": [
        VarSpec(
            "scene_images",
            "Картинки кадров",
            "image",
            "artifacts(scene_image), disk:scenes",
            _scene_images,
        ),
    ],
    "animation_prompts": [
        VarSpec(
            "animation_prompts",
            "Промты анимации по кадрам",
            "frames",
            "frames.animation_prompt",
            lambda c: _frame_rows(c.frames, lambda fr: _text_of(fr.animation_prompt)),
        ),
        VarSpec(
            "prompt_versions",
            "Версий промтов (видео)",
            "number",
            "prompt_versions(kind=video)",
            lambda c: c.prompt_versions.get("video", 0),
        ),
    ],
    "videos": [
        VarSpec(
            "scene_videos",
            "Видео клипов",
            "video",
            "artifacts(scene_video), disk:videos",
            lambda c: _media(c, artifacts=(ArtifactKind.scene_video,), dirs=("videos",), suffixes=_VIDEO_SUFFIXES),
        ),
        VarSpec("stale_videos", "Устаревшие видео", "list", "projects.meta.montage_board.stale_videos", _get_stale_videos),
    ],
    "audio": [
        VarSpec(
            "voiceover",
            "Озвучка",
            "audio",
            "artifacts(audio), disk:audio",
            lambda c: _media(c, artifacts=(ArtifactKind.audio,), dirs=("audio",), suffixes=_AUDIO_SUFFIXES),
        ),
        VarSpec("subtitles", "Субтитры", "list", "artifacts(subtitle), disk:subs", _get_subtitles),
        VarSpec("asr_words", "Слов в ASR-разборе", "number", "asr_words", lambda c: c.asr_words),
        VarSpec(
            "timings",
            "Тайминги кадров",
            "frames",
            "frames.start_ts/end_ts/duration_seconds",
            lambda c: _frame_rows(c.frames, _frame_timing),
        ),
    ],
    "music": [
        VarSpec(
            "music",
            "Музыка",
            "audio",
            "artifacts(music), disk:music",
            lambda c: _media(c, artifacts=(ArtifactKind.music,), dirs=("music",), suffixes=_AUDIO_SUFFIXES),
        ),
        VarSpec("bgm_path", "Выбранный трек (meta.bgm_path)", "text", "projects.meta.bgm_path", _get_bgm_path),
    ],
    "sfx_plan": [
        VarSpec("sfx_plan", "План звуков", "json", "projects.meta.sfx_plan", _get_sfx_plan),
        VarSpec("sfx_plan_file", "Файл sfx_plan.json", "list", "disk:sfx_plan.json", _get_sfx_plan_file),
    ],
    "sfx_gen": [
        VarSpec(
            "sfx_files",
            "Звуки сопровождения",
            "audio",
            "disk:sfx",
            lambda c: _media(c, dirs=("sfx",), suffixes=_AUDIO_SUFFIXES),
        ),
    ],
    "assemble": [
        VarSpec(
            "final_video",
            "Финальный ролик",
            "video",
            "artifacts(final_video), disk:final",
            lambda c: _media(
                c,
                artifacts=(ArtifactKind.final_video,),
                dirs=("final",),
                suffixes=_VIDEO_SUFFIXES | _AUDIO_SUFFIXES,
            ),
        ),
        VarSpec("final_files", "Файлы сборки", "list", "disk:final", _get_final_files),
        VarSpec("status", "Статус проекта", "text", "projects.status", lambda c: c.project.status.value),
    ],
    "publish": [
        VarSpec("status", "Статус публикации", "text", "projects.status", lambda c: c.project.status.value),
    ],
}


# ── Сборка ответа ────────────────────────────────────────────────────────


def _var_payload(spec: VarSpec, raw: Any) -> dict[str, Any]:
    """Сырое значение → поля ответа ``value`` / ``preview`` / ``count``."""
    kind = spec.kind
    if kind == "number":
        number = raw if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0
        return {"value": number, "preview": str(number), "count": 1}
    if kind == "bool":
        flag = bool(raw)
        return {"value": flag, "preview": "да" if flag else "нет", "count": 1}
    if kind == "json":
        try:
            dumped = json.dumps(raw, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            dumped = str(raw)
        size = len(raw) if isinstance(raw, (dict, list)) else 0
        return {"value": raw, "preview": dumped[:PREVIEW_CHARS], "count": size}
    if kind in ("text", "longtext"):
        text = _text_of(raw)
        payload: dict[str, Any] = {
            "value": text or None,
            "preview": text[:PREVIEW_CHARS],
            "count": len(text),
        }
        if kind == "longtext" and len(text) > LONG_TEXT_LIMIT:
            payload["value"] = None
            payload["truncated"] = True
        return payload
    items = list(raw) if isinstance(raw, list) else []
    if kind == "frames":
        rows = [item for item in items if isinstance(item, dict)]
        filled = sum(1 for item in rows if _text_of(item.get("value")))
        preview = f"{len(rows)} кадров, заполнено {filled}" if rows else "кадров нет"
        return {"value": rows, "preview": preview, "count": len(rows)}
    if kind in ("image", "video", "audio"):
        entries = [item for item in items if isinstance(item, dict) and item.get("url")]
        return {"value": entries, "preview": f"{len(entries)} файл(ов)", "count": len(entries)}
    labels = [
        _text_of(item.get("label")) if isinstance(item, dict) else _text_of(item) for item in items
    ]
    labels = [label for label in labels if label]
    preview = ", ".join(labels[:6])
    if len(labels) > 6:
        preview += f" … ещё {len(labels) - 6}"
    return {"value": items, "preview": preview, "count": len(items)}


def _collect_vars(ctx: VarCtx, specs: list[VarSpec]) -> list[dict[str, Any]]:
    """Собрать переменные ноды; поломка одного геттера не рушит ответ."""
    out: list[dict[str, Any]] = []
    for spec in specs:
        try:
            payload = _var_payload(spec, spec.get(ctx))
        except Exception as exc:  # noqa: BLE001 — переменная-подсказка, не данные
            logger.warning(
                "[#{}] переменная {} ноды {} не собралась: {}: {}",
                ctx.project.id,
                spec.key,
                ctx.node_key,
                type(exc).__name__,
                str(exc)[:200],
            )
            payload = {
                "value": None,
                "preview": "",
                "count": 0,
                "error": f"{type(exc).__name__}: {str(exc)[:200]}",
            }
        out.append(
            {
                "key": spec.key,
                "label": spec.label,
                "kind": spec.kind,
                "source": spec.source,
                **payload,
            }
        )
    return out


def _node_state(raw: Any, disabled: bool) -> str:
    if disabled:
        return "disabled"
    return _STATE_MAP.get(_text_of(raw).lower(), "pending")


def _node_specs(node: dict[str, Any]) -> list[VarSpec] | None:
    """Переменные ноды по её типу; ``None`` — ноду в панель не берём."""
    from app.services.excel_gpt_node import is_excel_gpt_node_type

    typ = _text_of(node.get("type"))
    specs = NODE_VARIABLE_SPECS.get(typ)
    if specs is not None:
        return specs
    if is_excel_gpt_node_type(typ):
        return NODE_VARIABLE_SPECS["excel_gpt"]
    return None


def _excel_slot_name(node: dict[str, Any]) -> str:
    """Имя слота excel_gpt: из ключа ноды (``…_pk_cast`` → ``cast``) или номер."""
    from app.services.excel_gpt_node import slot_index_from_node

    match = _PK_SLOT_RE.search(_text_of(node.get("id")))
    if match:
        return match.group(1)
    slot = slot_index_from_node(node)
    return f"слот {slot}" if slot else ""


def _panel_node_label(node: dict[str, Any]) -> str:
    """Подпись ноды для панели; у excel_gpt-слотов добавляем слот.

    Без этого в списке два «Персонажи» (нода ``hero`` и слот ``cast``) и два
    «Фоны» (нода ``backgrounds`` и слот ``backgrounds``) — человек не может
    выбрать нужную. Остальным нодам подпись не трогаем.
    """
    from app.services.excel_gpt_node import is_excel_gpt_node_type
    from app.services.project_graph import node_label

    label = node_label(node)
    if is_excel_gpt_node_type(_text_of(node.get("type"))):
        slot = _excel_slot_name(node)
        if slot:
            return f"{label} · слот {slot}"
    return label


def _montage_rows(node: dict[str, Any]) -> list[str]:
    """Строки доски, которые питает нода. Пусто — у шага нет строки на доске."""
    from app.services.excel_gpt_node import is_excel_gpt_node_type

    typ = _text_of(node.get("type"))
    if is_excel_gpt_node_type(typ):
        # Только слот «Сцены по плану» раскладывает план на кадры: из него
        # берутся attrs кадров (действие). Остальные слоты дают только xlsx.
        return ["action"] if _excel_slot_name(node) == "scenes" else []
    return list(_MONTAGE_ROWS_BY_TYPE.get(typ, ()))


async def _prompt_version_counts(session: AsyncSession, project_id: int) -> dict[str, int]:
    rows = (
        await session.execute(
            select(PromptVersion.kind, func.count())
            .where(PromptVersion.project_id == project_id)
            .group_by(PromptVersion.kind)
        )
    ).all()
    return {str(kind): int(total) for kind, total in rows}


async def _asr_word_count(session: AsyncSession, project_id: int) -> int:
    total = (
        await session.execute(
            select(func.count()).select_from(AsrWord).where(AsrWord.project_id == project_id)
        )
    ).scalar()
    return int(total or 0)


def _totals(
    frames: list[Frame],
    artifacts: list[Artifact],
    data_dir: Path,
) -> dict[str, int]:
    """Сводка по проекту: кадры и сколько актуальных медиа каждого вида."""

    def artifacts_of(kind: ArtifactKind) -> int:
        return sum(1 for art in artifacts if art.kind == kind)

    def disk_of(name: str, suffixes: frozenset[str]) -> int:
        return len(_disk_files(data_dir / name, suffixes))

    return {
        "frames": len(frames),
        "images": artifacts_of(ArtifactKind.scene_image) or disk_of("scenes", _IMAGE_SUFFIXES),
        "videos": artifacts_of(ArtifactKind.scene_video) or disk_of("videos", _VIDEO_SUFFIXES),
        "heroes": artifacts_of(ArtifactKind.hero_reference) or disk_of("characters", _IMAGE_SUFFIXES),
        "backgrounds": artifacts_of(ArtifactKind.background_reference)
        or disk_of("backgrounds", _IMAGE_SUFFIXES),
    }


async def build_montage_variables(session: AsyncSession, project: Project) -> dict[str, Any]:
    """Переменные проекта, сгруппированные по нодам его графа.

    Ноды и их состояние — из графа проекта (``project_graph``), значения —
    из ``projects`` / ``projects.meta`` / ``frames`` / ``artifacts`` / файлов.
    Панель показывает ровно то, что есть в этом ролике: у проекта, где сцены
    делает группа ``script_frames_qc`` на ``excel_gpt``-слотах, нод
    ``split``/``scene_design`` просто не будет.
    """
    from app.services.project_graph import (
        load_project_graph,
        node_disabled,
        node_states,
        node_step_code,
    )

    meta = dict(project.meta) if isinstance(project.meta, dict) else {}
    from app.services.db_v2 import frame_is_archived

    # Архив прежнего разбиения по плану в переменные не пускаем: иначе
    # «кадров N» и таблицы по кадрам считают 54 при живых 22.
    frames = [
        fr
        for fr in (
            (
                await session.execute(
                    select(Frame).where(Frame.project_id == project.id).order_by(Frame.number)
                )
            )
            .scalars()
            .all()
        )
        if not frame_is_archived(fr)
    ]
    artifacts = list(
        (await session.execute(select(Artifact).where(Artifact.project_id == project.id)))
        .scalars()
        .all()
    )
    graph = await load_project_graph(session, project)
    states = node_states(project, graph)
    data_dir = Path(project.data_dir)
    prompt_versions = await _prompt_version_counts(session, project.id)
    asr_words = await _asr_word_count(session, project.id)

    nodes: list[dict[str, Any]] = []
    for node in graph.nodes:
        node_key = _text_of(node.get("id"))
        if not node_key:
            continue
        specs = _node_specs(node)
        if specs is None:
            continue
        ctx = VarCtx(
            project=project,
            meta=meta,
            frames=frames,
            artifacts=artifacts,
            data_dir=data_dir,
            node_key=node_key,
            node=node,
            prompt_versions=prompt_versions,
            asr_words=asr_words,
        )
        nodes.append(
            {
                "node_key": node_key,
                "node_type": _text_of(node.get("type")),
                "label": _panel_node_label(node),
                "step_code": node_step_code(node),
                "montage_rows": _montage_rows(node),
                "state": _node_state(states.get(node_key), node_disabled(node)),
                "vars": _collect_vars(ctx, specs),
            }
        )

    return {
        "project_id": project.id,
        "slug": project.slug,
        "status": project.status.value,
        "generated_at": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "frames_total": len(frames),
        "nodes": nodes,
        "totals": _totals(frames, artifacts, data_dir),
    }
