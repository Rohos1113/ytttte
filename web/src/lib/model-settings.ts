/**
 * Чистая логика общего окна настроек Create (как у Seedance, но для всех моделей)
 * и режимов семейства kie.ai.
 *
 * Док «Генерация» рисует одни и те же чипы и одну панель «Параметры» для любой
 * модели; разница между моделями — только список дескрипторов полей. Здесь
 * строятся эти дескрипторы: из KieField[] (каталог KIE) и из конфигурации
 * чипов outsee (aspect / resolution / detail / duration / audio).
 *
 * Второй слой — режимы семейства: одна карточка в меню (семейство) может нести
 * несколько режимов, у каждого свои поля и цена. Здесь же выбирается активный
 * режим и считается цена в долларах с наценкой студии 25%.
 *
 * Никакого React и побочных эффектов: всё детерминировано, поэтому покрыто
 * юнит-тестами в `model-settings.test.ts`.
 */

import type { KieField, KieModeSpec, KieModelSpec } from "./api";

/** Наценка студии на цену kie.ai: клиент платит usd_kie × 1.25. */
export const STUDIO_MARKUP = 1.25;

/** Как рисовать контрол в панели «Параметры». */
export type ModelSettingKind =
  | "select"
  | "toggle"
  | "number"
  | "duration"
  | "text"
  | "voice"
  | "range";

/** Иконка чипа (маппинг в lucide — на стороне UI). */
export type ModelSettingIcon =
  | "aspect"
  | "resolution"
  | "duration"
  | "sound"
  | "voice"
  | "number"
  | "text"
  | "toggle"
  | "range"
  | "select";

export type ModelSettingOption = {
  id: string;
  label: string;
  hint?: string;
};

export type ModelSettingDescriptor = {
  /** Имя поля модели — ключ значения в values. */
  name: string;
  /** Значение data-chip в доке (у Seedance: aspect/resolution/duration/sound). */
  chip: string;
  label: string;
  /** Заголовок секции в панели «Параметры». */
  section: string;
  kind: ModelSettingKind;
  options?: ModelSettingOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Дефолт модели: и для показа, и для «Сбросить». */
  defaultValue?: unknown;
  hint?: string;
  icon: ModelSettingIcon;
  /** Суффикс значения («5s» / «5с»). */
  suffix?: string;
  /** В каком виде значение уходит в onChange. */
  valueType?: "number" | "string" | "boolean";
};

export type ModelSettingValues = Record<string, unknown>;

/** Значение поля: сохранённое, иначе дефолт модели (null/undefined — дефолт). */
export function modelSettingValue(
  descriptor: ModelSettingDescriptor,
  values: ModelSettingValues,
): unknown {
  const raw = values[descriptor.name];
  return raw === undefined || raw === null ? descriptor.defaultValue : raw;
}

/** Тумблер включён? «true»/1/true считаются включёнными. */
export function settingIsOn(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  return String(value).toLowerCase() === "true";
}

/** Текст на чипе параметра. */
export function formatSettingChip(
  descriptor: ModelSettingDescriptor,
  values: ModelSettingValues,
): string {
  const value = modelSettingValue(descriptor, values);
  if (descriptor.kind === "toggle") {
    const on = settingIsOn(value);
    if (descriptor.icon === "sound") return on ? "Звук вкл" : "Звук выкл";
    return `${descriptor.label}: ${on ? "вкл" : "выкл"}`;
  }
  if (descriptor.kind === "duration") {
    const num = Number(value);
    return Number.isFinite(num) ? `${num}${descriptor.suffix ?? ""}` : descriptor.label;
  }
  if (descriptor.kind === "select") {
    const id = String(value ?? "");
    const hit = descriptor.options?.find((o) => o.id === id);
    return hit ? hit.label : id || "—";
  }
  if (descriptor.kind === "voice") {
    return String(value ?? "") || "Голос";
  }
  if (descriptor.kind === "range") {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(2) : descriptor.label;
  }
  const text = String(value ?? "").trim();
  if (!text) return descriptor.label;
  const short = text.length > 18 ? `${text.slice(0, 17)}…` : text;
  return `${descriptor.label}: ${short}`;
}

/** Пары «поле → дефолт модели» для кнопки «Сбросить». */
export function settingDefaultPairs(
  descriptors: ModelSettingDescriptor[],
): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const d of descriptors) {
    if (d.defaultValue !== undefined) out.push([d.name, d.defaultValue]);
  }
  return out;
}

/** Числа длительности: из options, иначе диапазон min..max (1..60, как в доке). */
export function durationNumbers(descriptor: ModelSettingDescriptor): number[] {
  if (descriptor.options?.length) {
    const nums = descriptor.options
      .map((o) => Number(o.id))
      .filter((n) => Number.isFinite(n));
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  const lo = Math.max(1, Math.round(Number(descriptor.min ?? 1)));
  const rawHi = Number(descriptor.max ?? 15);
  const hi = Math.min(60, Math.max(lo, Math.round(Number.isFinite(rawHi) ? rawHi : 15)));
  const out: number[] = [];
  for (let n = lo; n <= hi; n += 1) out.push(n);
  return out;
}

// ---------------------------------------------------------------------------
// KIE: дескрипторы из KieField[]
// ---------------------------------------------------------------------------

/** Поля-файлы рисуют плитки референсов, а не чипы настроек. */
const KIE_FILE_KINDS = new Set(["images", "videos", "audios"]);

/** Служебные поля, которые в доке Create не показываем (формат отдаёт бэкенд, отладочные флаги). */
const KIE_SKIP_NAMES = new Set([
  "output_format",
  "format",
  "nsfw_checker",
  "web_search",
  "return_last_frame",
  "draft",
  "draft_task_id",
  "omni_reference_task_type",
  "background",
  "seed",
  "watermark",
  "thinking_mode",
  "color_palette",
  "bbox_list",
  "enhance_prompt",
  "expand_prompt",
  "prompt_extend",
  "prompt_upsampling",
  "negative_prompt",
  "enable_sequential",
  "n",
  "num_images",
  "max_images",
  "width",
  "height",
  "multi_shots",
  "prefer_multi_shots",
  "customize_multi_shots",
  "multi_prompt",
  "elements",
  "kling_elements",
  "enable_translation",
  "upload_cn",
  "safety_tolerance",
  "text_recognition",
]);

const KIE_VOICE_FIELDS = new Set(["voice_id", "voice"]);
const KIE_RANGE_DEFAULTS: Record<string, number> = { stability: 0.5, similarity: 0.75 };

/** data-chip для полей, которые рисует общая панель Seedance-стиля. */
const KIE_CHIP_ALIAS: Record<string, string> = {
  aspect_ratio: "aspect",
  generate_audio: "sound",
};

const KIE_SECTION: Record<string, string> = {
  aspect_ratio: "Соотношение сторон",
  resolution: "Разрешение",
  duration: "Длительность",
  generate_audio: "Звук",
};

/** Видимость поля по show_if: то же сравнение, что было в чипах KIE. */
export function isKieFieldVisible(
  field: KieField,
  values: ModelSettingValues = {},
): boolean {
  if (!field.show_if) return true;
  return Object.entries(field.show_if).every(([key, want]) => {
    const got = values[key];
    if (typeof want === "boolean") return settingIsOn(got) === want;
    return String(got ?? "") === String(want);
  });
}

/**
 * Подписи опций KIE. Спец-случаи повторяют прежние чипы:
 * quality → 1K/2K/Standard/Pro, vocalGender → мужской/женский/любой.
 */
export function kieOptionMeta(
  fieldName: string,
  option: string,
): { label: string; hint?: string } {
  const name = fieldName.toLowerCase();
  const opt = option.toLowerCase();
  if (name === "quality") {
    if (opt === "low") return { label: "Low" };
    if (opt === "medium") return { label: "Medium" };
    if (opt === "high") return { label: "High" };
    if (opt === "basic" || opt === "1k") return { label: "1K" };
    if (opt === "2k" || opt === "ultra") return { label: "2K" };
    if (opt === "1.5k") return { label: "1.5K" };
    if (opt === "std" || opt === "standard") return { label: "Standard", hint: "720p" };
    if (opt === "pro") return { label: "Pro", hint: "1080p" };
    if (opt === "xhigh") return { label: "X-High" };
    if (opt === "max") return { label: "Max" };
  }
  if (name === "size" || name === "image_size") {
    if (opt === "1k") return { label: "1K" };
    if (opt === "1.5k") return { label: "1.5K" };
    if (opt === "2k") return { label: "2K" };
    if (opt === "4k") return { label: "4K" };
  }
  if (name === "vocalgender") {
    if (opt === "m") return { label: "Мужской вокал", hint: "Мужской тембр" };
    if (opt === "f") return { label: "Женский вокал", hint: "Женский тембр" };
    return { label: "Вокал: Любой", hint: "Без предпочтений" };
  }
  if (name === "output_format" || name === "format") {
    return { label: option.toUpperCase() };
  }
  return { label: option || "—" };
}

function kieFieldDescriptor(field: KieField): ModelSettingDescriptor | null {
  const name = field.name;
  const base: ModelSettingDescriptor = {
    name,
    chip: KIE_CHIP_ALIAS[name] ?? name,
    label: field.label || name,
    section: KIE_SECTION[name] ?? (field.label || name),
    kind: "text",
    icon: "text",
    hint: field.desc,
    defaultValue: field.default,
  };

  if (KIE_VOICE_FIELDS.has(name)) {
    return { ...base, kind: "voice", icon: "voice", label: field.label || "Голос" };
  }

  if (name === "stability" || name === "similarity") {
    return {
      ...base,
      kind: "range",
      icon: "range",
      min: field.min ?? 0,
      max: field.max ?? 1,
      step: field.step ?? 0.01,
      defaultValue: field.default ?? KIE_RANGE_DEFAULTS[name],
    };
  }

  if (name === "duration") {
    const fromOptions = (field.options ?? [])
      .map((o) => Number(o))
      .filter((n) => Number.isFinite(n));
    const numbers = fromOptions.length
      ? [...new Set(fromOptions)].sort((a, b) => a - b)
      : durationNumbers({ ...base, min: field.min, max: field.max });
    if (!numbers.length) return null;
    return {
      ...base,
      kind: "duration",
      icon: "duration",
      suffix: "s",
      valueType: "number",
      min: numbers[0],
      max: numbers[numbers.length - 1],
      options: numbers.map((n) => ({ id: String(n), label: String(n) })),
    };
  }

  if (field.kind === "toggle") {
    return {
      ...base,
      kind: "toggle",
      icon: name === "generate_audio" ? "sound" : "toggle",
      valueType: "boolean",
    };
  }

  if (field.kind === "select") {
    const options = (field.options ?? []).map((o) => ({ id: o, ...kieOptionMeta(name, o) }));
    if (!options.length) return null;
    return { ...base, kind: "select", icon: "select", options };
  }

  if (field.kind === "number") {
    return {
      ...base,
      kind: "number",
      icon: "number",
      min: field.min,
      max: field.max,
      step: field.step ?? 1,
      valueType: "number",
    };
  }

  return { ...base, kind: "text", icon: "text", valueType: "string" };
}

/**
 * Дескрипторы настроек KIE-модели: без полей-файлов, главного текстового поля
 * (оно живёт в textarea промта), служебного формата и скрытых show_if полей.
 */
export function kieSettingDescriptors(
  fields: KieField[],
  options: { values?: ModelSettingValues; mainTextField?: string | null } = {},
): ModelSettingDescriptor[] {
  const values = options.values ?? {};
  const mainTextField = options.mainTextField ?? null;
  const out: ModelSettingDescriptor[] = [];
  for (const field of fields) {
    if (KIE_FILE_KINDS.has(field.kind)) continue;
    if (KIE_SKIP_NAMES.has(field.name)) continue;
    if (mainTextField && field.name === mainTextField) continue;
    if (!isKieFieldVisible(field, values)) continue;
    const descriptor = kieFieldDescriptor(field);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outsee: дескрипторы из конфигурации чипов
// ---------------------------------------------------------------------------

export type OutseeSettingName = "aspect" | "resolution" | "detail" | "duration" | "audio";

export type OutseeSettingsInput = {
  /** dockChipsForModel(...) — какие чипы есть у модели. */
  chips: string[];
  /** chip → опции (chipOptions); detail — уровни с подписями. */
  options: Partial<Record<OutseeSettingName, ModelSettingOption[]>>;
  /** Дефолты модели — для показа до первого изменения и для «Сбросить». */
  defaults?: Partial<Record<OutseeSettingName, unknown>>;
};

/**
 * Дескрипторы outsee-пресетов. Поля-файлы (image-input) и отдельные
 * переключатели (orientation / quality / instrumental) в док не попадают —
 * они остаются своими элементами в строке генерации.
 */
export function outseeSettingDescriptors(
  input: OutseeSettingsInput,
): ModelSettingDescriptor[] {
  const chips = new Set(input.chips);
  const defaults = input.defaults ?? {};
  const out: ModelSettingDescriptor[] = [];

  if (chips.has("aspect")) {
    const options = input.options.aspect ?? [];
    if (options.length) {
      out.push({
        name: "aspect",
        chip: "aspect",
        label: "Соотношение сторон",
        section: "Соотношение сторон",
        kind: "select",
        icon: "aspect",
        options,
        defaultValue: defaults.aspect,
        valueType: "string",
      });
    }
  }

  if (chips.has("resolution")) {
    const options = input.options.resolution ?? [];
    if (options.length) {
      out.push({
        name: "resolution",
        chip: "resolution",
        label: "Разрешение",
        section: "Разрешение",
        kind: "select",
        icon: "resolution",
        options,
        defaultValue: defaults.resolution,
        valueType: "string",
      });
    }
  }

  if (chips.has("detail")) {
    const options = input.options.detail ?? [];
    if (options.length) {
      out.push({
        name: "detail",
        chip: "detail",
        label: "Детализация",
        section: "Детализация",
        kind: "select",
        icon: "select",
        options,
        defaultValue: defaults.detail,
        valueType: "string",
      });
    }
  }

  if (chips.has("duration")) {
    const options = input.options.duration ?? [];
    const nums = options
      .map((o) => Number(o.id))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (nums.length) {
      out.push({
        name: "duration",
        chip: "duration",
        label: "Длительность",
        section: "Длительность",
        kind: "duration",
        icon: "duration",
        suffix: "с",
        valueType: "string",
        min: nums[0],
        max: nums[nums.length - 1],
        options: nums.map((n) => ({ id: String(n), label: `${n}с` })),
        defaultValue: defaults.duration,
      });
    }
  }

  if (chips.has("audio")) {
    out.push({
      name: "audio",
      chip: "audio",
      label: "Звук",
      section: "Звук",
      kind: "toggle",
      icon: "sound",
      valueType: "boolean",
      defaultValue: defaults.audio,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Режимы семейства kie.ai
// ---------------------------------------------------------------------------

/**
 * Режимы модели: пусто у старых плоских записей каталога (33 штуки),
 * непусто, когда backend отдаёт семейства с полем modes.
 */
export function kieFamilyModes(model: KieModelSpec | null | undefined): KieModeSpec[] {
  const modes = model?.modes;
  return Array.isArray(modes) ? modes.filter((m) => Boolean(m && m.id)) : [];
}

/** Активный режим: явно выбранный, иначе первый. null у плоской модели. */
export function kieFamilyMode(
  model: KieModelSpec | null | undefined,
  modeId?: string | null,
): KieModeSpec | null {
  const modes = kieFamilyModes(model);
  if (!modes.length) return null;
  return modes.find((m) => m.id === modeId) ?? modes[0] ?? null;
}

/**
 * Поля активного режима (или самой модели, если режимов нет).
 *
 * Режим с пустыми fields НЕ подменяется полями семейства: backend такие поля
 * не берёт, и пользователь видел бы настройки, которых у режима нет
 * (duration/resolution/seed и т.п. уходили бы в никуда).
 */
export function kieEffectiveFields(
  model: KieModelSpec | null | undefined,
  modeId?: string | null,
): KieField[] {
  const mode = kieFamilyMode(model, modeId);
  if (mode) return Array.isArray(mode.fields) ? mode.fields : [];
  return model?.fields ?? [];
}

/** Цена/правила активного режима (или самой модели, если режимов нет). */
export function kieEffectivePricing(
  model: KieModelSpec | null | undefined,
  modeId?: string | null,
) {
  const mode = kieFamilyMode(model, modeId);
  return mode?.pricing ?? model?.pricing ?? null;
}

/**
 * Схема полей режима известна? Контракт отдаёт fields_known: false — схему не
 * знаем («настройки неизвестны»); true — полей может не быть вовсе («нет
 * дополнительных настроек»). Если флага нет, считаем схему известной, когда
 * поля вообще есть; пустой fields без флага — неизвестная схема.
 */
export function kieFieldsKnown(
  model: KieModelSpec | null | undefined,
  modeId?: string | null,
): boolean {
  const mode = kieFamilyMode(model, modeId);
  const raw = mode?.fields_known ?? model?.fields_known;
  if (typeof raw === "boolean") return raw;
  return kieEffectiveFields(model, modeId).length > 0;
}

/** Главное текстовое поле модели из списка полей (prompt/text/dialogue). */
export function kieMainTextName(fields: KieField[]): string | null {
  const f = fields.find(
    (x) =>
      (x.kind === "textarea" || x.kind === "dialogue") &&
      ["prompt", "text", "dialogue"].includes(x.name),
  );
  return f ? f.name : null;
}

/** Поля-файлы: плитки референсов и слоты кадров. */
export function kieFileFieldsIn(fields: KieField[]): KieField[] {
  return fields.filter((f) => KIE_FILE_KINDS.has(f.kind));
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Подпись числа режимов для меню выбора: «4 режима». */
export function familyModesLabel(model: KieModelSpec | null | undefined): string | null {
  const n = kieFamilyModes(model).length;
  if (!n) return null;
  return `${n} ${pluralRu(n, "режим", "режима", "режимов")}`;
}

/**
 * Подпись режимов в строке пикера: первый режим + счётчик для семейства.
 * «Текст → видео · 4 режима», для одного режима — просто его название.
 */
export function familyModeSummary(model: KieModelSpec | null | undefined): string | null {
  const modes = kieFamilyModes(model);
  if (!modes.length) return null;
  const first = modes[0]?.label ?? modes[0]?.id ?? "";
  const count = familyModesLabel(model);
  if (modes.length === 1) return first;
  return first ? `${first} · ${count}` : count;
}

/** Бейдж текущего режима рядом с чипами. */
export function modeBadgeLabel(mode: KieModeSpec | null | undefined): string | null {
  return mode?.label ? mode.label : null;
}

/** Семейства, для которых ручной выбор режимов в UI отключён (по требованию владельца). */
const NO_MODE_FAMILIES = new Set([
  "nano-banana-2",
  "nano-banana-2-1",
  "nano-banana-2-lite",
  "nano-banana-pro",
  "gpt-image-2",
  "gpt-image-2-5",
  "gpt-image-2-6",
  "seedream-5",
  "seedream-5-pro",
  "seedream-5-flash",
  "seedream-5-lite",
  "seedream-5-5",
  "seedance-2-0",
  "seedance-2-0-fast",
  "seedance-2-5",
  "flux-3",
  "flux-1-kontext",
  "minimax-h3",
  "minimax-h3-image",
  "qwen3-image",
  "wan-2-7-image",
  "kling-4-0",
]);

/** Опции селектора режима для дока (id/label/hint). */
export function kieModeOptions(
  model: KieModelSpec | null | undefined,
): { id: string; label: string; hint?: string }[] {
  const familyId = String(model?.id || "").replace(/^kie:/, "").trim();
  if (NO_MODE_FAMILIES.has(familyId)) {
    return [];
  }
  const modes = kieFamilyModes(model);
  if (familyId.startsWith("kling-2-6") || familyId.startsWith("kling-3-0")) {
    const list = modes.filter((m) => m.id === "motion-control");
    if (!list.length) return [];
    return list.map((m) => ({
      id: m.id,
      label: "Motion Control",
      hint: m.desc || m.task_type,
    }));
  }
  if (modes.length <= 1) {
    return [];
  }
  return modes.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    hint: m.desc || m.task_type,
  }));
}

/**
 * Пресеты каталога outsee → id семейств KIE. В пикере одна строка на модель:
 * KIE — источник правды (поля, режимы, цена), пресет дублировал бы её с
 * урезанными настройками. id справа — как семейство называется в актуальном
 * curated-каталоге (например, Seedream 5 Pro в каталоге это seedream-5).
 */
export const OUTSEE_PRESET_FAMILIES: Record<string, string[]> = {
  "flux-2-pro": ["flux-2-pro"],
  "seedream-5-pro": ["seedream-5"],
  "nano-banana-2": ["nano-banana-2"],
  "qwen3-image": ["qwen3-image"],
  "gpt-image-2": ["gpt-image-2"],
  "topaz-image-upscale": ["topaz-image-upscale"],
  "seedance-2-0-fast": ["seedance-2-0"],
  "seedance-2-0-mini": ["seedance-2-0"],
  "veo-3-1-lite": ["veo-3-1"],
  "omni-flash": ["gemini-omni-flash-1-1", "gemini-omni-flash-1-2"],
  "kling-3-0-turbo": ["kling-3-0"],
  "kling-2-6": ["kling-2-6"],
  "topaz-video-upscale": ["topaz-video-upscale"],
};

/** Семейства KIE, которые заменяют пресет outsee (пусто — пресет уникален). */
export function outseePresetFamilyIds(slug: string): string[] {
  return OUTSEE_PRESET_FAMILIES[slug.trim().toLowerCase()] ?? [];
}

/**
 * Убирает пресеты outsee, у которых есть KIE-эквивалент: в пикере одна модель —
 * одна строка, KIE — источник правды (поля, режимы, цена).
 *
 * Владелец держит в пикере только curated-каталог KIE, поэтому пресет скрываем
 * и тогда, когда его семейство уже удалено из каталога: иначе удалённая модель
 * (Grok, Pixverse, Flux 2, старые Kling и т.д.) возвращалась бы в пикер отдельной
 * строкой. Пресеты без KIE-эквивалента (Suno 5.5, ElevenLabs) остаются.
 * Пока каталог не загружен (familyIds пуст) — показываем всё, чтобы пикер не
 * остался пустым при недоступном /api/kie-create/catalog.
 */
export function dropDuplicatePresets<T extends { slug: string }>(
  presets: T[],
  familyIds: Iterable<string>,
): T[] {
  const ids = new Set(Array.from(familyIds, (id) => String(id).toLowerCase()));
  if (!ids.size) return presets.slice();
  return presets.filter((p) => outseePresetFamilyIds(p.slug).length === 0);
}

/** Значения, которые переживают переключение режима: совпадают по имени поля. */
export function valuesForMode(
  values: ModelSettingValues,
  fields: KieField[],
): ModelSettingValues {
  const allowed = new Set(fields.map((f) => f.name));
  const out: ModelSettingValues = {};
  for (const [k, v] of Object.entries(values)) {
    if (allowed.has(k) || k.startsWith("_")) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Цены в долларах с наценкой студии 25%
// ---------------------------------------------------------------------------

export type UsdEstimate = {
  /** Цена для клиента: usd_kie × наценка. null — посчитать нельзя (tokens/megapixel). */
  usd_client: number | null;
  /** Цена kie.ai без наценки. null — посчитать нельзя. */
  usd_kie: number | null;
  /** Кредиты — только когда каталог ещё старый (фолбэк). */
  credits: number | null;
  source: "usd" | "credits" | "pending";
};

/** Единицы, для которых каталог не даёт пересчёта в UI: «цена уточняется». */
const PENDING_UNITS = new Set(["tokens", "megapixel", "unknown"]);

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Кредиты kie.ai → доллары клиента: credits × credit_usd × 1.25. */
export function usdFromCredits(
  credits: number,
  creditUsd: number,
  markup: number = STUDIO_MARKUP,
): number {
  const usdKie = credits * creditUsd;
  return round4(usdKie * markup);
}

/**
 * Сумма в кредитах без «бесплатно»: балансы, лимиты, суммы. Мельче 0.01 — 0.01 кр.
 */
export function formatMoneyUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd > 0 && usd < 0.01) return "0.01 кр.";
  return `${usd.toFixed(2)} кр.`;
}

/**
 * Формат ЦЕНЫ модели в UI: два знака, с «кр.».
 * 0 — «бесплатно» (а не 0.00 кр.); мельче 0.01 — 0.01 кр. (реальная цена, не ноль).
 * Неизвестную цену сюда не передаём — для неё formatEstimateUsd.
 */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "бесплатно";
  return formatMoneyUsd(usd);
}

/**
 * Подпись цены для дока: «$X», «бесплатно» при 0, «цена уточняется» при
 * неизвестной цене (tokens/megapixel/unknown/null).
 */
export function formatEstimateUsd(estimate: UsdEstimate | null | undefined): string {
  if (!estimate) return "—";
  if (estimate.source === "pending" || estimate.usd_client == null) {
    return "цена уточняется";
  }
  if (estimate.usd_client === 0) return "бесплатно";
  return formatUsd(estimate.usd_client);
}

function defaultsOf(fields: KieField[]): ModelSettingValues {
  const out: ModelSettingValues = {};
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = f.default;
  }
  return out;
}

function hasFiles(
  fields: KieField[],
  merged: ModelSettingValues,
  kinds: string[],
): boolean {
  return fields.some((f) => {
    if (!kinds.includes(f.kind)) return false;
    const v = merged[f.name];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === "string" && v.trim() !== "";
  });
}

function countFiles(
  fields: KieField[],
  merged: ModelSettingValues,
  kinds: string[],
): number {
  let total = 0;
  for (const f of fields) {
    if (!kinds.includes(f.kind)) continue;
    const v = merged[f.name];
    if (Array.isArray(v)) total += v.length;
    else if (typeof v === "string" && v.trim() !== "") total += 1;
  }
  return total;
}

/**
 * Сравнение правила when с текущими значениями. Служебные ключи:
 * `_has_images`, `_has_videos`, `_has_audios`, `_has_files` — есть ли файлы,
 * `_images_count` / `_videos_count` / `_files_count` — сколько их.
 * Для поля-массива число в when сравнивается с длиной массива.
 */
function ruleMatches(
  when: Record<string, unknown>,
  merged: ModelSettingValues,
  fields: KieField[],
): boolean {
  return Object.entries(when).every(([k, want]) => {
    if (k === "_has_images") return hasFiles(fields, merged, ["images"]) === Boolean(want);
    if (k === "_has_videos") return hasFiles(fields, merged, ["videos"]) === Boolean(want);
    if (k === "_has_audios") return hasFiles(fields, merged, ["audios"]) === Boolean(want);
    if (k === "_has_files") {
      return hasFiles(fields, merged, ["images", "videos", "audios"]) === Boolean(want);
    }
    if (k === "_images_count") return countFiles(fields, merged, ["images"]) === Number(want);
    if (k === "_videos_count") return countFiles(fields, merged, ["videos"]) === Number(want);
    if (k === "_files_count") {
      return countFiles(fields, merged, ["images", "videos", "audios"]) === Number(want);
    }
    const got = merged[k];
    if (typeof want === "boolean") return settingIsOn(got) === want;
    if (Array.isArray(got) && typeof want === "number") return got.length === want;
    return String(got ?? "") === String(want);
  });
}

/**
 * Множитель единицы цены (backend и UI считают одинаково: итог = per-unit × mult):
 * sec → длительность, 1k_chars → блоки по 1000 символов, image → число картинок,
 * gen → фикс. null — единица без правила пересчёта (tokens/megapixel).
 */
function unitMultiplier(
  unit: string,
  merged: ModelSettingValues,
): number | null {
  if (PENDING_UNITS.has(unit)) return null;
  if (unit === "sec") return Math.max(1, Number(merged.duration) || 5);
  if (unit === "1k_chars") {
    const text = String(merged.text ?? merged.dialogue ?? "");
    return Math.max(1, Math.ceil(text.length / 1000));
  }
  if (unit === "image") {
    for (const key of ["count", "num_images", "image_count", "n"]) {
      const val = Number(merged[key]);
      if (Number.isFinite(val) && val > 0) return Math.max(1, Math.round(val));
    }
    return 1;
  }
  return 1;
}

/**
 * Цена по настройкам. Источники по приоритету:
 * 1) usd_rules режима (backend шага 8);
 * 2) usd_default_client режима;
 * 3) фолбэк для старого каталога: credits × credit_usd × 1.25.
 *
 * Единицы tokens/megapixel без правила пересчёта не выдумываем: source=pending,
 * UI показывает «цена уточняется» (точную цену даст серверный /estimate).
 */
export function estimateSettingsUsd(args: {
  model: KieModelSpec | null | undefined;
  modeId?: string | null;
  values?: ModelSettingValues;
  creditUsd?: number;
  markup?: number;
}): UsdEstimate {
  const { model, modeId, values = {}, creditUsd = 0.005 } = args;
  const markup = args.markup ?? STUDIO_MARKUP;
  if (!model) return { usd_client: 0, usd_kie: 0, credits: null, source: "usd" };

  const fields = kieEffectiveFields(model, modeId);
  const pricing = kieEffectivePricing(model, modeId);
  const merged: ModelSettingValues = { ...defaultsOf(fields), ...values };
  if (!pricing) return { usd_client: 0, usd_kie: 0, credits: null, source: "usd" };

  const multiplier = unitMultiplier(pricing.unit, merged);
  if (multiplier == null) {
    return { usd_client: null, usd_kie: null, credits: null, source: "pending" };
  }

  const usdRule = (pricing.usd_rules ?? []).find((r) => ruleMatches(r.when ?? {}, merged, fields));
  if (usdRule) {
    const ruleMarkup = usdRule.markup ?? markup;
    const usdKie = round4(usdRule.usd_kie * multiplier);
    const usdClient = round4(
      (usdRule.usd_client ?? usdRule.usd_kie * ruleMarkup) * multiplier,
    );
    return { usd_client: usdClient, usd_kie: usdKie, credits: null, source: "usd" };
  }

  if (pricing.usd_default_client != null) {
    const usdClient = round4(pricing.usd_default_client * multiplier);
    const usdKie = round4(
      (pricing.usd_default_kie ?? pricing.usd_default_client / markup) * multiplier,
    );
    return { usd_client: usdClient, usd_kie: usdKie, credits: null, source: "usd" };
  }

  // ВРЕМЕННЫЙ ФОЛБЭК: пока каталог отдаёт только кредиты (до шага 8 backend).
  // После появления usd_rules/usd_default_client эта ветка не выполняется.
  let credits: number | undefined;
  for (const rule of pricing.rules ?? []) {
    if (ruleMatches(rule.when ?? {}, merged, fields)) {
      credits = rule.credits;
      break;
    }
  }
  if (credits === undefined) credits = pricing.default ?? 0;
  const totalCredits = round2(credits * multiplier);
  const usdKie = round4(totalCredits * creditUsd);
  const usdClient = round4(usdKie * markup);
  if (!(usdClient > 0)) {
    // Кредитный фолбэк с нулём НЕ доказывает бесплатность (0 = каталог молчит):
    // «цена уточняется». Бесплатность приходит только явным usd-правилом с 0.
    return {
      usd_client: null,
      usd_kie: usdKie > 0 ? usdKie : null,
      credits: totalCredits > 0 ? totalCredits : null,
      source: "pending",
    };
  }
  return {
    usd_client: usdClient,
    usd_kie: usdKie,
    credits: totalCredits,
    source: "credits",
  };
}

/**
 * Цена для строки семейства в пикере: price_from_usd из каталога, иначе
 * минимум по режимам, иначе цена самой модели.
 *
 * 0 — семья (или её самый дешёвый режим) бесплатная; null — цену не знаем
 * («цена уточняется»). Отрицательных и «почти нулевых» сантимов не отдаём:
 * форматтер сам покажет $0.01 для реальной цены мельче цента.
 */
export function familyPriceFromUsd(args: {
  model: KieModelSpec | null | undefined;
  creditUsd?: number;
  markup?: number;
}): number | null {
  const { model, creditUsd = 0.005 } = args;
  const markup = args.markup ?? STUDIO_MARKUP;
  if (!model) return null;
  const from = model.price_from_usd;
  if (typeof from === "number" && Number.isFinite(from) && from >= 0) {
    return from;
  }
  const modes = kieFamilyModes(model);
  if (modes.length) {
    const prices = modes
      .map((m) => estimateSettingsUsd({ model, modeId: m.id, creditUsd, markup }).usd_client)
      .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0);
    return prices.length ? Math.min(...prices) : null;
  }
  const est = estimateSettingsUsd({ model, creditUsd, markup });
  if (est.source === "pending" || est.usd_client == null) return null;
  return est.usd_client;
}
