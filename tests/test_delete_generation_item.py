from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.generation_storage import (
    build_generation_path,
    delete_generation_item,
    generations_root,
    write_sidecar,
)


@pytest.mark.asyncio
async def test_delete_failed_generation_without_media_file() -> None:
    # Создаем sidecar для ошибочной генерации (медиафайла нет, есть только .json)
    out_path = build_generation_path(media="image", model="test-model", ext="png", job_id="testjob12345")
    side = write_sidecar(
        out_path,
        media="image",
        model="test-model",
        prompt="A test prompt",
        params={},
        quote={},
        provider="outsee",
        status="failed",
        job_id="testjob12345",
        require_file=False,
    )
    assert side.is_file()
    assert not out_path.is_file()  # Медиафайла нет

    # 1. Проверяем удаление по пути (out_path)
    ok = await delete_generation_item(path=str(out_path))
    assert ok is True
    assert not side.is_file()


@pytest.mark.asyncio
async def test_delete_failed_generation_by_job_id() -> None:
    out_path = build_generation_path(media="video", model="test-video", ext="mp4", job_id="myjob98765")
    side = write_sidecar(
        out_path,
        media="video",
        model="test-video",
        prompt="A video prompt",
        params={},
        quote={},
        provider="kie",
        status="failed",
        job_id="myjob98765",
        require_file=False,
    )
    assert side.is_file()

    # Проверяем удаление по job_id
    ok = await delete_generation_item(job_id="myjob98765")
    assert ok is True
    assert not side.is_file()
