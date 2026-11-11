"""HTML-отчёт группы «Кино по плану» (plan_cinema).

Пишется кодом, без GPT. Источник данных — только то, что лежит в проекте:
сцены ``Frame.attrs``, кадры ``attrs["кадры"]``, персонажи и фоны ``Entity``,
вердикты QC (``qc_report.json``) и отчёт стиля (``style_report.json``).

Зачем свой шаблон: общий ``shots_report`` описывает старую цепочку с закадром,
её таблица контракта и колонка VO в этом режиме не существуют. Здесь нет ни
слова «закадр»: сцена — действие, кадры — изображение, речь — диалог.
"""

from __future__ import annotations

import html
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from app.services.plan_cinema.source import read_plan_text

REPORT_NAME = "shots-report.html"
UPLOADS_DIR = "excel_gpt_uploads"

_CSS = """
:root { color-scheme: light; }
body { margin:0; padding:24px 32px 64px; font:14px/1.5 "Segoe UI", Arial, sans-serif;
       color:#1c1f23; background:#f6f7f9; }
h1 { font-size:22px; margin:0 0 4px; }
h2 { font-size:17px; margin:28px 0 8px; padding-bottom:6px; border-bottom:1px solid #d6dae0; }
.meta { color:#5a6270; font-size:13px; margin-bottom:18px; }
.tiles { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:8px; }
.tile { background:#fff; border:1px solid #dfe3e8; border-radius:8px; padding:8px 12px; min-width:96px; }
.tile b { display:block; font-size:20px; line-height:1.2; }
.tile span { color:#5a6270; font-size:12px; }
.card { background:#fff; border:1px solid #dfe3e8; border-radius:10px; padding:14px 16px; margin:12px 0 18px; }
.scene-head { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
.badge { border-radius:999px; padding:1px 9px; font-size:12px; font-weight:600; }
.ok { background:#e6f4ea; color:#1e6b34; }
.warn { background:#fff4e0; color:#8a5a00; }
.bad { background:#fde8e8; color:#8b1e1e; }
.muted { color:#5a6270; }
table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
th, td { text-align:left; vertical-align:top; border-top:1px solid #e6e9ed; padding:6px 8px; }
th { background:#f2f4f7; font-weight:600; }
td.num { width:38px; color:#5a6270; }
.prompt { color:#3d4652; font-size:12px; max-height:120px; overflow:hidden; }
.dialogue { margin:6px 0 0; padding-left:18px; }
.dialogue li { margin:2px 0; }
footer { margin-top:28px; color:#5a6270; font-size:12px; }
code { background:#eef0f3; border-radius:4px; padding:0 4px; }
"""


def _esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def _text(value: Any) -> str:
    return " ".join(str(value or "").split())


def report_path(project: Any) -> Path:
    return Path(project.data_dir) / "reports" / REPORT_NAME


def _read_upload(project: Any, name: str) -> dict[str, Any]:
    """Новейший артефакт ``name`` из папок нод проекта (ключ ноды не важен)."""
    root = Path(project.data_dir) / UPLOADS_DIR
    if not root.is_dir():
        return {}
    candidates = [path for path in root.glob(f"*/{name}") if path.is_file()]
    if not candidates:
        return {}
    path = max(candidates, key=lambda item: item.stat().st_mtime)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _qc_by_scene(project: Any) -> dict[int, dict[str, Any]]:
    data = _read_upload(project, "qc_report.json")
    rows = data.get("сцены") if isinstance(data, dict) else None
    out: dict[int, dict[str, Any]] = {}
    for row in rows or []:
        if isinstance(row, dict) and row.get("номер") is not None:
            out[int(row["номер"])] = row
    return out


def _style_report(project: Any) -> dict[str, Any]:
    return _read_upload(project, "style_report.json")


def _speech_html(speech: Any) -> str:
    if not isinstance(speech, dict):
        return '<p class="muted">речи нет</p>'
    kind = str(speech.get("тип") or "нет")
    lines = [row for row in speech.get("реплики") or [] if isinstance(row, dict)]
    if kind == "нет" or not lines:
        return '<p class="muted">речь: нет (сцена играется действием)</p>'
    items = "".join(
        f"<li><b>{_esc(_text(row.get('кто')))}</b>: «{_esc(_text(row.get('текст')))}»"
        f"<span class=\"muted\"> — {_esc(_text(row.get('эмоция')))}</span></li>"
        for row in lines
    )
    return f'<p class="muted">речь: {_esc(kind)}</p><ul class="dialogue">{items}</ul>'


def _shots_table(kadry: list[Any]) -> str:
    if not kadry:
        return '<p class="muted">кадров нет</p>'
    head = (
        "<tr><th>№</th><th>План</th><th>Ракурс</th><th>Действие</th>"
        "<th>Реплика</th><th>Промт кадра</th></tr>"
    )
    rows: list[str] = []
    for index, shot in enumerate(kadry, 1):
        if not isinstance(shot, dict):
            continue
        prompt = _text(
            shot.get("промт_картинки") or shot.get("промт_старт") or shot.get("промт")
        )
        voice = ""
        if _text(shot.get("реплика")):
            voice = (
                f"{_esc(_text(shot.get('говорит')))}: «{_esc(_text(shot.get('реплика')))}»"
            )
        rows.append(
            "<tr>"
            f'<td class="num">{index}</td>'
            f"<td>{_esc(_text(shot.get('план')))}</td>"
            f"<td>{_esc(_text(shot.get('ракурс')))}</td>"
            f"<td>{_esc(_text(shot.get('действие')))}</td>"
            f"<td>{voice}</td>"
            f'<td class="prompt">{_esc(prompt)}</td>'
            "</tr>"
        )
    return f"<table><thead>{head}</thead><tbody>{''.join(rows)}</tbody></table>"


def _qc_badge(qc: dict[str, Any] | None) -> str:
    if not qc:
        return '<span class="badge warn">QC не записан</span>'
    verdict = str(qc.get("verdict") or "")
    label = {"pass": "QC: pass", "warn": "QC: warn", "fail": "QC: fail"}.get(
        verdict, f"QC: {verdict or '—'}"
    )
    css = {"pass": "ok", "warn": "warn", "fail": "bad"}.get(verdict, "warn")
    return f'<span class="badge {css}">{_esc(label)}</span>'


def _qc_block(qc: dict[str, Any] | None) -> str:
    if not qc:
        return ""
    violations = [row for row in qc.get("violations") or [] if isinstance(row, dict)]
    if not violations:
        return ""
    items = "".join(
        f"<li><code>{_esc(_text(row.get('code')))}</code> "
        f"{_esc(_text(row.get('shot')))}: {_esc(_text(row.get('detail')))}</li>"
        for row in violations
    )
    return f'<ul class="dialogue">{items}</ul>'


def build_report(
    project: Any,
    *,
    scenes: list[Any],
    characters: dict[str, Any],
    backgrounds: dict[str, Any],
) -> str:
    """Собрать HTML отчёта по сценам и кадрам проекта."""
    from app.services.plan_cinema.nodes import _frames_of, _scene_dict, _speech_of

    qc_map = _qc_by_scene(project)
    style = _style_report(project)
    plan_text = ""
    try:
        plan_text = read_plan_text(project)
    except (FileNotFoundError, ValueError):
        plan_text = ""

    scene_rows = [(_scene_dict(frame), _speech_of(frame), _frames_of(frame)) for frame in scenes]
    shots_total = sum(len(kadry) for _, _, kadry in scene_rows)
    speech_total = sum(
        1 for _, speech, _ in scene_rows if isinstance(speech, dict) and speech.get("тип") not in (None, "нет")
    )
    qc_pass = sum(1 for qc in qc_map.values() if str(qc.get("verdict")) == "pass")
    plan_points = [
        line.strip()
        for line in plan_text.splitlines()
        if line.strip()[:2].rstrip(".").isdigit() or line.strip().startswith("P")
    ]

    out: list[str] = []
    out.append("<!doctype html><html lang=ru><head><meta charset=utf-8>")
    out.append(f"<title>Кино по плану · {_esc(getattr(project, 'slug', ''))}</title>")
    out.append(f"<style>{_CSS}</style></head><body>")
    out.append("<h1>Кино по плану — отчёт по сценам и кадрам</h1>")
    out.append(
        '<p class="meta">Проект '
        f"#{_esc(getattr(project, 'id', '?'))} · {_esc(getattr(project, 'slug', ''))} · "
        f"{_esc(datetime.now().strftime('%d.%m.%Y %H:%M'))} · цепочка из 9 нод, без закадрового текста.</p>"
    )
    out.append('<div class="tiles">')
    for value, caption in (
        (len(plan_points), "пунктов плана"),
        (len(scene_rows), "сцен"),
        (shots_total, "кадров"),
        (len(characters), "персонажей"),
        (len(backgrounds), "фонов"),
        (f"{qc_pass}/{len(scene_rows)}", "QC pass"),
    ):
        out.append(f'<div class="tile"><b>{_esc(value)}</b><span>{_esc(caption)}</span></div>')
    out.append("</div>")

    style_name = str(style.get("style") or "")
    if style_name:
        counts = style.get("counts") or {}
        out.append(
            '<p class="meta">Стиль: <b>'
            f"{_esc(style_name)}</b> · кадров {_esc(counts.get('shots', 0))}, "
            f"мастер {_esc(counts.get('master', 0))}, дети {_esc(counts.get('children', 0))}, "
            f"обрезано {_esc(counts.get('trimmed', 0))}, без промта {_esc(counts.get('no_prompt', 0))}.</p>"
        )
    else:
        out.append('<p class="meta">Стиль не применён: отчёт стиля не найден.</p>')

    for scene, speech, kadry in scene_rows:
        background = backgrounds.get(scene.get("фон") or "")
        qc = qc_map.get(int(scene.get("номер") or 0))
        out.append('<section class="card">')
        out.append('<div class="scene-head">')
        out.append(f'<h2 style="border:0;margin:0">Сцена {_esc(scene.get("номер"))}</h2>')
        out.append(_qc_badge(qc))
        out.append(
            f'<span class="muted">план {_esc(", ".join(scene.get("id_плана") or []))} · '
            f'фон {_esc(scene.get("фон") or "—")} · кадров {len(kadry)}</span>'
        )
        out.append("</div>")
        out.append(
            f'<p><b>Место.</b> {_esc(_text(scene.get("место")))}</p>'
            f'<p><b>Событие.</b> {_esc(_text(scene.get("событие")))}</p>'
            f'<p><b>Действие.</b> {_esc(_text(scene.get("сцена")))}</p>'
            f'<p><b>Персонажи.</b> {_esc(", ".join(scene.get("персонажи") or []) or "—")}'
            f' · <b>предметы.</b> {_esc(", ".join(scene.get("предметы") or []) or "—")}</p>'
        )
        if isinstance(background, dict):
            bg_place = _text(background.get("место"))
            bg_desc = _text(background.get("описание"))
            if bg_place or bg_desc:
                out.append(
                    f'<p class="muted"><b>Фон.</b> {_esc(bg_place)}'
                    f'{" — " + _esc(bg_desc) if bg_desc else ""}</p>'
                )
        out.append(_speech_html(speech))
        out.append(_qc_block(qc))
        out.append(_shots_table(kadry))
        out.append("</section>")

    out.append("<h2>Пункты плана</h2>")
    out.append("<ol>")
    for line in plan_points:
        out.append(f"<li>{_esc(line)}</li>")
    out.append("</ol>")

    out.append("<h2>Персонажи</h2><table><thead><tr><th>Код</th><th>Имя</th><th>Внешность и одежда</th></tr></thead><tbody>")
    for code in sorted(characters):
        card = characters[code] if isinstance(characters[code], dict) else {}
        look = ". ".join(
            part
            for part in (_text(card.get("внешность")), _text(card.get("одежда")))
            if part
        )
        out.append(
            f"<tr><td>{_esc(code)}</td><td>{_esc(_text(card.get('имя')))}</td>"
            f'<td class="prompt">{_esc(look)}</td></tr>'
        )
    out.append("</tbody></table>")

    out.append("<h2>Фоны</h2><table><thead><tr><th>Код</th><th>Место</th><th>Описание и свет</th></tr></thead><tbody>")
    for code in sorted(backgrounds):
        card = backgrounds[code] if isinstance(backgrounds[code], dict) else {}
        detail = ". ".join(
            part
            for part in (
                _text(card.get("описание")),
                _text(card.get("свет")),
                _text(card.get("время")),
            )
            if part
        )
        out.append(
            f"<tr><td>{_esc(code)}</td><td>{_esc(_text(card.get('место')))}</td>"
            f'<td class="prompt">{_esc(detail)}</td></tr>'
        )
    out.append("</tbody></table>")

    out.append(
        "<footer>Цепочка: Сцены по плану → Персонажи → Каркас → Диалоги → Фоны → Шоты → "
        "QC → Стиль → Отчёт. Гейты: R-PLAN-COVER, R-CAST-DUP, R-DLG-FORM, R-DLG-SPEAKER, "
        "R-BG-REF, R-DLG-SHOT, механические правила кадров, QC-семантика. "
        f"Сцен с речью: {speech_total}.</footer>"
    )
    out.append("</body></html>")
    return "\n".join(out)


def write_report(
    project: Any,
    *,
    scenes: list[Any],
    characters: dict[str, Any],
    backgrounds: dict[str, Any],
) -> Path:
    path = report_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        build_report(project, scenes=scenes, characters=characters, backgrounds=backgrounds),
        encoding="utf-8",
    )
    return path
