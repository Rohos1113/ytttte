/**
 * Чистая логика общего окна настроек Create (как у Seedance, но для всех моделей).
 *
 * Док «Генерация» рисует одни и те же чипы и одну панель «Параметры» для любой
 * модели; разница между моделями — только список дескрипторов полей. Здесь
 * строятся эти дескрипторы: из KieField[] (каталог KIE) и из конфигурации
 * чипов outsee (aspect / resolution / detail / duration / audio).
 *
 * Никакого React и побочных эффектов: всё детерминировано, поэтому покрыто
 * юнит-тестами в `model-settings.test.ts`.
 */

import type { KieField } from "./api";

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

/** Служебные поля, которые в доке Create не показываем (формат отдаёт бэкенд). */
const KIE_SKIP_NAMES = new Set(["output_format", "format"]);

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
    if (opt === "basic") return { label: "1K", hint: "Базовое" };
    if (opt === "high") return { label: "2K", hint: "Высокое" };
    if (opt === "std" || opt === "standard") return { label: "Standard", hint: "720p" };
    if (opt === "pro") return { label: "Pro", hint: "1080p" };
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
