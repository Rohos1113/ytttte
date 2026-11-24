import base64
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
import httpx

from app.bots.pay52_image import (
    Pay52ImageError,
    build_pay52_image_payload,
    normalize_pay52_image_model,
    pay52_image_candidate_keys,
    pay52_image_configured,
    pay52_image_key_for_model,
    pay52_image_supports_model,
    run_generation,
)
from app.settings import Settings


def test_pay52_image_supports_model() -> None:
    assert pay52_image_supports_model("seedream-5-pro") is True
    assert pay52_image_supports_model("doubao-seedream-5.0-flash") is True
    assert pay52_image_supports_model("gpt-image-2-5") is True
    assert pay52_image_supports_model("gpt-image-2.5") is True
    assert pay52_image_supports_model("nano-banana-2") is True
    assert pay52_image_supports_model("gemini-3.1-flash-image") is True

    assert pay52_image_supports_model("seedance-2.0-fast") is False
    assert pay52_image_supports_model("kling-v2") is False
    assert pay52_image_supports_model("suno-v4") is False


def test_normalize_pay52_image_model() -> None:
    # Seedream
    assert normalize_pay52_image_model("seedream-5-pro") == "doubao-seedream-5.0-pro"
    assert normalize_pay52_image_model("seedream/5-flash-text-to-image") == "doubao-seedream-5.0-flash"
    assert normalize_pay52_image_model("doubao-seedream-4.0") == "doubao-seedream-4.0"

    # GPT Image
    assert normalize_pay52_image_model("gpt-image-2-5") == "gpt-image-2.5"
    assert normalize_pay52_image_model("gpt-image-2-5", {"quality": "high"}) == "gpt-image-2.5-flare"
    assert normalize_pay52_image_model("gpt-image-2.5-flare") == "gpt-image-2.5-flare"
    assert normalize_pay52_image_model("gpt-image-2", {"resolution": "4K"}) == "gpt-image-2-4k"
    assert normalize_pay52_image_model("gpt-image-2") == "gpt-image-2"

    # Banana / Gemini
    assert normalize_pay52_image_model("nano-banana-2") == "gemini-3.1-flash-image"
    assert normalize_pay52_image_model("nano-banana-pro") == "gemini-3-pro-image-preview"
    assert normalize_pay52_image_model("gemini-nano-banana-2.1") == "gemini-nano-banana-2.1"


def test_pay52_image_key_selection(monkeypatch) -> None:
    monkeypatch.setenv("PAY52_SEEDREAM_KEY", "key-seedream")
    monkeypatch.setenv("PAY52_GPT_IMAGE_KEY", "key-gpt-image")
    monkeypatch.setenv("PAY52_BANANA_KEY", "key-banana")
    monkeypatch.setenv("PAY52_GPT_KEY", "key-master-gpt")
    s = Settings()

    assert pay52_image_key_for_model("seedream-5-pro", cfg=s) == "key-seedream"
    assert pay52_image_key_for_model("gpt-image-2.5", cfg=s) == "key-gpt-image"
    assert pay52_image_key_for_model("nano-banana-2", cfg=s) == "key-banana"

    assert pay52_image_configured("seedream-5-pro", cfg=s) is True
    assert pay52_image_configured("gpt-image-2.5", cfg=s) is True
    assert pay52_image_configured("nano-banana-2", cfg=s) is True
    assert pay52_image_configured("kling-v2", cfg=s) is False

    # Candidate keys
    c_seed = pay52_image_candidate_keys("seedream-5-pro", cfg=s)
    assert c_seed[0] == "key-seedream"
    assert "key-master-gpt" in c_seed

    # Fallback when specific key empty
    monkeypatch.setenv("PAY52_SEEDREAM_KEY", "")
    s_noseed = Settings()
    c_fallback = pay52_image_candidate_keys("seedream-5-pro", cfg=s_noseed)
    assert "key-master-gpt" in c_fallback


def test_build_pay52_image_payload() -> None:
    spec = {"model": "gpt-image-2-5"}
    values = {
        "prompt": "Neon cyberpunk city",
        "aspect_ratio": "9:16",
        "quality": "high",
    }
    payload = build_pay52_image_payload(spec, values)
    assert payload["model"] == "gpt-image-2.5-flare"
    assert payload["prompt"] == "Neon cyberpunk city"
    assert payload["size"] == "1024x1792"
    assert payload["aspect_ratio"] == "9:16"

    # With reference images
    values_i2i = {
        "prompt": "Variation of image",
        "image_urls": ["https://example.com/ref.png"],
    }
    payload_i2i = build_pay52_image_payload({"model": "seedream-5-pro"}, values_i2i)
    assert payload_i2i["model"] == "doubao-seedream-5.0-pro"
    assert payload_i2i["image"] == "https://example.com/ref.png"
    assert payload_i2i["image_urls"] == ["https://example.com/ref.png"]


@pytest.mark.asyncio
async def test_run_generation_b64(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PAY52_GPT_IMAGE_KEY", "test-key")
    s = Settings()
    out_file = tmp_path / "result.png"

    sample_b64 = base64.b64encode(b"FAKE_PNG_IMAGE_BYTES_123456").decode("utf-8")
    mock_resp = httpx.Response(
        status_code=200,
        json={"data": [{"b64_json": sample_b64}]},
        request=httpx.Request("POST", "https://api.52pay.com/v1/images/generations"),
    )

    with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        spec = {"model": "gpt-image-2-5"}
        values = {"prompt": "a sunset"}
        res = await run_generation(spec, values, out_file, cfg=s)

        assert res.file_path == out_file
        assert out_file.exists()
        assert out_file.read_bytes() == b"FAKE_PNG_IMAGE_BYTES_123456"
        assert res.gen_id.startswith("pay52-img-")


@pytest.mark.asyncio
async def test_run_generation_url(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PAY52_SEEDREAM_KEY", "test-key")
    s = Settings()
    out_file = tmp_path / "result.jpg"

    mock_resp = httpx.Response(
        status_code=200,
        json={"data": [{"url": "https://cdn.example.com/generated.jpg"}]},
        request=httpx.Request("POST", "https://api.52pay.com/v1/images/generations"),
    )
    mock_dl = httpx.Response(
        status_code=200,
        content=b"JPEG_BINARY_DATA_XYZ",
        request=httpx.Request("GET", "https://cdn.example.com/generated.jpg"),
    )

    with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as mock_post, \
         patch.object(httpx.AsyncClient, "get", new_callable=AsyncMock) as mock_get:
        mock_post.return_value = mock_resp
        mock_get.return_value = mock_dl

        spec = {"model": "doubao-seedream-5.0-flash"}
        values = {"prompt": "a bird"}
        res = await run_generation(spec, values, out_file, cfg=s)

        assert res.file_path == out_file
        assert out_file.read_bytes() == b"JPEG_BINARY_DATA_XYZ"
        assert res.raw_url == "https://cdn.example.com/generated.jpg"


@pytest.mark.asyncio
async def test_run_generation_key_fallback(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PAY52_SEEDREAM_KEY", "bad-key")
    monkeypatch.setenv("PAY52_GPT_KEY", "good-key")
    s = Settings()
    out_file = tmp_path / "fallback.png"

    sample_b64 = base64.b64encode(b"FALLBACK_IMAGE_DATA").decode("utf-8")
    resp_401 = httpx.Response(
        status_code=401,
        text="Invalid key",
        request=httpx.Request("POST", "https://api.52pay.com/v1/images/generations"),
    )
    resp_200 = httpx.Response(
        status_code=200,
        json={"data": [{"b64_json": sample_b64}]},
        request=httpx.Request("POST", "https://api.52pay.com/v1/images/generations"),
    )

    with patch.object(httpx.AsyncClient, "post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = [resp_401, resp_200]
        spec = {"model": "doubao-seedream-5.0-flash"}
        values = {"prompt": "test fallback"}
        res = await run_generation(spec, values, out_file, cfg=s)

        assert mock_post.call_count == 2
        assert out_file.read_bytes() == b"FALLBACK_IMAGE_DATA"
