"""Дамп актуального промта ноды «Сцены по плану» (без вызова модели)."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

WT = Path(r"C:\Users\Admin\Desktop\video-pipeline\.worktrees\weblocal-8766")
sys.path.insert(0, str(WT))

from app.services.plan_cinema import nodes  # noqa: E402


class P:  # noqa: N801 — простой стенд вместо ORM-модели
    pass


def main() -> None:
    conn = sqlite3.connect(WT / "data" / "state.db")
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "select id, slug, topic, general_plan, meta from projects where id=3"
    ).fetchone()

    project = P()
    project.id = row["id"]
    project.slug = row["slug"]
    project.topic = row["topic"] or ""
    project.general_plan = row["general_plan"] or ""
    project.meta = json.loads(row["meta"] or "{}")
    project.data_dir = str(WT / "data" / "videos" / row["slug"])

    node_key = "n_excel_gpt_pk_scenes"
    spec = nodes._BY_KIND["scenes"]
    master = nodes._read_master(project, node_key, spec)
    plan_text, kind = nodes._source().read_node_input_text(project, node_key)
    prompt = nodes._render(master, ПЛАН=plan_text)

    fence = "```"
    out = WT / "data" / "prompt_scenes_plan_to_scenes.md"
    out.write_text(
        "\n".join(
            [
                "# Промт ноды «Сцены по плану»",
                "",
                "Проект: #3 test-vaha. Файл шаблона: "
                "`templates/node_groups/plan_cinema/plan_to_scenes.md`.",
                "",
                f"Вход (что подставляется в {{{{ПЛАН}}}}): **{kind}**, {len(plan_text)} зн.",
                "",
                "## 1. Мастер-промт (шаблон как уходит в модель)",
                "",
                f"{len(master)} зн.",
                "",
                fence,
                master,
                fence,
                "",
                "## 2. Итоговый промт: шаблон + подставленный вход",
                "",
                f"{len(prompt)} зн. Именно это уходит первым запросом (повторные "
                "попытки добавляют блок «ИСПРАВЬ ПРЕДЫДУЩИЙ ОТВЕТ»).",
                "",
                fence,
                prompt,
                fence,
                "",
            ]
        ),
        encoding="utf-8",
    )
    print("prompt_variant:", spec.prompt_variant)
    print("master chars:", len(master), "| input:", kind, len(plan_text), "| final:", len(prompt))
    print("written:", out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
