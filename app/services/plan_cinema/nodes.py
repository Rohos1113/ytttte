"""Диспетчер нод группы ``plan_cinema`` (``pk_*``): «Кино по плану».

Группа подключена пользовательской JSON-спекой ``node_groups/plan_cinema.json``;
``app/services/node_groups.py`` и ``app/orchestrator/steps/enrich_xlsx.py`` не
правятся. Хук раннера — две точки входа этого модуля:

- ``is_plan_cinema_node(node_key)`` — «моя ли нода»;
- ``run_plan_cinema_node(session, project, node_key=..., slot_idx=...)`` — исполнить.

Обработчики читают входы и пишут результаты только через модули пакета:
``plan_cinema.source`` (режим plan и текст плана), ``plan_cinema.apply``
(БД и артефакты), ``plan_cinema.gates`` (гейты). Исходная механика проекта
только импортируется (промты, оператор GPT, отчёт, стиль) — без правок.

Модель зовётся только для нод с промт-вариантом; «Стиль» и «Отчёт» — код.
Ответ модели всегда забираем текстом и разбираем JSON сами: это одинаково
работает для artifact- и project_file-нод и не требует отдельного
apply-ops-моста раннера.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple

logger = logging.getLogger(__name__)

GROUP_ID = "plan_cinema"

#: Ключ meta, включающий режим плана (CONTRACT.md §2).
SOURCE_MODE_KEY = "source_mode"
PLAN_MODE = "plan"

ARTIFACT_SCENES = "plan_scenes.json"
ARTIFACT_DIALOGUES = "dialogues.json"
ARTIFACT_SHOTS = "shots.json"
ARTIFACT_QC = "qc_report.json"
ARTIFACT_FIX = "shots_fix_report.json"
ARTIFACT_CHECK = "shots_check_report.json"
ARTIFACT_STYLE = "style_report.json"
ARTIFACT_REPORT = "report.json"
ARTIFACT_PROMPTS = "image_prompts_report.json"

#: Минимум сцен в артефакте «Сцены по плану» (CONTRACT.md §4: гейт R-PLAN-COVER).
MIN_SCENES = 1
#: Попыток ответа модели на гейт R-PLAN-COVER (CONTRACT.md §4: один повтор).
COVER_ATTEMPTS = 3
#: Порог карточки фона: локация должна встречаться в кадрах больше одного раза.
#: Одиночное место карточку не заводит — его описывает сам кадр (plan_backgrounds.md).
BACKGROUND_MIN_FRAMES = 2
#: Код фона (тот же контракт, что ``apply.SCENE_BACKGROUND_CODE_RE``).
_BACKGROUND_CODE_RE = re.compile(r"^f\d{2,}$")


# ── Реестр нод ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlanCinemaNodeSpec:
    """Описание одной ноды группы (совпадает с ``node_groups/plan_cinema.json``)."""
    kind: str
    local_key: str
    label: str
    prompt_variant: str | None
    output_mode: str

    @property
    def node_id(self) -> str:
        return f"n_excel_gpt_{self.local_key}"

    @property
    def suffix(self) -> str:
        return f"_{self.local_key}"

    @property
    def uses_model(self) -> bool:
        """Зовёт ли нода модель. «Стиль» и «Отчёт» — код, промт — имя файла."""
        return self.kind not in CODE_ONLY_KINDS


#: Ноды группы в порядке цепочки (CONTRACT.md §1).
NODE_SPECS: tuple[PlanCinemaNodeSpec, ...] = (
    PlanCinemaNodeSpec("scenes", "pk_scenes", "Сцены по плану", "plan_to_scenes", "artifact"),
    PlanCinemaNodeSpec("cast", "pk_cast", "Персонажи", "plan_cast", "project_file"),
    PlanCinemaNodeSpec("skeleton", "pk_skeleton", "Каркас", "scene_skeleton_plan", "project_file"),
    PlanCinemaNodeSpec("dialogues", "pk_dialogues", "Диалоги", "plan_dialogues", "project_file"),
    PlanCinemaNodeSpec("shots", "pk_shots", "Шоты", "scenes_to_frames_plan_ru", "project_file"),
    PlanCinemaNodeSpec(
        "backgrounds", "pk_backgrounds", "Фоны", "plan_backgrounds", "artifact"
    ),
    PlanCinemaNodeSpec("qc", "pk_qc", "QC", "shots_qc_plan_ru", "project_file"),
    PlanCinemaNodeSpec(
        "style", "pk_style", "Стиль", "style_noir_watercolour_16_09", "artifact"
    ),
    PlanCinemaNodeSpec("report", "pk_report", "Отчёт", None, "artifact"),
    PlanCinemaNodeSpec("fix", "pk_fix", "Правки кадров", "shots_fix_plan_ru", "project_file"),
    PlanCinemaNodeSpec(
        "check", "pk_check", "Проверка", "shots_check_plan_ru", "project_file"
    ),
    PlanCinemaNodeSpec(
        "prompts", "pk_prompts", "Промты картинок", "image_prompts_plan_ru", "project_file"
    ),
)

_BY_KIND: dict[str, PlanCinemaNodeSpec] = {spec.kind: spec for spec in NODE_SPECS}
_BY_SUFFIX: dict[str, PlanCinemaNodeSpec] = {spec.suffix: spec for spec in NODE_SPECS}

#: Полный ключ ноды (``pk_scenes``) или id (``n_excel_gpt_pk_scenes``).
_BY_KEY: dict[str, PlanCinemaNodeSpec] = {}
for _spec in NODE_SPECS:
    _BY_KEY[_spec.local_key] = _spec
    _BY_KEY[_spec.node_id] = _spec

#: Ноды без модели: «Стиль» пишет код (промт-вариант — имя файла стиля), «Отчёт» — HTML.
CODE_ONLY_KINDS: frozenset[str] = frozenset({"style", "report"})

#: Подпись источника входа «Сцен» в тексте результата.
_INPUT_KIND_RU: dict[str, str] = {
    "topic": "«Тема»",
    "plan": "«Сценарий»",
    "project_plan": "план проекта",
}

#: Легаси-суффиксы script_frames_qc (v1 ``_fw_*`` и v3 ``_sfq3_*``).
LEGACY_SUFFIXES: tuple[str, ...] = (
    "_fw_boundaries",
    "_fw_script",
    "_fw_check_script",
    "_fw_action",
    "_fw_shots",
    "_fw_frames",
    "_fw_qc",
    "_fw_style",
    "_fw_report",
    "_sfq3_plan",
    "_sfq3_script",
    "_sfq3_shots",
)


def plan_cinema_node_specs() -> tuple[PlanCinemaNodeSpec, ...]:
    """Все ноды группы в порядке цепочки."""
    return NODE_SPECS


def plan_cinema_node_ids() -> tuple[str, ...]:
    """id нод группы (``n_excel_gpt_pk_*``)."""
    return tuple(spec.node_id for spec in NODE_SPECS)


def is_plan_cinema_node(node_key: str | None) -> bool:
    """Нода принадлежит группе ``plan_cinema``?

    Ключ — полный (``pk_scenes``) или id ноды (``n_excel_gpt_pk_scenes``);
    «оканчивается на ``_pk_*``» сравнивается по границе слова, чтобы
    ``n_excel_gpt_pk_unknown`` не считалась своей.
    """
    return plan_cinema_node_spec(node_key) is not None


def plan_cinema_node_spec(node_key: str | None) -> PlanCinemaNodeSpec | None:
    """Описание ноды по id или local_key; ``None`` — чужая нода."""
    key = str(node_key or "").strip()
    return _BY_KEY.get(key)


def plan_cinema_node_kind(node_key: str | None) -> str:
    """Короткий вид ноды: ``scenes``, ``cast``… или пустая строка."""
    spec = plan_cinema_node_spec(node_key)
    return spec.kind if spec else ""


# ── Активация и конфликт групп ──────────────────────────────────────────────


def _canvas_node_ids(meta: Any) -> list[str]:
    """id нод канваса из ``meta.canvas_graph`` (пусто — графа нет)."""
    if not isinstance(meta, dict):
        return []
    graph = meta.get("canvas_graph")
    if not isinstance(graph, dict):
        return []
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        return []
    return [
        str(node.get("id") or "")
        for node in nodes
        if isinstance(node, dict) and str(node.get("id") or "").strip()
    ]


def _is_legacy_node(node_id: str) -> bool:
    return any(node_id.endswith(suffix) for suffix in LEGACY_SUFFIXES)


def mixed_group_conflict_error(meta: Any) -> str | None:
    """Ошибка, если на канвасе plan_cinema и script_frames_qc одновременно.

    CONTRACT.md §6: молча выбирать группу нельзя. ``None`` — конфликта нет.
    """
    keys = _canvas_node_ids(meta)
    own = sorted({key for key in keys if is_plan_cinema_node(key)})
    legacy = sorted({key for key in keys if _is_legacy_node(key)})
    if not (own and legacy):
        return None
    return (
        "На канвасе одновременно plan_cinema (_pk_*) и script_frames_qc "
        f"(v1 _fw_* / v3 _sfq3_*): plan_cinema={own[:5]}, script_frames_qc={legacy[:5]}. "
        "Так нельзя: раннер не выбирает группу молча. Оставь на канвасе одну схему."
    )


def source_mode(meta: Any) -> str:
    """Режим источника из meta: ``plan`` или ``voiceover`` (по умолчанию)."""
    if isinstance(meta, dict) and meta.get(SOURCE_MODE_KEY) == PLAN_MODE:
        return PLAN_MODE
    return "voiceover"


def assert_plan_cinema_activation(meta: Any, node_key: str | None = None) -> None:
    """Проверить, что нода plan_cinema может запускаться на этом канвасе.

    ``ValueError``, если смешаны группы или нет ``meta.source_mode="plan"``:
    молчаливый запуск режима плана на закадровом проекте запрещён.
    """
    error = mixed_group_conflict_error(meta)
    if error:
        raise ValueError(error)
    if node_key is not None and not is_plan_cinema_node(node_key):
        return
    if source_mode(meta) != PLAN_MODE:
        raise ValueError(
            f"нода {node_key or 'plan_cinema'} есть на канвасе, но режим плана "
            f"выключен: нет meta.{SOURCE_MODE_KEY} == {PLAN_MODE!r}. Вставь группу "
            f"{GROUP_ID} (она ставит флаг) или убери _pk_* ноды; молча запускать "
            "режим плана на закадровом проекте нельзя."
        )


# ── Результат ноды и общие помощники ────────────────────────────────────────


@dataclass
class NodeResult:
    """Итог обработчика ноды для ``run_plan_cinema_node``."""

    gate_status: str = "pass"
    reply_text: str = ""
    output_paths: list[Path] = field(default_factory=list)
    meta_patch: dict[str, Any] = field(default_factory=dict)


def _apply():
    from app.services.plan_cinema import apply as plan_apply

    return plan_apply


def _gates():
    from app.services.plan_cinema import gates

    return gates


def _source():
    from app.services.plan_cinema import source

    return source


def _split():
    """Чистые функции резки плана: разметка P1…Pn, разбор ответа, гейт."""
    from app.services import plan_scenes

    return plan_scenes


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _scene_dict(frame: Any) -> dict[str, Any]:
    """Сцена ``Frame`` → JSON-вход промтов по CONTRACT.md §3."""
    attrs = frame.attrs if isinstance(frame.attrs, dict) else {}
    return {
        "id": str(frame.uuid or ""),
        "номер": int(frame.number or 0),
        "место": str(attrs.get("место") or ""),
        "персонажи": list(attrs.get("персонажи") or []),
        "предметы": list(attrs.get("предметы") or []),
        "событие": str(attrs.get("событие") or ""),
        "примечание": str(attrs.get("примечание") or ""),
        "сцена": str(attrs.get("сцена") or ""),
        "id_плана": list(attrs.get("id_плана") or []),
        "фон": str(attrs.get("фон") or ""),
    }


    # Владелец 2026-11-20: требование «есть реплика в плане — тип не „нет“»
    # отключено (plan_text="" в гейте). Новые проверки — только с разрешения.

_TIME_WORDS = (
    "рассвет",
    "утро",
    "день",
    "полдень",
    "вечер",
    "сумерки",
    "закат",
    "ночь",
    "полночь",
)


def _time_of_day(place: str) -> str:
    """Время суток из описания места: «спальня, ночь, ложе…» → «ночь».

    Фон задаёт свет, поэтому одна локация в разное время суток — это разные
    фоны. Без времени в ключе ночная сцена получала рассветный фон соседней.
    """
    text = str(place or "").lower()
    for word in _TIME_WORDS:
        if word in text:
            return word
    return ""


def _place_group_key(place: str) -> str:
    """Локация места: «внутри каменного дома Куси, утро, дверь…» → «внутри каменного дома куси».

    Сцены одного места различаются хвостом деталей (время, что стоит рядом),
    а фон один на локацию. Берём часть до первой запятой, нижний регистр,
    кавычки и лишние пробелы снимаем.
    """
    head = str(place or "").split(",")[0]
    head = head.replace("«", "").replace("»", "").replace('"', "")
    return " ".join(head.split()).strip().lower()


_HEADING_RE = re.compile(
    r"^\s*(?:\d+[.)]\s*)?(?:ИНТ|НАТ|INT|EXT)[./\s]\s*(?P<loc>[^—–\n]+)",
    re.IGNORECASE,
)


def _plan_location(points_by_code: dict[str, str], refs: Sequence[str]) -> str:
    """Локация из шапки плана: ``ИНТ. КАМЕННЫЙ ДОМ КУСИ — УТРО`` → «каменный дом куси».

    План — источник правды о месте: в нём шапка написана кодом сценария, а
    «место» сцены — это уже описание для кадра. Группируем фоны по локации
    из шапки, а не по тексту описания.
    """
    for code in refs:
        match = _HEADING_RE.match(points_by_code.get(str(code), ""))
        if match:
            loc = " ".join(match.group("loc").split()).strip().lower()
            if loc:
                return loc
    return ""


def _speech_of(frame: Any) -> dict[str, Any]:
    attrs = frame.attrs if isinstance(frame.attrs, dict) else {}
    speech = attrs.get("речь")
    if isinstance(speech, dict):
        return speech
    return {"тип": "нет", "реплики": []}


def _scene_location_key(scene: Mapping[str, Any], plan_by_code: Mapping[str, str]) -> str:
    """Ключ локации сцены: место из шапки плана (или первые слова места) + время суток.

    Локация, а не сцена: кадры одной локации получают один фон, а время суток —
    часть локации, потому что задаёт свет (``plan_backgrounds.md``, правило 5).
    """
    place = " ".join(str(scene.get("место") or "").split()).strip()
    refs = [str(code) for code in (scene.get("id_плана") or [])]
    base = _plan_location(dict(plan_by_code), refs) or _place_group_key(place)
    time_of_day = _time_of_day(place)
    return f"{base} · {time_of_day}" if time_of_day else base


def _flat_text(value: Any) -> str:
    """Строка для входа модели: пробелы схлопнуты, текст идёт целиком.

    Никакой обрезки: «Фоны» собирают локацию из кадров, и отрезанный хвост
    описания («…») — это потерянные данные, а не экономия бюджета. Промт
    собирается из полных полей карточки.
    """
    return " ".join(str(value or "").split())


def _background_placeholder(scene: Mapping[str, Any]) -> dict[str, Any]:
    """Фон-заглушка для сцены, у которой карточки ещё нет.

    «Фоны» стоят **после** «Шотов»: фон собирается из кадров, поэтому на первом
    прогоне карточки нет. Кадры строятся от места сцены, код фона проставит
    нода «Фоны» после раскадровки.
    """
    return {
        "id": "",
        "место": str(scene.get("место") or ""),
        "описание": "",
        "свет": "",
        "время": "",
        "промт": "",
        "нет_карточки": True,
    }


def _frames_of(frame: Any) -> list[dict[str, Any]]:
    attrs = frame.attrs if isinstance(frame.attrs, dict) else {}
    kadry = attrs.get("кадры")
    return [row for row in kadry if isinstance(row, dict)] if isinstance(kadry, list) else []


def _shots_artifact_kadry(project: Any, node_key: str) -> dict[str, list[dict[str, Any]]]:
    """Кадры из артефакта «Шотов» по uuid сцены — запасной вход ноды «Фоны».

    Основной вход — ``Frame.attrs["кадры"]`` в БД. Артефакт нужен, когда шаг
    кадров записал ответ, но до БД он не доехал (упал коммит, ручной прогон).
    """
    spec = _BY_KIND["shots"]
    for key in (spec.node_id, spec.local_key):
        payload = _apply().read_artifact(project, key, ARTIFACT_SHOTS)
        if not isinstance(payload, Mapping):
            continue
        out: dict[str, list[dict[str, Any]]] = {}
        for op in payload.get("ops") or []:
            if not isinstance(op, Mapping):
                continue
            uuid = str(op.get("frame_uuid") or "").strip()
            raw_fields = op.get("fields")
            fields: Mapping[str, Any] = raw_fields if isinstance(raw_fields, Mapping) else {}
            raw_kadry = fields.get("кадры")
            if uuid and isinstance(raw_kadry, list):
                out[uuid] = [dict(row) for row in raw_kadry if isinstance(row, Mapping)]
        if out:
            return out
    return {}


def _registry_list(characters: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [characters[code] for code in sorted(characters)]


#: Секция «Диалог: …» пункта плана до следующей «Вставка:» или конца пункта.
_DIALOGUE_SECTION_RE = re.compile(r"Диалог:\s*(.*?)(?:\s*Вставка:|$)", re.S)


def _dialogue_text_of_point(text: str) -> str:
    """Текст словесного действия из пункта плана (пусто, если «Диалог: нет»)."""
    match = _DIALOGUE_SECTION_RE.search(str(text or ""))
    if not match:
        return ""
    value = match.group(1).strip().strip(".")
    if not value or value.lower().startswith("нет"):
        return ""
    return value


def _speech_points_owners(
    scenes: Sequence[dict[str, Any]],
    plan_by_code: dict[str, str],
    characters: dict[str, dict[str, Any]],
) -> dict[str, int]:
    """Пункт плана → номер сцены, которая отыгрывает его речь.

    Один пункт плана часто разложен на несколько сцен (воспоминание + реакция),
    и модель повторяла одну и ту же реплику в каждой. Владельцем словесного
    действия становится сцена, где есть названные в плане говорящие; остальным
    сценам того же пункта промт прямо говорит «речь уже отыграна — тип нет».
    """
    by_point: dict[str, list[dict[str, Any]]] = {}
    for scene in scenes:
        for code in scene.get("id_плана") or []:
            by_point.setdefault(str(code), []).append(scene)

    owners: dict[str, int] = {}
    for code, group in by_point.items():
        dialogue = _dialogue_text_of_point(plan_by_code.get(code, ""))
        if not dialogue:
            continue
        mentioned = {
            key
            for key, card in characters.items()
            if str(card.get("имя") or "").split(",")[0].strip()
            and str(card.get("имя") or "").split(",")[0].strip() in dialogue
        }

        def _score(scene: dict[str, Any]) -> tuple[int, int]:
            persons = {str(item) for item in scene.get("персонажи") or []}
            return (
                len(persons & mentioned),
                -int(scene.get("номер") or 0),
            )

        best = max(group, key=_score)
        owners[code] = int(best.get("номер") or 0)
    return owners


def _retry_block(problems: Sequence[str]) -> str:
    if not problems:
        return ""
    return (
        "\n\n### ИСПРАВЬ ПРЕДЫДУЩИЙ ОТВЕТ\n"
        + "\n".join(f"- {item}" for item in problems)
        + "\nВерни ответ заново целиком, только JSON, без пояснений."
    )


def _read_group_prompt(project: Any, name: str | None) -> str:
    """Файл промта группы ``plan_cinema``: ``templates/node_groups/plan_cinema/<name>.md``.

    Плюс то, что даёт обычное чтение промта (стилевые переменные, тема):
    без этого в промт не попадут ``{{ТЕМА}}`` и подстановки стиля.
    """
    from app.services.prompt_library import node_group_prompts_dir

    clean = str(name or "").strip()
    if not clean:
        raise FileNotFoundError("не задан промт-вариант ноды")
    path = node_group_prompts_dir(GROUP_ID) / f"{clean}.md"
    if not path.is_file():
        raise FileNotFoundError(str(path))
    text = path.read_text(encoding="utf-8")
    try:
        from app.services.excel_gpt_node import EXCEL_GPT_STEP_CODE
        from app.services.gpt_text_builder import inject_topic_placeholders
        from app.services.prompt_style_vars import apply_style_vars

        meta = getattr(project, "meta", None) or {}
        text = apply_style_vars(text, path, meta, EXCEL_GPT_STEP_CODE, clean)
        text = inject_topic_placeholders(text, str(getattr(project, "topic", None) or ""))
    except Exception:  # noqa: BLE001 — подстановки не критичны для чтения промта
        logger.debug("plan_cinema: подстановки промта %s пропущены", clean, exc_info=True)
    return text


def _read_master(project: Any, node_key: str, spec: PlanCinemaNodeSpec) -> str:
    """Прочитать промт ноды из папки группы ``plan_cinema``.

    Имя файла всегда берём из спеки группы, а не из ``prompt_slot_variants``:
    у голого проекта слотов нет, и общий резолвер молча отдаёт
    ``prompts/05_excel_gpt/default.md`` — чужого агента. Чтение идёт своим
    путём: ``_read_group_prompt``.
    """
    try:
        text = _read_group_prompt(project, spec.prompt_variant)
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: не найден промт "
            f"{spec.prompt_variant!r} в папке группы {GROUP_ID}"
        ) from exc
    text = str(text or "").strip()
    if not text:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: пустой промт "
            f"{spec.prompt_variant!r}"
        )
    return text


def _render(master: str, **context: Any) -> str:
    from app.services.prompts import render_prompt

    return render_prompt(master, **context)


#: Модель группы: GPT 6.1 Sol со средним мышлением (CONTRACT.md §2).
#: Берётся с канвас-ноды; если на канвасе забыли — падаем на это значение,
#: а не на дефолт «Работы с GPT» (там gpt-5.6-sol без мышления).
#: Именно ``gpt-6.1-sol``: на канвасе группа пишет ``gpt-6.1-sol-52pay``, но
#: маршрут 52pay в этом инстансе не поднят (в .env ключ лежит как
#: ``PAY52_GPT_API_KEY``, а Settings ждёт ``PAY52_GPT_KEY``), поэтому запрос
#: уходил в шлюз с литералом неизвестной модели и падал HTTP 400. Каталог
#: знает ``gpt-6.1-sol`` (алиас vibecode) — этот путь в инстансе рабочий.
DEFAULT_MODEL_ID = "gpt-6.1-sol"
DEFAULT_REASONING_EFFORT = "medium"
# Модели, которые группа считает «своими»: выбор с канваса принимается только
# из этого набора, иначе берётся DEFAULT_MODEL_ID.
ALLOWED_MODEL_IDS = frozenset({"gpt-6.1-sol-52pay", "gpt-6.1-sol"})


def _is_text_choice(model_id: str) -> bool:
    """Текстовая ли модель: каталог знает её как ``kind == "text"`` либо есть
    маршрут pay52 (у части id каталога нет, но шлюз её принимает)."""
    from app.services.pay52_routes import resolve_text
    from app.services.vibecode_catalog import find_model

    found = find_model(model_id)
    if found:
        return str(found.get("kind") or "") == "text"
    return resolve_text(model_id) is not None


def _node_canvas_data(project: Any, node_key: str) -> dict[str, Any]:
    """``data`` ноды с канваса проекта (без WorkflowRun)."""
    from app.services.vibecode_catalog import find_canvas_node

    meta = getattr(project, "meta", None) or {}
    node = find_canvas_node(meta, node_key=node_key)
    data = node.get("data") if isinstance(node, dict) and isinstance(node.get("data"), dict) else node
    return data if isinstance(data, dict) else {}


def node_model_pinned(project: Any, node_key: str) -> bool:
    """Человек выбрал модель на канвасе руками (флаг ``modelPinned``).

    Явный выбор сильнее и белого списка группы, и аварийного env-обхода
    провайдера: иначе «поставил Opus 5.5» молча работал
    бы gpt-6.1-sol — именно так выбор человека и терялся.
    """
    return bool(_node_canvas_data(project, node_key).get("modelPinned"))


def _routable_model_id(raw: str) -> str | None:
    """id модели, который каталог/маршруты действительно знают.

    Канвас группы хранит ``gpt-6.1-sol-52pay`` (суффикс наоборот относительно
    каталожного ``-pay52``); без этой нормализации id уезжал в шлюз литералом
    и получал ``unknown model``. Возвращаем первый вариант, на который есть
    маршрут, иначе ``None`` — вызывающий возьмёт DEFAULT_MODEL_ID.
    """
    want = (raw or "").strip()
    if not want:
        return None
    from app.services.pay52_routes import resolve_text
    from app.services.vibecode_catalog import find_model

    candidates = [want]
    flipped = want.replace("-52pay", "-pay52")
    if flipped != want:
        candidates.append(flipped)
    for cand in candidates:
        if find_model(cand) is not None or resolve_text(cand) is not None:
            return cand
    return None


def node_llm_choice(project: Any, node_key: str) -> tuple[str | None, str | None]:
    """Модель и сила мышления ноды: приоритет у выбора на канвасе, но только
    если там стоит наша модель 52pay.

    Иначе UI-дефолт каталога (``gpt-5.6-sol`` без мышления) перебивал бы выбор
    человека: ноды группы после вставки выглядели «сброшенными» на другую
    модель. Поэтому чужая модель с канваса игнорируется, а сила мышления
    берётся с канваса, если задана явно.
    """
    from app.services.vibecode_catalog import find_canvas_node

    meta = getattr(project, "meta", None) or {}
    node = find_canvas_node(meta, node_key=node_key)
    data = node.get("data") if isinstance(node, dict) and isinstance(node.get("data"), dict) else node
    data = data if isinstance(data, dict) else {}
    raw_model = _routable_model_id(
        str(data.get("modelId") or data.get("model_id") or "")
    )
    raw_effort = str(
        data.get("reasoningEffort") or data.get("reasoning_effort") or ""
    ).strip().lower()
    # Мышление читаем сами: штатный ``read_node_reasoning_effort`` на пустом
    # значении отдаёт ``high``, из-за чего «среднее» превращалось в высокое.
    effort = {
        "low": "low",
        "med": "medium",
        "medium": "medium",
        "high": "high",
        "ultra": "xhigh",
        "xhigh": "xhigh",
    }.get(raw_effort) or DEFAULT_REASONING_EFFORT
    pinned = bool(data.get("modelPinned"))
    if raw_model in ALLOWED_MODEL_IDS:
        return raw_model, effort
    # Явный пин с канваса (например, Claude Opus 5.5) — это выбор человека,
    # а не UI-дефолт: принимаем любую текстовую модель, на которую есть маршрут.
    if pinned and raw_model and _is_text_choice(raw_model):
        return raw_model, effort
    return DEFAULT_MODEL_ID, effort


async def _ask_text(project: Any, node_key: str, prompt: str, accompanying: str) -> str:
    """Один вызов модели текстом; JSON разбирает вызывающий обработчик.

    Модель и сила мышления берутся из ``node_llm_choice``: каталог сам по себе
    подставляет ``gpt-5.6-sol`` без мышления, поэтому override ставим явно,
    иначе выбор «52pay 6.1 среднее» не доезжает до запроса.
    """
    from app.services.gpt_operator_client import run_operator_api
    from app.services.llm_override import NodeLlmOverride, use_override
    from app.services.vibecode_catalog import find_model

    model_id, effort = node_llm_choice(project, node_key)
    found = find_model(str(model_id)) or {}
    # Маршрут берём из настроек (.env читает pydantic), а не только из os.environ:
    # PLAN_CINEMA_TEXT_PROVIDER в .env иначе не долетает до процесса.
    from app.settings import settings as _settings_provider

    forced_provider = str(
        getattr(_settings_provider, "plan_cinema_text_provider", "")
        or os.environ.get("PLAN_CINEMA_TEXT_PROVIDER")
        or ""
    ).strip().lower()
    if forced_provider in ("kie", "vibecode") and node_model_pinned(project, node_key):
        # Аварийный обход шлюза — для дефолтной модели группы. Явный пин
        # человека (например, Claude Opus 5.5) он не перебивает: иначе выбор
        # на канвасе молча превращался в gpt-6.1-sol.
        logger.info(
            "[#%s] %s: модель закреплена на канвасе (%s) — аварийный обход "
            "PLAN_CINEMA_TEXT_PROVIDER=%s не применяю",
            getattr(project, "id", "?"),
            node_key,
            model_id,
            forced_provider,
        )
        forced_provider = ""
    if forced_provider in ("kie", "vibecode"):
        # Аварийный обход шлюза 52pay: он режет валидацию промта (HTTP 400 на
        # сценах с оружием) и таймаутит (524 по 3-4 мин). Env-переключатель
        # гоняет текстовые ноды группы через kie (gpt-5-6-sol) или vibecode
        # (та же модель gpt-6.1-sol, другой шлюз); без переменной поведение
        # прежнее (52pay, gpt-6.1-sol).
        if forced_provider == "kie":
            model_id, effort, found = "gpt-5-6-sol", "medium", {}
            label = "kie gpt-5-6-sol"
        else:
            model_id, effort, found = "gpt-6.1-sol", "medium", {}
            label = "vibecode gpt-6.1-sol"
        ov = NodeLlmOverride(
            model_id=model_id,
            channel="stable",
            kind="text",
            provider=forced_provider,
            label=label,
            reasoning_effort=effort,
        )
    else:
        ov = NodeLlmOverride(
            model_id=str(model_id),
            channel=str(found.get("channel") or "stable"),
            kind="text",
            provider=str(found.get("provider") or "52pay"),
            label=str(found.get("display_name") or found.get("label") or model_id),
            reasoning_effort=effort,
        )
    with use_override(ov):
        # Жёсткая стена на один вызов. Шлюзы (52pay) умеют молча держать
        # соединение: httpx идёт с read=None, и без своего таймаута нода
        # висит часами (21.11 «Проверка» стояла 3 ч с одной зависшей пачкой).
        wall_s = float(os.environ.get("PLAN_CINEMA_CALL_TIMEOUT_S") or 0) or float(
            getattr(_settings_provider, "gpt_timeout_s", 0) or 0
        ) or 600.0
        try:
            res = await asyncio.wait_for(
                run_operator_api(
                    project_dir=Path(project.data_dir),
                    node_key=node_key,
                    role="work",
                    output_mode="text",
                    prompt=prompt,
                    accompanying=accompanying,
                    input_paths=[],
                    auto_pack=False,
                ),
                timeout=max(60.0, wall_s),
            )
        except TimeoutError as exc:
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: таймаут ответа модели "
                f"({int(max(60.0, wall_s))} с) — шлюз не ответил"
            ) from exc
    logger.info(
        "[#%s] %s: модель %s, мышление %s",
        getattr(project, "id", "?"),
        node_key,
        model_id,
        effort,
    )
    text = str(res.reply_text or "").strip()
    if not text:
        raise RuntimeError(f"#{getattr(project, 'id', '?')} {node_key}: пустой ответ модели")
    return text


async def _ask_json(project: Any, node_key: str, prompt: str, accompanying: str) -> dict:
    """Вызов модели с разбором JSON-объекта (с спасением обрезанного хвоста)."""
    from app.services.ai_result_io import parse_json_object
    from app.services.db_apply import close_truncated_json

    text = await _ask_text(project, node_key, prompt, accompanying)
    try:
        payload = parse_json_object(text)
    except ValueError as exc:
        payload = close_truncated_json(text)
        if not isinstance(payload, dict):
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: модель вернула не JSON ({exc})"
            ) from exc
    if not isinstance(payload, dict):
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: ответ модели — не JSON-объект"
        )
    return payload


def _parallel_limits(project: Any | None = None) -> tuple[int, float]:
    """Размер пачки и пауза между пачками для per-scene вызовов модели.

    ``PLAN_CINEMA_SCENES_PARALLEL`` (default 4) — сколько сцен спрашиваем у
    модели одновременно; ``1`` включает старое серийное поведение.
    ``PLAN_CINEMA_SCENES_STAGGER`` (default 1.0) — пауза между пачками, сек.

    Env задаёт поведение процесса, но переключать режим без рестарта нужно для
    A/B: если переменных нет, читаем ``data/plan_cinema_parallel.json``
    (``{"parallel": 1, "stagger": 1.0}``) — один и тот же сервер, разные
    прогоны. Файл опционален, битый файл — дефолт.

    Параллельны только вызовы модели. Запись в БД всегда идёт после пачки и
    строго в порядке сцен: сессия SQLAlchemy async не терпит конкурентных
    flush, а порядок правок должен быть предсказуемым.
    """
    raw_size = str(os.environ.get("PLAN_CINEMA_SCENES_PARALLEL") or "").strip()
    raw_stagger = str(os.environ.get("PLAN_CINEMA_SCENES_STAGGER") or "").strip()
    if not raw_size or not raw_stagger:
        try:
            from app.settings import settings as _settings

            path = Path(_settings.data_dir) / "plan_cinema_parallel.json"
            if path.is_file():
                config = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(config, dict):
                    if not raw_size:
                        raw_size = str(config.get("parallel") or "").strip()
                    if not raw_stagger:
                        raw_stagger = str(config.get("stagger") or "").strip()
        except (OSError, ValueError):
            logger.warning("plan_cinema: plan_cinema_parallel.json не прочитан — дефолт")
    try:
        size = int(raw_size) if raw_size else 4
    except ValueError:
        size = 4
    try:
        stagger = float(raw_stagger) if raw_stagger else 1.0
    except ValueError:
        stagger = 1.0
    return max(1, size), max(0.0, stagger)


async def _run_in_batches(
    items: Sequence[Any],
    worker: Any,
    commit: Any,
    *,
    size: int,
    stagger: float,
    project_id: Any = "?",
    node_key: str = "",
    label: Any = None,
) -> list[Any]:
    """Прогнать ``items`` через ``worker`` пачками по ``size`` и закоммитить.

    Внутри пачки — ``asyncio.gather`` (только вызовы модели, без записи),
    между пачками — пауза ``stagger``. После пачки результаты идут в
    ``commit`` по одному и строго в порядке ``items``: сессия SQLAlchemy async
    не терпит конкурентных flush, а порядок правок должен быть предсказуемым.
    При ``size <= 1`` поведение прежнее серийное (вызов → запись → следующий).
    Исключение из ``worker``/``commit`` не глотается: нода падает.

    На каждую сцену пишется INFO: номер пачки, сцена, время вызова и время
    записи — по журналу видно, где именно ушло время (модель или БД).
    ``label`` — функция «item → метка сцены» для этого лога.
    """
    done: list[Any] = []
    llm_ms_holder: list[int] = [0]

    def _scene_label(item: Any, position: int) -> Any:
        if callable(label):
            try:
                return label(item)
            except Exception:  # noqa: BLE001 — лог не должен валить прогон
                return position + 1
        return position + 1

    async def _timed(item: Any) -> tuple[Any, int]:
        started = time.perf_counter()
        result = await worker(item)
        return result, int((time.perf_counter() - started) * 1000)

    async def _commit_one(result: Any, scene: Any, pack: Any) -> None:
        started = time.perf_counter()
        await commit(result)
        commit_ms = int((time.perf_counter() - started) * 1000)
        # Строку хронометража пишем в loguru: stdlib-INFO этого модуля в файл
        # студии не доходит (стандартный логгер перехватывается только с
        # WARNING), а по этой строке видно, где время — в модели или в БД.
        try:
            from loguru import logger as _loguru

            _loguru.info(
                "[#{}] {}: сцена {}, пачка {} — вызов {} мс, запись {} мс",
                project_id,
                node_key,
                scene,
                pack,
                llm_ms_holder[0],
                commit_ms,
            )
        except Exception:  # noqa: BLE001 — хронометраж не должен валить ноду
            logger.info(
                "[#%s] %s: сцена %s, пачка %s — вызов %s мс, запись %s мс",
                project_id,
                node_key,
                scene,
                pack,
                llm_ms_holder[0],
                commit_ms,
            )

    if size <= 1:
        for position, item in enumerate(items):
            result, llm_ms = await _timed(item)
            llm_ms_holder[0] = llm_ms
            await _commit_one(result, _scene_label(item, position), "серийно")
            done.append(result)
        return done
    for pack, start in enumerate(range(0, len(items), size), 1):
        if start:
            await asyncio.sleep(stagger)
        chunk = items[start : start + size]
        pairs = await asyncio.gather(*(_timed(item) for item in chunk))
        for offset, (result, llm_ms) in enumerate(pairs):
            llm_ms_holder[0] = llm_ms
            await _commit_one(
                result, _scene_label(items[start + offset], start + offset), pack
            )
        done.extend(result for result, _llm_ms in pairs)
    return done


def _scenes_artifact(project: Any) -> dict[str, Any] | None:
    """Артефакт «Сцены по плану» (вход всех следующих нод)."""
    data = _apply().read_artifact(project, _BY_KIND["scenes"].node_id, ARTIFACT_SCENES)
    return data if isinstance(data, dict) else None


def _require_scenes_artifact(project: Any) -> dict[str, Any]:
    data = _scenes_artifact(project)
    if not data or not isinstance(data.get("сцены"), list) or not data["сцены"]:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')}: нет артефакта {ARTIFACT_SCENES} — "
            "сначала запусти ноду «Сцены по плану» (pk_scenes)"
        )
    return data


def _scenes_for_gate(data: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"номер": int(item.get("номер") or 0), "id_плана": list(item.get("id_плана") or [])}
        for item in data.get("сцены") or []
        if isinstance(item, dict)
    ]


# Стиль сцены: конспект вместо действия — брак, а не вкусовщина. Гейт ловит
# ровно то, что промт называет запретом, чтобы «Шоты» не разбирали пересказ.
SCENE_WORDS_MIN = 85
SCENE_WORDS_MAX = 160
SCENE_INSERT_WORDS_MIN = 50
SCENE_INSERT_WORDS_MAX = 100
SCENE_BANNED_PHRASES = (
    "пишет о",
    "рассказывает о",
    "сообщает о",
    "объявляет о",
    "осознаёт",
    "вспоминает",
    "размышляет",
    "мы видим",
    "в кадре видно",
    "эта история",
    "данный эпизод",
)


def _scene_style_problems(scenes: Sequence[dict[str, Any]]) -> list[str]:
    """Проверка объёма, кадрового бюджета и запрещённого пересказа.

    Кадровый бюджет проверяем только когда модель его прислала: нода пишет
    карточку сцены как текст (``номер``, ``id_плана``, ``сцена``,
    ``сцена_вставка``), а ``место``/``персонажи``/``кадров_макс`` собирают
    следующие шаги (решение владельца 22.11.2026). Требовать бюджет у
    четырёхпольной карточки — значит гонять прогон в вечный ретрай.
    """
    problems: list[str] = []
    for raw in scenes:
        if not isinstance(raw, dict):
            continue
        number = int(raw.get("номер") or 0)
        text = str(raw.get("сцена") or "")
        words = len(text.split())
        insert = bool(raw.get("сцена_вставка"))
        back = int(raw.get("возврат_к_сцене") or 0)
        cap_raw = raw.get("кадров_макс")
        cap = int(cap_raw or 0)
        if insert:
            lo, hi = SCENE_INSERT_WORDS_MIN, SCENE_INSERT_WORDS_MAX
        else:
            lo, hi = SCENE_WORDS_MIN, SCENE_WORDS_MAX
        if words < lo or words > hi:
            problems.append(
                f"сцена {number}: {words} слов, нужно {lo}–{hi} — действие подробнее"
            )
        low = text.casefold()
        for phrase in SCENE_BANNED_PHRASES:
            if phrase in low:
                problems.append(
                    f"сцена {number}: «{phrase}» — пересказ, покажи следствием поступка"
                )
        if not cap:
            # Карточка без кадрового бюджета: нода пишет текст сцены, а число
            # кадров режут следующие шаги. 0 — «не задан», а не «ноль кадров».
            continue
        if insert:
            # Промт разрешает 1–2 кадра на врезку (короткая сцена-удар), гейт
            # врезок тоже держит потолок 2: требовать ровно 2 — расхождение с
            # контрактом, из-за него врезка на один кадр падала в ретрай.
            if cap not in (1, 2):
                problems.append(f"сцена {number}: врезка, кадров_макс={cap}, нужно 1–2")
        elif back:
            if cap not in (0, *range(4, 11)):
                problems.append(
                    f"сцена {number}: возврат после врезки, кадров_макс={cap}, нужно 0"
                )
        elif cap not in range(4, 11):
            problems.append(
                f"сцена {number}: кадров_макс={cap}, нужно 4–10 по числу битов"
            )
    return problems


# ── Обработчики нод ─────────────────────────────────────────────────────────


async def _run_scenes(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 1: сценарий прозой → пункты (разбивка ноды) → сцены.

    Пункты плана выделяет сама нода: на вход идёт исходный текст как есть,
    ответ содержит разбивку ``пункты`` (P1…Pn) и ``сцены`` со ссылками на неё.
    Код проверяет только честность разбивки (дословность, порядок, покрытие
    входа) и держит гейт R-PLAN-COVER.
    """
    split = _split()
    gates = _gates()
    # Вход — выход ноды, подведённой стрелкой: «Тема» даёт текст темы,
    # «Сценарий» — общий план. Без стрелки остаётся план проекта.
    plan_text, input_kind = _source().read_node_input_text(project, node_key)
    if not plan_text:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: вход пуст — подведи "
            "«Тему» (или заполни «Сценарий»): резать нечего"
        )
    master = _read_master(project, node_key, _BY_KIND["scenes"])

    last_problems: list[str] = []
    points: list[tuple[str, str]] = []
    scenes: list[dict[str, Any]] = []
    for attempt in range(1, COVER_ATTEMPTS + 1):
        prompt = _render(master, ПЛАН=plan_text)
        raw = await _ask_text(
            project,
            node_key,
            prompt,
            _retry_block(last_problems) if attempt > 1 else "",
        )
        try:
            points, scenes = split.parse_plan_reply(raw)
        except split.PlanScenesError as exc:
            last_problems = [f"ответ не по контракту: {exc}"]
            logger.warning("[#%s] %s: попытка %s — %s", project.id, node_key, attempt, exc)
            continue
        # Модель иногда подменяет кириллицу латиницей в месте («лачугa»):
        # такая подмена разрывает группировку мест и имён на следующих шагах.
        points = [(code, split.fix_homoglyphs(text)) for code, text in points]
        scenes = [split.fix_scene_homoglyphs(scene) for scene in scenes]
        if len(points) < MIN_SCENES:
            last_problems = [
                f"пунктов {len(points)}, нужно 4–10 по числу битов сценария"
            ]
            logger.warning(
                "[#%s] %s: попытка %s, пунктов мало: %s",
                project.id,
                node_key,
                attempt,
                len(points),
            )
            continue
        plan_problems = split.check_points_cover_plan(plan_text, points)
        if plan_problems:
            last_problems = plan_problems
            logger.warning(
                "[#%s] %s: попытка %s, разбивка не покрывает вход: %s",
                project.id,
                node_key,
                attempt,
                "; ".join(plan_problems[:6]),
            )
            continue
        numbered = split.format_plan_points(points)
        # Врезка (П3) — мягкая проверка пары «врезка → возврат»: гейт покрытия
        # её не ужесточает, но кривую пару покажем модели на второй попытке.
        last_problems = list(split.insert_scene_problems(scenes))
        verdict = gates.check_plan_coverage(points, scenes)
        if not verdict.get("passed"):
            last_problems = list(verdict.get("errors") or [])
            for code in verdict.get("uncovered") or []:
                last_problems.append(f"пункт {code} не покрыт ни одной сценой")
            for code in verdict.get("unknown") or []:
                last_problems.append(f"сцена ссылается на несуществующий пункт {code}")
            logger.warning(
                "[#%s] %s: попытка %s, R-PLAN-COVER fail: %s",
                project.id,
                node_key,
                attempt,
                "; ".join(last_problems[:6]),
            )
            continue
        style_problems = _scene_style_problems(scenes)
        if style_problems:
            last_problems = style_problems
            logger.warning(
                "[#%s] %s: попытка %s, стиль сцены: %s",
                project.id,
                node_key,
                attempt,
                "; ".join(style_problems[:8]),
            )
            continue
        path = _apply().save_artifact(
            project,
            node_key,
            ARTIFACT_SCENES,
            {
                "пункты": [{"код": code, "текст": text} for code, text in points],
                "план_с_номерами": numbered,
                "сцены": scenes,
            },
        )
        # Ноды «Каркас» больше нет: сцены сами несут карточку (место,
        # персонажи, предметы, событие, действие), поэтому ячейки Frame
        # пишет этот же шаг — иначе «Диалоги» и «Шоты» читают старые сцены.
        cells = await _ensure_scene_cells(session, project, scenes, scenes)
        # Реестр персонажей уже собран (повторный прогон «Сцен»): сразу переводим
        # имена в коды, иначе «Диалоги»/«Шоты» увидят в сцене людей без кодов.
        remapped = await _map_scene_characters_to_codes(session, project)
        if remapped:
            await session.commit()
        return NodeResult(
            reply_text=(
                f"сцены по плану: вход {_INPUT_KIND_RU.get(input_kind, input_kind)} "
                f"{len(plan_text)} зн., пунктов {len(points)}, сцен {len(scenes)}, "
                f"ячеек {len(cells)}, покрытие R-PLAN-COVER pass, стиль pass"
                + (f", кодов персонажей {remapped}" if remapped else "")
            ),
            output_paths=[path],
        )
    raise RuntimeError(
        f"#{getattr(project, 'id', '?')} {node_key}: R-PLAN-COVER fail после "
        f"{COVER_ATTEMPTS} попыток — {json.dumps(last_problems[:8], ensure_ascii=False)}"
    )


async def _run_cast(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 2: сцены + план → реестр ``Entity(type="character")``; гейт R-CAST-DUP."""
    gates = _gates()
    data = _require_scenes_artifact(project)
    master = _read_master(project, node_key, _BY_KIND["cast"])
    prompt = _render(
        master,
        ПЛАН_С_НОМЕРАМИ=str(data.get("план_с_номерами") or ""),
        СЦЕНЫ=_json(data.get("сцены") or []),
    )
    payload = await _ask_json(project, node_key, prompt, "Реестр персонажей целиком.")
    characters = payload.get("персонажи")
    if not isinstance(characters, list) or not characters:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: ответ без списка «персонажи»"
        )
    problems = gates.cast_duplicate_problems(characters)
    if problems:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: R-CAST-DUP fail — "
            f"{json.dumps(problems[:8], ensure_ascii=False)}"
        )
    result = await _apply().write_entities(session, project, characters=characters)
    # Старый реестр остаётся в базе активным после смены сценария: люди
    # прошлого ролика (c12…) попадали в промты «Диалогов» и «Шотов» наравне
    # с новыми. Всё, чего нет в этом ответе, уводим в архив.
    new_codes = {
        str(item.get("id") or "").strip()
        for item in characters
        if isinstance(item, dict)
    }
    archived = await _apply().archive_characters_not_in(session, project, new_codes)
    # Реестр построен: «Сцены» пишут персонажей именами (кодов на том шаге ещё
    # нет, каркас удалён), а «Диалоги»/«Шоты» ждут коды c0N. Заменяем имена на
    # коды прямо в attrs сцен — иначе гейт R-DLG-SPEAKER и карточки кадров
    # видят людей без кодов.
    # Сначала привязка, которую модель дала сама («кто в какой сцене»), —
    # она читает текст сцены целиком и знает вариации. Текстовый разбор ниже
    # остаётся запасным путём: он не различает падежи и роли.
    scene_roles = payload.get("сцены")
    mapped = 0
    if isinstance(scene_roles, list) and scene_roles:
        mapped = await _apply_scene_roles_from_reply(session, project, scene_roles)
    if not mapped:
        mapped = await _map_scene_characters_to_codes(session, project)
    return NodeResult(
        reply_text=(
            f"персонажи: {len(characters)} записей, записано "
            f"{result.get('characters', 0)}, в архиве {archived}, "
            f"кодов в сценах {mapped}, R-CAST-DUP pass"
        )
    )


#: Синонимы полей реплики: модель иногда пишет латиницей/по-английски.
_REPLICA_ALIASES = {
    "text": "текст",
    "line": "текст",
    "who": "кто",
    "speaker": "кто",
    "emotion": "эмоция",
    "tone": "эмоция",
}
#: Синонимы типа речи.
_SPEECH_TYPE_ALIASES = {
    "no": "нет",
    "none": "нет",
    "monologue": "монолог",
    "dialogue": "диалог",
}


def _normalize_speech_payload(payload: Any) -> dict[str, Any]:
    """``речь`` из ответа модели → контрактные поля.

    Гейт ``R-DLG-FORM`` строгий: лишнее поле — брак. Но ответы приходят с
    ``text``/``who`` вместо ``текст``/``кто``, и шаг падал на формальности,
    хотя диалог верный. Переводим синонимы до гейта, не ослабляя контракт:
    неизвестное поле по-прежнему остаётся и будет поймано.
    """
    raw = payload if isinstance(payload, Mapping) else {}
    speech: dict[str, Any] = {
        "тип": str(raw.get("тип") or raw.get("type") or "").strip(),
        "реплики": [],
    }
    kind = speech["тип"].casefold()
    if kind in _SPEECH_TYPE_ALIASES:
        speech["тип"] = _SPEECH_TYPE_ALIASES[kind]
    replicas = raw.get("реплики")
    if not isinstance(replicas, list):
        replicas = raw.get("replicas") if isinstance(raw.get("replicas"), list) else []
    for replica in replicas:
        if not isinstance(replica, Mapping):
            speech["реплики"].append(replica)
            continue
        item: dict[str, Any] = {}
        for key, value in replica.items():
            name = str(key).strip()
            item[_REPLICA_ALIASES.get(name.casefold(), name)] = value
        speech["реплики"].append(item)
    return speech


def _name_key(value: Any) -> str:
    """Ключ сравнения имён: нижний регистр, без знаков, лишних пробелов."""
    text = re.sub(r"[^0-9a-zа-яё]+", " ", str(value or "").lower())
    return " ".join(text.split())


async def _map_scene_characters_to_codes(session: Any, project: Any) -> int:
    """Имена персонажей в ``Frame.attrs["персонажи"]`` → коды реестра.

    Совпадение точное по нормализованному имени, затем по вхождению одного в
    другое (в плане пишут «комиссар Маркес Джодокус», в сцене — «комиссар»).
    Неизвестное имя не выдумывает код: оно просто выпадает из списка.

    С шага «Сцены» карточка сцены больше не содержит поля ``персонажи`` (его
    собирают следующие ноды), поэтому для пустого списка имена ищем прямо в
    тексте сцены: «Император» → ``c01``. Иначе «Диалоги» и «Шоты» остаются без
    привязки людей к сцене.
    """
    apply = _apply()
    registry = await apply.load_characters(session, project)
    by_name: dict[str, str] = {}
    for code, item in registry.items():
        key = _name_key(item.get("имя") or item.get("name"))
        if key:
            by_name.setdefault(key, str(code))
    if not by_name:
        return 0
    keys = list(by_name)
    #: Ключи поиска по тексту сцены. Берём все слова имени до запятой: в
    #: сцене пишут «Дорн», а в реестре «Рогал Дорн, участник ударной группы».
    #: Слово, которое встречается у двух карточек («командир»), пропускаем:
    #: иначе оно приписывало сцене чужих людей. Вариации («Хорус — ранен») не
    #: ищем: у них то же имя, что у основы.
    variations = {
        str(code)
        for code, item in registry.items()
        if _is_variation_card(item)
    }
    candidates: dict[str, set[str]] = {}
    for key, code in by_name.items():
        if code in variations:
            continue
        head = key.split(",")[0].strip()
        for word in head.split(" "):
            if len(word) >= 4:
                candidates.setdefault(word, set()).add(code)
    text_keys: list[tuple[str, str]] = [
        (word, next(iter(codes)))
        for word, codes in candidates.items()
        if len(codes) == 1
    ]
    mapped = 0
    for frame in await apply.load_scenes(session, project):
        attrs = dict(frame.attrs) if isinstance(frame.attrs, dict) else {}
        names = attrs.get("персонажи")
        # Привязку от самой модели не перебиваем: она видела текст сцены.
        if attrs.get("персонажи_из_сцен"):
            continue
        # Коды, выведенные из текста раньше, пересчитываем: после правки
        # реестра в них могли попасть вариации и лишние люди. Признак такой
        # привязки — список из одних кодов `c0N` без пометки.
        all_codes = (
            isinstance(names, list)
            and bool(names)
            and all(re.fullmatch(r"c\d{2,}", str(item or "").strip()) for item in names)
        )
        derive_from_text = (
            bool(attrs.get("персонажи_из_текста"))
            or all_codes
            or not (isinstance(names, list) and names)
        )
        has_names = not derive_from_text and isinstance(names, list) and bool(names)
        codes: list[str] = []
        if has_names:
            for raw in names:
                text = str(raw or "").strip()
                if not text:
                    continue
                if re.fullmatch(r"c\d{2,}", text):
                    codes.append(text)
                    continue
                key = _name_key(text)
                code = by_name.get(key)
                if code is None and key:
                    for candidate in keys:
                        if key in candidate or candidate in key:
                            code = by_name[candidate]
                            break
                if code and code not in codes:
                    codes.append(code)
        else:
            scene_key = _name_key(attrs.get("сцена"))
            if not scene_key:
                continue
            for head, code in text_keys:
                if code in codes:
                    continue
                # Окончание до трёх букв: в сцене «умирающим Императором»,
                # в реестре — «Император».
                if re.search(
                    rf"(?<![\wа-яё]){re.escape(head)}[а-яё]{{0,3}}(?![\wа-яё])",
                    scene_key,
                ):
                    codes.append(code)
        if has_names and codes == list(names):
            continue
        if not codes:
            if not derive_from_text or not names:
                continue
        attrs["персонажи"] = codes
        if derive_from_text:
            attrs["персонажи_из_текста"] = True
        await apply.write_scene_attrs(session, project, str(frame.uuid), attrs)
        mapped += len(codes)
    return mapped


def _is_variation_card(item: Mapping[str, Any]) -> bool:
    """Карточка-вариация: у неё заполнено ``правила`` (id основы)."""
    rules = str(item.get("правила") or item.get("rules") or "").strip()
    if rules:
        return True
    name = str(item.get("имя") or item.get("name") or "").casefold()
    return "вариация" in name


async def _apply_scene_roles_from_reply(
    session: Any,
    project: Any,
    scene_roles: Sequence[Any],
) -> int:
    """``сцены`` из ответа «Персонажей»: номер сцены + имена → коды в attrs.

    Модель читает текст сцены целиком и сама называет, кто в ней есть, — это
    точнее текстового разбора по словам (он цепляется за падежи и роли).
    Имена ищутся в реестре по полному имени и по части до запятой. Неизвестное
    имя не выдумывает код. Транзакцию не коммитит.
    """
    apply = _apply()
    registry = await apply.load_characters(session, project)
    by_name: dict[str, str] = {}
    for code, item in registry.items():
        name = str(item.get("имя") or item.get("name") or "")
        for key in (_name_key(name), _name_key(name.split(",")[0])):
            if key:
                by_name.setdefault(key, str(code))
    frames = {int(frame.number): frame for frame in await apply.load_scenes(session, project)}
    applied = 0
    for raw in scene_roles:
        if not isinstance(raw, Mapping):
            continue
        try:
            number = int(raw.get("номер") or 0)
        except (TypeError, ValueError):
            continue
        frame = frames.get(number)
        if frame is None:
            continue
        names = raw.get("персонажи")
        if not isinstance(names, list):
            continue
        codes: list[str] = []
        for name in names:
            key = _name_key(name)
            if not key:
                continue
            code = by_name.get(key) or by_name.get(_name_key(str(name).split(",")[0]))
            if code is None:
                for candidate, candidate_code in by_name.items():
                    if key in candidate or candidate in key:
                        code = candidate_code
                        break
            if code and code not in codes:
                codes.append(code)
        attrs = dict(frame.attrs) if isinstance(frame.attrs, dict) else {}
        attrs["персонажи"] = codes
        attrs["персонажи_из_сцен"] = True
        await apply.write_scene_attrs(session, project, str(frame.uuid), attrs)
        applied += len(codes)
    return applied


def _scene_attrs(raw: Mapping[str, Any], plan_refs: list[str]) -> dict[str, Any]:
    """``attrs`` ячейки сцены из карточки модели: все поля, ничего не теряем.

    Раньше здесь был жёсткий список из 11 ключей, и ``примечание`` (а также
    любое поле, которое модель добавила сама) в базу не попадало: результат в
    БД расходился с artifact, следующие шаги этих данных не видели.
    """
    attrs: dict[str, Any] = {
        "источник": "pk",
        "id_плана": list(plan_refs),
        "место": str(raw.get("место") or ""),
        "персонажи": list(raw.get("персонажи") or []),
        "предметы": list(raw.get("предметы") or []),
        "событие": str(raw.get("событие") or ""),
        "сцена": str(raw.get("сцена") or ""),
        "примечание": str(raw.get("примечание") or ""),
        # Врезка (П3): поля необязательные, у обычной сцены просто false/0.
        "сцена_вставка": bool(raw.get("сцена_вставка") or False),
        "возврат_к_сцене": int(raw.get("возврат_к_сцене") or 0),
        "продолжение_фона": bool(raw.get("продолжение_фона") or False),
        "кадров_макс": int(raw.get("кадров_макс") or 0),
    }
    for key, value in raw.items():
        name = str(key)
        if name in attrs or name in ("номер", "id_плана", "источник"):
            continue
        attrs[name] = value
    return attrs


async def _ensure_scene_cells(
    session: Any,
    project: Any,
    scenes: list[dict[str, Any]],
    step1: list[dict[str, Any]],
) -> list[Any]:
    """Ячейки ``Frame`` сцен: создать при первом прогоне, иначе обновить ``attrs``.

    Сцена — ячейка ``Frame`` (``Scene`` только папка), ``voiceover_text=""``.
    Старые ячейки проекта не трогаются: при первом прогоне создаются новые
    сцены, при повторном обновляются только сцены ``attrs["источник"] == "pk"``.
    """
    apply = _apply()
    from app.models import Frame, FrameStatus, Scene
    from app.services.db_v2 import new_frame_uuid

    refs_by_number = {
        int(item.get("номер") or 0): list(item.get("id_плана") or [])
        for item in step1
        if isinstance(item, dict)
    }
    existing = await apply.load_scenes(session, project)
    if existing and len(existing) != len(scenes):
        # План переписали — число сцен поменялось. Старые ячейки не удаляем:
        # снимаем метку источника, чтобы группа их больше не видела, и создаём
        # новый комплект. Так повторный прогон не упирается в «12 → 11».
        logger.warning(
            "[#%s] сцен было %s, стало %s — старые ячейки сняты с учёта",
            getattr(project, "id", "?"),
            len(existing),
            len(scenes),
        )
        for frame in existing:
            attrs = dict(frame.attrs) if isinstance(frame.attrs, dict) else {}
            # Всё, что делало ячейку «живой» для следующих нод, убираем: иначе
            # архивные сцены висят в очереди «Картинок» под номерами 1000xx и
            # просят генерацию по старым промтам. «удалён» — штатная пометка,
            # по ней платная генерация пропускает кадр навсегда.
            attrs = {
                "источник": "pk_archived",
                "архив_номер": attrs.get("номер") or attrs.get("архив_номер"),
                "удалён": True,
                "пометка": "архив прежнего разбиения по плану",
            }
            frame.attrs = attrs
            frame.image_prompt = ""
            frame.animation_prompt = ""
            frame.status = FrameStatus.planned
            # Номер уникален в проекте: архивным ячейкам отдаём смещённый
            # диапазон, чтобы новый комплект сцен занял номера 1..N.
            frame.number = 100000 + int(getattr(frame, "id", 0) or 0)
            frame.sort_key = 1000000.0 + float(getattr(frame, "id", 0) or 0)
        await session.flush()
        existing = []
    if existing:
        for frame, raw in zip(existing, scenes, strict=False):
            number = int(raw.get("номер") or 0)
            attrs = _scene_attrs(raw, refs_by_number.get(number, []))
            await apply.write_scene_attrs(session, project, str(frame.uuid), attrs)
        return existing

    scene = (
        (await session.execute(__import__("sqlalchemy").select(Scene).where(Scene.project_id == project.id)))
        .scalars()
        .first()
    )
    if scene is None:
        scene = Scene(project_id=project.id, sort_key=10.0, title="main")
        session.add(scene)
        await session.flush()
    cells: list[Frame] = []
    for index, raw in enumerate(scenes, 1):
        number = int(raw.get("номер") or index)
        frame = Frame(
            project_id=project.id,
            number=index,
            voiceover_text="",
            meaning=str(raw.get("событие") or ""),
            duration_seconds=None,
            uuid=new_frame_uuid(),
            sort_key=float(index) * 10.0,
            scene_id=scene.id,
            status=FrameStatus.planned,
            attrs=_scene_attrs(raw, refs_by_number.get(number, [])),
        )
        session.add(frame)
        cells.append(frame)
    await session.flush()
    return cells


async def _run_skeleton(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 3: сцены шага 1 → текст действия и `attrs` ячеек сцен."""
    data = _require_scenes_artifact(project)
    characters = await _apply().load_characters(session, project)
    master = _read_master(project, node_key, _BY_KIND["skeleton"])
    prompt = _render(
        master,
        СЦЕНЫ=_json(data.get("сцены") or []),
        РЕЕСТР=_json(_registry_list(characters)),
    )
    payload = await _ask_json(project, node_key, prompt, "Сцены каркаса целиком.")
    scenes = payload.get("сцены")
    if not isinstance(scenes, list) or not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: ответ без списка «сцены»"
        )
    step1 = [item for item in data.get("сцены") or [] if isinstance(item, dict)]
    if len(scenes) != len(step1):
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: сцен в ответе {len(scenes)}, "
            f"во входе {len(step1)} — одна сцена входа = одна сцена ответа"
        )
    cells = await _ensure_scene_cells(session, project, scenes, step1)
    return NodeResult(
        reply_text=(
            f"каркас: сцен {len(cells)}, у каждой attrs источник=pk, "
            'voiceover_text=""'
        )
    )


def _plan_points(project: Any) -> list[tuple[str, str]]:
    """Пункты плана с кодами: артефакт «Сцены» важнее нумерации прозы.

    Нода «Сцены» формулирует свои опорные точки (``пункты`` с кодами P1..Pn) и
    ссылается на них в ``id_плана``. Нумерация абзацев сырой прозы — другая
    нумерация: тот же код P2 там означает чужой абзац, и «Диалоги» получали
    план не про свою сцену (модель честно отвечала «нет речи»). Поэтому берём
    пункты из артефакта сцен, а на нумерацию прозы падаем только если артефакта
    нет.
    """
    artifact = _scenes_artifact(project) or {}
    points: list[tuple[str, str]] = []
    for item in artifact.get("пункты") or []:
        if not isinstance(item, Mapping):
            continue
        code = str(item.get("код") or "").strip()
        text = " ".join(str(item.get("текст") or "").split())
        if code and text:
            points.append((code, text))
    if points:
        return points
    return _split().num_plan_points(_source().read_plan_text(project))


async def _run_dialogues(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 4: по сцене → ``attrs["речь"]``; гейты R-DLG-FORM и R-DLG-SPEAKER."""
    apply = _apply()
    gates = _gates()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    characters = await apply.load_characters(session, project)
    registry_codes = sorted(characters)
    # Сцены могли переписать уже после «Персонажей» (повторный прогон одного
    # шага): в attrs снова имена, а модель пишет реплики кодами c0N — гейт
    # R-DLG-SPEAKER бракует верный диалог. Пересобираем коды из реестра здесь
    # же, чтобы нода работала при частичном прогоне, а не только по цепочке.
    if registry_codes:
        remapped = await _map_scene_characters_to_codes(session, project)
        if remapped:
            logger.info(
                "[#%s] %s: персонажи сцен → коды реестра, заменено %s",
                getattr(project, "id", "?"),
                node_key,
                remapped,
            )
            await session.commit()
            scenes = await apply.load_scenes(session, project)
    plan_points = _plan_points(project)
    plan_by_code = dict(plan_points)
    master = _read_master(project, node_key, _BY_KIND["dialogues"])
    # Один пункт плана — одна сцена с речью. Владелец словесного действия
    # определяется по говорящим из реестра, остальные сцены этого пункта
    # получают пометку «уже отыграно» (план → номер сцены-владельца).
    speech_owners = _speech_points_owners(
        [_scene_dict(frame) for frame in scenes], plan_by_code, characters
    )
    # Промты собираем заранее и один раз: в пачке разница только в том, когда
    # именно ушёл вызов, сам промт сцены от этого не меняется.
    jobs: list[tuple[dict[str, Any], str]] = []
    for frame in scenes:
        scene = _scene_dict(frame)
        # План — единственный источник того, что люди произносят: в сцене
        # остаётся только действие. Отдаём модели пункты именно этой сцены.
        refs = [str(code) for code in scene.get("id_плана") or []]
        scene_plan = "\n".join(
            f"{code}: {plan_by_code[code]}" for code in refs if code in plan_by_code
        ) or "\n".join(f"{code}: {text}" for code, text in plan_points)
        already = [
            {"пункт": code, "сцена": owner}
            for code, owner in speech_owners.items()
            if code in refs and owner != int(scene.get("номер") or 0)
        ]
        scene_for_prompt = dict(scene)
        if already:
            scene_for_prompt["речь_уже_отыграна"] = already
        prompt = _render(
            master,
            СЦЕНА=_json(scene_for_prompt),
            ПЛАН=scene_plan,
            РЕЕСТР=_json(_registry_list(characters)),
        )
        jobs.append((scene, prompt))

    async def _ask_scene(job: tuple[dict[str, Any], str]) -> tuple[dict[str, Any], dict[str, Any]]:
        scene, prompt = job
        payload = await _ask_json(project, node_key, prompt, "Речь этой сцены целиком.")
        return scene, payload

    written = 0
    # Итог по сценам — для артефакта: без файла вкладка «Результат» у диалогов
    # пустая, хотя речь записана в кадры.
    speeches: list[dict[str, Any]] = []
    speeches_by_number: dict[str, dict[str, Any]] = {}

    async def _commit(answer: tuple[dict[str, Any], dict[str, Any]]) -> None:
        nonlocal written
        scene, payload = answer
        speech = _normalize_speech_payload(payload)
        problems = gates.dialog_problems(
            speech,
            list(scene.get("персонажи") or []),
            registry_codes,
            # План этой сцены для требования «в плане реплика — значит не „нет“».
            # Владелец 2026-11-20: требование отключено — нода не имеет права
            # падать из-за того, что модель честно ответила «нет». Дальше решает
            # человек, а не гейт.
            plan_text="",
        )
        if problems:
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']}, "
                f"R-DLG fail — {json.dumps(problems[:8], ensure_ascii=False)}"
            )
        await apply.apply_plan_ops(
            session,
            project,
            [{"frame_uuid": scene["id"], "fields": {"речь": speech}}],
        )
        row = {"номер": scene["номер"], "тип": speech.get("тип") or "нет"}
        reply_lines = speech.get("реплики") or []
        row["реплик"] = len(reply_lines)
        if reply_lines:
            row["речь"] = reply_lines
            speeches_by_number[str(scene["номер"])] = row
            written += 1
        # Коммитим каждую сцену: иначе длинная транзакция шага держит write-lock
        # SQLite, и учёт LLM (`llm_ledger`) не может вставить строку — каждый
        # вызов ждёт освобождения блокировки (~66 с на сцену). Плюс прогресс
        # переживает падение ноды.
        await session.commit()

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: сцен %s, пачка %s, пауза %.1f с",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        size,
        stagger,
    )
    await _run_in_batches(
        jobs,
        _ask_scene,
        _commit,
        size=size,
        stagger=stagger,
        project_id=getattr(project, "id", "?"),
        node_key=node_key,
        label=lambda job: job[0]["номер"],
    )
    speeches = [
        speeches_by_number[str(scene["номер"])]
        for scene, _prompt in jobs
        if str(scene["номер"]) in speeches_by_number
    ]
    path = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_DIALOGUES,
        {
            "сцены": speeches,
            "сцен_с_речью": written,
            "сцен_всего": len(jobs),
        },
    )
    return NodeResult(
        reply_text=f"диалоги: сцен с речью {written}, R-DLG-FORM/SPEAKER pass",
        output_paths=[path],
    )


def _shot_prompt_from_fields(
    shot: dict[str, Any], scene: dict[str, Any], background: dict[str, Any] | None
) -> str:
    """Собрать ``промт_картинки`` кадра из его же полей, если модель его не дала.

    Модель иногда оставляет промт только у K1 и у промта конца. Дырку в
    обязательном поле не оставляем: собираем тот же текст из плана, ракурса,
    высоты, фона сцены и действия кадра. Это не выдумка, а компоновка уже
    принятых полей кадра.
    """
    parts: list[str] = ["Линза 35 мм."]
    if shot.get("план"):
        parts.append(f"План {shot['план']}.")
    if shot.get("ракурс"):
        parts.append(f"Ракурс {shot['ракурс']}.")
    if shot.get("высота"):
        parts.append(f"Высота {shot['высота']}.")
    if shot.get("объект"):
        parts.append(f"Объект {shot['объект']}.")
    place = str(scene.get("место") or "").strip()
    if place:
        parts.append(f"Место: {place}.")
    if background:
        for key in ("описание", "свет", "время"):
            value = str(background.get(key) or "").strip()
            if value:
                parts.append(f"{value.rstrip('.')}.")
        shot_background = str(shot.get("фон") or "").strip()
        if shot_background:
            parts.append(f"В кадре видно: {shot_background.rstrip('.')}.")
    if shot.get("кто"):
        parts.append(f"В кадре: {shot['кто']}.")
    if shot.get("позы"):
        parts.append(f"Позы: {str(shot['позы']).rstrip('.')}.")
    if shot.get("действие"):
        parts.append(f"Действие: {str(shot['действие']).rstrip('.')}.")
    return _clamp(" ".join(parts), 4700)


def _clamp(text: str, limit: int) -> str:
    """Обрезать по границе предложения, не длиннее ``limit``."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for separator in (". ", "! ", "? ", "; "):
        position = cut.rfind(separator)
        if position > limit // 2:
            return cut[: position + 1]
    return cut.rstrip()


# ── Непрерывность и камера кадров: детерминированная нормализация ────────────

#: Код персонажа в полях кадра: ``c01``, ``c12``.
_PERSON_CODE_RE = re.compile(r"c\d{2}")
#: Слова стороны в поле ``где``. Порядок важен: «в центре» раньше «по центру».
_SIDE_WORDS: tuple[str, ...] = (
    "слева",
    "справа",
    "в центре",
    "по центру",
    "на переднем плане",
    "в глубине",
)
#: Глаголы перехода: только они разрешают персонажу сменить сторону между кадрами.
_MOVE_WORDS: tuple[str, ...] = (
    "переш",
    "переход",
    "подош",
    "отош",
    "отход",
    "вста",
    "сел ",
    "села",
    "шагн",
    "вош",
    "выш",
    "обош",
    "оберн",
    "поверн",
    "перебеж",
    "подбеж",
    "уход",
    "ушё",
    "двину",
    "сдвину",
    "приблиз",
)
#: Канонные значения камеры — по ним и только по ним правится текст промта.
_CAMERA_VALUES: dict[str, tuple[str, ...]] = {
    "план": ("ДАЛЬНИЙ", "ОБЩИЙ", "СРЕДНИЙ", "СРЕДНЕ-КРУПНЫЙ", "КРУПНЫЙ", "ДЕТАЛЬ"),
    "ракурс": ("фронт", "3/4", "с плеча", "сверху", "снизу", "макро"),
    "высота": ("уровень глаз", "снизу вверх", "сверху вниз"),
}
#: Фрагмент камеры в промте: «план ОБЩИЙ, ракурс фронт, высота уровень глаз».
_CAMERA_FRAGMENT_RE = re.compile(
    r"(?i)(?<![\w-])(план|ракурс|высота)\s+([^,.;\n]+)"
)


def _card_codes(shot: Mapping[str, Any]) -> set[str]:
    """Коды персонажей из поля ``кто``."""
    return set(_PERSON_CODE_RE.findall(str(shot.get("кто") or "")))


def _card_people(shot: Mapping[str, Any]) -> dict[str, str]:
    """Код → имя персонажа из поля ``кто``: «Аделфус (c01), Геннэдиус (c05)»."""
    text = str(shot.get("кто") or "")
    people: dict[str, str] = {}
    for match in _PERSON_CODE_RE.finditer(text):
        head = re.split(r"[,;]", text[: match.start()])[-1].strip(" .,:;()")
        for word in head.split():
            if word[:1].isupper():
                people.setdefault(match.group(0), word)
                break
    return people


def _sides_by_code(shot: Mapping[str, Any]) -> dict[str, str]:
    """Сторона каждого персонажа в ``где``: код → «слева»/«справа»/…"""
    text = str(shot.get("где") or "")
    if not text:
        return {}
    names = _card_people(shot)
    sides: dict[str, str] = {}
    for clause in re.split(r"[;.]", text):
        for piece in re.split(r",", clause):
            piece_fold = piece.casefold()
            side = next((word for word in _SIDE_WORDS if word in piece_fold), "")
            if not side:
                continue
            codes = _PERSON_CODE_RE.findall(piece)
            if codes:
                for code in codes:
                    sides.setdefault(code, side)
                continue
            for code, name in names.items():
                if name and re.search(
                    rf"(?i)(?<![\w-]){re.escape(name)}(?![\w-])", piece
                ):
                    sides.setdefault(code, side)
    return sides


def _motion_text(shot: Mapping[str, Any]) -> str:
    """Текст кадра для поиска глаголов перехода."""
    parts = (shot.get("где"), shot.get("позы"), shot.get("действие"))
    return " ".join(str(part or "") for part in parts).casefold()


def _rewrite_camera_text(shot: dict[str, Any]) -> None:
    """Переписать фрагмент камеры в промтах кадра под поля ``план/ракурс/высота``.

    Промт «Шотов» пишет камеру строчными через запятую: «Линза 35 мм, план ОБЩИЙ,
    ракурс фронт, высота уровень глаз». Меняются только канонные значения, чтобы
    не портить фразы вида «крупный план героя»; если фрагмента нет — камера
    дописывается предложением.
    """
    plan = str(shot.get("план") or "").strip()
    angle = str(shot.get("ракурс") or "").strip()
    height = str(shot.get("высота") or "").strip()
    wanted = {"план": plan, "ракурс": angle, "высота": height}
    if not any(wanted.values()):
        return
    canonical = {
        key: {value.casefold() for value in values}
        for key, values in _CAMERA_VALUES.items()
    }

    for field_name in ("промт_картинки",):
        text = str(shot.get(field_name) or "").strip()
        if not text:
            continue
        rewritten = {"план": False, "ракурс": False, "высота": False}

        def _replace(match: re.Match[str]) -> str:
            key = match.group(1).casefold()
            value = str(match.group(2) or "").strip().casefold()
            if not wanted[key] or value not in canonical[key]:
                return match.group(0)
            rewritten[key] = True
            return f"{match.group(1)} {wanted[key]}"

        text = _CAMERA_FRAGMENT_RE.sub(_replace, text)
        if sum(rewritten.values()) < 2:
            text = (
                f"{text.rstrip('.')}. "
                f"План {plan or 'ОБЩИЙ'}, ракурс {angle or 'фронт'}, "
                f"высота {height or 'уровень глаз'}."
            )
        shot[field_name] = _clamp(text, 4700)


def _normalize_reply_cameras(kadry: list[dict[str, Any]], speech: Mapping[str, Any]) -> None:
    """Закрепить камеру кадра с репликой (П8): диалог — «с плеча», монолог — КРУПНЫЙ.

    Модель ставит репликам «глухой фронт» и случайные планы; снимаем с неё это
    решение: крупность и угол кадра реплики задаёт правило, а не импровизация.
    Встречная пара (две реплики подряд) по канону идёт одним планом, поэтому
    повтор сетапа здесь разрешён.
    """
    replies = [item for item in speech.get("реплики") or [] if isinstance(item, dict)]
    speakers = {str(item.get("кто") or "") for item in replies if str(item.get("кто") or "")}
    monologue = str(speech.get("тип") or "") == "монолог" or len(speakers) == 1
    for shot in kadry:
        if not str(shot.get("реплика") or "").strip():
            continue
        shot["высота"] = "уровень глаз"
        if monologue:
            shot["план"] = "КРУПНЫЙ"
            shot["ракурс"] = "фронт"
            shot["объект"] = "лицо"
        else:
            shot["план"] = "СРЕДНЕ-КРУПНЫЙ"
            shot["ракурс"] = "с плеча"
            shot["объект"] = "двое" if len(_card_codes(shot)) > 1 else "лицо"
        _rewrite_camera_text(shot)


#: Служебные слова, которые не являются якорем зоны («в центре», «на тех же местах»).
_ZONE_STOP_WORDS = frozenset(
    {
        "кадре", "кадр", "прошлом", "тех", "местах", "центре", "переднем",
        "плане", "глубине", "слева", "справа", "рядом", "стоит", "стоят",
        "сидит", "сидят", "находится", "находятся", "который", "которая",
        "после", "того", "этом", "этой", "этого", "тоже", "около", "вдоль",
        "лицом", "боком", "прямо", "чуть", "ближе", "дальше", "между",
    }
)


def _zone_tokens(shot: Mapping[str, Any]) -> set[str]:
    """Якоря зоны из ``где``: «койка», «стол», «прилавок», «проём».

    Сравниваем по основам (первые 5 букв): «Тесенна» в соседних кадрах и
    «Тесенны» — это одна и та же зона, а не смена локации. Иначе валидатор
    валил кадры, где модель назвала тот же объект в другой падежной форме.
    """
    text = str(shot.get("где") or "").casefold()
    text = text.split("на тех же местах")[0]
    return {
        word[:5]
        for word in re.findall(r"[а-яё]{4,}", text)
        if word not in _ZONE_STOP_WORDS
    }


def _zone_changed(previous: Mapping[str, Any], current: Mapping[str, Any]) -> bool:
    """Сменилась ли зона фона: у соседних кадров нет общих якорей места."""
    before = _zone_tokens(previous)
    after = _zone_tokens(current)
    if not before or not after:
        return False
    if str(previous.get("место") or "") != str(current.get("место") or ""):
        return True
    return not (before & after)


#: Минимум знаков в ``действие``: одна фраза короче — это не «начало → ход → итог».
_ACTION_MIN_CHARS = 120


def _shot_contract_problems(kadry: Sequence[Any]) -> list[str]:
    """Замечания, из-за которых ответ по сцене уходит модели на правку.

    Два требования владельца (2026-11-19):
    1) ``действие`` описывает кусок целиком — начало, ход, итог: 2–3 предложения,
       не меньше 120 знаков, без вывода-морали после тире;
    2) кадры внутри сцены не перескакивают между зонами фона без кадра перехода
       с глаголом перемещения.
    """
    shots = [item for item in kadry if isinstance(item, dict)]
    problems: list[str] = []
    for position, shot in enumerate(shots, 1):
        label = str(shot.get("id") or f"K{position}")
        action = str(shot.get("действие") or "").strip()
        sentences = [part for part in re.split(r"(?<=[.!?])\s+", action) if part.strip()]
        if len(action) < _ACTION_MIN_CHARS or len(sentences) < 2:
            problems.append(
                f"{label}: в `действие` одна фраза — нужны начало (кто где и что "
                "собирается), ход и итог (кто где оказался), 2–3 предложения, "
                "не меньше 120 знаков, без морали после тире"
            )
    for position, (previous, current) in enumerate(
        zip(shots, shots[1:], strict=False), 2
    ):
        label = str(current.get("id") or f"K{position}")
        if not _zone_changed(previous, current):
            continue
        if any(word in _motion_text(current) for word in _MOVE_WORDS):
            continue
        problems.append(
            f"{label}: кадр сразу в другой зоне, чем прошлый "
            f"({str(previous.get('где') or '')[:60]!r} → {str(current.get('где') or '')[:60]!r}) — "
            "нужен кадр перехода с глаголом перемещения (встаёт, шагает, подходит) "
            "или та же зона, что в прошлом кадре"
        )
    problems.extend(_people_named_problems(shots))
    return problems


#: Код персонажа без имени: «Персонаж c01», «персонаж c09», «человек c03».
_ANON_PERSON_RE = re.compile(r"(?i)персонаж\w*\s+\(?c\d{2}\)?")
#: Одна пара «имя (код)» в поле «кто».
_NAMED_PERSON_RE = re.compile(r"\S.*?\(c\d{2}\)")
#: Разделитель людей в «кто»: запятая, плюс, косая черта или союз «и».
_PEOPLE_SPLIT_RE = re.compile(r"\s*(?:[,;+/]|\sи\s)\s*")


def _people_named_problems(shots: Sequence[dict[str, Any]]) -> list[str]:
    """Кадры не называют людей кодом вместо имени.

    Реестр персонажей теперь уходит в промт отдельным блоком ``{{РЕЕСТР}}``:
    без этой проверки модель при нехватке имени писала «Персонаж c01», и
    генератор картинок не знал, кого рисовать (владелец, 2026-11-20).
    """
    problems: list[str] = []
    for position, shot in enumerate(shots, 1):
        label = str(shot.get("id") or f"K{position}")
        who = str(shot.get("кто") or "").strip()
        fields = {
            "кто": who,
            "действие": str(shot.get("действие") or ""),
            "промт_картинки": str(shot.get("промт_картинки") or ""),
        }
        for name, value in fields.items():
            match = _ANON_PERSON_RE.search(value)
            if match:
                problems.append(
                    f"{label}: в `{name}` персонаж назван без имени — {match.group(0)!r}. "
                    "Возьми имя, внешность и одежду из реестра персонажей и пиши "
                    "«Имя (c0N)»; код без имени — брак"
                )
                break
        if not who:
            continue
        # В кадре бывает несколько людей: промт разрешает список «Иван (c01),
        # Пётр (c02)», и генератору картинок он нужен целиком. Проверяем каждую
        # пару, а не строку целиком (иначе валидный список считался браком).
        people = [part for part in _PEOPLE_SPLIT_RE.split(who) if part.strip()]
        bad = [part for part in people if not _NAMED_PERSON_RE.fullmatch(part.strip())]
        if bad:
            problems.append(
                f"{label}: в `кто` нет пары «имя (код)» — {bad[0][:60]!r}. Пиши людей "
                "именами из реестра с кодом: «Иван (c01), Пётр (c02)». Группы без "
                "кода реестра (семья, преследователи, мечники) в `кто` не пиши"
            )
    return problems



def _normalize_kadry(
    kadry: list[Any],
    speech: dict[str, Any],
    scene: dict[str, Any],
    background: dict[str, Any] | None = None,
) -> list[Any]:
    """Довести кадры сцены до контракта валидатора кадров (``shot_rules_v2``).

    Пары ``старт/конец`` в этой цепочке нет: её делает отдельная нода, поэтому
    поля пары здесь вычищаются и в ответ не попадают. Валидатор требует
    ``промт_картинки`` у каждого кадра — если модель его не дала, промт
    собирается из полей самого кадра (``_shot_prompt_from_fields``).
    Ещё проставляются ``номер`` и ``фон_код`` из сцены.
    """
    out: list[Any] = []
    for index, shot in enumerate(kadry, 1):
        if not isinstance(shot, dict):
            out.append(shot)
            continue
        row = dict(shot)
        picture = str(row.get("промт_картинки") or "").strip()
        if not picture:
            picture = _shot_prompt_from_fields(row, scene, background)
        row["промт_картинки"] = _clamp(picture, 4700)
        # Пара старт/конец — забота отдельной ноды: чужие поля не тащим.
        for legacy in ("старт", "конец", "точность", "причина", "промт_старт", "промт_конец"):
            row.pop(legacy, None)
        row.setdefault("номер", index)
        row.setdefault("ракурс", "фронт")
        # Сквозные данные сцены: номер сцены и место одни на все кадры.
        row.setdefault("сцена", int(scene.get("номер") or 0))
        row.setdefault("место", str(scene.get("место") or ""))
        # Код фона — из сцены, а не из ответа модели: у одиночного места кода
        # нет (пустая строка), у повторяющегося его проставит нода «Фоны».
        row["фон_код"] = str(scene.get("фон") or "").strip()
        out.append(row)
    cards = [item for item in out if isinstance(item, dict)]
    _normalize_reply_cameras(cards, speech)
    return out


class _ShotAttempt(NamedTuple):
    """Один ответ модели по сцене: нормализованная лестница и её замечания."""

    kadry: list[Any]
    problems: list[str]


async def _plan_scene_shots(
    project: Any,
    node_key: str,
    scene: dict[str, Any],
    speech: dict[str, Any],
    background: dict[str, Any] | None,
    *,
    scene_vo: str | None = None,
    previous: _ShotAttempt | None = None,
    registry: Sequence[Mapping[str, Any]] | None = None,
) -> _ShotAttempt:
    """Спросить у модели кадры одной сцены и сразу прогнать код-валидатор.

    ``scene_vo`` — кусок закадрового текста этой сцены (режим VO): с ним
    берётся промт ``scenes_to_frames_plan_vo`` и модель обязана разложить весь
    кусок по кадрам. Без ``scene_vo`` — прежний промт без закадра.

    ``previous`` — прошлая попытка: её замечания уходят модели отдельным
    блоком «Исправь». Так исправляются и техсбой, и неверная раскладка закадра.

    ``registry`` — реестр персонажей ``c01…``: без него модель знает из сцены
    только коды и пишет в кадры «Персонаж c01» без имени, возраста и одежды.
    """
    if scene_vo is None:
        master = _read_master(project, node_key, _BY_KIND["shots"])
        prompt = _render(
            master,
            UUID_СЦЕНЫ=scene["id"],
            СЦЕНА=_json(scene),
            РЕЧЬ=_json(speech),
            ФОН=_json(background),
        )
    else:
        master = _read_vo_prompt(project, VO_SHOTS_PROMPT, node_key)
        prompt = _render_vo(
            master,
            UUID_СЦЕНЫ=scene["id"],
            СЦЕНА=_json(scene),
            РЕЧЬ=_json(speech),
            ФОН=_json(background),
            ЗАКАДР_СЦЕНЫ=scene_vo,
            РЕЕСТР=_json(list(registry or [])),
        )
    if previous is not None and previous.problems:
        prompt += (
            "\n\n## Исправь\n\nПрошлый ответ не прошёл код-валидатор. "
            "Пересобери кадры сцены целиком и устрани ровно это:\n"
            + "\n".join(f"- {item}" for item in previous.problems[:10])
        )
    # ``accompanying`` уходит модели отдельной инструкцией рядом с контрактом и
    # на практике перебивает хвост мастер-промта, поэтому лимит кадров дублируем
    # здесь: без этого модель режет на кадры каждое микросостояние (сцена 10 —
    # 27 кадров при лимите 6 в промте). Проверено: с этим текстом та же сцена
    # даёт 4 кадра, сцена 19 — 6.
    accompany = (
        "Шоты этой сцены целиком. Жёсткий лимит: от 2 до 6 кадров на сцену, семь и "
        "больше — брак. Одно состояние (стоит, слушает, смотрит, ждёт) — один кадр. "
        "Отдельных кадров-реакций нет. Если кадров выходит больше шести — объединяй "
        "соседние, реплики и события не выбрасывай."
        if scene_vo is None
        else "Шоты этой сцены целиком."
    )
    payload = await _ask_json(project, node_key, prompt, accompany)
    ops = payload.get("ops")
    if not isinstance(ops, list) or not ops:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']} — "
            "ответ без ops"
        )
    kadry: list[Any] = []
    for op in ops:
        if not isinstance(op, dict):
            continue
        fields = op.get("fields")
        if not isinstance(fields, dict):
            continue
        raw_kadry = fields.get("кадры")
        if isinstance(raw_kadry, list):
            kadry.extend(_normalize_kadry(raw_kadry, speech, scene, background))
    # Контракт владельца 2026-11-19: кадры правятся промтом, но два жёстких
    # нарушения (скачок зоны без кадра перехода и «действие» из одной фразы)
    # возвращаются модели блоком «## Исправь».
    return _ShotAttempt(kadry=kadry, problems=_shot_contract_problems(kadry))


# ── Режим VO: закадровый текст, подведённый к «Шотам» ───────────────────────


def _vo():
    """Модуль VO-механики: деление закадра, проверки раскладки, длительности."""
    from app.services.plan_cinema import vo_shots

    return vo_shots


#: Промты режима VO — файлы в папке группы ``plan_cinema``.
VO_PARTITION_PROMPT = "plan_vo_partition"
VO_SHOTS_PROMPT = "scenes_to_frames_plan_vo"
#: Попыток деления закадра по сценам: ответ модели проверяет код (один повтор).
VO_PARTITION_ATTEMPTS = 2
#: Попыток разложить кусок сцены по кадрам, прежде чем разложить его кодом.
VO_SHOT_ATTEMPTS = 2
#: Приписка к промту QC в режиме VO: закадр — не лишнее поле и не нарушение.
VO_QC_NOTE = (
    "\n\n## Закадровый текст (режим VO)\n\n"
    "В этой сцене есть закадровый текст: поле `закадр` у каждого кадра — дословный "
    "кусок полной озвучки, склейка кусков сцены = кусок сцены. Это не заглушка и не "
    "лишнее поле: не предлагай убрать `закадр` и не считай его нарушением. Проверяй, "
    "что картинка кадра соответствует смыслу его куска.\n"
)


#: Подписи-отсылки для ПОВТОРНЫХ вхождений плейсхолдеров в промтах режима VO:
#: большие данные подставляются один раз, дальше — короткая ссылка «см. выше».
#: Без этого один закадр на 14 000 знаков размножается на десятки тысяч
#: символов (плейсхолдер упомянут в правилах и чек-листах), и шлюз отбивает
#: запрос как «промт содержит недопустимое содержимое» (код 400).
VO_PLACEHOLDER_ALIASES: dict[str, str] = {
    "СЦЕНЫ": "‹список сцен выше›",
    "ЗАКАДР": "‹полный закадр выше›",
    "ЗАКАДР_СЦЕНЫ": "‹кусок закадра сцены выше›",
    "СЦЕНА": "‹сцена выше›",
    "РЕЧЬ": "‹речь сцены выше›",
    "ФОН": "‹фон сцены выше›",
    "UUID_СЦЕНЫ": "‹UUID сцены выше›",
    "РЕЕСТР": "‹реестр персонажей выше›",
}


def _render_vo(master: str, **values: str) -> str:
    """Подстановка данных в промт режима VO: значение — один раз, дальше отсылка.

    Обычный ``_render`` заменяет все вхождения; для маленьких полей это
    нормально, но закадр и список сцен в промте VO повторяются в правилах и
    чек-листах, и все-вхождения-подстановка раздувает запрос в десятки раз.
    """
    text = str(master or "")
    for name, value in values.items():
        token = "{{" + name + "}}"
        if token not in text:
            continue
        text = text.replace(token, str(value), 1)
        text = text.replace(token, VO_PLACEHOLDER_ALIASES.get(name, f"‹{name} выше›"))
    return text


def _read_vo_prompt(project: Any, name: str, node_key: str) -> str:
    """Промт режима VO из папки группы; отсутствие файла — внятная ошибка."""
    try:
        text = _read_group_prompt(project, name)
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: к «Шотам» подведён закадровый "
            f"текст, но в папке группы {GROUP_ID} нет промта {name!r}"
        ) from exc
    text = str(text or "").strip()
    if not text:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: пустой промт {name!r} режима VO"
        )
    return text


def _vo_scene_rows(scene_dicts: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Вход деления закадра: номер, место, событие и короткое описание сцены.

    Описание нужно модели, чтобы понять, о чём сцена, и привязать к ней кусок
    текста. Режем его: длинные описания вместе с полным закадром раздувают
    запрос до размера, на котором шлюз отбивает промт («недопустимое
    содержимое»); проверено на проекте 2 (пустой вход давал кривые границы —
    кусок на 7 знаков посреди ролика).
    """
    rows: list[dict[str, Any]] = []
    for scene in scene_dicts:
        event = " ".join(str(scene.get("событие") or "").split())
        action = " ".join(str(scene.get("сцена") or "").split())
        characters = [
            str(code)[:12]
            for code in (scene.get("персонажи") or [])[:3]
            if str(code).strip()
        ]
        rows.append(
            {
                "номер": int(scene["номер"]),
                "место": str(scene.get("место") or "").strip(),
                "событие": event[:200],
                "сцена": action[:300],
                "персонажи": characters,
            }
        )
    return rows


def _vo_partition_block() -> str:
    """Заголовок «Исправь» для второй попытки деления закадра."""
    return (
        "\n\n## Исправь\n\nПрошлое деление не прошло код-проверку закадра. "
        "Пересобери ответ целиком и устрани ровно это:\n"
    )


async def _vo_partition(
    project: Any,
    node_key: str,
    scene_dicts: Sequence[dict[str, Any]],
    vo_text: str,
) -> list[dict[str, Any]]:
    """Полный закадр → кусок на каждую сцену; проверка кодом, один повтор.

    Деление семантическое (какой кусок к какой сцене), поэтому его делает
    модель. Код проверяет арифметику: сцены 1:1, порядок, каждый кусок
    непустой, склейка = весь закадр слово в слово. Не сошлось — второй
    запрос с конкретными замечаниями, потом отказ с проблемами.
    """
    vo = _vo()
    numbers = [int(scene["номер"]) for scene in scene_dicts]
    master = _read_vo_prompt(project, VO_PARTITION_PROMPT, node_key)
    problems: list[str] = []
    for attempt in range(1, VO_PARTITION_ATTEMPTS + 1):
        prompt = _render_vo(
            master,
            СЦЕНЫ=_json(_vo_scene_rows(scene_dicts)),
            ЗАКАДР=vo_text,
        )
        if attempt > 1:
            prompt += _vo_partition_block() + "\n".join(
                f"- {item}" for item in problems[:10]
            )
        try:
            payload = await _ask_json(
                project, node_key, prompt, "Куски закадра по сценам целиком."
            )
        except RuntimeError as exc:
            problems = [str(exc)]
            logger.warning(
                "[#%s] %s: деление закадра, попытка %s — %s",
                getattr(project, "id", "?"),
                node_key,
                attempt,
                exc,
            )
            continue
        chunks = payload.get("сцены")
        problems = vo.scene_chunk_problems(
            numbers, chunks if isinstance(chunks, list) else [], vo_text
        )
        if not problems:
            rows = (
                [row for row in chunks if isinstance(row, dict)]
                if isinstance(chunks, list)
                else []
            )
            return [
                {
                    "номер": int(row.get("номер") or 0),
                    "закадр": str(row.get("закадр") or "").strip(),
                }
                for row in rows
            ]
        logger.warning(
            "[#%s] %s: деление закадра, попытка %s, код-проверка — %s",
            getattr(project, "id", "?"),
            node_key,
            attempt,
            json.dumps(problems[:6], ensure_ascii=False),
        )
    raise RuntimeError(
        f"#{getattr(project, 'id', '?')} {node_key}: закадровый текст не разложился по "
        f"сценам после {VO_PARTITION_ATTEMPTS} попыток — "
        f"{json.dumps(problems[:8], ensure_ascii=False)}"
    )


def _kadry_in_order(kadry: Sequence[Any]) -> list[Any]:
    """Кадры сцены по полю ``порядок`` (если оно есть), иначе как пришли.

    Раскладка закадра и длительности идут по порядку списка, поэтому список
    выравнивается по «порядок» ещё до раскладки: иначе кадр с порядком 3 мог
    бы получить текст второго.
    """
    rows = list(kadry or [])
    keyed: list[tuple[int, int, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            keyed.append((len(rows), index, row))
            continue
        raw = row.get("порядок")
        if raw is None:
            raw = row.get("номер")
        try:
            order = int(str(raw).strip())
        except (TypeError, ValueError):
            order = len(rows)
        keyed.append((order, index, row))
    keyed.sort(key=lambda item: (item[0], item[1]))
    return [row for _, _, row in keyed]


async def _run_shots_vo(
    session: Any,
    project: Any,
    *,
    node_key: str,
    source: Any,
) -> NodeResult:
    """Шаг 5 в режиме VO: закадр разложен по кадрам, темп 13.5 знака в секунду.

    Порядок: полный закадр → куски по сценам (модель + код-гейт) → кадры
    каждой сцены (модель раскладывает свой кусок + код-гейт, при провале
    кусок раскладывается кодом) → запись ``кадры``, ``voiceover_text`` сцены и
    ``duration_seconds`` → сквозная проверка «весь текст покрыт, темп 13.5».
    """
    apply = _apply()
    vo = _vo()
    from app.services.gpt_api import GptApiError

    text = str(getattr(source, "text", "") or "").strip()
    if not vo.normalize_words(text):
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: к «Шотам» подведён закадровый "
            f"текст ({getattr(source, 'node_key', '?')}), но текст пуст — сначала нода "
            "«Закадровый текст»"
        )
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    backgrounds = await apply.load_backgrounds(session, project)
    # Реестр персонажей обязателен: в сцене лежат только коды ``c01…``, и без
    # реестра модель писала в кадры «Персонаж c01» — имени, возраста и одежды
    # взять ей было неоткуда, генератор картинок никого не узнавал.
    characters = await apply.load_characters(session, project)
    registry = _registry_list(characters)
    scene_dicts = [_scene_dict(frame) for frame in scenes]
    # «Фоны» стоят ПОСЛЕ «Шотов»: фон собирается из кадров, поэтому на первом
    # прогоне карточки ещё нет. Это не ошибка — кадры строятся от места сцены.
    chunks = await _vo_partition(project, node_key, scene_dicts, text)
    chunk_by_number = {int(row["номер"]): row["закадр"] for row in chunks}
    # Склейка проверяется ДО вызовов модели на кадры: деление уже прошло
    # код-гейт, это страховка, и падать на ней после 32 платных сцен незачем.
    glued = " ".join(str(row.get("закадр") or "").strip() for row in chunks)
    if not vo.same_words(text, glued):
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: режим VO — куски сцен не "
            "склеиваются в полный закадровый текст (потеря или дубль слов)"
        )

    all_ops: list[dict[str, Any]] = []
    no_kadry: list[str] = []
    code_split: list[int] = []
    frames_by_number = {
        int(_scene_dict(frame)["номер"]): frame for frame in scenes
    }
    jobs: list[dict[str, Any]] = []
    for scene in scene_dicts:
        frame = frames_by_number[int(scene["номер"])]
        jobs.append(
            {
                "scene": scene,
                "frame": frame,
                "speech": _speech_of(frame),
                "background": backgrounds.get(scene["фон"])
                or _background_placeholder(scene),
                "scene_vo": chunk_by_number.get(int(scene["номер"]), ""),
            }
        )

    async def _ask_scene(job: dict[str, Any]) -> dict[str, Any]:
        """Кадры сцены: модель раскладывает кусок, код проверяет и страхует."""
        scene = job["scene"]
        scene_vo = job["scene_vo"]
        last_kadry: list[Any] = []
        problems: list[str] = []
        for attempt_no in range(1, VO_SHOT_ATTEMPTS + 1):
            previous = (
                _ShotAttempt(kadry=last_kadry, problems=problems) if problems else None
            )
            try:
                attempt = await _plan_scene_shots(
                    project,
                    node_key,
                    scene,
                    job["speech"],
                    job["background"],
                    scene_vo=scene_vo,
                    previous=previous,
                    registry=registry,
                )
            except RuntimeError as exc:
                problems = [str(exc)]
                logger.warning(
                    "[#%s] %s: сцена %s, попытка %s — %s",
                    getattr(project, "id", "?"),
                    node_key,
                    scene["номер"],
                    attempt_no,
                    exc,
                )
                continue
            except GptApiError as exc:
                logger.warning(
                    "[#%s] %s: сцена %s — шлюз отказал (%s), сцену пропускаю",
                    getattr(project, "id", "?"),
                    node_key,
                    scene["номер"],
                    exc,
                )
                return {**job, "kadry": [], "skip_reason": str(exc)}
            last_kadry = _kadry_in_order(attempt.kadry)
            problems = list(attempt.problems) + vo.shots_partition_problems(
                scene_vo, last_kadry
            )
            if not problems:
                return {**job, "kadry": last_kadry, "code_split": False}
            logger.warning(
                "[#%s] %s: сцена %s, попытка %s, раскладка закадра — %s",
                getattr(project, "id", "?"),
                node_key,
                scene["номер"],
                attempt_no,
                json.dumps(problems[:4], ensure_ascii=False),
            )
        if not last_kadry:
            return {
                **job,
                "kadry": [],
                "skip_reason": "; ".join(problems[:3]) or "нет кадров",
            }
        # Модель не разложила текст слово в слово — раскладываем кодом.
        # Это не выдумывание кадров: визуальную лестницу дала модель, код
        # только гарантирует, что весь кусок закадра дошёл до кадров.
        code_split.append(int(scene["номер"]))
        return {
            **job,
            "kadry": vo.distribute_scene_vo(scene_vo, last_kadry),
            "code_split": True,
        }

    async def _commit(answer: dict[str, Any]) -> None:
        scene = answer["scene"]
        kadry = [row for row in (answer.get("kadry") or []) if isinstance(row, dict)]
        if not kadry:
            no_kadry.append(
                f"сцена {scene['номер']}: {answer.get('skip_reason') or 'нет кадров'}"
            )
            return
        kadry = vo.with_durations(kadry)
        kadry = [{**row, "номер": index} for index, row in enumerate(kadry, 1)]
        scene_vo = str(answer.get("scene_vo") or "")
        seconds = round(
            sum(float(row.get("длительность") or 0) for row in kadry), 2
        )
        await apply.write_scene_attrs(
            session, project, scene["id"], {"кадры": kadry}
        )
        frame = answer["frame"]
        frame.voiceover_text = scene_vo
        frame.duration_seconds = seconds
        await session.flush()
        all_ops.append({"frame_uuid": scene["id"], "fields": {"кадры": kadry}})
        # Коммит на сцену: готовые сцены не теряются, write-lock SQLite не
        # держится через все вызовы модели (тот же BUG-006, что в dialogues).
        await session.commit()

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: режим VO, сцен %s, закадр %s зн, пачка %s, пауза %.1f с",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        len(text),
        size,
        stagger,
    )
    if jobs:
        await _run_in_batches(
            jobs,
            _ask_scene,
            _commit,
            size=size,
            stagger=stagger,
            project_id=getattr(project, "id", "?"),
            node_key=node_key,
            label=lambda job: job["scene"]["номер"],
        )
    if no_kadry:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: режим VO — без кадров остались "
            f"сцены: {json.dumps(no_kadry[:8], ensure_ascii=False)}. Закадр обязан быть "
            "разложен по всем сценам"
        )
    summary = vo.vo_rate_summary(text, chunks)
    written = round(
        sum(
            float(row.get("длительность") or 0)
            for op in all_ops
            for row in op["fields"]["кадры"]
        ),
        2,
    )
    # Сверяем не с длиной всего закадра, а с текстом, который физически лёг в
    # кадры: пробелы на стыках сцен (31 штука на 32 сцены) — паузы, их нет ни
    # в одном кадре, иначе гейт рушился бы на любом длинном проекте.
    shot_chars = sum(
        len(str(row.get("закадр") or "").strip()) for row in chunks
    )
    expected = round(shot_chars / vo.VO_CHARS_PER_SEC, 2)
    delta = round(written - expected, 2)
    tolerance = max(0.5, 0.02 * max(1, len(chunks)))
    if abs(delta) > tolerance:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: режим VO — длительность "
            f"{written} с не сходится с темпом 13.5 знака/сек ({expected} с, "
            f"расхождение {delta:+.2f} с при допуске {tolerance:.2f}). "
            "Раскладка потеряла или добавила текст"
        )
    pauses = round((len(chunks) - 1) / vo.VO_CHARS_PER_SEC, 2) if len(chunks) > 1 else 0.0
    path = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_SHOTS,
        {
            "ops": all_ops,
            "закадр_план": chunks,
            "закадр_источник": str(getattr(source, "node_key", "") or ""),
            "темп_зн_в_сек": vo.VO_CHARS_PER_SEC,
            "секунд": written,
            "секунд_в_кадрах": expected,
            "паузы_между_сценами_сек": pauses,
        },
    )
    kadrov = sum(len(op["fields"]["кадры"]) for op in all_ops)
    reply = (
        f"шоты (VO): сцен {len(all_ops)}, кадров {kadrov}, закадр {summary['chars']} зн = "
        f"{written} с при {vo.VO_CHARS_PER_SEC} зн/с, покрытие VO pass"
    )
    if pauses:
        reply += f" (+{pauses:.2f} с пауз на стыках сцен не входят в кадры)"
    if code_split:
        reply += f"; раскладку пересобрал код: сцен {len(sorted(set(code_split)))}"
    logger.info("[#%s] %s: %s", getattr(project, "id", "?"), node_key, reply)
    return NodeResult(reply_text=reply, output_paths=[path])


async def _run_shots(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 5: по сцене → ``attrs["кадры"]`` через apply-ops ``frame_uuid``.

    Если к ноде «Шоты» подведён закадровый текст (ребро от ноды «Закадровый
    текст» на канвасе), включается режим VO: весь текст обязан быть разложен
    по кадрам с темпом 13.5 знака в секунду, сцены соотносятся с кусками
    текста. Без ребра поведение прежнее — кадры без закадра.
    """
    source = _vo().shots_node_vo_source(project, node_key)
    if source is not None:
        return await _run_shots_vo(session, project, node_key=node_key, source=source)
    apply = _apply()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    backgrounds = await apply.load_backgrounds(session, project)
    all_ops: list[dict[str, Any]] = []
    problems_total: list[str] = []
    skipped_total: list[str] = []
    # Отладка одного прогона: PLAN_CINEMA_SCENES="1,2" — считать только эти сцены.
    only = {
        int(part)
        for part in str(os.environ.get("PLAN_CINEMA_SCENES") or "").replace(" ", "").split(",")
        if part.isdigit()
    }
    if only:
        # Частичный прогон — отладочный: его лестницу не записываем, иначе
        # остальные сцены остались бы без кадров.
        logger.warning("[#%s] %s: частичный прогон, сцены %s", getattr(project, "id", "?"), node_key, sorted(only))
    jobs: list[dict[str, Any]] = []
    for frame in scenes:
        scene = _scene_dict(frame)
        if only and int(scene["номер"]) not in only:
            continue
        speech = _speech_of(frame)
        # «Фоны» идут ПОСЛЕ «Шотов» (фон собирается из кадров), поэтому на
        # первом прогоне карточки ещё нет. Это не ошибка: кадры строятся от
        # места сцены, код фона проставит нода «Фоны».
        background = backgrounds.get(scene["фон"]) or _background_placeholder(scene)
        jobs.append({"scene": scene, "speech": speech, "background": background})

    async def _ask_scene(job: dict[str, Any]) -> dict[str, Any]:
        """Спросить кадры сцены — один ответ, без правок по замечаниям.

        Повтор только на технический сбой (модель вернула битый JSON): такой
        ответ разобрать нельзя. Если и со второго раза не разобралось — сцену
        пропускаем (её прошлые кадры остаются), а не роняем весь шаг.
        """
        scene, speech, background = job["scene"], job["speech"], job["background"]
        from app.services.gpt_api import GptApiError

        last_error = ""
        for attempt_no in range(1, _SHOTS_ATTEMPTS + 1):
            try:
                attempt = await _plan_scene_shots(
                    project, node_key, scene, speech, background
                )
            except RuntimeError as exc:
                last_error = str(exc)
                logger.warning(
                    "[#%s] %s: сцена %s, попытка %s — %s",
                    getattr(project, "id", "?"),
                    node_key,
                    scene["номер"],
                    attempt_no,
                    last_error,
                )
                continue
            except GptApiError as exc:
                # Отказ шлюза (модерация промта, лимит, баланс) — это не битый
                # JSON: повторять ту же сцену бессмысленно, и ронять весь шаг
                # из-за одной сцены тоже. Пропускаем — прошлые кадры остаются.
                last_error = str(exc)
                logger.warning(
                    "[#%s] %s: сцена %s — шлюз отказал (%s), сцену пропускаю",
                    getattr(project, "id", "?"),
                    node_key,
                    scene["номер"],
                    last_error,
                )
                break
            return {**job, "attempt": attempt}
        return {**job, "attempt": None, "skip_reason": last_error}

    async def _commit(answer: dict[str, Any]) -> None:
        scene = answer["scene"]
        attempt = answer.get("attempt")
        if attempt is None:
            skipped_total.append(f"сцена {scene['номер']}: {answer.get('skip_reason')}")
            return
        scene_kadry, problems = attempt.kadry, list(attempt.problems)
        if problems:
            problems_total.extend(problems)
            return
        # Лестницу кадров сцены пишем точной заменой: обычный apply-ops склеивает
        # новую лестницу со старой и оставляет «хвост» от прошлого прогона
        # (например кадр без промта картинки), а гейт потом падает на нём.
        scene_kadry = [
            {**row, "номер": index} if isinstance(row, dict) else row
            for index, row in enumerate(scene_kadry, 1)
        ]
        if not only:
            await apply.write_scene_attrs(
                session, project, scene["id"], {"кадры": scene_kadry}
            )
        all_ops.append({"frame_uuid": scene["id"], "fields": {"кадры": scene_kadry}})
        # Коммит на сцену: не держим write-lock SQLite через весь прогон (иначе
        # учёт LLM ждёт блокировку на каждом вызове) и не теряем готовые сцены
        # при падении на следующей.
        await session.commit()

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: сцен %s, пачка %s, пауза %.1f с",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        size,
        stagger,
    )
    if jobs:
        await _run_in_batches(
            jobs,
            _ask_scene,
            _commit,
            size=size,
            stagger=stagger,
            project_id=getattr(project, "id", "?"),
            node_key=node_key,
            label=lambda job: job["scene"]["номер"],
        )
    if problems_total:
        debug_path = Path(project.data_dir) / "excel_gpt_uploads" / node_key / "shots_fail.json"
        try:
            debug_path.parent.mkdir(parents=True, exist_ok=True)
            debug_path.write_text(
                json.dumps(
                    {"проблемы": problems_total, "ops": all_ops},
                    ensure_ascii=False,
                    indent=1,
                ),
                encoding="utf-8",
            )
        except OSError:
            logger.exception("[#%s] %s: не удалось сохранить shots_fail.json",
                             getattr(project, "id", "?"), node_key)
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: кадры не прошли код-валидатор — "
            f"{json.dumps(problems_total[:8], ensure_ascii=False)}"
        )
    if not all_ops:
        raise RuntimeError(f"#{getattr(project, 'id', '?')} {node_key}: нет ни одного кадра")
    # Отладочный shots_fail.json от прерванных прогонов больше не нужен: его
    # таблица в «Результатах» дублировала кадры успешного прогона.
    stale_fail = Path(project.data_dir) / "excel_gpt_uploads" / node_key / "shots_fail.json"
    try:
        stale_fail.unlink(missing_ok=True)
    except OSError:
        logger.debug("[#%s] %s: shots_fail.json не удалился", getattr(project, "id", "?"), node_key)
    path = apply.save_artifact(project, node_key, ARTIFACT_SHOTS, {"ops": all_ops})
    kadrov = sum(len(op["fields"]["кадры"]) for op in all_ops)
    reply = f"шоты: сцен {len(all_ops)}, кадров {kadrov}"
    if skipped_total:
        logger.warning(
            "[#%s] %s: сцены без кадров — %s",
            getattr(project, "id", "?"),
            node_key,
            "; ".join(skipped_total[:8]),
        )
        reply += f"; сцен без ответа модели {len(skipped_total)}"
    return NodeResult(reply_text=reply, output_paths=[path])


def _backgrounds_input(
    scenes: Sequence[Mapping[str, Any]],
    kadry_by_scene: Mapping[str, Sequence[Mapping[str, Any]]],
    plan_by_code: Mapping[str, str],
) -> dict[str, Any]:
    """Вход ноды «Фоны»: кадры всех сцен, сгруппированные по сценам.

    Модель получает раскадровку (что и где снято), а не места сцен: правил
    объединения в промте, группирует она. Код считает ключи локаций и число
    кадров — по ним проверяются порог повторяемости и связь «сцена → фон».
    """
    rows: list[dict[str, Any]] = []
    keys: dict[int, str] = {}
    frames: dict[int, int] = {}
    total = 0
    for scene in scenes:
        number = int(scene.get("номер") or 0)
        kadry = [
            row
            for row in (kadry_by_scene.get(str(scene.get("id") or "")) or [])
            if isinstance(row, Mapping)
        ]
        keys[number] = _scene_location_key(scene, plan_by_code)
        frames[number] = len(kadry)
        total += len(kadry)
        rows.append(
            {
                "сцена": number,
                "место": _flat_text(scene.get("место")),
                "кадров": len(kadry),
                # Первые четыре ракурса кадров сцены: из них код соберёт лист
                # фона 2×2 (квадрант 1 → кадр 1 … квадрант 4 → кадр 4). Сама
                # модель ракурсы не выбирает и в промт не пишет.
                "ракурсы": [_flat_text(kadr.get("ракурс")) for kadr in kadry[:4]],
                "кадры": [
                    {
                        "id": _flat_text(kadr.get("id")),
                        "порядок": kadr.get("порядок"),
                        "план": _flat_text(kadr.get("план")),
                        "ракурс": _flat_text(kadr.get("ракурс")),
                        "высота": _flat_text(kadr.get("высота")),
                        # «кто и где» — одно поле новой раскадровки; старое
                        # разбиение на «кто»/«где» поддерживаем как есть.
                        "где": _flat_text(kadr.get("где") or kadr.get("кто_где")),
                        "кто_где": _flat_text(kadr.get("кто_где")),
                        "место": _flat_text(kadr.get("место")),
                        "фон": _flat_text(kadr.get("фон")),
                        "действие": _flat_text(kadr.get("действие")),
                        "кто": _flat_text(kadr.get("кто")),
                    }
                    for kadr in kadry
                ],
            }
        )
    return {"сцены": rows, "keys": keys, "frames": frames, "frames_total": total}


def _assign_backgrounds(
    cards: Any,
    *,
    scene_keys: Mapping[int, str],
    scene_frames: Mapping[int, int],
) -> dict[str, Any]:
    """Разобрать ответ модели: карточки фонов и код фона каждой сцены.

    Правила ``plan_backgrounds.md``: карточка — только на повторяющуюся
    локацию; кадры одной сцены с одной локацией — один фон; продолжение и
    возврат к прежнему месту берут прежний код (второй ``Entity`` не нужен).

    Возвращает ``{"cards", "code_by_scene", "dropped", "warnings", "problems",
    "frames_by_key", "expected_keys"}``.
    """
    empty: dict[str, Any] = {
        "cards": [],
        "code_by_scene": {},
        "dropped": [],
        "warnings": [],
        "problems": [],
        "frames_by_key": {},
        "expected_keys": 0,
    }
    if not isinstance(cards, list):
        empty["problems"] = ["ответ без списка «фоны»"]
        return empty
    problems: list[str] = []
    dropped: list[str] = []
    warnings: list[str] = []
    code_by_scene: dict[int, str] = {}
    kept: list[dict[str, Any]] = []
    seen_codes: set[str] = set()
    for index, raw in enumerate(cards, 1):
        if not isinstance(raw, Mapping):
            problems.append(f"фон #{index}: элемент не объект")
            continue
        code = str(raw.get("id") or "").strip().lower()
        if not _BACKGROUND_CODE_RE.match(code):
            problems.append(f"фон #{index}: id {code!r} не по формату f0N (например, f01)")
            continue
        if code in seen_codes:
            problems.append(f"фон {code}: код повторяется")
            continue
        place = " ".join(str(raw.get("место") or "").split())
        if not place:
            problems.append(f"фон {code}: пустое «место»")
            continue
        raw_numbers = raw.get("сцены")
        if not isinstance(raw_numbers, list) or not raw_numbers:
            problems.append(f"фон {code}: пустой «сцены» — перечисли сцены этого фона")
            continue
        numbers: list[int] = []
        unknown: list[Any] = []
        for value in raw_numbers:
            try:
                number = int(value)
            except (TypeError, ValueError):
                unknown.append(value)
                continue
            if number not in scene_keys:
                unknown.append(value)
            elif number not in numbers:
                numbers.append(number)
        if unknown:
            problems.append(f"фон {code}: сцен {unknown[:6]} нет во входе")
            continue
        if not numbers:
            problems.append(f"фон {code}: пустой «сцены» после разбора")
            continue
        duplicates = [number for number in numbers if number in code_by_scene]
        if duplicates:
            problems.append(f"сцены {duplicates[:6]} указаны в двух фонах")
            continue
        card_frames = sum(scene_frames.get(number, 0) for number in numbers)
        if card_frames < BACKGROUND_MIN_FRAMES:
            dropped.append(
                f"{code}: {card_frames} кадр(ов) — одиночное место, карточка не заводится"
            )
            continue
        card_keys = {scene_keys[number] for number in numbers}
        if len(card_keys) > 1:
            # Место в текстах разошлось («двор» / «тот же двор»), а модель
            # объединила кадры в один фон. Ключ — эвристика по тексту, поэтому
            # это не отказ шага, а предупреждение: семантику решила модель.
            warnings.append(
                f"фон {code}: сцены разных мест {sorted(card_keys)} — "
                "объединены моделью в один фон"
            )
        for number in numbers:
            code_by_scene[number] = code
        seen_codes.add(code)
        kept.append({**dict(raw), "id": code, "место": place, "сцены": list(numbers)})
    # Одна локация — один фон. Модель иногда заводит на одно место две карточки
    # (разбила кадры по подместам или по времени). Это не повод падать: вторую
    # склеиваем в первую и переводим её сцены на первый код — ровно то, что
    # сделал бы человек, увидев два фона одного места.
    kept_by_key: dict[str, dict[str, Any]] = {}
    merged_kept: list[dict[str, Any]] = []
    for card in kept:
        key = scene_keys.get(card["сцены"][0], "")
        target = kept_by_key.get(key) if key else None
        if target is not None:
            target["сцены"] = sorted({*target["сцены"], *card["сцены"]})
            for number in card["сцены"]:
                code_by_scene[number] = target["id"]
            warnings.append(
                f"локация {key!r}: карточки {card['id']} и {target['id']} "
                "описывают одно место — склеены в один фон"
            )
            continue
        if key:
            kept_by_key[key] = card
        merged_kept.append(card)
    kept = merged_kept
    key_code: dict[str, str] = {}
    for number in sorted(code_by_scene):
        key = scene_keys.get(number, "")
        code = code_by_scene[number]
        if key:
            key_code[key] = code
    # Продолжение/возврат: сцена без кода, но её локация уже имеет код, — берём
    # прежний фон, второй Entity не создаём.
    for number in sorted(scene_keys):
        if number in code_by_scene:
            continue
        inherited = key_code.get(scene_keys[number])
        if inherited:
            code_by_scene[number] = inherited
    frames_by_key: dict[str, int] = {}
    for number, key in scene_keys.items():
        frames_by_key[key] = frames_by_key.get(key, 0) + scene_frames.get(number, 0)
    expected_keys = {
        key: count for key, count in frames_by_key.items() if count >= BACKGROUND_MIN_FRAMES
    }
    for key in sorted(expected_keys):
        if key in key_code:
            continue
        numbers = sorted(number for number, value in scene_keys.items() if value == key)
        problems.append(
            f"локация {key!r} встречается {expected_keys[key]} раз(а) в кадрах, "
            f"но фона нет (сцены {numbers})"
        )
    return {
        "cards": kept,
        "code_by_scene": code_by_scene,
        "dropped": dropped,
        "warnings": warnings,
        "problems": problems,
        "frames_by_key": frames_by_key,
        "expected_keys": len(expected_keys),
    }


def _card_angles(
    scenes: Sequence[Mapping[str, Any]],
    kadry_by_scene: Mapping[str, Sequence[Mapping[str, Any]]],
    code_by_scene: Mapping[int, str],
) -> dict[str, list[dict[str, Any]]]:
    """Кадры-панели листа каждого фона: первые четыре кадра по порядку сцен.

    Квадрант 1 = первый кадр фона, квадрант 4 = четвёртый. Кадры 5+ в лист не
    попадают, недостающие панели заполняет общий вид (см. ``compose_sheet_prompt``).
    Отдаём не только ракурс, но и всё, из чего строится вид панели: крупность,
    высота камеры и что видно из декорации в этом кадре.
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for scene in scenes:
        number = int(scene.get("номер") or 0)
        code = str(code_by_scene.get(number) or "").strip()
        if not code:
            continue
        bucket = out.setdefault(code, [])
        if len(bucket) >= 4:
            continue
        rows = kadry_by_scene.get(str(scene.get("id") or "")) or []
        for row in rows:
            if len(bucket) >= 4:
                break
            bucket.append(
                {
                    "id": str(row.get("id") or ""),
                    "ракурс": str(row.get("ракурс") or ""),
                    "высота": str(row.get("высота") or ""),
                    "план": str(row.get("план") or ""),
                }
            )
    return out


def _card_sheet_views(
    cards: Sequence[Mapping[str, Any]],
    frames_by_code: Mapping[str, Sequence[Mapping[str, Any]]],
) -> dict[str, list[str]]:
    """Вид каждой панели листа: английский текст модели, иначе — ракурс кадра.

    Модель пишет в карточке поле ``кадры_листа``: по записи на кадр этого фона
    (``кадр`` — id из входа, ``вид`` — что видит камера локации без людей).
    Код ставит записи в жёсткий порядок панелей: квадрант 1 → первый кадр фона,
    квадрант 4 → четвёртый. Записи нет — панель получает вид по ракурсу кадра
    (``front view`` и т.п.), чтобы лист не остался пустым.
    """
    from app.services.plan_cinema.backgrounds_render import angle_en

    out: dict[str, list[str]] = {}
    for card in cards:
        if not isinstance(card, Mapping):
            continue
        code = str(card.get("id") or "").strip()
        frames = list(frames_by_code.get(code) or [])
        if not frames:
            continue
        by_shot: dict[str, str] = {}
        raw = card.get("кадры_листа")
        if isinstance(raw, list):
            for entry in raw:
                if not isinstance(entry, Mapping):
                    continue
                shot_id = str(entry.get("кадр") or "").strip()
                text = " ".join(str(entry.get("вид") or "").split())
                if shot_id and text:
                    by_shot[shot_id] = text
        views: list[str] = []
        for frame in frames[:4]:
            shot_id = str(frame.get("id") or "")
            views.append(by_shot.get(shot_id) or angle_en(frame.get("ракурс")))
        if views:
            out[code] = views
    return out


async def _run_backgrounds(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 6: кадры всех сцен → Entity(background) f0N + код фона кадру и сцене.

    Вход — ШОТЫ (``attrs["кадры"]``), а не места сцен: объединение кадров в
    локации и порог повторяемости — правила промта ``plan_backgrounds``.
    Код проверяет форму ответа, пиннит код на каждую сцену и на каждый её кадр
    (``фон_код``) и терпит одиночные места без карточки.
    """
    apply = _apply()
    gates = _gates()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    scene_dicts = [_scene_dict(frame) for frame in scenes]
    plan_by_code = dict(_plan_points(project))
    kadry_by_scene: dict[str, list[dict[str, Any]]] = {}
    for frame, scene in zip(scenes, scene_dicts, strict=False):
        kadry_by_scene[str(scene["id"])] = _frames_of(frame)
    if not any(kadry_by_scene.values()):
        # Кадры могли остаться только в артефакте «Шотов» (упал коммит).
        artifact = _shots_artifact_kadry(project, node_key)
        if artifact:
            kadry_by_scene = {
                scene_id: list(artifact.get(scene_id, []))
                for scene_id in kadry_by_scene
            }
    # Место сцены: карточка → шапка плана → место кадров → «кто и где» кадра →
    # текст сцены. Новое разбиение по плану отдельного «места» в карточке не
    # держит: место живёт в кадрах и в тексте сцены, а у кадра «где» слито с
    # «кто» в одно поле. Поэтому «пустое место» — не повод ронять шаг.
    for scene in scene_dicts:
        rows = kadry_by_scene.get(str(scene["id"])) or []
        place = " ".join(str(scene.get("место") or "").split())
        if not place:
            place = _plan_location(
                plan_by_code, [str(code) for code in scene.get("id_плана") or []]
            )
        if not place:
            place = next(
                (
                    " ".join(str(row.get("место") or "").split())
                    for row in rows
                    if " ".join(str(row.get("место") or "").split())
                ),
                "",
            )
        if not place:
            place = next(
                (
                    " ".join(str(row.get("кто_где") or row.get("где") or "").split())
                    for row in rows
                    if " ".join(str(row.get("кто_где") or row.get("где") or "").split())
                ),
                "",
            )
        if not place:
            place = " ".join(str(scene.get("сцена") or "").split())
        if not place:
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: у сцены {scene['номер']} "
                "пустое место — ни в карточке, ни в плане, ни в кадрах"
            )
        scene["место"] = place
    kadrov = sum(len(rows) for rows in kadry_by_scene.values())
    if not kadrov:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет кадров — сначала «Шоты»"
        )
    built = _backgrounds_input(scene_dicts, kadry_by_scene, plan_by_code)
    master = _read_master(project, node_key, _BY_KIND["backgrounds"])
    prompt = _render(master, КАДРЫ=_json(built["сцены"]))
    payload = await _ask_json(project, node_key, prompt, "Фоны целиком.")
    assigned = _assign_backgrounds(
        payload.get("фоны"),
        scene_keys=built["keys"],
        scene_frames=built["frames"],
    )
    if assigned["problems"]:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: фоны — "
            f"{json.dumps(assigned['problems'][:8], ensure_ascii=False)}"
        )
    for note in assigned["dropped"]:
        logger.warning("[#%s] %s: %s", getattr(project, "id", "?"), node_key, note)
    for note in assigned["warnings"]:
        logger.info("[#%s] %s: %s", getattr(project, "id", "?"), node_key, note)
    cards = assigned["cards"]
    # Лист фона 2×2: в ``промт`` карточки код дописывает блок из четырёх панелей.
    # Порядок жёсткий: квадрант 1 = первый кадр фона … квадрант 4 = четвёртый.
    # Текст панели пишет модель в ``кадры_листа`` — что перед камерой и на чём
    # акцент; код только ставит записи по местам и снимает служебное поле.
    angles_by_code = _card_angles(scene_dicts, kadry_by_scene, assigned["code_by_scene"])
    if cards:
        from app.services.plan_cinema.backgrounds_render import compose_sheet_prompt

        views_by_code = _card_sheet_views(cards, angles_by_code)
        for card in cards:
            code = str(card.get("id") or "").strip()
            base = str(card.get("промт") or "").strip()
            views = views_by_code.get(code) or []
            card.pop("кадры_листа", None)
            if not base or not views:
                continue  # кадры без ракурсов (старые данные) — промт не трогаем
            card["промт"] = compose_sheet_prompt(base, views)
            logger.info(
                "[#%s] %s: фон %s — панели 1-4 из кадров %s, у каждой свой вид",
                getattr(project, "id", "?"),
                node_key,
                code,
                [str(frame.get("id") or "") for frame in angles_by_code.get(code) or []],
            )
        await apply.write_entities(session, project, backgrounds=cards)
    ops: list[dict[str, Any]] = []
    patched_by_scene: dict[str, list[dict[str, Any]]] = {}
    for scene in scene_dicts:
        code = str(assigned["code_by_scene"].get(int(scene["номер"]), "") or "")
        scene["фон"] = code
        ops.append({"frame_uuid": scene["id"], "fields": {"фон": code}})
        rows = kadry_by_scene.get(str(scene["id"])) or []
        if rows:
            patched_by_scene[str(scene["id"])] = [
                {**dict(row), "фон_код": code} for row in rows
            ]
    await apply.apply_plan_ops(session, project, ops)
    for scene_id, patched in patched_by_scene.items():
        await apply.write_scene_attrs(session, project, scene_id, {"кадры": patched})
    problems = gates.background_ref_problems(
        scene_dicts,
        await apply.load_backgrounds(session, project),
    )
    if problems:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: R-BG-REF fail — "
            f"{json.dumps(problems[:8], ensure_ascii=False)}"
        )
    # Фон — не только текст: у заведённой локации должна быть PNG (механика
    # как у референсов персонажей). У одиночных мест карточки нет — PNG не
    # рисуется, кадр опирается на место сцены.
    from app.services.plan_cinema.backgrounds_render import prune_backgrounds, render_missing

    # Перезапуск «Фонов» пишет новый комплект локаций: коды прошлого прогона
    # (f10…f16) обязаны уходить с учёта вместе с артефактами и PNG, иначе в
    # реестре и «Результатах» висят промты и картинки старой группировки.
    pruned = await prune_backgrounds(
        session, project, [str(card.get("id") or "") for card in cards]
    )
    if pruned["archived"] or pruned["artifacts_removed"] or pruned["files_removed"]:
        logger.info(
            "[#%s] %s: старые фоны сняты с учёта — карточек %s, артефактов %s, PNG %s",
            getattr(project, "id", "?"),
            node_key,
            pruned["archived"],
            pruned["artifacts_removed"],
            pruned["files_removed"],
        )

    render_paused = bool((getattr(project, "meta", None) or {}).get("backgrounds_render_paused"))
    if render_paused:
        rendered, already = 0, 0
        logger.info(
            "[#%s] %s: рисование PNG фонов на паузе (meta.backgrounds_render_paused)",
            getattr(project, "id", "?"),
            node_key,
        )
    elif cards:
        # Только коды этого прогона: в реестре могли остаться карточки прежней
        # группировки (upsert не удаляет), и рисовать их PNG — платить за мусор.
        rendered, already = await render_missing(
            session, project, only=[str(card.get("id") or "") for card in cards]
        )
    else:
        rendered, already = 0, 0
    logger.info(
        "[#%s] %s: PNG фонов — нарисовано %s, уже было %s",
        getattr(project, "id", "?"),
        node_key,
        rendered,
        already,
    )
    without_card = sum(
        1
        for scene in scene_dicts
        if not assigned["code_by_scene"].get(int(scene["номер"]))
    )
    reply = (
        f"фоны: сцен {len(scene_dicts)}, кадров {kadrov}, фонов {len(cards)} "
        f"(повторяющихся локаций {assigned['expected_keys']}), "
        f"лист 2×2: ракурсов {sum(len(v) for v in angles_by_code.values())}, "
        f"сцен без карточки {without_card}, "
        f"PNG нарисовано {rendered}, готовых {already}"
        f"{', рисование на паузе' if render_paused else ''}, R-BG-REF pass"
    )
    return NodeResult(reply_text=reply)


async def _run_qc(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 7: семантический QC сцены; VO-правила не применяются (vo_mode=False).

    Один проход по всем сценам. Автоматический ремонт кадров и повторный
    проход отключены (2026-11-17): ремонт ухудшал результат (54 → 81
    замечание), а нода всё равно падала. Теперь QC — чистый отчёт:
    вердикты и замечания в qc_report.json, нода всегда завершается успешно.
    """
    result, verdicts, violations_total = await _qc_pass(session, project, node_key=node_key)
    failed = [row for row in verdicts if row["verdict"] == "fail"]
    path = result
    warn = [row for row in verdicts if row["verdict"] == "warn"]
    if failed:
        # Не валим ноду: замечания QC — материал для правок, а не отказ шага.
        # Вердикты и список нарушений уже в qc_report.json; в ответе — сводка.
        codes = sorted({str(v.get("code") or "?") for v in violations_total})
        logger.error(
            "[#%s] %s: QC fail в сценах %s — коды %s, замечаний %s (нода не валится)",
            getattr(project, "id", "?"),
            node_key,
            [row["номер"] for row in failed],
            codes,
            len(violations_total),
        )
    return NodeResult(
        reply_text=(
            f"QC: сцен {len(verdicts)}, pass {sum(1 for v in verdicts if v['verdict'] == 'pass')}, "
            f"warn {len(warn)}, fail {len(failed)}, замечаний {len(violations_total)}"
        ),
        output_paths=[path],
    )


async def _qc_pass(
    session: Any, project: Any, *, node_key: str
) -> tuple[Path, list[dict[str, Any]], list[dict[str, Any]]]:
    """Один проход QC по всем сценам: (файл отчёта, вердикты, нарушения)."""
    apply = _apply()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    characters = await apply.load_characters(session, project)
    backgrounds = await apply.load_backgrounds(session, project)
    master = _read_master(project, node_key, _BY_KIND["qc"])
    # Режим VO: в кадрах есть «закадр», и QC не должен считать его нарушением.
    vo_source = _vo().shots_node_vo_source(project, _BY_KIND["shots"].node_id)
    verdicts: list[dict[str, Any]] = []
    violations_total: list[dict[str, Any]] = []
    jobs: list[dict[str, Any]] = []
    for index, frame in enumerate(scenes):
        scene = _scene_dict(frame)
        speech = _speech_of(frame)
        kadry = _frames_of(frame)
        mechanical = _shot_mechanics(
            kadry, vo_mode=vo_source is not None, scene=scene
        )
        neighbour_prev = _scene_dict(scenes[index - 1]) if index > 0 else None
        neighbour_next = _scene_dict(scenes[index + 1]) if index + 1 < len(scenes) else None
        prompt = _render(
            master,
            сцена=_json(scene),
            речь=_json(speech),
            кадры=_json(kadry),
            реестр_персонажи=_json(_registry_list(characters)),
            реестр_фоны=_json([backgrounds[code] for code in sorted(backgrounds)]),
            механические_нарушения=_json(mechanical),
            соседи=_json({"предыдущая": neighbour_prev, "следующая": neighbour_next}),
        )
        if vo_source is not None:
            prompt += VO_QC_NOTE
        jobs.append({"scene": scene, "prompt": prompt})

    async def _ask_scene(job: dict[str, Any]) -> dict[str, Any]:
        payload = await _ask_json(
            project, node_key, job["prompt"], "Вердикт QC этой сцены."
        )
        return {**job, "payload": payload}

    async def _commit(answer: dict[str, Any]) -> None:
        scene, payload = answer["scene"], answer["payload"]
        qc = payload.get("qc")
        if not isinstance(qc, dict):
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']} — "
                "ответ без «qc»"
            )
        verdict = str(qc.get("verdict") or "")
        if verdict not in ("pass", "warn", "fail"):
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']} — "
                f"недопустимый verdict {verdict!r}"
            )
        violations = [row for row in qc.get("violations") or [] if isinstance(row, dict)]
        # Стык двух сцен — не ошибка кадра: правится раскадровкой соседей, а не
        # этой нодой. Такие замечания остаются в отчёте как warn с рецептом.
        codes = {str(row.get("code") or "") for row in violations}
        if verdict == "fail" and codes and codes <= _CROSS_SCENE_CODES:
            verdict = "warn"
        for row in violations:
            violations_total.append({"сцена": scene["номер"], **row})
        verdicts.append(
            {"номер": scene["номер"], "verdict": verdict,
             "violations": violations, "fixes": qc.get("fixes") or [],
             "issues": qc.get("issues") or []}
        )

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: сцен %s, пачка %s, пауза %.1f с",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        size,
        stagger,
    )
    await _run_in_batches(
        jobs,
        _ask_scene,
        _commit,
        size=size,
        stagger=stagger,
        project_id=getattr(project, "id", "?"),
        node_key=node_key,
        label=lambda job: job["scene"]["номер"],
    )
    path = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_QC,
        {"сцены": verdicts, "механические": True},
    )
    return Path(path), verdicts, violations_total


def _fix_cards_problems(kadry_in: Sequence[Any], cards: Any) -> list[str]:
    """Что не так с карточками из ответа модели правок.

    Нода правит только ``промт_картинки``; всё, что меняет раскадровку
    (число, порядок, id), — ошибка ответа, а не повод перезаписать сцену.
    Остальные поля при сборке берутся из входа, поэтому здесь их не сверяем.
    """
    if not isinstance(cards, list):
        return ["поле «кадры» — не список"]
    if len(cards) != len(kadry_in):
        return [f"кадров {len(cards)} вместо {len(kadry_in)}"]
    problems: list[str] = []
    for expected, got in zip(kadry_in, cards, strict=False):
        if not isinstance(got, dict):
            problems.append(f"кадр {expected.get('id')}: карточка не объект")
            continue
        shot_id = str(expected.get("id") or "")
        if str(got.get("id") or "") != shot_id:
            problems.append(f"кадр {shot_id}: id изменился на {got.get('id')!r}")
        # Порядок модель не обязана возвращать: в ответе его может не быть вовсе
        # (промт просит править только отдельные поля), а порядок кадра уже
        # закреплён его id. Сверяем только присланный порядок.
        got_order = str(got.get("порядок") or "").strip()
        expected_order = str(expected.get("порядок") or "").strip()
        if got_order and expected_order and got_order != expected_order:
            problems.append(f"кадр {shot_id}: порядок изменился")
        if not str(got.get("промт_картинки") or "").strip():
            problems.append(f"кадр {shot_id}: пустой промт_картинки")
    return problems


def _fix_cards_merge(kadry_in: Sequence[Any], cards: Sequence[Any]) -> list[dict[str, Any]]:
    """Карточки для apply-ops: меняется ровно одно поле — ``промт_картинки``."""
    merged: list[dict[str, Any]] = []
    for original, got in zip(kadry_in, cards, strict=False):
        card = dict(original) if isinstance(original, dict) else {}
        card["промт_картинки"] = str(got.get("промт_картинки") or "").strip()
        merged.append(card)
    return merged



#: Поля кадра, которые правит «Проверка» (позиционирование и геометрия).
_CHECK_FIELDS: tuple[str, ...] = ("кто", "где", "позы", "фон", "промт_картинки")


def _check_cards_problems(kadry_in: Sequence[Any], cards: Any) -> list[str]:
    """Что не так с карточками из ответа «Проверки».

    Нода меняет только положение/состав персонажей. Всё, что меняет
    раскадровку (число кадров, порядок, id), — ошибка ответа, а не повод
    перезаписать сцену.
    """
    if not isinstance(cards, list):
        return ["поле «кадры» — не список"]
    if len(cards) != len(kadry_in):
        return [f"кадров {len(cards)} вместо {len(kadry_in)}"]
    problems: list[str] = []
    for expected, got in zip(kadry_in, cards, strict=False):
        if not isinstance(got, dict):
            problems.append(f"кадр {expected.get('id')}: карточка не объект")
            continue
        shot_id = str(expected.get("id") or "")
        if str(got.get("id") or "") != shot_id:
            problems.append(f"кадр {shot_id}: id изменился на {got.get('id')!r}")
        # Порядок модель не обязана возвращать: в ответе его может не быть вовсе
        # (промт просит править только отдельные поля), а порядок кадра уже
        # закреплён его id. Сверяем только присланный порядок.
        got_order = str(got.get("порядок") or "").strip()
        expected_order = str(expected.get("порядок") or "").strip()
        if got_order and expected_order and got_order != expected_order:
            problems.append(f"кадр {shot_id}: порядок изменился")
    return problems


def _check_cards_merge(
    kadry_in: Sequence[Any], cards: Sequence[Any]
) -> list[dict[str, Any]]:
    """Карточки для записи: меняются только поля ``_CHECK_FIELDS``.

    Всё остальное (план, ракурс, высота, действие, промты старта/конца,
    фон_код, id, порядок) берётся из входа — модель их не переписывает.
    Пустой ``кто``/``где``/``позы`` — легальная правка (персонажа выписали),
    пустой ``промт_картинки`` — нет: промт не обнуляем.
    """
    merged: list[dict[str, Any]] = []
    for original, got in zip(kadry_in, cards, strict=False):
        card = dict(original) if isinstance(original, dict) else {}
        source = got if isinstance(got, dict) else {}
        for key in _CHECK_FIELDS:
            if key not in source:
                continue
            value = str(source.get(key) or "").strip()
            if key == "промт_картинки" and not value:
                continue
            card[key] = value
        merged.append(card)
    return merged


async def _run_check(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг: проверка и корректировка кадров — позиционирование и геометрия.

    Стоит после «Фонов»: кадры и карточка фона уже есть. Правит только состав
    персонажей кадра (``кто``), их место (``где``), положение и действие
    (``позы``), описание видимого фона (``фон``) и положение в ``промт_картинки``.
    Непрерывность проверяется по предыдущему кадру массива, экранные стороны —
    из ракурса кадра относительно точки обзора фона. Число, порядок, план и
    остальные поля кадров защищены валидацией и не уезжают.
    """
    apply = _apply()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    characters = await apply.load_characters(session, project)
    backgrounds = await apply.load_backgrounds(session, project)
    master = _read_master(project, node_key, _BY_KIND["check"])
    vo_source = _vo().shots_node_vo_source(project, _BY_KIND["shots"].node_id)
    jobs: list[dict[str, Any]] = []
    for index, frame in enumerate(scenes):
        scene = _scene_dict(frame)
        kadry = _frames_of(frame)
        if not kadry:
            continue
        mechanical = _shot_mechanics(
            kadry, vo_mode=vo_source is not None, scene=scene
        )
        neighbour_prev = _scene_dict(scenes[index - 1]) if index > 0 else None
        neighbour_next = (
            _scene_dict(scenes[index + 1]) if index + 1 < len(scenes) else None
        )
        prompt = _render(
            master,
            сцена=_json(scene),
            кадры=_json(kadry),
            реестр_персонажи=_json(_registry_list(characters)),
            реестр_фоны=_json([backgrounds[code] for code in sorted(backgrounds)]),
            механические_нарушения=_json(mechanical),
            соседи=_json({"предыдущая": neighbour_prev, "следующая": neighbour_next}),
        )
        jobs.append({"scene": scene, "frame": frame, "kadry": kadry, "prompt": prompt})
    if not jobs:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет кадров — сначала «Шоты»"
        )

    reports: list[dict[str, Any]] = []

    async def _ask_scene(job: dict[str, Any]) -> dict[str, Any]:
        """Спросить правки одной сцены, переспрашивая при битом наборе кадров.

        Модель иногда возвращает меньше кадров, чем было во входе («кадров 0
        вместо 6») — раньше это валило всю ноду и она перезапускалась с первой
        сцены, теряя уже сделанное. Теперь такая сцена переспрашивается до трёх
        раз, остальные сцены пачки продолжают работу.
        """
        prompt = str(job["prompt"])
        problems: list[str] = []
        for attempt in range(1, 4):
            try:
                payload = await _ask_json(
                    project, node_key, prompt, "Исправленные кадры этой сцены."
                )
            except Exception as exc:  # noqa: BLE001 — обрыв/битый JSON у шлюза
                problems = [f"ответ модели не разобран: {exc}"]
                logger.warning(
                    "[#%s] %s: сцена %s — ответ не разобран (попытка %s/3): %s",
                    getattr(project, "id", "?"),
                    node_key,
                    job["scene"]["номер"],
                    attempt,
                    str(exc)[:200],
                )
                if attempt == 3:
                    raise
                continue
            cards = payload.get("кадры") if isinstance(payload, dict) else None
            problems = _check_cards_problems(job["kadry"], cards)
            if not problems:
                return {**job, "payload": payload}
            logger.warning(
                "[#%s] %s: сцена %s — набор кадров не принят (попытка %s/3): %s",
                getattr(project, "id", "?"),
                node_key,
                job["scene"]["номер"],
                attempt,
                "; ".join(problems[:3]),
            )
            prompt = (
                str(job["prompt"])
                + "\n\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРИНЯТ: "
                + "; ".join(problems[:3])
                + ".\nВерни ВСЕ кадры сцены ровно в том же количестве и с теми же id,"
                " что во входе: правь только кто/где/позы/фон/промт_картинки, ничего не выбрасывай."
            )
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: сцена {job['scene']['номер']} — "
            + "; ".join(problems[:3])
        )

    async def _commit(answer: dict[str, Any]) -> None:
        scene, kadry_in = answer["scene"], answer["kadry"]
        payload = answer["payload"]
        cards = payload.get("кадры")
        problems = _check_cards_problems(kadry_in, cards)
        if problems:
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']} — "
                + "; ".join(problems[:3])
            )
        fixed = _check_cards_merge(kadry_in, cards)
        changed = sum(
            1
            for before, after in zip(kadry_in, fixed, strict=False)
            if any(
                str(before.get(key) or "").strip()
                != str(after.get(key) or "").strip()
                for key in _CHECK_FIELDS
            )
        )
        if changed:
            # Кадры сцены живут в ``Frame.attrs["кадры"]``: точечный патч
            # атрибутов сцены, а не apply-ops по ядру — ``db_apply`` не знает
            # поле «кадры» и валится «неизвестные поля ['кадры']» (поймано
            # живым прогоном 2026-11-21 01:33).
            await apply.write_scene_attrs(session, project, scene["id"], {"кадры": fixed})
            await session.commit()
        report = payload.get("report") if isinstance(payload.get("report"), dict) else {}
        verdict = str(report.get("verdict") or ("fixed" if changed else "pass"))
        if verdict not in ("pass", "fixed", "warn"):
            verdict = "fixed" if changed else "pass"
        reports.append(
            {
                "номер": scene["номер"],
                "verdict": verdict,
                "changed": changed,
                "violations": [
                    row for row in report.get("violations") or [] if isinstance(row, dict)
                ],
                "unresolved": [str(item) for item in report.get("unresolved") or []],
            }
        )

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: сцен с кадрами %s, пачка %s, пауза %.1f с",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        size,
        stagger,
    )
    await _run_in_batches(
        jobs,
        _ask_scene,
        _commit,
        size=size,
        stagger=stagger,
        project_id=getattr(project, "id", "?"),
        node_key=node_key,
        label=lambda job: job["scene"]["номер"],
    )
    fixed_total = sum(int(row["changed"]) for row in reports)
    violations_total = sum(len(row["violations"]) for row in reports)
    unresolved_total = sum(len(row["unresolved"]) for row in reports)
    path = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_CHECK,
        {"сцены": reports, "правлено": fixed_total},
    )
    return NodeResult(
        reply_text=(
            f"проверка кадров: сцен {len(reports)}, правлено кадров {fixed_total}, "
            f"нарушений {violations_total}, unresolved {unresolved_total}"
        ),
        output_paths=[Path(path)],
    )



async def _run_fix(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг: правка ``промт_картинки`` кадров сцены — последняя нода цепочки.

    Стоит после «Отчёта»: правки промтов идут в самом конце, перед генерацией
    картинок. В отличие от «QC» нода не только находит нарушения, но и
    **дописывает промты**: мизансцена и кто перед кем, инварианты единого
    исходного фона сцены, камера и взгляд, запрет повторять исходный кадр
    фона, логика последовательности, планировка и движение. Кадры правятся
    строго последовательно, 1 → N. Правит только ``промт_картинки``: число,
    порядок, план и остальные поля кадров защищены валидацией и не уезжают.
    """
    apply = _apply()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    characters = await apply.load_characters(session, project)
    backgrounds = await apply.load_backgrounds(session, project)
    master = _read_master(project, node_key, _BY_KIND["fix"])
    vo_source = _vo().shots_node_vo_source(project, _BY_KIND["shots"].node_id)
    jobs: list[dict[str, Any]] = []
    for index, frame in enumerate(scenes):
        scene = _scene_dict(frame)
        kadry = _frames_of(frame)
        if not kadry:
            continue
        mechanical = _shot_mechanics(
            kadry, vo_mode=vo_source is not None, scene=scene
        )
        neighbour_prev = _scene_dict(scenes[index - 1]) if index > 0 else None
        neighbour_next = (
            _scene_dict(scenes[index + 1]) if index + 1 < len(scenes) else None
        )
        prompt = _render(
            master,
            сцена=_json(scene),
            кадры=_json(kadry),
            реестр_персонажи=_json(_registry_list(characters)),
            реестр_фоны=_json([backgrounds[code] for code in sorted(backgrounds)]),
            механические_нарушения=_json(mechanical),
            соседи=_json({"предыдущая": neighbour_prev, "следующая": neighbour_next}),
        )
        jobs.append({"scene": scene, "frame": frame, "kadry": kadry, "prompt": prompt})
    if not jobs:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет кадров — сначала «Шоты»"
        )

    reports: list[dict[str, Any]] = []

    async def _ask_scene(job: dict[str, Any]) -> dict[str, Any]:
        """Спросить правки одной сцены, переспрашивая при битом наборе кадров.

        Модель иногда возвращает меньше кадров, чем было во входе («кадров 0
        вместо 6») — раньше это валило всю ноду и она перезапускалась с первой
        сцены, теряя уже сделанное. Теперь такая сцена переспрашивается до трёх
        раз, остальные сцены пачки продолжают работу.
        """
        prompt = str(job["prompt"])
        problems: list[str] = []
        for attempt in range(1, 4):
            try:
                payload = await _ask_json(
                    project, node_key, prompt, "Исправленные кадры этой сцены."
                )
            except Exception as exc:  # noqa: BLE001 — обрыв/битый JSON у шлюза
                problems = [f"ответ модели не разобран: {exc}"]
                logger.warning(
                    "[#%s] %s: сцена %s — ответ не разобран (попытка %s/3): %s",
                    getattr(project, "id", "?"),
                    node_key,
                    job["scene"]["номер"],
                    attempt,
                    str(exc)[:200],
                )
                if attempt == 3:
                    raise
                continue
            cards = payload.get("кадры") if isinstance(payload, dict) else None
            problems = _fix_cards_problems(job["kadry"], cards)
            if not problems:
                return {**job, "payload": payload}
            logger.warning(
                "[#%s] %s: сцена %s — набор кадров не принят (попытка %s/3): %s",
                getattr(project, "id", "?"),
                node_key,
                job["scene"]["номер"],
                attempt,
                "; ".join(problems[:3]),
            )
            prompt = (
                str(job["prompt"])
                + "\n\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРИНЯТ: "
                + "; ".join(problems[:3])
                + ".\nВерни ВСЕ кадры сцены ровно в том же количестве и с теми же id,"
                " что во входе: правь только промт_картинки, ничего не выбрасывай."
            )
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: сцена {job['scene']['номер']} — "
            + "; ".join(problems[:3])
        )

    async def _commit(answer: dict[str, Any]) -> None:
        scene, kadry_in = answer["scene"], answer["kadry"]
        payload = answer["payload"]
        cards = payload.get("кадры")
        problems = _fix_cards_problems(kadry_in, cards)
        if problems:
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']} — "
                + "; ".join(problems[:3])
            )
        fixed = _fix_cards_merge(kadry_in, cards)
        changed = sum(
            1
            for before, after in zip(kadry_in, fixed, strict=False)
            if str(before.get("промт_картинки") or "").strip()
            != str(after.get("промт_картинки") or "").strip()
        )
        if changed:
            # Кадры сцены живут в ``Frame.attrs["кадры"]``: точечный патч
            # атрибутов сцены, а не apply-ops по ядру — ``db_apply`` не знает
            # поле «кадры» и валится «неизвестные поля ['кадры']» (поймано
            # живым прогоном 2026-11-21 01:33).
            await apply.write_scene_attrs(session, project, scene["id"], {"кадры": fixed})
            await session.commit()
        report = payload.get("report") if isinstance(payload.get("report"), dict) else {}
        verdict = str(report.get("verdict") or ("fixed" if changed else "pass"))
        if verdict not in ("pass", "fixed", "warn"):
            verdict = "fixed" if changed else "pass"
        reports.append(
            {
                "номер": scene["номер"],
                "verdict": verdict,
                "changed": changed,
                "violations": [
                    row for row in report.get("violations") or [] if isinstance(row, dict)
                ],
                "unresolved": [str(item) for item in report.get("unresolved") or []],
            }
        )

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: сцен с кадрами %s, пачка %s, пауза %.1f с",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        size,
        stagger,
    )
    await _run_in_batches(
        jobs,
        _ask_scene,
        _commit,
        size=size,
        stagger=stagger,
        project_id=getattr(project, "id", "?"),
        node_key=node_key,
        label=lambda job: job["scene"]["номер"],
    )
    fixed_total = sum(int(row["changed"]) for row in reports)
    violations_total = sum(len(row["violations"]) for row in reports)
    unresolved_total = sum(len(row["unresolved"]) for row in reports)
    path = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_FIX,
        {"сцены": reports, "правлено": fixed_total},
    )
    return NodeResult(
        reply_text=(
            f"правки кадров: сцен {len(reports)}, правлено промтов {fixed_total}, "
            f"нарушений {violations_total}, unresolved {unresolved_total}"
        ),
        output_paths=[Path(path)],
    )


#: Механические коды кадров, которые в режиме VO снимаются: старый потолок
#: «не больше 6 кадров на сцену» противоречит правилу владельца «весь закадр
#: разложен по кадрам»: на 600–900 знаков сцены нужно 7–10 кадров.
VO_RELAXED_SHOT_CODES: tuple[str, ...] = ("R-SHOT-CEILING",)


def _reply_pair_shot_ids(kadry: Sequence[Any]) -> set[str]:
    """Кадры встречных реплик: пара разных говорящих подряд.

    По канону промта у такой пары один план и один ракурс, поэтому повтор сетапа
    здесь разрешён, а механическое ``R-PLAN-SAME`` — ложное замечание.
    """
    shots = [item for item in kadry if isinstance(item, dict)]
    ids: set[str] = set()
    for previous, current in zip(shots, shots[1:], strict=False):
        previous_reply = str(previous.get("реплика") or "").strip()
        current_reply = str(current.get("реплика") or "").strip()
        if not (previous_reply and current_reply):
            continue
        if str(previous.get("говорит") or "") == str(current.get("говорит") or ""):
            continue
        for shot in (previous, current):
            shot_id = str(shot.get("id") or "").strip()
            if shot_id:
                ids.add(shot_id)
    return ids


def _shot_mechanics(
    kadry: Sequence[Any],
    *,
    vo_mode: bool = False,
    scene: Mapping[str, Any] | None = None,
) -> list[str]:
    """Механические нарушения кадров; в режиме VO потолок кадров снят.

    Только валидатор ``shot_rules_v2``. Проверки непрерывности (30°, стороны,
    телепорты персонажей) удалены решением владельца 2026-11-21: кадры не
    разводятся кодом, QC ничего про угол не пишет. Ложное ``R-PLAN-SAME``
    у встречных реплик снимается: одинаковый сетап у пары диалога — канон.
    """
    problems = list(_gates().shots_gate_problems(kadry, vo_mode=False))
    if vo_mode:
        problems = [
            item
            for item in problems
            if not any(item.startswith(code) for code in VO_RELAXED_SHOT_CODES)
        ]
    reply_pair_ids = _reply_pair_shot_ids(kadry)
    if reply_pair_ids:
        problems = [
            item
            for item in problems
            if not (
                item.startswith("R-PLAN-SAME ")
                and any(f" {shot_id}:" in item for shot_id in reply_pair_ids)
            )
        ]
    return problems


def _vo_chunks_by_number(
    project: Any, shots_key: str, scenes: Sequence[Any]
) -> dict[int, str]:
    """Куски закадра по сценам для ремонтного прохода.

    Источник правды — ``Frame.voiceover_text`` сцены (его пишет сама нода
    «Шоты» в режиме VO); если он пуст (старый прогон) — берём ``закадр_план``
    из артефакта ``shots.json``.
    """
    chunks: dict[int, str] = {}
    for frame in scenes:
        number = int(_scene_dict(frame)["номер"])
        text = str(getattr(frame, "voiceover_text", "") or "").strip()
        if text:
            chunks[number] = text
    if chunks:
        return chunks
    data = _apply().read_artifact(project, shots_key, ARTIFACT_SHOTS)
    if isinstance(data, dict):
        for row in data.get("закадр_план") or []:
            if not isinstance(row, dict):
                continue
            try:
                chunks[int(row.get("номер") or 0)] = str(row.get("закадр") or "").strip()
            except (TypeError, ValueError):
                continue
    return chunks


async def _shots_repair_pass(
    session: Any,
    project: Any,
    *,
    qc_node_key: str,
    scenes: list[dict[str, Any]],
    violations: list[dict[str, Any]],
) -> list[int]:
    """Переспросить кадры сцен, где QC нашёл нарушения.

    Модель ноды шотов получает ту же сцену, фон и разбор QC с указанием кадра:
    правится лестница кадров, затем она снова идёт через код-валидатор. Возвращает
    номера сцен, которые реально переписались (их проверяет повторный QC).
    """
    apply = _apply()
    gates = _gates()
    vo = _vo()
    shots_key = _BY_KIND["shots"].node_id
    all_scenes = await apply.load_scenes(session, project)
    frames_by_number = {int(_scene_dict(frame)["номер"]): frame for frame in all_scenes}
    backgrounds = await apply.load_backgrounds(session, project)
    # Реестр персонажей — как и в основном прогоне шотов: ремонт после QC
    # не должен терять имена и внешность героев.
    registry = _registry_list(await apply.load_characters(session, project))
    # Ремонт после QC обязан сохранить режим VO: иначе с отремонтированной
    # сцены исчезнут закадры, а полный текст перестанет сходиться.
    vo_source = vo.shots_node_vo_source(project, shots_key)
    vo_chunks = (
        _vo_chunks_by_number(project, shots_key, all_scenes)
        if vo_source is not None
        else {}
    )
    repaired: list[int] = []
    for row in scenes:
        number = int(row["номер"])
        frame = frames_by_number.get(number)
        if frame is None:
            continue
        scene = _scene_dict(frame)
        speech = _speech_of(frame)
        background = backgrounds.get(scene["фон"])
        if background is None:
            continue
        scene_vo = str(vo_chunks.get(number) or "")
        if vo_source is not None and not scene_vo:
            logger.warning(
                "[#%s] %s: сцена %s — режим VO, но куска закадра нет "
                "(voiceover_text пуст и в shots.json его нет), правлю по старой ветке",
                getattr(project, "id", "?"),
                qc_node_key,
                number,
            )
        scene_notes = [
            item for item in violations if int(item.get("сцена") or 0) == number
        ]
        if scene_vo:
            base_prompt = _render_vo(
                _read_vo_prompt(project, VO_SHOTS_PROMPT, shots_key),
                UUID_СЦЕНЫ=scene["id"],
                СЦЕНА=_json(scene),
                РЕЧЬ=_json(speech),
                ФОН=_json(background),
                ЗАКАДР_СЦЕНЫ=scene_vo,
                РЕЕСТР=_json(registry),
            )
        else:
            base_prompt = _render(
                _read_master(project, shots_key, _BY_KIND["shots"]),
                UUID_СЦЕНЫ=scene["id"],
                СЦЕНА=_json(scene),
                РЕЧЬ=_json(speech),
                ФОН=_json(background),
            )
        notes = "\n".join(
            f"- {item.get('shot') or 'сцена'}: {item.get('code') or '?'} — {item.get('detail') or ''}"
            for item in scene_notes[:10]
        )
        prompt = (
            base_prompt
            + "\n\n## Исправь после QC\n\n"
            "QC кадров этой сцены нашёл несоответствия. Пересобери кадры сцены "
            "целиком и убери ровно эти:\n"
            + notes
            + "\nКадр, на который указал QC, больше не должен объяснять движение "
            "против его же промта; соседние сцены и фон не меняй."
        )
        if scene_vo:
            prompt += (
                "\nЗакадровый текст сцены при правке обязан остаться разложенным "
                "по кадрам слово в слово: склейка «закадр» всех кадров = кусок сцены."
            )
        payload = await _ask_json(project, shots_key, prompt, "Шоты этой сцены целиком.")
        ops = payload.get("ops")
        if not isinstance(ops, list) or not ops:
            continue
        kadry: list[Any] = []
        for op in ops:
            if not isinstance(op, dict):
                continue
            fields = op.get("fields")
            if isinstance(fields, dict) and isinstance(fields.get("кадры"), list):
                kadry.extend(_normalize_kadry(fields["кадры"], speech, scene, background))
        if scene_vo:
            kadry = _kadry_in_order([item for item in kadry if isinstance(item, dict)])
            lost = vo.shots_partition_problems(scene_vo, kadry)
            if lost:
                logger.warning(
                    "[#%s] %s: сцена %s после правки QC — закадр разложен кодом (%s)",
                    getattr(project, "id", "?"),
                    qc_node_key,
                    number,
                    json.dumps(lost[:3], ensure_ascii=False),
                )
                kadry = vo.distribute_scene_vo(scene_vo, kadry)
            kadry = vo.with_durations(kadry)
        problems = list(gates.shots_dialogue_problems_plan(kadry, speech))
        problems.extend(_shot_mechanics(kadry, vo_mode=bool(scene_vo), scene=scene))
        if problems:
            logger.warning(
                "[#%s] %s: сцена %s после правки не прошла валидатор — %s",
                getattr(project, "id", "?"),
                qc_node_key,
                number,
                json.dumps(problems[:3], ensure_ascii=False),
            )
            continue
        kadry = [
            {**item, "номер": position} if isinstance(item, dict) else item
            for position, item in enumerate(kadry, 1)
        ]
        await apply.write_scene_attrs(
            session, project, scene["id"], {"кадры": kadry}
        )
        if scene_vo:
            frame.voiceover_text = scene_vo
            frame.duration_seconds = round(
                sum(
                    float(item.get("длительность") or 0)
                    for item in kadry
                    if isinstance(item, dict)
                ),
                2,
            )
        # Коммит после каждой отремонтированной сцены: иначе нода держит
        # write-lock SQLite на все вызовы модели ремонтного прохода, и леджер
        # не может записать llm_calls (тот же BUG-006, что в dialogues/shots).
        await session.commit()
        repaired.append(number)
    if repaired:
        await session.flush()
    return repaired


#: Коды про стык соседних сцен: это замечание раскадровке, не провал сцены.
_CROSS_SCENE_CODES = frozenset({"R-SEM-CONTINUITY"})

#: Счётчики последней сцены (их же возвращает ``_apply_style_to_kadry``).
_STYLE_COUNTS: dict[str, dict[str, int]] = {}

#: Предел тела промта кадра по валидатору: ``shot_rules_v2.PROMPT_BODY_MAX``.
_CADR_BODY_MAX = 4000
#: STYLE-блок кадра: предел 700 символов (R-STYLE-LEN), запас сцены — 200.
#: В keys `frame_style.max_style_chars_v2` нет, поэтому считаем локально.
_STYLE_BLOCK_LIMIT_V2 = 700
_MIN_SCENE_BUDGET = 200


def _max_style_chars_v2(limit: int | None = None) -> int:
    """Предел STYLE-блока v2: 700 символов и не больше остатка бюджета."""
    from app.services import frame_style

    lim = frame_style.body_limit() if limit is None else int(limit)
    return min(_STYLE_BLOCK_LIMIT_V2, max(0, lim - _MIN_SCENE_BUDGET))


#: Сколько раз спрашивать модель по сцене, если ответ не разобрался как JSON.
_SHOTS_ATTEMPTS = 3


def _compact_style(style_text: str, limit: int) -> str:
    """Сжать файл стиля до бюджета STYLE-блока (≤ ``limit``).

    В файле стиля много пояснений для человека; картинке хватает первых
    абзацев: режем по границе предложения, чтобы блок остался читаемым и
    проходил ``R-STYLE-LEN``. Если файл уже короткий — не трогаем.
    """
    text = " ".join(str(style_text or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for separator in (". ", "! ", "? ", "; "):
        position = cut.rfind(separator)
        if position > limit // 2:
            return cut[: position + 1]
    return cut.rstrip()


def _apply_style_to_kadry(
    frame_style: Any,
    frame: Any,
    style_text: str,
    style_name: str,
    limit: int | None = None,
) -> dict[str, int]:
    """Дописать STYLE-блок в кадры одной сцены-``Frame`` и сохранить в ``attrs``.

    Мастер K1 идёт штатным ``apply_style_to_frames``: он берёт сцену из
    ``промт_картинки``, кладёт исходник в ``промт_без_стиля``, пишет ``промт`` и
    ``image_prompt`` по переданному бюджету — режется сцена по предложению,
    стиль никогда.

    Остальные кадры сцены в план-группе не отдельные ``Frame``, а строки
    ``attrs["кадры"]``, поэтому штатный ``apply_style_to_child_prompts`` их не
    видит. Дописываем их сами тем же публичным ``compose_styled_prompt`` и с тем
    же бюджетом; исходник — в ``промт_без_стиля``, повтор идемпотентен.

    ``limit`` = тело промта (4000 по валидатору) + длина сжатого STYLE-блока,
    чтобы итог не вылетал за ``R-PROMPT-LEN``.
    """
    from sqlalchemy.orm.attributes import flag_modified

    report = frame_style.apply_style_to_frames(
        [frame],
        style_name=style_name,
        style_text=style_text,
        limit=limit,
        set_ready_status=False,
    )
    raw = report.get("counts") or {}
    kadry = _frames_of(frame)
    limit = frame_style.body_limit() if limit is None else int(limit)
    style_clean = str(style_text or "").strip()
    master = frame_style.master_index(kadry)
    trimmed_children = 0
    for index, entry in enumerate(kadry):
        # Мастеру промт уже дописал apply_style_to_frames; остальным — сами.
        if index == master:
            continue
        base = str(entry.get(frame_style.SCENE_RAW_KEY) or "").strip() or str(
            frame_style.strip_style(entry.get(frame_style.MAIN_PROMPT_KEY)) or ""
        ).strip()
        if not base:
            continue
        final, _scene_cut, trimmed = frame_style.compose_styled_prompt(
            base, style_clean, limit=limit
        )
        if not final or final == str(entry.get(frame_style.MAIN_PROMPT_KEY) or ""):
            continue
        entry[frame_style.MAIN_PROMPT_KEY] = final
        entry[frame_style.SCENE_RAW_KEY] = base
        if trimmed:
            trimmed_children += 1
        entry[frame_style.STYLE_NAME_KEY] = frame_style.clean_style_name(style_name)
    # «Дети» считаются по факту наличия STYLE-блока в их промтах, а не по
    # числу записей в этом проходе: повторный прогон ничего не меняет, но
    # кадры уже стилизованы, и отчёт не должен показывать 0.
    children = sum(
        1
        for idx, ent in enumerate(kadry)
        if idx != master and str(ent.get(frame_style.STYLE_NAME_KEY) or "").strip()
    )
    attrs = dict(frame.attrs or {})
    attrs["кадры"] = kadry
    frame.attrs = attrs
    flag_modified(frame, "attrs")
    counts = {
        "shots": len(kadry),
        "master": int(raw.get("image_prompt_written", 0) or 0),
        "children": children,
        "trimmed": int(raw.get("trimmed", 0) or 0) + trimmed_children,
        "no_prompt": int(raw.get("no_prompt", 0) or 0),
    }
    _STYLE_COUNTS["last"] = counts
    return counts


def _style_text_from_slot(node_key: str, name: str, text: Any) -> str:
    """Текст стиля из загруженного «своего промта».

    Поле выбора стиля хранит имя файла, но текст лежит в библиотеке промтов как
    ``<имя>.md`` (файл стиля в папке стилей при этом не создаётся). Если текст
    слота не похож на стиль — это мастер-промт шага, и брать его нельзя.
    """
    from app.services import frame_style
    from app.services.excel_gpt_node import EXCEL_GPT_STEP_CODE
    from app.services.prompt_library import prompt_path

    candidates: list[tuple[str, bool]] = [(str(text or "").strip(), False)]
    try:
        path = prompt_path(EXCEL_GPT_STEP_CODE, name)
        if path.is_file():
            candidates.append(
                (path.read_text(encoding="utf-8", errors="replace").strip(), True)
            )
    except Exception:  # noqa: BLE001 — путь промта не критичен, важен текст слота
        logger.debug("[%s] не удалось прочитать промт %r", node_key, name)
    for item, from_named_file in candidates:
        if _looks_like_style(item, named_file=from_named_file):
            return frame_style.normalize_style_text(item)
    logger.warning(
        "[%s] стиль %r не найден как файл, а текст слота не похож на стиль — "
        "беру стиль по умолчанию",
        node_key,
        name,
    )
    return ""


def _looks_like_style(text: str, *, named_file: bool = False) -> bool:
    """Стиль — короткий визуальный блок, не мастер-промт шага.

    ``named_file`` — текст взят из промта шага по имени привязки (``warhamer``,
    ``style_*``): такие файлы бывают длиннее 1500 символов (warhamer.md — 2885),
    и раньше они отбрасывались как «не стиль», из-за чего нода молча уходила в
    стиль по умолчанию (акварель-нуар) при живом выборе Warhammer. Мастер-промты
    шагов всё равно отсекаются по «## » и по «Ты …» в начале.
    """
    clean = (text or "").strip()
    limit = 6000 if named_file else 1500
    if len(clean) < 40 or len(clean) > limit:
        return False
    # Мастер-промты шагов начинаются с постановки роли и содержат разделы «##».
    return "## " not in clean and "Ты " not in clean[:200]


def _resolve_style(project: Any, node_key: str) -> tuple[str, str]:
    """(имя стиля, текст стиля) для ноды: файл стилей или загруженный текст."""
    from app.services import frame_style
    from app.services.excel_gpt_node import EXCEL_GPT_STEP_CODE
    from app.services.prompt_library import read_resolved_project_prompt

    try:
        variant, _path, _text, prompt_source = read_resolved_project_prompt(
            project, EXCEL_GPT_STEP_CODE, node_key=node_key, slot_id="main"
        )
    except FileNotFoundError:
        variant, _text, prompt_source = "", "", "missing"
    style_name = ""
    style_text = ""
    # Стиль выбирают двумя способами: файлом из папки стилей (имя файла) или
    # загрузкой текста в «свой промт» — тогда в поле стоит имя загруженного
    # файла, а файла стиля с таким именем нет. Второй способ законный: текст
    # приходит содержимым слота, и брать его надо оттуда, а не искать файл.
    candidate = frame_style.clean_style_name(variant)
    is_default_variant = candidate in ("", "default", "по умолчанию")
    if not is_default_variant:
        path = frame_style.style_path(candidate)
        if path is None:
            path = next(
                (
                    item
                    for item in sorted(frame_style.styles_dir().glob("*.md"))
                    if item.stem == candidate and item.is_file()
                ),
                None,
            )
        if path is not None:
            style_name = path.stem
            style_text = frame_style.normalize_style_text(
                path.read_text(encoding="utf-8", errors="replace")
            )
        else:
            style_name = candidate
            style_text = _style_text_from_slot(node_key, candidate, _text)
    if not style_text:
        style_name = frame_style.DEFAULT_STYLE
        style_text = frame_style.load_style_text(style_name)
    logger.info(
        "[%s] стиль: %s (источник %s), символов %s",
        node_key,
        style_name,
        prompt_source,
        len(style_text),
    )
    return style_name, style_text


async def _run_style(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 8: стиль (код, без GPT): STYLE-блок в поля кадров сцен ``attrs["кадры"]``.

    Промтов на уровне сцены в группе нет: промты живут в кадрах
    (``промт_картинки``), поэтому стиль идёт по кадрам каждой сцены: мастеру
    K1 — штатным ``apply_style_to_frames``, остальным — тем же
    ``compose_styled_prompt`` (см. ``_apply_style_to_kadry``). Реплики не
    трогаются: стиль касается промтов, а не текста.
    """
    apply = _apply()

    from app.services import frame_style

    style_name, style_text = _resolve_style(project, node_key)
    # Промт кадра живёт в бюджете валидатора кадров: тело ≤ 4000 символов,
    # STYLE-блок ≤ 700 (R-STYLE-LEN). Полный файл стиля (≈3500) не влезает,
    # поэтому берём сжатый блок и считаем от него бюджет сцены.
    style_text = _compact_style(
        style_text, _max_style_chars_v2()
    )
    body_limit = _CADR_BODY_MAX + len(style_text)
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — нечего стилить"
        )
    totals: dict[str, int] = {}
    per_scene: list[dict[str, Any]] = []
    for frame in scenes:
        kadry = _frames_of(frame)
        if not kadry:
            per_scene.append({"номер": int(frame.number or 0), "кадров": 0, "styled": 0})
            continue
        _apply_style_to_kadry(frame_style, frame, style_text, style_name, body_limit)
        counts = _STYLE_COUNTS["last"]
        for key, value in counts.items():
            if isinstance(value, int):
                totals[key] = totals.get(key, 0) + value
        per_scene.append(
            {
                "номер": int(frame.number or 0),
                "кадров": counts.get("shots", 0),
                "мастер": counts.get("master", 0),
                "дети": counts.get("children", 0),
                "обрезано": counts.get("trimmed", 0),
            }
        )
    await session.flush()
    # Стиль мог раздуть промты: после записи проверяем кадры тем же
    # механическим валидатором, что и нода шотов (R-PROMPT-LEN, R-STYLE-LEN).
    # В VO-режиме валидатор идёт с vo_mode=True, иначе снимался бы потолок
    # кадров по «без закадра» и сцена из 7+ кусков закадра валила шаг стиля.
    style_block_len = len(style_text)
    vo_mode = False
    try:
        shots_key = _BY_KIND["shots"].node_id
        vo_mode = _vo().shots_node_vo_source(project, shots_key) is not None
    except Exception:  # noqa: BLE001 — VO-источник не критичен для стиля
        logger.debug("[%s] не удалось определить VO-режим", node_key, exc_info=True)
    problems: list[str] = []
    for frame in scenes:
        items = _gates().shots_gate_problems(
            _frames_of(frame),
            vo_mode=vo_mode,
            style_block_len=style_block_len,
        )
        if vo_mode:
            items = [
                item
                for item in items
                if not any(item.startswith(code) for code in VO_RELAXED_SHOT_CODES)
            ]
        problems.extend(items)
    report = {
        "style": style_name,
        "style_chars": len(style_text),
        "style_file": str(frame_style.style_path(style_name) or ""),
        "counts": totals,
        "сцены": per_scene,
        "проблемы": problems[:12],
        "vo_mode": vo_mode,
        "project_id": getattr(project, "id", None),
        "node_key": node_key,
    }
    path = apply.save_artifact(project, node_key, ARTIFACT_STYLE, report)
    # Гейт после стиля больше не валит ноду: замечания механического
    # валидатора — дело ноды QC, а стиль обязан доводить шаг до конца.
    if not totals.get("master") and not totals.get("children"):
        logger.error(
            "[%s] стиль %s не лёг ни на один кадр — нет кадров или нет промтов (R-STYLE), смотри %s",
            node_key,
            style_name,
            path,
        )
    if problems:
        logger.warning(
            "[%s] после стиля кадры не проходят валидатор (не блокирую): %s",
            node_key,
            json.dumps(problems[:5], ensure_ascii=False),
        )
    return NodeResult(
        reply_text=(
            f"стиль {style_name}: кадров {totals.get('shots', 0)}, "
            f"мастеров {totals.get('master', 0)}, детей {totals.get('children', 0)}, "
            f"обрезано {totals.get('trimmed', 0)}, "
            f"замечаний валидатора {len(problems)}"
        ),
        output_paths=[path],
    )


async def _run_report(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг 9: HTML-отчёт сцен и кадров (код, без GPT).

    Свой шаблон группы: общий ``shots_report`` описывает старую цепочку с
    закадром, а здесь закадра нет вовсе — только план, сцены, речь, фоны и кадры.
    """
    from app.services.plan_cinema import report as plan_report

    apply = _apply()
    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(f"#{getattr(project, 'id', '?')} {node_key}: нет сцен для отчёта")
    characters = await apply.load_characters(session, project)
    backgrounds = await apply.load_backgrounds(session, project)
    path = plan_report.write_report(
        project, scenes=scenes, characters=characters, backgrounds=backgrounds
    )
    shots_total = sum(len(_frames_of(frame)) for frame in scenes)
    path_artifact = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_REPORT,
        {
            "отчёт": str(path),
            "сцен": len(scenes),
            "кадров": shots_total,
            "персонажей": len(characters),
            "фонов": len(backgrounds),
        },
    )
    return NodeResult(
        reply_text=f"отчёт: сцен {len(scenes)}, кадров {shots_total}, файл {path.name}",
        output_paths=[path, path_artifact],
    )


# ── Промты картинок: финальный промт кадра из переменных ────────────────────

#: Панели листа фона 2×2: номер → место на картинке.
SHEET_PANEL_PLACES: dict[int, str] = {
    1: "верхний левый",
    2: "верхний правый",
    3: "нижний левый",
    4: "нижний правый",
}
#: В листе всегда четыре панели (``backgrounds_render.SHEET_ANGLES_COUNT``).
SHEET_PANEL_COUNT = len(SHEET_PANEL_PLACES)
#: Ракурс кадра → ближайший ракурс панели (канон ``backgrounds_render.SHEET_ANGLE_EN``).
_ANGLE_NEAREST: dict[str, str] = {
    "фронт": "фронт",
    "3/4": "3/4",
    "с плеча": "3/4",
    "профиль": "3/4",
    "сзади": "фронт",
    "со спины": "фронт",
    "сверху": "фронт",
    "снизу": "фронт",
    "макро": "3/4",
}
#: Крупность по возрастанию: панель с ближайшей крупностью предпочтительнее.
_PLAN_RANK: tuple[str, ...] = (
    "ОБЩИЙ",
    "СРЕДНИЙ",
    "СРЕДНЕ-КРУПНЫЙ",
    "КРУПНЫЙ",
    "ДЕТАЛЬ",
    "МАКРО",
)
#: Поля кадра, которые уходят модели: старый промт не нужен, он пишется с нуля.
_PROMPT_INPUT_KEYS: tuple[str, ...] = (
    "id",
    "номер",
    "порядок",
    "план",
    "ракурс",
    "высота",
    "линза",
    "место",
    "действие",
    "кто_где",
    "позы",
    "эмоции",
    "предметы",
    "говорит",
    "реплика",
    "звук",
    "фон_код",
    "кто",
    "где",
    "фон",
)
#: Линза по умолчанию, если в кадре нет своего поля.
PROMPT_LENS_DEFAULT = "35"


def _angle_key(raw: Any) -> str:
    return " ".join(str(raw or "").split()).lower().replace("\\", "/")


def _plan_rank(raw: Any) -> int:
    text = " ".join(str(raw or "").split()).upper()
    for index, name in enumerate(_PLAN_RANK):
        if name in text:
            return index
    return 1


def _closest_panel(
    panels: Sequence[Mapping[str, Any]], shot: Mapping[str, Any]
) -> int:
    """Панель для кадра 5+: тот же ракурс, иначе ближайший по канону листа."""
    want = _angle_key(shot.get("ракурс"))
    if want:
        same = [
            (index, panel)
            for index, panel in enumerate(panels, 1)
            if _angle_key(panel.get("ракурс")) == want
        ]
        if same:
            rank = _plan_rank(shot.get("план"))
            return min(
                same,
                key=lambda item: (abs(_plan_rank(item[1].get("план")) - rank), item[0]),
            )[0]
        nearest = _ANGLE_NEAREST.get(want, "")
        if nearest:
            same = [
                (index, panel)
                for index, panel in enumerate(panels, 1)
                if _angle_key(panel.get("ракурс")) == nearest
            ]
            if same:
                return same[0][0]
    return 1


def _shot_panels(
    scenes: Sequence[Any], kadry_by_scene: Mapping[str, Sequence[Mapping[str, Any]]]
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    """(кадры-панели фона, номер панели каждого кадра).

    Панели листа — первые четыре кадра фона в порядке сцен (как их собирает
    ``_card_angles``). Кадры 5+ в лист не попадают: им достаётся панель по
    логике первых четырёх — тот же ракурс, при равенстве ближайшая крупность.
    """
    frames_by_bg: dict[str, list[dict[str, Any]]] = {}
    for frame in scenes:
        for shot in kadry_by_scene.get(str(getattr(frame, "uuid", ""))) or []:
            code = str(shot.get("фон_код") or "").strip()
            if not code:
                continue
            bucket = frames_by_bg.setdefault(code, [])
            if len(bucket) < SHEET_PANEL_COUNT:
                bucket.append(
                    {
                        "id": str(shot.get("id") or ""),
                        "ракурс": str(shot.get("ракурс") or ""),
                        "план": str(shot.get("план") or ""),
                    }
                )
    shot_panel: dict[str, int] = {}
    for bucket in frames_by_bg.values():
        for index, panel in enumerate(bucket, 1):
            if panel["id"]:
                shot_panel[panel["id"]] = index
    for frame in scenes:
        for shot in kadry_by_scene.get(str(getattr(frame, "uuid", ""))) or []:
            shot_id = str(shot.get("id") or "").strip()
            if not shot_id or shot_id in shot_panel:
                continue
            code = str(shot.get("фон_код") or "").strip()
            bucket = frames_by_bg.get(code) or []
            if bucket:
                shot_panel[shot_id] = _closest_panel(bucket, shot)
    return frames_by_bg, shot_panel


def _panels_payload(
    frames_by_bg: Mapping[str, Sequence[Mapping[str, Any]]],
    shot_panel: Mapping[str, int],
) -> dict[str, Any]:
    """Карта листа для промта: панели фонов, номер панели кадра, места на листе."""
    return {
        "фоны": {
            code: {
                str(index): str(panel.get("id") or "")
                for index, panel in enumerate(bucket, 1)
            }
            for code, bucket in frames_by_bg.items()
        },
        "кадры": {shot_id: panel for shot_id, panel in shot_panel.items()},
        "места": {str(number): place for number, place in SHEET_PANEL_PLACES.items()},
    }


def _ref_block(panel: int) -> str:
    """Служебный блок «Референсы» — дословно один и тот же в каждом промте."""
    place = SHEET_PANEL_PLACES.get(int(panel or 0), "")
    tail = f" ({place})" if place else ""
    return (
        "Референсы: каждый референс с персонажем — один персонаж, показанный с разных "
        "сторон. Лист фона — одна и та же локация в четырёх панелях; бери только "
        f"панель {panel}{tail}."
    )


def _prompt_input_card(card: Mapping[str, Any]) -> dict[str, Any]:
    return {key: card[key] for key in _PROMPT_INPUT_KEYS if key in card}


def _prompts_cards_problems(kadry_in: Sequence[Any], cards: Any) -> list[str]:
    """Что не так с карточками из ответа «Промтов картинок»."""
    if not isinstance(cards, list):
        return ["поле «кадры» — не список"]
    if len(cards) != len(kadry_in):
        return [f"кадров {len(cards)} вместо {len(kadry_in)}"]
    problems: list[str] = []
    for expected, got in zip(kadry_in, cards, strict=False):
        if not isinstance(got, dict):
            problems.append(f"кадр {expected.get('id')}: карточка не объект")
            continue
        shot_id = str(expected.get("id") or "")
        if str(got.get("id") or "") != shot_id:
            problems.append(f"кадр {shot_id}: id изменился на {got.get('id')!r}")
        text = " ".join(str(got.get("промт_картинки") or "").split())
        if not text:
            problems.append(f"кадр {shot_id}: пустой промт_картинки")
        elif len(text) < 200:
            problems.append(f"кадр {shot_id}: промт короче 200 символов ({len(text)})")
    return problems


def _style_tail_split(text: str, style_text: str) -> tuple[str, str]:
    """(тело, хвост стиля) — если промт уже кончается текстом стиля."""
    body = text.strip()
    style = " ".join(str(style_text or "").split())
    if style and body.endswith(style):
        return body[: -len(style)].strip(), style
    return body, ""


def _prompts_cards_merge(
    kadry_in: Sequence[Any],
    cards: Sequence[Any],
    shot_panel: Mapping[str, int],
    style_text: str,
) -> tuple[list[dict[str, Any]], int, list[str]]:
    """Карточки для записи: меняются только ``промт_картинки`` и ``панель_фона``.

    Код доводит промт до контракта: номер панели берёт из своей карты (модель
    могла не посчитать), блок «Референсы» вставляет дословно, стиль ставит
    последним блоком и режет тело под бюджет: тело ≤ 4000, стиль ≤ 700.
    """
    from app.services import frame_style

    style = " ".join(str(style_text or "").split())
    merged: list[dict[str, Any]] = []
    trimmed = 0
    defects: list[str] = []
    for original, got in zip(kadry_in, cards, strict=False):
        card = dict(original) if isinstance(original, dict) else {}
        shot_id = str(card.get("id") or "")
        panel = int(shot_panel.get(shot_id) or 0)
        text = " ".join(str((got or {}).get("промт_картинки") or "").split())
        body, tail = _style_tail_split(text, style)
        if not tail and style:
            # Стиля в ответе нет — код ставит его сам, последним блоком.
            body = text
        # Блок референсов обязателен и не режется: под него бронируем место,
        # обрезка идёт до него, а не по нему.
        ref = ""
        if panel and "Референс" not in body:
            ref = _ref_block(panel)
        budget = _CADR_BODY_MAX - (len(ref) + 1 if ref else 0)
        if len(body) > budget:
            body, cut = frame_style.trim_scene(body, budget)
            trimmed += int(cut)
        if ref:
            body = f"{body} {ref}".strip()
        final = f"{body}\n\n{style}".strip() if style else body
        if not final:
            defects.append(f"кадр {shot_id}: пустой промт после сборки")
        card["промт_картинки"] = final
        card["панель_фона"] = panel if panel else int(card.get("панель_фона") or 0)
        merged.append(card)
    return merged, trimmed, defects


async def _run_prompts(session: Any, project: Any, *, node_key: str) -> NodeResult:
    """Шаг: промты картинок — финальный промт кадра из переменных.

    Стоит после «Правок кадров», перед генерацией картинок. Собирает промт
    заново по переменным кадра: линза, план, ракурс, высота, действие с
    персонажами по кодам, положение на экране (модель пересчитывает его из
    ракурса и высоты, а не копирует ``кто_где``), фон с номером панели листа
    2×2, блок референсов и стиль. Панели считает код: кадры 1–4 фона → панели
    1–4, кадры 5+ → панель по логике первых четырёх (тот же ракурс, при
    равенстве ближайшая крупность), поэтому раскладка листа не разъезжается.
    """
    apply = _apply()

    scenes = await apply.load_scenes(session, project)
    if not scenes:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет сцен — сначала «Сцены по плану»"
        )
    characters = await apply.load_characters(session, project)
    backgrounds = await apply.load_backgrounds(session, project)
    # Стиль берём у ноды «Стиль»: у «Промтов картинок» свой промт-вариант.
    style_name, style_text = _resolve_style(project, _BY_KIND["style"].node_id)
    style_text = _compact_style(style_text, _max_style_chars_v2())
    master_prompt = _read_master(project, node_key, _BY_KIND["prompts"])
    kadry_by_scene: dict[str, list[dict[str, Any]]] = {
        str(frame.uuid): _frames_of(frame) for frame in scenes
    }
    frames_by_bg, shot_panel = _shot_panels(scenes, kadry_by_scene)
    panels_payload = _panels_payload(frames_by_bg, shot_panel)
    registry_json = _json(_registry_list(characters))
    backgrounds_json = _json([backgrounds[code] for code in sorted(backgrounds)])
    jobs: list[dict[str, Any]] = []
    for frame in scenes:
        scene = _scene_dict(frame)
        kadry = kadry_by_scene[str(frame.uuid)]
        if not kadry:
            continue
        prompt = _render(
            master_prompt,
            сцена=_json(scene),
            кадры=_json([_prompt_input_card(card) for card in kadry]),
            реестр_персонажи=registry_json,
            реестр_фоны=backgrounds_json,
            панели_фона=_json(panels_payload),
            стиль=style_text,
            линза=PROMPT_LENS_DEFAULT,
        )
        jobs.append(
            {"scene": scene, "frame": frame, "kadry": kadry, "prompt": prompt}
        )
    if not jobs:
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: нет кадров — сначала «Шоты»"
        )

    reports: list[dict[str, Any]] = []

    async def _ask_scene(job: dict[str, Any]) -> dict[str, Any]:
        """Спросить промты одной сцены, переспрашивая при потерянных кадрах."""
        prompt = str(job["prompt"])
        problems: list[str] = []
        for attempt in range(1, _SHOTS_ATTEMPTS + 1):
            try:
                payload = await _ask_json(
                    project, node_key, prompt, "Промты картинок этой сцены."
                )
            except Exception as exc:  # noqa: BLE001 — обрыв/битый JSON у шлюза
                problems = [f"ответ модели не разобран: {exc}"]
                logger.warning(
                    "[#%s] %s: сцена %s — ответ не разобран (попытка %s/%s): %s",
                    getattr(project, "id", "?"),
                    node_key,
                    job["scene"]["номер"],
                    attempt,
                    _SHOTS_ATTEMPTS,
                    str(exc)[:200],
                )
                if attempt == _SHOTS_ATTEMPTS:
                    raise
                continue
            cards = payload.get("кадры") if isinstance(payload, dict) else None
            problems = _prompts_cards_problems(job["kadry"], cards)
            if not problems:
                return {**job, "payload": payload}
            logger.warning(
                "[#%s] %s: сцена %s — кадры не приняты (попытка %s/%s): %s",
                getattr(project, "id", "?"),
                node_key,
                job["scene"]["номер"],
                attempt,
                _SHOTS_ATTEMPTS,
                "; ".join(problems[:3]),
            )
            prompt = (
                str(job["prompt"])
                + "\n\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРИНЯТ: "
                + "; ".join(problems[:3])
                + ".\nВерни ВСЕ кадры сцены в том же количестве и с теми же id,"
                " у каждого кадра полный промт_картинки."
            )
        raise RuntimeError(
            f"#{getattr(project, 'id', '?')} {node_key}: сцена {job['scene']['номер']} — "
            + "; ".join(problems[:3])
        )

    async def _commit(answer: dict[str, Any]) -> None:
        scene, kadry_in = answer["scene"], answer["kadry"]
        payload = answer["payload"]
        cards = payload.get("кадры")
        problems = _prompts_cards_problems(kadry_in, cards)
        if problems:
            raise RuntimeError(
                f"#{getattr(project, 'id', '?')} {node_key}: сцена {scene['номер']} — "
                + "; ".join(problems[:3])
            )
        merged, trimmed, defects = _prompts_cards_merge(
            kadry_in, cards, shot_panel, style_text
        )
        report = payload.get("report") if isinstance(payload.get("report"), dict) else {}
        unresolved = [str(item) for item in report.get("unresolved") or []]
        # Мастер K1 — тот же промт в image_prompt сцены: именно его берёт генерация.
        first = merged[0] if merged else {}
        frame = answer["frame"]
        if first.get("промт_картинки"):
            frame.image_prompt = str(first["промт_картинки"])
        # Кадры сцены живут в ``Frame.attrs["кадры"]``: точечный патч атрибутов,
        # а не apply-ops по ядру (``db_apply`` не знает поля «кадры»).
        await apply.write_scene_attrs(session, project, scene["id"], {"кадры": merged})
        await session.commit()
        lengths = [len(str(row.get("промт_картинки") or "")) for row in merged]
        reports.append(
            {
                "номер": scene["номер"],
                "кадров": len(merged),
                "панели": {
                    str(row.get("id") or ""): int(row.get("панель_фона") or 0)
                    for row in merged
                },
                "длина": {
                    "мин": min(lengths) if lengths else 0,
                    "макс": max(lengths) if lengths else 0,
                },
                "обрезано": trimmed,
                "unresolved": unresolved + defects,
            }
        )

    size, stagger = _parallel_limits()
    logger.info(
        "[#%s] %s: сцен с кадрами %s, пачка %s, пауза %.1f с, стиль %s (%s симв)",
        getattr(project, "id", "?"),
        node_key,
        len(jobs),
        size,
        stagger,
        style_name,
        len(style_text),
    )
    await _run_in_batches(
        jobs,
        _ask_scene,
        _commit,
        size=size,
        stagger=stagger,
        project_id=getattr(project, "id", "?"),
        node_key=node_key,
        label=lambda job: job["scene"]["номер"],
    )
    shots_total = sum(int(row["кадров"]) for row in reports)
    trimmed_total = sum(int(row["обрезано"]) for row in reports)
    unresolved_all = [item for row in reports for item in row["unresolved"]]
    path = apply.save_artifact(
        project,
        node_key,
        ARTIFACT_PROMPTS,
        {
            "сцены": reports,
            "кадров": shots_total,
            "обрезано": trimmed_total,
            "стиль": {"имя": style_name, "символов": len(style_text)},
            "панели": panels_payload["фоны"],
            "unresolved": unresolved_all,
        },
    )
    return NodeResult(
        reply_text=(
            f"промты картинок: сцен {len(reports)}, кадров {shots_total}, "
            f"стиль {style_name} ({len(style_text)} симв), обрезано {trimmed_total}, "
            f"unresolved {len(unresolved_all)}"
        ),
        output_paths=[Path(path)],
    )


_HANDLERS = {
    "scenes": _run_scenes,
    "cast": _run_cast,
    "skeleton": _run_skeleton,
    "dialogues": _run_dialogues,
    "shots": _run_shots,
    "backgrounds": _run_backgrounds,
    "qc": _run_qc,
    "fix": _run_fix,
    "check": _run_check,
    "style": _run_style,
    "report": _run_report,
    "prompts": _run_prompts,
}



async def _finish_node(
    session: Any,
    project: Any,
    *,
    spec: PlanCinemaNodeSpec,
    node_key: str,
    slot_idx: int,
    result: NodeResult,
) -> None:
    """Отметить ноду завершённой так же, как это делают старые код-ноды."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.gpt_operator import save_operator_result
    from app.services.run_sync import complete_excel_gpt_node_by_key

    save_operator_result(
        project,
        node_key,
        input_paths=[],
        output_paths=result.output_paths,
        reply_text=result.reply_text,
        gate_status=result.gate_status,
    )
    meta = dict(project.meta or {})
    done_keys = [str(key) for key in (meta.get("excel_gpt_completed_keys") or [])]
    if node_key not in done_keys:
        done_keys.append(node_key)
        meta["excel_gpt_completed_keys"] = done_keys
    completed = [int(x) for x in (meta.get("enrich_completed_slots") or []) if str(x).isdigit()]
    if slot_idx not in completed:
        completed.append(slot_idx)
        completed.sort()
        meta["enrich_completed_slots"] = completed
    meta.pop("active_excel_gpt_node_key", None)
    if result.meta_patch:
        meta.update(result.meta_patch)
    project.meta = meta
    flag_modified(project, "meta")
    await session.flush()
    try:
        await complete_excel_gpt_node_by_key(
            session, project, node_key, enrich_slot=slot_idx
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "[#%s] %s: complete_excel_gpt_node_by_key failed",
            getattr(project, "id", "?"),
            node_key,
        )


async def run_plan_cinema_node(
    session: Any,
    project: Any,
    *,
    node_key: str,
    slot_idx: int,
) -> None:
    """Исполнить ноду группы ``plan_cinema`` по её ``node_key``.

    Хук раннера вызывает это после проверки ``is_plan_cinema_node``. Нода
    проверяет активацию (``meta.source_mode == "plan"``, нет смеси групп),
    диспетчеризует обработчик, отмечает завершение.
    """
    spec = plan_cinema_node_spec(node_key)
    if spec is None:
        raise RuntimeError(
            f"run_plan_cinema_node: {node_key!r} не нода группы {GROUP_ID}"
        )
    meta = dict(project.meta or {})
    assert_plan_cinema_activation(meta, node_key)
    handler = _HANDLERS[spec.kind]
    logger.info(
        "[#%s] plan_cinema %s (%s): старт",
        getattr(project, "id", "?"),
        node_key,
        spec.label,
    )
    result = await handler(session, project, node_key=node_key)
    await _finish_node(
        session,
        project,
        spec=spec,
        node_key=node_key,
        slot_idx=slot_idx,
        result=result,
    )
    logger.info(
        "[#%s] plan_cinema %s: %s",
        getattr(project, "id", "?"),
        node_key,
        result.reply_text,
    )


__all__ = [
    "ARTIFACT_CHECK",
    "ARTIFACT_DIALOGUES",
    "ARTIFACT_FIX",
    "ARTIFACT_PROMPTS",
    "ARTIFACT_QC",
    "ARTIFACT_REPORT",
    "ARTIFACT_SCENES",
    "ARTIFACT_SHOTS",
    "ARTIFACT_STYLE",
    "GROUP_ID",
    "LEGACY_SUFFIXES",
    "MIN_SCENES",
    "NODE_SPECS",
    "NodeResult",
    "PLAN_MODE",
    "PlanCinemaNodeSpec",
    "SOURCE_MODE_KEY",
    "assert_plan_cinema_activation",
    "is_plan_cinema_node",
    "mixed_group_conflict_error",
    "plan_cinema_node_ids",
    "plan_cinema_node_kind",
    "plan_cinema_node_spec",
    "plan_cinema_node_specs",
    "run_plan_cinema_node",
    "source_mode",
]
