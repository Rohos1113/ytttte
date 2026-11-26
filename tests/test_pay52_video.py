import pytest

from app.bots.pay52_video import (
    Pay52VideoError,
    build_pay52_video_payload,
    pay52_video_key_for_model,
)
from app.settings import Settings


def test_pay52_video_key_selection(monkeypatch) -> None:
    monkeypatch.setenv("SEEDANCE_MINI_KEY", "key-mini")
    monkeypatch.setenv("SEEDANCE_FAST_KEY", "key-fast")
    monkeypatch.setenv("SEEDANCE_OVERSEAS_KEY", "key-overseas")
    s = Settings()

    assert pay52_video_key_for_model("seedance-2.0-mini", cfg=s) == "key-mini"
    assert pay52_video_key_for_model("seedance-2.0-mini-ref", cfg=s) == "key-mini"
    assert pay52_video_key_for_model("seedance-2-0-mini", cfg=s) == "key-mini"
    assert pay52_video_key_for_model("Seedance 2.0 Fast 海外", cfg=s) == "key-fast"
    assert pay52_video_key_for_model("seedance-2-0-fast-overseas", cfg=s) == "key-fast"
    assert pay52_video_key_for_model("Seedance 2.0 海外", cfg=s) == "key-overseas"
    assert pay52_video_key_for_model("seedance-2-0-overseas", cfg=s) == "key-overseas"
    assert pay52_video_key_for_model("seedance-2.5", cfg=s) == "key-overseas"

    # Fallback на fast key, если mini key пустой
    monkeypatch.setenv("SEEDANCE_MINI_KEY", "")
    s_nofast = Settings()
    assert pay52_video_key_for_model("seedance-2.0-mini", cfg=s_nofast) == "key-fast"


def test_build_payload_seedance_mini() -> None:
    spec = {"model": "seedance-2.0-mini"}
    values = {
        "prompt": "Cinematic sunset",
        "seconds": 8,
        "aspect_ratio": "16:9",
        "resolution": "720p",
        "first_frame_url": "https://img.example/start.png",
        "last_frame_url": "https://img.example/end.png",
        "reference_image_urls": ["https://img.example/ref1.png", "https://img.example/ref2.png"],
        "reference_video_urls": ["https://img.example/vid1.mp4"],
        "reference_audio_urls": ["https://img.example/aud1.mp3"],
    }

    payload = build_pay52_video_payload(spec, values)
    assert payload["model"] == "seedance-2.0-mini"
    assert payload["prompt"] == "Cinematic sunset"
    assert payload["seconds"] == "8"
    assert payload["aspect_ratio"] == "16:9"
    assert payload["resolution"] == "720p"

    content = payload["metadata"]["content"]
    assert {"role": "first_frame", "url": "https://img.example/start.png"} in content
    assert {"role": "last_frame", "url": "https://img.example/end.png"} in content
    assert {"role": "reference_image", "url": "https://img.example/ref1.png"} in content
    assert {"role": "reference_video", "url": "https://img.example/vid1.mp4"} in content
    assert {"role": "reference_audio", "url": "https://img.example/aud1.mp3"} in content


def test_build_payload_seedance_mini_rejects_audio_alone() -> None:
    spec = {"model": "seedance-2.0-mini"}
    values = {
        "prompt": "Talking head",
        "reference_audio_urls": ["https://img.example/aud1.mp3"],
    }
    with pytest.raises(Pay52VideoError, match="аудио не может передаваться без изображения"):
        build_pay52_video_payload(spec, values)


def test_build_payload_seedance_fast_overseas() -> None:
    spec = {"model": "Seedance 2.0 Fast 海外"}
    values = {
        "prompt": "Portrait of a smiling woman walking in Tokyo",
        "duration": 6,
        "ratio": "9:16",
        "resolution": "720p",
        "first_frame": "https://img.example/face1.png",
        "reference_images": ["https://img.example/face2.png"],
        "reference_videos": ["https://img.example/vid.mp4"],
        "reference_audios": ["https://img.example/aud.mp3"],
    }

    payload = build_pay52_video_payload(spec, values)
    assert payload["model"] == "seedance-2.0-fast"
    assert payload["prompt"] == "Portrait of a smiling woman walking in Tokyo"
    assert payload["duration"] == 6
    assert payload["ratio"] == "9:16"
    assert payload["resolution"] == "720p"
    assert payload["referenceImages"] == [
        "https://img.example/face1.png",
        "https://img.example/face2.png",
    ]
    assert payload["referenceVideos"] == ["https://img.example/vid.mp4"]
    assert payload["referenceAudios"] == ["https://img.example/aud.mp3"]


def test_build_payload_seedance_overseas_1080p() -> None:
    spec = {"model": "Seedance 2.0 海外"}
    values = {
        "prompt": "Ultra HD nature scenery",
        "duration": 10,
        "ratio": "16:9",
        "resolution": "1080p",
    }
    payload = build_pay52_video_payload(spec, values)
    assert payload["model"] == "seedance-2.0-fast"
    assert payload["duration"] == 10
    assert payload["resolution"] == "1080p"


def test_build_payload_seedance_2_5_resolutions() -> None:
    spec = {"model": "seedance-2.5"}
    for res in ("480p", "720p", "1080p"):
        p = build_pay52_video_payload(spec, {"prompt": "ocean wave", "seconds": 5, "resolution": res})
        assert p["model"] == "seedance-2.5"
        assert p["resolution"] == res
    # fallback to 720p on unknown resolution
    p_def = build_pay52_video_payload(spec, {"prompt": "ocean wave", "seconds": 5, "resolution": "unknown_res"})
    assert p_def["resolution"] == "720p"


def test_kie_http_resolves_all_curated_video_families() -> None:
    from app.bots.kie_http import _resolve_kie_video_spec

    for fid in (
        "veo-3-1",
        "seedance-2-0",
        "seedance-2-0-fast",
        "seedance-2-5",
        "kling-2-6",
        "kling-3-0",
        "kling-4-0",
        "hailuo-2-3-i2v",
        "minimax-h3-t2v",
        "wan-3-0",
    ):
        spec_no_frame = _resolve_kie_video_spec(fid, has_start_frame=False)
        spec_with_frame = _resolve_kie_video_spec(fid, has_start_frame=True)
        assert spec_no_frame is not None and spec_no_frame.get("model"), fid
        assert spec_with_frame is not None and spec_with_frame.get("model"), fid
        assert any(
            f.get("kind") == "images" for f in (spec_with_frame.get("fields") or [])
        ), fid


@pytest.mark.asyncio
async def test_create_task_rotates_on_400_invalid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    from app.bots import pay52_video

    monkeypatch.setattr(pay52_video.settings, "seedance_overseas_key", "bad-key")
    monkeypatch.setattr(pay52_video.settings, "seedance_fast_key", "good-key")
    monkeypatch.setattr(pay52_video.settings, "pay52_key_fallback_enabled", True)

    calls: list[str] = []

    class DummyResponse:
        def __init__(self, status_code: int, json_data: dict) -> None:
            self.status_code = status_code
            self._json = json_data
            self.text = str(json_data)

        def json(self) -> dict:
            return self._json

    class DummyClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "DummyClient":
            return self

        async def __aexit__(self, *exc: object) -> None:
            pass

        async def post(self, url: str, headers: dict | None = None, json: dict | None = None) -> DummyResponse:
            auth = (headers or {}).get("Authorization", "")
            calls.append(auth)
            if "bad-key" in auth:
                return DummyResponse(400, {"error": {"message": "密钥无效。请检查 API Key 是否复制完整，以及是否已禁用或过期。"}})
            return DummyResponse(200, {"id": "task_12345"})

    monkeypatch.setattr(httpx, "AsyncClient", DummyClient)

    task_id = await pay52_video.create_task({"model": "seedance-2.5", "prompt": "test"})
    assert task_id == "task_12345"
    assert len(calls) == 2
    assert "bad-key" in calls[0]
    assert "good-key" in calls[1]


@pytest.mark.asyncio
async def test_poll_task_rotates_on_400_invalid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    import httpx

    from app.bots import pay52_video

    monkeypatch.setattr(pay52_video.settings, "seedance_overseas_key", "bad-key")
    monkeypatch.setattr(pay52_video.settings, "seedance_fast_key", "good-key")
    monkeypatch.setattr(pay52_video.settings, "pay52_key_fallback_enabled", True)

    calls: list[str] = []

    class DummyResponse:
        def __init__(self, status_code: int, json_data: dict, text: str = "") -> None:
            self.status_code = status_code
            self._json = json_data
            self.text = text or str(json_data)

        def json(self) -> dict:
            return self._json

    class DummyClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "DummyClient":
            return self

        async def __aexit__(self, *exc: object) -> None:
            pass

        async def get(self, url: str, headers: dict | None = None) -> DummyResponse:
            auth = (headers or {}).get("Authorization", "")
            calls.append(auth)
            if "bad-key" in auth:
                return DummyResponse(400, {"error": "Invalid token"}, text="Invalid token")
            return DummyResponse(200, {"status": "SUCCESS", "video_url": "https://video.example/1.mp4"})

    monkeypatch.setattr(httpx, "AsyncClient", DummyClient)

    url = await pay52_video.poll_task("task_abc", model_name="seedance-2.5", timeout_s=5.0)
    assert url == "https://video.example/1.mp4"
    assert len(calls) == 2
    assert "bad-key" in calls[0]
    assert "good-key" in calls[1]


def test_kling_4_support_and_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.bots.pay52_video import (
        normalize_pay52_video_model,
        pay52_video_supports_model,
    )

    monkeypatch.setenv("SEEDANCE_OVERSEAS_KEY", "key-overseas")
    s = Settings()

    assert pay52_video_supports_model("kling-4-0") is True
    assert pay52_video_supports_model("kling-4.0") is True
    assert pay52_video_supports_model("kling-4.0/keyframe-to-video") is True
    assert pay52_video_supports_model("kling-3-0") is False
    assert pay52_video_supports_model("kling-3.0/video") is False

    assert pay52_video_key_for_model("kling-4-0", cfg=s) == "key-overseas"
    assert pay52_video_key_for_model("kling-4.0", cfg=s) == "key-overseas"
    assert pay52_video_key_for_model("kling-3-0", cfg=s) == ""

    assert normalize_pay52_video_model("kling-4.0-k1") == "kling-4.0"
    assert normalize_pay52_video_model("kling-4-0") == "kling-4.0"

    # Text to video payload (duration < 5 clamped to 5)
    spec = {"model": "kling-4.0"}
    p_text = build_pay52_video_payload(spec, {"prompt": "A running horse", "duration": 3, "aspect_ratio": "16:9"})
    assert p_text["model"] == "kling-4.0"
    assert p_text["prompt"] == "A running horse"
    assert p_text["duration"] == 5
    assert p_text["ratio"] == "16:9"
    assert "referenceImages" not in p_text

    # Image to video payload
    p_img = build_pay52_video_payload(
        spec,
        {
            "prompt": "Animate this painting",
            "first_frame_url": "https://img.example/frame.png",
            "duration": 5,
            "resolution": "720p",
        },
    )
    assert p_img["model"] == "kling-4.0"
    assert p_img["referenceImages"] == ["https://img.example/frame.png"]
    assert p_img["image_url"] == "https://img.example/frame.png"



