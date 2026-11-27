import assert from "node:assert/strict";
import { test } from "node:test";

import type { KieField, KieModeSpec, KieModelSpec } from "./api.ts";
import {
  STUDIO_MARKUP,
  dropDuplicatePresets,
  durationNumbers,
  estimateSettingsUsd,
  familyModeSummary,
  familyModesLabel,
  familyPriceFromUsd,
  formatEstimateUsd,
  formatMoneyUsd,
  formatSettingChip,
  formatUsd,
  isKieFieldVisible,
  kieEffectiveFields,
  kieEffectivePricing,
  kieFamilyMode,
  kieFamilyModes,
  kieFieldsKnown,
  kieFileFieldsIn,
  kieMainTextName,
  kieModeOptions,
  kieOptionMeta,
  kieSettingDescriptors,
  modelSettingValue,
  outseePresetFamilyIds,
  outseeSettingDescriptors,
  settingDefaultPairs,
  settingIsOn,
  usdFromCredits,
  valuesForMode,
  type ModelSettingDescriptor,
} from "./model-settings.ts";

function field(name: string, kind: KieField["kind"], extra: Partial<KieField> = {}): KieField {
  return { name, label: name, kind, ...extra };
}

function byName(descriptors: ModelSettingDescriptor[], name: string) {
  return descriptors.find((d) => d.name === name);
}

function pricing(extra: Partial<KieModelSpec["pricing"]> = {}): KieModelSpec["pricing"] {
  return { unit: "gen", rules: [], default: 10, ...extra };
}

function model(extra: Partial<KieModelSpec> = {}): KieModelSpec {
  return {
    id: "family-1",
    label: "Family 1",
    category: "video",
    desc: "",
    result: "video",
    fields: [],
    pricing: pricing(),
    ...extra,
  };
}

function mode(id: string, extra: Partial<KieModeSpec> = {}): KieModeSpec {
  return { id, label: id, fields: [], pricing: pricing(), ...extra };
}

// ---------------------------------------------------------------------------
// KIE: дескрипторы из KieField[]
// ---------------------------------------------------------------------------

test("kieSettingDescriptors: kind поля превращается в kind контрола", () => {
  const fields: KieField[] = [
    field("aspect_ratio", "select", { options: ["16:9", "9:16"], default: "16:9" }),
    field("resolution", "select", { options: ["480p", "720p"], default: "720p" }),
    field("generate_audio", "toggle", { default: true }),
    field("steps", "number", { min: 0, max: 100, step: 1 }),
    field("style", "text"),
    field("voice_id", "text", { default: "abc" }),
    field("stability", "number", {}),
  ];
  const descriptors = kieSettingDescriptors(fields);
  assert.equal(descriptors.length, 7);
  assert.equal(byName(descriptors, "aspect_ratio")?.kind, "select");
  assert.equal(byName(descriptors, "resolution")?.kind, "select");
  assert.equal(byName(descriptors, "generate_audio")?.kind, "toggle");
  assert.equal(byName(descriptors, "steps")?.kind, "number");
  assert.equal(byName(descriptors, "style")?.kind, "text");
  assert.equal(byName(descriptors, "voice_id")?.kind, "voice");
  assert.equal(byName(descriptors, "stability")?.kind, "range");
});

test("kieFieldsKnown: известная схема без настроек ≠ неизвестная схема", () => {
  // kling-avatar/omnihuman/recraft: поля есть (только файлы/промпт) — схема известна.
  const fileOnly = model({
    modes: [
      mode("avatar-pro", {
        fields: [field("image_url", "images"), field("audio_url", "audios"), field("prompt", "textarea")],
      }),
    ],
  });
  assert.equal(kieFieldsKnown(fileOnly, "avatar-pro"), true);

  // Режим с пустыми полями и без флага — схему не знаем.
  const empty = model({ modes: [mode("x", { fields: [] })] });
  assert.equal(kieFieldsKnown(empty, "x"), false);

  // Явный контракт fields_known=false главнее наличия полей.
  const unknown = model({
    modes: [
      {
        id: "y",
        label: "Y",
        fields: [field("resolution", "select", { options: ["720p"] })],
        pricing: pricing({ unit: "gen", default: 1 }),
        fields_known: false,
      },
    ],
  });
  assert.equal(kieFieldsKnown(unknown, "y"), false);
});

test("kieSettingDescriptors: подсказка опции только из данных, без карты разрешений", () => {
  // Раньше UI дописывал "1080p"/"4k" подпись «только Quality» из захардкоженной
  // карты — у Kling 3.0 Omni это враньё. Подсказок у разрешений быть не должно.
  const descriptors = kieSettingDescriptors([
    field("resolution", "select", { options: ["480p", "720p", "1080p", "4k"], default: "720p" }),
  ]);
  const options = byName(descriptors, "resolution")?.options ?? [];
  assert.deepEqual(
    options.map((o) => o.id),
    ["480p", "720p", "1080p", "4k"],
  );
  assert.ok(options.every((o) => o.hint === undefined), "у опций нет подсказок из воздуха");
});

test("kieSettingDescriptors: data-chip у Seedance-полей прежний (aspect/sound)", () => {
  const descriptors = kieSettingDescriptors([
    field("aspect_ratio", "select", { options: ["16:9"], default: "16:9" }),
    field("resolution", "select", { options: ["720p"], default: "720p" }),
    field("duration", "number", { min: 4, max: 6, default: 5 }),
    field("generate_audio", "toggle", { default: true }),
  ]);
  assert.deepEqual(
    descriptors.map((d) => d.chip),
    ["aspect", "resolution", "duration", "sound"],
  );
  assert.deepEqual(
    descriptors.map((d) => d.section),
    ["Соотношение сторон", "Разрешение", "Длительность", "Звук"],
  );
});

test("kieSettingDescriptors: файлы, главный текст, формат и скрытые поля не попадают", () => {
  const fields: KieField[] = [
    field("prompt", "textarea"),
    field("image_url", "images", { max_items: 1 }),
    field("reference_videos", "videos"),
    field("reference_audio", "audios"),
    field("output_format", "select", { options: ["mp4"] }),
    field("format", "select", { options: ["png"] }),
    field("style", "text", { show_if: { customMode: true } }),
    field("title", "text", { show_if: { customMode: true } }),
  ];
  const hidden = kieSettingDescriptors(fields, { mainTextField: "prompt" });
  assert.deepEqual(hidden.map((d) => d.name), []);
  const shown = kieSettingDescriptors(fields, {
    mainTextField: "prompt",
    values: { customMode: true },
  });
  assert.deepEqual(shown.map((d) => d.name), ["style", "title"]);
});

test("kieSettingDescriptors: duration из options не разворачивается в диапазон", () => {
  const descriptors = kieSettingDescriptors([
    field("duration", "select", { options: ["4", "6", "8"], default: "8" }),
  ]);
  const duration = byName(descriptors, "duration")!;
  assert.equal(duration.kind, "duration");
  assert.deepEqual(durationNumbers(duration), [4, 6, 8]);
  assert.deepEqual(duration.options?.map((o) => o.id), ["4", "6", "8"]);
});

test("kieSettingDescriptors: duration Seedance 2.0 mini отсекает 1..3с по hint/min", () => {
  const descriptors = kieSettingDescriptors([
    field("duration", "number", {
      hint: "Video duration in 4-15 seconds or -1.",
      default: 5,
    }),
  ]);
  const duration = byName(descriptors, "duration")!;
  assert.equal(duration.kind, "duration");
  assert.equal(duration.min, 4);
  assert.equal(duration.max, 15);
  assert.deepEqual(
    durationNumbers(duration),
    [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.ok(!durationNumbers(duration).includes(1));
  assert.ok(!durationNumbers(duration).includes(2));
  assert.ok(!durationNumbers(duration).includes(3));
});

test("kieSettingDescriptors: range-поля получают границы 0..1 и дефолт из смысла поля", () => {
  const descriptors = kieSettingDescriptors([
    field("stability", "number", {}),
    field("similarity", "number", { default: 0.9 }),
  ]);
  const stability = byName(descriptors, "stability")!;
  assert.deepEqual(
    [stability.min, stability.max, stability.step, stability.defaultValue],
    [0, 1, 0.01, 0.5],
  );
  assert.equal(byName(descriptors, "similarity")?.defaultValue, 0.9);
});

test("kieOptionMeta: подписи quality и vocalGender как в прежних чипах", () => {
  assert.deepEqual(kieOptionMeta("quality", "basic"), { label: "1K" });
  assert.deepEqual(kieOptionMeta("quality", "high"), { label: "High" });
  assert.deepEqual(kieOptionMeta("quality", "low"), { label: "Low" });
  assert.deepEqual(kieOptionMeta("quality", "medium"), { label: "Medium" });
  assert.deepEqual(kieOptionMeta("quality", "std"), { label: "Standard", hint: "720p" });
  assert.deepEqual(kieOptionMeta("quality", "pro"), { label: "Pro", hint: "1080p" });
  assert.deepEqual(kieOptionMeta("vocalGender", "m"), {
    label: "Мужской вокал",
    hint: "Мужской тембр",
  });
  assert.deepEqual(kieOptionMeta("vocalGender", ""), {
    label: "Вокал: Любой",
    hint: "Без предпочтений",
  });
});

test("isKieFieldVisible: show_if по boolean и по строке", () => {
  assert.equal(isKieFieldVisible(field("style", "text")), true);
  const toggleField = field("style", "text", { show_if: { customMode: true } });
  assert.equal(isKieFieldVisible(toggleField, {}), false);
  assert.equal(isKieFieldVisible(toggleField, { customMode: "true" }), true);
  assert.equal(isKieFieldVisible(toggleField, { customMode: false }), false);
  const selectField = field("duration", "number", { show_if: { customMode: "advanced" } });
  assert.equal(isKieFieldVisible(selectField, { customMode: "advanced" }), true);
  assert.equal(isKieFieldVisible(selectField, { customMode: "simple" }), false);
});

// ---------------------------------------------------------------------------
// Outsee: дескрипторы из конфигурации чипов
// ---------------------------------------------------------------------------

const OUTSEE_DETAIL = [
  { id: "low", label: "Низкое", hint: "дешевле" },
  { id: "medium", label: "Среднее", hint: "баланс" },
  { id: "high", label: "Высокое", hint: "детальнее" },
];

test("outseeSettingDescriptors: аспект/разрешение/детализация — сетки кнопок", () => {
  const descriptors = outseeSettingDescriptors({
    chips: ["aspect", "resolution", "detail"],
    options: {
      aspect: ["16:9", "9:16"].map((o) => ({ id: o, label: o })),
      resolution: ["1K", "2K"].map((o) => ({ id: o, label: o })),
      detail: OUTSEE_DETAIL,
    },
    defaults: { aspect: "16:9", resolution: "2K", detail: "medium" },
  });
  assert.deepEqual(descriptors.map((d) => d.name), ["aspect", "resolution", "detail"]);
  assert.ok(descriptors.every((d) => d.kind === "select"));
  assert.equal(byName(descriptors, "aspect")?.defaultValue, "16:9");
  assert.equal(byName(descriptors, "detail")?.options?.[1]?.hint, "баланс");
});

test("outseeSettingDescriptors: duration — сетка чисел со своим суффиксом", () => {
  const descriptors = outseeSettingDescriptors({
    chips: ["duration"],
    options: { duration: ["5", "10"].map((o) => ({ id: o, label: `${o}с` })) },
    defaults: { duration: "5" },
  });
  const duration = descriptors[0]!;
  assert.equal(duration.kind, "duration");
  assert.equal(duration.valueType, "string");
  assert.equal(duration.suffix, "с");
  assert.deepEqual(durationNumbers(duration), [5, 10]);
  assert.equal(formatSettingChip(duration, {}), "5с");
});

test("outseeSettingDescriptors: audio — тумблер, файлы и чужие чипы игнорируются", () => {
  const descriptors = outseeSettingDescriptors({
    chips: ["image-input", "orientation", "quality", "instrumental", "audio"],
    options: {},
    defaults: { audio: true },
  });
  assert.deepEqual(descriptors.map((d) => d.name), ["audio"]);
  assert.equal(descriptors[0]!.kind, "toggle");
  assert.equal(descriptors[0]!.defaultValue, true);
});

test("outseeSettingDescriptors: порядок чипов — как в доке", () => {
  const descriptors = outseeSettingDescriptors({
    chips: ["audio", "duration", "detail", "resolution", "aspect"],
    options: {
      aspect: [{ id: "16:9", label: "16:9" }],
      resolution: [{ id: "2K", label: "2K" }],
      detail: OUTSEE_DETAIL,
      duration: [{ id: "5", label: "5с" }],
    },
  });
  assert.deepEqual(
    descriptors.map((d) => d.name),
    ["aspect", "resolution", "detail", "duration", "audio"],
  );
});

// ---------------------------------------------------------------------------
// Значения, чипы, сброс
// ---------------------------------------------------------------------------

test("formatSettingChip: toggle/duration/select и дефолты", () => {
  const sound = outseeSettingDescriptors({
    chips: ["audio"],
    options: {},
    defaults: { audio: false },
  })[0]!;
  assert.equal(formatSettingChip(sound, {}), "Звук выкл");

  const duration = outseeSettingDescriptors({
    chips: ["duration"],
    options: { duration: [{ id: "5", label: "5с" }] },
    defaults: { duration: "5" },
  })[0]!;
  assert.equal(formatSettingChip(duration, { duration: "10" }), "10с");

  const quality = kieSettingDescriptors([
    field("quality", "select", { options: ["basic", "high"], default: "high" }),
  ])[0]!;
  assert.equal(formatSettingChip(quality, {}), "High");
  assert.equal(formatSettingChip(quality, { quality: "basic" }), "1K");
});

test("modelSettingValue и settingIsOn: false/0 не заменяются дефолтом", () => {
  const toggle = kieSettingDescriptors([field("generate_audio", "toggle", { default: true })])[0]!;
  assert.equal(modelSettingValue(toggle, { generate_audio: false }), false);
  assert.equal(modelSettingValue(toggle, {}), true);
  const steps = kieSettingDescriptors([field("steps", "number", { default: 7 })])[0]!;
  assert.equal(modelSettingValue(steps, { steps: 0 }), 0);
  assert.equal(settingIsOn("TRUE"), true);
  assert.equal(settingIsOn(0), false);
  assert.equal(settingIsOn(1), true);
});

test("settingDefaultPairs: только поля с дефолтом", () => {
  const descriptors = kieSettingDescriptors([
    field("aspect_ratio", "select", { options: ["16:9"], default: "16:9" }),
    field("steps", "number", {}),
    field("generate_audio", "toggle", { default: true }),
  ]);
  assert.deepEqual(settingDefaultPairs(descriptors), [
    ["aspect_ratio", "16:9"],
    ["generate_audio", true],
  ]);
});

test("durationNumbers: диапазон ограничен 1..60 и по умолчанию 1..15", () => {
  const base: ModelSettingDescriptor = {
    name: "d",
    chip: "d",
    label: "d",
    section: "d",
    kind: "duration",
    icon: "duration",
  };
  assert.deepEqual(durationNumbers(base), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(durationNumbers({ ...base, min: 1, max: 99 }), Array.from({ length: 60 }, (_, i) => i + 1));
});

// ---------------------------------------------------------------------------
// Режимы семейства
// ---------------------------------------------------------------------------

test("kieFamilyModes: у плоской модели режимов нет, у семейства — порядок каталога", () => {
  assert.deepEqual(kieFamilyModes(null), []);
  assert.deepEqual(kieFamilyModes(model()), []);
  const family = model({ modes: [mode("t2v"), mode("i2v")] });
  assert.deepEqual(kieFamilyModes(family).map((m) => m.id), ["t2v", "i2v"]);
});

test("kieFamilyMode: явный режим, иначе первый, у плоской модели null", () => {
  const family = model({ modes: [mode("t2v"), mode("i2v")] });
  assert.equal(kieFamilyMode(family, "i2v")?.id, "i2v");
  assert.equal(kieFamilyMode(family, "unknown")?.id, "t2v");
  assert.equal(kieFamilyMode(family, null)?.id, "t2v");
  assert.equal(kieFamilyMode(model(), "t2v"), null);
});

test("kieEffectiveFields/kieEffectivePricing: поля и цена выбранного режима", () => {
  const t2v = mode("t2v", {
    fields: [field("duration", "number", { min: 4, max: 8, default: 4 })],
    pricing: { unit: "sec", rules: [], default: 41 },
  });
  const i2v = mode("i2v", {
    fields: [field("resolution", "select", { options: ["720p"], default: "720p" })],
    pricing: { unit: "sec", rules: [], default: 20 },
  });
  const family = model({
    fields: [field("prompt", "textarea")],
    pricing: pricing({ default: 99 }),
    modes: [t2v, i2v],
  });
  assert.deepEqual(kieEffectiveFields(family, "i2v").map((f) => f.name), ["resolution"]);
  assert.deepEqual(kieEffectiveFields(family, "t2v").map((f) => f.name), ["duration"]);
  assert.equal(kieEffectiveFields(family, null)[0]?.name, "duration");
  assert.equal(kieEffectivePricing(family, "i2v")?.default, 20);
  assert.equal(kieEffectivePricing(family, null)?.default, 41);
  // У плоской модели берутся её собственные поля и цена.
  assert.equal(kieEffectivePricing(model({ pricing: pricing({ default: 7 }) }), null)?.default, 7);
});

test("режим без своих полей НЕ подменяется полями модели (настройки не выдумываем)", () => {
  const family = model({
    fields: [field("seed", "number")],
    modes: [mode("only", { fields: [] })],
  });
  // Backend поля режима в payload/estimate не берёт: показывать их нельзя.
  assert.deepEqual(kieEffectiveFields(family, "only"), []);
  // У плоской модели без modes свои поля остаются как были.
  assert.deepEqual(
    kieEffectiveFields(model({ fields: [field("seed", "number")] }), null).map((f) => f.name),
    ["seed"],
  );
});

test("kieMainTextName/kieFileFieldsIn: главный текст и файлы из полей режима", () => {
  const fields = [
    field("prompt", "textarea"),
    field("negative_prompt", "textarea"),
    field("image_url", "images", { max_items: 1 }),
    field("reference_videos", "videos"),
    field("audio_file", "audios"),
  ];
  assert.equal(kieMainTextName(fields), "prompt");
  assert.equal(kieMainTextName([field("dialogue", "dialogue")]), "dialogue");
  assert.equal(kieMainTextName([field("seed", "number")]), null);
  assert.deepEqual(kieFileFieldsIn(fields).map((f) => f.name), [
    "image_url",
    "reference_videos",
    "audio_file",
  ]);
});

test("familyModesLabel/familyModeSummary: счётчик режимов по-русски", () => {
  const one = model({ modes: [mode("t2v", { label: "Текст → видео" })] });
  assert.equal(familyModesLabel(one), "1 режим");
  assert.equal(familyModeSummary(one), "Текст → видео");
  const four = model({
    modes: [mode("t2v", { label: "Текст → видео" }), mode("a"), mode("b"), mode("c")],
  });
  assert.equal(familyModesLabel(four), "4 режима");
  assert.equal(familyModeSummary(four), "Текст → видео · 4 режима");
  const five = model({ modes: Array.from({ length: 5 }, (_, i) => mode(`m${i}`)) });
  assert.equal(familyModesLabel(five), "5 режимов");
  assert.equal(familyModesLabel(model()), null);
  assert.equal(familyModeSummary(model()), null);
});

test("kieModeOptions: id/label/hint для селектора режима", () => {
  const family = model({
    modes: [mode("t2v", { label: "Текст → видео", desc: "просто текст" }), mode("i2v")],
  });
  assert.deepEqual(kieModeOptions(family), [
    { id: "t2v", label: "Текст → видео", hint: "просто текст" },
    { id: "i2v", label: "i2v", hint: undefined },
  ]);

  // Скрытие режимов для семейств без ручного выбора (Hailuo 2.3, MiniMax H3)
  assert.deepEqual(
    kieModeOptions(model({ id: "hailuo-2-3-i2v", modes: [mode("i2v-pro"), mode("i2v-standard")] })),
    [],
  );
  assert.deepEqual(
    kieModeOptions(model({ id: "minimax-h3-t2v", modes: [mode("t2v"), mode("i2v"), mode("r2v")] })),
    [],
  );
});

test("valuesForMode: оставляет поля нового режима и служебные ключи", () => {
  const values = { duration: 5, resolution: "720p", _nonce: "x", first_frame_url: "u" };
  const kept = valuesForMode(values, [field("duration", "number"), field("resolution", "select")]);
  assert.deepEqual(kept, { duration: 5, resolution: "720p", _nonce: "x" });
});

// ---------------------------------------------------------------------------
// Цены в долларах: наценка студии 25%
// ---------------------------------------------------------------------------

test("usdFromCredits: кредиты kie × курс × наценка", () => {
  assert.equal(STUDIO_MARKUP, 1.25);
  assert.equal(usdFromCredits(10, 0.005), 0.0625);
  assert.equal(usdFromCredits(100, 0.005), 0.625);
  assert.equal(usdFromCredits(10, 0.005, 1), 0.05);
});

test("formatUsd: 0 — «бесплатно», мелкое — 0.01 кр., пустое — тире", () => {
  assert.equal(formatUsd(0), "бесплатно");
  assert.equal(formatUsd(0.0625), "0.06 кр.");
  assert.equal(formatUsd(1.25), "1.25 кр.");
  assert.equal(formatUsd(0.004), "0.01 кр.");
  assert.equal(formatUsd(12), "12.00 кр.");
  assert.equal(formatUsd(null), "—");
  // Балансы и суммы остаются деньгами: там 0.00 кр. — честный ноль.
  assert.equal(formatMoneyUsd(0), "0.00 кр.");
  assert.equal(formatMoneyUsd(0.004), "0.01 кр.");
  assert.equal(formatMoneyUsd(null), "—");
});

test("estimateSettingsUsd: старый каталог с кредитами — фолбэк с наценкой", () => {
  const flat = model({ pricing: pricing({ unit: "gen", default: 10 }) });
  const est = estimateSettingsUsd({ model: flat, creditUsd: 0.005 });
  assert.equal(est.source, "credits");
  assert.equal(est.credits, 10);
  assert.equal(est.usd_kie, 0.05);
  assert.equal(est.usd_client, 0.0625);
});

test("estimateSettingsUsd: unit=sec умножает на длительность", () => {
  const flat = model({ pricing: pricing({ unit: "sec", default: 41 }) });
  const est = estimateSettingsUsd({ model: flat, values: { duration: 5 }, creditUsd: 0.005 });
  assert.equal(est.credits, 205);
  assert.equal(est.usd_client, 1.2813);
});

test("estimateSettingsUsd: правило when совпадает по настройкам и _has_videos", () => {
  const flat = model({
    fields: [field("resolution", "select", { options: ["720p", "1080p"] }), field("video_url", "videos")],
    pricing: pricing({
      unit: "gen",
      default: 10,
      rules: [
        { when: { resolution: "1080p" }, credits: 20 },
        { when: { _has_videos: true }, credits: 30 },
      ],
    }),
  });
  assert.equal(estimateSettingsUsd({ model: flat, creditUsd: 0.005 }).credits, 10);
  assert.equal(
    estimateSettingsUsd({ model: flat, values: { resolution: "1080p" }, creditUsd: 0.005 }).credits,
    20,
  );
  assert.equal(
    estimateSettingsUsd({ model: flat, values: { video_url: ["u"] }, creditUsd: 0.005 }).credits,
    30,
  );
});

test("estimateSettingsUsd: usd_rules режима — цена в $ с наценкой, момент unit=sec", () => {
  const family = model({
    fields: [field("duration", "number", { default: 4 }), field("resolution", "select", { options: ["720p", "1080p"] })],
    modes: [
      mode("t2v", {
        fields: [field("duration", "number", { default: 4 }), field("resolution", "select", { options: ["720p", "1080p"] })],
        pricing: pricing({
          unit: "sec",
          usd_rules: [
            { when: { resolution: "1080p" }, usd_kie: 0.4 },
            { when: {}, usd_kie: 0.1 },
          ],
        }),
      }),
    ],
  });
  const hd = estimateSettingsUsd({
    model: family,
    modeId: "t2v",
    values: { resolution: "1080p", duration: 5 },
  });
  assert.equal(hd.source, "usd");
  assert.equal(hd.usd_kie, 2);
  assert.equal(hd.usd_client, 2.5);
  const sd = estimateSettingsUsd({
    model: family,
    modeId: "t2v",
    values: { resolution: "720p", duration: 4 },
  });
  assert.equal(sd.usd_client, 0.5);
});

test("estimateSettingsUsd: usd_default_client и своя цена у каждого режима", () => {
  const family = model({
    modes: [
      mode("cheap", { pricing: pricing({ usd_default_client: 0.08 }) }),
      mode("rich", { pricing: pricing({ usd_default_client: 1.25 }) }),
    ],
  });
  assert.equal(estimateSettingsUsd({ model: family, modeId: "cheap" }).usd_client, 0.08);
  assert.equal(estimateSettingsUsd({ model: family, modeId: "rich" }).usd_client, 1.25);
  assert.equal(estimateSettingsUsd({ model: family, modeId: "rich" }).usd_kie, 1);
});

test("estimateSettingsUsd: число картинок влияет на цену (_images_count и длина массива)", () => {
  const flat = model({
    fields: [field("image_urls", "images", { max_items: 4 })],
    pricing: pricing({
      rules: [
        { when: { _images_count: 2 }, credits: 20 },
        { when: { image_urls: 4 }, credits: 40 },
        { when: {}, credits: 10 },
      ],
    }),
  });
  assert.equal(estimateSettingsUsd({ model: flat, creditUsd: 0.005 }).credits, 10);
  assert.equal(
    estimateSettingsUsd({ model: flat, values: { image_urls: ["a", "b"] }, creditUsd: 0.005 })
      .credits,
    20,
  );
  assert.equal(
    estimateSettingsUsd({
      model: flat,
      values: { image_urls: ["a", "b", "c", "d"] },
      creditUsd: 0.005,
    }).credits,
    40,
  );
});

test("estimateSettingsUsd: tokens/megapixel без пересчёта — «цена уточняется», не выдумываем", () => {
  const tokens = model({ pricing: pricing({ unit: "tokens" }) });
  const est = estimateSettingsUsd({ model: tokens });
  assert.equal(est.source, "pending");
  assert.equal(est.usd_client, null);
  assert.equal(formatEstimateUsd(est), "цена уточняется");
  const megapixel = model({ pricing: pricing({ unit: "megapixel" }) });
  assert.equal(estimateSettingsUsd({ model: megapixel }).source, "pending");
});

test("estimateSettingsUsd: unit=image — фикс за картинку, count умножает", () => {
  const flat = model({
    fields: [field("num_images", "number", { default: 2 })],
    pricing: pricing({ unit: "image", usd_default_client: 0.08 }),
  });
  assert.equal(estimateSettingsUsd({ model: flat }).usd_client, 0.16);
  assert.equal(
    formatEstimateUsd(estimateSettingsUsd({ model: flat, values: { num_images: 1 } })),
    "0.08 кр.",
  );
});

test("estimateSettingsUsd: наценку можно переопределить", () => {
  // Правило без usd_client: клиентская цена = usd_kie × наценка.
  const withRule = model({
    pricing: pricing({ usd_rules: [{ when: {}, usd_kie: 0.4 }] }),
  });
  assert.equal(estimateSettingsUsd({ model: withRule }).usd_client, 0.5);
  assert.equal(estimateSettingsUsd({ model: withRule, markup: 2 }).usd_client, 0.8);
  // Фолбэк по кредитам тоже учитывает наценку.
  const flat = model({ pricing: pricing({ default: 10 }) });
  assert.equal(estimateSettingsUsd({ model: flat, creditUsd: 0.005, markup: 2 }).usd_client, 0.1);
});

test("familyPriceFromUsd: price_from_usd из каталога, иначе минимум по режимам", () => {
  const withFrom = model({ price_from_usd: 0.12, modes: [mode("a", { pricing: pricing({ usd_default_client: 1 }) })] });
  assert.equal(familyPriceFromUsd({ model: withFrom }), 0.12);

  const family = model({
    modes: [
      mode("a", { pricing: pricing({ usd_default_client: 0.5 }) }),
      mode("b", { pricing: pricing({ usd_default_client: 0.2 }) }),
    ],
  });
  assert.equal(familyPriceFromUsd({ model: family }), 0.2);

  const flat = model({ pricing: pricing({ default: 10 }) });
  assert.equal(familyPriceFromUsd({ model: flat, creditUsd: 0.005 }), 0.0625);
  assert.equal(familyPriceFromUsd({ model: null }), null);
});

test("dropDuplicatePresets: пресеты с KIE-эквивалентом скрываются, уникальные остаются", () => {
  const presets = [
    { slug: "flux-2-pro" },
    { slug: "seedance-2-0-fast" },
    { slug: "veo-3-1-lite" },
    { slug: "kling-2-6" },
    { slug: "gpt-image-2" },
    { slug: "suno-5-5" },
    { slug: "elevenlabs-v4" },
  ];
  const families = [
    "flux-2-pro",
    "seedance-2-0",
    "veo-3-1",
    "kling-2-6",
    "gpt-image-2",
    "suno-music",
  ];
  assert.deepEqual(
    dropDuplicatePresets(presets, families).map((p) => p.slug),
    ["suno-5-5", "elevenlabs-v4"],
  );
  // Каталог не загружен (пустой ответ) — пресеты остаются, пикер не пустой.
  assert.equal(dropDuplicatePresets(presets, []).length, presets.length);
});

test("dropDuplicatePresets: пресет без семьи (модель удалена из каталога) тоже скрыт", () => {
  // flux-2-pro / gpt-image-2 — моделей больше нет в curated-каталоге: их семей
  // нет в families, но строки-пресеты не должны возвращаться в пикер.
  const presets = [
    { slug: "flux-2-pro" },
    { slug: "gpt-image-2" },
    { slug: "omni-flash" },
    { slug: "suno-5-5" },
  ];
  const families = ["veo-3-1", "seedream-5", "nano-banana-2", "suno-music"];
  assert.deepEqual(
    dropDuplicatePresets(presets, families).map((p) => p.slug),
    ["suno-5-5"],
  );
});

test("outseePresetFamilyIds: соответствие пресетов семействам KIE", () => {
  assert.deepEqual(outseePresetFamilyIds("seedance-2-0-fast"), ["seedance-2-0"]);
  assert.deepEqual(outseePresetFamilyIds("seedance-2-0-mini"), ["seedance-2-0"]);
  assert.deepEqual(outseePresetFamilyIds("veo-3-1-lite"), ["veo-3-1-lite", "veo-3-1"]);
  assert.deepEqual(outseePresetFamilyIds("kling-3-0-turbo"), ["kling-3-0"]);
  assert.deepEqual(outseePresetFamilyIds("omni-flash"), [
    "gemini-omni-flash-1-1",
    "gemini-omni-flash-1-2",
  ]);
  assert.deepEqual(outseePresetFamilyIds("suno-5-5"), []);
  assert.deepEqual(outseePresetFamilyIds("не-существует"), []);
});

test("нулевая цена — «бесплатно», неизвестная — «цена уточняется»", () => {
  // ideogram-v3/remix и gemini-omni/character: unit unknown, правил и дефолтов нет.
  const unknown = model({
    modes: [
      mode("remix", {
        pricing: {
          unit: "unknown",
          rules: [],
          default: 0,
          usd_rules: [],
          usd_default_client: null,
          usd_default_kie: null,
        },
      }),
    ],
  });
  const est = estimateSettingsUsd({ model: unknown, modeId: "remix", creditUsd: 0.005 });
  assert.equal(est.usd_client, null);
  assert.equal(est.source, "pending");
  assert.equal(formatEstimateUsd(est), "цена уточняется");

  // Явный ноль (suno-cover/cover, grok segment-map) — бесплатно, не «$0.00».
  const free = model({
    modes: [
      mode("cover", {
        pricing: {
          unit: "image",
          rules: [],
          default: 0,
          usd_rules: [{ when: {}, usd_kie: 0, usd_client: 0 }],
          usd_default_client: 0,
          usd_default_kie: 0,
        },
      }),
    ],
  });
  const freeEst = estimateSettingsUsd({ model: free, modeId: "cover", creditUsd: 0.005 });
  assert.equal(freeEst.usd_client, 0);
  assert.equal(freeEst.source, "usd");
  assert.equal(formatEstimateUsd(freeEst), "бесплатно");
  // Пикер: семья с бесплатным режимом/ценой — «бесплатно», не null.
  assert.equal(familyPriceFromUsd({ model: free }), 0);
});

test("kieSettingDescriptors скрывает complexity и moderation (GPT Image 2.6)", () => {
  const fields: KieField[] = [
    { name: "prompt", label: "Промпт", kind: "textarea" },
    { name: "aspect_ratio", label: "Соотношение сторон", kind: "select", options: ["1:1", "16:9"] },
    { name: "resolution", label: "Разрешение", kind: "select", options: ["1K", "2K"] },
    { name: "quality", label: "Качество", kind: "select", options: ["low", "medium", "high"] },
    { name: "complexity", label: "Сложность", kind: "select", options: ["low", "medium", "high"] },
    { name: "moderation", label: "Модерация", kind: "select", options: ["auto", "low"] },
  ];
  const descriptors = kieSettingDescriptors(fields, { mainTextField: "prompt" });
  const names = descriptors.map((d) => d.name);
  assert.deepEqual(names, ["aspect_ratio", "resolution", "quality"]);
});

test("kieSettingDescriptors скрывает fallback, generation_type и модель veo3", () => {
  const fields: KieField[] = [
    { name: "prompt", label: "Промпт", kind: "textarea" },
    { name: "model", label: "Модель", kind: "select", options: ["veo3_fast", "veo3_lite", "veo3"] },
    { name: "generation_type", label: "Тип генерации", kind: "select", options: ["TEXT_2_VIDEO"] },
    { name: "enable_fallback", label: "Fallback", kind: "toggle" },
    { name: "aspect_ratio", label: "Соотношение сторон", kind: "select", options: ["16:9", "9:16"] },
    { name: "resolution", label: "Разрешение", kind: "select", options: ["720p", "1080p", "4k"] },
    { name: "duration", label: "Длительность", kind: "select", options: ["4", "6", "8"] },
  ];
  const descriptors = kieSettingDescriptors(fields, { mainTextField: "prompt" });
  const names = descriptors.map((d) => d.name);
  assert.deepEqual(names, ["aspect_ratio", "resolution", "duration"]);
});

