# Проверка картинок на панели монтажа (image check v1)

> **Что это.** В шапке «Панели монтажа» появляется дропдаун **«Механика проверки»**.
> Механики: **картинки** (эта фича) и **видео** (пункт виден, но выключен — v1 только картинки).
>
> Механика картинок: по сценам **4 готовых кадра склеиваются в одну картинку** (2×2, в родном размере кадров),
> каждый лист уходит агенту-проверке вместе с **промтом каждого кадра**; агент проводит
> ряд проверок и проверку соответствия промту и выдаёт **вердикт по каждому кадру**.
> Дальше по настройке: либо только **уведомления** о проблемах по кадрам, либо
> **авто-перегенерация** плохих кадров (с лимитами перепроверок/перегенераций).
> Все версии картинок кадра видны в **истории** — можно выбрать любую и поставить активной.
>
> **Статус:** v1, реализуется 2026-11-23 в чекауте `C:\Users\Admin\Desktop\WebVideoPipeline-keys`
> (ветка `22.11.2026`). Живая студия на :8766 крутится из другого worktree — сюда не влияет.

---

## 1. Границы v1

| Есть | Нет (сознательно) |
|---|---|
| Механика «картинки»: листы из 4 **уже сгенерированных** картинок кадров | Механика «видео» (пункт в меню выключен) |
| Агент-проверка с **вариантами** промта + свободной задачей | Обучение/правка промтов из UI |
| Вердикт по каждому кадру (pass/fail + проблемы + соответствие промту) | Правка промта по находке (только уведомление) |
| Режимы: `notify` (уведомления) / `auto` (сам перегенерирует) | Ручной выбор отдельных кадров на перегенерацию в popover (v2) |
| Лимиты: `max_rechecks`, `max_regens` | Отдельный счётчик денег (стоимость идёт общим леджером) |
| История версий картинки кадра + «сделать активной» | Версионирование в БД (индекс — в meta, файлы — в `old/scenes/`) |
| Прогон по всему проекту или по одному кадру/сцене (API) | Автозапуск проверки после ноды `img` |

**Источник картинок — готовые кадры** (решение владельца 2026-11-23): лист собирается из
активной картинки кадра, а не генерируется заново по промту сцены.

---

## 2. Файлы

| Файл | Кто | Что |
|---|---|---|
| `docs/MONTAGE-IMAGE-CHECK.md` | Lead | этот контракт |
| `app/contracts/montage_check.py` | Lead | контракт LLM-ответа проверки (`vp.montage_check.v1`) |
| `app/services/montage_check_meta.py` | Lead | настройки/прогресс/вердикты/история в `meta.montage_board` |
| `app/services/montage_check_images.py` | Lead | сборка листов, vision-вызов, вердикты, авто-реген, история |
| `prompts/check_montage/{default,strict,soft}.md` | Lead | варианты агента проверки |
| `app/services/montage_check_job.py` | backend | фон-джоба (реестр задач, spawn/get/cancel) |
| `app/web/routers/project_ops.py` | backend | 5 эндпоинтов `/montage-board/check*` |
| `app/services/access_guard.py` | backend | operator-token на `check/run`, `check/settings`, `check/apply-image` |
| `app/services/montage_board_job_state.py` | backend | `image_check_job` в `_JOB_KEYS` |
| `tests/test_montage_check_api.py` | backend | эндпоинты/настройки/job/apply-image |
| `web/src/lib/types.ts`, `web/src/lib/api.ts` | frontend | типы + методы |
| `web/src/components/studio/montage-image-check-popover.tsx` | frontend | дропдаун в шапке монтажа |
| `web/src/components/canvas/montage-image-check-badge.tsx` | frontend | бейдж проблем на кадре + история/выбор |
| `web/src/components/canvas/assemble-montage-board.tsx` | frontend | вставка кнопки в шапку + overlay бейджа |

**Правило хозяина файла:** backend не трогает `web/**` и файлы Lead; frontend не трогает `app/**`.

---

## 3. Настройки (meta)

`project.meta["montage_board"]["image_check_settings"]`:

```python
{
  "kind": "images",           # images | video (video выключен в v1)
  "mode": "notify",           # notify | auto
  "agent": "default",         # id варианта промта из prompts/check_montage/<id>.md
  "task": "",                 # свободная задача проверки (пусто = только промт варианта)
  "max_rechecks": 1,          # 0..5, сколько раз перепроверять кадр после регена
  "max_regens": 1,            # 0..5, сколько раз перегенерировать кадр за прогон
  "frames_per_sheet": 4,      # v1 фиксировано 4
  "sheet_long_side": 3840,    # 4К: лист 2160×3840 (клетка 1080×1920)
}
```

Валидация: неизвестный `kind` → 400 (video → 400 «механика видео ещё не включена»);
`mode` только `notify|auto`; лимиты обрезаются в 0..5; `agent` — существующий файл.

Прочие ключи `meta.montage_board`:

```python
"image_check_job": {"status":"idle|running|done|error|cancelled","phase":str,
                    "phase_detail":str,"done":int,"total":int,"error":str|None,
                    "started_at":iso|None,"finished_at":iso|None,"result":dict|None},
"image_check": {"frames": { "<number>": {"verdict":"pass|fail|skip","score":float|None,
                     "prompt_match":bool,"problems":[str],"sheet":str|None,"cell":int|None,
                     "checked_at":iso|None,"regen_round":int}},
                 "history": [ {"frame_number":int,"shot":1,"file":str,"path":str,
                     "created_at":iso,"source":"generated|regen|archive","verdict":str,
                     "problems":[str],"active":bool} ],
                 "last_run": {"at":iso,"total":int,"pass":int,"fail":int,"skip":int,
                     "sheets":int,"regenerated":int,"rechecks":int} }
```

`image_check_job` **обязан** быть в `_JOB_KEYS` (`montage_board_job_state.py`), иначе после
рестарта студии job навсегда `running`.

---

## 4. Лист (склейка 4 кадров) — как собирается

1. Кадры проекта — `Frame` по `order_by(sort_key, number)`; сцена — VO-ячейка через
   `montage_scene_editor.scene_group(frames, frame)` (то же, что на доске).
2. Пачки под листы: сцена из 2+ кадров режется на пачки по 4; **одиночные сцены
   пакуются по 4 соседних кадра** — типовой проект это «сцена = один кадр», иначе лист
   2×2 не набрать никогда, а «4 кадра в картинке» — требование владельца.
   Пачка = один лист; меньше 2 картинок в пачке — лист не собираем (`skip` с причиной).
3. Картинка кадра: `find_shot1_image(scenes_dir, number)` → `find_parent_still_image` →
   `find_shot2_image`. Нет картинки — кадр `skip: "нет картинки кадра"`, в лист не попадает.
4. Лист собирает `montage_check_images.compose_sheet(cells, out)`
   (PIL, без `compose_grid_strip`: нужны ярлыки клеток и пустые клетки на 3 кадрах):
   4 кадра → 2×2, 3 кадра → 2×2 с пустой клеткой, 2 кадра → 1×2; на каждой клетке
   выжжен ярлык «клетка · номер кадра» (агент не путает панели). Размер клетки —
   родной размер кадра: 1080×1920 → лист 2168×3848, без апскейла/даунскейла до «4К». Путь: `project.data_dir / "check" / f"sheet_{first_frame:03d}_{idx:02d}.png"`
   (`first_frame` — первый кадр пачки, `idx` — номер пачки внутри блока).
5. Для vision берётся тот же PNG; сжатие до лимита провайдера (4 МБ) делает
   `gpt_api.image_to_data_url` само (`_compress_image_for_vision`).

Лимит одного vision-запроса — **8 картинок / 4 МБ** (`gpt_api._MAX_VISION_IMAGES`,
`_MAX_VISION_BYTES`). Мы шлём **один лист = один запрос**, поэтому в лимит укладываемся.

---

## 5. Агент-проверка (промт + варианты + задача)

Промты: `prompts/check_montage/<id>.md`, `<id>` = имя файла без `.md`.
Первую строку `# Заголовок` и строку `> Кратко…` используем как `title`/`summary` в UI,
остальное — тело промта. В v1: `default`, `strict`, `soft`.

Сборка запроса (`montage_check_images.build_sheet_prompt`):

```
<тело варианта>

# ЗАДАЧА ОПЕРАТОРА
<task, если задана>

# ЛИСТ
Лист <idx>: сетка 2×2, клетки идут слева направо, сверху вниз. На каждой картинке
в левом верхнем углу выжжен ярлык «клетка · номер кадра».
- клетка 1: кадр #7
- клетка 2: кадр #8

# ПРОМТЫ КАДРОВ
## Клетка 1 — кадр #7
<image_prompt кадра 7>
…
```

Ответ — JSON по контракту `vp.montage_check.v1` (см. §6). Вызов:
`get_gpt_client().ask_with_files(text, [sheet_png], project_id=…, timeout=300,
response_schema=CONTRACT.response_schema())` + `CONTRACT.parse(reply)`.
`LlmContractError` → **один** repair-ретрай с текстом ошибки в промте; после него —
`error` прогона. **Битый ответ ≠ fail:** никаких регенераций по мусору
(`app/contracts/check_report.py`: «спека Битый ответ проверки ≠ вердикт fail»).

---

## 6. Контракт LLM-ответа (`vp.montage_check.v1`)

```json
{
  "cells": [
    {"frame": 1, "verdict": "pass", "score": 0.9, "prompt_match": true, "problems": []}
  ],
  "summary": "коротко, что проверено"
}
```

- `cells` — 1..4 элемента, `frame` = позиция клетки в листе (1..4), НЕ номер кадра проекта;
- `verdict` ∈ `pass|fail`; `score` 0..1 (None допустим); `prompt_match` bool;
- `problems` — короткие фразы по-русски («двое персонажей», «нет пропса», «фон не тот»);
- нет `verdict`/`cells` → `LlmContractError` (repair, затем error прогона).

---

## 7. Логика прогона (`run_image_check`)

```python
async def run_image_check(
    project_id: int,
    *,
    frame_numbers: list[int] | None = None,  # проверять только эти кадры
    scene: int | None = None,                # или только сцену (номер VO-родителя)
    progress: Callable[[str, str, int, int], None] | None = None,  # phase, detail, done, total
) -> dict:
    """{"total","pass","fail","skip","sheets","regenerated","rechecks","frames":{...},
        "cancelled": bool, "error": str|None}"""
```

Шаги:

1. `status=running`, `phase="sheets"`: собрать листы (§4).
2. `phase="check"`: по листу — vision-вызов (§5), вердикты в `image_check.frames`,
   `sheet`/`cell` кадра, `history` — текущая картинка как `source="generated"`, `active=True`.
3. Режим `notify`: на этом всё; `last_run` + `status=done`.
4. Режим `auto`: для каждого `fail`-кадра до `max_regens`:
   `regen_scene_image(session, project, number, shot=1, mode="same_prompt")`
   (`montage_board_regen.py:786`; старый файл сам уезжает в `old/scenes/`,
   `montage_board_assets.archive_file`) → запись в `history` (`source="regen"`) →
   перепроверка кадра (лист пачки пересобирается, один vision-вызов) до `max_rechecks`.
   После лимита — кадр остаётся `fail` с проблемами.
5. `is_stop_requested(project_id)` проверяется между листами и регенами → `cancelled`.
6. `status=done` (или `error`), `last_run`; `publish_project_event(..., "image_check",
   {"status":…,"refresh_board":True})` — публикует job-модуль.

Перепроверка после регена считается в `rechecks`; регенерации — в `regenerated`.

---

## 8. История версий картинки и «сделать активной»

`list_frame_history(project, frame_number)` (в `montage_check_images.py`) отдаёт:

1. индекс `image_check.history` (самые свежие сверху, с вердиктами) — `source=generated|regen`;
2. файлы из `project.data_dir/old/scenes/**` по шаблонам кадра (`frame_NNN_*`,
   `frame_NNN_s2_*`, `frame_NNN_parent_*`; layout смешанный — плоские `old/scenes/<ts>_<name>`
   и папки `old/scenes/<ts>/<name>`) — `source=archive`, вердикт `unknown`;
3. текущий файл кадра — `active=True`, `url=/api/files?path=…&v=mtime`.

Выбор версии (`apply_history_image`): файл копируется в `scenes/` с новым uuid-именем и
проводится через `finalize_scene_image(session, project, number, shot=1, new_path=dest)` —
текущая картинка уезжает в архив, выбранная становится активной. Запись в `history`
(`source="regen"`, `problems` из индекса, если вердикт известен).

Границы безопасности: `file` в API — только имя файла из выдачи `GET check` (никаких
произвольных путей; сверять с кандидатами истории).

---

## 9. REST API

Префикс `/api/projects/{project_id}/montage-board`.

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/check` | `{settings, agents[], job, frames[], history[], summary}` — см. §10 |
| GET | `/check/status` | `{job}` (лёгкий polling) |
| POST | `/check/run` | тело `{frame_numbers?: int[], scene?: int, kind?: "images"}` → `{started: bool, already_running?: bool, job}` |
| POST | `/check/settings` | частичный объект настроек → `{settings}`; неизвестный `kind`/`mode` → 400 |
| POST | `/check/apply-image` | `{frame_number: int, file: str}` → `{ok: true, frame_number, image_url}`; файла нет в истории → 400 |
| POST | `/check/cancel` | → `{cancelled: bool}` (ставит `is_stop_requested`) |

`kind="video"` → 400 `{"detail": "проверка видео ещё не включена"}`.
Пока job `running`, второй `/check/run` → `{started: false, already_running: true, job}`.

---

## 10. Форма ответа `GET /check` (фронт)

```ts
interface MontageCheckSettings { kind: "images"|"video"; mode: "notify"|"auto";
  agent: string; task: string; max_rechecks: number; max_regens: number;
  frames_per_sheet: number; sheet_long_side: number; }
interface MontageCheckAgent { id: string; title: string; summary: string; }
interface MontageCheckFrameResult { frame_number: number; verdict: "pass"|"fail"|"skip";
  score: number|null; prompt_match: boolean; problems: string[]; sheet: string|null;
  cell: number|null; checked_at: string|null; regen_round: number; }
interface MontageCheckHistoryItem { frame_number: number; shot: number; file: string;
  path: string; url: string|null; created_at: string|null;
  source: "generated"|"regen"|"archive"; verdict: "pass"|"fail"|"unknown";
  problems: string[]; active: boolean; }
interface MontageCheckJob { status: "idle"|"running"|"done"|"error"|"cancelled";
  phase?: string; phase_detail?: string; done?: number; total?: number;
  error?: string|null; started_at?: string|null; finished_at?: string|null;
  result?: Record<string, unknown>|null; }
interface MontageCheckDTO { settings: MontageCheckSettings; agents: MontageCheckAgent[];
  job: MontageCheckJob; frames: MontageCheckFrameResult[];
  history: MontageCheckHistoryItem[];
  summary: { total: number; pass: number; fail: number; skip: number }; }
```

---

## 11. UI (фронт)

- **Кнопка «Проверка»** в шапке доски — сразу после «Галерея генератора (CDP)»
  (`assemble-montage-board.tsx:4381`), перед `AudioAlignPopover` (4382). Форма — Popover
  (как `AudioAlignPopover`, `z-[10060]`).
- В поповере: выпадающий список **«Механика проверки»** (`Картинки` — активно, `Видео` —
  disabled, подпись «скоро»); режим `Уведомлять / Авто-перегенерация`; селект **агента**
  (варианты из `agents`); textarea **задача**; лимиты **перепроверок** и **перегенераций**
  (0..5) — всё это = «отображение настроек, автоматическая работа или нет, сколько
  перепроверок и перегенераций»; кнопка **«Проверить картинки»**; прогресс/фаза; итог
  (ок/проблемы/пропуски); список проблем по кадрам (уведомления); под ним — **история**
  версий по кадру с миниатюрами и кнопкой «Поставить» (apply-image).
- **Бейдж на кадре**: у `ClickableMedia` уже есть слот `overlay`
  (`assemble-montage-board.tsx:1533/1613`, передаётся `overlay={null}` на 4812) — кладём
  туда красный/зелёный кружок с числом проблем + tooltip; клик открывает поповер с
  историей кадра.
- После `run`/`apply-image` — invalidate `["montage-board", projectId]` и
  `["montage-check", projectId]`.
- Обновление доски после регена — по событию WS `project_updated` с `image_check`
  (как у `montage_board_apply`) и/или `onFinished` из popover.

---

## 12. Приёмка v1

1. `pytest tests/test_montage_check_api.py tests/test_montage_check_sheets.py -q` — зелёные.
2. `ruff check app/ tests/test_montage_check*.py` — чисто.
3. `cd web && npx tsc --noEmit` (или `npm run build`) — без ошибок.
4. Смоук на живом проекте с картинками: `POST /check/run` даёт листы 2168×3848 (2×2 из 1080×1920), ответ
   `done`, вердикты по кадрам; в `notify` ничего не перегенерируется; в `auto` плохой кадр
   получает новый файл и запись в истории; «Поставить» из истории меняет активную картинку.
5. `python scripts/bump_studio_version.py` перед коммитом, если менялся `web/**`.

Без живого LLM-ключа смоук ограничивается юнит-тестами с замоканным `ask_with_files`.
