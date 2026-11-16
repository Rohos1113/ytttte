from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.models import Project
from app.services.elevenlabs_voices import resolve_elevenlabs_voice_id
from app.settings import settings
from app.web.api import create_app


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "elevenlabs_api_key", "")
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def test_voice_lab_list_empty(client: TestClient):
    resp = client.get("/api/voice-lab/voices")
    assert resp.status_code == 200
    data = resp.json()
    assert data["configured"] is False
    assert data["daily_used"] == 0
    assert data["daily_limit"] == 10
    assert data["voices"] == []


def test_voice_lab_create_clone_without_key(client: TestClient, tmp_path: Path):
    sample_bytes = b"ID3\x03\x00\x00\x00\x00\x00\x00FAKE_MP3_DATA"
    files = [
        ("samples", ("test_sample.mp3", io.BytesIO(sample_bytes), "audio/mpeg")),
    ]
    data = {
        "name": "Тестовый голос",
        "description": "Описание клона",
        "language": "ru",
        "kind": "instant",
    }
    resp = client.post("/api/voice-lab/clones", data=data, files=files)
    assert resp.status_code == 201
    res_data = resp.json()
    voice = res_data["voice"]
    assert voice["name"] == "Тестовый голос"
    assert voice["status"] == "pending_provider"
    assert "ELEVENLABS_API_KEY" in (res_data["provider_error"] or "")

    # Проверяем, что клон сохранился на диске
    clone_id = voice["id"]
    clone_dir = tmp_path / "voices" / "clones" / clone_id
    assert clone_dir.exists()
    assert (clone_dir / "meta.json").exists()
    assert (clone_dir / "sample-1.mp3").exists()

    # Проверяем отдачу сэмпла
    sample_resp = client.get(f"/api/voice-lab/clones/{clone_id}/sample?index=0")
    assert sample_resp.status_code == 200
    assert sample_resp.content == sample_bytes


def test_voice_lab_create_clone_success(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(settings, "elevenlabs_api_key", "sk_test_key_1234567890")

    with patch(
        "app.web.routers.voice_lab.create_voice",
        new=AsyncMock(return_value="eleven_voice_abc123456"),
    ):
        sample_bytes = b"ID3_AUDIO_BYTES"
        files = [
            ("samples", ("sample.mp3", io.BytesIO(sample_bytes), "audio/mpeg")),
        ]
        data = {
            "name": "Готовый клон",
            "language": "ru",
        }
        resp = client.post("/api/voice-lab/clones", data=data, files=files)
        assert resp.status_code == 201
        voice = resp.json()["voice"]
        assert voice["status"] == "ready"
        assert voice["external_voice_id"] == "eleven_voice_abc123456"

        # Проверяем, что resolve_elevenlabs_voice_id разрешает локальный id в external_voice_id
        project = Project(topic="test")
        project.meta = {
            "node_step_params": {
                "audio": {"elevenlabs_voice_id": voice["id"]},
            }
        }
        resolved = resolve_elevenlabs_voice_id(project)
        assert resolved == "eleven_voice_abc123456"

        # Проверяем переименование
        patch_resp = client.patch(
            f"/api/voice-lab/clones/{voice['id']}",
            json={"name": "Новое имя клона", "description": "Новое описание"},
        )
        assert patch_resp.status_code == 200
        assert patch_resp.json()["voice"]["name"] == "Новое имя клона"

        # Проверяем удаление
        del_resp = client.delete(f"/api/voice-lab/clones/{voice['id']}")
        assert del_resp.status_code == 200
        assert del_resp.json()["deleted"] is True

        # Проверяем список после удаления
        list_resp = client.get("/api/voice-lab/voices")
        assert len(list_resp.json()["voices"]) == 0


def test_voice_lab_daily_limit(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "elevenlabs_api_key", "sk_test_key")

    with patch(
        "app.web.routers.voice_lab.create_voice",
        new=AsyncMock(return_value="ext_id"),
    ):
        for i in range(10):
            files = [("samples", (f"s{i}.mp3", io.BytesIO(b"audio"), "audio/mpeg"))]
            r = client.post("/api/voice-lab/clones", data={"name": f"Clone {i}"}, files=files)
            assert r.status_code == 201

        # 11-й запрос должен вернуть 429
        files = [("samples", ("s10.mp3", io.BytesIO(b"audio"), "audio/mpeg"))]
        over_resp = client.post("/api/voice-lab/clones", data={"name": "Clone 11"}, files=files)
        assert over_resp.status_code == 429
        assert "Лимит" in over_resp.json()["detail"]


def test_voice_lab_preview(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "elevenlabs_api_key", "sk_test_key")

    with patch(
        "app.web.routers.voice_lab.create_voice",
        new=AsyncMock(return_value="ext_id_preview"),
    ):
        files = [("samples", ("s.mp3", io.BytesIO(b"audio"), "audio/mpeg"))]
        create_resp = client.post("/api/voice-lab/clones", data={"name": "Clone Prev"}, files=files)
        assert create_resp.status_code == 201
        clone_id = create_resp.json()["voice"]["id"]

    with patch(
        "app.web.routers.voice_lab.synthesize_preview",
        new=AsyncMock(side_effect=lambda vid, txt, out: out.write_bytes(b"PREVIEW_MP3")),
    ):
        prev_resp = client.post(
            f"/api/voice-lab/clones/{clone_id}/preview",
            json={"text": "Привет, это образец звучания"},
        )
        assert prev_resp.status_code == 200
        assert "audio_url" in prev_resp.json()

        # Скачиваем аудио превью
        audio_resp = client.get(f"/api/voice-lab/clones/{clone_id}/preview-audio")
        assert audio_resp.status_code == 200
        assert audio_resp.content == b"PREVIEW_MP3"

