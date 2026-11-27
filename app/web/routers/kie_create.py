"""REST: генерации мультимедиа через kie.ai (универсальный каталог).

Модели/формы/валидация/цены — в app/services/kie_catalog.py.
Задания — в очередь через create_jobs (provider="kie"), результат — в
data/generations (глобальная Create-история; привязка к проектам — «В проект»).
"""

from __future__ import annotations

import base64
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from loguru import logger

from app.bots import kie_http, pay52_video
from app.services import kie_catalog
from app.services.create_jobs import enqueue_generation, get_job
from app.settings import settings

router = APIRouter(prefix="/kie-create", tags=["kie-create"])

_EXT_BY_RESULT = {"video": ".mp4", "image": ".png", "audio": ".mp3", "text": ".txt"}
_MEDIA_BY_RESULT = {"video": "video", "image": "image", "audio": "audio", "text": "audio"}


def _echo_catalog_family_id(quote: dict[str, Any], model_id: str) -> dict[str, Any]:
    """family_id в ответе = id каталога, который прислал клиент.

    У части семейств id карточки /catalog отличается от docs-id (старое имя
    студии с суффиксом режима: hailuo-2-3-i2v, seedance-1-5-pro, ...). UI сверяет
    ответ с kieModel.id, поэтому эхом отдаём то, что пришло в model_id.
    """
    if quote.get("family_id") is not None and model_id:
        quote["family_id"] = model_id
    return quote


@router.get("/catalog")
async def get_catalog() -> dict[str, Any]:
    """Каталог + формы + значения по умолчанию — всё для picker-модели."""
    from app.bots.elevenlabs_api import elevenlabs_api_configured

    return {
        **kie_catalog.catalog_for_ui(),
        # Флаг готовности важен до первого вызова /generate.
        "configured": kie_http.kie_configured(),
        "elevenlabs_configured": elevenlabs_api_configured(),
        "pay52_configured": pay52_video.pay52_configured(),
    }


@router.get("/credits")
async def get_credits() -> dict[str, Any]:
    from app.services.studio_auth import current_is_admin

    if not current_is_admin():
        return {
            "configured": kie_http.kie_configured(),
            "credits": None,
            "usd": None,
        }
    credits = await kie_http.get_credits()
    return {
        "configured": kie_http.kie_configured(),
        "credits": credits,
        "usd": round(credits * kie_catalog.CREDIT_USD, 2) if credits is not None else None,
    }


@router.post("/estimate")
async def post_estimate(body: dict[str, Any]) -> dict[str, Any]:
    """Оценка цены без вызова kie: {model_id, mode?, values} → $ (kie / клиент +25%)."""
    body = body or {}
    model_id = str(body.get("model_id") or "").strip()
    mode_id = str(body.get("mode") or "").strip()
    values = body.get("values") or {}
    if not isinstance(values, dict):
        raise HTTPException(status_code=400, detail="values must be object")
    if mode_id:
        # Семья/режим: цена в USD с наценкой студии.
        family = kie_catalog.get_family(model_id)
        mode = kie_catalog.get_mode(family, mode_id) if family is not None else None
        if family is None or mode is None:
            raise HTTPException(status_code=404, detail=f"unknown model_id/mode {model_id!r}/{mode_id!r}")
        quote = kie_catalog.estimate_usd(family, mode, values)
        quote["errors"] = kie_catalog.validate_mode_values(family, mode, values)
        return _echo_catalog_family_id(quote, model_id)
    spec = kie_catalog.get_model(model_id)
    if spec is not None:
        return kie_catalog.estimate_credits(spec, values)
    family = kie_catalog.get_family(model_id)
    if family is None:
        raise HTTPException(status_code=404, detail="unknown model_id")
    mode = kie_catalog.get_mode(family)
    if mode is None:
        raise HTTPException(status_code=404, detail=f"model {model_id!r} без режимов")
    quote = kie_catalog.estimate_usd(family, mode, values)
    quote["errors"] = kie_catalog.validate_mode_values(family, mode, values)
    return _echo_catalog_family_id(quote, model_id)


@router.post("/upload")
async def post_upload(file: UploadFile = File(...)) -> dict[str, Any]:  # noqa: B008
    """Загрузка файла → публичный URL kie (рефы image/video/audio генераций)."""
    if not kie_http.kie_configured():
        raise HTTPException(status_code=503, detail="kie API не настроен (KIE_API_KEY)")
    content = await file.read()
    if not content or len(content) < 16:
        raise HTTPException(status_code=400, detail="пустой файл")
    if len(content) > 200 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="файл > 200 МБ")
    name = Path(file.filename or "file.bin").name
    name = re.sub(r"[^\w.\-]+", "_", name)[:80] or "file.bin"
    url = await kie_http.upload_file(content, name)
    return {"url": url, "filename": name, "bytes": len(content)}


def _find_text(obj: Any) -> str:
    if isinstance(obj, dict):
        for k, v in obj.items():
            if str(k).lower() in ("lyrics", "text", "content", "lyric") and isinstance(v, str) and v.strip():
                return v
        for v in obj.values():
            found = _find_text(v)
            if found:
                return found
    elif isinstance(obj, list):
        for it in obj:
            found = _find_text(it)
            if found:
                return found
    return ""


async def _ensure_kie_asset_url(val: Any, filename_prefix: str = "asset") -> Any:
    """Если значение — data: URL или локальный файл, загружает его в KIE и возвращает публичный URL."""
    if isinstance(val, list):
        res = []
        for item in val:
            res.append(await _ensure_kie_asset_url(item, filename_prefix=filename_prefix))
        return res
    if not isinstance(val, str):
        return val
    s = val.strip()
    if not s or s.startswith(("http://", "https://", "asset://")):
        return val

    # 1. Base64 data: URL
    if s.startswith("data:"):
        header, _, b64_data = s.partition(",")
        if not b64_data:
            return val
        mime = "image/png"
        if ":" in header and ";" in header:
            mime = header.split(":")[1].split(";")[0].strip()
        ext = ".png"
        if "jpeg" in mime or "jpg" in mime:
            ext = ".jpg"
        elif "webp" in mime:
            ext = ".webp"
        elif "gif" in mime:
            ext = ".gif"
        elif "mp4" in mime:
            ext = ".mp4"
        elif "mp3" in mime or "mpeg" in mime:
            ext = ".mp3"
        elif "wav" in mime:
            ext = ".wav"
        try:
            content = base64.b64decode(b64_data)
        except Exception as e:
            logger.warning("kie_create: failed to decode base64: {}", e)
            return val
        filename = f"{filename_prefix}_{uuid.uuid4().hex[:8]}{ext}"
        try:
            uploaded_url = await kie_http.upload_file(content, filename=filename)
            logger.info("kie_create: auto-uploaded data URL to {}", uploaded_url)
            return uploaded_url
        except Exception as e:
            logger.error("kie_create: upload_file failed for data URL: {}", e)
            raise HTTPException(status_code=502, detail=f"Не удалось загрузить файл в KIE: {e}") from e

    # 2. Локальный путь (/api/files?path=... или путь на диске)
    local_path: Path | None = None
    if s.startswith("/api/files?path="):
        try:
            parsed = urlparse(s)
            qp = parse_qs(parsed.query).get("path")
            if qp and qp[0]:
                p = Path(qp[0])
                if p.is_file():
                    local_path = p
        except Exception:
            pass
    elif s.startswith("/api/generations/"):
        rel = s.replace("/api/generations/", "")
        p = Path("data/generations") / rel
        if p.is_file():
            local_path = p
    else:
        p = Path(s)
        if p.is_file():
            local_path = p
        else:
            p2 = Path(settings.data_dir) / s
            if p2.is_file():
                local_path = p2

    if local_path and local_path.is_file():
        content = local_path.read_bytes()
        filename = f"{filename_prefix}_{local_path.name}"
        try:
            uploaded_url = await kie_http.upload_file(content, filename=filename)
            logger.info("kie_create: auto-uploaded local file {} to {}", local_path, uploaded_url)
            return uploaded_url
        except Exception as e:
            logger.error("kie_create: upload_file failed for local file {}: {}", local_path, e)
            raise HTTPException(status_code=502, detail=f"Не удалось загрузить файл в KIE: {e}") from e

    return val


@router.post("/generate")
async def post_generate(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    """Генерация: {model_id (семья), mode (режим), values} либо старый {model_id, values}.

    Без mode работает прежний каталог (legacy-записи); с mode — семья/режим,
    цена в долларах с наценкой 25%, payload под api режима.
    """
    model_id = str((body or {}).get("model_id") or "").strip()
    mode_id = str((body or {}).get("mode") or "").strip()
    values = (body or {}).get("values") or {}
    if not isinstance(values, dict):
        raise HTTPException(status_code=400, detail="values must be object")

    family: dict[str, Any] | None = None
    mode: dict[str, Any] | None = None
    family = kie_catalog.get_family(model_id)

    # Автоопределение режима для семейств с автодетектом (MiniMax H3)
    if family is not None and str(family.get("id")) == "minimax-h3":
        has_refs = bool(
            values.get("reference_image_urls")
            or values.get("reference_video_urls")
            or values.get("reference_audio_urls")
            or "@image_" in str(values.get("prompt") or "")
        )
        has_frame = bool(
            values.get("first_frame_url")
            or values.get("last_frame_url")
            or values.get("image_url")
            or values.get("image_urls")
        )
        if has_refs:
            mode_id = "r2v"
        elif has_frame:
            mode_id = "i2v"
            if not values.get("first_frame_url"):
                img = values.get("image_url") or values.get("image_urls")
                if img:
                    values["first_frame_url"] = img[0] if isinstance(img, list) else img
        elif not mode_id:
            mode_id = "t2v"

    if mode_id:
        if family is None:
            family = kie_catalog.get_family(model_id)
        mode = kie_catalog.get_mode(family, mode_id) if family is not None else None
        if family is None or mode is None:
            raise HTTPException(
                status_code=404, detail=f"unknown model_id/mode {model_id!r}/{mode_id!r}"
            )
        spec = kie_catalog.mode_spec(family, mode)
    else:
        legacy_spec = kie_catalog.get_model(model_id)
        if legacy_spec is None:
            family = kie_catalog.get_family(model_id)
            mode = kie_catalog.get_mode(family) if family is not None else None
            if family is None or mode is None:
                raise HTTPException(status_code=404, detail=f"unknown model_id {model_id!r}")
            spec = kie_catalog.mode_spec(family, mode)
        else:
            spec = legacy_spec

    # Автоматически загружаем data: URL и локальные файлы в KIE CDN до валидации каталога
    fields_spec = {f["name"]: f for f in (spec.get("fields") or [])}
    for k, v in list(values.items()):
        f_spec = fields_spec.get(k)
        is_file_field = (
            (f_spec and f_spec.get("kind") in kie_catalog._FILE_KINDS)
            or "image" in k.lower()
            or "frame" in k.lower()
            or "file" in k.lower()
            or "url" in k.lower()
        )
        if is_file_field and v:
            values[k] = await _ensure_kie_asset_url(v, filename_prefix=k)

    if family is not None and mode is not None:
        errors = kie_catalog.validate_mode_values(family, mode, values)
    else:
        errors = kie_catalog.validate_values(spec, values)
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors[:6]))
    result_kind = str(spec.get("result") or "video")
    is_elevenlabs = spec.get("api") == "elevenlabs" or spec.get("id") == "elevenlabs-v4"
    from app.bots import pay52_image
    is_pay52_image = bool(
        result_kind == "image" and pay52_image.pay52_image_configured(spec)
    )
    is_pay52_video = bool(
        result_kind == "video"
        and pay52_video.pay52_video_configured(spec)
    )
    is_pay52 = spec.get("api") == "pay52" or is_pay52_video or is_pay52_image
    if is_elevenlabs:
        from app.bots.elevenlabs_api import elevenlabs_api_configured
        if not elevenlabs_api_configured():
            raise HTTPException(
                status_code=503,
                detail="ElevenLabs API не настроен (задайте ELEVENLABS_API_KEY)",
            )
    elif not is_pay52 and not kie_http.kie_configured():
        if is_pay52_video or is_pay52_image:
            is_pay52 = True
        else:
            raise HTTPException(status_code=503, detail="API не настроен (KIE_API_KEY / PAY52_*_KEY)")
    elif is_pay52 and not is_pay52_video and not is_pay52_image and not kie_http.kie_configured():
        raise HTTPException(status_code=503, detail="API не настроен (KIE_API_KEY / PAY52_*_KEY)")

    payload = kie_catalog.build_payload(spec, values)
    if family is not None and mode is not None:
        quote = kie_catalog.estimate_usd(family, mode, values)
    else:
        quote = kie_catalog.estimate_credits(spec, values)
    result_kind = str(spec.get("result") or "video")
    media = _MEDIA_BY_RESULT.get(result_kind, "video")
    ext = _EXT_BY_RESULT.get(result_kind, ".mp4")
    prompt = str(values.get("prompt") or values.get("text") or "")[:10000]

    from app.db import session_scope
    from app.services import credit_ledger as cl
    from app.services.credits import price_micro
    from app.services.studio_auth import current_is_admin
    from app.services.tenant import current_tenant

    tenant = current_tenant()
    is_admin = current_is_admin()
    cost_usd = float(quote.get("usd") or 0.0)
    credits_num = float(quote.get("credits") or 0.0)
    hold_amount_micro = int(round(credits_num * 1_000_000))
    if hold_amount_micro <= 0:
        hold_amount_micro = price_micro(cost_usd)
    # Проект из запроса (вкладка «Генерация» его пока не шлёт — тогда adhoc):
    # холд без проекта не находится при сверке «кто потратил».
    try:
        project_id = int((body or {}).get("project_id") or 0)
    except (TypeError, ValueError):
        project_id = 0
    hold_id: str | None = None

    if tenant and not is_admin:
        async with session_scope() as session:
            try:
                hold = await cl.open_hold(
                    session,
                    tenant,
                    project_id=project_id,
                    step_code=f"kie_{media}",
                    amount_micro=hold_amount_micro,
                )
                hold_id = hold.id
            except cl.InsufficientCredits as exc:
                raise HTTPException(
                    status_code=402,
                    detail=f"Недостаточно кредитов: {exc}",
                ) from exc

    if is_elevenlabs:
        provider_name = "elevenlabs"
        provider_label = "ElevenLabs"
    elif is_pay52:
        provider_name = "pay52"
        provider_label = "52pay"
    else:
        provider_name = "kie"
        provider_label = "KIE"
    # Какая запись журнала соответствует результату и в каких единицах платим.
    pricing_unit = str(quote.get("unit") or "gen")
    if result_kind == "video":
        ledger_kind = "video"
        ledger_unit = "second"
        ledger_units = float(quote.get("multiplier") or 1.0) if pricing_unit == "sec" else 1.0
    elif result_kind == "image":
        ledger_kind, ledger_unit, ledger_units = "image", "item", 1.0
    elif result_kind == "audio":
        if pricing_unit == "1k_chars":
            voiced = str(values.get("text") or values.get("prompt") or "")
            ledger_kind, ledger_unit, ledger_units = "audio", "char", float(max(1, len(voiced)))
        else:
            ledger_kind, ledger_unit, ledger_units = "audio", "track", 1.0
    else:
        ledger_kind, ledger_unit, ledger_units = "text", "item", 1.0
    fact_model = str(spec.get("id") or model_id)
    memo = f"{provider_label} генерация {media} ({spec['label']})"

    async def run(out_path: Path):
        from app.services.create_billing import charge_hold_by_fact
        from app.services.media_ledger import capture_rows, media_call

        try:
            # Факт пишем здесь: kie_http.run_generation / pay52_video /
            # elevenlabs_api — это транспорт без учёта, и «Генерация» зовёт их
            # напрямую. capture_rows собирает id ровно этих строк, чтобы
            # списать по факту, а не по оценке каталога.
            with capture_rows() as rows:
                async with media_call(
                    provider_name,
                    ledger_kind,
                    model=fact_model,
                    units=ledger_units,
                    unit=ledger_unit,
                    project_id=project_id or None,
                ) as call:
                    if is_elevenlabs:
                        from app.bots.elevenlabs_api import (
                            ElevenLabsApi,
                        )
                        text_val = str(values.get("text") or values.get("prompt") or "")
                        voice_id_val = str(values.get("voice_id") or values.get("voice") or "").strip() or None
                        stab_val = values.get("stability")
                        sim_val = values.get("similarity")
                        spec_model = str(spec.get("model") or "").strip()
                        tts_model = (
                            "eleven_v4"
                            if "v4" in spec_model or spec.get("id") == "elevenlabs-v4"
                            else (spec_model or "eleven_v4")
                        )
                        api_obj = ElevenLabsApi()
                        generated_file = await api_obj.tts(
                            text=text_val,
                            out_path=out_path,
                            voice_id=voice_id_val,
                            model_id=tts_model,
                            project_id=project_id or None,
                            stability=float(stab_val) if stab_val is not None else None,
                            similarity=float(sim_val) if sim_val is not None else None,
                        )
                        from app.bots.outsee import GenerationResult
                        res = GenerationResult(
                            file_path=generated_file,
                            gen_id=f"el-{uuid.uuid4().hex[:10]}",
                            raw_url=None,
                        )
                    elif is_pay52:
                        if result_kind == "image":
                            res = await pay52_image.run_generation(spec, values, out_path)
                        else:
                            res = await pay52_video.run_generation(spec, payload, out_path)
                    elif result_kind == "text":
                        task_id = await kie_http.create_task(
                            str(spec.get("api")), spec.get("endpoint"), payload
                        )
                        data = await kie_http.poll_task(str(spec.get("api")), task_id)
                        text = _find_text(data) or str(data)[:4000]
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        out_path.write_text(text, encoding="utf-8")
                        from app.bots.outsee import GenerationResult

                        res = GenerationResult(file_path=out_path, gen_id=task_id, raw_url=None)
                    else:
                        try:
                            res = await kie_http.run_generation(spec, payload, out_path)
                        except Exception as e_kie:
                            if result_kind == "image" and pay52_image.pay52_image_configured(spec):
                                logger.warning(
                                    "kie_create: KIE generation failed ({}), falling back to 52pay: {}",
                                    type(e_kie).__name__,
                                    e_kie,
                                )
                                call.provider = "pay52"
                                res = await pay52_image.run_generation(spec, values, out_path)
                            elif result_kind != "image" and pay52_video.pay52_video_configured(spec):
                                logger.warning(
                                    "kie_create: KIE generation failed ({}), falling back to 52pay: {}",
                                    type(e_kie).__name__,
                                    e_kie,
                                )
                                call.provider = "pay52"
                                res = await pay52_video.run_generation(spec, payload, out_path)
                            else:
                                raise
                    gid = getattr(res, "gen_id", None)
                    stem_id = out_path.stem
                    if gid:
                        call.external_id = f"{gid}|{stem_id}"
                    else:
                        call.external_id = stem_id

            if hold_id:
                async with session_scope() as session:
                    await charge_hold_by_fact(
                        session,
                        hold_id,
                        rows,
                        est_usd=cost_usd,
                        memo=memo,
                    )
            return res
        except BaseException:
            if hold_id:
                try:
                    async with session_scope() as session:
                        await cl.release_hold(session, hold_id, memo=f"Сбой/отмена {provider_label} генерации {media}")
                except Exception as e_hold:
                    logger.warning("kie_create: ошибка release_hold {}: {}", hold_id, e_hold)
            raise

    job_provider = provider_name
    client_id = request.headers.get("x-client-id") or request.query_params.get("client_id")
    job_model_display = (
        str(family.get("label") or family.get("name") or family.get("id") or spec.get("label") or "")
        if family
        else str(spec.get("label") or "")
    )
    job = await enqueue_generation(
        media=media,
        model=job_model_display,
        provider=job_provider,
        prompt=prompt,
        ext=ext,
        params={
            "model_id": model_id,
            "mode": mode_id or None,
            "kie_id": str(spec.get("id") or ""),
            "values": values,
            "project_id": project_id or None,
        },
        quote={
            "credits": quote.get("credits") or 0.0,
            "usd": quote.get("usd") or 0.0,
            "usd_client": quote.get("usd_client"),
            "note": quote.get("note") or "",
        },
        run=run,
        hold_id=hold_id,
        client_id=client_id,
    )
    logger.info(
        "kie-create: generate {} / {} ({}) → job {} (~{} кр. / ${})",
        model_id,
        mode_id or "legacy",
        spec["label"],
        job.id,
        quote.get("credits"),
        quote.get("usd"),
    )
    return {"job": job.to_dict(), "estimate": _echo_catalog_family_id(quote, model_id)}


@router.get("/jobs/{job_id}")
async def kie_job_status(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    if job is None:
        return {"job_id": job_id, "status": "unknown", "ok": False}
    return job.to_dict()
