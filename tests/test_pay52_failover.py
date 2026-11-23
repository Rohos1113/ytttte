"""Тесты отказоустойчивости 52pay: умный retry (Вариант 1) и ротация ключей (Вариант 2)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.bots import pay52_video
from app.bots.pay52_video import Pay52VideoError, create_task, pay52_video_candidate_keys, poll_task
from app.services import gpt_api
from app.services.gpt_api import GptApiError
from app.services.llm_override import NodeLlmOverride, use_override
from app.services.pay52_routes import candidate_keys_for_model, candidate_keys_for_video, resolve_text
from app.settings import Settings, settings


def test_pay52_text_candidate_keys_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Settings()
    monkeypatch.setattr(s, "pay52_claude_low_key", "key-claude-low")
    monkeypatch.setattr(s, "pay52_claude_high_key", "key-claude-high")
    monkeypatch.setattr(s, "pay52_gpt_key", "key-gpt-master")
    monkeypatch.setattr(s, "pay52_deepseek_key", "key-deepseek")
    monkeypatch.setattr(s, "pay52_key_fallback_enabled", True)

    # Claude: сначала свой low, затем high, затем master gpt, затем остальные
    keys_claude = candidate_keys_for_model("claude-sonnet-5", cfg=s)
    assert keys_claude[0] == "key-claude-low"
    assert "key-claude-high" in keys_claude
    assert "key-gpt-master" in keys_claude

    # DeepSeek: сначала свой ключ, затем master gpt
    keys_ds = candidate_keys_for_model("deepseek-v4.1-flash", cfg=s)
    assert keys_ds[0] == "key-deepseek"
    assert keys_ds[1] == "key-gpt-master"

    # GPT: мастер-ключ
    keys_gpt = candidate_keys_for_model("gpt-6.1-sol", cfg=s)
    assert keys_gpt[0] == "key-gpt-master"


def test_pay52_video_candidate_keys_priority(monkeypatch: pytest.MonkeyPatch) -> None:
    s = Settings()
    monkeypatch.setattr(s, "seedance_mini_key", "key-mini")
    monkeypatch.setattr(s, "seedance_fast_key", "key-fast")
    monkeypatch.setattr(s, "seedance_overseas_key", "key-overseas")
    monkeypatch.setattr(s, "pay52_gpt_key", "key-gpt-master")
    monkeypatch.setattr(s, "pay52_key_fallback_enabled", True)

    keys_mini = pay52_video_candidate_keys("seedance-2.0-mini", cfg=s)
    assert keys_mini[0] == "key-mini"
    assert "key-fast" in keys_mini
    assert "key-overseas" in keys_mini
    assert "key-gpt-master" in keys_mini

    keys_fast = pay52_video_candidate_keys("seedance-2.0-fast", cfg=s)
    assert keys_fast[0] == "key-fast"
    assert "key-mini" in keys_fast
    assert "key-gpt-master" in keys_fast


@pytest.mark.asyncio
async def test_pay52_video_create_task_retries_on_502(monkeypatch: pytest.MonkeyPatch) -> None:
    """Вариант 1: при 502 Bad Gateway create_task делает повтор с бэкоффом."""
    monkeypatch.setattr(settings, "seedance_fast_key", "test-fast-key")
    monkeypatch.setattr(settings, "pay52_max_retries", 3)
    monkeypatch.setattr(settings, "pay52_retry_backoff_base_s", 0.01)

    calls = 0

    async def fake_post(self, url, headers=None, json=None):
        nonlocal calls
        calls += 1
        if calls == 1:
            req = httpx.Request("POST", url)
            return httpx.Response(502, text="Bad Gateway", request=req)
        req = httpx.Request("POST", url)
        return httpx.Response(200, json={"task_id": "task-xyz-123"}, request=req)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    task_id = await create_task({"model": "seedance-2.0-fast", "prompt": "test"})
    assert task_id == "task-xyz-123"
    assert calls == 2


@pytest.mark.asyncio
async def test_pay52_video_create_task_key_fallback_on_401(monkeypatch: pytest.MonkeyPatch) -> None:
    """Вариант 2: при 401 Unauthorized на первом ключе create_task ротирует на резервный ключ."""
    monkeypatch.setattr(settings, "seedance_fast_key", "primary-bad-key")
    monkeypatch.setattr(settings, "seedance_mini_key", "backup-good-key")
    monkeypatch.setattr(settings, "pay52_key_fallback_enabled", True)
    monkeypatch.setattr(settings, "pay52_retry_backoff_base_s", 0.01)

    used_auth_headers: list[str] = []

    async def fake_post(self, url, headers=None, json=None):
        auth = (headers or {}).get("Authorization", "")
        used_auth_headers.append(auth)
        req = httpx.Request("POST", url)
        if "primary-bad-key" in auth:
            return httpx.Response(401, json={"error": {"message": "Invalid API Key"}}, request=req)
        return httpx.Response(200, json={"task_id": "task-fallback-ok"}, request=req)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    task_id = await create_task({"model": "seedance-2.0-fast", "prompt": "test"})
    assert task_id == "task-fallback-ok"
    assert used_auth_headers == [
        "Bearer primary-bad-key",
        "Bearer backup-good-key",
    ]


@pytest.mark.asyncio
async def test_pay52_text_key_rotation_on_401(monkeypatch: pytest.MonkeyPatch) -> None:
    """Вариант 2 для LLM: при 401 Unauthorized на ключе модели чат переключается на мастер-ключ."""
    monkeypatch.setattr(settings, "pay52_claude_low_key", "bad-claude-key")
    monkeypatch.setattr(settings, "pay52_gpt_key", "good-master-key")
    monkeypatch.setattr(settings, "pay52_key_fallback_enabled", True)
    monkeypatch.setattr(settings, "pay52_retry_backoff_base_s", 0.01)

    ov = NodeLlmOverride(model_id="claude-sonnet-5", channel="stable", kind="text", provider="52pay", label="52pay")
    used_auth: list[str] = []

    async def fake_plain(*, url, headers, body, timeout, use_model):
        auth = headers.get("Authorization", "")
        used_auth.append(auth)
        if "bad-claude-key" in auth:
            raise GptApiError("GPT HTTP 401: Unauthorized", context={"status_code": 401, "retryable": False, "model": use_model})
        return gpt_api.GptChatResult(text="response-from-master-key", model=use_model)

    async def no_budget(kwargs=None):
        return None, None

    monkeypatch.setattr(gpt_api, "_chat_completions_plain", fake_plain)
    monkeypatch.setattr(gpt_api, "_check_budget_before_call", no_budget)

    with use_override(ov):
        res = await gpt_api.chat(prompt="hello", model="claude-sonnet-5")
        assert res.text == "response-from-master-key"
        assert used_auth == [
            "Bearer bad-claude-key",
            "Bearer good-master-key",
        ]


@pytest.mark.asyncio
async def test_pay52_text_retry_on_502(monkeypatch: pytest.MonkeyPatch) -> None:
    """Вариант 1 для LLM: при 502 Bad Gateway чат делает повтор с бэкоффом."""
    monkeypatch.setattr(settings, "pay52_gpt_key", "test-gpt-key")
    monkeypatch.setattr(settings, "pay52_max_retries", 3)
    monkeypatch.setattr(settings, "pay52_retry_backoff_base_s", 0.01)

    ov = NodeLlmOverride(model_id="gpt-6.1-sol", channel="stable", kind="text", provider="52pay", label="52pay")
    attempts = 0

    async def fake_plain(*, url, headers, body, timeout, use_model):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise GptApiError("GPT HTTP 502: Bad Gateway", context={"status_code": 502, "retryable": True, "model": use_model})
        return gpt_api.GptChatResult(text="success-after-retry", model=use_model)

    async def no_budget(kwargs=None):
        return None, None

    monkeypatch.setattr(gpt_api, "_chat_completions_plain", fake_plain)
    monkeypatch.setattr(gpt_api, "_check_budget_before_call", no_budget)

    with use_override(ov):
        res = await gpt_api.chat(prompt="hello", model="gpt-6.1-sol")
        assert res.text == "success-after-retry"
        assert attempts == 2


@pytest.mark.asyncio
async def test_kie_create_fallbacks_to_kie_when_pay52_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Если 52pay падает, генерация автоматически уходит на KIE."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.bots.outsee import GenerationResult
    from app.web.routers import kie_create
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    monkeypatch.setattr(kie_create.pay52_video, "pay52_video_configured", lambda spec: True)
    monkeypatch.setattr(kie_create.kie_http, "kie_configured", lambda: True)

    cj._JOBS.clear()
    cj._SEMS.clear()
    cj._SEM_SIZES.clear()
    cj._RECENT_FP.clear()

    async def fake_pay52_fail(spec, payload, out_path):
        raise Pay52VideoError("52pay server error 500")

    called_kie = False

    async def fake_kie_ok(spec, payload, out_path):
        nonlocal called_kie
        called_kie = True
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00" * 32)
        return GenerationResult(file_path=out_path, gen_id="kie-fallback-1", raw_url=None)

    monkeypatch.setattr(kie_create.pay52_video, "run_generation", fake_pay52_fail)
    monkeypatch.setattr(kie_create.kie_http, "run_generation", fake_kie_ok)

    app = FastAPI()
    app.include_router(kie_create.router, prefix="/api")
    c = TestClient(app)

    r = c.post(
        "/api/kie-create/generate",
        json={
            "model_id": "seedance-2-0",
            "mode": "mini",
            "values": {"prompt": "тестовое видео", "duration": 5},
        },
    )
    assert r.status_code == 200
    assert called_kie is True


@pytest.mark.asyncio
async def test_kie_create_fallbacks_to_pay52_when_kie_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Если KIE выдает ошибку (например 402 нет кредитов), генерация уходит в 52pay."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.bots.kie_http import KieHttpError
    from app.bots.outsee import GenerationResult
    from app.web.routers import kie_create
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    monkeypatch.setattr(kie_create.pay52_video, "pay52_video_configured", lambda spec: True)
    monkeypatch.setattr(kie_create.kie_http, "kie_configured", lambda: True)

    cj._JOBS.clear()
    cj._SEMS.clear()
    cj._SEM_SIZES.clear()
    cj._RECENT_FP.clear()

    called_pay52 = False

    async def fake_kie_fail(spec, payload, out_path):
        raise KieHttpError("kie 402 credits insufficient")

    async def fake_pay52_ok(spec, payload, out_path):
        nonlocal called_pay52
        called_pay52 = True
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"\x00" * 32)
        return GenerationResult(file_path=out_path, gen_id="pay52-fallback-1", raw_url=None)

    monkeypatch.setattr(kie_create.kie_http, "run_generation", fake_kie_fail)
    monkeypatch.setattr(kie_create.pay52_video, "run_generation", fake_pay52_ok)

    # Запускаем через KIE (например is_pay52=False)
    monkeypatch.setattr(kie_create.pay52_video, "pay52_video_configured", lambda spec: False)

    app = FastAPI()
    app.include_router(kie_create.router, prefix="/api")
    c = TestClient(app)

    # При генерации включаем pay52_video_configured внутри
    monkeypatch.setattr(kie_create.pay52_video, "pay52_video_configured", lambda spec: True)

    r = c.post(
        "/api/kie-create/generate",
        json={
            "model_id": "seedance-2-0",
            "mode": "mini",
            "values": {"prompt": "тестовое видео", "duration": 5},
        },
    )
    assert r.status_code == 200
    assert called_pay52 is True

