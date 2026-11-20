"""Модуль для преобразования технических ошибок провайдеров и моделей в человекочитаемый вид (без жаргона и дампов JSON).

Используется:
  * Вкладкой «Генерация» (Outsee, KIE, ElevenLabs, Suno, Pay52) — create_jobs.py;
  * Нодами на холсте и каталогом ошибок — error_catalog.py;
  * Чат-оркестратором и суммаризатором — summarizer.py, plain_ru.py.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Регулярные выражения для вычищения технического мусора
_EXCEPTION_PREFIX = re.compile(
    r"^(?:(?:[a-zA-Z_]\w*\.)*[a-zA-Z_]\w*(?:Error|Exception)|HTTPStatusError|StatusError)\s*:\s*",
    re.IGNORECASE,
)
_HTTP_STATUS_PREFIX = re.compile(
    r"^(?:GPT\s+HTTP|HTTP|Status|код)\s*[:=]?\s*(\d{3})\b\s*[:—\-]?\s*",
    re.IGNORECASE,
)
_JSON_BLOCK = re.compile(r"(\{.*\}|\[.*\])", re.DOTALL)
_HTML_TAGS = re.compile(r"<[^>]+>")


def _extract_message_from_json(text: str) -> str:
    """Попытаться извлечь поле 'message', 'msg' или 'error' из вложенного JSON."""
    match = _JSON_BLOCK.search(text)
    if not match:
        return ""
    raw = match.group(1).strip()
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            # Проверяем вложенные объекты: {"error": {"message": "..."}}
            err_obj = data.get("error")
            if isinstance(err_obj, dict):
                msg = err_obj.get("message") or err_obj.get("msg")
                if msg and isinstance(msg, str):
                    return msg.strip()
            if isinstance(err_obj, str) and err_obj.strip():
                return err_obj.strip()
            for key in ("message", "msg", "detail", "error_description"):
                val = data.get(key)
                if isinstance(val, str) and val.strip():
                    return val.strip()
    except Exception:
        pass
    return ""


def humanize_media_job_error(exc_or_text: Any) -> str:
    """Человекочитаемая ошибка для генерации (картинки, видео, аудио, озвучка).

    Никаких 'KieHttpError', '502 Bad Gateway', '{"error": ...}'.
    Только понятный человеку русский текст с рекомендацией.
    """
    if exc_or_text is None:
        return "Генерация не удалась"

    raw = str(getattr(exc_or_text, "reason", None) or exc_or_text).strip()
    if not raw:
        return "Генерация не удалась"

    if "отменен" in raw.lower() or "отменена" in raw.lower() or "cancel" in raw.lower():
        return "Генерация отменена пользователем"

    low = raw.lower()

    # 1. Баланс и кредиты
    if any(k in low for k in (
        "insufficient balance",
        "balance is insufficient",
        "insufficient credit",
        "insufficient_credit",
        "out of credit",
        "quota",
        "credits exhausted",
        "нет кредит",
        "баланс исчерпан",
        "пополните",
        "not enough credits",
        "credit limit",
        "code 4001",
        "4001",
        "spend_cap",
        "бюджет исчерпан",
    )):
        return "Закончились средства на балансе провайдера — пополните счёт"

    # 2. Цензура и модерация
    if any(k in low for k in (
        "moderation",
        "violate",
        "policy",
        "nsfw",
        "sensitive",
        "banned",
        "safety",
        "safety system",
        "content filter",
        "prompt is not safe",
        "отклонён фильтром",
        "модераци",
    )):
        return "Промпт отклонён фильтром безопасности (цензура) — смягчите формулировки"

    # 3. Лимиты запросов (Rate Limit / 429)
    if "429" in low or "rate limit" in low or "too many requests" in low or "concurrent" in low:
        return "Превышен лимит запросов к сервису генерации — подождите 1–2 минуты"

    # 4. Сервер перегружен / упал шлюз (500, 502, 503, 504, Bad Gateway)
    if any(k in low for k in (
        "502 bad gateway",
        "504 gateway",
        "503 service",
        "bad gateway",
        "gateway timeout",
        "internal server error",
        "500 internal",
        "cloudflare",
        "service unavailable",
        "overloaded",
        "upstream_error",
    )) or re.search(r"\b(?:500|502|503|504)\b", low):
        return "Сервер генерации временно перегружен или недоступен — повторите через 1–2 минуты"

    # 5. Ключ API и авторизация
    if any(k in low for k in (
        "apikey error",
        "invalid api key",
        "not authorized",
        "unauthorized",
        "forbidden",
        "401",
        "403",
        "нет api ключ",
        "нет ключа",
        "не настроен",
    )):
        return "Неверный API-ключ или нет доступа к выбранной модели — проверьте настройки"

    # 6. Таймауты
    if "timeout" in low or "timed out" in low or "таймаут" in low or "время ожидания" in low:
        return "Превышено время ожидания ответа генератора — попробуйте повторить"

    # 7. Сеть и подключение
    if any(k in low for k in (
        "connection refused",
        "connection reset",
        "all connection attempts failed",
        "connecterror",
        "сетев",
    )):
        return "Ошибка связи с сервером модели — проверьте интернет-соединение"

    # 8. Слишком длинный промпт / параметры
    if "too long" in low or "prompt length" in low or "слишком длинн" in low:
        return "Промпт слишком длинный для этой модели — сократите описание"

    # 9. Аудио / голос
    if "voice_not_found" in low or "голос не найден" in low:
        return "Выбранный голос не найден в сервисе озвучки — выберите другой голос"

    # Если есть вложенный текст сообщения из JSON, пробуем очистить его
    inner = _extract_message_from_json(raw)
    if inner and len(inner) > 5 and not _JSON_BLOCK.search(inner):
        cleaned = clean_technical_noise(inner)
        if cleaned:
            return cleaned

    # Если уже на русском и понятный — чистим от технических префиксов
    cleaned_raw = clean_technical_noise(raw)
    if re.search(r"[А-Яа-яЁё]", cleaned_raw) and not _JSON_BLOCK.search(cleaned_raw):
        return cleaned_raw[:250].rstrip(".")

    return "Генерация временно не удалась — попробуйте повторить"


def humanize_error(exc_or_text: Any) -> str:
    """Общий преобразователь любых ошибок системы в понятный русский язык."""
    if exc_or_text is None:
        return ""

    raw = str(getattr(exc_or_text, "reason", None) or exc_or_text).strip()
    if not raw:
        return ""

    low = raw.lower()

    # Специфичные проектные ошибки пайплайна
    if "excel_gpt: нет входа" in low or "нет кадров" in low or "кадров нет" in low:
        return "Не хватает входных кадров — сначала запустите предыдущие ноды пайплайна"
    if "у кадров нет данных сцены" in low or "img_pr_no_scene_data" in low:
        return "У кадров нет описания сцен — сначала выполните шаг работы со сценами (GPT)"
    if "модель отказалась работать" in low or "refusal" in low:
        return "Модель не смогла обработать входные данные — проверьте заполненность полей"
    if "бюджет исчерпан" in low or "budget exhausted" in low:
        return "Исчерпан суточный лимит трат проекта — увеличьте лимит в настройках"
    if "database is locked" in low or "база данных занята" in low or "db_locked" in low:
        return "База данных занята параллельной операцией — повторите запуск"
    if "файл не найден" in low or "filenotfounderror" in low or "file_missing" in low:
        return "Входной файл не найден — проверьте связи между нодами"
    if "не json" in low or "нет json" in low or "jsondecodeerror" in low or "bad json" in low:
        return "Модель прислала некорректный ответ — нажмите «Повторить»"

    # Обработка сетевых ошибок и ошибок провайдеров
    media_res = humanize_media_job_error(raw)
    if media_res != "Генерация временно не удалась — попробуйте повторить":
        return media_res

    # Вычищаем технические префиксы
    cleaned = clean_technical_noise(raw)
    if cleaned and re.search(r"[А-Яа-яЁё]", cleaned):
        return cleaned[:250].rstrip(".")

    return "Действие временно не выполнено — попробуйте повторить"


def clean_technical_noise(text: str) -> str:
    """Удалить префиксы исключений, коды HTTP, HTML-теги и фигурные скобки JSON."""
    s = str(text or "").strip()
    if not s:
        return ""

    # Срезаем ActionCallError / RuntimeError / исключения
    s = re.sub(
        r"^(?:(?:[a-zA-Z_]\w*\.)*[a-zA-Z_]\w*(?:Error|Exception)|HTTPStatusError|StatusError)\s*:\s*",
        "",
        s,
        flags=re.I,
    ).strip()

    # Срезаем HTTP 400 Bad Request / 502 / и т.д.
    s = re.sub(r"^(?:(?:GPT\s+)?HTTP\s*)?\d{3}(?:\s+[\w\s]+)?\s*[:—\-]?\s*", "", s, flags=re.I).strip()
    s = _HTML_TAGS.sub("", s).strip()

    # Если строка начинается с JSON-объекта {"error": ...}, достаем суть
    if s.startswith("{") or "{" in s:
        inner = _extract_message_from_json(s)
        if inner:
            s = inner
        else:
            s = _JSON_BLOCK.sub("", s).strip()

    # Убираем кавычки и двоеточия на краях
    s = s.strip(" '\"`:\t\r\n-—")
    return s
