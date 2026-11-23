"""Хранилище проверки картинок в ``project.meta["montage_board"]``.

Ключи (см. ``docs/MONTAGE-IMAGE-CHECK.md`` §3):

- ``image_check_settings`` — настройки механики (режим, агент, лимиты);
- ``image_check_job``      — фон-прогресс прогона (его читает UI);
- ``image_check``          — вердикты по кадрам, история версий, итог последнего прогона.

Настройки/вердикты живут в meta доски намеренно: доска — уже существующий
контракт между фронтом, apply-job и монтажом, а отдельная таблица потребовала бы
миграции и RLS-политик ради одного экрана.

Модуль синхронный (meta — JSON на `Project`), сессию/коммит держат вызывающие.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.services.montage_board_meta import montage_meta, set_montage_meta

IMAGE_CHECK_SETTINGS_KEY = "image_check_settings"
IMAGE_CHECK_JOB_KEY = "image_check_job"
IMAGE_CHECK_KEY = "image_check"

#: Папка с вариантами агента проверки (файлы ``<id>.md``).
AGENTS_DIRNAME = "check_montage"
PROMPTS_ROOT = Path(__file__).resolve().parent.parent.parent / "prompts"

#: Лимит истории версий: старые записи чистим, иначе meta пухнет и тормозит доску.
HISTORY_LIMIT = 200
FRAME_HISTORY_LIMIT = 12

LIKE_MODES = ("notify", "auto")
KINDS = ("images", "video")
MAX_LIMIT = 5

DEFAULT_SETTINGS: dict[str, Any] = {
    "kind": "images",
    "mode": "notify",
    "agent": "default",
    "task": "",
    "max_rechecks": 1,
    "max_regens": 1,
    "frames_per_sheet": 4,
    # Не используется: лист склеивается в родном размере кадров (1080×1920 → 2168×3848),
    # без растяжки до 4К. Поле оставлено, чтобы не ломать DTO настроек.
    "sheet_long_side": 3840,
}


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------- агенты (промты)


def _split_prompt_text(text: str) -> tuple[str, str, str]:
    """Промт-файл → (title, summary, body). Первая ``# …`` — заголовок, ``> …`` — краткое."""
    title = ""
    summary: list[str] = []
    body: list[str] = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not title and stripped.startswith("# "):
            title = stripped[2:].strip()
            continue
        if stripped.startswith(">"):
            summary.append(stripped.lstrip("> ").strip())
            continue
        body.append(line)
    return title, " ".join(s for s in summary if s), "\n".join(body).strip()


def _agent_file(agent_id: str) -> Path:
    name = (agent_id or "").strip()
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ValueError(f"недопустимое имя агента проверки: {agent_id!r}")
    return PROMPTS_ROOT / AGENTS_DIRNAME / f"{name}.md"


def list_agents() -> list[dict[str, str]]:
    """Варианты агента проверки из ``prompts/check_montage/*.md``."""
    directory = PROMPTS_ROOT / AGENTS_DIRNAME
    agents: list[dict[str, str]] = []
    if not directory.is_dir():
        return agents
    for path in sorted(directory.glob("*.md")):
        try:
            title, summary, body = _split_prompt_text(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if not body:
            continue
        agents.append({"id": path.stem, "title": title or path.stem, "summary": summary})
    return agents


def load_agent_prompt(agent_id: str) -> str:
    """Тело промта варианта. Нет файла/пустое тело → ValueError (не тихий pass)."""
    path = _agent_file(agent_id)
    if not path.is_file():
        raise ValueError(
            f"промт агента проверки «{agent_id}» не найден ({path}) — "
            f"положите файл в prompts/{AGENTS_DIRNAME}/"
        )
    body = _split_prompt_text(path.read_text(encoding="utf-8", errors="replace"))[2]
    if not body:
        raise ValueError(f"промт агента проверки «{agent_id}» пустой ({path})")
    return body


# ------------------------------------------------------------------- настройки


def _clamp_limit(value: Any, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, min(MAX_LIMIT, number))


def read_settings(project) -> dict[str, Any]:
    """Сохранить+прогнать валидацию не удалось → отдать безопасный дефолт по полю."""
    board = montage_meta(project)
    raw = board.get(IMAGE_CHECK_SETTINGS_KEY)
    stored = raw if isinstance(raw, dict) else {}
    out = dict(DEFAULT_SETTINGS)
    out.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})

    kind = str(out.get("kind") or "images").strip().lower()
    out["kind"] = kind if kind in KINDS else "images"
    mode = str(out.get("mode") or "notify").strip().lower()
    out["mode"] = mode if mode in LIKE_MODES else "notify"
    out["agent"] = str(out.get("agent") or "default").strip() or "default"
    out["task"] = str(out.get("task") or "").strip()[:2000]
    out["max_rechecks"] = _clamp_limit(out.get("max_rechecks"), DEFAULT_SETTINGS["max_rechecks"])
    out["max_regens"] = _clamp_limit(out.get("max_regens"), DEFAULT_SETTINGS["max_regens"])
    out["frames_per_sheet"] = DEFAULT_SETTINGS["frames_per_sheet"]
    out["sheet_long_side"] = DEFAULT_SETTINGS["sheet_long_side"]
    return out


def write_settings(project, patch: dict[str, Any], *, allow_video: bool = False) -> dict[str, Any]:
    """Частичный патч настроек. ValueError → 400 на эндпоинте."""
    if not isinstance(patch, dict):
        raise ValueError("настройки должны быть объектом")
    unknown = sorted(set(patch) - set(DEFAULT_SETTINGS))
    if unknown:
        raise ValueError(f"неизвестные поля настроек: {', '.join(unknown)}")

    current = read_settings(project)
    merged = {**current, **{k: v for k, v in patch.items() if v is not None}}

    kind = str(merged.get("kind") or "").strip().lower()
    if kind not in KINDS:
        raise ValueError(f"неизвестная механика проверки: {kind!r}; доступны: images, video")
    if kind == "video" and not allow_video:
        raise ValueError("проверка видео ещё не включена")
    mode = str(merged.get("mode") or "").strip().lower()
    if mode not in LIKE_MODES:
        raise ValueError(f"неизвестный режим проверки: {mode!r}; доступны: notify, auto")
    agent = str(merged.get("agent") or "").strip()
    known = {a["id"] for a in list_agents()}
    if known and agent not in known:
        raise ValueError(f"агент проверки «{agent}» не найден; доступны: {', '.join(sorted(known))}")

    clean = {
        "kind": kind,
        "mode": mode,
        "agent": agent or "default",
        "task": str(merged.get("task") or "").strip()[:2000],
        "max_rechecks": _clamp_limit(merged.get("max_rechecks"), current["max_rechecks"]),
        "max_regens": _clamp_limit(merged.get("max_regens"), current["max_regens"]),
        "frames_per_sheet": DEFAULT_SETTINGS["frames_per_sheet"],
        "sheet_long_side": DEFAULT_SETTINGS["sheet_long_side"],
    }
    board = montage_meta(project)
    board[IMAGE_CHECK_SETTINGS_KEY] = clean
    set_montage_meta(project, board)
    return clean


# ------------------------------------------------------------------ фон-статус


def read_job(project) -> dict[str, Any]:
    board = montage_meta(project)
    raw = board.get(IMAGE_CHECK_JOB_KEY)
    job = dict(raw) if isinstance(raw, dict) else {}
    job.setdefault("status", "idle")
    return job


def write_job(project, patch: dict[str, Any]) -> dict[str, Any]:
    board = montage_meta(project)
    job = dict(board.get(IMAGE_CHECK_JOB_KEY) or {})
    job.update(patch)
    board[IMAGE_CHECK_JOB_KEY] = job
    set_montage_meta(project, board)
    return job


# ------------------------------------------------------ вердикты и история


def _check_section(project) -> dict[str, Any]:
    board = montage_meta(project)
    section = board.get(IMAGE_CHECK_KEY)
    return dict(section) if isinstance(section, dict) else {}


def _write_section(project, section: dict[str, Any]) -> None:
    board = montage_meta(project)
    board[IMAGE_CHECK_KEY] = section
    set_montage_meta(project, board)


def read_results(project) -> dict[str, dict[str, Any]]:
    frames = _check_section(project).get("frames")
    return dict(frames) if isinstance(frames, dict) else {}


def write_results(project, results: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Слить вердикты по кадрам (ключ — номер кадра строкой)."""
    section = _check_section(project)
    frames = dict(section.get("frames") or {})
    for key, value in results.items():
        if isinstance(value, dict):
            frames[str(key)] = value
    section["frames"] = frames
    _write_section(project, section)
    return frames


def clear_results(project, frame_numbers: list[int] | None = None) -> None:
    """Сбросить вердикты: все или по списку кадров (перед прогоном подмножества не нужен)."""
    if frame_numbers is None:
        section = _check_section(project)
        section["frames"] = {}
        _write_section(project, section)
        return
    section = _check_section(project)
    frames = dict(section.get("frames") or {})
    for number in frame_numbers:
        frames.pop(str(number), None)
    section["frames"] = frames
    _write_section(project, section)


def read_history(project) -> list[dict[str, Any]]:
    items = _check_section(project).get("history")
    return [dict(x) for x in items] if isinstance(items, list) else []


def append_history(project, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Дописать версии картинок: свежие сверху, активная — одна на кадр."""
    if not entries:
        return read_history(project)
    section = _check_section(project)
    history = [dict(x) for x in (section.get("history") or []) if isinstance(x, dict)]

    for entry in entries:
        try:
            number = int(entry.get("frame_number") or 0)
        except (TypeError, ValueError):
            continue
        if number <= 0:
            continue
        name = str(entry.get("file") or "")
        item = {
            "frame_number": number,
            "shot": int(entry.get("shot") or 1),
            "file": name,
            "path": str(entry.get("path") or ""),
            "created_at": str(entry.get("created_at") or utc_now()),
            "source": str(entry.get("source") or "regen"),
            "verdict": str(entry.get("verdict") or "unknown"),
            "problems": [str(p) for p in (entry.get("problems") or [])][:20],
            "active": bool(entry.get("active", True)),
        }
        # Дедуп: та же версия картинки не должна жить в истории дважды.
        history = [h for h in history if not (int(h.get("frame_number") or 0) == number and h.get("file") == name)]
        if item["active"]:
            for h in history:
                if int(h.get("frame_number") or 0) == number:
                    h["active"] = False
        history.insert(0, item)

    # Лимиты: не больше N версий на кадр и общего потолка.
    per_frame: dict[int, int] = {}
    trimmed: list[dict[str, Any]] = []
    for item in history:
        number = int(str(item.get("frame_number") or 0))
        seen = per_frame.get(number, 0)
        if seen >= FRAME_HISTORY_LIMIT:
            continue
        per_frame[number] = seen + 1
        trimmed.append(item)
    section["history"] = trimmed[:HISTORY_LIMIT]
    _write_section(project, section)
    return [dict(x) for x in section["history"]]


def read_last_run(project) -> dict[str, Any] | None:
    last = _check_section(project).get("last_run")
    return dict(last) if isinstance(last, dict) else None


def write_last_run(project, run: dict[str, Any]) -> None:
    section = _check_section(project)
    section["last_run"] = dict(run)
    _write_section(project, section)


def summary_of(results: dict[str, dict[str, Any]]) -> dict[str, int]:
    total = pass_ = fail = skip = 0
    for value in results.values():
        if not isinstance(value, dict):
            continue
        total += 1
        verdict = str(value.get("verdict") or "skip")
        if verdict == "pass":
            pass_ += 1
        elif verdict == "fail":
            fail += 1
        else:
            skip += 1
    return {"total": total, "pass": pass_, "fail": fail, "skip": skip}
