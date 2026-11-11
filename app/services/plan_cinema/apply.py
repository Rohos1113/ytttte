"""plan_cinema: чтение, запись и артефакты для нод группы (CONTRACT.md §3).

Исходные файлы механики не трогаем: ``db_apply.apply_ops`` остаётся как был.
Здесь живёт публичный API для диспетчера ``pk_*`` нод:

Чтение: ``load_scenes``, ``load_characters``, ``load_backgrounds``.
Запись: ``apply_plan_ops`` (общий вход apply-ops: сцены/кадры → обычный
``db_apply.apply_ops``, а речь/фон сцены — поверх него), ``write_entities``
(персонажи + фоны), ``write_scene_attrs`` (точечный патч ``Frame.attrs``),
``upsert_backgrounds``, ``apply_scene_fields``.
Артефакты: ``artifact_path``, ``save_artifact``, ``read_artifact``.

Валидация формы речи сцены — ``validate_scene_speech``: неверная форма даёт
``db_apply.ApplyOpsError``, а не молчаливую запись. Алиас
``"реплика" → voiceover_text`` живёт в ``db_apply.FIELD_ALIASES`` и здесь не
используется: реплики кадров пишутся как данные лестницы ``attrs["кадры"]``
через обычный apply-ops и ``voiceover_text`` не трогают.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Entity, Frame, Project
from app.services.db_apply import ApplyOpsError

#: Значения поля «тип» речи (CONTRACT.md §3).
SPEECH_TYPES: tuple[str, ...] = ("нет", "монолог", "диалог")
#: Ключи одной реплики.
SPEECH_REPLICA_KEYS: tuple[str, ...] = ("кто", "текст", "эмоция")
#: Максимум реплик в диалоговой сцене.
SPEECH_MAX_REPLICAS = 6
#: Код фона: f01, f02… (Entity(type="background", code="f0N")).
SCENE_BACKGROUND_CODE_RE = re.compile(r"^f\d{2,}$")
#: attrs фона ровно по контракту (порядок как в CONTRACT.md §3).
BACKGROUND_ATTR_KEYS: tuple[str, ...] = ("место", "описание", "свет", "время", "промт")
#: Ключ режима plan_cinema в attrs сцены: ровно `"источник": "pk"` (§3).
SCENE_SOURCE_ATTR = "источник"
SCENE_SOURCE_MARK = "pk"
#: Имена поля «речь сцены» во входных данных.
SPEECH_FIELD_NAMES: frozenset[str] = frozenset({"речь", "speech", "речь_сцены", "scene_speech"})
#: Имена поля «код фона сцены» во входных данных.
BACKGROUND_FIELD_NAMES: frozenset[str] = frozenset(
    {"фон", "фон_сцены", "сцена_фон", "scene_background", "scene_bg"}
)


def validate_scene_speech(raw: Any, *, scope: str = "речь сцены") -> dict[str, Any]:
    """Проверить и нормализовать ``Frame.attrs["речь"]`` по CONTRACT.md §3.

    ``тип`` только нет/монолог/диалог; «нет» → пустые реплики; «монолог» —
    ровно одна; «диалог» — 2–6 реплик и минимум два разных ``кто``. В реплике
    обязательны непустые ``кто``/``текст``, ``эмоция`` необязательна.

    Неверная форма — ``ApplyOpsError`` с понятным текстом: молчаливой записи
    кривой речи в БД нет.
    """
    if not isinstance(raw, dict):
        raise ApplyOpsError(
            f"{scope}: «речь» должна быть объектом с ключами "
            f"['тип', 'реплики'], а не {type(raw).__name__}"
        )
    unknown = [str(k) for k in raw if str(k) not in {"тип", "реплики"}]
    if unknown:
        raise ApplyOpsError(
            f"{scope}: неизвестные поля речи {unknown}; разрешены: ['тип', 'реплики']"
        )
    kind = str(raw.get("тип") or "").strip()
    if kind not in SPEECH_TYPES:
        raise ApplyOpsError(f"{scope}: «тип» {kind!r} не из {list(SPEECH_TYPES)}")
    replicas_raw = raw.get("реплики")
    if replicas_raw is None:
        replicas_raw = []
    if not isinstance(replicas_raw, list):
        raise ApplyOpsError(
            f"{scope}: «реплики» должны быть списком, а не {type(replicas_raw).__name__}"
        )
    replicas: list[dict[str, str]] = []
    for idx, replica in enumerate(replicas_raw, 1):
        if not isinstance(replica, dict):
            raise ApplyOpsError(f"{scope}: реплика #{idx} должна быть объектом")
        extra = [str(k) for k in replica if str(k) not in SPEECH_REPLICA_KEYS]
        if extra:
            raise ApplyOpsError(
                f"{scope}: реплика #{idx}: неизвестные поля {extra}; "
                f"разрешены: {list(SPEECH_REPLICA_KEYS)}"
            )
        who = str(replica.get("кто") or "").strip()
        if not who:
            raise ApplyOpsError(
                f"{scope}: реплика #{idx}: пустой «кто» (нужен код c0N из реестра)"
            )
        text = str(replica.get("текст") or "").strip()
        if not text:
            raise ApplyOpsError(f"{scope}: реплика #{idx} ({who}): пустой «текст»")
        replicas.append(
            {
                "кто": who,
                "текст": text,
                "эмоция": str(replica.get("эмоция") or "").strip(),
            }
        )
    if kind == "нет":
        if replicas:
            raise ApplyOpsError(
                f"{scope}: «тип» нет требует пустых «реплики», пришло {len(replicas)}"
            )
    elif kind == "монолог":
        if len(replicas) != 1:
            raise ApplyOpsError(
                f"{scope}: монолог — ровно 1 реплика, пришло {len(replicas)}"
            )
    else:
        if not 2 <= len(replicas) <= SPEECH_MAX_REPLICAS:
            raise ApplyOpsError(
                f"{scope}: диалог — 2–{SPEECH_MAX_REPLICAS} реплик, "
                f"пришло {len(replicas)}"
            )
        speakers = {r["кто"] for r in replicas}
        if len(speakers) < 2:
            raise ApplyOpsError(
                f"{scope}: диалог требует минимум двух разных «кто», "
                f"пришло {sorted(speakers)}"
            )
    return {"тип": kind, "реплики": replicas}


def normalize_scene_background_code(value: Any, *, scope: str = "фон сцены") -> str:
    """``Frame.attrs["фон"]`` = код ``f0N``; неверный формат — отказ."""
    if not isinstance(value, str):
        raise ApplyOpsError(
            f"{scope}: код фона должен быть строкой f0N, а не {type(value).__name__}"
        )
    code = value.strip()
    if not code:
        raise ApplyOpsError(f"{scope}: нужен код фона f0N (например, f01)")
    if not SCENE_BACKGROUND_CODE_RE.match(code):
        raise ApplyOpsError(f"{scope}: код фона {code!r} не по формату f0N (например, f01)")
    return code


def normalize_background_card(raw: Any) -> dict[str, Any]:
    """Карточка фона из ответа агента → code/name/attrs по CONTRACT.md §3."""
    if not isinstance(raw, dict):
        raise ApplyOpsError("backgrounds: каждый элемент — объект")
    code = str(raw.get("id") or raw.get("code") or raw.get("код") or "").strip()
    if not code:
        raise ApplyOpsError("backgrounds: нужен id (f01…)")
    if not SCENE_BACKGROUND_CODE_RE.match(code):
        raise ApplyOpsError(
            f"backgrounds: код {code!r} не по формату f0N (например, f01)"
        )
    attrs = {key: str(raw.get(key) or "").strip() for key in BACKGROUND_ATTR_KEYS}
    if not attrs["место"]:
        raise ApplyOpsError(f"backgrounds: фон {code}: пустое «место»")
    return {"code": code, "name": attrs["место"], "attrs": attrs}


async def upsert_backgrounds(
    session: AsyncSession,
    project: Project,
    backgrounds: list[Any],
) -> int:
    """Записать/обновить ``Entity(type="background", code="f01"…)`` — CONTRACT.md §3.

    Один фон на локацию: повторный код обновляет attrs, второй сущности нет.
    Пустые поля новой карточки не стирают уже записанное. Вызывать после
    ``db_apply.apply_ops``; транзакцию завершает вызывающий.
    """
    from sqlalchemy.orm.attributes import flag_modified

    if not isinstance(backgrounds, list):
        raise ApplyOpsError("backgrounds: нужен список")
    if not backgrounds:
        return 0
    existing = list(
        (
            await session.execute(
                select(Entity).where(
                    Entity.project_id == project.id,
                    Entity.type == "background",
                )
            )
        ).scalars()
    )
    by_code = {str(e.code or "").strip(): e for e in existing if e.code}
    max_key = max((float(e.sort_key or 0) for e in existing), default=0.0)
    n = 0
    for raw in backgrounds:
        card = normalize_background_card(raw)
        code = card["code"]
        en = by_code.get(code)
        if en is None:
            max_key += 10.0
            en = Entity(
                project_id=project.id,
                type="background",
                code=code,
                name=card["name"],
                attrs=card["attrs"],
                sort_key=max_key,
            )
            session.add(en)
            by_code[code] = en
        else:
            en.name = card["name"] or en.name
            en.type = "background"
            old = dict(en.attrs) if isinstance(en.attrs, dict) else {}
            incoming = {k: v for k, v in card["attrs"].items() if str(v).strip()}
            en.attrs = {**old, **incoming}
            flag_modified(en, "attrs")
        n += 1
    await session.flush()
    return n


async def apply_scene_fields(
    session: AsyncSession,
    project: Project,
    ops: list[dict[str, Any]] | None,
) -> int:
    """Записать поля сцены в ``Frame.attrs``: ``речь`` и ``фон``.

    Формат op — как у apply-ops: ``{"frame_uuid": "<uuid сцены>",
    "fields": {"речь": {...}, "фон": "f01"}}``. Все поля и значения проходят
    валидацию до записи: неизвестный uuid/поле и неверная форма — отказ
    ``ApplyOpsError``. Вызывать после ``db_apply.apply_ops``; транзакцию
    завершает вызывающий.
    """
    raw_ops = list(ops or [])
    if not raw_ops:
        return 0
    frames = list(
        (await session.execute(select(Frame).where(Frame.project_id == project.id))).scalars()
    )
    by_uuid = {str(f.uuid): f for f in frames}
    updated = 0
    for op in raw_ops:
        if not isinstance(op, dict):
            raise ApplyOpsError("plan_cinema: op должен быть объектом")
        uuid = str(op.get("frame_uuid") or "").strip()
        if not uuid:
            raise ApplyOpsError("plan_cinema: для op нужен frame_uuid")
        fr = by_uuid.get(uuid)
        if fr is None:
            raise ApplyOpsError(f"plan_cinema: неизвестный frame_uuid {uuid!r}")
        fields = op.get("fields")
        if not isinstance(fields, dict) or not fields:
            raise ApplyOpsError(f"plan_cinema: кадр {uuid}: пустые fields")
        attrs = dict(fr.attrs) if isinstance(fr.attrs, dict) else {}
        written = 0
        for key, value in fields.items():
            name = str(key).strip().lower().replace(" ", "_")
            if name in SPEECH_FIELD_NAMES:
                attrs["речь"] = validate_scene_speech(
                    value, scope=f"кадр {uuid}: attrs.речь"
                )
            elif name in BACKGROUND_FIELD_NAMES:
                attrs["фон"] = normalize_scene_background_code(
                    value, scope=f"кадр {uuid}: attrs.фон"
                )
            else:
                allowed = sorted(SPEECH_FIELD_NAMES | BACKGROUND_FIELD_NAMES)
                raise ApplyOpsError(
                    f"plan_cinema: кадр {uuid}: неизвестное поле {key!r}; "
                    f"разрешены: {allowed}"
                )
            written += 1
        if not written:
            raise ApplyOpsError(f"plan_cinema: кадр {uuid}: пустые fields")
        fr.attrs = attrs
        updated += 1
    await session.flush()
    return updated


async def apply_plan_extras(
    session: AsyncSession,
    project: Project,
    *,
    backgrounds: list[Any] | None = None,
    ops: list[dict[str, Any]] | None = None,
) -> dict[str, int]:
    """Удобная обёртка для ноды: фоны, затем поля сцен. Транзакцию не коммитит.

    Порядок важен: ``Entity(background)`` пишется до ссылок сцен на ``f0N``,
    чтобы гейт R-BG-REF видел фон к моменту проверки.
    """
    result = {"backgrounds": 0, "scene_fields": 0}
    if backgrounds:
        result["backgrounds"] = await upsert_backgrounds(session, project, backgrounds)
    if ops:
        result["scene_fields"] = await apply_scene_fields(session, project, ops)
    return result


# ── Чтение реестров (source of truth — БД) ───────────────────────────────────


async def load_scenes(session: AsyncSession, project: Project) -> list[Frame]:
    """Сцены plan_cinema: ячейки Frame с ``attrs["источник"] == "pk"``.

    Сортировка — по ``Frame.number`` (порядок сцен детерминирован).
    """
    frames = list(
        (await session.execute(select(Frame).where(Frame.project_id == project.id))).scalars()
    )
    scenes = [
        f
        for f in frames
        if isinstance(f.attrs, dict)
        and str(f.attrs.get(SCENE_SOURCE_ATTR) or "").strip() == SCENE_SOURCE_MARK
    ]
    scenes.sort(key=lambda f: (int(getattr(f, "number", 0) or 0), int(getattr(f, "id", 0) or 0)))
    return scenes


async def load_characters(session: AsyncSession, project: Project) -> dict[str, dict[str, Any]]:
    """Реестр персонажей ``c01…`` из Entity(type="character").

    Архивные/инактивные (``db_v2.entity_is_archived``) не попадают. Карточка —
    ровно поля контракта §3 (costume/voice — если записаны в Entity.attrs).
    """
    from app.services.db_v2 import entity_is_archived

    rows = list(
        (
            await session.execute(
                select(Entity).where(
                    Entity.project_id == project.id, Entity.type == "character"
                )
            )
        ).scalars()
    )
    by_code: dict[str, dict[str, Any]] = {}
    for en in rows:
        code = str(en.code or "").strip()
        if not code or entity_is_archived(en):
            continue
        attrs = en.attrs if isinstance(en.attrs, dict) else {}
        by_code[code] = {
            "id": code,
            "имя": str(en.name or attrs.get("имя") or ""),
            "внешность": str(attrs.get("внешность") or attrs.get("look") or ""),
            "одежда": str(attrs.get("одежда") or attrs.get("clothes") or ""),
            "характер": str(attrs.get("характер") or attrs.get("char") or ""),
            "правила": str(attrs.get("правила") or attrs.get("rules") or ""),
            "voice_prompt": str(attrs.get("voice_prompt") or ""),
            "voice_id": str(attrs.get("voice_id") or ""),
        }
    return by_code


async def load_backgrounds(session: AsyncSession, project: Project) -> dict[str, dict[str, Any]]:
    """Реестр фонов ``f01…`` из Entity(type="background") — attrs по §3."""
    from app.services.db_v2 import entity_is_archived

    rows = list(
        (
            await session.execute(
                select(Entity).where(
                    Entity.project_id == project.id, Entity.type == "background"
                )
            )
        ).scalars()
    )
    by_code: dict[str, dict[str, Any]] = {}
    for en in rows:
        code = str(en.code or "").strip()
        if not code or entity_is_archived(en):
            continue
        attrs = en.attrs if isinstance(en.attrs, dict) else {}
        card = {"id": code, "место": str(attrs.get("место") or en.name or "")}
        for key in BACKGROUND_ATTR_KEYS:
            if key == "место":
                continue
            card[key] = str(attrs.get(key) or "")
        by_code[code] = card
    return by_code


# ── Запись: общий вход apply-ops и сущности ─────────────────────────────────


async def apply_plan_ops(
    session: AsyncSession,
    project: Project,
    payload: list[dict[str, Any]] | dict[str, Any] | None,
    *,
    export_xlsx: bool = False,
) -> dict[str, Any]:
    """Единая точка записи plan_cinema: обычный apply-ops + поля сцены.

    ``payload`` — список apply-ops, как у ``db_apply.apply_ops``::
        [{"frame_uuid": "<uuid сцены>", "fields": {"кадры": [...],
          "речь": {...}, "фон": "f01"}}]

    Поля кадра (``кадры``, промты, действие…) и старый закадр идут в обычный
    ``db_apply.apply_ops``; ``речь`` и ``фон`` вырезаются и пишутся поверх через
    ``apply_scene_fields`` — иначе исходный db_apply не знает этих ключей.
    Возвращает ``{"updated": n, "scene_fields": m, ...}`` (поля apply_ops
    сохраняются). Транзакцию не коммитит — это делает вызывающая нода.
    """
    from app.services import db_apply

    if isinstance(payload, dict):
        raw_ops = payload.get("ops")
        if raw_ops is None:
            raw_ops = [payload] if payload.get("frame_uuid") else []
    else:
        raw_ops = payload
    ops = list(raw_ops or [])

    core_ops: list[dict[str, Any]] = []
    scene_ops: list[dict[str, Any]] = []
    for op in ops:
        if not isinstance(op, dict):
            raise ApplyOpsError("plan_cinema: op должен быть объектом")
        fields = op.get("fields")
        if not isinstance(fields, dict):
            core_ops.append(op)
            continue
        scene_fields = {
            key: value
            for key, value in fields.items()
            if str(key).strip().lower().replace(" ", "_")
            in (SPEECH_FIELD_NAMES | BACKGROUND_FIELD_NAMES)
        }
        rest = {key: value for key, value in fields.items() if key not in scene_fields}
        if rest:
            core_ops.append({**op, "fields": rest})
        if scene_fields:
            scene_ops.append({"frame_uuid": op.get("frame_uuid"), "fields": scene_fields})

    result: dict[str, Any] = {}
    if core_ops:
        result = await db_apply.apply_ops(
            session, project, core_ops, export_xlsx=export_xlsx
        )
    scene_n = await apply_scene_fields(session, project, scene_ops)
    result["scene_fields"] = scene_n
    return result


async def write_entities(
    session: AsyncSession,
    project: Project,
    *,
    characters: list[dict[str, Any]] | None = None,
    backgrounds: list[dict[str, Any]] | None = None,
) -> dict[str, int]:
    """Записать реестры персонажей и фонов. Транзакцию не коммитит.

    Персонажи — через существующий ``db_apply.upsert_characters`` (не меняем
    исходник), фоны — через ``upsert_backgrounds`` (§3). Оба upsert по коду.
    """
    from app.services import db_apply

    result = {"characters": 0, "backgrounds": 0}
    if characters:
        result["characters"] = await db_apply.upsert_characters(
            session, project, list(characters)
        )
    if backgrounds:
        result["backgrounds"] = await upsert_backgrounds(
            session, project, list(backgrounds)
        )
    return result


async def write_scene_attrs(
    session: AsyncSession,
    project: Project,
    scene_uuid: str,
    attrs_patch: dict[str, Any],
) -> None:
    """Точечный патч ``Frame.attrs`` сцены (место, персонажи, предметы, событие…).

    Ключи речи и фона проходят валидацию; прочие пишутся как есть. Сцену
    ищем по uuid в проекте, чужой/несуществующий uuid — отказ. Транзакцию
    не коммитит.
    """
    uuid = str(scene_uuid or "").strip()
    if not uuid:
        raise ApplyOpsError("plan_cinema: нужен scene_uuid")
    if not isinstance(attrs_patch, dict) or not attrs_patch:
        raise ApplyOpsError(f"plan_cinema: сцена {uuid}: пустой attrs_patch")
    frames = list(
        (await session.execute(select(Frame).where(Frame.project_id == project.id))).scalars()
    )
    fr = next((f for f in frames if str(f.uuid) == uuid), None)
    if fr is None:
        raise ApplyOpsError(f"plan_cinema: неизвестный scene_uuid {uuid!r}")
    attrs = dict(fr.attrs) if isinstance(fr.attrs, dict) else {}
    for key, value in attrs_patch.items():
        name = str(key).strip().lower().replace(" ", "_")
        if name in SPEECH_FIELD_NAMES:
            attrs["речь"] = validate_scene_speech(value, scope=f"сцена {uuid}: attrs.речь")
        elif name in BACKGROUND_FIELD_NAMES:
            attrs["фон"] = normalize_scene_background_code(
                value, scope=f"сцена {uuid}: attrs.фон"
            )
        else:
            attrs[str(key)] = value
    fr.attrs = attrs
    await session.flush()


# ── Артефакты нод ───────────────────────────────────────────────────────────


def artifact_dir(project: Project, node_key: str) -> Path:
    """Папка артефактов ноды: ``<project.data_dir>/excel_gpt_uploads/<node_key>/``.

    Одно место с прежними excel_gpt-нодами (``excel_gpt_node.upload_dir``),
    чтобы цепочка и UI видели файл по тому же пути. ``node_key`` чистится от
    символов, запрещённых в путях Windows.
    """
    cleaned = "".join(
        "_" if ch in '<>:"/\\|?*' else ch for ch in str(node_key or "")
    ).strip(" .") or "node"
    return Path(project.data_dir) / "excel_gpt_uploads" / cleaned


def artifact_path(project: Project, node_key: str, name: str) -> Path:
    """Путь артефакта; ``name`` — только имя файла (без подкаталогов)."""
    safe = Path(str(name or "")).name
    if not safe:
        raise ApplyOpsError("plan_cinema: пустое имя артефакта")
    return artifact_dir(project, node_key) / safe


def save_artifact(project: Project, node_key: str, name: str, payload: Any) -> Path:
    """Сохранить JSON-артефакт ноды (создаёт папку). Возвращает путь."""
    path = artifact_path(project, node_key, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return path


def read_artifact(project: Project, node_key: str, name: str) -> Any | None:
    """Прочитать JSON-артефакт ноды; нет файла/битый JSON — ``None``."""
    path = artifact_path(project, node_key, name)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
