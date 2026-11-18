"""Параллельная очередь Create: семафор, waiting/running, отдельные job_id."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest


def _reset_create_jobs(
    monkeypatch,
    *,
    outsee: int = 2,
    minimax: int = 10,
) -> None:
    from app.services import create_jobs as cj

    monkeypatch.setattr(cj.settings, "create_max_parallel", max(outsee, minimax))
    monkeypatch.setattr(cj.settings, "create_max_parallel_outsee", outsee)
    cj._JOBS.clear()
    cj._SEMS.clear()
    cj._SEM_SIZES.clear()
    cj._TASKS.clear()
    cj._RECENT_FP.clear()


@pytest.mark.asyncio
async def test_enqueue_dedups_identical_request_within_window(tmp_path: Path, monkeypatch) -> None:
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    _reset_create_jobs(monkeypatch, outsee=2)

    async def slow_run(out_path: Path):
        class R:
            file_path = out_path
            raw_url = None

        out_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        await asyncio.sleep(0.05)
        return R()

    kwargs = dict(
        media="image",
        model="gpt-image-2",
        provider="outsee",
        prompt="одинаковый",
        ext=".png",
        params={"aspect": "16:9"},
        quote=None,
        run=slow_run,
    )
    a = await cj.enqueue_generation(**kwargs)
    b = await cj.enqueue_generation(**kwargs)
    assert a.id == b.id
    await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_enqueue_respects_max_parallel_and_unique_ids(tmp_path: Path, monkeypatch) -> None:
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    _reset_create_jobs(monkeypatch, outsee=2)

    gate = asyncio.Event()
    started: list[str] = []

    async def slow_run(out_path: Path):
        started.append(out_path.name)

        class R:
            file_path = out_path
            raw_url = None

        out_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        await gate.wait()
        return R()

    jobs = []
    for i in range(3):
        job = await cj.enqueue_generation(
            media="image",
            model="gpt-image-2",
            provider="outsee",
            prompt=f"prompt-{i}",
            ext=".png",
            params=None,
            quote=None,
            run=slow_run,
        )
        jobs.append(job)

    assert len({j.id for j in jobs}) == 3

    for _ in range(50):
        snap = cj.queue_snapshot(provider="outsee")
        if snap["running_count"] == 2 and snap["waiting_count"] == 1:
            break
        await asyncio.sleep(0.02)
    else:
        snap = cj.queue_snapshot(provider="outsee")
        pytest.fail(
            f"expected 2 running + 1 waiting, got "
            f"run={snap['running_count']} wait={snap['waiting_count']} "
            f"statuses={[j.status for j in jobs]}"
        )

    assert snap["max_parallel"] == 2
    assert snap["max_parallel_outsee"] == 2
    waiting = snap["waiting"]
    assert len(waiting) == 1
    assert waiting[0]["queue_position"] == 1
    assert waiting[0]["status"] == "queued"
    assert all(j["status"] == "processing" for j in snap["running"])

    gate.set()
    for _ in range(100):
        if all(j.status in {"done", "failed"} for j in jobs):
            break
        await asyncio.sleep(0.02)
    assert all(j.status == "done" for j in jobs)
    assert len(started) == 3
    final = cj.queue_snapshot()
    assert final["total_active"] == 0
    assert len(cj._TASKS) == 0


@pytest.mark.asyncio
async def test_outsee_and_minimax_use_separate_pools(tmp_path: Path, monkeypatch) -> None:
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    _reset_create_jobs(monkeypatch, outsee=1, minimax=2)

    gate = asyncio.Event()

    async def slow_run(out_path: Path):
        class R:
            file_path = out_path
            raw_url = None

        out_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        await gate.wait()
        return R()

    # 2 outsee при лимите 1 → 1 running + 1 waiting
    o1 = await cj.enqueue_generation(
        media="image",
        model="gpt-image-2",
        provider="outsee",
        prompt="o1",
        ext=".png",
        params=None,
        quote=None,
        run=slow_run,
    )
    o2 = await cj.enqueue_generation(
        media="image",
        model="gpt-image-2",
        provider="outsee",
        prompt="o2",
        ext=".png",
        params=None,
        quote=None,
        run=slow_run,
    )
    # minimax не должен ждать outsee-слот
    g1 = await cj.enqueue_generation(
        media="image",
        model="gpt-image-2",
        provider="minimax",
        prompt="g1",
        ext=".png",
        params=None,
        quote=None,
        run=slow_run,
    )

    for _ in range(50):
        so = cj.queue_snapshot(provider="outsee")
        sg = cj.queue_snapshot(provider="minimax")
        if so["running_count"] == 1 and so["waiting_count"] == 1 and sg["running_count"] == 1:
            break
        await asyncio.sleep(0.02)
    else:
        so = cj.queue_snapshot(provider="outsee")
        sg = cj.queue_snapshot(provider="minimax")
        pytest.fail(f"outsee={so} minimax={sg} statuses o={[o1.status, o2.status]} g={g1.status}")

    assert cj.max_parallel("outsee") == 1
    assert cj.max_parallel("minimax") == 2
    gate.set()
    for _ in range(100):
        if all(j.status in {"done", "failed"} for j in (o1, o2, g1)):
            break
        await asyncio.sleep(0.02)
    assert all(j.status == "done" for j in (o1, o2, g1))


@pytest.mark.asyncio
async def test_queue_snapshot_empty_when_idle(monkeypatch, tmp_path: Path) -> None:
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    _reset_create_jobs(monkeypatch, outsee=5, minimax=10)
    snap = cj.queue_snapshot()
    assert snap["running"] == []
    assert snap["waiting"] == []
    assert snap["running_count"] == 0
    assert snap["waiting_count"] == 0
    assert snap["max_parallel_outsee"] == 5
    assert snap["max_parallel"] == 10


@pytest.mark.asyncio
async def test_queue_snapshot_isolates_by_client_id(monkeypatch, tmp_path: Path) -> None:
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    _reset_create_jobs(monkeypatch, outsee=5, minimax=10)

    gate = asyncio.Event()

    async def waiting_run(out_path: Path):
        class R:
            file_path = out_path
            raw_url = None

        out_path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        await gate.wait()
        return R()

    job_a = await cj.enqueue_generation(
        media="image",
        model="gpt-image-2",
        provider="outsee",
        prompt="промпт клиента А",
        ext=".png",
        params={"aspect": "16:9"},
        quote=None,
        run=waiting_run,
        client_id="client_a",
    )
    await asyncio.sleep(0.02)

    # Клиент B запрашивает очередь: видит running_count=1 (сервер занят), но в running чужой задачи нет!
    snap_b = cj.queue_snapshot(client_id="client_b")
    assert snap_b["running_count"] == 1
    assert snap_b["running"] == []

    # Клиент A запрашивает очередь: видит свою задачу
    snap_a = cj.queue_snapshot(client_id="client_a")
    assert snap_a["running_count"] == 1
    assert len(snap_a["running"]) == 1
    assert snap_a["running"][0]["job_id"] == job_a.id
    assert snap_a["running"][0]["prompt_preview"] == "промпт клиента А"

    gate.set()
    await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_get_job_recovers_from_disk_after_memory_wipe(monkeypatch, tmp_path: Path) -> None:
    from app.services import create_jobs as cj
    from app.services import generation_storage as gs

    monkeypatch.setattr(gs.settings, "data_dir", tmp_path)
    _reset_create_jobs(monkeypatch, outsee=5)

    async def instant_run(out_path: Path):
        class R:
            file_path = out_path
            raw_url = "https://cdn.example.com/video.mp4"

        out_path.write_bytes(b"\x00" * 128)
        return R()

    job = await cj.enqueue_generation(
        media="video",
        model="kling-2.6",
        provider="kie",
        prompt="тест восстановления после рестарта",
        ext=".mp4",
        params={"resolution": "720p"},
        quote={"credits": 10, "usd": 0.05, "note": ""},
        run=instant_run,
        client_id="client_test",
    )
    # Ждём завершения задачи
    await asyncio.sleep(0.1)
    assert job.status == "done"

    # 1. Поиск по точному ID и по history_id в живой памяти
    assert cj.get_job(job.id) is not None
    assert cj.get_job(job.history_id) is not None

    # 2. Имитируем перезапуск сервера: память _JOBS полностью очищена
    cj._JOBS.clear()
    assert len(cj._JOBS) == 0

    # 3. get_job должен найти сайдкар на диске и восстановить статус
    recovered_by_id = cj.get_job(job.id)
    assert recovered_by_id is not None
    assert recovered_by_id.status == "done"
    assert recovered_by_id.model == "kling-2.6"
    assert recovered_by_id.provider == "kie"
    assert recovered_by_id.history_id == job.history_id

    recovered_by_hist = cj.get_job(job.history_id)
    assert recovered_by_hist is not None
    assert recovered_by_hist.status == "done"
    assert recovered_by_hist.id == job.id
