/**
 * Строки пикера kie.ai: одна карточка = одна модель (семейство).
 *
 * Режимы семейства (t2i / i2i / t2v / i2v, Pro / Flash / Lite) — не отдельные
 * карточки: иначе «Seedance 2.0 · Fast» и «Seedance 2.0 · Mini» выглядят как
 * разные модели, хотя это одна. Режим выбирается чипами в доке (`switchKieMode`),
 * а карточка несёт первый режим семейства, чтобы было что подсветить и с чего
 * начать.
 *
 * Слаг строки: `kie:<family>~<mode>`. `kie:<family>` без режима валиден
 * (старые плоские записи каталога и сохранённые настройки).
 */

import type { KieModeSpec, KieModelSpec } from "./api";
import { estimateSettingsUsd, familyPriceFromUsd } from "./model-settings.ts";

/** Разделитель режима в слаге пикера. */
export const KIE_MODE_SEP = "~";

/**
 * Семейства, полностью скрытые из меню выбора модели (решение владельца):
 * картинки — Kie (апскейл), Topaz, Suno (обложка), Recraft, OmniHuman, Ideogram;
 * видео — обе модели Alibaba (HappyHorse / HappyHorse 1.1).
 * Каталог и пайплайн их не теряют: скрытие только витрины пикера.
 */
const HIDDEN_FAMILY_IDS = new Set([
  "kie-image-upscale",
  "kie-video-upscale",
  "topaz-image-upscale",
  "suno-cover",
  "recraft",
  "omnihuman-1-5-image",
  "ideogram-v3",
  "happyhorse",
  "happyhorse-1-1",
  "nano-banana-pro",
]);

/** Семейство скрыто из меню выбора модели. */
export function isFamilyHidden(familyId: string): boolean {
  return HIDDEN_FAMILY_IDS.has(String(familyId || "").trim());
}

/** Слаг строки пикера: семейство + режим (режим необязателен у плоских записей). */
export function kieRowSlug(familyId: string, modeId?: string | null): string {
  const clean = String(familyId || "").replace(/^kie:/, "");
  const mode = String(modeId || "").trim();
  return mode ? `kie:${clean}${KIE_MODE_SEP}${mode}` : `kie:${clean}`;
}

/**
 * Разбор слага пикера: { familyId, modeId }. Не-KIE слаги (пресеты outsee)
 * дают null — их вызов разбирает остальной код.
 */
export function parseKieSlug(slug: string): { familyId: string; modeId: string | null } | null {
  const raw = String(slug || "");
  if (!raw.startsWith("kie:")) return null;
  const body = raw.slice(4);
  const at = body.indexOf(KIE_MODE_SEP);
  if (at < 0) return { familyId: body, modeId: null };
  const familyId = body.slice(0, at);
  const modeId = body.slice(at + 1);
  if (!familyId) return null;
  return { familyId, modeId: modeId || null };
}

/** Строка пикера: всё, что нужно карточке модели, без иконок и бренд-правил. */
export type KiePickerRow = {
  slug: string;
  familyId: string;
  modeId: string | null;
  label: string;
  desc: string | null;
  priceUsd: number | null;
  pricePending: boolean;
  /** «топ» — только у первой строки семейства, чтобы бейдж не размножался. */
  isTop: boolean;
  modeSummary: string | null;
  brandName: string | null;
  media: string | null;
};

/** В какой тип пикера попадает семейство (медиа из каталога, иначе по result). */
export function mediaOfModel(model: KieModelSpec): string {
  return (
    model.media ??
    (model.result === "video" ? "video" : model.result === "image" ? "image" : model.result)
  );
}

function modePrice(
  model: KieModelSpec,
  mode: KieModeSpec,
  creditUsd: number,
  markup?: number,
): { usd: number | null; pending: boolean } {
  // Каталог отдаёт цену режима отдельно — она точнее цены семейства.
  const from = (mode as { price_from_usd?: number }).price_from_usd;
  if (typeof from === "number" && Number.isFinite(from) && from >= 0) {
    return { usd: from, pending: false };
  }
  const est = estimateSettingsUsd({ model, modeId: mode.id, creditUsd, markup });
  if (est.source === "pending" || est.usd_client == null) {
    const familyUsd = familyPriceFromUsd({ model, creditUsd, markup });
    return { usd: familyUsd, pending: familyUsd == null };
  }
  return { usd: est.usd_client, pending: false };
}

function modeMatchesQuery(model: KieModelSpec, mode: KieModeSpec, q: string): boolean {
  const hay = `${mode.label || ""} ${mode.task_type || ""} ${mode.kie_id || ""} ${mode.id}`;
  return hay.toLowerCase().includes(q);
}

/** Тип задачи режима по-русски — вторая строка строки пикера. */
const TASK_RU: Record<string, string> = {
  "Text to Image": "текст → картинка",
  "Image to Image": "картинка → картинка",
  "Image Editing": "редактирование картинки",
  "Text to Video": "текст → видео",
  "Image to Video": "картинка → видео",
  "Video to Video": "видео → видео",
  "Video Editing": "редактирование видео",
  "Reference to Video": "референс → видео",
  "Lip Sync": "липсинк",
};

/** «Text to Image, Image to Video» → «текст → картинка / картинка → видео». */
export function taskTypeRu(task?: string | null): string | null {
  const raw = String(task || "").trim();
  if (!raw) return null;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => TASK_RU[p] ?? p.toLowerCase());
  const uniq = [...new Set(parts)];
  return uniq.length ? uniq.join(" / ") : null;
}

function familyMatchesQuery(model: KieModelSpec, q: string): boolean {
  const hay = `${model.label || ""} ${model.desc || ""} ${model.hint || ""} ${model.id}`;
  return hay.toLowerCase().includes(q);
}

/** Направления режима по отдельности — для сводки без дублей. */
function taskTokens(task?: string | null): string[] {
  return String(task || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => TASK_RU[p] ?? p.toLowerCase());
}

/**
 * Вторая строка карточки: какие способы генерации есть у модели.
 * «Text to Video, Image to Video» → «текст → видео · картинка → видео».
 */
function modesSummary(model: KieModelSpec, modes: KieModeSpec[]): string | null {
  const tasks = [...new Set(modes.flatMap((m) => taskTokens(m.task_type)))];
  if (tasks.length) return tasks.join(" · ");
  const labels = [
    ...new Set(modes.map((m) => String(m.label || m.id || "").trim()).filter(Boolean)),
  ];
  if (labels.length) return labels.slice(0, 3).join(" · ");
  return model.hint || model.desc || null;
}

/**
 * Строка одного семейства. Одна модель — одна карточка: режимы (Pro / Flash,
 * текст / картинка → видео) свёрнуты в неё, а не разложены отдельными строками.
 * Семейство без режимов (старые плоские записи) даёт строку `kie:<family>`.
 */
export function familyPickerRows(
  model: KieModelSpec,
  opts: { creditUsd?: number; markup?: number; query?: string } = {},
): KiePickerRow[] {
  const creditUsd = opts.creditUsd ?? 0.005;
  const q = (opts.query ?? "").trim().toLowerCase();
  if (isFamilyHidden(model.id)) return [];
  const modes = (model.modes ?? []).filter((m) => Boolean(m && m.id));
  const brandName = model.brand ?? null;
  const hitFamily = !q || familyMatchesQuery(model, q);

  if (!modes.length) {
    const usd = familyPriceFromUsd({ model, creditUsd, markup: opts.markup });
    return [
      {
        slug: kieRowSlug(model.id),
        familyId: model.id,
        modeId: null,
        label: model.label,
        desc: model.hint || model.desc || null,
        priceUsd: usd,
        pricePending: usd == null,
        isTop: Boolean(model.is_top || model.isTop),
        modeSummary: null,
        brandName,
        media: mediaOfModel(model),
      },
    ];
  }

  // Поиск по режиму («flash») тоже должен найти модель — но строкой семьи.
  const matched = hitFamily ? modes : modes.filter((m) => modeMatchesQuery(model, m, q));
  if (!matched.length) return [];

  // Цена карточки — самый дешёвый режим: «от $X», как в плоском списке.
  let cheapest: number | null = null;
  let pending = false;
  for (const mode of matched) {
    const price = modePrice(model, mode, creditUsd, opts.markup);
    if (price.usd != null) {
      cheapest = cheapest == null ? price.usd : Math.min(cheapest, price.usd);
    } else if (price.pending) {
      pending = true;
    }
  }

  const first = matched[0];
  const single = modes.length === 1;
  return [
    {
      slug: kieRowSlug(model.id, first.id),
      familyId: model.id,
      modeId: first.id,
      label: model.label,
      // Один режим — подписью режима (он и есть модель); несколько — перечень
      // способов генерации, чтобы было видно, что это одна модель.
      desc: single ? first.label || model.hint || model.desc || null : modesSummary(model, modes),
      priceUsd: cheapest,
      pricePending: cheapest == null && pending,
      isTop: Boolean(model.is_top || model.isTop),
      modeSummary: single
        ? first.label || null
        : modes.map((m) => String(m.label || m.id || "").trim()).filter(Boolean).join(" · "),
      brandName,
      media: mediaOfModel(model),
    },
  ];
}

/**
 * Список строк вкладки: одна карточка на семейство. Порядок — как в каталоге.
 */
export function pickerRowsForMedia(
  models: KieModelSpec[],
  media: string,
  opts: { creditUsd?: number; markup?: number; query?: string } = {},
): KiePickerRow[] {
  const out: KiePickerRow[] = [];
  for (const model of models) {
    if (mediaOfModel(model) !== media) continue;
    out.push(...familyPickerRows(model, opts));
  }
  return out;
}
