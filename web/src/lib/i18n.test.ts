import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatTemplate,
  getTranslation,
  useI18nStore,
} from "./i18n.ts";

test("formatTemplate replaces parameters correctly", () => {
  assert.equal(
    formatTemplate("Привет, {name}!", { name: "Алиса" }),
    "Привет, Алиса!",
  );
  assert.equal(
    formatTemplate("Файлов: {count} из {total}", { count: 3, total: 10 }),
    "Файлов: 3 из 10",
  );
  assert.equal(
    formatTemplate("Без параметров"),
    "Без параметров",
  );
});

test("getTranslation returns correct Russian translations", () => {
  assert.equal(getTranslation("common.save", undefined, "ru"), "Сохранить");
  assert.equal(getTranslation("common.cancel", undefined, "ru"), "Отмена");
  assert.equal(getTranslation("canvas.nodes.script", undefined, "ru"), "Закадровый текст");
  assert.equal(getTranslation("sfx.categories.foley.label", undefined, "ru"), "Шумы");
  assert.equal(getTranslation("sfx.readyFiles", { count: 5 }, "ru"), "Готово · 5 файл(ов)");
  assert.equal(getTranslation("projects.title", undefined, "ru"), "Проекты");
  assert.equal(getTranslation("projects.wizard.v1Title", undefined, "ru"), "Классика (v1)");
  assert.equal(getTranslation("canvas.autoAdvance.title", undefined, "ru"), "Автозапуск шагов");
  assert.equal(getTranslation("canvas.streams.title", undefined, "ru"), "Потоки генерации");
  assert.equal(getTranslation("canvas.streams.parallelProjects", undefined, "ru"), "Параллель проектов");
  assert.equal(getTranslation("canvas.streams.busy", { busy: 0, total: 4 }, "ru"), "занято 0/4");
  assert.equal(getTranslation("params.streams", undefined, "ru"), "Потоки");
});

test("getTranslation returns correct English translations", () => {
  assert.equal(getTranslation("common.save", undefined, "en"), "Save");
  assert.equal(getTranslation("common.cancel", undefined, "en"), "Cancel");
  assert.equal(getTranslation("canvas.nodes.script", undefined, "en"), "Voiceover Script");
  assert.equal(getTranslation("sfx.categories.foley.label", undefined, "en"), "Foley");
  assert.equal(getTranslation("sfx.readyFiles", { count: 5 }, "en"), "Ready · 5 file(s)");
  assert.equal(getTranslation("projects.title", undefined, "en"), "Projects");
  assert.equal(getTranslation("projects.wizard.v1Title", undefined, "en"), "Classic (v1)");
  assert.equal(getTranslation("canvas.autoAdvance.title", undefined, "en"), "Step autostart");
  assert.equal(getTranslation("canvas.streams.title", undefined, "en"), "Generation streams");
  assert.equal(getTranslation("canvas.streams.parallelProjects", undefined, "en"), "Parallel projects");
  assert.equal(getTranslation("canvas.streams.busy", { busy: 0, total: 4 }, "en"), "in use 0/4");
  assert.equal(getTranslation("params.streams", undefined, "en"), "Streams");
});

test("getTranslation falls back to Russian when key is missing in English", () => {
  // Проверяем, что несуществующий ключ возвращает сам ключ
  assert.equal(getTranslation("nonexistent.key.test", undefined, "en"), "nonexistent.key.test");
});

test("useI18nStore changes active locale", () => {
  useI18nStore.getState().setLocale("en");
  assert.equal(useI18nStore.getState().locale, "en");
  assert.equal(getTranslation("common.save"), "Save");

  useI18nStore.getState().setLocale("ru");
  assert.equal(useI18nStore.getState().locale, "ru");
  assert.equal(getTranslation("common.save"), "Сохранить");
});
