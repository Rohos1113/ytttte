"""Запустить ноду «Сцены по плану» у проекта #2 и дождаться результата."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8766"
PROJECT = 2
NODE = "n_excel_gpt_pk_scenes"


def api(path: str, payload: dict | None = None) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"{API}{path}", data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(request, timeout=60) as resp:
        return json.load(resp)


def state() -> tuple[str, str, dict]:
    data = api(f"/api/projects/{PROJECT}")
    meta = data.get("meta") or {}
    scenes = (meta.get("gpt_operator_results") or {}).get(NODE) or {}
    return str(data.get("status") or ""), str(scenes.get("at") or ""), meta


def main() -> None:
    old_status, old_at, _ = state()
    print("до запуска:", old_status, old_at, flush=True)
    started = api(
        f"/api/projects/{PROJECT}/steps/excel_gpt/run"
        f"?node_key={NODE}&mode=resume&only_node=true&force_wipe=true&dry_run=false",
        {},
    )
    print("запуск:", json.dumps(started, ensure_ascii=False)[:300], flush=True)

    deadline = time.monotonic() + 12 * 60
    last = ""
    while time.monotonic() < deadline:
        time.sleep(10)
        try:
            status, at, meta = state()
        except urllib.error.URLError as exc:
            print("api down:", exc, flush=True)
            continue
        pause = meta.get("pause_reason") or {}
        code = pause.get("code") if isinstance(pause, dict) else None
        line = f"{status} | at={at} | pause={code}"
        if line != last:
            print(time.strftime("%H:%M:%S"), line, flush=True)
            last = line
        if at and at != old_at and status not in {"enriching_1"}:
            print("ГОТОВО", flush=True)
            scenes = (meta.get("gpt_operator_results") or {}).get(NODE) or {}
            print(json.dumps(scenes, ensure_ascii=False)[:2000], flush=True)
            return
        if code:
            print("ПАУЗА", json.dumps(pause, ensure_ascii=False)[:1500], flush=True)
            return
    print("ТАЙМАУТ", flush=True)


if __name__ == "__main__":
    main()
