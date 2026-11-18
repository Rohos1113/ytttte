"""Per-model media backend: Outsee vs kie Kling vs kie image.

Глобальные IMAGE_PROVIDER / VIDEO_PROVIDER остаются дефолтом для прочих
моделей. Жёстко:

- GPT Image 2 / Nano Banana 2 → OUTSEE_API_KEY
- Veo 3.1 Lite → OUTSEE_API_KEY
- Kling 2.6 → KIE_API_KEY
- Flux 2 Pro / Seedream 5 Pro / Z-Image / Qwen Image 3 → KIE_API_KEY

Одна поправка к первой строке (2026-11-16): если задан
`PAY52_GPT_IMAGE_KEY`, GPT Image 2 идёт через 52pay
(app/bots/pay52_images.py), потому что outsee.io с рабочей машины перестал
отвечать — TLS handshake timeout и напрямую, и через socks. Приоритет
pay52 выше outsee: иначе живой ключ 52pay не использовался бы вовсе.
"""

from __future__ import annotations

from app.settings import settings

# После нормализации (_ → -) и алиасов.
OUTSEE_IMAGE_IDS = frozenset(
    {
        "gpt-image-2",
        "nano-banana-2",
        "nano-banana-2-lite",
        "gpt-image-1.5",
    }
)
# Модели шлюза vibecode (картинки идут через app/bots/vibecode_images.py).
VIBECODE_IMAGE_IDS = frozenset(
    {
        "gpt-image-2.5",
    }
)
# Модели картинок kie.ai Market (app/bots/kie_http.py generate_kie_image).
KIE_IMAGE_IDS = frozenset(
    {
        "flux-2-pro",
        "seedream-5-pro",
        "qwen3-image",
    }
)
# Модели, которые 52pay отдаёт как GPT Image 2 (app/bots/pay52_images.py).
PAY52_IMAGE_IDS = frozenset(
    {
        "gpt-image-2",
        "gpt-image-2-vip",
        "gpt-image-1.5",
    }
)
OUTSEE_VIDEO_IDS = frozenset(
    {
        "veo-3-1-lite",
    }
)
KIE_VIDEO_IDS = frozenset(
    {
        "kling-2-6",
        "seedance-2-0-mini",
        "seedance-2-5",
        "seedance-1-5-pro",
        "kling-3-0",
        "kling-v3-turbo-i2v",
        "kling-v3-turbo-t2v",
        "hailuo-2-3-i2v",
        "wan-2-7-i2v",
        "wan-2-7-t2v",
    }
)

# Старый Slow и studio-id → канонический slug.
_ALIASES = {
    "gpt-image-2": "gpt-image-2",
    "gpt-image-2-vip": "gpt-image-2",
    "nano-banana-2": "nano-banana-2",
    "nano-banana-2-lite": "nano-banana-2-lite",
    "veo-3-1-lite": "veo-3-1-lite",
    "veo-3-1-fast": "veo-3-1-lite",
    "kling-2-6": "kling-2-6",
}


def canonical_media_id(raw: str | None) -> str:
    s = (raw or "").strip().lower().replace("_", "-")
    if not s:
        return ""
    return _ALIASES.get(s, s)


def is_nano_banana_pro(model_slug: str | None) -> bool:
    """Любой slug Nano Banana Pro (pro / vt / cl / vip / 4k-vip)."""
    cid = canonical_media_id(model_slug)
    return cid == "nano-banana-pro" or cid.startswith("nano-banana-pro-")


def image_provider_for(model_slug: str | None) -> str:
    cid = canonical_media_id(model_slug)
    if cid in PAY52_IMAGE_IDS and (getattr(settings, "pay52_gpt_image_key", "") or "").strip():
        return "pay52"
    if cid in KIE_IMAGE_IDS:
        return "kie"
    if cid in OUTSEE_IMAGE_IDS:
        return "outsee"
    if cid in VIBECODE_IMAGE_IDS:
        return "vibecode"
    return (getattr(settings, "image_provider", None) or "outsee").strip().lower() or "outsee"


def video_provider_for(model_slug: str | None) -> str:
    cid = canonical_media_id(model_slug)
    if cid in KIE_VIDEO_IDS:
        return "kie"
    if cid in OUTSEE_VIDEO_IDS:
        return "outsee"
    return (getattr(settings, "video_provider", None) or "outsee").strip().lower() or "outsee"
