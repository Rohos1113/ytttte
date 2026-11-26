"""Каталог моделей kie.ai для вкладки «Генерация» (индивидуальная генерация).

Источники (20.08.2026):
  - параметры: OpenAPI-спеки docs.kie.ai (market/*, veo3-api, suno-api, runway-api)
  - цены: страницы моделей kie.ai (pricingDesc) — кредиты и $.
Курс kie: 1 кредит = $0.005 (kie.ai/dashboard/billing).

Структура модели:
  id, label, category, desc, api ("jobs" | "veo" | "suno" | "runway"),
  model (для jobs — поле model), endpoint (для suno/runway/veo),
  result ("video" | "image" | "audio"), fields[], pricing{}.

Field: name, label, kind, required, default, options[{id,label}], min, max,
  step, max_items, accept, desc, show_if {field: value}.
kind: text | textarea | select | toggle | number | images | videos | audios |
  dialogue (строки «голос | текст»).

pricing: unit = gen | sec | 1k_chars; rules — первое совпадение по when
(точное сравнение; спец-ключи _has_images/_has_videos — по файловым полям);
default — fallback кредитов; note — текстовая расшифровка с kie.ai.
"""

from __future__ import annotations

import contextlib
import math
import re
from typing import Any

from app.services.kie_catalog_families import FAMILIES

CREDIT_USD = 0.005  # 1 кредит kie.ai = $0.005
MARKUP = 1.25  # наценка студии: usd_client = usd_kie × 1.25

CATEGORIES: list[dict[str, str]] = [
    {"id": "video", "label": "Видео"},
    {"id": "image", "label": "Картинки"},
    {"id": "music", "label": "Музыка (Suno)"},
    {"id": "sound", "label": "Звуки"},
    {"id": "voice", "label": "Голос / TTS"},
    {"id": "tools", "label": "Апскейл и утилиты"},
]

_ASPECT_VIDEO = ["16:9", "9:16", "1:1"]
_ASPECT_WIDE = ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "adaptive"]
_ASPECT_IMG = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"]
_RES_IMG = ["1K", "2K", "4K"]


def _f(
    name: str,
    label: str,
    kind: str,
    *,
    required: bool = False,
    default: Any = None,
    options: list[str] | None = None,
    min: float | None = None,  # noqa: A002
    max: float | None = None,  # noqa: A002
    step: float | None = None,
    max_items: int | None = None,
    desc: str = "",
    show_if: dict[str, Any] | None = None,
    max_len: int | None = None,
    omit_values: list[Any] | None = None,
    omit_from_payload: bool = False,
) -> dict[str, Any]:
    f: dict[str, Any] = {
        "name": name,
        "label": label,
        "kind": kind,
        "required": required,
        "desc": desc,
    }
    if default is not None:
        f["default"] = default
    if options:
        f["options"] = options
    if min is not None:
        f["min"] = min
    if max is not None:
        f["max"] = max
    if step is not None:
        f["step"] = step
    if max_items is not None:
        f["max_items"] = max_items
    if show_if:
        f["show_if"] = show_if
    if max_len is not None:
        f["max_len"] = max_len
    if omit_values:
        f["omit_values"] = list(omit_values)
    if omit_from_payload:
        f["omit_from_payload"] = True
    return f


def _prompt(label: str = "Промпт", **kw: Any) -> dict[str, Any]:
    kw.setdefault("required", True)
    return _f("prompt", label, "textarea", **kw)


def _duration(def_: float = 5, min_: float = 1, max_: float = 15, **kw: Any) -> dict[str, Any]:
    return _f(
        "duration",
        "Длительность, сек",
        "number",
        default=def_,
        min=min_,
        max=max_,
        step=1,
        **kw,
    )


def _aspect(opts: list[str] | None = None, def_: str = "16:9") -> dict[str, Any]:
    return _f("aspect_ratio", "Соотношение сторон", "select", options=opts or _ASPECT_VIDEO, default=def_)


def _res(opts: list[str], def_: str) -> dict[str, Any]:
    return _f("resolution", "Разрешение", "select", options=opts, default=def_)


def _audio_toggle(def_: bool = False) -> dict[str, Any]:
    return _f("generate_audio", "Генерировать звук", "toggle", default=def_)


def _seed() -> dict[str, Any]:
    return _f("seed", "Seed (0 — случайно)", "number", min=0, max=2147483647, step=1)


MODELS: list[dict[str, Any]] = [
    # ============================ ВИДЕО ============================
    {
        "id": "veo-3-1",
        "is_top": True,
        "label": "Google Veo 3.1",
        "category": "video",
        "api": "veo",
        "endpoint": "/api/v1/veo/generate",
        "result": "video",
        "desc": "Флагман Google: кинематографичный свет, реалистичная физика, мягкий кино-пролёт камеры.",
        "fields": [
            _prompt(),
            _f(
                "model",
                "Режим",
                "select",
                options=["veo3_lite", "veo3_fast", "veo3"],
                default="veo3_lite",
                desc="Lite — дешево/массово, Fast — баланс, Quality — максимум",
            ),
            _f(
                "generationType",
                "Тип генерации",
                "select",
                options=["TEXT_2_VIDEO", "FIRST_AND_LAST_FRAMES_2_VIDEO", "REFERENCE_2_VIDEO"],
                default="TEXT_2_VIDEO",
                desc="REFERENCE — только Fast/Lite, 1–3 референс-картинки, 8 сек",
            ),
            _aspect(["16:9", "9:16", "Auto"], "16:9"),
            _res(["720p", "1080p", "4k"], "720p"),
            _f("duration", "Длительность, сек", "select", options=["4", "6", "8"], default="8"),
            _f(
                "imageUrls",
                "Кадры/референсы",
                "images",
                max_items=3,
                desc="1 кадр — оживление; 2 — первый+последний; 1–3 — референсы (REFERENCE_2_VIDEO)",
            ),
            _f("watermark", "Вотермарка (текст)", "text"),
            _f("enableTranslation", "Переводить промпт на англ.", "toggle", default=True),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"model": "veo3_lite", "resolution": "720p"}, "credits": 30},
                {"when": {"model": "veo3_lite", "resolution": "1080p"}, "credits": 35},
                {"when": {"model": "veo3_lite", "resolution": "4k"}, "credits": 150},
                {"when": {"model": "veo3_fast", "resolution": "720p"}, "credits": 60},
                {"when": {"model": "veo3_fast", "resolution": "1080p"}, "credits": 65},
                {"when": {"model": "veo3_fast", "resolution": "4k"}, "credits": 180},
                {"when": {"model": "veo3", "resolution": "720p"}, "credits": 250},
                {"when": {"model": "veo3", "resolution": "1080p"}, "credits": 255},
                {"when": {"model": "veo3", "resolution": "4k"}, "credits": 370},
            ],
            "default": 60,
            "note": "за видео: Lite 30/35/150, Fast 60/65/180, Quality 250/255/370 кр (720p/1080p/4K)",
        },
    },
    {
        "id": "seedance-2-5",
        "is_top": True,
        "label": "Seedance 2.5 (ByteDance)",
        "category": "video",
        "api": "jobs",
        "model": "bytedance/seedance-2-5",
        "result": "video",
        "desc": "Топовый флагман ByteDance: многоплановые пролёты, сложные взаимодействия, до 30 сек.",
        "fields": [
            _prompt(),
            _f("first_frame_url", "Первый кадр", "images", max_items=1),
            _f(
                "last_frame_url",
                "Последний кадр",
                "images",
                max_items=1,
                desc="Только вместе с первым кадром",
            ),
            _f(
                "reference_image_urls",
                "Референс-картинки",
                "images",
                max_items=30,
                desc="Несовместимо с первым/последним кадром",
            ),
            _f(
                "reference_video_urls",
                "Референс-видео",
                "videos",
                max_items=10,
                desc="480p/720p, 2–30 сек каждое, суммарно ≤30 сек",
            ),
            _f(
                "reference_audio_urls",
                "Референс-аудио",
                "audios",
                max_items=10,
                desc="wav/mp3, 2–30 сек каждое",
            ),
            _res(["480p", "720p", "1080p"], "720p"),
            _aspect(_ASPECT_WIDE, "adaptive"),
            _duration(5, 4, 30, desc="-1 — автоматический выбор длительности"),
            _audio_toggle(True),
            _f("return_last_frame", "Вернуть последний кадр", "toggle", default=False),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "480p", "_has_videos": True}, "credits": 17},
                {"when": {"resolution": "480p"}, "credits": 28},
                {"when": {"resolution": "720p", "_has_videos": True}, "credits": 38},
                {"when": {"resolution": "720p"}, "credits": 63},
                {"when": {"resolution": "1080p", "_has_videos": True}, "credits": 68.5},
                {"when": {"resolution": "1080p"}, "credits": 114},
            ],
            "default": 63,
            "note": "кр/сек: с видеовходом дешевле (17/38/68.5), без — 28/63/114 (480p/720p/1080p)",
        },
    },
    {
        "id": "seedance-2-0",
        "label": "Seedance 2.0",
        "category": "video",
        "api": "jobs",
        "model": "bytedance/seedance-2",
        "result": "video",
        "desc": "До 15 сек, до 4K, референсы (9 картинок / 3 видео / 3 аудио), веб-поиск.",
        "fields": [
            _prompt(),
            _f("first_frame_url", "Первый кадр", "images", max_items=1),
            _f("last_frame_url", "Последний кадр", "images", max_items=1),
            _f("reference_image_urls", "Референс-картинки", "images", max_items=9),
            _f("reference_video_urls", "Референс-видео", "videos", max_items=3),
            _f("reference_audio_urls", "Референс-аудио", "audios", max_items=3),
            _res(["480p", "720p", "1080p", "4k"], "720p"),
            _aspect(_ASPECT_WIDE, "16:9"),
            _duration(5, 4, 15),
            _audio_toggle(True),
            _f("return_last_frame", "Вернуть последний кадр", "toggle", default=False),
            _f("web_search", "Веб-поиск", "toggle", default=False),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "480p", "_has_videos": True}, "credits": 11.5},
                {"when": {"resolution": "480p"}, "credits": 19},
                {"when": {"resolution": "720p", "_has_videos": True}, "credits": 25},
                {"when": {"resolution": "720p"}, "credits": 41},
                {"when": {"resolution": "1080p", "_has_videos": True}, "credits": 62},
                {"when": {"resolution": "1080p"}, "credits": 102},
                {"when": {"resolution": "4k", "_has_videos": True}, "credits": 128},
                {"when": {"resolution": "4k"}, "credits": 208},
            ],
            "default": 41,
            "note": "кр/сек: 480p 11.5/19, 720p 25/41, 1080p 62/102, 4K 128/208 (с видео/без)",
        },
    },
    {
        "id": "seedance-2-0-fast",
        "label": "Seedance 2.0 Fast",
        "category": "video",
        "api": "jobs",
        "model": "bytedance/seedance-2-fast",
        "result": "video",
        "desc": "Быстрый и дешёвый Seedance 2.0 для черновиков.",
        "fields": [
            _prompt(),
            _f("first_frame_url", "Первый кадр", "images", max_items=1),
            _f("last_frame_url", "Последний кадр", "images", max_items=1),
            _f("reference_image_urls", "Референс-картинки", "images", max_items=9),
            _f("reference_video_urls", "Референс-видео", "videos", max_items=3),
            _f("reference_audio_urls", "Референс-аудио", "audios", max_items=3),
            _res(["480p", "720p"], "720p"),
            _aspect(_ASPECT_WIDE, "16:9"),
            _duration(5, 4, 15),
            _audio_toggle(True),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "480p", "_has_videos": True}, "credits": 6.8},
                {"when": {"resolution": "480p"}, "credits": 11.7},
                {"when": {"resolution": "720p", "_has_videos": True}, "credits": 15},
                {"when": {"resolution": "720p"}, "credits": 24.8},
            ],
            "default": 24.8,
            "note": "кр/сек: 480p 6.8/11.7, 720p 15/24.8 (с видео/без)",
        },
    },
    {
        "id": "seedance-2-0-mini",
        "is_top": True,
        "label": "Seedance 2.0 Mini",
        "category": "video",
        "api": "jobs",
        "model": "bytedance/seedance-2-mini",
        "result": "video",
        "desc": "Самый дешёвый Seedance от ByteDance — массовые черновики (от 3.8 кр/сек). Отклоняет фото реальных лиц. Аудио только с фото/видео.",
        "fields": [
            _prompt(),
            _f("first_frame_url", "Первый кадр", "images", max_items=1),
            _f("last_frame_url", "Последний кадр", "images", max_items=1),
            _f("reference_image_urls", "Референс-картинки", "images", max_items=9),
            _f("reference_video_urls", "Референс-видео", "videos", max_items=3),
            _res(["480p", "720p"], "720p"),
            _aspect(_ASPECT_WIDE, "16:9"),
            _duration(5, 4, 15),
            _audio_toggle(True),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "480p", "_has_videos": True}, "credits": 2.4},
                {"when": {"resolution": "480p"}, "credits": 3.8},
                {"when": {"resolution": "720p", "_has_videos": True}, "credits": 5},
                {"when": {"resolution": "720p"}, "credits": 8.2},
            ],
            "default": 8.2,
            "note": "кр/сек: 480p 2.4/3.8, 720p 5/8.2 (с видео/без)",
        },
    },
    {
        "id": "kling-3-0",
        "is_top": True,
        "label": "Kling 3.0 Pro (1080p + звук)",
        "category": "video",
        "api": "jobs",
        "model": "kling-3.0/video",
        "result": "video",
        "desc": "Премиум качество Full HD 1080p с автогенерацией звуковых эффектов и мульти-планов.",
        "fields": [
            _prompt(),
            _f(
                "mode",
                "Режим",
                "select",
                options=["std", "pro", "4K"],
                default="std",
                desc="std=720p, pro=1080p, 4K=2160p",
            ),
            _aspect(_ASPECT_VIDEO, "16:9"),
            _duration(5, 3, 15),
            _f("sound", "Звуковые эффекты", "toggle", default=False),
            _f("image_urls", "Первый/последний кадр", "images", max_items=2),
            _f(
                "multi_shots",
                "Мульти-шоты",
                "toggle",
                default=False,
                desc="Несколько планов в одном ролике (промпт разбей по планам)",
            ),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"mode": "std", "sound": True}, "credits": 20},
                {"when": {"mode": "std"}, "credits": 14},
                {"when": {"mode": "pro", "sound": True}, "credits": 27},
                {"when": {"mode": "pro"}, "credits": 18},
                {"when": {"mode": "4K"}, "credits": 67},
            ],
            "default": 14,
            "note": "кр/сек: std 14/20, pro 18/27, 4K 67 (без/со звуком)",
        },
    },
    {
        "id": "kling-v3-turbo-t2v",
        "is_top": True,
        "label": "Kling 3.0 Turbo (текст)",
        "category": "video",
        "api": "jobs",
        "model": "kling/v3-turbo-text-to-video",
        "result": "video",
        "desc": "Генерация за 1 минуту: сложные сцены, высокая детализация, непревзойдённая динамика.",
        "fields": [
            _prompt(),
            _duration(5, 3, 15),
            _aspect(_ASPECT_VIDEO, "16:9"),
            _res(["720p", "1080p"], "720p"),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "720p"}, "credits": 18},
                {"when": {"resolution": "1080p"}, "credits": 22.5},
            ],
            "default": 18,
            "note": "кр/сек: 720p 18, 1080p 22.5",
        },
    },
    {
        "id": "kling-v3-turbo-i2v",
        "is_top": True,
        "label": "Kling 3.0 Turbo (оживление фото)",
        "category": "video",
        "api": "jobs",
        "model": "kling/v3-turbo-image-to-video",
        "result": "video",
        "desc": "Мгновенное и естественное оживление фото и артов за 60 секунд.",
        "fields": [
            _prompt(),
            _f("image_urls", "Стартовый кадр", "images", max_items=1, required=True),
            _duration(5, 3, 15),
            _res(["720p", "1080p"], "720p"),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "720p"}, "credits": 18},
                {"when": {"resolution": "1080p"}, "credits": 22.5},
            ],
            "default": 18,
            "note": "кр/сек: 720p 18, 1080p 22.5",
        },
    },
    {
        "id": "kling-3-0-omni-t2v",
        "is_top": True,
        "label": "Kling 3.0 Omni (со звуком)",
        "category": "video",
        "api": "jobs",
        "model": "kling-3.0-omni/text-to-video",
        "result": "video",
        "desc": "Мульти-планы со встроенным синхронным звуком окружения (шум волн, шелест ветра).",
        "fields": [
            _prompt(),
            _f("audio", "Нативный звук", "toggle", default=False),
            _res(["720p", "1080p", "4k"], "720p"),
            _aspect(_ASPECT_VIDEO, "16:9"),
            _duration(5, 3, 15),
            _f("customize_multi_shots", "Свои мульти-шоты", "toggle", default=False),
            _f("prefer_multi_shots", "Умное планирование шотов", "toggle", default=False),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "720p", "audio": True}, "credits": 18},
                {"when": {"resolution": "720p"}, "credits": 14},
                {"when": {"resolution": "1080p", "audio": True}, "credits": 23},
                {"when": {"resolution": "1080p"}, "credits": 18},
                {"when": {"resolution": "4k"}, "credits": 67},
            ],
            "default": 14,
            "note": "кр/сек без/со звуком: 720p 14/18, 1080p 18/23, 4K 67",
        },
    },
    {
        "id": "kling-2-6",
        "label": "Kling 2.6",
        "category": "video",
        "api": "jobs",
        "model": "kling-2.6/text-to-video",
        "model_map_i2i": "kling-2.6/image-to-video",
        "result": "video",
        "desc": "Kling 2.6: генерация из текста или фото (Full HD 1080p), 5/10 сек.",
        "fields": [
            _prompt(),
            _f("image_urls", "Стартовый кадр / фото", "images", max_items=1, required=False),
            _aspect(_ASPECT_VIDEO, "16:9"),
            _f("duration", "Длительность, сек", "select", options=["5", "10"], default="5"),
            _f("sound", "Звук", "toggle", default=False),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"duration": "5", "sound": True}, "credits": 110},
                {"when": {"duration": "5"}, "credits": 55},
                {"when": {"duration": "10", "sound": True}, "credits": 220},
                {"when": {"duration": "10"}, "credits": 110},
            ],
            "default": 55,
            "note": "за ролик: 5с 55/110, 10с 110/220 кр (без/со звуком)",
        },
    },
    {
        "id": "kling-3-0-motion-control",
        "hint": "Картинка персонажа + видео с движением → персонаж повторяет движение из видео.",
        "label": "Kling 3.0 Motion Control",
        "category": "video",
        "api": "jobs",
        "model": "kling-3.0/motion-control",
        "result": "video",
        "desc": "Перенос движения из референс-видео на картинку.",
        "fields": [
            _prompt("Промпт (опционально)", required=False),
            _f("image_urls", "Картинка-персонаж", "images", max_items=1, required=True),
            _f("video_urls", "Видео-донор движения", "videos", max_items=1, required=True),
            _res(["720p", "1080p"], "720p"),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "720p"}, "credits": 20},
                {"when": {"resolution": "1080p"}, "credits": 27},
            ],
            "default": 20,
            "note": "кр/сек: 720p 20, 1080p 27",
        },
    },
    {
        "id": "hailuo-2-3-i2v",
        "is_top": True,
        "label": "MiniMax Hailuo 2.3 (фото)",
        "category": "video",
        "api": "jobs",
        "model": "hailuo/2-3-image-to-video-pro",
        "result": "video",
        "desc": "Непревзойдённая естественная органика и пластика движений человека при оживлении фото.",
        "fields": [
            _prompt(),
            _f("image_url", "Стартовый кадр", "images", max_items=1, required=True),
            _f("mode", "Тир", "select", options=["standard", "pro"], default="standard"),
            _f("duration", "Длительность, сек", "select", options=["6", "10"], default="6"),
            _res(["768P", "1080P"], "768P"),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"mode": "standard", "duration": "6", "resolution": "768P"}, "credits": 30},
                {"when": {"mode": "standard", "duration": "10", "resolution": "768P"}, "credits": 50},
                {"when": {"mode": "standard", "duration": "6", "resolution": "1080P"}, "credits": 50},
                {"when": {"mode": "pro", "duration": "6", "resolution": "768P"}, "credits": 45},
                {"when": {"mode": "pro", "duration": "10", "resolution": "768P"}, "credits": 90},
                {"when": {"mode": "pro", "duration": "6", "resolution": "1080P"}, "credits": 80},
            ],
            "default": 30,
            "note": "за ролик: std 30/50/50, pro 45/90/80 кр (6с 768 / 10с 768 / 6с 1080)",
        },
    },
    {
        "id": "minimax-h3-t2v",
        "label": "MiniMax H3 (текст)",
        "category": "video",
        "api": "jobs",
        "model": "minimax-h3/text-to-video",
        "result": "video",
        "desc": "Компактный видеопоток с четким выразительным стилем и разрешением до 2K.",
        "fields": [
            _prompt(),
            _aspect(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], "16:9"),
            _duration(6, 4, 15),
            _res(["768P", "2K"], "2K"),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"resolution": "768P"}, "credits": 16},
                {"when": {"resolution": "2K"}, "credits": 26},
            ],
            "default": 26,
            "note": "кр/сек: 768P 16, 2K 26; входные картинки свыше 5 — по 8 кр",
        },
    },
    # ============================ КАРТИНКИ ============================
    {
        "id": "nano-banana-2",
        "is_top": True,
        "label": "Nano Banana 2",
        "category": "image",
        "api": "jobs",
        "model": "nano-banana-2",
        "result": "image",
        "desc": "Google Gemini 3.1 Flash Image: быстро, точный текст, до 8 референсов.",
        "fields": [
            _prompt(),
            _f("image_input", "Референсы (до 8)", "images", max_items=8),
            _aspect(
                ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"], "auto"
            ),
            _res(_RES_IMG, "1K"),
            _f("output_format", "Формат", "select", options=["png", "jpg"], default="png"),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"resolution": "1K"}, "credits": 8},
                {"when": {"resolution": "2K"}, "credits": 12},
                {"when": {"resolution": "4K"}, "credits": 18},
            ],
            "default": 8,
            "note": "за картинку: 1K 8, 2K 12, 4K 18 кр",
        },
    },
    {
        "id": "gpt-image-2",
        "is_top": True,
        "label": "GPT Image 2",
        "category": "image",
        "api": "jobs",
        "model": "gpt-image-2-text-to-image",
        "model_map_i2i": "gpt-image-2-image-to-image",
        "result": "image",
        "desc": "OpenAI GPT Image 2: фотореализм, текст на картинке, до 4K.",
        "fields": [
            _prompt(),
            _f("image_urls", "Референсы (до 8)", "images", max_items=8),
            _aspect(_ASPECT_IMG, "auto"),
            _res(_RES_IMG, "1K"),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"resolution": "1K"}, "credits": 6},
                {"when": {"resolution": "2K"}, "credits": 10},
                {"when": {"resolution": "4K"}, "credits": 16},
            ],
            "default": 6,
            "note": "за картинку: 1K 6, 2K 10, 4K 16 кр",
        },
    },
    {
        "id": "nano-banana-2-lite",
        "label": "Nano Banana 2 Lite",
        "category": "image",
        "api": "jobs",
        "model": "nano-banana-2-lite",
        "result": "image",
        "desc": "Быстрый Nano Banana 2 — 1K черновики за 19 секунд.",
        "fields": [
            _prompt(),
            _f("image_input", "Референсы (до 8)", "images", max_items=8),
            _aspect(["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"], "auto"),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 4, "note": "4 кр/картинку (1K)"},
    },
    {
        "id": "seedream-5-pro",
        "is_top": True,
        "label": "ByteDance Seedream 5 Pro",
        "category": "image",
        "api": "jobs",
        "model": "seedream/5-pro-text-to-image",
        "model_map_i2i": "seedream/5-pro-image-to-image",
        "result": "image",
        "desc": "ByteDance Seedream 5 Pro: передовой флагман фотореализма, сложные сцены, до 6 референсов.",
        "fields": [
            _prompt(),
            _f("image_urls", "Референсы (до 6)", "images", max_items=6),
            _aspect(["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"], "1:1"),
            _f(
                "quality",
                "Разрешение",
                "select",
                options=["basic", "high"],
                default="basic",
                desc="basic=1K, high=2K",
            ),
            _f("output_format", "Формат", "select", options=["png", "jpeg"], default="png"),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"quality": "basic"}, "credits": 7},
                {"when": {"quality": "high"}, "credits": 14},
            ],
            "default": 7,
            "note": "за картинку: 1K 7, 2K 14 кр",
        },
    },
    {
        "id": "qwen3-image",
        "label": "Alibaba Qwen Image 3",
        "category": "image",
        "api": "jobs",
        "model": "qwen3/text-to-image",
        "model_map_i2i": "qwen3/image-to-image",
        "result": "image",
        "desc": "Alibaba Qwen Image 3: превосходная детализация, восточная эстетика, типографика и стилизация.",
        "fields": [
            _prompt(),
            _f("image_urls", "Референсы (до 4)", "images", max_items=4),
            _aspect(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], "1:1"),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 4.8, "note": "4.8 кр/картинку (1K/2K)"},
    },
    # ============================ МУЗЫКА (SUNO) ============================
    {
        "id": "suno-music",
        "hint": "Опиши трек («мрачный фонк, женский вокал») или в custom-режиме дай свой текст, стиль и название.",
        "label": "Suno — трек",
        "category": "music",
        "api": "suno",
        "endpoint": "/api/v1/generate",
        "result": "audio",
        "desc": "Полный трек по описанию: вокал или инструментал, модели V4…V5_5.",
        "fields": [
            _f("customMode", "Свой режим (стиль/текст/название)", "toggle", default=True),
            _f("model", "Модель", "select", options=["V5_5", "V5"], default="V5_5"),
            _prompt("Описание / текст песни", required=False),
            _f(
                "style",
                "Стиль",
                "text",
                show_if={"customMode": True},
                desc="например: dark phonk, female vocal, 120 bpm",
            ),
            _f("title", "Название", "text", show_if={"customMode": True}),
            _f("instrumental", "Без вокала", "toggle", default=False),
            _f("negativeTags", "Исключить стили", "text"),
            _f(
                "vocalGender",
                "Вокал",
                "select",
                options=["", "m", "f"],
                default="",
                show_if={"instrumental": False},
                desc="Любой, мужской или женский вокал",
            ),
            _f(
                "duration",
                "Длительность, сек (только V5_5)",
                "number",
                min=10,
                max=360,
                step=1,
                show_if={"model": "V5_5"},
            ),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 12, "note": "12 кр/трек (~$0.06)"},
    },
    {
        "id": "suno-extend",
        "hint": "Продлевает трек Suno: нужен audioId из прошлой генерации (виден в логах kie).",
        "label": "Suno — продлить трек",
        "category": "music",
        "api": "suno",
        "endpoint": "/api/v1/generate/extend",
        "result": "audio",
        "desc": "Продление существующего трека Suno по audioId.",
        "fields": [
            _f("audioId", "ID трека (audioId)", "text", required=True),
            _f("defaultParamFlag", "Свои параметры", "toggle", default=True),
            _prompt("Промпт продления", required=False),
            _f("style", "Стиль", "text"),
            _f("title", "Название", "text"),
            _f("continueAt", "Продлить с, сек", "number", min=0, step=0.1),
            _f("model", "Модель", "select", options=["V5_5", "V5"], default="V5_5"),
            _f("instrumental", "Без вокала", "toggle", default=False),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 12, "note": "12 кр/продление"},
    },
    {
        "id": "suno-upload-cover",
        "hint": "Твоё аудио → кавер в новом стиле. Загрузи файл, опиши стиль.",
        "label": "Suno — кавер на своё аудио",
        "category": "music",
        "api": "suno",
        "endpoint": "/api/v1/generate/upload-cover",
        "result": "audio",
        "desc": "Загружаешь аудио — Suno делает кавер в новом стиле.",
        "fields": [
            _f("uploadUrl", "Твое аудио", "audios", max_items=1, required=True),
            _f("customMode", "Свой режим", "toggle", default=True),
            _prompt("Промпт/стиль кавера"),
            _f("style", "Стиль", "text"),
            _f("title", "Название", "text"),
            _f("model", "Модель", "select", options=["V5_5", "V5"], default="V5_5"),
            _f("instrumental", "Без вокала", "toggle", default=False),
            _f("negativeTags", "Исключить стили", "text"),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 12, "note": "12 кр/кавер"},
    },
    {
        "id": "suno-add-vocals",
        "hint": "Инструментал + текст песни → трек с вокалом.",
        "label": "Suno — добавить вокал",
        "category": "music",
        "api": "suno",
        "endpoint": "/api/v1/generate/add-vocals",
        "result": "audio",
        "desc": "Добавляет вокал к инструментальной дорожке (uploadUrl).",
        "fields": [
            _f("uploadUrl", "Инструментал (аудио)", "audios", max_items=1, required=True),
            _prompt("Текст песни"),
            _f("style", "Стиль", "text"),
            _f("title", "Название", "text"),
            _f("model", "Модель", "select", options=["V5_5", "V5"], default="V5_5"),
            _f(
                "vocalGender",
                "Вокал",
                "select",
                options=["", "m", "f"],
                default="",
                desc="Любой, мужской или женский вокал",
            ),
            _f("negativeTags", "Исключить стили", "text"),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 12, "note": "12 кр/запрос"},
    },
    {
        "id": "suno-separate-vocals",
        "hint": "Трек → вокал и минус раздельно (или по инструментам).",
        "label": "Suno — разделить вокал/минус",
        "category": "music",
        "api": "suno",
        "endpoint": "/api/v1/vocal-removal/generate",
        "result": "audio",
        "desc": "Стем-сепарация: вокал/инструментал или по инструментам.",
        "fields": [
            _f("uploadUrl", "Трек (аудио)", "audios", max_items=1, required=True),
            _f(
                "type",
                "Тип разделения",
                "select",
                options=["separate_vocals", "split_stem", "advanced_split"],
                default="separate_vocals",
                desc="separate_vocals — вокал+минус; split_stem — мультистем; advanced_split — по stemName",
            ),
            _f(
                "stemName",
                "Инструмент (для advanced)",
                "text",
                show_if={"type": "advanced_split"},
                desc="например: drums, bass, piano",
            ),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"type": "separate_vocals"}, "credits": 10},
                {"when": {"type": "split_stem"}, "credits": 50},
                {"when": {"type": "advanced_split"}, "credits": 20},
            ],
            "default": 10,
            "note": "вокал/минус 10, мультистем 50, по инструменту 20 кр",
        },
    },
    {
        "id": "suno-lyrics",
        "hint": "Опиши тему → готовый текст песни для Suno.",
        "label": "Suno — текст песни",
        "category": "music",
        "api": "suno",
        "endpoint": "/api/v1/lyrics",
        "result": "text",
        "desc": "Генерация текста песни по описанию.",
        "fields": [
            _prompt("О чём песня"),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 0.4, "note": "0.4 кр/текст (~$0.002)"},
    },
    # ============================ ЗВУКИ ============================
    {
        "id": "elevenlabs-sfx",
        "hint": "kie отключил ElevenLabs SFX (500 Internal Error). Здесь Foley через Suno Sounds V5: «разбитое стекло», «whoosh» — без песни.",
        "label": "Звуковые эффекты",
        "category": "sound",
        "api": "suno",
        "endpoint": "/api/v1/generate/sounds",
        "result": "audio",
        "desc": "Foley/SFX через Suno Sounds Task (V5). kie больше не гоняет elevenlabs/sound-effect-v2.",
        "prompt_wrap": (
            "Foley sound effect only: {prompt}. "
            "No music, no melody, no singing, no vocals, no speech, no lyrics."
        ),
        "fields": [
            _prompt("Описание звука", max_len=400),
            _f("model", "Модель", "select", options=["V5"], default="V5"),
            _f("soundLoop", "Зациклить", "toggle", default=False),
            _f(
                "duration_seconds",
                "Длительность, сек (пусто — авто)",
                "number",
                min=0.5,
                max=22,
                step=0.1,
                omit_from_payload=True,
            ),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [],
            "default": 2.5,
            "note": "2.5 кр/звук (~$0.0125), Suno Sounds",
        },
    },
    {
        "id": "suno-sounds",
        "hint": "Suno Sounds — короткие музыкальные петли/атмосфера. Часто с вокалом. Для ударов/whoosh бери ElevenLabs SFX.",
        "label": "Suno — саундскейп (не Foley)",
        "category": "sound",
        "api": "suno",
        "endpoint": "/api/v1/generate/sounds",
        "result": "audio",
        "desc": "Suno Sounds Task (только V5): петли и атмосфера, не чистый SFX.",
        "fields": [
            _prompt("Описание атмосферы", max_len=500),
            _f(
                "model",
                "Модель",
                "select",
                options=["V5"],
                default="V5",
                desc="Sounds Task на kie принимает только V5; V5_5 — это песни",
            ),
            _f("soundLoop", "Зациклить", "toggle", default=False),
            _f("soundTempo", "Темп (BPM, пусто — авто)", "number", min=1, max=300, step=1),
            _f(
                "soundKey",
                "Тональность",
                "select",
                options=[
                    "Any",
                    "C",
                    "C#",
                    "D",
                    "D#",
                    "E",
                    "F",
                    "F#",
                    "G",
                    "G#",
                    "A",
                    "A#",
                    "B",
                    "Cm",
                    "C#m",
                    "Dm",
                    "D#m",
                    "Em",
                    "Fm",
                    "F#m",
                    "Gm",
                    "G#m",
                    "Am",
                    "A#m",
                    "Bm",
                ],
                default="Any",
                omit_values=["Any"],
            ),
        ],
        "pricing": {"unit": "gen", "rules": [], "default": 2.5, "note": "2.5 кр/клип (~$0.0125)"},
    },
    # ============================ ГОЛОС / TTS ============================
    {
        "id": "elevenlabs-v4",
        "hint": "Официальный ElevenLabs API: 200 русских голосов, собственные клоны и аудио-теги эмоций.",
        "label": "Озвучка ElevenLabs v4",
        "category": "voice",
        "api": "elevenlabs",
        "model": "eleven_v4",
        "endpoint": "/v1/text-to-speech",
        "result": "audio",
        "desc": "Сверхреалистичная озвучка ElevenLabs v4. Диапазон 1–10 000 символов, библиотека 200 русских голосов, теги настроения и пауз.",
        "fields": [
            _f(
                "text",
                "Текст озвучки",
                "textarea",
                required=True,
                max_len=10000,
                desc="Диапазон 1–10 000 символов. Поддерживает эмоциональные теги: [happy], [whisper], [sighs] и др.",
            ),
            _f(
                "voice_id",
                "Голос (Voice ID)",
                "text",
                default="ymDCYd8puC7gYjxIamPt",
                required=True,
                desc="20-значный ID голоса из библиотеки",
            ),
            _f("stability", "Стабильность (0–1)", "number", default=0.5, min=0.0, max=1.0, step=0.01),
            _f("similarity", "Схожесть (0–1)", "number", default=0.75, min=0.0, max=1.0, step=0.01),
        ],
        "pricing": {
            "unit": "1k_chars",
            "rules": [],
            "default": 3,
            "note": "3 кр за 1000 символов (~$0.015)",
        },
    },
    # ============================ АПСКЕЙЛ / УТИЛИТЫ ============================
    {
        "id": "topaz-video-upscale",
        "is_top": True,
        "hint": "Загрузите любое видео (720p/1080p) → выберите кратность → получите ролик в 2K или 4K с удалением артефактов.",
        "label": "Topaz Video AI (апскейл)",
        "category": "tools",
        "api": "jobs",
        "model": "topaz/video-upscale",
        "result": "video",
        "desc": "Нейросетевое увеличение разрешения в 2K/4K и устранение шума и артефактов сжатия.",
        "fields": [
            _f("video_url", "Видео", "videos", max_items=1, required=True),
            _f("upscale_factor", "Кратность", "select", options=["1", "2", "4"], default="2"),
        ],
        "pricing": {
            "unit": "sec",
            "rules": [
                {"when": {"upscale_factor": "4"}, "credits": 14},
                {"when": {"upscale_factor": "2"}, "credits": 8},
                {"when": {"upscale_factor": "1"}, "credits": 8},
            ],
            "default": 8,
            "note": "кр/сек исходника: ×1/×2 — 8, ×4 — 14",
        },
    },
    {
        "id": "topaz-image-upscale",
        "hint": "Картинка → та же картинка в 2K или 4K. Без промпта — только файл.",
        "label": "Topaz — апскейл картинки",
        "category": "tools",
        "api": "jobs",
        "model": "topaz/image-upscale",
        "result": "image",
        "desc": "Topaz: апскейл картинки до 2K/4K.",
        "fields": [
            _f("image_url", "Картинка", "images", max_items=1, required=True),
            _f("target", "Цель", "select", options=["2K", "4K"], default="2K"),
        ],
        "pricing": {
            "unit": "gen",
            "rules": [
                {"when": {"target": "2K"}, "credits": 10},
                {"when": {"target": "4K"}, "credits": 20},
            ],
            "default": 10,
            "note": "за картинку: ≤2K 10, 4K 20 кр",
        },
    },
]

_BY_ID: dict[str, dict[str, Any]] = {m["id"]: m for m in MODELS}

_MODEL_ALIASES: dict[str, str] = {
    "seedance-2-fast": "seedance-2-0-fast",
    "seedance-2.0-fast": "seedance-2-0-fast",
    "seedance-2-mini": "seedance-2-0-mini",
    "seedance-2": "seedance-2-0",
    "seedance-2.0-mini": "seedance-2-0-mini",
    "seedance-2.0-mini-ref": "seedance-2-0-mini",
    "seedance-2.5": "seedance-2-5",
    "kling-2-6-t2v": "kling-2-6",
    "kling-2-6-i2v": "kling-2-6",
    "kling-2.6": "kling-2-6",
}

_FILE_KINDS = {"images", "videos", "audios", "file"}


def get_model(model_id: str) -> dict[str, Any] | None:
    if model_id in _BY_ID:
        return _BY_ID[model_id]
    alias = _MODEL_ALIASES.get(model_id)
    if alias:
        return _BY_ID.get(alias)
    return None


def list_models(category: str | None = None) -> list[dict[str, Any]]:
    if not category:
        return list(MODELS)
    return [m for m in MODELS if m["category"] == category]


def defaults_for(spec: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in spec.get("fields") or []:
        if "default" in f:
            out[f["name"]] = f["default"]
    return out


def _is_unset(val: Any) -> bool:
    """«Поле не задано»: None или пустая строка — UI присылает так нетронутые поля."""
    return val is None or (isinstance(val, str) and not val.strip())


def normalize_values(spec: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    """Значения с дефолтами каталога (для прайсинга и валидации).

    Явный null/"" в values — это «пользователь не трогал поле», а не «сбросить
    значение»: берём дефолт режима, иначе null глушит when-условие цены.
    """
    merged = defaults_for(spec)
    for k, v in (values or {}).items():
        if _is_unset(v):
            continue
        merged[k] = v
    return merged


def _has_files(values: dict[str, Any], spec: dict[str, Any], kinds: set[str]) -> bool:
    for f in spec.get("fields") or []:
        if f.get("kind") not in kinds:
            continue
        v = values.get(f["name"])
        if isinstance(v, list) and v:
            return True
        if isinstance(v, str) and v.strip():
            return True
    return False


def _match(when: dict[str, Any], values: dict[str, Any], spec: dict[str, Any]) -> bool:
    for key, want in when.items():
        if key == "_has_images":
            if _has_files(values, spec, {"images"}) != bool(want):
                return False
            continue
        if key == "_has_videos":
            if _has_files(values, spec, {"videos"}) != bool(want):
                return False
            continue
        got = values.get(key)
        if isinstance(want, bool):
            truthy = got is True or str(got).strip().lower() in ("true", "1", "yes", "on")
            if truthy != want:
                return False
            continue
        if str(got) != str(want):
            return False
    return True


def estimate_credits(spec: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    """Динамическая цена: кредиты и $ по текущим настройкам."""
    pricing = spec.get("pricing") or {}
    merged = normalize_values(spec, values)
    credits: float | None = None
    for rule in pricing.get("rules") or []:
        if _match(rule.get("when") or {}, merged, spec):
            credits = float(rule["credits"])
            break
    if credits is None:
        default = pricing.get("default")
        credits = float(default) if default is not None else 0.0
    unit = pricing.get("unit") or "gen"
    total = credits
    multiplier = 1.0
    if unit == "sec":
        try:
            multiplier = float(merged.get("duration") or 5)
        except (TypeError, ValueError):
            multiplier = 5.0
        multiplier = max(1.0, multiplier)
        total = credits * multiplier
    elif unit == "1k_chars":
        text = str(merged.get("text") or merged.get("dialogue") or "")
        multiplier = max(1.0, math.ceil(len(text) / 1000))
        total = credits * multiplier
    return {
        "credits": round(total, 2),
        "usd": round(total * CREDIT_USD, 4),
        # клиентская цена с наценкой — для нового UI (старое поле "usd" не менялось)
        "usd_kie": round(total * CREDIT_USD, 6),
        "usd_client": round(total * CREDIT_USD * MARKUP, 4),
        "markup": MARKUP,
        "unit": unit,
        "unit_credits": credits,
        "unit_usd_kie": round(credits * CREDIT_USD, 6),
        "unit_usd_client": round(credits * CREDIT_USD * MARKUP, 4),
        "multiplier": multiplier,
        "note": pricing.get("note") or "",
    }


def validate_values(spec: dict[str, Any], values: dict[str, Any]) -> list[str]:
    """Проверки по схеме каталога → список ошибок (пусто = ок)."""
    errors: list[str] = []
    merged = normalize_values(spec, values)
    known = {f["name"] for f in spec.get("fields") or []}
    for f in spec.get("fields") or []:
        name = f["name"]
        v = merged.get(name)
        empty = v is None or (isinstance(v, str) and not v.strip()) or (isinstance(v, list) and not v)
        if f.get("required") and empty:
            errors.append(f"{f['label'] or name}: обязательное поле")
            continue
        if empty:
            continue
        kind = f.get("kind")
        if kind == "select" and f.get("options"):
            if str(v) not in [str(o) for o in f["options"]]:
                errors.append(f"{name}: значение {v!r} вне списка {f['options']}")
        elif kind == "number":
            try:
                num = float(str(v))
                if f.get("min") is not None and num < float(f["min"]):
                    errors.append(f"{name}: {num} < min {f['min']}")
                if f.get("max") is not None and num > float(f["max"]):
                    errors.append(f"{name}: {num} > max {f['max']}")
            except (TypeError, ValueError):
                errors.append(f"{name}: не число: {v!r}")
        elif kind in ("text", "textarea") and f.get("max_len"):
            if len(str(v)) > int(f["max_len"]):
                errors.append(f"{name}: {len(str(v))} символов > max {f['max_len']}")
        elif kind in _FILE_KINDS:
            items = v if isinstance(v, list) else [v]
            if f.get("max_items") and len(items) > int(f["max_items"]):
                errors.append(f"{name}: файлов {len(items)} > {f['max_items']}")
            for u in items:
                if not str(u).startswith(("http://", "https://", "asset://")):
                    errors.append(f"{name}: не URL: {str(u)[:60]!r}")
    if spec.get("category") == "video":
        def _has_val(key: str) -> bool:
            val = merged.get(key)
            if isinstance(val, list):
                return len(val) > 0
            if isinstance(val, str):
                return bool(val.strip())
            return False

        has_frames = any(
            _has_val(k)
            for k in ("first_frame_url", "last_frame_url", "first_frame", "last_frame")
        )
        has_refs = any(
            _has_val(k)
            for k in ("reference_image_urls", "reference_images")
        )
        if has_frames and has_refs:
            errors.append(
                "Видеомодели не поддерживают одновременное совмещение перехода по кадрам (старт/финиш) "
                "и референсов. Выберите один режим: либо только кадры, либо только референсы."
            )
    unknown = set((values or {}).keys()) - known
    if unknown:
        # неизвестные ключи не режем жёстко — вдруг поле каталога отстало
        pass
    return errors


def _legacy_resolve_model_id(spec: dict[str, Any], values: dict[str, Any]) -> str:
    """model с учётом model_map (variant→другой model id) и i2i-варианта."""
    merged = normalize_values(spec, values)
    mmap = spec.get("model_map") or {}
    for f in spec.get("fields") or []:
        val = merged.get(f["name"])
        if val is not None and str(val) in mmap:
            return mmap[str(val)]
    i2i = spec.get("model_map_i2i")
    if i2i and (_has_files(merged, spec, {"images"}) or bool(merged.get("first_frame_url"))):
        return i2i
    return spec.get("model") or ""


def build_payload(spec: dict[str, Any], values: dict[str, Any]) -> dict[str, Any]:
    """Тело запроса под тип API: jobs (model+input) или flat (veo/suno/runway)."""
    merged = normalize_values(spec, values)
    body: dict[str, Any] = {}
    fields = spec.get("fields")
    if not fields:
        body = {k: v for k, v in merged.items() if not _is_unset(v)}
    else:
        for f in fields:
            name = f["name"]
            v = merged.get(name)
            if v is None:
                continue
            omit = {str(x) for x in (f.get("omit_values") or [])}
            if str(v) in omit:
                continue
            if f.get("omit_from_payload"):
                continue
            kind = f.get("kind")
            if kind in _FILE_KINDS:
                items = v if isinstance(v, list) else [v]
                items = [str(u).strip() for u in items if str(u).strip()]
                if not items:
                    continue
                # одиночные поля (max_items=1) — строкой, если так в спеке
                if f.get("max_items") == 1 and name.endswith("_url"):
                    body[name] = items[0]
                else:
                    body[name] = items
                continue
            if kind == "toggle":
                body[name] = v is True or str(v).strip().lower() in ("true", "1", "yes", "on")
                continue
            if kind == "number":
                try:
                    num = float(v)
                    body[name] = int(num) if float(num).is_integer() else num
                except (TypeError, ValueError):
                    pass
                continue
            if kind == "dialogue":
                lines = [ln for ln in str(v).splitlines() if "|" in ln]
                dlg = []
                for ln in lines:
                    voice, _, text = ln.partition("|")
                    if text.strip():
                        dlg.append({"voice": voice.strip(), "text": text.strip()})
                if dlg:
                    body[name] = dlg
                continue
            if isinstance(v, str) and not v.strip():
                continue
            body[name] = v
    wrap = str(spec.get("prompt_wrap") or "")
    if wrap and "{prompt}" in wrap:
        key = "prompt" if "prompt" in body else ("text" if "text" in body else "")
        raw = str(body.get(key) or "").strip()
        if key and raw and "Foley sound effect only:" not in raw:
            extra = ""
            dur = merged.get("duration_seconds")
            if dur not in (None, ""):
                extra = f" Duration about {dur} seconds."
            body[key] = (wrap.format(prompt=raw) + extra)[:500]
    if spec.get("category") == "video":
        if spec.get("id") == "kling-2-6":
            img = body.get("image_urls") or body.get("first_frame_url") or body.get("first_frame")
            if img:
                urls = img if isinstance(img, list) else [img]
                body["image_urls"] = [str(u) for u in urls if str(u).strip()]
                body.pop("aspect_ratio", None)
                body.pop("first_frame_url", None)
                body.pop("first_frame", None)
            else:
                body.pop("image_urls", None)
        has_frames = bool(
            body.get("first_frame_url")
            or body.get("last_frame_url")
            or body.get("first_frame")
            or body.get("last_frame")
            or body.get("image_urls")
        )
        has_refs = bool(body.get("reference_image_urls") or body.get("reference_images"))
        if has_frames and has_refs:
            # Приоритет отдаётся кадрам — исключаем взаимоисключающие референсы
            body.pop("reference_image_urls", None)
            body.pop("reference_images", None)
    api = spec.get("api")
    if api == "pay52":
        from app.bots.pay52_video import build_pay52_video_payload

        return build_pay52_video_payload(spec, merged)
    if api == "jobs":
        resolved_model = _legacy_resolve_model_id(spec, merged)
        if "kling-3" in str(resolved_model).lower() or "kling-3" in str(spec.get("id", "")).lower():
            if "multi_shots" not in body:
                body["multi_shots"] = False
        return {"model": resolved_model, "input": body}
    if api in ("veo", "runway") and "duration" in body:
        # veo/runway ждут duration числом, даже если в UI это select
        with contextlib.suppress(TypeError, ValueError):
            body["duration"] = int(float(body["duration"]))
    if api == "suno":
        # Suno API 422: duration разрешён только при customMode=True и моделях V5_5/V6/V6_WILD
        if not body.get("customMode") and "duration" in body:
            body.pop("duration", None)
        elif "duration" in body:
            with contextlib.suppress(TypeError, ValueError):
                body["duration"] = int(float(body["duration"]))
    return body


# ==================== СЕМЬИ И РЕЖИМЫ (шаг 9) ====================
# FAMILIES генерируется scripts/gen_kie_families.py из docs/kie-model-families.json
# и docs/kie-prices-usd.json. У каждого режима pricing в ДОЛЛАРАХ:
# usd_client = usd_kie × MARKUP. Legacy-записи MODELS остаются как были
# (обратная совместимость старых id и аудио), семьи — надстройка над ними.

_ENDPOINT_BY_API: dict[str, str] = {
    "veo": "/api/v1/veo/generate",
    "runway": "/api/v1/runway/generate",
    "suno": "/api/v1/generate",
}

_AUDIO_CATEGORIES = ("music", "sound", "voice")


def _num(val: Any) -> float | None:
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _legacy_kie_ids(spec: dict[str, Any]) -> set[str]:
    """Все kie model id, которые может отправить legacy-запись каталога."""
    ids: set[str] = set()
    for key in ("model", "id"):
        val = spec.get(key)
        if val:
            ids.add(str(val))
    for val in (spec.get("model_map") or {}).values():
        if val:
            ids.add(str(val))
    if spec.get("model_map_i2i"):
        ids.add(str(spec["model_map_i2i"]))
    return ids


_FAMILY_BY_ID: dict[str, dict[str, Any]] = {str(f["id"]): f for f in FAMILIES}
_FAMILY_BY_KIE: dict[str, dict[str, Any]] = {}
for _fam in FAMILIES:
    for _mode in _fam.get("modes") or []:
        _kid = str(_mode.get("kie_id") or "")
        if _kid:
            _FAMILY_BY_KIE.setdefault(_kid, _fam)

# legacy id каталога → семья (чтобы старые id не двоились в меню, а остались режимом)
_FAMILY_BY_LEGACY_ID: dict[str, dict[str, Any]] = {}
for _spec in MODELS:
    _fam_legacy: dict[str, Any] | None = _FAMILY_BY_ID.get(str(_spec["id"]))
    if _fam_legacy is None:
        for _kid in _legacy_kie_ids(_spec):
            _fam_legacy = _FAMILY_BY_KIE.get(_kid)
            if _fam_legacy is not None:
                break
    if _fam_legacy is not None:
        _FAMILY_BY_LEGACY_ID[str(_spec["id"])] = _fam_legacy

_LEGACY_BY_KIE: dict[str, dict[str, Any]] = {}
for _spec in MODELS:
    for _kid in _legacy_kie_ids(_spec):
        _LEGACY_BY_KIE.setdefault(_kid, _spec)


def list_families() -> list[dict[str, Any]]:
    return list(FAMILIES)


def _singleton_mode(spec: dict[str, Any], media: str) -> dict[str, Any]:
    """Режим-заглушка для legacy-модели, не вошедшей в семьи."""
    return {
        "id": "default",
        "label": str(spec.get("label") or ""),
        "kie_id": str(spec.get("model") or spec.get("id") or ""),
        "task_type": str(spec.get("category") or ""),
        "api": str(spec.get("api") or "jobs"),
        "media": media,
        "endpoint": str(spec.get("endpoint") or ""),
        "fields": spec.get("fields") or [],
        "pricing": _usd_pricing_from_legacy(spec),
        "constraints": [],
        "_legacy": True,
    }


def _singleton_family(spec: dict[str, Any]) -> dict[str, Any]:
    """Семья из одной модели — обратная совместимость одиночных карточек."""
    media = _media_of(spec)
    if media not in ("video", "image"):
        media = "video" if str(spec.get("result") or "") == "video" else str(spec.get("result") or "video")
    return {
        "id": str(spec["id"]),
        "label": str(spec.get("label") or spec["id"]),
        "brand": str(spec.get("brand") or ""),
        "media": media,
        "desc": str(spec.get("desc") or ""),
        "default_mode": "default",
        "modes": [_singleton_mode(spec, media)],
        "_legacy": True,
    }


def _usd_pricing_from_legacy(spec: dict[str, Any]) -> dict[str, Any]:
    """pricing кредитов legacy-модели → pricing режима в USD (+25%)."""
    pricing = spec.get("pricing") or {}
    unit = str(pricing.get("unit") or "gen")
    rules: list[dict[str, Any]] = []
    for raw in pricing.get("rules") or []:
        credits = _num(raw.get("credits"))
        if credits is None:
            continue
        usd_kie = credits * CREDIT_USD
        rules.append(
            {
                "when": raw.get("when") or {},
                "usd_kie": round(usd_kie, 6),
                "usd_client": round(usd_kie * MARKUP, 4),
            }
        )
    default_kie = _num(pricing.get("default"))
    default_kie = default_kie * CREDIT_USD if default_kie is not None else None
    if default_kie is None and rules:
        default_kie = float(rules[0]["usd_kie"])
    return {
        "unit": unit,
        "markup": MARKUP,
        "usd_rules": rules,
        "usd_default_kie": round(default_kie, 6) if default_kie is not None else None,
        "usd_default_client": round(default_kie * MARKUP, 4) if default_kie is not None else None,
        "note": str(pricing.get("note") or ""),
        "formula": "",
    }


def get_family(family_id: str | dict[str, Any] | None) -> dict[str, Any] | None:
    """Семья по id: id семьи, старый id каталога, kie_id режима или сама семья."""
    if isinstance(family_id, dict):
        return family_id if "modes" in family_id else None
    if not family_id:
        return None
    key = str(family_id)
    if key == "seedream-5":
        key = "seedream-5-pro"
    fam = _FAMILY_BY_ID.get(key) or _FAMILY_BY_LEGACY_ID.get(key) or _FAMILY_BY_KIE.get(key)
    if fam is not None:
        return fam
    legacy = get_model(key)
    if legacy is not None:
        return _singleton_family(legacy)
    return None


def get_mode(
    family: str | dict[str, Any] | None,
    mode_id: str | None = None,
) -> dict[str, Any] | None:
    """Режим семьи; без mode_id — режим по умолчанию (default_mode или первый)."""
    fam = family if isinstance(family, dict) and "modes" in family else get_family(family)
    if fam is None:
        return None
    modes = fam.get("modes") or []
    if not modes:
        return None
    if mode_id:
        key = str(mode_id).strip()
        for mode in modes:
            if key in (str(mode.get("id")), str(mode.get("kie_id"))):
                return mode
        if str(fam.get("id")) == "seedance-2-0" and key == "mini":
            return get_mode("seedance-2-0-mini", "mini")
        return None
    default_id = str(fam.get("default_mode") or "")
    for mode in modes:
        if str(mode.get("id")) == default_id:
            return mode
    return modes[0]


def _default_endpoint(api: str, kie_id: str) -> str:
    if api in _ENDPOINT_BY_API:
        return _ENDPOINT_BY_API[api]
    legacy = _LEGACY_BY_KIE.get(kie_id)
    if legacy and legacy.get("endpoint"):
        return str(legacy["endpoint"])
    return ""


def mode_spec(
    family: str | dict[str, Any] | None,
    mode: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Режим в форме legacy-записи каталога (общая механика payload/валидации)."""
    fam = family if isinstance(family, dict) and "modes" in family else get_family(family)
    md = mode if isinstance(mode, dict) and "kie_id" in mode else get_mode(fam, mode if isinstance(mode, str) else None)
    if fam is None or md is None:
        return {}
    kie_id = str(md.get("kie_id") or "")
    api = str(md.get("api") or "jobs")
    media = str(md.get("media") or fam.get("media") or "video")
    fields = md.get("fields") or []
    if not fields:
        # у старых записей схемы в docs нет, но в каталоге студии поля уже были —
        # берём их, чтобы цена зависела от настроек, а форма не оставалась пустой
        legacy = _LEGACY_BY_KIE.get(kie_id)
        if legacy and legacy.get("fields"):
            fields = legacy["fields"]
    fam_label = str(fam.get("label") or fam.get("name") or fam.get("id") or "")
    mode_label = str(md.get("label") or md.get("id") or "")
    spec: dict[str, Any] = {
        "id": kie_id or str(md.get("id") or ""),
        "family_id": fam.get("id"),
        "family_label": fam_label,
        "mode_id": md.get("id"),
        "mode_label": mode_label,
        "label": fam_label or mode_label,
        "brand": str(fam.get("brand") or ""),
        "category": media,
        "media": media,
        "api": api,
        "model": kie_id,
        "result": media,
        "fields": fields,
        "constraints": md.get("constraints") or [],
        "pricing": md.get("pricing") or {},
        "is_family_mode": True,
    }
    endpoint = md.get("endpoint") or _default_endpoint(api, kie_id)
    if endpoint:
        spec["endpoint"] = endpoint
    return spec


def defaults_for_mode(
    family: str | dict[str, Any] | None,
    mode: str | dict[str, Any] | None = None,
) -> dict[str, Any]:
    spec = mode_spec(family, mode)
    return defaults_for(spec) if spec else {}


def build_mode_payload(
    family: str | dict[str, Any] | None,
    mode: str | dict[str, Any] | None,
    values: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Тело запроса для нужного api по семье/режиму (jobs: model+input, veo/… flat)."""
    spec = mode_spec(family, mode)
    if not spec:
        return {}
    return build_payload(spec, values or {})


def resolve_model_id(
    spec_or_family: str | dict[str, Any] | None,
    values: dict[str, Any] | None = None,
    mode: str | None = None,
) -> str:
    """kie_id модели: у семьи/режима — kie_id выбранного режима, у legacy — model."""
    target: Any = spec_or_family
    if isinstance(target, str):
        target = get_family(target)
    if isinstance(target, dict) and "modes" in target:
        chosen = get_mode(target, mode)
        return str((chosen or {}).get("kie_id") or "")
    if isinstance(target, dict) and "kie_id" in target:
        return str(target.get("kie_id") or target.get("model") or "")
    if isinstance(target, dict):
        return _legacy_resolve_model_id(target, values or {})
    return ""


_IMAGE_SIZE_MP: dict[str, float] = {
    "square": 1.048576,
    "square_hd": 2.359296,
    "portrait_4_3": 1.39776,
    "portrait_16_9": 1.86368,
    "landscape_4_3": 1.39776,
    "landscape_16_9": 1.86368,
}
_RESOLUTION_MP: dict[str, float] = {
    "1k": 1.048576,
    "2k": 4.19,
    "4k": 16.78,
    "8k": 67.11,
}
_SIZE_WH_RE = re.compile(r"^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$")


def _megapixels(merged: dict[str, Any]) -> float | None:
    """Мегапиксели выхода по настройкам (для цен «за мегапиксель»)."""
    width = _num(merged.get("width"))
    height = _num(merged.get("height"))
    if width and height:
        return width * height / 1_000_000
    size = merged.get("image_size") or merged.get("size")
    if size is not None and str(size).strip():
        text = str(size).strip()
        preset = _IMAGE_SIZE_MP.get(text.casefold())
        if preset is not None:
            return preset
        match = _SIZE_WH_RE.match(text)
        if match:
            return int(match.group(1)) * int(match.group(2)) / 1_000_000
    resolution = merged.get("resolution") or merged.get("output_resolution")
    if resolution is not None:
        return _RESOLUTION_MP.get(str(resolution).strip().casefold())
    return None


def _price_multiplier(unit: str, spec: dict[str, Any], merged: dict[str, Any]) -> tuple[float, str]:
    """Во сколько раз базовая цена умножается на текущие настройки."""
    if unit == "sec":
        for name in ("duration", "seconds", "video_duration", "duration_seconds"):
            if name in merged:
                num = _num(merged[name])
                if num is not None and num > 0:
                    return max(1.0, num), name
        return 5.0, "duration(default 5)"
    if unit in ("image", "images", "img", "picture"):
        for name in ("count", "num_images", "n", "image_count", "batch_size"):
            num = _num(merged.get(name))
            if num is not None and num > 0:
                return max(1.0, num), name
        return 1.0, "count(default 1)"
    if unit == "1k_chars":
        text = str(merged.get("text") or merged.get("prompt") or merged.get("dialogue") or "")
        return float(max(1, math.ceil(len(text) / 1000))), "text"
    if unit in ("1m_tokens", "mp"):
        # цена за 1M токенов / за мегапиксель: из формы итог не выводится
        return 1.0, "unit"
    return 1.0, "gen"


def estimate_usd(
    family: str | dict[str, Any] | None,
    mode: str | dict[str, Any] | None = None,
    values: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Цена режима в долларах: usd_kie (kie) и usd_client (+25%), кредиты для леджера."""
    fam = family if isinstance(family, dict) and "modes" in family else get_family(family)
    md = mode if isinstance(mode, dict) and "kie_id" in mode else get_mode(fam, mode if isinstance(mode, str) else None)
    unknown = {
        "family_id": str((fam or {}).get("id") or ""),
        "mode_id": str((md or {}).get("id") or ""),
        "kie_id": str((md or {}).get("kie_id") or ""),
        "unit": "gen",
        "markup": MARKUP,
        "usd_kie": None,
        "usd_client": None,
        "usd": 0.0,
        "credits": 0.0,
        "unit_usd_kie": None,
        "unit_usd_client": None,
        "multiplier": 1.0,
        "multiplier_on": "",
        "known": False,
        "note": "неизвестно",
        "approx": False,
        "formula": "",
        "breakdown": {},
    }
    if fam is None or md is None:
        return unknown
    spec = mode_spec(fam, md)
    merged = normalize_values(spec, values or {})
    pricing = _mode_usd_pricing(md)
    unit = str(pricing.get("unit") or "gen")

    def _unknown_quote(note: str) -> dict[str, Any]:
        result = dict(unknown)
        result.update(
            {
                "family_id": str(fam.get("id") or ""),
                "mode_id": str(md.get("id") or ""),
                "kie_id": str(md.get("kie_id") or ""),
                "unit": unit,
                "note": note,
                "formula": pricing.get("formula") or "",
            }
        )
        return result

    token_multiplier: float | None = None
    if unit in ("tokens", "1m_tokens"):
        tokens = _token_count(merged)
        if tokens is None:
            # количество токенов из настроек не выводится — цену не выдумываем
            return _unknown_quote("цена уточняется")
        token_multiplier = tokens / 1_000_000
    matched: dict[str, Any] | None = None
    best_score = -1
    rules = pricing.get("usd_rules") or []
    for rule in rules:
        when = rule.get("when") or {}
        if not _match_usd_rule(when, merged, spec):
            continue
        # specificity: больше условий — точнее правило; наличие видео/картинки на входе
        # (это факт payload, а не дефолт формы) весит больше обычного условия
        score = sum(2 if str(k).strip().lower() in _INPUT_FLAG_KEYS else 1 for k in when)
        if score > best_score:
            matched = rule
            best_score = score
    approx = False
    if matched is None and rules:
        # точной комбинации нет в прайсе — берём ближайший тариф, а не глобальный
        # минимум: иначе выбор более дорогой настройки снижает цену
        matched = _nearest_usd_rule(rules, merged, spec)
        approx = True
    if matched is not None:
        base_kie = _num(matched.get("usd_kie"))
        base_client = _num(matched.get("usd_client"))
    else:
        base_kie = _num(pricing.get("usd_default_kie"))
        base_client = _num(pricing.get("usd_default_client"))
    if base_kie is None and base_client is not None:
        base_kie = base_client / MARKUP
    if base_client is None and base_kie is not None:
        base_client = base_kie * MARKUP
    if base_kie is None or base_client is None:
        return _unknown_quote(pricing.get("note") or "неизвестно")
    if token_multiplier is not None:
        multiplier, multiplier_on = token_multiplier, "tokens"
    elif unit in ("megapixel", "mp"):
        pixels = _megapixels(merged)
        if pixels is None:
            return _unknown_quote("цена уточняется")
        multiplier, multiplier_on = pixels, "megapixels"
    else:
        multiplier, multiplier_on = _price_multiplier(unit, spec, merged)
    usd_kie = float(base_kie) * multiplier
    usd_client = float(base_client) * multiplier
    extra_kie, extra_client, extra_applied = _extra_usd(pricing, merged)
    usd_kie += extra_kie
    usd_client += extra_client
    credits = usd_client / CREDIT_USD
    note = pricing.get("note") or ""
    if approx:
        tail = "ближайший тариф" if matched is not None else "правило не разрешилось"
        note = f"{note} (ориентировочно: {tail})".strip()
    breakdown = {
        "kie_id": str(md.get("kie_id") or ""),
        "unit": unit,
        "matched_rule": (matched or {}).get("when") or None,
        "approx": approx,
        "base_usd_kie": round(float(base_kie), 6),
        "base_usd_client": round(float(base_client), 4),
        "multiplier": multiplier,
        "multiplier_on": multiplier_on,
        "usd_kie": round(usd_kie, 6),
        "usd_client": round(usd_client, 4),
        "credits": round(credits, 4),
        "markup": MARKUP,
    }
    if extra_applied:
        breakdown["extra_charges"] = extra_applied
        breakdown["extra_usd_kie"] = round(extra_kie, 6)
        breakdown["extra_usd_client"] = round(extra_client, 4)
    return {
        "family_id": str(fam.get("id") or ""),
        "mode_id": str(md.get("id") or ""),
        "kie_id": str(md.get("kie_id") or ""),
        "unit": unit,
        "markup": MARKUP,
        "usd_kie": round(usd_kie, 6),
        "usd_client": round(usd_client, 4),
        "usd": round(usd_client, 4),
        "credits": round(credits, 4),
        "unit_usd_kie": round(float(base_kie), 6),
        "unit_usd_client": round(float(base_client), 4),
        "multiplier": multiplier,
        "multiplier_on": multiplier_on,
        "known": True,
        "note": note,
        "approx": approx,
        "formula": pricing.get("formula") or "",
        "breakdown": breakdown,
    }


_TOKEN_FIELD_CANDIDATES = (
    "tokens",
    "token_count",
    "input_tokens",
    "output_tokens",
    "max_tokens",
    "token_budget",
)
_IMAGE_KEYS_RE = re.compile(r"(image|frame|photo|picture)", re.IGNORECASE)
_IMAGE_SETTING_KEYS = {
    "image_size",
    "size",
    "image_quality",
    "image_steps",
    "image_resolution",
    "image_format",
}


def _looks_like_image_ref(value: Any) -> bool:
    """URL/путь/data-uri картинки, а не слово вроде «16:9»."""
    if isinstance(value, dict):
        return bool(str(value.get("url") or "").strip())
    text = str(value or "").strip()
    if not text:
        return False
    low = text.lower()
    if low.startswith(("http://", "https://", "data:", "file://", "blob:")):
        return True
    if "\\" in text:
        return True
    tail = text.rsplit("/", 1)[-1]
    return "/" in text and "." in tail


def _iter_images(merged: dict[str, Any]) -> list[str]:
    """Все картинки из значений: по полям вида *_image(s)/*_frame и свободным ключам."""
    found: list[str] = []
    for key, val in merged.items():
        key_low = str(key).lower()
        if key_low in _IMAGE_SETTING_KEYS:
            continue
        if "video" in key_low or "audio" in key_low:
            continue
        if not _IMAGE_KEYS_RE.search(key_low):
            continue
        items = val if isinstance(val, list) else [val]
        for item in items:
            if _looks_like_image_ref(item):
                found.append(str(item.get("url") if isinstance(item, dict) else item).strip())
    return found


def _extra_usd(
    pricing: dict[str, Any], merged: dict[str, Any]
) -> tuple[float, float, list[dict[str, Any]]]:
    """Доплаты за входные картинки сверх бесплатных (pricing.extra_charges)."""
    charges = pricing.get("extra_charges") or []
    if not charges:
        return 0.0, 0.0, []
    images = _iter_images(merged)
    total_kie = 0.0
    total_client = 0.0
    applied: list[dict[str, Any]] = []
    for charge in charges:
        if str(charge.get("per") or "") not in ("image", "images"):
            continue
        per_kie = _num(charge.get("usd_kie")) or 0.0
        per_client = _num(charge.get("usd_client")) or 0.0
        free = int(charge.get("free_first") or 0)
        paid = max(0, len(images) - free)
        if paid <= 0:
            continue
        add_kie = per_kie * paid
        add_client = per_client * paid
        total_kie += add_kie
        total_client += add_client
        applied.append(
            {
                "what": str(charge.get("what") or "входные картинки"),
                "images": len(images),
                "free": free,
                "paid": paid,
                "unit_usd_kie": round(per_kie, 6),
                "unit_usd_client": round(per_client, 4),
                "usd_kie": round(add_kie, 6),
                "usd_client": round(add_client, 4),
            }
        )
    return total_kie, total_client, applied


def _token_count(merged: dict[str, Any]) -> float | None:
    """Количество токенов, если настройка задаёт его явно."""
    for name in _TOKEN_FIELD_CANDIDATES:
        num = _num(merged.get(name))
        if num:
            return num
    return None


def _has_value(merged: dict[str, Any], key: str) -> bool:
    val = merged.get(key)
    if isinstance(val, list):
        return len(val) > 0
    if isinstance(val, str):
        return bool(val.strip())
    return val is not None and val is not False


def _frames_refs_conflict(spec: dict[str, Any], merged: dict[str, Any]) -> bool:
    """Кадры (first/last/start/end) и референс-картинки несовместимы в одном запросе."""
    frames = False
    refs = False
    for field in spec.get("fields") or []:
        name = str(field.get("name") or "").lower()
        if not _has_value(merged, field.get("name") or ""):
            continue
        if "frame" in name:
            frames = True
        elif "reference" in name and "video" not in name and "audio" not in name:
            refs = True
    return frames and refs


def validate_mode_values(
    family: str | dict[str, Any] | None,
    mode: str | dict[str, Any] | None,
    values: dict[str, Any] | None = None,
) -> list[str]:
    """Проверки режима: обязательные, enum, min/max, max_items, взаимоисключения."""
    spec = mode_spec(family, mode)
    if not spec:
        return ["режим не найден"]
    vals = values or {}
    errors = validate_values(spec, vals)
    if str(spec.get("category")) == "video":
        merged = normalize_values(spec, vals)
        conflict = (
            "Видеомодели не поддерживают одновременное совмещение перехода по кадрам (старт/финиш) "
            "и референсов. Выберите один режим: либо только кадры, либо только референсы."
        )
        if _frames_refs_conflict(spec, merged) and conflict not in errors:
            errors.append(conflict)
    return errors


_TIER_FIELD_CANDIDATES = (
    "tier",
    "mode",
    "model",
    "quality",
    "rendering_speed",
    "speed",
    "quality_tier",
)
_RESOLUTION_FIELD_CANDIDATES = (
    "resolution",
    "output_resolution",
    "video_resolution",
    "video_quality",
    "image_size",
    "size",
    "quality",
)
_AUDIO_FIELD_CANDIDATES = (
    "audio",
    "sound",
    "generate_audio",
    "enable_audio",
    "generate_audio_switch",
    "sound_effects",
    "with_audio",
)
_UPSCALE_FIELD_CANDIDATES = ("upscale_factor", "upscale", "scale", "factor")
_FROM_RES_FIELD_CANDIDATES = ("from_resolution", "source_resolution", "input_resolution")
_DURATION_FIELD_CANDIDATES = (
    "duration",
    "duration_seconds",
    "duration_s",
    "output_duration",
    "video_duration",
)

# Синонимы ключей when из прайса → поля формы режима.
# Разрешение правил общее: сначала поле с тем же именем, потом синонимы,
# потом любое поле, чьи options принимают нужное значение.
_WHEN_KEY_ALIASES: dict[str, tuple[str, ...]] = {
    "sound": _AUDIO_FIELD_CANDIDATES,
    "audio": _AUDIO_FIELD_CANDIDATES,
    "has_audio": _AUDIO_FIELD_CANDIDATES,
    "mode": _TIER_FIELD_CANDIDATES,
    "tier": _TIER_FIELD_CANDIDATES,
    "resolution": _RESOLUTION_FIELD_CANDIDATES,
    "duration": _DURATION_FIELD_CANDIDATES,
    "upscale": _UPSCALE_FIELD_CANDIDATES,
    "scale": _UPSCALE_FIELD_CANDIDATES,
    "from_resolution": _FROM_RES_FIELD_CANDIDATES,
    "source_resolution": _FROM_RES_FIELD_CANDIDATES,
}
_TIER_KEYS = frozenset({"mode", "tier"})
_VIDEO_FLAG_KEYS = frozenset({"with_video", "_has_videos", "has_videos", "has_video", "video_input"})
_IMAGE_FLAG_KEYS = frozenset({"with_images", "_has_images", "has_images", "has_image"})
_INPUT_FLAG_KEYS = _VIDEO_FLAG_KEYS | _IMAGE_FLAG_KEYS
# ключи, которым нужен внешний контекст (токены/апскейл источника): правило не применяем
_UNRESOLVED_ONLY_KEYS = frozenset({"token_kind", "from_resolution", "source_resolution"})

# тир в правилах цены может не совпадать буквально со значением поля (veo3_lite ↔ lite)
_TIER_ALIASES: dict[str, set[str]] = {
    "quality": {"quality", "veo3", "pro", "high", "max", "best"},
    "pro": {"pro", "quality", "veo3", "high", "max"},
    "lite": {"lite", "veo3_lite", "low", "cheap"},
    "fast": {"fast", "turbo", "veo3_fast"},
    "turbo": {"turbo", "fast"},
    "max": {"max", "quality", "veo3", "high"},
    "medium": {"medium", "balanced", "standard", "std", "normal"},
    "standard": {"standard", "std", "balanced", "medium"},
    "balanced": {"balanced", "medium", "standard", "std"},
    "high": {"high", "quality", "pro"},
}

# разрешение в правилах цены против тирового поля (std=720p, pro=1080p в Kling)
_RESOLUTION_ALIASES: dict[str, set[str]] = {
    "480p": {"480p", "sd"},
    "720p": {"720p", "hd", "std", "standard"},
    "768p": {"768p"},
    "1080p": {"1080p", "fullhd", "fhd", "pro"},
    "2k": {"2k", "1440p", "qhd"},
    "4k": {"4k", "2160p", "uhd", "ultra"},
}

_RES_OPTION_RE = re.compile(r"^\s*(\d{3,4}\s*[pP]|\d+\s*[kK]|\d+\s*[kK]\s*/\s*\d+\s*[kK])\s*$")


def _as_bool(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("true", "1", "yes", "on")


def _comparator(key: str) -> str:
    """Чем сравнивать значения when: тир, разрешение, число, bool."""
    k = str(key).strip().lower()
    if k in _TIER_KEYS:
        return "tier"
    if k == "sound" or k == "audio":
        return "audio"
    return k


def _looks_like_resolution(field: dict[str, Any]) -> bool:
    options = [str(o) for o in (field.get("options") or [])]
    if not options:
        return False
    hits = 0
    for opt in options:
        if _RES_OPTION_RE.match(opt) or ("/" in opt and any(_RES_OPTION_RE.match(p) for p in opt.split("/"))):
            hits += 1
    return hits >= max(1, len(options) // 2)


def _cond_present(merged: dict[str, Any], name: str) -> bool:
    if name not in merged:
        return False
    val = merged[name]
    if val is None:
        return False
    if isinstance(val, str) and not val.strip():
        return False
    return True


def _when_candidate_fields(
    spec: dict[str, Any],
    key: str,
    want: Any = None,
    strict: bool = False,
) -> list[str]:
    """Поля режима, которые могут отвечать за условие when (сначала точное имя).

    strict=True — только имена/синонимы ключа, без смыслового поиска по options.
    """
    fields = spec.get("fields") or []
    known = [str(f.get("name") or "") for f in fields]
    out: list[str] = []

    def add(name: Any) -> None:
        text = str(name or "")
        if text and text in known and text not in out:
            out.append(text)

    k = str(key).strip().lower()
    add(k)
    for alias in _WHEN_KEY_ALIASES.get(k, ()):
        add(alias)
    if want is not None and not strict and not isinstance(want, bool):
        comp = _comparator(k)
        for field in fields:
            options = [str(o) for o in (field.get("options") or [])]
            if not options:
                continue
            if any(_values_match(want, opt, comp) for opt in options):
                add(field.get("name"))
    return out


def _find_rule_field(spec: dict[str, Any], key: str, want: Any = None) -> str | None:
    """Какое поле режима отвечает за условие правила цены (первое подходящее)."""
    candidates = _when_candidate_fields(spec, key, want)
    return candidates[0] if candidates else None


def _values_match(want: Any, got: Any, key: str = "") -> bool:
    """Сравнение значения правила с настройкой: регистр, числа, bool, 1K/2K, тиры, 4K↔4k."""
    if isinstance(want, bool):
        return _as_bool(got) == want
    if want is None:
        return True
    w = str(want).strip()
    g = str(got).strip()
    if w == g:
        return True
    w_cf, g_cf = w.casefold(), g.casefold()
    if w_cf == g_cf:
        return True
    if key == "audio":
        return _as_bool(want) == _as_bool(got)
    if "/" in w:
        parts = [p.strip() for p in w.split("/") if p.strip()]
        if any(p.casefold() == g_cf for p in parts):
            return True
        g_num = _num(g)
        if g_num is not None:
            for part in parts:
                part_num = _num(part)
                if part_num is not None and abs(part_num - g_num) < 1e-9:
                    return True
    wont, gont = _num(w), _num(g)
    if wont is not None and gont is not None and abs(wont - gont) < 1e-9:
        return True
    if key in ("upscale", "scale") and w_cf.rstrip("x") == g_cf.rstrip("x"):
        return True
    if key == "tier":
        if not w_cf.isdigit() and w_cf in g_cf:
            return True
        if w_cf in set(re.split(r"[^a-z0-9]+", g_cf)):
            return True
        alias = _TIER_ALIASES.get(w_cf)
        if alias and g_cf in alias:
            return True
    if key == "resolution":
        if g_cf in _RESOLUTION_ALIASES.get(w_cf, set()):
            return True
        if w_cf in _RESOLUTION_ALIASES and g_cf.rstrip("p") == w_cf.rstrip("p"):
            return True
    return False


def _has_video_input(merged: dict[str, Any], spec: dict[str, Any]) -> bool:
    """Есть ли на входе видео (цена у Seedance зависит от видеовхода)."""
    for field in spec.get("fields") or []:
        name = str(field.get("name") or "")
        if not _has_value(merged, name):
            continue
        low = name.lower()
        if field.get("kind") == "videos":
            return True
        if "video" in low and any(tok in low for tok in ("url", "list", "ids", "reference", "input", "file")):
            return True
    return False


_FACTOR_TO_RESOLUTION = {"1": "1k", "2": "2k", "4": "4k", "8": "8k"}
_RESOLUTION_TO_FACTOR = {v: k for k, v in _FACTOR_TO_RESOLUTION.items()}


def _derived_resolution(spec: dict[str, Any], merged: dict[str, Any]) -> str | None:
    """Разрешение, если в форме его нет явно: вывести из фактора апскейла (2 → 2K)."""
    for field in spec.get("fields") or []:
        name = str(field.get("name") or "")
        if name == "resolution" or (
            _looks_like_resolution(field) and _cond_present(merged, name)
        ):
            if _cond_present(merged, name):
                return str(merged.get(name))
    for name in _UPSCALE_FIELD_CANDIDATES:
        if not _cond_present(merged, name):
            continue
        factor = str(merged.get(name)).strip().casefold().rstrip("x")
        if factor in _FACTOR_TO_RESOLUTION:
            return _FACTOR_TO_RESOLUTION[factor]
    return None


def _output_megapixels(spec: dict[str, Any], merged: dict[str, Any]) -> float | None:
    mp = _megapixels(merged)
    if mp is not None:
        return mp
    resolution = _derived_resolution(spec, merged)
    if resolution is None:
        return None
    return _RESOLUTION_MP.get(resolution.strip().casefold())


def _condition_status(
    spec: dict[str, Any],
    merged: dict[str, Any],
    key: str,
    want: Any,
) -> str:
    """Статус одного условия when: match / no / unresolved."""
    k = str(key).strip().lower()
    if k in _VIDEO_FLAG_KEYS:
        expected = _as_bool(want)
        return "match" if _has_video_input(merged, spec) == expected else "no"
    if k in _IMAGE_FLAG_KEYS:
        expected = _as_bool(want)
        return "match" if _has_files(merged, spec, {"images"}) == expected else "no"
    if k == "max_mp":
        mp = _output_megapixels(spec, merged)
        cap = _num(want)
        if mp is None or cap is None:
            return "unresolved"
        return "match" if mp <= cap + 1e-6 else "no"
    if k in _UNRESOLVED_ONLY_KEYS:
        # источник данных (качество апскейла/тип токенов) — только явно совпадающее поле,
        # никакого смыслового поиска: resolution ≠ from_resolution
        field = _find_rule_field(spec, k, want)
        strict = _when_candidate_fields(spec, k, None, strict=True)
        if field is None or field not in strict:
            return "unresolved"
    comp = _comparator(k)
    candidates = _when_candidate_fields(spec, k, want)
    present = False
    for name in candidates:
        if not _cond_present(merged, name):
            continue
        present = True
        if _values_match(want, merged.get(name), comp):
            return "match"
    if present:
        return "no"
    if k == "resolution":
        # разрешение может не иметь своего поля: выводим из фактора апскейла (2x → 2K)
        derived = _derived_resolution(spec, merged)
        if derived is not None:
            return "match" if _values_match(want, derived, "resolution") else "no"
    if k in _TIER_KEYS or k == "resolution":
        # условие может быть зашито в самом id модели (hailuo ...-pro / ...-standard)
        hint = " ".join(str(spec.get(x) or "") for x in ("id", "kie_id", "label"))
        if hint.strip() and _values_match(want, hint, comp):
            return "match"
    return "unresolved"


def _match_usd_rule(
    when: dict[str, Any],
    merged: dict[str, Any],
    spec: dict[str, Any],
) -> bool:
    """Совпадение правила цены: все условия when должны разрешиться и совпасть."""
    for key, want in (when or {}).items():
        if _condition_status(spec, merged, str(key), want) != "match":
            return False
    return True


def _nearest_usd_rule(
    rules: list[dict[str, Any]],
    merged: dict[str, Any],
    spec: dict[str, Any],
) -> dict[str, Any] | None:
    """Ближайший тариф, когда точной комбинации нет в прайсе.

    Максимум совпавших условий (вес видео/картинки — как при точном матче);
    при равенстве берём правило дороже, чтобы не занижать цену.
    None — если не совпало ни одно условие (тогда остаётся default).
    """
    best: dict[str, Any] | None = None
    best_key: tuple[int, float] | None = None
    for rule in rules:
        when = rule.get("when") or {}
        if not when:
            continue
        score = 0
        for key, want in when.items():
            if _condition_status(spec, merged, str(key), want) != "match":
                continue
            k = str(key).strip().lower()
            score += 2 if k in _INPUT_FLAG_KEYS else 1
        if score <= 0:
            continue
        price = _num(rule.get("usd_client"))
        rank = (score, float(price) if price is not None else 0.0)
        if best_key is None or rank > best_key:
            best, best_key = rule, rank
    return best


def _mode_usd_pricing(mode: dict[str, Any]) -> dict[str, Any]:
    """pricing режима в USD; если прайс не нашёлся — цена legacy-записи каталога."""
    pricing = mode.get("pricing") or {}
    if pricing.get("usd_default_kie") is not None or pricing.get("usd_rules"):
        return pricing
    legacy = _LEGACY_BY_KIE.get(str(mode.get("kie_id") or ""))
    if legacy is not None:
        return _usd_pricing_from_legacy(legacy)
    return pricing


def _cheapest_usd(pricing: dict[str, Any]) -> float | None:
    vals: list[float] = []
    default_client = _num(pricing.get("usd_default_client"))
    if default_client is not None and default_client > 0:
        vals.append(default_client)
    for rule in pricing.get("usd_rules") or []:
        client = _num(rule.get("usd_client"))
        if client is not None and client > 0:
            vals.append(client)
    return round(min(vals), 4) if vals else None


def _credits_pricing_from_usd(pricing: dict[str, Any]) -> dict[str, Any]:
    """pricing режима в USD → legacy-совместимый pricing в кредитах (для старого UI)."""
    unit = str(pricing.get("unit") or "gen")
    rules: list[dict[str, Any]] = []
    for raw in pricing.get("usd_rules") or []:
        client = _num(raw.get("usd_client"))
        if client is None:
            continue
        rules.append({"when": raw.get("when") or {}, "credits": round(client / CREDIT_USD, 2)})
    default_client = _num(pricing.get("usd_default_client"))
    default: float
    if default_client is not None and default_client > 0:
        default = round(default_client / CREDIT_USD, 2)
    elif rules and float(rules[0]["credits"]) > 0:
        default = float(rules[0]["credits"])
    else:
        # бесплатная модель или неизвестная цена: положительный плейсхолдер,
        # чтобы старый UI не писал $0. Настоящая цена — в pricing режима.
        default = 1.0
    return {
        "unit": unit,
        "rules": rules,
        "default": default,
        "note": str(pricing.get("note") or ""),
        "unknown": _cheapest_usd(pricing) is None,
    }


def _mode_card(mode: dict[str, Any], fam: dict[str, Any]) -> dict[str, Any]:
    pricing = _mode_usd_pricing(mode)
    return {
        "id": str(mode.get("id") or ""),
        "label": str(mode.get("label") or mode.get("id") or ""),
        "kie_id": str(mode.get("kie_id") or ""),
        "task_type": str(mode.get("task_type") or ""),
        "api": str(mode.get("api") or "jobs"),
        "media": str(mode.get("media") or fam.get("media") or ""),
        "fields": mode.get("fields") or [],
        "pricing": pricing,
        "constraints": mode.get("constraints") or [],
        "docs_url": str(mode.get("docs_url") or ""),
        "hint": str(mode.get("hint") or ""),
        "price_from_usd": _cheapest_usd(pricing),
    }


def _primary_legacy(fam: dict[str, Any]) -> dict[str, Any] | None:
    """Legacy-модель, чьи поля/цены берём для карточки семьи (совместимость UI)."""
    fid = str(fam.get("id") or "")
    for spec in MODELS:
        if str(spec["id"]) == fid:
            return spec
    default_mode = get_mode(fam) or {}
    kie_id = str(default_mode.get("kie_id") or "")
    if kie_id:
        for spec in MODELS:
            if kie_id in _legacy_kie_ids(spec):
                return spec
    for spec in MODELS:
        if _FAMILY_BY_LEGACY_ID.get(str(spec["id"])) is fam:
            return spec
    return None


def _audio_card(spec: dict[str, Any]) -> dict[str, Any]:
    """Аудио/музыка/голос — как раньше, без семей и USD-наценки."""
    return {
        "id": spec["id"],
        "label": spec["label"],
        "category": spec["category"],
        "media": _media_of(spec),
        "desc": spec.get("desc") or "",
        "hint": spec.get("hint") or "",
        "is_top": bool(spec.get("is_top", False)),
        "isTop": bool(spec.get("is_top", False)),
        "badge": spec.get("badge") or "",
        "result": spec.get("result"),
        "fields": spec.get("fields") or [],
        "pricing": spec.get("pricing") or {},
    }


def _family_card(fam: dict[str, Any], legacy: dict[str, Any] | None = None) -> dict[str, Any]:
    """Карточка семьи для UI: modes[] + legacy-поля для обратной совместимости."""
    modes = fam.get("modes") or []
    mode_cards = [_mode_card(mode, fam) for mode in modes]
    default_mode = get_mode(fam) or (modes[0] if modes else {})
    default_fields = default_mode.get("fields") or []
    fields = (legacy or {}).get("fields") or default_fields
    if not fields:
        for card in mode_cards:
            if card.get("fields"):
                fields = card["fields"]
                break
    if not fields:
        fields = [
            {
                "name": "prompt",
                "label": "Промпт",
                "kind": "textarea",
                "required": False,
                "desc": "неизвестно",
            }
        ]
    pricing = (legacy or {}).get("pricing")
    if not pricing:
        pricing = _credits_pricing_from_usd(_mode_usd_pricing(default_mode))
    is_top = bool((legacy or {}).get("is_top", fam.get("is_top", False)))
    media = str(fam.get("media") or _media_of(legacy or {}) or "video")
    category = str((legacy or {}).get("category") or ("video" if media == "video" else "image"))
    prices = [card["price_from_usd"] for card in mode_cards if card.get("price_from_usd")]
    return {
        "id": str((legacy or {}).get("id") or fam.get("id")),
        "label": str(fam.get("label") or (legacy or {}).get("label") or fam.get("id")),
        "category": category,
        "media": media,
        "desc": str(fam.get("desc") or (legacy or {}).get("desc") or ""),
        "hint": str((legacy or {}).get("hint") or ""),
        "is_top": is_top,
        "isTop": is_top,
        "badge": str((legacy or {}).get("badge") or ""),
        "result": str((legacy or {}).get("result") or media),
        "fields": fields,
        "pricing": pricing,
        "brand": str(fam.get("brand") or ""),
        "family_id": str(fam.get("id") or ""),
        "kie_id": str(default_mode.get("kie_id") or ""),
        "default_mode": str(default_mode.get("id") or ""),
        "modes": mode_cards,
        "modes_count": len(mode_cards),
        "price_from_usd": round(min(prices), 4) if prices else None,
    }


def _media_of(m: dict[str, Any]) -> str:
    """В какой тип Create-пикера попадает модель: image | video | audio."""
    cat = m.get("category")
    if cat in ("video",):
        return "video"
    if cat in ("image",):
        return "image"
    if cat in ("music", "sound", "voice"):
        return "audio"
    # tools — по типу результата
    return str(m.get("result") or "video")


def catalog_for_ui() -> dict[str, Any]:
    """Каталог для фронта: семьи с режимами (медиа) + аудио как раньше.

    Медиа: одна карточка на семейство, внутри modes[] со своими полями и
    ценами в USD (pricing.usd_default_client). Старые одиночные модели без
    семьи остаются карточкой с одним режимом «default».
    Аудио/музыка/голос отдаются ровно как раньше — без семей и наценки.
    """
    covered: set[str] = set()
    cards: list[dict[str, Any]] = []
    for fam in FAMILIES:
        legacy = _primary_legacy(fam)
        cards.append(_family_card(fam, legacy))
        for spec in MODELS:
            if _FAMILY_BY_LEGACY_ID.get(str(spec["id"])) is fam:
                covered.add(str(spec["id"]))
    for spec in MODELS:
        if str(spec["id"]) in covered:
            continue
        if spec.get("category") in _AUDIO_CATEGORIES:
            cards.append(_audio_card(spec))
            continue
        cards.append(_family_card(_singleton_family(spec), spec))
    return {
        "credit_usd": CREDIT_USD,
        "markup": MARKUP,
        "families_count": len(FAMILIES),
        "categories": CATEGORIES,
        "models": cards,
    }
