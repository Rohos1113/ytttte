"""Гейты группы «Кино по плану» (``plan_cinema``) — без закадрового текста.

CONTRACT.md §5. Модуль в старой механике ничего не меняет: здесь живут
проверки режима «без закадра», а существующие валидаторы (``shot_rules_v2``,
``scene_shot_grammar``, ``apply_ops_batches``, ``plan_scenes``) импортируются
как есть и вызываются в своём обычном режиме.

Что здесь:

* ``check_plan_coverage`` — ``R-PLAN-COVER`` (тонкая обёртка над
  ``app.services.plan_scenes.check_plan_coverage``: один источник правды).
* ``cast_duplicate_problems`` — ``R-CAST-DUP``: дубли персонажей после
  нормализации имени.
* ``dialog_problems`` — ``R-DLG-FORM`` + ``R-DLG-SPEAKER``: форма ``речь``
  и говорящие из реестра/сцены.
* ``background_ref_problems`` — ``R-BG-REF``: у сцены есть ``фон`` и он
  существует.
* ``shots_dialogue_problems_plan`` — ``R-DLG-SHOT`` через существующий
  ``shots_dialogue_problems`` из ``apply_ops_batches``.
* ``shots_gate_problems`` — механические нарушения кадров v2 при
  ``vo_mode=False``: VO-правила (R-VO-*) сняты, просодика кадра остаётся.

Режим «без закадра» выражен здесь, а не флагом в старых валидаторах: старые
модули вызываются только так, как задуманы, а VO-ветки в них просто не
запускаются (``vo_mode=False`` у механических правил означает «не передаём
сцены с VO и закадр в кадрах»).
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any

from app.services.plan_scenes import check_plan_coverage as _check_plan_coverage
from app.services.shot_rules_v2 import validate as _validate_shots_v2

#: Значения поля «тип» речи (CONTRACT.md §3).
SPEECH_TYPES: tuple[str, ...] = ("нет", "монолог", "диалог")
#: Максимум реплик в диалоге (CONTRACT.md §3).
SPEECH_MAX_REPLICAS = 6
#: Максимум слов в «эмоция» (CONTRACT.md §3: 1–3 слова).
SPEECH_EMOTION_MAX_WORDS = 3
#: Код персонажа / фона.
CHARACTER_CODE_RE = re.compile(r"^c\d{2,}$")
BACKGROUND_CODE_RE = re.compile(r"^f\d{2,}$")
#: Коды VO-правил v2 — в режиме «без закадра» не применяются (CONTRACT.md §5).
VO_CODES: frozenset[str] = frozenset(
    {
        "R-VO-SHORT",
        "R-VO-LONG",
        "R-VO-CUTAWAY",
        "R-VO-COVER",
        "R-VO-SCENE-LEN",
    }
)
#: Поле закадра в кадре: в новой цепочке его нет (CONTRACT.md §3).
VO_FIELD = "закадр"
#: Поле речи сцены.
SPEECH_FIELD = "речь"
#: Поле фона сцены.
BACKGROUND_FIELD = "фон"
#: Ключ режима сцены новой цепочки (CONTRACT.md §3).
SCENE_SOURCE_KEY = "источник"
SCENE_SOURCE_MARK = "pk"


# ---------------------------------------------------------------------------
# Утилиты
# ---------------------------------------------------------------------------


def _text(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split())


def _fold(value: Any) -> str:
    """Нормализация имени: регистр, ё, лишние пробелы и пунктуация."""
    raw = unicodedata.normalize("NFKC", str(value or ""))
    raw = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in raw)
    return " ".join(raw.split()).casefold().replace("ё", "е")


def _codes(values: Any) -> list[str]:
    """Коды из list[str], list[dict] (``код``/``code``/``id``) или строки."""
    if values is None:
        return []
    if isinstance(values, (str, Mapping)):
        values = [values]
    out: list[str] = []
    for item in values:
        raw = (
            (item.get("код") or item.get("code") or item.get("id"))
            if isinstance(item, Mapping)
            else item
        )
        code = _text(raw)
        if code and code not in out:
            out.append(code)
    return out


def _speech_raw(rech: Any) -> dict[str, Any] | None:
    """``речь`` сцены: dict или JSON-строка → dict, иначе None."""
    if isinstance(rech, str):
        try:
            rech = json.loads(rech)
        except (json.JSONDecodeError, TypeError):
            return None
    return dict(rech) if isinstance(rech, Mapping) else None


def _legacy_speech(speech: Mapping[str, Any]) -> dict[str, Any]:
    """Контрактная ``речь`` (§3) → формат старого гейта реплик: ``текст`` строкой.

    ``apply_ops_batches.shots_dialogue_problems`` читает старое поле ``текст``
    («кто: реплика — кто: реплика»), поэтому переводим, не меняя смысла.
    """
    replicas = [r for r in (speech.get("реплики") or []) if isinstance(r, Mapping)]
    text = " — ".join(
        f"{_text(r.get('кто'))}: {str(r.get('текст') or '').strip()}" for r in replicas
    )
    return {"тип": _text(speech.get("тип")), "текст": text}



# ---------------------------------------------------------------------------
# R-PLAN-COVER
# ---------------------------------------------------------------------------


def check_plan_coverage(
    points: Sequence[tuple[str, str] | str],
    scenes: Sequence[dict] | None,
) -> dict:
    """``R-PLAN-COVER``: каждый пункт плана покрыт сценой, ссылки не убывают.

    Тонкая обёртка над ``plan_scenes.check_plan_coverage`` — правила живут в
    одном месте, здесь только точка входа для диспетчера группы.

    :param points: пункты плана ``[(код, текст)]`` или ``[код]``.
    :param scenes: сцены ответа модели (``номер``, ``id_плана``, ...).
    :return: ``{"passed", "uncovered", "unknown", "errors", "scenes"}``.
    """
    return _check_plan_coverage(points, scenes)


# ---------------------------------------------------------------------------
# R-CAST-DUP
# ---------------------------------------------------------------------------


def cast_duplicate_problems(characters: Sequence[Mapping[str, Any]] | None) -> list[str]:
    """``R-CAST-DUP``: два персонажа с одинаковым именем после нормализации.

    Нормируется имя (``attrs.имя``/``имя``/``name``): регистр, ё, пунктуация.
    Вариации по контракту (``правила`` = id основы) дублем не считаются —
    у них имя отличается («Имя — отличие (вариация c01)»).
    """
    rows = [c for c in (characters or []) if isinstance(c, Mapping)]
    problems: list[str] = []
    seen: dict[str, list[tuple[str, str]]] = {}
    for pos, row in enumerate(rows, 1):
        attrs = row.get("attrs") if isinstance(row.get("attrs"), Mapping) else {}
        code = _text(row.get("code") or row.get("id") or attrs.get("code")) or f"#{pos}"
        name = _text(row.get("имя") or row.get("name") or attrs.get("имя"))
        key = _fold(name)
        if not key:
            problems.append(f"{code}: пустое имя персонажа")
            continue
        seen.setdefault(key, []).append((code, name))
    for _key, group in seen.items():
        if len(group) < 2:
            continue
        codes = [code for code, _ in group]
        problems.append(
            f"дубль персонажа «{group[0][1]}»: {', '.join(codes)} "
            "(имена совпадают после нормализации)"
        )
    return problems


# ---------------------------------------------------------------------------
# R-DLG-FORM + R-DLG-SPEAKER
# ---------------------------------------------------------------------------


def dialog_problems(
    rech: Any,
    scene_characters: Sequence[Any] | None = None,
    registry_codes: Sequence[Any] | None = None,
) -> list[str]:
    """``R-DLG-FORM`` + ``R-DLG-SPEAKER`` для одной сцены.

    Форма (CONTRACT.md §3): ``тип`` ∈ нет/монолог/диалог; ``нет`` → пустые
    реплики; ``монолог`` → ровно 1; ``диалог`` → 2–6 реплик и минимум два
    разных ``кто``; у реплики непустые ``кто``/``текст``, ``эмоция``
    необязательна (1–3 слова).

    Говорящие: ``кто`` из реестра и из ``персонажи`` этой сцены.

    :param rech: ``Frame.attrs["речь"]`` — dict или JSON-строка.
    :param scene_characters: ``персонажи`` сцены (коды ``c0N``).
    :param registry_codes: коды реестра персонажей.
    :return: список проблем; пустой список — форма и говорящие в порядке.
    """
    speech = _speech_raw(rech)
    if speech is None:
        return ["речь: не объект {\"тип\", \"реплики\"}"]

    problems: list[str] = []
    unknown_keys = [str(k) for k in speech if str(k) not in {"тип", "реплики"}]
    if unknown_keys:
        problems.append(f"речь: неизвестные поля {unknown_keys}")

    kind = _text(speech.get("тип"))
    raw_replicas = speech.get("реплики")
    if not isinstance(raw_replicas, list):
        problems.append("речь: «реплики» должны быть списком")
        replicas: list[Mapping[str, Any]] = []
    else:
        replicas = raw_replicas

    speakers: list[str] = []
    for idx, replica in enumerate(replicas, 1):
        if not isinstance(replica, Mapping):
            problems.append(f"реплика #{idx}: не объект")
            continue
        extra = [str(k) for k in replica if str(k) not in {"кто", "текст", "эмоция"}]
        if extra:
            problems.append(f"реплика #{idx}: неизвестные поля {extra}")
        who = _text(replica.get("кто"))
        text = str(replica.get("текст") or "").strip()
        emotion = _text(replica.get("эмоция"))
        if not who:
            problems.append(f"реплика #{idx}: пустой «кто»")
        if not text:
            problems.append(f"реплика #{idx}: пустой «текст»")
        if emotion and len(emotion.split()) > SPEECH_EMOTION_MAX_WORDS:
            problems.append(
                f"реплика #{idx}: «эмоция» длиннее {SPEECH_EMOTION_MAX_WORDS} слов"
            )
        if who:
            speakers.append(who)

    if kind not in SPEECH_TYPES:
        problems.append(f"речь: «тип» {kind!r} не из {list(SPEECH_TYPES)}")
    elif kind == "нет":
        if replicas:
            problems.append(f"речь: тип «нет» требует пустых реплик, пришло {len(replicas)}")
    elif kind == "монолог":
        if len(replicas) != 1:
            problems.append(f"речь: монолог — ровно 1 реплика, пришло {len(replicas)}")
    else:
        if not 2 <= len(replicas) <= SPEECH_MAX_REPLICAS:
            problems.append(
                f"речь: диалог — 2–{SPEECH_MAX_REPLICAS} реплик, пришло {len(replicas)}"
            )
        if len(set(speakers)) < 2:
            problems.append(
                f"речь: диалог требует минимум двух разных «кто», пришло {sorted(set(speakers))}"
            )

    # R-DLG-SPEAKER: кто из реестра и из персонажей этой сцены.
    scene_codes = set(_codes(scene_characters))
    registry = set(_codes(registry_codes)) if registry_codes is not None else None
    for who in speakers:
        if not CHARACTER_CODE_RE.match(who):
            problems.append(f"речь: «кто» {who!r} не код реестра c0N")
            continue
        if registry is not None and who not in registry:
            problems.append(f"речь: «кто» {who} нет в реестре персонажей")
        if scene_codes and who not in scene_codes:
            problems.append(
                f"речь: «кто» {who} нет в персонажах сцены {sorted(scene_codes)}"
            )
    return problems


# ---------------------------------------------------------------------------
# R-BG-REF
# ---------------------------------------------------------------------------


def background_ref_problems(
    scenes: Sequence[Any] | None,
    backgrounds: Sequence[Any] | None,
) -> list[str]:
    """``R-BG-REF``: у сцены есть ``фон`` и фон существует.

    :param scenes: сцены (dict с ``attrs``/полями или пары ``(код, attrs)``).
    :param backgrounds: фоны — список кодов ``f0N`` или карточек с ``code``.
    :return: список проблем.
    """
    known = set(_codes(backgrounds))
    problems: list[str] = []
    for pos, scene in enumerate(scenes or [], 1):
        if isinstance(scene, Mapping):
            attrs = scene.get("attrs") if isinstance(scene.get("attrs"), Mapping) else scene
            sid = _text(attrs.get("номер") or attrs.get("id") or attrs.get("код") or f"#{pos}")
            code = _text(attrs.get(BACKGROUND_FIELD))
        elif isinstance(scene, (tuple, list)) and len(scene) == 2:
            # (код сцены, attrs)
            sid = _text(scene[0]) or f"#{pos}"
            attrs = scene[1] if isinstance(scene[1], Mapping) else {}
            code = _text(attrs.get(BACKGROUND_FIELD))
        else:
            problems.append(f"сцена #{pos}: элемент не объект")
            continue
        if not code:
            problems.append(f"сцена {sid}: нет «фон» — нужен код f0N")
            continue
        if not BACKGROUND_CODE_RE.match(code):
            problems.append(f"сцена {sid}: «фон» {code!r} не код f0N")
            continue
        if known and code not in known:
            problems.append(f"сцена {sid}: фон {code} не существует")
    return problems


# ---------------------------------------------------------------------------
# R-DLG-SHOT
# ---------------------------------------------------------------------------


def shots_dialogue_problems_plan(shots: Sequence[Mapping[str, Any]] | None, rech: Any) -> list[str]:
    """``R-DLG-SHOT``: кадры реплик против речи сцены.

    Существующий ``apply_ops_batches.shots_dialogue_problems`` читает старое
    поле ``речь["текст"]``; контрактную ``речь`` (§3, список ``реплики``)
    переводим в этот формат и вызываем гейт как есть — правило реплик от
    закадра не зависит.
    """
    from app.services.apply_ops_batches import shots_dialogue_problems

    rows = [dict(shot) for shot in (shots or []) if isinstance(shot, Mapping)]
    speech = _speech_raw(rech)
    if speech is None:
        return ["речь: не объект {\"тип\", \"реплики\"}"]
    return list(shots_dialogue_problems(rows, _legacy_speech(speech)))


# ---------------------------------------------------------------------------
# Механика кадров v2 без VO
# ---------------------------------------------------------------------------


def shots_gate_problems(
    frames: Sequence[Mapping[str, Any]] | None,
    *,
    vo_mode: bool = False,
    registry: Mapping[str, Any] | None = None,
    style_block_len: int | None = None,
    style_marker: str | None = None,
    scenes: Sequence[Mapping[str, Any]] | None = None,
) -> list[str]:
    """Механические нарушения кадров v2 в режиме «без закадра».

    ``shots``/``frames`` — кадры по CONTRACT.md §3. В новом режиме у сцены нет
    VO, поэтому ``scenes`` для VO-правил не передаются: ``validate`` не может
    посчитать ни длину куска, ни покрытие, ни длину VO сцены — VO-правила не
    срабатывают. Сами VO-коды (``VO_CODES``) дополнительно отфильтрованы, а
    код ``R-PLACEHOLDER`` по полю ``закадр`` у такого кадра не возникает:
    поле в новой цепочке не пишется.

    :param frames: кадры сцены/проекта.
    :param vo_mode: ``False`` (по умолчанию в этой группе) — «без закадра»;
        ``True`` — пробросить сцены и проверить VO-правила как в старой цепочке.
    :param registry: ``{"персонажи": [...], "предметы": [...]}``.
    :param style_block_len: длина STYLE-блока (R-STYLE-LEN / тело промта).
    :param style_marker: маркер STYLE-блока (R-STYLE-DRIFT).
    :param scenes: сцены для VO-правил — используются только при ``vo_mode=True``.
    :return: список строк вида ``"{код} {кадр}: {detail}"``.
    """
    rows = [dict(shot) for shot in (frames or []) if isinstance(shot, Mapping)]
    scene_rows = (
        [dict(scene) for scene in (scenes or []) if isinstance(scene, Mapping)]
        if vo_mode
        else []
    )
    violations = _validate_shots_v2(
        scene_rows,
        rows,
        style_block_len=style_block_len,
        registry=dict(registry) if registry is not None else None,
        style_marker=style_marker,
    )
    out: list[str] = []
    for violation in violations:
        code = str(getattr(violation, "code", "") or "")
        if not vo_mode and code in VO_CODES:
            continue
        shot_id = str(getattr(violation, "shot_id", "") or "")
        scene_id = str(getattr(violation, "scene_id", "") or "")
        who = shot_id or scene_id or "-"
        detail = str(getattr(violation, "detail", "") or "")
        out.append(f"{code} {who}: {detail}" if detail else f"{code} {who}")
    return out


__all__ = [
    "BACKGROUND_CODE_RE",
    "BACKGROUND_FIELD",
    "CHARACTER_CODE_RE",
    "SCENE_SOURCE_KEY",
    "SCENE_SOURCE_MARK",
    "SPEECH_EMOTION_MAX_WORDS",
    "SPEECH_FIELD",
    "SPEECH_MAX_REPLICAS",
    "SPEECH_TYPES",
    "VO_CODES",
    "VO_FIELD",
    "background_ref_problems",
    "cast_duplicate_problems",
    "check_plan_coverage",
    "dialog_problems",
    "shots_dialogue_problems_plan",
    "shots_gate_problems",
]
