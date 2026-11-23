"""Локальная маршрутизация моделей, которые реально открыты ключами 52pay.

Ключ пустой — маршрут не срабатывает, запрос остаётся на vibecode/kie.
Модели Клода идут на рабочий ключ pay52_claude_low_key (sk-AFaYVF...).
"""

from __future__ import annotations

from dataclasses import dataclass

# catalog id или id из /v1/models → (поле Settings, id в запросе)
_TEXT: dict[str, tuple[str, str]] = {
    # DeepSeek
    "deepseek-v4.1-flash": ("pay52_deepseek_key", "deepseek-v4.1-flash"),
    "deepseek-v4.1-flash-pay52": ("pay52_deepseek_key", "deepseek-v4.1-flash"),
    # Kimi
    "kimi-k3.1-pro": ("pay52_kimi_key", "kimi-k3.1-pro"),
    "kimi-k3.1-pro-pay52": ("pay52_kimi_key", "kimi-k3.1-pro"),
    # Gemini
    "gemini-4-argon": ("pay52_gemini_key", "gemini-4-argon"),
    "gemini-4-argon-pay52": ("pay52_gemini_key", "gemini-4-argon"),
    "gemini-3.8-flash": ("pay52_gemini_key", "gemini-3.8-flash"),
    "gemini-3.8-flash-pay52": ("pay52_gemini_key", "gemini-3.8-flash"),
    "gemini-flash-lite-latest": ("pay52_gemini_key", "gemini-flash-lite-latest"),
    "gemini-flash-lite-latest-pay52": ("pay52_gemini_key", "gemini-flash-lite-latest"),
    # OpenAI / GPT-6
    "gpt-6.1-sol": ("pay52_gpt_key", "gpt-6.1-sol"),
    "gpt-6.1-sol-pay52": ("pay52_gpt_key", "gpt-6.1-sol"),
    "gpt-6-sol": ("pay52_gpt_key", "gpt-6.1-sol"),
    "gpt-6-astra": ("pay52_gpt_key", "gpt-6-astra"),
    "gpt-6-astra-pay52": ("pay52_gpt_key", "gpt-6-astra"),
    "gpt-6-luna": ("pay52_gpt_key", "gpt-6-luna"),
    "gpt-6-luna-pay52": ("pay52_gpt_key", "gpt-6-luna"),
    "gpt-6.1-terra": ("pay52_gpt_key", "gpt-6.1-terra"),
    "gpt-6.1-terra-pay52": ("pay52_gpt_key", "gpt-6.1-terra"),
    "gpt-5.6-sol": ("pay52_gpt_key", "gpt-6.1-sol"),
    "gpt-5-6-sol": ("pay52_gpt_key", "gpt-6.1-sol"),
    "gpt-5.5": ("pay52_gpt_key", "gpt-6.1-sol"),
    # Claude (Anthropic) — на актуальном рабочем ключе sk-AFaYVF...
    "claude-sonnet-5": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-sonnet-5-pay52": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-sonnet-5-pay52-low": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-sonnet-5-pay52-high": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-sonnet-5-5": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-sonnet-5-5-pay52-high": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-sonnet-5-5-pay52-low": ("pay52_claude_low_key", "claude-sonnet-5"),
    "claude-haiku-5-5": ("pay52_claude_low_key", "claude-haiku-5-5"),
    "claude-haiku-5-5-pay52": ("pay52_claude_low_key", "claude-haiku-5-5"),
    "claude-haiku-5-5-pay52-high": ("pay52_claude_low_key", "claude-haiku-5-5"),
    "claude-haiku-4-5": ("pay52_claude_low_key", "claude-haiku-5-5"),
    "claude-haiku-4-5-pay52-low": ("pay52_claude_low_key", "claude-haiku-5-5"),
    "claude-opus-5-5": ("pay52_claude_low_key", "claude-opus-5-5"),
    "claude-opus-5-5-pay52": ("pay52_claude_low_key", "claude-opus-5-5"),
    "claude-opus-5-5-pay52-high": ("pay52_claude_low_key", "claude-opus-5-5"),
    "claude-opus-5-5-pay52-low": ("pay52_claude_low_key", "claude-opus-5-5"),
    "claude-opus-5": ("pay52_claude_low_key", "claude-opus-5-5"),
    "claude-fable-5-1": ("pay52_claude_low_key", "claude-fable-5-1"),
    "claude-fable-5-1-pay52": ("pay52_claude_low_key", "claude-fable-5-1"),
    "claude-fable-5-1-pay52-high": ("pay52_claude_low_key", "claude-fable-5-1"),
    # GLM (Zhipu)
    "glm-5.3": ("pay52_glm_key", "glm-5.3"),
    "glm-5.3-pay52": ("pay52_glm_key", "glm-5.3"),
    "glm-5.3-flash": ("pay52_glm_key", "glm-5.3-flash"),
    "glm-5.3-flash-pay52": ("pay52_glm_key", "glm-5.3-flash"),
    "glm-5.2": ("pay52_glm_key", "glm-5.3"),
}

# Видео этих ключей не совпадает с kie/outsee id в пикере. Карта для явного вызова.
_VIDEO: dict[str, str] = {
    "seedance-2.0-mini": "seedance_fast_key",
    "seedance-2.0-mini-ref": "seedance_fast_key",
    "seedance-2-0-mini": "seedance_fast_key",
    "seedance 2.0 fast 海外": "seedance_fast_key",
    "seedance-2.0-fast": "seedance_fast_key",
    "seedance-2-0-fast": "seedance_fast_key",
    "seedance-2-0-fast-overseas": "seedance_fast_key",
    "seedance-2.5": "seedance_fast_key",
    "seedance-2-5": "seedance_fast_key",
    "seedance 2.5 海外": "seedance_fast_key",
    "kling-4.0-k1": "seedance_fast_key",
    "veo-3.1-fast-generate-preview": "seedance_fast_key",
}


def _key(settings, field: str) -> str:
    """Ключ из Settings: имя нашей линии (*_api_key) или новой (pay52_gpt_key и т.п.)."""
    for name in (field, field.replace("_api_key", "_key"), field.replace("_key", "_api_key")):
        value = str(getattr(settings, name, "") or "").strip()
        if value:
            return value
    if "claude" in field:
        # Fallback на любой настроенный ключ Клода
        return str(getattr(settings, "pay52_claude_low_key", "") or getattr(settings, "pay52_claude_high_key", "") or "").strip()
    if "seedance" in field:
        return str(getattr(settings, "seedance_fast_key", "") or getattr(settings, "seedance_mini_key", "") or getattr(settings, "seedance_overseas_key", "") or "").strip()
    # Fallback на любой настроенный 52pay ключ
    return str(
        getattr(settings, "pay52_gpt_key", "")
        or getattr(settings, "pay52_glm_key", "")
        or getattr(settings, "pay52_claude_low_key", "")
        or ""
    ).strip()


@dataclass(frozen=True)
class Pay52TextRoute:
    api_model: str
    api_key: str
    url: str
    candidate_keys: tuple[str, ...] = ()

    def headers(self, key: str | None = None) -> dict[str, str]:
        active = key or self.api_key
        return {
            "Authorization": f"Bearer {active}",
            "Content-Type": "application/json",
        }


def candidate_keys_for_model(model: str | None, cfg: Any | None = None) -> list[str]:
    """Список рабочих и резервных ключей для текстовой модели в порядке приоритета."""
    raw = (model or "").strip()
    spec = _TEXT.get(raw) or _TEXT.get(raw.lower())
    if not spec:
        return []
    if cfg is None:
        from app.settings import settings as s
    else:
        s = cfg

    field, _ = spec
    keys: list[str] = []

    # 1. Основной ключ для этой модели
    primary = _key(s, field)
    if primary:
        keys.append(primary)

    # Если ротация ключей включена (дефолт True):
    fallback_enabled = bool(getattr(s, "pay52_key_fallback_enabled", True))
    if fallback_enabled:
        # 2. Родственные ключи того же семейства
        if "claude" in field:
            for alt_name in ("pay52_claude_high_key", "pay52_claude_low_key"):
                val = str(getattr(s, alt_name, "") or "").strip()
                if val:
                    keys.append(val)

        # 3. Мастер-ключ GPT
        gpt_master = str(getattr(s, "pay52_gpt_key", "") or "").strip()
        if gpt_master:
            keys.append(gpt_master)

        # 4. Другие текстовые ключи пула
        for alt_field in ("pay52_glm_key", "pay52_claude_low_key", "pay52_deepseek_key", "pay52_kimi_key", "pay52_gemini_key"):
            val = str(getattr(s, alt_field, "") or "").strip()
            if val:
                keys.append(val)

    # Дедупликация с сохранением порядка
    seen: set[str] = set()
    result: list[str] = []
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            result.append(k)
    return result


def resolve_text(model: str | None) -> Pay52TextRoute | None:
    raw = (model or "").strip()
    spec = _TEXT.get(raw) or _TEXT.get(raw.lower())
    if not spec:
        return None
    from app.settings import settings

    _, api_model = spec
    keys = candidate_keys_for_model(model, cfg=settings)
    if not keys:
        return None
    base = (settings.pay52_base_url or "https://api.52pay.com/v1").strip().rstrip("/")
    return Pay52TextRoute(
        api_model=api_model,
        api_key=keys[0],
        url=f"{base}/chat/completions",
        candidate_keys=tuple(keys),
    )


def video_api_key(model: str | None) -> str:
    raw = (model or "").strip()
    from app.settings import settings

    field = _VIDEO.get(raw) or _VIDEO.get(raw.lower())
    if not field:
        return ""
    return _key(settings, field)


def candidate_keys_for_video(model: str | None, cfg: Any | None = None) -> list[str]:
    """Список рабочих и резервных ключей для видео 52pay в порядке приоритета."""
    if cfg is None:
        from app.settings import settings as s
    else:
        s = cfg

    raw = (model or "").strip()
    field = _VIDEO.get(raw) or _VIDEO.get(raw.lower())
    primary = _key(s, field) if field else ""

    keys: list[str] = []
    if primary:
        keys.append(primary)

    fallback_enabled = bool(getattr(s, "pay52_key_fallback_enabled", True))
    if fallback_enabled:
        # Все доступные видео-ключи
        for vkey in (
            getattr(s, "seedance_fast_key", ""),
            getattr(s, "seedance_mini_key", ""),
            getattr(s, "seedance_overseas_key", ""),
            getattr(s, "pay52_gpt_key", ""),
        ):
            val = str(vkey or "").strip()
            if val:
                keys.append(val)

    seen: set[str] = set()
    result: list[str] = []
    for k in keys:
        if k and k not in seen:
            seen.add(k)
            result.append(k)
    return result
