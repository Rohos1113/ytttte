import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GEN_ASSISTANT_ALL_STYLES,
  GEN_ASSISTANT_CATEGORIES,
} from "./gen-assistant-styles.ts";
import { FISHER_STYLE_CATEGORIES } from "./gen-assistant-fisher-styles.ts";

/**
 * Каталог «406 стилей» (набор «Рыбак») внутри окна «Генерация» → «Каталог стилей».
 * Файл набора собирается скриптом scripts/build_fisher_style_catalog.py.
 */
test("набор «Рыбак»: 14 категорий, 406 стилей, уникальные id", () => {
  assert.equal(FISHER_STYLE_CATEGORIES.length, 14, "ожидаем 14 категорий набора");

  const styles = FISHER_STYLE_CATEGORIES.flatMap((c) => c.styles);
  assert.equal(styles.length, 406, "ожидаем 406 стилей");

  const ids = styles.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id стилей должны быть уникальны");

  for (const cat of FISHER_STYLE_CATEGORIES) {
    assert.ok(cat.id.startsWith("fisher-"), `категория ${cat.id} должна быть в пространстве fisher-`);
    assert.ok(cat.name.trim(), `у категории ${cat.id} нет названия`);
    assert.ok(cat.styles.length > 0, `категория ${cat.id} пустая`);
  }
});

test("набор «Рыбак»: у каждого стиля есть ядро промпта, описание и обложка", () => {
  for (const cat of FISHER_STYLE_CATEGORIES) {
    for (const style of cat.styles) {
      assert.ok(style.promptCore.trim().length >= 20, `у стиля ${style.id} короткое ядро промпта`);
      assert.ok(style.desc.trim(), `у стиля ${style.id} нет описания`);
      assert.equal(style.cover, `/gen-styles/fisher/${style.id}.webp`, `обложка ${style.id} не по схеме`);
      assert.ok(Array.isArray(style.tags) && style.tags.length > 0, `у стиля ${style.id} нет тегов`);
    }
  }
});

test("каталог генерации = базовые стили + набор «Рыбак», 19 категорий и 438 стилей", () => {
  assert.equal(GEN_ASSISTANT_CATEGORIES.length, 5 + 14);
  assert.equal(GEN_ASSISTANT_ALL_STYLES.length, 32 + 406);

  const ids = GEN_ASSISTANT_ALL_STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id базовых и новых стилей не должны пересекаться");

  const catIds = GEN_ASSISTANT_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(catIds).size, catIds.length, "id категорий должны быть уникальны");
});

