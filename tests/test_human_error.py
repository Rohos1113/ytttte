from __future__ import annotations

from app.services.human_error import clean_technical_noise, humanize_error, humanize_media_job_error


def test_humanize_media_balance_error() -> None:
    raw = 'KieHttpError: 400 Bad Request: {"code": 4001, "msg": "account balance is insufficient"}'
    res = humanize_media_job_error(raw)
    assert "Закончились средства на балансе" in res
    assert "KieHttpError" not in res
    assert "4001" not in res


def test_humanize_media_bad_gateway() -> None:
    raw = "httpx.HTTPStatusError: Server error '502 Bad Gateway' for url 'https://api.kie.ai/api/v1/jobs'"
    res = humanize_media_job_error(raw)
    assert "перегружен" in res or "недоступен" in res
    assert "502" not in res
    assert "httpx" not in res


def test_humanize_media_moderation() -> None:
    raw = 'OutseeImageError: 400 Client Error: {"error": "prompt violates content moderation policy"}'
    res = humanize_media_job_error(raw)
    assert "цензура" in res or "безопасности" in res
    assert "OutseeImageError" not in res


def test_humanize_media_rate_limit() -> None:
    raw = "Rate limit reached: 429 Too Many Requests"
    res = humanize_media_job_error(raw)
    assert "лимит запросов" in res


def test_humanize_media_timeout() -> None:
    raw = "httpx.ReadTimeout: The read operation timed out"
    res = humanize_media_job_error(raw)
    assert "ожидания" in res


def test_clean_technical_noise() -> None:
    raw = "ActionCallError: 400 Bad Request: missing_global_context"
    res = clean_technical_noise(raw)
    assert "ActionCallError" not in res
    assert "400" not in res


def test_humanize_error_pipeline_inputs() -> None:
    raw = "excel_gpt: нет входа в ноду «Закадр»: в БД проекта #1 нет кадров"
    res = humanize_error(raw)
    assert "Не хватает входных кадров" in res
