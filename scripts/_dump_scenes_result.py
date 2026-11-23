"""Полный результат ноды «Сцены по плану» проекта #2 в читаемый markdown.

Читает артефакт с диска и мету проекта из SQLite — студия для дампа не нужна.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

WT = Path(r"C:\Users\Admin\Desktop\video-pipeline\.worktrees\weblocal-8766")

import sys

sys.path.insert(0, str(WT))

from app.web import node_tables  # noqa: E402


def main() -> None:
    db = sqlite3.connect(WT / "data" / "state.db")
    db.row_factory = sqlite3.Row
    project = db.execute("select topic, meta from projects where id=2").fetchone()
    meta = json.loads(project["meta"] or "{}")
    node_result = (meta.get("gpt_operator_results") or {}).get("n_excel_gpt_pk_scenes") or {}

    raw_path = (
        WT
        / "data"
        / "videos"
        / "pavypvya"
        / "excel_gpt_uploads"
        / "n_excel_gpt_pk_scenes"
        / "plan_scenes.json"
    )
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    normalized = node_tables.normalize_document(
        raw_path.read_text(encoding="utf-8"), full=True, name="plan_scenes", with_refs=False
    )
    table = (normalized.get("tables") or [{}])[0]

    lines: list[str] = []
    add = lines.append
    add("# Результат ноды «Сцены по плану» — проект #2 (pavypvya)")
    add("")
    add(f"Прогон: {node_result.get('at') or '—'} (UTC). Модель: gpt-6.1-sol.")
    add(f"Вход: «Тема» — «{project['topic'] or ''}»")
    add(f"Файл результата: `{raw_path}`")
    add("")
    add(
        f"Таблиц в результате: {len(normalized.get('tables') or [])} (одна, как требует владелец). "
        f"Строк: {len(table.get('rows') or [])}, колонок: {len(table.get('columns') or [])}: "
        + ", ".join(str(c.get("key")) for c in table.get("columns") or [])
    )
    add("")
    add("## Пункты плана")
    add("")
    add("| код | текст |")
    add("| --- | --- |")
    for point in raw["пункты"]:
        add(f"| {point['код']} | {point['текст']} |")
    add("")
    add("## Сцены (все переменные ноды)")
    add("")
    for scene in raw["сцены"]:
        add(f"### Сцена {scene['номер']}")
        add("")
        add(f"- **id_плана**: {', '.join(scene['id_плана'])}")
        add(f"- **место**: {scene['место']}")
        add("- **персонажи**: " + (", ".join(scene["персонажи"]) or "—"))
        add("- **предметы**: " + (", ".join(scene["предметы"]) or "—"))
        add(f"- **событие**: {scene['событие']}")
        add(f"- **примечание**: {scene['примечание'] or '—'}")
        add(
            f"- **сцена_вставка**: {scene['сцена_вставка']} | **возврат_к_сцене**: "
            f"{scene['возврат_к_сцене']} | **продолжение_фона**: {scene['продолжение_фона']}"
        )
        add(f"- **кадров_макс**: {scene['кадров_макс']}")
        add("")
        add(scene["сцена"])
        add("")
    add("## Сырой JSON")
    add("")
    add("```json")
    add(json.dumps(raw, ensure_ascii=False, indent=2))
    add("```")

    out = WT / "data" / "результат-сцены-по-плану-проект-2.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("tables:", len(normalized.get("tables") or []), "| rows:", len(table.get("rows") or []))
    print("written:", out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
