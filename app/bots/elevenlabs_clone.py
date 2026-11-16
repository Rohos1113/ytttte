"""Клонирование голоса через ElevenLabs API (`POST /v1/voices/add`).

## Зачем отдельный файл

Озвучка уже живёт в ``app/bots/elevenlabs_api.py``. Здесь другая
ответственность: не синтез, а управление голосами — мгновенный клон (IVC) из
загруженных сэмплов и короткий предпросмотр клонированным голосом. Держать это
в одном модуле с TTS значило бы смешать «озвучить текст» и «завести голос».

## Контракт провайдера

``POST https://api.elevenlabs.io/v1/voices/add``
заголовок ``xi-api-key``;
multipart: ``name`` (обязателен), ``description``, ``labels`` (JSON-строка,
язык кладём туда), ``files`` — один или несколько аудиофайлов;
ответ: ``{"voice_id": "..."}``.

Предпросмотр: ``POST /v1/text-to-speech/{voice_id}`` → сырые байты mp3
(тот же транспорт, что у озвучки, поэтому формат вывода берём из настроек).

## Ошибки

Наружу не летит ни статус, ни тело ответа провайдера: только человеческий
текст по-русски (401 — ключ, 402 — тариф, 403 — гео-блок/права ключа,
422 — сэмплы, 429 — частота). Роутер реестра кладёт этот текст в
``provider_error`` и отдаёт запись со статусом ``pending_provider``, а не 500:
сэмплы пользователя уже сохранены, и терять их из-за чужой ошибки нельзя.
"""

from __future__ import annotations

import json
import mimetypes
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

_API_BASE = "https://api.elevenlabs.io/v1"
# Клон — это загрузка до 25 МБ аудио на сторону провайдера, ему нужен запас.
_CREATE_TIMEOUT = 180.0
_TTS_TIMEOUT = 120.0

_MIME_BY_EXT = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "m4a": "audio/mp4",
    "ogg": "audio/ogg",
    "flac": "audio/flac",
}

# Что сказать оператору по коду ответа — без стектрейсов и без тела ответа.
_STATUS_HINTS = {
    401: "ElevenLabs отклонил ключ (HTTP 401) — проверь ELEVENLABS_API_KEY",
    402: "Тариф ElevenLabs не разрешает клонирование голоса (HTTP 402)",
    403: "ElevenLabs запретил запрос (HTTP 403): гео-блок или у ключа нет прав",
    422: "ElevenLabs не принял сэмплы (HTTP 422): слишком короткие, тихие или битые",
    429: "ElevenLabs ограничил частоту запросов (HTTP 429) — повтори позже",
}


class ElevenLabsCloneError(RuntimeError):
    """Провайдер не дал создать/озвучить клон. Текст — для человека."""


class ElevenLabsNotConfigured(ElevenLabsCloneError):
    """Ключ ElevenLabs не задан — идти к провайдеру не с чем."""


def elevenlabs_api_key() -> str:
    from app.settings import settings

    return (settings.elevenlabs_api_key or "").strip()


def elevenlabs_clone_configured() -> bool:
    """Есть ли ключ для создания клонов (та же настройка, что у озвучки)."""
    return bool(elevenlabs_api_key())


def _require_key() -> str:
    key = elevenlabs_api_key()
    if not key:
        raise ElevenLabsNotConfigured(
            "Ключ ElevenLabs не задан (ELEVENLABS_API_KEY) — сэмплы сохранены, "
            "клон ждёт ключа"
        )
    return key


def _mime_for(path: Path) -> str:
    guessed = mimetypes.guess_type(path.name)[0]
    if guessed:
        return guessed
    return _MIME_BY_EXT.get(path.suffix.lower().lstrip("."), "application/octet-stream")


def _provider_error(resp: httpx.Response, action: str) -> ElevenLabsCloneError:
    """Ошибка провайдера как понятный текст: код + короткая выдержка ответа."""
    hint = _STATUS_HINTS.get(resp.status_code) or (
        f"ElevenLabs ответил HTTP {resp.status_code} на {action}"
    )
    body = " ".join((resp.text or "").split())[:200]
    message = f"{hint}. Ответ провайдера: {body}" if body else hint
    logger.warning("11Labs clone: {} — {}", action, message)
    return ElevenLabsCloneError(message)


async def create_voice(
    name: str,
    description: str = "",
    files: list[Path] | None = None,
    *,
    language: str | None = None,
) -> str:
    """Создать мгновенный клон голоса. Возвращает ``voice_id`` провайдера.

    ``files`` — уже сохранённые на диск сэмплы (роутер пишет их до вызова,
    чтобы ошибка провайдера не теряла загрузку пользователя).
    """
    key = _require_key()
    clean_name = (name or "").strip()
    if not clean_name:
        raise ElevenLabsCloneError("Пустое имя голоса — ElevenLabs такое не примет")
    paths = [Path(p) for p in (files or [])]
    if not paths:
        raise ElevenLabsCloneError("Нет сэмплов для клонирования")
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        raise ElevenLabsCloneError(f"Сэмпл пропал с диска: {missing[0]}")

    data: dict[str, str] = {"name": clean_name}
    if description.strip():
        data["description"] = description.strip()
    if language and language.strip():
        # ElevenLabs ждёт labels строкой JSON, а не вложенным объектом.
        data["labels"] = json.dumps({"language": language.strip()}, ensure_ascii=False)

    try:
        with ExitStack() as stack:
            multipart: list[tuple[str, tuple[str, Any, str]]] = []
            for path in paths:
                handle = stack.enter_context(path.open("rb"))
                multipart.append(("files", (path.name, handle, _mime_for(path))))
            async with httpx.AsyncClient(timeout=_CREATE_TIMEOUT) as client:
                resp = await client.post(
                    f"{_API_BASE}/voices/add",
                    headers={"xi-api-key": key},
                    data=data,
                    files=multipart,
                )
    except httpx.HTTPError as e:
        raise ElevenLabsCloneError(
            f"ElevenLabs недоступен: {e.__class__.__name__}. Проверь сеть/прокси"
        ) from e

    if resp.status_code not in (200, 201):
        raise _provider_error(resp, "создание голоса")

    try:
        payload = resp.json()
    except ValueError as e:
        raise ElevenLabsCloneError("ElevenLabs вернул не-JSON на создание голоса") from e

    voice_id = str(payload.get("voice_id") or "").strip()
    if not voice_id:
        voice = payload.get("voice") or {}
        voice_id = str(voice.get("voice_id") or voice.get("id") or "").strip()
    if not voice_id:
        raise ElevenLabsCloneError("ElevenLabs не вернул voice_id — клон не подтверждён")

    logger.info("11Labs clone: голос «{}» создан, voice_id={}", clean_name, voice_id)
    return voice_id


async def synthesize_preview(voice_id: str, text: str, out_path: Path) -> Path:
    """Озвучить короткую фразу клоном и сохранить mp3 в ``out_path``."""
    key = _require_key()
    clean_text = (text or "").strip()
    if not clean_text:
        raise ElevenLabsCloneError("Пустой текст для предпросмотра")
    clean_voice = (voice_id or "").strip()
    if not clean_voice:
        raise ElevenLabsCloneError("У клона нет voice_id провайдера — предпросмотр невозможен")

    from app.settings import settings

    try:
        async with httpx.AsyncClient(timeout=_TTS_TIMEOUT) as client:
            resp = await client.post(
                f"{_API_BASE}/text-to-speech/{clean_voice}",
                headers={"xi-api-key": key, "Accept": "audio/mpeg"},
                params={"output_format": settings.elevenlabs_output_format or "mp3_44100_128"},
                json={"text": clean_text, "model_id": settings.elevenlabs_tts_model},
            )
    except httpx.HTTPError as e:
        raise ElevenLabsCloneError(
            f"ElevenLabs недоступен: {e.__class__.__name__}. Проверь сеть/прокси"
        ) from e

    if resp.status_code != 200 or not resp.content:
        raise _provider_error(resp, "предпросмотр")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(resp.content)
    return out_path
