"""REST API «Голосовая лаборатория»: реестр клонированных голосов ElevenLabs.

## Зачем

Мгновенные клоны (IVC) нужны, чтобы озвучивать ролик своим голосом. Это первая
поверхность студии, которая держит собственный аудио-архив: сэмплы человека и
метаданные клона.

## Хранение — файлы, без БД (осознанное решение первой версии)

    data/voices/clones/index.json          — реестр записей
    data/voices/clones/<uuid>/meta.json    — копия записи каталога
    data/voices/clones/<uuid>/sample-1.mp3 — сэмплы, как их загрузили

Таблиц и миграций нет: реестр читается и пишется целиком одним JSON. Если
``index.json`` потеряется или побьётся, реестр восстановится из ``meta.json``
каталогов — данные пользователя лежат и там. Записи ровно столько, сколько
нужно для лимита, списка и статуса; сами файлы — в каталоге клона.

## Пути

Корень — ``settings.data_dir`` (через ``app.paths`` его нет, но правило то же,
что в остальных роутерах): путь считается НА КАЖДЫЙ ВЫЗОВ, потому что
``settings.data_dir`` подменяется в тестах. Константа, посчитанная на импорте,
подмену не увидит и один раз допишет в боевой ``data/`` — это уже было с
``services/local_library.py``.

## Ключ и провайдер

Без ``ELEVENLABS_API_KEY`` клон всё равно заводится: сэмплы сохраняются,
запись получает ``status="pending_provider"`` и текст причины в
``provider_error``. Ответ — тот же 201, а не ошибка: оператор загрузил голос,
ключ появится позже. Ошибка самого провайдера (401/402/403/422/429) идёт в тот
же ``provider_error`` — превращать её в 500 нельзя, сэмплы уже сохранены.

## Доступ

Роутер монтируется под ``/api/voice-lab``. Участника отсекает middleware
личности: префикса нет в ``identity.TENANT_ALLOWED_PREFIXES``. Здесь про роли
ничего нет — ни одной проверки прав.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from loguru import logger
from pydantic import BaseModel

from app.bots.elevenlabs_clone import (
    ElevenLabsCloneError,
    ElevenLabsNotConfigured,
    create_voice,
    elevenlabs_clone_configured,
    synthesize_preview,
)
from app.services.ai_result_io import ffprobe_duration
from app.settings import settings

router = APIRouter(prefix="/voice-lab", tags=["voice-lab"])

# Лимит созданий в сутки: клон — платная операция у провайдера, а случайные
# двойные нажатия в мастере клонирования дают «мусорные» голоса в аккаунте.
DAILY_LIMIT = 10
# Суммарный размер сэмплов на одно создание (совпадает с фронтом).
MAX_TOTAL_BYTES = 25 * 1024 * 1024
# Что принимаем: остальное провайдер всё равно не разберёт.
ALLOWED_EXTENSIONS = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "m4a": "audio/mp4",
    "ogg": "audio/ogg",
    "flac": "audio/flac",
}
# Максимум текста на предпросмотр: это фраза «послушать голос», а не закадр.
PREVIEW_MAX_CHARS = 500

_READ_CHUNK = 1024 * 1024
_CLONE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# Реестр — один JSON, читаем-правим-пишем. Без замка два одновременных
# создания перетирали бы друг друга (потерянная запись на диск бы ушла).
_REGISTRY_LOCK = asyncio.Lock()


# ── Пути и реестр ─────────────────────────────────────────────────────────


def clones_root() -> Path:
    """Каталог реестра клонов (считается на каждый вызов, см. docstring модуля)."""
    return Path(settings.data_dir) / "voices" / "clones"


def _index_path() -> Path:
    return clones_root() / "index.json"


def _clone_dir(clone_id: str) -> Path:
    return clones_root() / clone_id


def _now_local_iso() -> str:
    """Время создания в местной зоне со смещением — как в `services/create_jobs`."""
    return datetime.now(UTC).astimezone().isoformat(timespec="seconds")


def _today_prefix() -> str:
    return datetime.now(UTC).astimezone().date().isoformat()


def _created_today(record: dict[str, Any]) -> bool:
    return str(record.get("created_at") or "")[:10] == _today_prefix()


def _read_index() -> list[dict[str, Any]] | None:
    """Реестр с диска. ``None`` — индекса нет или он битый (повод восстановить)."""
    path = _index_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.warning("voice-lab: index.json не прочитан ({}), беру meta.json", e)
        return None
    items = raw.get("voices") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return None
    return [r for r in items if isinstance(r, dict) and str(r.get("id") or "").strip()]


def _records_from_dirs() -> list[dict[str, Any]]:
    """Восстановление реестра из каталогов: индекс — не единственное хранилище."""
    root = clones_root()
    if not root.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for entry in sorted(root.iterdir()):
        meta = entry / "meta.json"
        if not entry.is_dir() or not meta.is_file():
            continue
        try:
            record = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("voice-lab: meta.json не прочитан: {}", meta)
            continue
        if isinstance(record, dict) and record.get("id"):
            records.append(record)
    return records


def _load_records() -> list[dict[str, Any]]:
    """Реестр записей: индекс, а если его нет/он битый — из ``meta.json``.

    Восстанавливаемся только при ОТСУТСТВИИ индекса, а не при пустом списке:
    иначе клон, удалённый из реестра, «воскресал» бы из каталога, который не
    успели убрать с диска.
    """
    records = _read_index()
    return _records_from_dirs() if records is None else records


def _save_records(records: list[dict[str, Any]]) -> None:
    """Записать реестр атомарно: половина списка на диске не останется."""
    root = clones_root()
    root.mkdir(parents=True, exist_ok=True)
    path = _index_path()
    tmp = path.with_name(f"{path.name}.tmp")
    payload = {"version": 1, "voices": records}
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _save_meta(clone_id: str, record: dict[str, Any]) -> None:
    clone_dir = _clone_dir(clone_id)
    clone_dir.mkdir(parents=True, exist_ok=True)
    (clone_dir / "meta.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _ensure_id(clone_id: str) -> None:
    """Чужой/поддельный id — 404, и никакого выхода из каталога клонов.

    Проверка формата нужна не для красоты: id приходит из URL, а ``..``
    в качестве сегмента пути увёл бы поиск файлов в родительский каталог.
    """
    if not _CLONE_ID_RE.match(clone_id or ""):
        raise HTTPException(status_code=404, detail=f"Клон «{clone_id}» не найден")


def _find(records: list[dict[str, Any]], clone_id: str) -> dict[str, Any] | None:
    for record in records:
        if str(record.get("id") or "") == clone_id:
            return record
    return None


def _samples_of(record: dict[str, Any]) -> list[dict[str, Any]]:
    samples = record.get("samples")
    if not isinstance(samples, list):
        return []
    return [s for s in samples if isinstance(s, dict) and s.get("file")]


def _public(record: dict[str, Any]) -> dict[str, Any]:
    """Запись наружу в том виде, которого ждёт фронт (`lib/voice-lab-api.ts`)."""
    clone_id = str(record.get("id") or "")
    samples = _samples_of(record)
    return {
        "id": clone_id,
        "name": record.get("name") or "",
        "description": record.get("description") or "",
        "language": record.get("language") or "ru",
        "status": record.get("status") or "pending_provider",
        "source": record.get("source") or "clone",
        "sample_url": f"/api/voice-lab/clones/{clone_id}/sample?index=0" if samples else None,
        "external_voice_id": record.get("external_voice_id") or None,
        "created_at": record.get("created_at"),
        "samples_count": len(samples),
        "duration_sec": round(float(record.get("duration_sec") or 0.0), 2),
        # Не в строгом контракте, но без него после перезагрузки страницы
        # непонятно, почему клон «ждёт ключа».
        "provider_error": record.get("provider_error") or None,
    }


# ── Сэмплы ────────────────────────────────────────────────────────────────


def _sample_ext(filename: str | None) -> str:
    return Path(filename or "").suffix.lower().lstrip(".")


def _probe_duration(path: Path) -> float | None:
    """Длительность сэмпла; None — ffprobe нет или файл не аудио. Не критично."""
    try:
        value = ffprobe_duration(path)
    except Exception:  # noqa: BLE001 — длительность нужна только для показа
        return None
    return round(value, 2) if value else None


async def _save_samples(
    clone_dir: Path,
    uploads: list[UploadFile],
) -> tuple[list[dict[str, Any]], str | None]:
    """Сохранить сэмплы в каталог клона. Возвращает (список файлов, ошибка)."""
    clone_dir.mkdir(parents=True, exist_ok=True)
    saved: list[dict[str, Any]] = []
    total = 0
    limit_mb = MAX_TOTAL_BYTES // (1024 * 1024)
    for i, upload in enumerate(uploads, start=1):
        ext = _sample_ext(upload.filename)
        dest = clone_dir / f"sample-{i}.{ext}"
        size = 0
        try:
            with dest.open("wb") as fh:
                while chunk := await upload.read(_READ_CHUNK):
                    total += len(chunk)
                    if total > MAX_TOTAL_BYTES:
                        return saved, f"Сэмплы весят больше {limit_mb} МБ — загрузите короче"
                    size += len(chunk)
                    fh.write(chunk)
        finally:
            await upload.close()
        if size == 0:
            return saved, f"Файл «{upload.filename}» пустой"
        saved.append({"file": dest.name, "bytes": size, "duration_sec": _probe_duration(dest)})
    return saved, None


# ── Ручки ─────────────────────────────────────────────────────────────────


@router.get("/voices")
async def list_voices() -> dict[str, Any]:
    """Реестр клонов + состояние ключа и суточного лимита."""
    records = _load_records()
    records.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
    return {
        "configured": elevenlabs_clone_configured(),
        "daily_used": sum(1 for r in records if _created_today(r)),
        "daily_limit": DAILY_LIMIT,
        "voices": [_public(r) for r in records],
    }


@router.post("/clones", status_code=201)
async def create_clone(  # noqa: B008 — File/Form в сигнатуре: паттерн FastAPI
    name: str = Form(..., description="Имя голоса"),
    description: str = Form("", description="Описание"),
    language: str = Form("ru", description="Язык сэмплов"),
    kind: str = Form("instant", description="Тип клонирования: instant (IVC)"),
    samples: list[UploadFile] = File(default=[], description="Аудио-сэмплы"),
) -> dict[str, Any]:
    """Завести клон: сэмплы → диск, затем (если есть ключ) голос у провайдера."""
    clean_name = (name or "").strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Название голоса обязательно")

    uploads = [f for f in samples if f and f.filename]
    if not uploads:
        raise HTTPException(
            status_code=400,
            detail="Приложите хотя бы один сэмпл: mp3, wav, m4a, ogg или flac",
        )
    allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
    for upload in uploads:
        ext = _sample_ext(upload.filename)
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Формат «{ext or 'без расширения'}» не поддерживается "
                    f"({upload.filename}). Нужен один из: {allowed}"
                ),
            )

    clone_id = str(uuid.uuid4())
    clone_dir = _clone_dir(clone_id)
    record: dict[str, Any] = {
        "id": clone_id,
        "name": clean_name,
        "description": (description or "").strip(),
        "language": (language or "ru").strip() or "ru",
        "kind": (kind or "instant").strip() or "instant",
        "status": "pending_provider",
        "source": "clone",
        "external_voice_id": None,
        "created_at": _now_local_iso(),
        "updated_at": None,
        "samples": [],
        "duration_sec": 0.0,
        "provider_error": None,
    }

    # Бронь под лимитом ДО чтения файлов. Между проверкой и записью идёт
    # `await` (диск, потом ещё и провайдер) — без брони два параллельных
    # нажатия «Создать» оба увидели бы 9 созданий и вместе пробили лимит 10.
    async with _REGISTRY_LOCK:
        records = _load_records()
        used_today = sum(1 for r in records if _created_today(r))
        if used_today >= DAILY_LIMIT:
            raise HTTPException(
                status_code=429,
                detail=f"Лимит {DAILY_LIMIT} клонирований в сутки исчерпан — попробуйте завтра",
            )
        records.insert(0, record)
        _save_records(records)

    saved, save_error = await _save_samples(clone_dir, uploads)
    if save_error:
        # Загрузка не удалась — снимаем бронь: лимит тратится только на
        # реальные создания, а не на отклонённые браком файлы.
        shutil.rmtree(clone_dir, ignore_errors=True)
        async with _REGISTRY_LOCK:
            rest = [r for r in _load_records() if str(r.get("id") or "") != clone_id]
            _save_records(rest)
        raise HTTPException(status_code=400, detail=save_error)

    durations = [float(s.get("duration_sec") or 0.0) for s in saved]
    record["samples"] = saved
    record["duration_sec"] = round(sum(durations), 2)
    # Сэмплы на диске и в реестре: с этого момента ошибка провайдера уже не
    # теряет загрузку пользователя.
    async with _REGISTRY_LOCK:
        records = _load_records()
        stored = _find(records, clone_id)
        if stored is None:
            # Бронь успели снести параллельным DELETE — возвращаем запись,
            # терять уже загруженные файлы нельзя.
            records.insert(0, record)
        else:
            stored.update(
                samples=saved,
                duration_sec=record["duration_sec"],
                created_at=record["created_at"],
            )
            record = stored
        _save_records(records)
        _save_meta(clone_id, record)

    provider_error: str | None = None
    if not elevenlabs_clone_configured():
        provider_error = (
            "Ключ ElevenLabs не задан (ELEVENLABS_API_KEY) — сэмплы сохранены, "
            "клон ждёт ключа"
        )
    else:
        try:
            external_id = await create_voice(
                name=clean_name,
                description=record["description"],
                files=[clone_dir / str(s["file"]) for s in saved],
                language=record["language"],
            )
        except (ElevenLabsNotConfigured, ElevenLabsCloneError) as e:
            provider_error = str(e)
        except Exception as e:  # noqa: BLE001 — провайдер не должен давать 500
            logger.exception("voice-lab: неожиданная ошибка ElevenLabs")
            provider_error = f"Не удалось создать голос у ElevenLabs: {e}"
        else:
            record["status"] = "ready"
            record["external_voice_id"] = external_id

    async with _REGISTRY_LOCK:
        records = _load_records()
        stored = _find(records, clone_id)
        if stored is None:
            # Реестр успели почистить, пока ходили к провайдеру. Запись всё
            # равно вернём — сэмплы на диске, терять загрузку пользователя
            # из-за чужого DELETE нельзя.
            logger.warning("voice-lab: запись {} исчезла из реестра во время создания", clone_id)
            stored = record
            stored["provider_error"] = provider_error
        else:
            stored["status"] = record["status"]
            stored["external_voice_id"] = record["external_voice_id"]
            stored["provider_error"] = provider_error
            stored["updated_at"] = _now_local_iso()
            _save_records(records)
            _save_meta(clone_id, stored)

    logger.info(
        "voice-lab: клон «{}» {} (сэмплов {}, {} с{})",
        clean_name,
        stored.get("status"),
        len(saved),
        record["duration_sec"],
        ", provider_error: " + provider_error if provider_error else "",
    )
    return {"voice": _public(stored), "provider_error": provider_error}


class ClonePatch(BaseModel):
    """Правка клона: имя и/или описание. Остальное не редактируется."""

    name: str | None = None
    description: str | None = None


@router.patch("/clones/{clone_id}")
async def update_clone(clone_id: str, body: ClonePatch) -> dict[str, Any]:
    """Переименовать клон / поправить описание в реестре."""
    _ensure_id(clone_id)
    patch: dict[str, Any] = {}
    if body.name is not None:
        new_name = body.name.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Название голоса не может быть пустым")
        patch["name"] = new_name
    if body.description is not None:
        patch["description"] = body.description.strip()
    if not patch:
        raise HTTPException(status_code=400, detail="Нечего менять: передайте name и/или description")

    async with _REGISTRY_LOCK:
        records = _load_records()
        record = _find(records, clone_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"Клон «{clone_id}» не найден")
        record.update(patch)
        record["updated_at"] = _now_local_iso()
        _save_records(records)
        _save_meta(clone_id, record)
    return {"voice": _public(record)}


@router.delete("/clones/{clone_id}")
async def delete_clone(clone_id: str) -> dict[str, bool]:
    """Удалить клон из студии: запись, метаданные и сэмплы.

    Голос в аккаунте ElevenLabs не трогаем — в первой версии реестр отвечает
    только за то, что завёл сам.
    """
    _ensure_id(clone_id)
    async with _REGISTRY_LOCK:
        records = _load_records()
        rest = [r for r in records if str(r.get("id") or "") != clone_id]
        if len(rest) == len(records):
            raise HTTPException(status_code=404, detail=f"Клон «{clone_id}» не найден")
        _save_records(rest)
    shutil.rmtree(_clone_dir(clone_id), ignore_errors=True)
    logger.info("voice-lab: клон {} удалён", clone_id)
    return {"deleted": True}


@router.get("/clones/{clone_id}/sample")
async def get_clone_sample(
    clone_id: str,
    index: int = Query(0, ge=0, description="Номер сэмпла, с нуля"),
) -> FileResponse:
    """Отдать загруженный сэмпл для прослушивания в браузере."""
    _ensure_id(clone_id)
    record = _find(_load_records(), clone_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Клон «{clone_id}» не найден")
    samples = _samples_of(record)
    if index >= len(samples):
        raise HTTPException(
            status_code=404,
            detail=f"У клона нет сэмпла №{index} (всего {len(samples)})",
        )
    path = _clone_dir(clone_id) / str(samples[index]["file"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл сэмпла пропал с диска")
    media_type = ALLOWED_EXTENSIONS.get(path.suffix.lower().lstrip("."), "application/octet-stream")
    return FileResponse(
        path=path,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600"},
        filename=path.name,
    )


class PreviewBody(BaseModel):
    """Текст, который надо произнести клоном для прослушивания."""

    text: str = ""


@router.post("/clones/{clone_id}/preview")
async def preview_clone(clone_id: str, body: PreviewBody) -> dict[str, str]:
    """Озвучить короткую фразу клонированным голосом.

    Ручка отдачи — ``GET .../preview-audio``: контракт требует вернуть ссылку,
    а не байты, и файл перезаписывается, поэтому в URL кладём метку времени
    (кэш браузера не должен отдавать прошлую озвучку).
    """
    _ensure_id(clone_id)
    record = _find(_load_records(), clone_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"Клон «{clone_id}» не найден")
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Пустой текст для предпросмотра")
    if len(text) > PREVIEW_MAX_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"Для предпросмотра хватит фразы: до {PREVIEW_MAX_CHARS} символов",
        )
    voice_id = str(record.get("external_voice_id") or "").strip()
    if not voice_id:
        raise HTTPException(
            status_code=400,
            detail="Клон ещё не создан у ElevenLabs — предпрослушивание появится после ключа",
        )
    out_path = _clone_dir(clone_id) / "preview.mp3"
    try:
        await synthesize_preview(voice_id, text, out_path)
    except (ElevenLabsNotConfigured, ElevenLabsCloneError) as e:
        # Контракт: провайдерский сбой предпросмотра — это 400 с понятным
        # текстом, а не 500: ключ/тариф/гео-блок лечатся действием человека.
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:  # noqa: BLE001
        logger.exception("voice-lab: предпросмотр упал")
        raise HTTPException(status_code=400, detail=f"Не удалось получить предпросмотр: {e}") from e
    return {"audio_url": f"/api/voice-lab/clones/{clone_id}/preview-audio?v={int(time.time())}"}


@router.get("/clones/{clone_id}/preview-audio")
async def get_preview_audio(clone_id: str) -> FileResponse:
    """Отдать готовый mp3 предпросмотра (ссылка приходит из ``/preview``)."""
    _ensure_id(clone_id)
    path = _clone_dir(clone_id) / "preview.mp3"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Предпросмотра ещё нет — запросите /preview")
    return FileResponse(
        path=path,
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store"},
        filename=f"{clone_id}-preview.mp3",
    )
