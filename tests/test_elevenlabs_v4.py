"""Тесты для модели ElevenLabs v4 в Create API и каталоге голосов."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import kie_catalog
from app.web.routers import kie_create, voices


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(kie_create.router, prefix="/api")
    app.include_router(voices.router, prefix="/api")
    return app


def test_elevenlabs_v4_catalog_entry() -> None:
    model = kie_catalog.get_model("elevenlabs-v4")
    assert model is not None
    assert model["label"] == "Озвучка ElevenLabs v4"
    assert model["api"] == "elevenlabs"
    assert model["model"] == "eleven_v4"
    assert model["result"] == "audio"
    assert any(f["name"] == "text" for f in model["fields"])
    assert any(f["name"] == "voice_id" for f in model["fields"])
    assert any(f["name"] == "stability" for f in model["fields"])
    assert any(f["name"] == "similarity" for f in model["fields"])


def test_elevenlabs_v4_estimate() -> None:
    model = kie_catalog.get_model("elevenlabs-v4")
    assert model is not None
    est = kie_catalog.estimate_credits(model, {"text": "A" * 1500})
    assert est["credits"] == 6.0  # 3 * 2 (1500 chars = 2 thousands)
    assert est["usd"] > 0


def test_catalog_endpoint_reports_elevenlabs_configured() -> None:
    c = TestClient(_app())
    r = c.get("/api/kie-create/catalog")
    assert r.status_code == 200
    data = r.json()
    assert "elevenlabs_configured" in data
    assert any(m["id"] == "elevenlabs-v4" for m in data["models"])


def test_voices_endpoints() -> None:
    c = TestClient(_app())
    r = c.get("/api/voices/catalog")
    assert r.status_code == 200
    catalog = r.json()
    assert len(catalog) > 0
    first = catalog[0]
    assert "id" in first
    assert "name" in first

    r_one = c.get(f"/api/voices/{first['id']}")
    assert r_one.status_code == 200
    assert r_one.json()["id"] == first["id"]
