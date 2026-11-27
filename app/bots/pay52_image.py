"""HTTP-клиент 52pay.com для генерации изображений.

Поддерживаемые семейства:
  1. Doubao Seedream (PAY52_SEEDREAM_KEY):
     - doubao-seedream-5.0-flash, doubao-seedream-5.0-pro, doubao-seedream-4.0
  2. GPT Image (PAY52_GPT_IMAGE_KEY):
     - gpt-image-2.5, gpt-image-2.5-flare, gpt-image-2, gpt-image-2-4k
  3. Gemini / Nano Banana (PAY52_BANANA_KEY):
     - gemini-3.1-flash-image (Nano Banana 2 / Lite),
       gemini-3-pro-image-preview (Nano Banana Pro),
       gemini-nano-banana-2.1 (Nano Banana 2.1)
"""

from __future__ import annotations

import base64
import uuid
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

from app.bots.outsee import GenerationResult
from app.settings import settings

ASPECT_TO_SIZE: dict[str, str] = {
    "1:1": "1024x1024",
    "9:16": "1024x1792",
    "16:9": "1792x1024",
    "4:3": "1024x768",
    "3:4": "768x1024",
    "3:2": "1080x720",
    "2:3": "720x1080",
    "21:9": "1792x768",
    "27:16": "1728x1024",
    "16:27": "1024x1728",
    "9:8": "1152x1024",
    "8:9": "1024x1152",
    "auto": "1024x1024",
}


class Pay52ImageError(RuntimeError):
    """Ошибка вызова 52pay Image API."""

    def __init__(self, message: str, *, context: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.context = context or {}


def pay52_base_url() -> str:
    base = (getattr(settings, "pay52_base_url", "") or "https://api.52pay.com/v1").strip()
    return base.rstrip("/")


def pay52_image_supports_model(model_name: str) -> bool:
    name_low = (model_name or "").lower()
    return (
        "seedream" in name_low
        or "doubao" in name_low
        or "gpt-image" in name_low
        or "gpt_image" in name_low
        or "banana" in name_low
        or ("gemini" in name_low and "image" in name_low)
    )


def normalize_pay52_image_model(raw_model: str, values: dict[str, Any] | None = None) -> str:
    s = (raw_model or "").strip().lower()
    val = values or {}

    # 1. Doubao Seedream
    if "seedream" in s or "doubao" in s:
        if "5.5" in s or "5-5" in s or "5_5" in s:
            return "doubao-seedream-5.5"
        if "flash" in s or "lite" in s:
            return "doubao-seedream-5.0-flash"
        if "4" in s and "4." in s:
            return "doubao-seedream-4.0"
        return "doubao-seedream-5.0-pro"

    # 2. GPT Image
    if "gpt" in s and "image" in s:
        quality = str(val.get("quality") or "").lower()
        resolution = str(val.get("resolution") or "").upper()
        if "4k" in s or resolution == "4K":
            return "gpt-image-2-4k"
        if "flare" in s or quality == "high":
            return "gpt-image-2.5-flare"
        if "2-6" in s or "2.6" in s or "2-5" in s or "2.5" in s:
            return "gpt-image-2.5"
        if "2" in s and ("2-0" in s or "2.0" in s or s.endswith("-2") or s == "gpt-image-2"):
            return "gpt-image-2"
        return "gpt-image-2.5"

    # 3. Gemini / Nano Banana
    if "banana" in s or "gemini" in s:
        if "pro" in s:
            return "gemini-3-pro-image-preview"
        if "2.1" in s or "2-1" in s:
            return "gemini-nano-banana-2.1"
        return "gemini-3.1-flash-image"

    return (raw_model or "").strip()


def pay52_image_key_for_model(model_name: str, cfg: Any | None = None) -> str:
    if not pay52_image_supports_model(model_name):
        return ""
    s = cfg or settings
    name_low = (model_name or "").lower()

    if "seedream" in name_low or "doubao" in name_low:
        key = (getattr(s, "pay52_seedream_key", "") or "").strip()
        if key:
            return key
    elif "gpt" in name_low and "image" in name_low:
        key = (getattr(s, "pay52_gpt_image_key", "") or "").strip()
        if key:
            return key
    elif "banana" in name_low or "gemini" in name_low:
        key = (getattr(s, "pay52_banana_key", "") or "").strip()
        if key:
            return key

    return ""


def pay52_image_candidate_keys(model_name: str, cfg: Any | None = None) -> list[str]:
    """Список рабочих и резервных ключей для картинок 52pay в порядке приоритета."""
    s = cfg or settings
    primary = pay52_image_key_for_model(model_name, cfg=s)
    keys: list[str] = []
    if primary:
        keys.append(primary)

    name_low = (model_name or "").lower()
    if "seedream" in name_low or "doubao" in name_low:
        alt = str(getattr(s, "pay52_seedream_key", "") or "").strip()
        if alt:
            keys.append(alt)
    elif "gpt" in name_low and "image" in name_low:
        alt = str(getattr(s, "pay52_gpt_image_key", "") or "").strip()
        if alt:
            keys.append(alt)
    elif "banana" in name_low or "gemini" in name_low:
        alt = str(getattr(s, "pay52_banana_key", "") or "").strip()
        if alt:
            keys.append(alt)

    seen: set[str] = set()
    result: list[str] = []
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            result.append(k)
    return result


def pay52_image_configured(spec_or_model: Any = None, cfg: Any | None = None) -> bool:
    s = cfg or settings
    if spec_or_model is not None:
        if isinstance(spec_or_model, dict):
            model_id = str(spec_or_model.get("model") or spec_or_model.get("id") or "")
        else:
            model_id = str(spec_or_model or "")
        if not pay52_image_supports_model(model_id):
            return False
        return bool(pay52_image_key_for_model(model_id, cfg=s))

    return bool(
        getattr(s, "pay52_seedream_key", "")
        or getattr(s, "pay52_banana_key", "")
        or getattr(s, "pay52_gpt_image_key", "")
        or (getattr(s, "pay52_gpt_key", "") and getattr(s, "pay52_key_fallback_enabled", True))
    )


def build_pay52_image_payload(
    spec: dict[str, Any],
    values: dict[str, Any],
) -> dict[str, Any]:
    raw_model = str(spec.get("model") or spec.get("id") or "")
    model_name = normalize_pay52_image_model(raw_model, values)
    prompt = str(values.get("prompt") or values.get("text") or "").strip()

    aspect_ratio = str(values.get("aspect_ratio") or values.get("aspectRatio") or "1:1").replace("_", ":")
    size = ASPECT_TO_SIZE.get(aspect_ratio, "1024x1024")

    payload: dict[str, Any] = {
        "model": model_name,
        "prompt": prompt,
        "size": size,
        "aspect_ratio": aspect_ratio,
    }

    # Поддержка референсных изображений (i2i)
    image_urls = (
        values.get("image_urls")
        or values.get("imageUrls")
        or values.get("input_urls")
        or values.get("image_input")
    )
    if not image_urls and values.get("image_url"):
        image_urls = [values["image_url"]]
    if image_urls and isinstance(image_urls, list) and image_urls:
        payload["image_urls"] = image_urls
        payload["image"] = image_urls[0]

    return payload


async def run_generation(
    spec: dict[str, Any],
    values: dict[str, Any],
    out_path: Path,
    *,
    timeout_s: float = 180.0,
    cfg: Any | None = None,
) -> GenerationResult:
    """Генерация изображения через 52pay POST /v1/images/generations."""
    payload = build_pay52_image_payload(spec, values)
    model_name = str(payload.get("model") or "")
    keys = pay52_image_candidate_keys(model_name, cfg=cfg)
    if not keys:
        raise Pay52ImageError(
            f"52pay image: нет настроенного API-ключа для модели {model_name}",
            context={"provider_code": 401, "model": model_name},
        )

    url = f"{pay52_base_url()}/images/generations"
    logger.info("pay52_image: запрос к {} (model={}, size={}, keys={})", url, model_name, payload.get("size"), len(keys))

    last_error: Exception | None = None
    for key_idx, key in enumerate(keys):
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as client:
                r = await client.post(url, headers=headers, json=payload)
                if r.status_code == 400 and payload.get("model") == "doubao-seedream-5.5":
                    logger.warning(
                        "pay52_image: ключ 52pay не имеет прав на doubao-seedream-5.5, мягкий fallback на doubao-seedream-5.0-pro"
                    )
                    fallback_payload = dict(payload, model="doubao-seedream-5.0-pro")
                    r = await client.post(url, headers=headers, json=fallback_payload)
                if r.status_code == 200:
                    data = r.json()
                    items = data.get("data") or []
                    if not items:
                        raise Pay52ImageError(
                            f"52pay image: пустой список результатов в ответе: {r.text[:200]}",
                            context={"provider_code": 500, "response": r.text[:200]},
                        )
                    item = items[0]
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    gen_id = f"pay52-img-{uuid.uuid4().hex[:12]}"

                    # 1. Base64 ответ (b64_json)
                    b64_data = item.get("b64_json") or item.get("base64")
                    if b64_data:
                        raw_bytes = base64.b64decode(b64_data)
                        out_path.write_bytes(raw_bytes)
                        logger.info(
                            "pay52_image: получено b64 изображение, сохранено в {} ({} bytes)",
                            out_path.name,
                            len(raw_bytes),
                        )
                        return GenerationResult(file_path=out_path, gen_id=gen_id, raw_url=None)

                    # 2. URL ответ
                    img_url = str(item.get("url") or "").strip()
                    if img_url:
                        logger.info("pay52_image: скачиваем результат с {}", img_url[:100])
                        dl_r = await client.get(img_url, timeout=60.0)
                        if dl_r.status_code == 200 and dl_r.content:
                            out_path.write_bytes(dl_r.content)
                            logger.info(
                                "pay52_image: сохранено в {} ({} bytes)",
                                out_path.name,
                                len(dl_r.content),
                            )
                            return GenerationResult(file_path=out_path, gen_id=gen_id, raw_url=img_url)
                        raise Pay52ImageError(
                            f"52pay image: не удалось скачать картинку ({dl_r.status_code})",
                            context={"provider_code": dl_r.status_code, "img_url": img_url[:100]},
                        )

                    raise Pay52ImageError(
                        f"52pay image: в ответе нет url или b64_json: {r.text[:200]}",
                        context={"provider_code": 500, "response": r.text[:200]},
                    )

                logger.warning(
                    "pay52_image: попытка с ключом {}/{} status={} ответ={}",
                    key_idx + 1,
                    len(keys),
                    r.status_code,
                    r.text[:250],
                )
                last_error = Pay52ImageError(
                    f"52pay image ({r.status_code}): {r.text[:300]}",
                    context={"provider_code": r.status_code, "response": r.text[:300]},
                )
        except Exception as e:
            logger.warning("pay52_image: ошибка попытки {}/{} ({}): {}", key_idx + 1, len(keys), type(e).__name__, e)
            last_error = e

    if last_error:
        if isinstance(last_error, Pay52ImageError):
            raise last_error
        raise Pay52ImageError(f"52pay image: все попытки завершились ошибкой: {last_error}") from last_error

    raise Pay52ImageError("52pay image: генерация не удалась")
