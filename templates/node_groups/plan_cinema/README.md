# Группа `plan_cinema` — «Кино по плану»

Ролик строится из **плана** (`project.general_plan`), а не из закадрового текста: сцены → персонажи →
диалоги → каркас → кадры → фоны → QC → стиль → отчёт. Закадра в этой цепочке нет:
`Frame.voiceover_text = ""`, поля `закадр` нет ни в сцене, ни в кадрах, VO-гейты отключены (`vo_mode=False`).

Цепочка (все рёбра `after`, `project_meta={"source_mode": "plan"}`):

**Сцены по плану → Персонажи → Каркас → Диалоги → Шоты → Фоны → QC → Стиль → Отчёт**

## Ноды

| нода (id) | подпись | режим | промт (вариант) | файл |
|---|---|---|---|---|
| `n_excel_gpt_pk_scenes` | Сцены по плану | artifact/code | `plan_to_scenes` | `templates/node_groups/plan_cinema/plan_to_scenes.md` |
| `n_excel_gpt_pk_cast` | Персонажи | project_file | `plan_cast` | `templates/node_groups/plan_cinema/plan_cast.md` |
| `n_excel_gpt_pk_skeleton` | Каркас | project_file | `scene_skeleton_plan` | `templates/node_groups/plan_cinema/scene_skeleton_plan.md` |
| `n_excel_gpt_pk_dialogues` | Диалоги | project_file | `plan_dialogues` | `templates/node_groups/plan_cinema/plan_dialogues.md` |
| `n_excel_gpt_pk_shots` | Шоты | project_file | `scenes_to_frames_plan_ru` | `templates/node_groups/plan_cinema/scenes_to_frames_plan_ru.md` |
| `n_excel_gpt_pk_backgrounds` | Фоны | artifact/code + GPT | `plan_backgrounds` | `templates/node_groups/plan_cinema/plan_backgrounds.md` |
| `n_excel_gpt_pk_qc` | QC | project_file | `shots_qc_plan_ru` | `templates/node_groups/plan_cinema/shots_qc_plan_ru.md` |
| `n_excel_gpt_pk_style` | Стиль | artifact/code | `style_noir_watercolour_16_09` (имя файла стиля) или имя загруженного текста стиля | файл из `templates/node_groups/script_frames_qc/styles/*.md` (общая папка) **или** текст, загруженный в «свой промт» ноды; спецификация — `style_plan.md` |
| `n_excel_gpt_pk_report` | Отчёт | artifact/code | — | HTML собирает код |

Порядок «Фоны» после «Шотов» — намеренно: шоты пишут `место` и ракурс, фоны группируют места и создают `f0N`.

Стиль можно задать двумя способами: выбрать файл из папки стилей или загрузить свой текст в «свой промт» ноды — тогда в поле стоит имя загруженного файла, а текст берётся из библиотеки промтов. Жёсткое требование «файл должен называться `style_*.md`» снято: оно ломало второй способ.

## Входы и выходы по нодам

| нода | вход | выход | гейт |
|---|---|---|---|
| Сцены по плану | `general_plan`, размеченный кодом на `P1…Pn` | `scene_boundaries/plan_scenes.json`: `номер`, `id_плана[]`, `место`, `событие`, `примечание` | `R-PLAN-COVER` |
| Персонажи | план + сцены | `Entity(type="character", code="c01"…)` с `имя/внешность/одежда/характер/правила/voice_prompt/voice_id` | `R-CAST-DUP` |
| Каркас | сцены + реестр | ячейки `Frame` (`voiceover_text=""`), `attrs`: `источник="pk"`, `id_плана`, `место`, `персонажи`, `предметы`, `событие`, `сцена` | — |
| Диалоги | сцена + реестр | `Frame.attrs["речь"]` = `{тип, реплики:[{кто, текст, эмоция}]}` | `R-DLG-FORM`, `R-DLG-SPEAKER` |
| Шоты | сцена + `речь` + `место` | apply-ops `{"frame_uuid": "<uuid сцены>", "fields": {"кадры": [...]}}`, без `закадр` | `R-DLG-SHOT` |
| Фоны | нормализованные `место` всех сцен | `Entity(type="background", code="f01"…)`, у сцены `attrs["фон"] = "f0N"` | `R-BG-REF` |
| QC | сцена, `речь`, кадры, реестры, механические нарушения | `{"qc": {"verdict", "violations", "fixes", "issues"}}` | семантика §5 |
| Стиль | выбранный `style_*.md` + кадры сцен | `промт_картинки` K1 = сцена + стиль, `промт_без_стиля`, `стиль`; `frames.image_prompt` | `R-STYLE-LEN` |
| Отчёт | сцены, кадры, речь, фоны | `reports/shots-report.html` | — |

Гейты покрытия считаются кодом, не моделью: `app/services/plan_scenes.py`
(`num_plan_points`, `parse_scenes_reply`, `check_plan_coverage`). При провале — один повтор,
затем `gate_status=fail` и цепочка стоит.

## Чем отличается от `script_frames_qc`

1. Вход — план, а не закадр: нет ноды «Границы» (режет план «Сцены по плану»), нет склейки VO.
2. `voiceover_text = ""` у всех сцен; поля `закадр` нет в схеме кадра, VO-правила (26–80 / 12–30,
   дословность, покрытие VO) не применяются; валидаторы вызываются с `vo_mode=False`.
3. Речь — отдельная сущность сцены (`attrs["речь"]`), а не VO: диалоги пишутся до шотов, шоты
   раскладывают реплики по кадрам (`говорит`, `реплика`), код проверяет их через `shots_dialogue_problems`.
4. Персонажи — отдельный шаг «Персонажи» (реестр `Entity(character)`), есть гейт дублей `R-CAST-DUP`;
   в старой группе реестр собирался внутри «Каркаса».
5. Фоны — отдельная сущность на локацию: нода «Фоны» после «Шотов», у сцены `attrs["фон"]`, гейт `R-BG-REF`.
6. Сцена — ячейка `Frame` с `attrs["источник"] == "pk"`; по этому ключу отличаем сцены новой цепочки от старых.
7. «Стиль» и «Отчёт» переиспользуют логику старой группы; промты и id нод новые, `pk_*`.

Ставится с `default_after_type="plan"`; вместе с `script_frames_qc` не ставится
(`mixed_group_conflict_error`). Старые проекты без `meta.source_mode == "plan"` не меняются.

## Если гейт упал

| гейт | что значит | что делать |
|---|---|---|
| `R-PLAN-COVER` | план не покрыт сценами, ссылки убывают или есть `P` вне плана | прочитать в отчёте `uncovered` / `unknown` / `errors`, перезапустить «Сцены по плану» (один автоповтор уже был); кривой план чинить в «Сценарии», а не в нодах |
| `R-CAST-DUP` | два персонажа с одним именем после нормализации | перезапустить «Персонажи»; имя основы свести к одному `cNN` |
| `R-DLG-FORM` / `R-DLG-SPEAKER` | форма `речь` не по контракту или `кто` вне реестра/сцены | перезапустить «Диалоги» по этой сцене, править `речь` в `attrs`, а не кадры |
| `R-DLG-SHOT` | реплики не разложены по кадрам | перезапустить «Шоты» по сцене; реплика дословно из `речь` |
| `R-BG-REF` | у сцены нет фона или фон не существует | перезапустить «Фоны»; проверить `attrs["фон"]` сцены против `Entity(background)` |
| `R-STYLE-LEN` | стиль не влезает в лимит 4877 | взять другой файл стиля; стиль не режется никогда |
| `qc.verdict == fail` | семантические нарушения от GPT-QC | смотреть `violations` и `fixes`, повторять «Шоты» / «Диалоги» по указанным кадрам |

Проверка после прогона: `reports/shots-report.html` (сцены, кадры, речь, фоны) и
`excel_gpt_uploads/n_excel_gpt_pk_style/style_report.json`.
