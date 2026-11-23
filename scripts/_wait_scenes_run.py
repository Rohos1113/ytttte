"""Ждать окончания прогона «Сцены по плану» проекта #2 и напечатать состояние."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

API = "http://127.0.0.1:8766"
OLD_AT = "2026-11-22T18:19:57.731164+00:00"
RUNNING = {"enriching_1", "processing", "running", "shots_ready", "images_ready"}


def get(project_id: int = 2) -> dict:
    with urllib.request.urlopen(f"{API}/api/projects/{project_id}", timeout=30) as resp:
        return json.load(resp)


def main() -> None:
    deadline = time.monotonic() + 45 * 60
    last = ""
    while time.monotonic() < deadline:
        try:
            data = get()
        except urllib.error.URLError as exc:
            print("api down:", exc, flush=True)
            time.sleep(20)
            continue
        meta = data.get("meta") or {}
        scenes = (meta.get("gpt_operator_results") or {}).get("n_excel_gpt_pk_scenes") or {}
        status = str(data.get("status") or "")
        at = str(scenes.get("at") or "")
        pause = meta.get("pause_reason") or {}
        state = f"{status} | scenes_at={at} | pause={pause.get('code') if isinstance(pause, dict) else pause}"
        if state != last:
            print(time.strftime("%H:%M:%S"), state, flush=True)
            last = state
        if at and at != OLD_AT and status not in RUNNING:
            print("DONE", flush=True)
            print(
                json.dumps(
                    {"status": status, "scenes": scenes, "pause": pause, "projects": data.get("slug")},
                    ensure_ascii=False,
                )[:4000],
                flush=True,
            )
            return
        if isinstance(pause, dict) and pause.get("code"):
            print("PAUSED", flush=True)
            print(json.dumps({"status": status, "pause": pause, "scenes": scenes}, ensure_ascii=False)[:4000])
            return
        time.sleep(15)
    print("TIMEOUT", flush=True)


if __name__ == "__main__":
    main()
