"""Генератор app/services/kie_catalog_families.py из docs/*.json.

Вход:
  docs/kie-model-families.json — семьи/режимы (шаг 7 аналитика);
  docs/kie-prices-usd.json     — цены в USD по kie_id (шаг 12, необязателен:
                                 если его нет, цены берутся из кредитов в
                                 kie-model-families.json и переводятся в $).

Выход: app/services/kie_catalog_families.py — FAMILIES: list[dict], где у
каждого режима pricing в ДОЛЛАРАХ:
  {"unit", "markup": 1.25, "usd_rules": [{"when", "usd_kie", "usd_client"}],
   "usd_default_kie", "usd_default_client", "note", "formula"}

Скрипт воспроизводимый: одинаковый вход → одинаковый выход (без времени,
без случайных ключей). Запускать из корня репозитория:
  python scripts/gen_kie_families.py           # собрать модуль
  python scripts/gen_kie_families.py --check   # только проверить счётчики
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FAMILIES_SRC = ROOT / "docs" / "kie-model-families.json"
PRICES_SRC = ROOT / "docs" / "kie-prices-usd.json"
OUT = ROOT / "app" / "services" / "kie_catalog_families.py"

MARKUP = 1.25
CREDIT_USD = 0.005

# Служебные суффиксы, которые аналитик мог оставить в id (в id режима они не нужны).
_FIELD_KIND_MAP = {
    "image": "images",
    "images": "images",
    "video": "videos",
    "videos": "videos",
    "audio": "audios",
    "audios": "audios",
    "file": "file",
    "url": "text",
    "string": "text",
    "bool": "toggle",
    "boolean": "toggle",
    "int": "number",
    "integer": "number",
    "float": "number",
    "enum": "select",
    "dropdown": "select",
}

# Ключи правил when: приватные спец-ключи движка пишем с подчёркиванием.
_WHEN_ALIASES = {
    "with_video": "_has_videos",
    "has_video": "_has_videos",
    "video_input": "_has_videos",
    "input_video": "_has_videos",
    "with_images": "_has_images",
    "has_image": "_has_images",
    "image_input": "_has_images",
}


def _load_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"gen_kie_families: битый JSON {path}: {exc}", file=sys.stderr)
        return None


def _as_family_list(doc: Any) -> list[dict[str, Any]]:
    """Вытащить список семейств из любой обёртки, которую мог отдать аналитик."""
    if doc is None:
        return []
    if isinstance(doc, list):
        return [f for f in doc if isinstance(f, dict)]
    if isinstance(doc, dict):
        for key in ("families", "items", "data", "result", "model_families"):
            val = doc.get(key)
            if isinstance(val, list):
                return [f for f in val if isinstance(f, dict)]
            if isinstance(val, dict):
                out = []
                for k, v in val.items():
                    if isinstance(v, dict):
                        v = {**v}
                        v.setdefault("id", k)
                        out.append(v)
                if out:
                    return out
    return []


def _as_price_map(doc: Any) -> dict[str, dict[str, Any]]:
    """Индекс цен по kie_id: список, dict по kie_id, dict-обёртка."""
    if doc is None:
        return {}
    items: list[dict[str, Any]] = []
    if isinstance(doc, list):
        items = [x for x in doc if isinstance(x, dict)]
    elif isinstance(doc, dict):
        for key in ("models", "prices", "items", "data", "kie_models"):
            val = doc.get(key)
            if isinstance(val, list):
                items = [x for x in val if isinstance(x, dict)]
                break
            if isinstance(val, dict):
                items = []
                for k, v in val.items():
                    if isinstance(v, dict):
                        v = {**v}
                        v.setdefault("kie_id", k)
                        items.append(v)
                break
        else:
            # Плоский dict kie_id -> запись цены
            if doc and all(isinstance(v, dict) for v in doc.values()):
                items = []
                for k, v in doc.items():
                    v = {**v}
                    v.setdefault("kie_id", k)
                    items.append(v)
    out: dict[str, dict[str, Any]] = {}
    for item in items:
        kid = str(item.get("kie_id") or item.get("id") or "").strip()
        if kid:
            out[kid] = item
    return out


def _norm_number(val: Any) -> float | None:
    try:
        num = float(val)
    except (TypeError, ValueError):
        return None
    return num


def _first_number(*vals: Any) -> float | None:
    for val in vals:
        num = _norm_number(val)
        if num is not None:
            return num
    return None


def _norm_when(when: Any) -> dict[str, Any]:
    if not isinstance(when, dict):
        return {}
    out: dict[str, Any] = {}
    for key, val in when.items():
        k = str(key).strip()
        alias = _WHEN_ALIASES.get(k.lower())
        if alias:
            # bool-флаги важны оба: with_video=false — это тоже условие цены
            out[alias] = val if isinstance(val, bool) else str(val)
            continue
        out[k] = val
    return out


def _rule_usd(when: dict[str, Any], usd_kie: Any, usd_client: Any) -> dict[str, Any] | None:
    kie = _norm_number(usd_kie)
    client = _norm_number(usd_client)
    if kie is None and client is None:
        return None
    if kie is None and client is not None:
        kie = client / MARKUP
    if client is None and kie is not None:
        client = kie * MARKUP
    rule: dict[str, Any] = {"when": when}
    rule["usd_kie"] = round(float(kie), 6) if kie is not None else None
    rule["usd_client"] = round(float(client), 4) if client is not None else None
    return rule


_UNIT_ALIASES = {
    "1m_tokens": "tokens",
    "tokens": "tokens",
    "token": "tokens",
    "mp": "megapixel",
    "megapixel": "megapixel",
    "megapixels": "megapixel",
    "sec": "sec",
    "second": "sec",
    "seconds": "sec",
    "gen": "gen",
    "image": "image",
    "images": "image",
    "1k_chars": "1k_chars",
}


def _norm_unit(raw: Any) -> str:
    unit = str(raw or "").strip().lower()
    return _UNIT_ALIASES.get(unit, unit or "unknown")


def _pricing_from_price(rec: dict[str, Any]) -> dict[str, Any]:
    """Запись docs/kie-prices-usd.json → pricing режима."""
    unit = _norm_unit(rec.get("unit"))
    rules: list[dict[str, Any]] = []
    raw_rules = rec.get("usd_rules") or rec.get("rules") or []
    if isinstance(raw_rules, dict):
        raw_rules = [raw_rules]
    for raw in raw_rules:
        if not isinstance(raw, dict):
            continue
        rule = _rule_usd(
            _norm_when(raw.get("when")),
            raw.get("usd_kie"),
            raw.get("usd_client"),
        )
        if rule is not None:
            rules.append(rule)
    default_kie = _first_number(
        rec.get("usd_default_kie"),
        rec.get("default_usd_kie"),
        rec.get("default_kie"),
    )
    default_client = _first_number(
        rec.get("usd_default_client"),
        rec.get("default_usd_client"),
        rec.get("default_client"),
    )
    if default_kie is None and default_client is not None:
        default_kie = default_client / MARKUP
    if default_client is None and default_kie is not None:
        default_client = default_kie * MARKUP
    extra_charges: list[dict[str, Any]] = []
    for raw in rec.get("extra_charges") or []:
        if not isinstance(raw, dict):
            continue
        per = str(raw.get("per") or "")
        usd_kie = _norm_number(raw.get("usd_kie"))
        usd_client = _norm_number(raw.get("usd_client"))
        if usd_kie is None and usd_client is not None:
            usd_kie = usd_client / MARKUP
        if usd_client is None and usd_kie is not None:
            usd_client = usd_kie * MARKUP
        if usd_kie is None or usd_client is None:
            continue
        extra_charges.append(
            {
                "what": str(raw.get("what") or ""),
                "per": per,
                "free_first": int(raw.get("free_first") or raw.get("free_count") or 0),
                "usd_kie": round(float(usd_kie), 6),
                "usd_client": round(float(usd_client), 4),
            }
        )
    return {
        "unit": unit,
        "markup": MARKUP,
        "usd_rules": rules,
        "usd_default_kie": round(float(default_kie), 6) if default_kie is not None else None,
        "usd_default_client": round(float(default_client), 4) if default_client is not None else None,
        "extra_charges": extra_charges,
        "note": str(rec.get("note") or ""),
        "formula": str(rec.get("formula") or ""),
        "affects_price": [str(x) for x in (rec.get("affects_price") or [])],
        "source": str(rec.get("source") or ""),
    }


def _pricing_from_credits(pricing: Any) -> dict[str, Any] | None:
    """Fallback: pricing режима из kie-model-families.json (кредиты) → USD."""
    if not isinstance(pricing, dict):
        return None
    unit = _norm_unit(pricing.get("unit"))
    rules: list[dict[str, Any]] = []
    for raw in pricing.get("rules") or []:
        if not isinstance(raw, dict):
            continue
        credits = _norm_number(raw.get("credits", raw.get("default")))
        if credits is None:
            continue
        rule = _rule_usd(
            _norm_when(raw.get("when")),
            credits * CREDIT_USD,
            credits * CREDIT_USD * MARKUP,
        )
        if rule is not None:
            rules.append(rule)
    default_credits = _norm_number(pricing.get("default", pricing.get("credits")))
    default_kie = default_credits * CREDIT_USD if default_credits is not None else None
    if default_kie is None and rules:
        default_kie = rules[0]["usd_kie"]
    return {
        "unit": unit,
        "markup": MARKUP,
        "usd_rules": rules,
        "usd_default_kie": round(float(default_kie), 6) if default_kie is not None else None,
        "usd_default_client": round(float(default_kie) * MARKUP, 4) if default_kie is not None else None,
        "note": str(pricing.get("note") or ""),
        "formula": "",
    }


def _unknown_pricing() -> dict[str, Any]:
    return {
        "unit": "unknown",
        "markup": MARKUP,
        "usd_rules": [],
        "usd_default_kie": None,
        "usd_default_client": None,
        "note": "неизвестно",
        "formula": "",
    }


def _norm_options(raw: Any) -> list[str]:
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[str] = []
    for opt in raw:
        if isinstance(opt, dict):
            val = opt.get("value", opt.get("id", opt.get("label", opt.get("name"))))
        else:
            val = opt
        if val is None:
            continue
        text = str(val)
        if text not in out:
            out.append(text)
    return out


def _norm_field(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or raw.get("key") or "").strip()
    if not name:
        return None
    kind = str(raw.get("kind") or raw.get("type") or "text").strip().lower()
    kind = _FIELD_KIND_MAP.get(kind, kind)
    field: dict[str, Any] = {
        "name": name,
        "label": str(raw.get("label") or raw.get("title") or name),
        "kind": kind,
        "required": bool(raw.get("required", False)),
    }
    if "default" in raw:
        field["default"] = raw["default"]
    options = _norm_options(raw.get("options") or raw.get("values") or raw.get("enum"))
    if options:
        field["options"] = options
        if kind not in ("select",):
            field["kind"] = "select"
    for num_key in ("min", "max", "step", "max_len"):
        num = _norm_number(raw.get(num_key))
        if num is not None:
            field[num_key] = int(num) if float(num).is_integer() else num
    max_items = _norm_number(raw.get("max_items", raw.get("maxFiles")))
    if max_items is not None:
        field["max_items"] = int(max_items)
    hint = str(raw.get("hint") or raw.get("desc") or raw.get("description") or "")
    if hint:
        field["hint"] = hint
        field["desc"] = hint
    show_if = raw.get("show_if") or raw.get("showIf")
    if isinstance(show_if, dict) and show_if:
        field["show_if"] = show_if
    omit_values = raw.get("omit_values")
    if isinstance(omit_values, list) and omit_values:
        field["omit_values"] = omit_values
    if raw.get("omit_from_payload"):
        field["omit_from_payload"] = True
    return field


def _mode_media(task_type: str, family_media: str) -> str:
    if family_media in ("video", "image"):
        return family_media
    low = task_type.lower()
    if "image" in low or "text-to-image" in low:
        return "image"
    return "video"


def _norm_mode(raw: Any, family_media: str, prices: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kie_id = str(raw.get("kie_id") or raw.get("model") or "").strip()
    if not kie_id:
        return None
    mode_id = str(raw.get("id") or raw.get("mode") or kie_id).strip()
    task_type = str(raw.get("task_type") or raw.get("taskType") or "")
    fields_raw = raw.get("fields") or []
    fields: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for rf in fields_raw:
        field = _norm_field(rf)
        if field is None or field["name"] in seen_names:
            continue
        seen_names.add(field["name"])
        fields.append(field)
    pricing = None
    if kie_id in prices:
        pricing = _pricing_from_price(prices[kie_id])
    if pricing is None:
        pricing = _pricing_from_credits(raw.get("pricing"))
    if pricing is None:
        pricing = _unknown_pricing()
    constraints = raw.get("constraints") or []
    if isinstance(constraints, str):
        constraints = [constraints]
    endpoint = raw.get("endpoint") or raw.get("path")
    mode: dict[str, Any] = {
        "id": mode_id,
        "label": str(raw.get("label") or raw.get("title") or mode_id),
        "kie_id": kie_id,
        "task_type": task_type,
        "api": str(raw.get("api") or ("jobs" if _mode_media(task_type, family_media) else "jobs")),
        "media": _mode_media(task_type, family_media),
        "fields": fields,
        "pricing": pricing,
        "constraints": [str(c) for c in constraints],
    }
    if endpoint:
        mode["endpoint"] = str(endpoint)
    docs_url = raw.get("docs_url") or raw.get("docs")
    if docs_url:
        mode["docs_url"] = str(docs_url)
    hint = raw.get("hint")
    if hint:
        mode["hint"] = str(hint)
    return mode


def _norm_family(raw: dict[str, Any], prices: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    fid = str(raw.get("id") or raw.get("family_id") or "").strip()
    if not fid:
        return None
    media_raw = str(raw.get("media") or raw.get("type") or "").strip().lower()
    media = "image" if media_raw in ("image", "images", "img") else "video"
    modes_raw = raw.get("modes") or []
    modes: list[dict[str, Any]] = []
    for rm in modes_raw:
        mode = _norm_mode(rm, media, prices)
        if mode is not None:
            modes.append(mode)
    # режимы без явных kie_id могли лежать отдельными полями
    if not modes:
        single = _norm_mode({**raw, "id": "default"}, media, prices)
        if single is not None:
            modes = [single]
    if not modes:
        return None
    default_mode = str(raw.get("default_mode") or "")
    mode_ids = {m["id"] for m in modes}
    if default_mode not in mode_ids:
        default_mode = modes[0]["id"]
    return {
        "id": fid,
        "label": str(raw.get("label") or raw.get("title") or fid),
        "brand": str(raw.get("brand") or raw.get("provider") or ""),
        "media": media,
        "desc": str(raw.get("desc") or raw.get("description") or ""),
        "default_mode": default_mode,
        "modes": modes,
    }


def build(prices_doc: Any, families_doc: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    prices = _as_price_map(prices_doc)
    families: list[dict[str, Any]] = []
    seen_families: set[str] = set()
    for raw in _as_family_list(families_doc):
        family = _norm_family(raw, prices)
        if family is None or family["id"] in seen_families:
            continue
        seen_families.add(family["id"])
        families.append(family)
    # Покрытие kie_id: дубли — ошибка контракта, оставляем первый.
    seen_kie: dict[str, str] = {}
    dups: list[dict[str, str]] = []
    for family in families:
        for mode in family["modes"]:
            kid = mode["kie_id"]
            if kid in seen_kie:
                dups.append({"kie_id": kid, "kept": seen_kie[kid], "dup": f"{family['id']}/{mode['id']}"})
                continue
            seen_kie[kid] = f"{family['id']}/{mode['id']}"
    missing_prices = [
        f"{f['id']}/{m['id']}:{m['kie_id']}"
        for f in families
        for m in f["modes"]
        if m["pricing"].get("usd_default_kie") is None and not m["pricing"].get("usd_rules")
    ]
    stats = {
        "families": len(families),
        "modes": sum(len(f["modes"]) for f in families),
        "kie_ids": len(seen_kie),
        "dups": dups,
        "missing_prices": missing_prices,
        "price_file": PRICES_SRC.is_file(),
    }
    return families, stats


def render(families: list[dict[str, Any]]) -> str:
    # pprint даёт валидный Python-литерал (True/False/None), а не JSON.
    import pprint

    body = pprint.pformat(families, width=110, sort_dicts=False)
    return (
        '"""Семьи и режимы медиа-моделей kie.ai (СГЕНЕРИРОВАНО, не править руками).\n'
        "\n"
        "Источник: docs/kie-model-families.json (семьи/режимы) +\n"
        "docs/kie-prices-usd.json (цены в USD). Пересобрать:\n"
        "    python scripts/gen_kie_families.py\n"
        "\n"
        "У каждого режима pricing в ДОЛЛАРАХ:\n"
        '  {"unit", "markup": 1.25, "usd_rules": [...],\n'
        '   "usd_default_kie", "usd_default_client", "note", "formula"}\n'
        '"""\n'
        "\n"
        "from __future__ import annotations\n"
        "\n"
        "from typing import Any\n"
        "\n"
        "MARKUP = 1.25\n"
        "\n"
        "FAMILIES: list[dict[str, Any]] = "
        + body
        + "\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Сгенерировать kie_catalog_families.py")
    parser.add_argument("--check", action="store_true", help="только проверить счётчики, файл не писать")
    parser.add_argument("--quiet", action="store_true", help="не печатать сводку")
    args = parser.parse_args(argv)

    families_doc = _load_json(FAMILIES_SRC)
    prices_doc = _load_json(PRICES_SRC)
    if families_doc is None:
        print(
            f"gen_kie_families: нет {FAMILIES_SRC} — модуль будет собран пустым "
            "(ждите шаг 7)",
            file=sys.stderr,
        )
    families, stats = build(prices_doc, families_doc)
    if stats["dups"]:
        print(f"gen_kie_families: ДУБЛИ kie_id ({len(stats['dups'])}):", file=sys.stderr)
        for dup in stats["dups"][:20]:
            print(f"  {dup['kie_id']}: {dup['kept']} vs {dup['dup']}", file=sys.stderr)
    if not args.quiet:
        print(
            "gen_kie_families: семейств {families}, режимов {modes}, kie_id {kie_ids}, "
            "без цены {missing}, прайс {price_file}".format(
                families=stats["families"],
                modes=stats["modes"],
                kie_ids=stats["kie_ids"],
                missing=len(stats["missing_prices"]),
                price_file=stats["price_file"],
            )
        )
    if args.check:
        return 1 if stats["dups"] else 0
    OUT.write_text(render(families), encoding="utf-8")
    if not args.quiet:
        print(f"gen_kie_families: записан {OUT.relative_to(ROOT)}")
    return 1 if stats["dups"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
