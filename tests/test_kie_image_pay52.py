from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.bots import kie_http
from app.bots.outsee import GenerationResult


@pytest.mark.asyncio
async def test_generate_kie_image_uses_pay52(monkeypatch, tmp_path: Path) -> None:
    from app.settings import settings
    monkeypatch.setattr(settings, "pay52_seedream_key", "test-seedream-key")
    monkeypatch.setattr(settings, "kie_api_key", "")
    monkeypatch.setattr(settings, "gpt_api_key", "")
    out_file = tmp_path / "img.png"

    with patch("app.bots.pay52_image.run_generation", new_callable=AsyncMock) as mock_p52:
        mock_p52.return_value = GenerationResult(
            file_path=out_file, gen_id="pay52-img-123", raw_url="https://img.example/1.png"
        )
        res = await kie_http.generate_kie_image(
            prompt="A majestic lion",
            out_path=out_file,
            model_slug="seedream_5_pro",
        )
        assert mock_p52.called
        assert res.gen_id == "pay52-img-123"


@pytest.mark.asyncio
async def test_generate_kie_image_fallback_to_kie(monkeypatch, tmp_path: Path) -> None:
    from app.settings import settings
    monkeypatch.setattr(settings, "pay52_seedream_key", "test-seedream-key")
    monkeypatch.setattr(settings, "kie_api_key", "test-kie-key")
    out_file = tmp_path / "img.png"

    with patch("app.bots.pay52_image.run_generation", new_callable=AsyncMock) as mock_p52, \
         patch("app.bots.kie_http.run_generation", new_callable=AsyncMock) as mock_kie:
        mock_p52.side_effect = RuntimeError("52pay timed out")
        mock_kie.return_value = GenerationResult(
            file_path=out_file, gen_id="kie-img-456", raw_url="https://kie.example/2.png"
        )
        res = await kie_http.generate_kie_image(
            prompt="A majestic lion",
            out_path=out_file,
            model_slug="seedream_5_pro",
        )
        assert mock_p52.called
        assert mock_kie.called
        assert res.gen_id == "kie-img-456"
