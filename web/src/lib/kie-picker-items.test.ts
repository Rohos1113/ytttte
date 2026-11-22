/**
 * Пикер «Генерация»: одна карточка = одна модель, режимы свёрнуты внутрь.
 *
 * Данные — как их отдаёт /api/kie-create/catalog: семейства с modes[]. Проверяем,
 * что способы генерации (t2i/t2v/i2v, Pro/Flash) не размножают строки, что слаг
 * `kie:<family>~<mode>` остаётся рабочим и что поиск по режиму находит модель.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { KieModelSpec } from "./api.ts";
import {
  KIE_MODE_SEP,
  familyPickerRows,
  isFamilyHidden,
  kieRowSlug,
  mediaOfModel,
  parseKieSlug,
  pickerRowsForMedia,
  taskTypeRu,
} from "./kie-picker-items.ts";

function mode(id: string, label: string, price?: number, task?: string) {
  return {
    id,
    label,
    task_type: task,
    fields: [] as { name: string; label: string; kind: string }[],
    pricing: { unit: "image" as const, rules: [], default: 0 },
    ...(price == null ? {} : { price_from_usd: price }),
  } as never;
}

const FAMILY: KieModelSpec = {
  id: "seedream-5-pro",
  label: "Seedream 5",
  category: "image",
  media: "image",
  desc: "описания в источниках нет",
  hint: "",
  result: "image",
  fields: [],
  pricing: { unit: "image", rules: [], default: 0 },
  price_from_usd: 0.02,
  modes: [
    mode("t2i-pro", "Pro: текст → картинка", 0.0438, "Text to Image"),
    mode("i2i-pro", "Pro: картинка → картинка", 0.0438, "Image to Image"),
    mode("t2i-flash", "Flash: текст → картинка", 0.02, "Text to Image"),
  ],
} as unknown as KieModelSpec;

const SINGLE: KieModelSpec = {
  id: "nano-banana-2",
  label: "Nano Banana 2",
  category: "image",
  media: "image",
  desc: "",
  result: "image",
  fields: [],
  pricing: { unit: "image", rules: [], default: 5 },
  modes: [mode("t2i", "Текст → картинка")],
} as unknown as KieModelSpec;

const FLAT: KieModelSpec = {
  id: "suno-music",
  label: "Suno — трек",
  category: "audio",
  media: "audio",
  desc: "трек по описанию",
  result: "audio",
  fields: [],
  pricing: { unit: "gen", rules: [{ when: {}, credits: 10 }], default: 10 },
} as unknown as KieModelSpec;

test("слаг строки: семейство и режим, разбор обратно", () => {
  const slug = kieRowSlug("seedream-5-pro", "t2i-pro");
  assert.equal(slug, `kie:seedream-5-pro${KIE_MODE_SEP}t2i-pro`);
  assert.deepEqual(parseKieSlug(slug), { familyId: "seedream-5-pro", modeId: "t2i-pro" });
  assert.deepEqual(parseKieSlug("kie:wan-3-0"), { familyId: "wan-3-0", modeId: null });
  assert.equal(parseKieSlug("veo-3-1-lite"), null);
  // префикс не обязателен: id из сохранённых настроек
  assert.equal(kieRowSlug("kie:wan-3-0", null), "kie:wan-3-0");
});

test("модель с несколькими режимами — одна строка, режимы свёрнуты", () => {
  const rows = familyPickerRows(FAMILY, { creditUsd: 0.005 });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.label, "Seedream 5");
  assert.equal(row.familyId, "seedream-5-pro");
  // стартовый режим — первый из каталога, чипы в доке переключают дальше
  assert.equal(row.modeId, "t2i-pro");
  assert.equal(row.slug, `kie:seedream-5-pro${KIE_MODE_SEP}t2i-pro`);
  // вторая строка — способы генерации, а не название одного режима
  assert.equal(row.desc, "текст → картинка · картинка → картинка");
  // «от $X» — самый дешёвый режим семейства
  assert.equal(row.priceUsd, 0.02);
  assert.equal(row.isTop, false);
  assert.match(String(row.modeSummary), /Pro: текст → картинка/);
});

test("семейство с одним режимом остаётся одной строкой с названием модели", () => {
  const rows = familyPickerRows(SINGLE, { creditUsd: 0.005 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Nano Banana 2");
  assert.equal(rows[0].slug, `kie:nano-banana-2${KIE_MODE_SEP}t2i`);
  assert.equal(rows[0].desc, "Текст → картинка");
});

test("старая плоская запись каталога даёт одну строку без режима", () => {
  const rows = familyPickerRows(FLAT, { creditUsd: 0.005 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, "kie:suno-music");
  assert.equal(rows[0].modeId, null);
  assert.equal(rows[0].media, "audio");
});

test("тип задачи режима — по-русски, направления не дублируются", () => {
  assert.equal(taskTypeRu("Text to Image"), "текст → картинка");
  assert.equal(taskTypeRu("Text to Video, Image to Video"), "текст → видео / картинка → видео");
  assert.equal(taskTypeRu("Something New"), "something new");
  assert.equal(taskTypeRu(""), null);

  const KLING = {
    ...FAMILY,
    id: "kling-3-0",
    label: "Kling 3.0",
    modes: [
      mode("video", "Видео (Pro / Standard / 4K)", 0.09, "Text to Video, Image to Video"),
      mode("motion-control", "Motion Control", 0.09, "Video to Video"),
    ],
  } as unknown as KieModelSpec;
  const [row] = familyPickerRows(KLING, { creditUsd: 0.005 });
  // t2v + i2v + v2v одной модели — по-прежнему одна карточка
  assert.equal(row.label, "Kling 3.0");
  assert.equal(row.desc, "текст → видео · картинка → видео · видео → видео");
});

test("вкладка собирает строки только своей медиа и не дублирует модели", () => {
  const rows = pickerRowsForMedia([FAMILY, SINGLE, FLAT], "image", { creditUsd: 0.005 });
  assert.equal(rows.length, 2); // Seedream 5 + Nano Banana 2, всего две модели
  assert.equal(rows.filter((r) => r.media !== "image").length, 0);
  // одинаковых слагов нет: дубль строки = дубль модели в меню
  assert.equal(new Set(rows.map((r) => r.slug)).size, rows.length);
  assert.equal(mediaOfModel(FLAT), "audio");
});

test("скрытые семейства не попадают в меню, остальные остаются", () => {
  // Решение владельца: картинки Kie-апскейл / Topaz / Suno-обложка / Recraft /
  // OmniHuman / Ideogram и видео Alibaba (HappyHorse) — из выбора модели убраны.
  const hiddenImage = ["kie-image-upscale", "topaz-image-upscale", "suno-cover", "recraft", "omnihuman-1-5-image", "ideogram-v3"];
  const hiddenVideo = ["happyhorse", "happyhorse-1-1"];
  for (const id of [...hiddenImage, ...hiddenVideo]) {
    assert.equal(isFamilyHidden(id), true, id);
  }
  assert.equal(isFamilyHidden("seedream-5-pro"), false);
  // каталог остаётся: скрытие — витрина пикера, а не удаление моделей
  assert.equal(isFamilyHidden("kling-4-0"), false);
  const rows = pickerRowsForMedia([FAMILY, SINGLE, FLAT], "image", { creditUsd: 0.005, query: "recraft" });
  assert.equal(rows.filter((r) => r.familyId === "recraft").length, 0);
});

test("поиск: по названию модели и по режиму — та же одна карточка", () => {
  const byFamily = familyPickerRows(FAMILY, { creditUsd: 0.005, query: "seedream" });
  assert.equal(byFamily.length, 1);
  assert.equal(byFamily[0].label, "Seedream 5");
  const byMode = familyPickerRows(FAMILY, { creditUsd: 0.005, query: "flash" });
  assert.equal(byMode.length, 1);
  assert.equal(byMode[0].label, "Seedream 5");
  // совпал конкретный режим — с него и стартуем
  assert.equal(byMode[0].modeId, "t2i-flash");
  const none = familyPickerRows(FAMILY, { creditUsd: 0.005, query: "несуществующее" });
  assert.equal(none.length, 0);
});
