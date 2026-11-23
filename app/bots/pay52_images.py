"""Картинки через 52pay (OpenAI-совместимый /images/generations).

Зачем: outsee.io с этой машины не отвечает (TLS handshake timeout в любом
плече, напрямую и через socks), а ключ 52pay на GPT Image 2 работает.
Модели `gpt-image-2` / `gpt-image-2-vip` уходят сюда, если задан
`PAY52_GPT_IMAGE_KEY` (см. app/services/media_route.py).

Ответ шлюза приходит с `b64_json`; есть ветка на `url`. Живая проверка
2026-11-16: POST /v1/images/generations model=gpt-image-2 → 200 за ~53 с.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

from app.bots.outsee import GenerationResult
from app.settings import settings

_GENERATE_PATH = "/images/generations"
_EDIT_PATH = "/images/edits"

# gpt-image-2 принимает только эти три размера.
_SIZES = ("1024x1024", "1536x1024", "1024x1536")

#: Seedream на 52pay: свой ключ (``PAY52_SEEDREAM_KEY``), тот же
#: OpenAI-совместимый ``/images/generations``, но id модели другой — шлюз
#: отдаёт семейство ``doubao-seedream-*``. Живая проверка 2026-11-20:
#: ``doubao-seedream-5.0-flash``, размеры 1024x1024 и 1024x1536 → 200.
_SEEDREAM_API_MODELS: dict[str, str] = {
    "seedream-5-pro": "doubao-seedream-5.0-pro",
    "seedream-5-lite": "doubao-seedream-5.0-flash",
    "seedream-4-0": "doubao-seedream-4.0",
}

# Шлюз 52pay режет промты китайской модерацией («提示词包含违规内容»). Один
# повтор со смягчёнными формулировками дешевле, чем падение всей волны героев:
# персонаж и так рисуется по описанию внешности, а не по сцене боя.
_SOFTEN = {
    "кровь": "тёмное пятно на ткани",
    "кровав": "тёмное пятно на ткани",
    "ранен": "уставший",
    "шрам": "след от старой царапины",
    "оружие": "снаряжение",
    "меч": "снаряжение",
    "нож": "инструмент",
    "убийств": "столкновение",
    "труп": "фигура в тени",
    "бой": "столкновение",
    "битв": "столкновение",
    "война": "конфликт",
    "стрел": "движение",
}
_SAFE_PREFIX = (
    "Безопасная иллюстрация персонажа для книги: поясной портрет, нейтральный фон, "
    "никакой крови, оружия и сцен насилия. "
)


def soften_prompt_for_moderation(text: str) -> str:
    """Снять слова, на которых шлюз включает модерацию, и добавить рамку."""
    out = (text or "").strip()
    low = out.lower()
    changed = False
    for bad, safe in _SOFTEN.items():
        idx = low.find(bad)
        while idx >= 0:
            out = out[:idx] + safe + out[idx + len(bad) :]
            low = out.lower()
            idx = low.find(bad, idx + len(safe))
            changed = True
    if not changed:
        return _SAFE_PREFIX + out
    return _SAFE_PREFIX + out



def _slug(model_slug: str | None) -> str:
    return (model_slug or "").strip().lower().replace("_", "-")


#: Каталожный slug → id модели шлюза для семейства GPT Image 2.
#: Владелец 2026-11-21: картинки должны генерироваться моделью ``gpt-image-2-4k``
#: на том же ключе и том же API. Проверено ``GET /v1/models`` (21.11.2026):
#: шлюз отдаёт ``gpt-image-2``, ``gpt-image-2-4k``, ``gpt-image-2.5``,
#: ``gpt-image-2.5-flare``, ``gpt-image-2-5``.
_GPT_IMAGE_API_MODELS: dict[str, str] = {
    "gpt-image-2": "gpt-image-2-4k",
    "gpt-image-2-vip": "gpt-image-2-4k",
}


def api_model_for(model_slug: str | None) -> str:
    """Slug каталога → id модели шлюза.

    Seedream у 52pay зовётся ``doubao-*``, а GPT Image 2 уходит как
    ``gpt-image-2-4k`` (картинки в 4K). Остальные slug идут как есть.
    """
    slug = _slug(model_slug)
    return (
        _SEEDREAM_API_MODELS.get(slug)
        or _GPT_IMAGE_API_MODELS.get(slug)
        or (model_slug or "gpt-image-2-4k").strip()
    )


def seedream_configured() -> bool:
    """Есть ли ключ 52pay под Seedream (отдельный от GPT Image 2)."""
    return bool((getattr(settings, "pay52_seedream_key", "") or "").strip())


def pay52_images_configured() -> bool:
    return bool((settings.pay52_gpt_image_key or "").strip()) or seedream_configured()


def _key_for(model_slug: str | None) -> str:
    """Ключ под конкретную модель: Seedream — свой, остальное — GPT Image 2."""
    if _slug(model_slug) in _SEEDREAM_API_MODELS:
        key = (getattr(settings, "pay52_seedream_key", "") or "").strip()
        if key:
            return key
    return (settings.pay52_gpt_image_key or "").strip()


def _base_url() -> str:
    return (settings.pay52_base_url or "https://api.52pay.com/v1").strip().rstrip("/")


def _headers(*, model_slug: str | None = None, multipart: bool = False) -> dict[str, str]:
    key = _key_for(model_slug)
    if not key:
        raise ValueError(
            "нет ключа 52pay для картинки: задай PAY52_SEEDREAM_KEY (Seedream) "
            "или PAY52_GPT_IMAGE_KEY (GPT Image 2) в .env"
        )
    if multipart:
        return {"Authorization": f"Bearer {key}"}
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def native_aspect(aspect_ratio: str | None) -> str:
    """Ближайший аспект, который gpt-image-2 реально умеет.

    16:9/9:16 у модели нет — только 1:1, 3:2 и 2:3. Настройка обязана это
    учитывать: приёмка кадра сверяет пропорцию PNG с выбранным аспектом, и
    «16:9» на выходе 3:2 не пройдёт (aspect_mismatch). Поэтому аспект
    приводим к нативному на входе, а не режем картинку после генерации.
    """
    ratio = _ratio(aspect_ratio)
    if ratio is None:
        return "3:2"
    options = (("1:1", 1.0), ("3:2", 1.5), ("2:3", 1 / 1.5))
    best = min(options, key=lambda item: abs(item[1] - ratio))
    return best[0]


def size_for_aspect(aspect_ratio: str | None, *, default: str = "1536x1024") -> str:
    """Нативный аспект → размер из списка gpt-image-2."""
    ar = native_aspect(aspect_ratio)
    if ar == "1:1":
        return "1024x1024"
    if ar == "2:3":
        return "1024x1536"
    if ar == "3:2":
        return "1536x1024"
    return default


async def generate_image(
    prompt: str,
    out_path: Path,
    *,
    model_slug: str = "gpt-image-2",
    aspect_ratio: str = "16:9",
    size: str | None = None,
    quality: str | None = None,
    reference_images: list[Path] | None = None,
    timeout: float = 600.0,
    project_id: int | None = None,
    gen_id: str | None = None,
    **_unused: Any,
) -> GenerationResult:
    """Одна картинка: generations (или edits с референсом) → b64/url → файл.

    Референс нужен вариантам персонажа (c09/c11 — «тот же человек в другой
    одежде»): шлюз без картинки отвечает 400 «请重新上传角色参考图».
    """
    payload_size = size if size in _SIZES else size_for_aspect(aspect_ratio)
    refs = [Path(p) for p in (reference_images or []) if p is not None]
    refs = [p for p in refs if p.is_file()]
    raw, raw_url = await _post_once(
        prompt=prompt,
        payload_size=payload_size,
        model_slug=model_slug,
        quality=quality,
        refs=refs,
        timeout=timeout,
    )
    if len(raw) < 32:
        # шлюз ответил 400 по модерации — один повтор со смягчённым текстом
        soft = soften_prompt_for_moderation(prompt)
        if soft.strip() != prompt.strip():
            logger.warning(
                "pay52 images: модерация отбила промт {} — повтор со смягчённым",
                out_path.name,
            )
            raw, raw_url = await _post_once(
                prompt=soft,
                payload_size=payload_size,
                model_slug=model_slug,
                quality=quality,
                refs=refs,
                timeout=timeout,
            )
    if len(raw) < 32:
        raise RuntimeError("pay52 images: пустая картинка в ответе")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(raw)
    logger.info(
        "pay52 images: ok {} {} refs={} → {} ({} bytes) project={}",
        model_slug,
        payload_size,
        len(refs),
        out_path.name,
        len(raw),
        project_id,
    )
    return GenerationResult(file_path=out_path, gen_id=gen_id, raw_url=raw_url)


def _ratio(text: str | None) -> float | None:
    s = (text or "").strip().replace("_", ":").replace("x", ":").replace("х", ":")
    if ":" not in s:
        return None
    try:
        w_s, h_s = s.split(":", 1)
        w, h = float(w_s), float(h_s)
    except (ValueError, TypeError):
        return None
    if w <= 0 or h <= 0:
        return None
    return w / h


def fit_aspect(raw: bytes, aspect_ratio: str | None, *, tolerance: float = 0.02) -> bytes:
    """Подрезать картинку по центру до запрошенного аспекта (если расходится)."""
    target = _ratio(aspect_ratio)
    if target is None:
        return raw
    try:
        from io import BytesIO

        from PIL import Image

        im = Image.open(BytesIO(raw))
        w, h = im.size
        if w <= 0 or h <= 0:
            return raw
        cur = w / h
        if abs(cur - target) / target <= tolerance:
            return raw
        if cur > target:
            new_w = max(1, round(h * target))
            left = (w - new_w) // 2
            im = im.crop((left, 0, left + new_w, h))
        else:
            new_h = max(1, round(w / target))
            top = (h - new_h) // 2
            im = im.crop((0, top, w, top + new_h))
        buf = BytesIO()
        im.save(buf, format="PNG")
        logger.info(
            "pay52 images: кроп {}x{} → {}x{} под аспект {}",
            w,
            h,
            im.size[0],
            im.size[1],
            aspect_ratio,
        )
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        logger.debug("pay52 images: кроп под аспект не удался", exc_info=True)
        return raw


async def _post_once(
    *,
    prompt: str,
    payload_size: str,
    model_slug: str,
    quality: str | None,
    refs: list[Path],
    timeout: float,
) -> tuple[bytes, str]:
    """Один запрос в шлюз. Пустые байты — отказ по модерации (повторят выше)."""
    model = api_model_for(model_slug)
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        if refs:
            files = [
                ("image[]", (p.name or "ref.png", p.read_bytes(), "image/png")) for p in refs
            ]
            data: dict[str, Any] = {
                "model": model,
                "prompt": prompt,
                "size": payload_size,
                "n": "1",
            }
            if quality:
                data["quality"] = quality
            r = await client.post(
                f"{_base_url()}{_EDIT_PATH}",
                headers=_headers(model_slug=model_slug, multipart=True),
                files=files,
                data=data,
            )
        else:
            body: dict[str, Any] = {
                "model": model,
                "prompt": prompt,
                "size": payload_size,
                "n": 1,
            }
            if quality:
                body["quality"] = quality
            r = await client.post(
                f"{_base_url()}{_GENERATE_PATH}",
                headers=_headers(model_slug=model_slug),
                json=body,
            )
    if r.status_code >= 400:
        text = r.text or ""
        if "违规内容" in text:
            logger.warning("pay52 images: модерация промта (HTTP 400), текст смягчу")
            return b"", ""
        raise RuntimeError(f"pay52 images HTTP {r.status_code}: {text[:300]}")
    try:
        payload = r.json()
    except Exception:  # noqa: BLE001
        raise RuntimeError("pay52 images: не-JSON ответ шлюза") from None
    items = payload.get("data") if isinstance(payload, dict) else None
    first = items[0] if isinstance(items, list) and items else {}
    first = first if isinstance(first, dict) else {}
    b64 = first.get("b64_json")
    if isinstance(b64, str) and b64.strip():
        return base64.b64decode(b64), ""
    raw_url = str(first.get("url") or "").strip()
    if not raw_url.startswith("http"):
        raise RuntimeError(f"pay52 images: нет ни b64_json, ни URL ({str(payload)[:200]})")
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=False) as client:
        dl = await client.get(raw_url)
    if dl.status_code >= 400 or len(dl.content or b"") < 32:
        raise RuntimeError(f"pay52 images download HTTP {dl.status_code}")
    return dl.content or b"", raw_url
