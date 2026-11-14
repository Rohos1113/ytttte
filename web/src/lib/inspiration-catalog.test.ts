import assert from "node:assert/strict";
import { test } from "node:test";

import { GEN_ASSISTANT_ALL_STYLES, GEN_ASSISTANT_CATEGORIES } from "./gen-assistant-styles.ts";

/** Тот же каталог, что показывает «Вдохновение»: помощник и кнопка берут его из одного места. */
test("каталог стилей помощника цел: категории, уникальные id, непустые ядра", () => {
  assert.ok(GEN_ASSISTANT_CATEGORIES.length > 0, "должны быть категории");
  assert.ok(GEN_ASSISTANT_ALL_STYLES.length >= 30, "в каталоге ожидаем много стилей");

  const ids = GEN_ASSISTANT_ALL_STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id стилей должны быть уникальны");

  for (const style of GEN_ASSISTANT_ALL_STYLES) {
    assert.ok(style.name.trim(), `у стиля ${style.id} нет названия`);
    assert.ok(style.promptCore.trim(), `у стиля ${style.id} нет ядра промпта`);
  }
});

test("каждый стиль лежит хотя бы в одной категории", () => {
  const inCategories = new Set(GEN_ASSISTANT_CATEGORIES.flatMap((c) => c.styles.map((s) => s.id)));
  for (const style of GEN_ASSISTANT_ALL_STYLES) {
    assert.ok(inCategories.has(style.id), `стиль ${style.id} не показан ни в одной категории`);
  }
});
