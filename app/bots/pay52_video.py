"""HTTP-клиент 52pay.com для генерации видео семейством Seedance.

Поддерживаемые модели:
  1. seedance-2.0-mini (SEEDANCE_MINI_KEY / SEEDANCE_FAST_KEY):
     - prompt, seconds ("4"–"15"), aspect_ratio ("16:9"), resolution ("480p" | "720p")
     - metadata.content с ролями: first_frame, last_frame, reference_image (max 9),
       reference_video (max 3), reference_audio (max 3).
     - Аудио без картинки/видео отклоняется. Фото реального лица отклоняет.
  2. Seedance 2.0 Fast 海外 (SEEDANCE_FAST_KEY):
     - prompt (до 10 000 знаков), duration (4–15), ratio, resolution ("480p" | "720p")
     - referenceImages (до 9), referenceVideos (до 3), referenceAudios (до 3)
     - Поддержка живых лиц, плоские массивы без ролей start/end.
  3. Seedance 2.0 海外 (SEEDANCE_OVERSEAS_KEY):
     - prompt, duration (4–15), resolution, referenceImages (до 9), referenceVideos (до 3), referenceAudios (до 3)
  4. seedance-2.5 (SEEDANCE_OVERSEAS_KEY):
     - prompt, seconds (до 30), resolution ("480p" | "720p" | "1080p"), до 30 картинок.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

from app.bots.outsee import GenerationResult, OutseeImageError
from app.settings import settings

_POLL_INTERVAL_S = 3.0
_POLL_MAX_S = 900.0


class Pay52VideoError(OutseeImageError):
    """Ошибка вызова 52pay Video API (совместима с outsee_retry / classify_video_error)."""

    def __init__(self, message: str, *, context: dict[str, Any] | None = None) -> None:
        super().__init__(message, context=context)


def pay52_base_url() -> str:
    base = (getattr(settings, "pay52_base_url", "") or "https://api.52pay.com/v1").strip()
    return base.rstrip("/")


def normalize_pay52_video_model(raw: str) -> str:
    s = (raw or "").strip().lower()
    if "mini" in s:
        return "seedance-2.0-mini"
    if "2.5" in s or "2-5" in s:
        return "seedance-2.5"
    if "fast" in s:
        return "seedance-2.0-fast"
    if "kling" in s:
        return "kling-4.0"
    if "veo" in s:
        return "veo-3.1-fast-generate-preview"
    if "seedance" in s:
        return "seedance-2.0-fast"
    clean = (raw or "").strip()
    if clean and not any("\u4e00" <= c <= "\u9fff" for c in clean):
        return clean
    return "seedance-2.0-fast"


def pay52_video_supports_model(model_name: str) -> bool:
    name_low = (model_name or "").lower()
    return (
        "seedance" in name_low
        or "kling-4" in name_low
        or "kling_4" in name_low
        or ("kling" in name_low and "3" not in name_low and "2" not in name_low)
        or "veo-3.1-fast" in name_low
    )


def pay52_video_key_for_model(model_name: str, cfg: Any | None = None) -> str:
    if not pay52_video_supports_model(model_name):
        return ""
    s = cfg or settings
    name_low = (model_name or "").lower()
    if "kling" in name_low:
        return (s.seedance_overseas_key or s.seedance_fast_key or s.seedance_mini_key or "").strip()
    if "fast" in name_low:
        return (s.seedance_fast_key or s.seedance_mini_key or s.seedance_overseas_key or "").strip()
    if "2.5" in name_low or "2-5" in name_low or "overseas" in name_low or "海外" in model_name:
        return (s.seedance_overseas_key or s.seedance_fast_key or s.seedance_mini_key or "").strip()
    if "mini" in name_low or "ref" in name_low:
        return (s.seedance_mini_key or s.seedance_fast_key or s.seedance_overseas_key or "").strip()
    if "seedance" in name_low:
        return (s.seedance_fast_key or s.seedance_mini_key or s.seedance_overseas_key or "").strip()
    return ""


def pay52_video_candidate_keys(model_name: str, cfg: Any | None = None) -> list[str]:
    """Список рабочих ключей для конкретной модели видео 52pay (строго 1 ключ модели, без дублирующих вызовов)."""
    s = cfg or settings
    primary = pay52_video_key_for_model(model_name, cfg=s)
    if primary:
        return [primary]
    return []


def pay52_configured() -> bool:
    s = settings
    return bool(
        s.seedance_mini_key
        or s.seedance_fast_key
        or s.seedance_overseas_key
        or s.pay52_gpt_key
    )


def pay52_video_configured(spec: dict[str, Any] | None = None) -> bool:
    if not spec:
        return pay52_configured()
    model = str(spec.get("model") or spec.get("id") or spec.get("family_id") or "")
    return bool(pay52_video_key_for_model(model))


def build_pay52_video_payload(spec: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    """Сборка тела запроса согласно правилам конкретной модели Seedance на 52pay."""
    model_raw = str(spec.get("model") or spec.get("id") or "seedance-2.0-mini")
    prompt = str(values.get("prompt") or values.get("text") or "").strip()

    raw_dur = values.get("duration") or values.get("seconds") or 5
    try:
        dur_int = max(1, min(30, int(float(raw_dur))))
    except (ValueError, TypeError):
        dur_int = 5

    raw_ratio = str(values.get("aspect_ratio") or values.get("ratio") or "16:9").replace("_", ":")
    if raw_ratio in ("auto", "", "None"):
        raw_ratio = "16:9"

    raw_res = str(values.get("resolution") or "720p").lower()
    if raw_res not in ("480p", "720p", "1080p", "4k"):
        raw_res = "720p"

    first_frame = (
        values.get("first_frame_url")
        or values.get("first_frame")
        or values.get("image_url")
        or values.get("image")
    )
    last_frame = values.get("last_frame_url") or values.get("last_frame")
    ref_images = (
        values.get("reference_image_urls")
        or values.get("reference_images")
        or values.get("referenceImages")
        or values.get("image_urls")
        or values.get("images")
        or []
    )
    if isinstance(ref_images, str):
        ref_images = [ref_images]
    ref_videos = values.get("reference_video_urls") or values.get("reference_videos") or []
    if isinstance(ref_videos, str):
        ref_videos = [ref_videos]
    ref_audios = values.get("reference_audio_urls") or values.get("reference_audios") or []
    if isinstance(ref_audios, str):
        ref_audios = [ref_audios]

    # 1. Модель seedance-2.0-mini (базовый Mini)
    if "mini" in model_raw.lower() or "seedance-2.0-mini" in model_raw.lower():
        content: list[dict[str, str]] = []
        img_count = 0
        if first_frame and img_count < 9:
            content.append({"role": "first_frame", "url": str(first_frame).strip()})
            img_count += 1
        if last_frame and img_count < 9:
            content.append({"role": "last_frame", "url": str(last_frame).strip()})
            img_count += 1
        for u in ref_images:
            if img_count >= 9:
                break
            su = str(u).strip()
            if su and not any(c.get("url") == su for c in content):
                content.append({"role": "reference_image", "url": su})
                img_count += 1

        vid_count = 0
        for u in ref_videos:
            if vid_count >= 3:
                break
            su = str(u).strip()
            if su:
                content.append({"role": "reference_video", "url": su})
                vid_count += 1

        aud_count = 0
        for u in ref_audios:
            if aud_count >= 3:
                break
            su = str(u).strip()
            if su:
                content.append({"role": "reference_audio", "url": su})
                aud_count += 1

        if aud_count > 0 and img_count == 0 and vid_count == 0:
            raise Pay52VideoError(
                "Seedance Mini Ref: аудио не может передаваться без изображения или видео",
                context={"provider_code": 400, "error_kind": "invalid_attachments"},
            )

        payload: dict[str, Any] = {
            "model": "seedance-2.0-mini",
            "prompt": prompt,
            "seconds": str(min(15, max(4, dur_int))),
            "aspect_ratio": raw_ratio,
            "resolution": raw_res if raw_res in ("480p", "720p") else "720p",
        }
        if content:
            payload["metadata"] = {"content": content}
        return payload

    # 2. Модель Seedance 2.0 Fast (seedance-2.0-fast)
    if "fast" in model_raw.lower():
        all_images: list[str] = []
        if first_frame:
            all_images.append(str(first_frame).strip())
        if last_frame:
            su = str(last_frame).strip()
            if su not in all_images:
                all_images.append(su)
        for u in ref_images:
            su = str(u).strip()
            if su and su not in all_images:
                all_images.append(su)

        return {
            "model": "seedance-2.0-fast",
            "prompt": prompt[:10000],
            "duration": min(15, max(4, dur_int)),
            "ratio": raw_ratio,
            "resolution": raw_res if raw_res in ("480p", "720p") else "720p",
            "referenceImages": all_images[:9],
            "referenceVideos": [str(u).strip() for u in ref_videos if str(u).strip()][:3],
            "referenceAudios": [str(u).strip() for u in ref_audios if str(u).strip()][:3],
        }

    # 3. seedance-2.5
    if "2.5" in model_raw or "2-5" in model_raw:
        all_images = []
        if first_frame:
            all_images.append(str(first_frame).strip())
        if last_frame:
            su = str(last_frame).strip()
            if su not in all_images:
                all_images.append(su)
        for u in ref_images:
            su = str(u).strip()
            if su and su not in all_images:
                all_images.append(su)

        return {
            "model": "seedance-2.5",
            "prompt": prompt,
            "seconds": str(min(30, max(4, dur_int))),
            "resolution": raw_res if raw_res in ("480p", "720p", "1080p") else "720p",
            "referenceImages": all_images[:30],
        }

    # 4. Kling 4.0
    if "kling" in model_raw.lower():
        all_images = []
        if first_frame:
            su = str(first_frame).strip()
            if su:
                all_images.append(su)
        if last_frame:
            su = str(last_frame).strip()
            if su and su not in all_images:
                all_images.append(su)
        for u in ref_images:
            su = str(u).strip()
            if su and su not in all_images:
                all_images.append(su)

        payload_kling: dict[str, Any] = {
            "model": "kling-4.0",
            "prompt": prompt,
            "duration": min(30, max(5, dur_int)),
            "ratio": raw_ratio,
            "resolution": raw_res if raw_res in ("480p", "720p", "1080p") else "720p",
        }
        if all_images:
            payload_kling["referenceImages"] = all_images[:9]
            payload_kling["image_url"] = all_images[0]
        return payload_kling

    # 5. Fallback / Seedance 2.0 (seedance-2.0-fast)
    all_images = []
    if first_frame:
        all_images.append(str(first_frame).strip())
    if last_frame:
        su = str(last_frame).strip()
        if su not in all_images:
            all_images.append(su)
    for u in ref_images:
        su = str(u).strip()
        if su and su not in all_images:
            all_images.append(su)

    fallback_model = normalize_pay52_video_model(model_raw)
    return {
        "model": fallback_model,
        "prompt": prompt,
        "duration": min(15, max(4, dur_int)),
        "resolution": raw_res if raw_res in ("480p", "720p", "1080p") else "720p",
        "referenceImages": all_images[:9],
        "referenceVideos": [str(u).strip() for u in ref_videos if str(u).strip()][:3],
        "referenceAudios": [str(u).strip() for u in ref_audios if str(u).strip()][:3],
    }


async def create_task(
    body: dict[str, Any],
    *,
    key: str | None = None,
    max_retries: int | None = None,
) -> str:
    """Создаёт задачу видеогенерации через POST /v1/videos.

    Отказоустойчивость:
    - Вариант 1 (Smart Retry): повторы с экспоненциальной задержкой при 500, 502, 503, 504 и таймаутах.
    - Вариант 2 (Key Fallback): ротация на резервные ключи пула при 401, 402, 403, 429.
    """
    model_name = normalize_pay52_video_model(str(body.get("model") or ""))
    body["model"] = model_name

    candidate_keys = pay52_video_candidate_keys(model_name)
    if key and key.strip():
        explicit = key.strip()
        candidate_keys = [explicit] + [k for k in candidate_keys if k != explicit]

    if not candidate_keys:
        raise Pay52VideoError(
            f"52pay: нет API-ключа для модели {model_name!r}",
            context={"provider_code": 401, "error_kind": "no_key"},
        )

    retries_per_key = int(max_retries if max_retries is not None else getattr(settings, "pay52_max_retries", 3))
    base_backoff_s = float(getattr(settings, "pay52_retry_backoff_base_s", 1.0))
    url = f"{pay52_base_url()}/videos"

    last_err: Pay52VideoError | None = None

    for key_idx, current_key in enumerate(candidate_keys):
        headers = {
            "Authorization": f"Bearer {current_key}",
            "Content-Type": "application/json",
        }
        for attempt in range(retries_per_key):
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    r = await client.post(url, headers=headers, json=body)
                try:
                    resp_data = r.json()
                except Exception:
                    resp_data = {"message": (r.text or "")[:300], "code": r.status_code}
            except Exception as e:
                backoff = min(base_backoff_s * (2 ** attempt), 10.0)
                logger.warning(
                    "pay52_video: сбой сети при создании задачи ({}: {}), попытка {}/{}, повтор через {:.1f}s",
                    type(e).__name__,
                    e,
                    attempt + 1,
                    retries_per_key,
                    backoff,
                )
                last_err = Pay52VideoError(
                    f"52pay create POST failed: {type(e).__name__} ({e})",
                    context={"provider_code": 504},
                )
                if attempt + 1 < retries_per_key:
                    await asyncio.sleep(backoff)
                continue

            if 200 <= r.status_code < 300 and isinstance(resp_data, dict):
                task_id = str(resp_data.get("task_id") or resp_data.get("id") or "").strip()
                if not task_id:
                    data_block = resp_data.get("data")
                    if isinstance(data_block, dict):
                        task_id = str(data_block.get("task_id") or data_block.get("id") or "").strip()
                if task_id:
                    return task_id
                last_err = Pay52VideoError(
                    "52pay create: в ответе нет task_id",
                    context={"provider_code": 500, "raw": str(resp_data)[:200]},
                )
                backoff = min(base_backoff_s * (2 ** attempt), 10.0)
                if attempt + 1 < retries_per_key:
                    await asyncio.sleep(backoff)
                continue

            err_msg = ""
            if isinstance(resp_data, dict):
                raw_err = resp_data.get("error")
                err_dict: dict[str, Any] = raw_err if isinstance(raw_err, dict) else resp_data
                err_msg = str(err_dict.get("message") or err_dict.get("msg") or resp_data)

            last_err = Pay52VideoError(
                f"52pay create failed ({r.status_code}): {err_msg[:300]}",
                context={"provider_code": r.status_code, "raw": str(resp_data)[:200]},
            )

            # Вариант 2: ротация ключей при ошибках авторизации/лимитах/балансе/недействительном ключе
            # Примечание: 52pay при недействительном/истекшем токене возвращает HTTP 400 с сообщением "密钥无效" / "Invalid token"
            err_low = (err_msg or "").lower()
            is_key_err = (
                r.status_code in (401, 402, 403, 429)
                or (
                    r.status_code == 400
                    and any(m in err_low or m in err_msg for m in ("密钥", "token", "key", "auth", "invalid api key"))
                )
            )
            if is_key_err:
                if key_idx + 1 < len(candidate_keys):
                    logger.warning(
                        "pay52_video: ключ {}/{} вернул HTTP {} ({}), переключаемся на резервный ключ...",
                        key_idx + 1,
                        len(candidate_keys),
                        r.status_code,
                        err_msg[:100],
                    )
                    break
                raise last_err

            # Вариант 1: повтор с экспоненциальной задержкой при 5xx
            if r.status_code in (500, 502, 503, 504) or r.status_code >= 500:
                backoff = min(base_backoff_s * (2 ** attempt), 10.0)
                logger.warning(
                    "pay52_video: create ошибка HTTP {} ({}), попытка {}/{}, повтор через {:.1f}s",
                    r.status_code,
                    err_msg[:100],
                    attempt + 1,
                    retries_per_key,
                    backoff,
                )
                if attempt + 1 < retries_per_key:
                    await asyncio.sleep(backoff)
                continue

            raise last_err

    if last_err:
        raise last_err
    raise Pay52VideoError("52pay: не удалось создать задачу (исчерпаны попытки и ключи)")


async def poll_task(
    task_id: str,
    *,
    model_name: str,
    key: str | None = None,
    timeout_s: float = _POLL_MAX_S,
) -> str:
    """Опрашивает статус задачи до завершения, возвращает URL готового видео."""
    candidate_keys = pay52_video_candidate_keys(model_name)
    if key and key.strip():
        explicit = key.strip()
        candidate_keys = [explicit] + [k for k in candidate_keys if k != explicit]
    active_key = candidate_keys[0] if candidate_keys else (key or pay52_video_key_for_model(model_name))
    key_idx = 0

    headers = {
        "Authorization": f"Bearer {active_key}",
        "Content-Type": "application/json",
    }
    url = f"{pay52_base_url()}/videos/{task_id}"
    fallback_url = f"{pay52_base_url()}/video/generations/{task_id}"

    deadline = asyncio.get_running_loop().time() + max(60.0, timeout_s)
    net_fails = 0

    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            try:
                r = await client.get(url, headers=headers)
                net_fails = 0
            except (httpx.TransportError, httpx.TimeoutException) as e:
                net_fails += 1
                if net_fails >= 8 or asyncio.get_running_loop().time() >= deadline:
                    raise Pay52VideoError(
                        f"52pay poll {task_id}: таймаут/сбой сети ({type(e).__name__})",
                        context={"provider_code": 504, "task_id": task_id},
                    ) from e
                await asyncio.sleep(_POLL_INTERVAL_S)
                continue

            # Ротация ключа если во время поллинга отвалилась авторизация/квота/недействительный ключ
            poll_text_low = (r.text or "").lower()
            is_poll_key_err = (
                r.status_code in (401, 402, 403, 429)
                or (
                    r.status_code == 400
                    and any(m in poll_text_low or m in (r.text or "") for m in ("密钥", "token", "key", "auth"))
                )
            )
            if is_poll_key_err and key_idx + 1 < len(candidate_keys):
                key_idx += 1
                active_key = candidate_keys[key_idx]
                headers["Authorization"] = f"Bearer {active_key}"
                logger.warning(
                    "pay52_video poll: ключ вернул HTTP {}, ротация на запасной ключ ({}/{})",
                    r.status_code,
                    key_idx + 1,
                    len(candidate_keys),
                )
                await asyncio.sleep(1.0)
                continue

            if r.status_code >= 500:
                net_fails += 1
                if net_fails >= 8 or asyncio.get_running_loop().time() >= deadline:
                    raise Pay52VideoError(
                        f"52pay poll {task_id}: сервер вернул HTTP {r.status_code}",
                        context={"provider_code": r.status_code, "task_id": task_id},
                    )
                await asyncio.sleep(_POLL_INTERVAL_S)
                continue

            try:
                data = r.json()
            except Exception:
                data = {"message": (r.text or "")[:300], "code": r.status_code}

            if not isinstance(data, dict):
                await asyncio.sleep(_POLL_INTERVAL_S)
                continue

            # Извлечение статуса
            status = str(data.get("status") or "").lower()
            raw_meta = data.get("metadata")
            metadata: dict[str, Any] = raw_meta if isinstance(raw_meta, dict) else {}

            if status in ("completed", "success", "succeeded", "finish", "finished", "done"):
                video_url = str(
                    metadata.get("url")
                    or metadata.get("video_url")
                    or metadata.get("videoUrl")
                    or metadata.get("download_url")
                    or data.get("url")
                    or data.get("video_url")
                    or data.get("videoUrl")
                    or data.get("download_url")
                    or data.get("output")
                    or ""
                ).strip()
                if not video_url and isinstance(data.get("data"), dict):
                    inner_d = data["data"]
                    video_url = str(
                        inner_d.get("url")
                        or inner_d.get("video_url")
                        or inner_d.get("videoUrl")
                        or inner_d.get("result_url")
                        or inner_d.get("download_url")
                        or inner_d.get("output")
                        or ""
                    ).strip()
                elif not video_url and isinstance(data.get("data"), list) and data["data"]:
                    first_item = data["data"][0]
                    if isinstance(first_item, str) and first_item.startswith("http"):
                        video_url = first_item.strip()
                    elif isinstance(first_item, dict):
                        video_url = str(first_item.get("url") or first_item.get("video_url") or "").strip()
                if video_url:
                    return video_url
                # Если статус completed, но url еще не записан, подождём 1 итерацию
                await asyncio.sleep(2.0)

            if status in ("failed", "failure", "error", "fail"):
                fail_reason = str(data.get("fail_reason") or data.get("error") or data.get("message") or "Video generation failed")
                raise Pay52VideoError(
                    f"52pay генерация завершилась ошибкой: {fail_reason[:300]}",
                    context={"provider_code": 501, "task_id": task_id},
                )

            # Если основной эндпоинт вернул unknown или пустой статус, проверим fallback /video/generations/
            if status in ("unknown", ""):
                try:
                    r_fb = await client.get(fallback_url, headers=headers)
                    data_fb = r_fb.json()
                    if isinstance(data_fb, dict) and isinstance(data_fb.get("data"), dict):
                        fb_inner = data_fb["data"]
                        fb_st = str(fb_inner.get("status") or "").lower()
                        if fb_st in ("success", "completed", "succeeded", "done"):
                            video_url = str(
                                fb_inner.get("url")
                                or fb_inner.get("video_url")
                                or fb_inner.get("videoUrl")
                                or fb_inner.get("download_url")
                                or ""
                            ).strip()
                            if video_url:
                                return video_url
                        elif fb_st in ("fail", "failed", "error"):
                            fail_reason = str(fb_inner.get("fail_reason") or "Video generation failed")
                            raise Pay52VideoError(
                                f"52pay генерация завершилась ошибкой: {fail_reason[:300]}",
                                context={"provider_code": 501, "task_id": task_id},
                            )
                except Exception:
                    pass

            if asyncio.get_running_loop().time() >= deadline:
                raise Pay52VideoError(
                    f"52pay poll {task_id}: превышен лимит ожидания ({timeout_s}s)",
                    context={"provider_code": 504, "task_id": task_id},
                )

            await asyncio.sleep(_POLL_INTERVAL_S)


async def run_generation(
    spec: dict[str, Any],
    payload: dict[str, Any],
    out_path: Path,
    *,
    timeout_s: float = _POLL_MAX_S,
) -> GenerationResult:
    """Полный цикл: подготовка payload, отправка, поллинг и скачивание mp4."""
    model_name = str(spec.get("model") or spec.get("id") or "")
    key = pay52_video_key_for_model(model_name)

    # Если payload ещё не сформирован под 52pay, трансформируем его
    if "metadata" not in payload and "referenceImages" not in payload and "model" not in payload:
        final_body = build_pay52_video_payload(spec, payload)
    elif payload.get("input") and isinstance(payload["input"], dict):
        final_body = build_pay52_video_payload(spec, payload["input"])
    else:
        final_body = payload

    logger.info("pay52_video: отправка задачи для модели {} (seconds/duration={})", final_body.get("model"), final_body.get("seconds") or final_body.get("duration"))
    task_id = await create_task(final_body, key=key)
    logger.info("pay52_video: задача создана (task_id={}), начинаем поллинг", task_id)

    video_url = await poll_task(task_id, model_name=str(final_body.get("model")), key=key, timeout_s=timeout_s)
    logger.info("pay52_video: видео готово, скачиваем с {}", video_url[:100])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    browser_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    # Подписанные URL хранилищ (OSS / S3 / CDN) не принимают Authorization заголовок (возвращают 400)
    has_query_signature = any(
        param in video_url.lower()
        for param in ("signature=", "x-amz-", "ossaccesskeyid=", "token=", "expires=")
    )

    last_dl_err: Exception | None = None
    for attempt in range(4):
        # 1-я попытка для подписанных ссылок — чистый GET без Authorization.
        # Для внутренних URL api.52pay.com без подписи — с Authorization.
        use_auth = bool(
            key
            and not has_query_signature
            and (pay52_base_url() in video_url or "aihubkit.com" in video_url or "52pay" in video_url)
        )
        if attempt == 1 and not use_auth and key:
            use_auth = True
        elif attempt == 2 and use_auth:
            use_auth = False

        headers: dict[str, str] = {"User-Agent": browser_ua}
        if use_auth and key:
            headers["Authorization"] = f"Bearer {key}"

        try:
            async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
                r = await client.get(video_url, headers=headers)
                if r.status_code == 200 and r.content and len(r.content) >= 32:
                    out_path.write_bytes(r.content)
                    last_dl_err = None
                    break
                logger.warning(
                    "pay52_video: скачивание попытка {}/4 status={} auth={} ответ={}",
                    attempt + 1,
                    r.status_code,
                    use_auth,
                    (r.text or "")[:150],
                )
                last_dl_err = Pay52VideoError(
                    f"52pay: не удалось скачать готовое видео ({r.status_code})",
                    context={"provider_code": r.status_code, "video_url": video_url[:150]},
                )
        except Exception as e:
            last_dl_err = e
            logger.warning("pay52_video: скачивание попытка {}/4 не удалась ({}): {}", attempt + 1, video_url[:80], e)
        if attempt < 3:
            await asyncio.sleep(2.0 * (attempt + 1))

    if last_dl_err:
        if isinstance(last_dl_err, Pay52VideoError):
            raise last_dl_err
        raise Pay52VideoError(
            f"52pay: не удалось скачать готовое видео: {last_dl_err}",
            context={"video_url": video_url[:150]},
        ) from last_dl_err

    logger.info("pay52_video: успешно сохранено в {} ({} bytes)", out_path.name, out_path.stat().st_size)
    return GenerationResult(file_path=out_path, raw_url=video_url, gen_id=task_id)
