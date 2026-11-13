import assert from "node:assert/strict";
import { test } from "node:test";

import type { KieField } from "./api.ts";
import {
  durationNumbers,
  formatSettingChip,
  isKieFieldVisible,
  kieOptionMeta,
  kieSettingDescriptors,
  modelSettingValue,
  outseeSettingDescriptors,
  settingDefaultPairs,
  settingIsOn,
  type ModelSettingDescriptor,
} from "./model-settings.ts";

function field(name: string, kind: KieField["kind"], extra: Partial<KieField> = {}): KieField {
  return { name, label: name, kind, ...extra };
}

function byName(descriptors: ModelSettingDescriptor[], name: string) {
  return descriptors.find((d) => d.name === name);
}

// ---------------------------------------------------------------------------
// KIE: дескрипторы из KieField[]
// ---------------------------------------------------------------------------

test("kieSettingDescriptors: kind поля превращается в kind контрола", () => {
  const fields: KieField[] = [
    field("aspect_ratio", "select", { options: ["16:9", "9:16"], default: "16:9" }),
    field("resolution", "select", { options: ["480p", "720p"], default: "720p" }),
    field("generate_audio", "toggle", { default: true }),
    field("seed", "number", { min: 0, max: 100, step: 1 }),
    field("style", "text"),
    field("voice_id", "text", { default: "abc" }),
    field("stability", "number", {}),
  ];
  const descriptors = kieSettingDescriptors(fields);
  assert.equal(descriptors.length, 7);
  assert.equal(byName(descriptors, "aspect_ratio")?.kind, "select");
  assert.equal(byName(descriptors, "resolution")?.kind, "select");
  assert.equal(byName(descriptors, "generate_audio")?.kind, "toggle");
  assert.equal(byName(descriptors, "seed")?.kind, "number");
  assert.equal(byName(descriptors, "style")?.kind, "text");
  assert.equal(byName(descriptors, "voice_id")?.kind, "voice");
  assert.equal(byName(descriptors, "stability")?.kind, "range");
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

test("kieSettingDescriptors: textarea не-главного поля остаётся текстовым контролом", () => {
  const descriptors = kieSettingDescriptors([field("negative_prompt", "textarea")], {
    mainTextField: "prompt",
  });
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]!.kind, "text");
});

test("kieSettingDescriptors: дефолт, min/max и step переносятся в дескриптор", () => {
  const descriptors = kieSettingDescriptors([
    field("duration", "number", { min: 4, max: 15, default: 5 }),
    field("seed", "number", { min: 0, max: 2147483647, step: 1 }),
    field("quality", "select", { options: ["basic", "high"], default: "basic" }),
  ]);
  const duration = byName(descriptors, "duration")!;
  assert.equal(duration.defaultValue, 5);
  assert.equal(duration.min, 4);
  assert.equal(duration.max, 15);
  assert.equal(duration.suffix, "s");
  assert.equal(duration.valueType, "number");
  assert.deepEqual(durationNumbers(duration), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const seed = byName(descriptors, "seed")!;
  assert.equal(seed.min, 0);
  assert.equal(seed.max, 2147483647);
  assert.equal(seed.step, 1);
  assert.equal(byName(descriptors, "quality")?.defaultValue, "basic");
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
  const similarity = byName(descriptors, "similarity")!;
  assert.equal(similarity.defaultValue, 0.9);
});

test("kieSettingDescriptors: select без опций не рисуем — управлять нечем", () => {
  const descriptors = kieSettingDescriptors([field("resolution", "select", { options: [] })]);
  assert.deepEqual(descriptors, []);
});

test("kieOptionMeta: подписи quality и vocalGender как в прежних чипах", () => {
  assert.deepEqual(kieOptionMeta("quality", "basic"), { label: "1K", hint: "Базовое" });
  assert.deepEqual(kieOptionMeta("quality", "high"), { label: "2K", hint: "Высокое" });
  assert.deepEqual(kieOptionMeta("quality", "std"), { label: "Standard", hint: "720p" });
  assert.deepEqual(kieOptionMeta("quality", "pro"), { label: "Pro", hint: "1080p" });
  assert.deepEqual(kieOptionMeta("vocalGender", "m"), {
    label: "Мужской вокал",
    hint: "Мужской тембр",
  });
  assert.deepEqual(kieOptionMeta("vocalGender", "f"), {
    label: "Женский вокал",
    hint: "Женский тембр",
  });
  assert.deepEqual(kieOptionMeta("vocalGender", ""), {
    label: "Вокал: Любой",
    hint: "Без предпочтений",
  });
  assert.deepEqual(kieOptionMeta("style", ""), { label: "—" });
});

test("isKieFieldVisible: show_if по boolean и по строке", () => {
  assert.equal(isKieFieldVisible(field("style", "text")), true);
  const toggleField = field("style", "text", { show_if: { customMode: true } });
  assert.equal(isKieFieldVisible(toggleField, {}), false);
  assert.equal(isKieFieldVisible(toggleField, { customMode: true }), true);
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
  assert.equal(byName(descriptors, "detail")?.options?.length, 3);
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

test("outseeSettingDescriptors: пустые опции не дают пустых секций", () => {
  assert.deepEqual(
    outseeSettingDescriptors({ chips: ["aspect", "resolution", "duration"], options: {} }),
    [],
  );
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

const seedanceAudio = kieSettingDescriptors([
  field("generate_audio", "toggle", { default: true }),
])[0]!;

test("formatSettingChip: toggle, duration, select и дефолты", () => {
  assert.equal(formatSettingChip(seedanceAudio, {}), "Звук вкл");
  assert.equal(formatSettingChip(seedanceAudio, { generate_audio: false }), "Звук выкл");
  assert.equal(formatSettingChip(seedanceAudio, { generate_audio: "true" }), "Звук вкл");

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
  assert.equal(formatSettingChip(duration, {}), "5с");
  assert.equal(formatSettingChip(duration, { duration: "10" }), "10с");

  const quality = kieSettingDescriptors([
    field("quality", "select", { options: ["basic", "high"], default: "high" }),
  ])[0]!;
  assert.equal(formatSettingChip(quality, {}), "2K");
  assert.equal(formatSettingChip(quality, { quality: "basic" }), "1K");
  assert.equal(formatSettingChip(quality, { quality: "unknown" }), "unknown");
});

test("formatSettingChip: number/text показывают подпись и обрезают длинное", () => {
  const seed = kieSettingDescriptors([field("seed", "number", { default: 42 })])[0]!;
  assert.equal(formatSettingChip(seed, {}), "seed: 42");
  const style = kieSettingDescriptors([field("style", "text")])[0]!;
  assert.equal(formatSettingChip(style, {}), "style");
  assert.equal(formatSettingChip(style, { style: "dark phonk" }), "style: dark phonk");
  assert.equal(
    formatSettingChip(style, { style: "x".repeat(40) }),
    `style: ${"x".repeat(17)}…`,
  );
  const voice = kieSettingDescriptors([field("voice_id", "text", { default: "abc" })])[0]!;
  assert.equal(formatSettingChip(voice, {}), "abc");
});

test("modelSettingValue: null/undefined заменяются дефолтом, false и 0 остаются", () => {
  const toggle = kieSettingDescriptors([field("generate_audio", "toggle", { default: true })])[0]!;
  assert.equal(modelSettingValue(toggle, { generate_audio: false }), false);
  assert.equal(modelSettingValue(toggle, { generate_audio: undefined }), true);
  const seed = kieSettingDescriptors([field("seed", "number", { default: 7 })])[0]!;
  assert.equal(modelSettingValue(seed, {}), 7);
  assert.equal(modelSettingValue(seed, { seed: 0 }), 0);
});

test("settingIsOn: boolean, строка и число", () => {
  assert.equal(settingIsOn(true), true);
  assert.equal(settingIsOn("true"), true);
  assert.equal(settingIsOn("TRUE"), true);
  assert.equal(settingIsOn(false), false);
  assert.equal(settingIsOn("false"), false);
  assert.equal(settingIsOn(0), false);
  assert.equal(settingIsOn(1), true);
  assert.equal(settingIsOn(undefined), false);
});

test("settingDefaultPairs: только поля с дефолтом", () => {
  const descriptors = kieSettingDescriptors([
    field("aspect_ratio", "select", { options: ["16:9"], default: "16:9" }),
    field("seed", "number", {}),
    field("generate_audio", "toggle", { default: true }),
  ]);
  assert.deepEqual(settingDefaultPairs(descriptors), [
    ["aspect_ratio", "16:9"],
    ["generate_audio", true],
  ]);
});

test("durationNumbers: диапазон ограничен 1..60 и по умолчанию 1..15", () => {
  assert.deepEqual(durationNumbers({ name: "d", chip: "d", label: "d", section: "d", kind: "duration", icon: "duration" }), [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
  assert.deepEqual(
    durationNumbers({ name: "d", chip: "d", label: "d", section: "d", kind: "duration", icon: "duration", min: 0, max: 3 }),
    [1, 2, 3],
  );
  assert.deepEqual(
    durationNumbers({ name: "d", chip: "d", label: "d", section: "d", kind: "duration", icon: "duration", min: 1, max: 99 }),
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
});
