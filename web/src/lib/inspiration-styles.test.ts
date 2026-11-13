import assert from "node:assert/strict";
import { test } from "node:test";

import { INSPIRATION_STYLES, inspirationStyle } from "./inspiration-styles.ts";

test("стили уникальны по id и у всех есть подпись с иконкой", () => {
  const ids = INSPIRATION_STYLES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id стилей должны быть уникальны");
  for (const s of INSPIRATION_STYLES) {
    assert.ok(s.id.trim(), "у стиля должен быть id");
    assert.ok(s.label.trim(), `у стиля ${s.id} нет подписи`);
    assert.ok(s.icon.trim(), `у стиля ${s.id} нет иконки`);
  }
});

test("«Без стиля» ничего не дописывает, остальные — непустой суффикс", () => {
  const none = inspirationStyle("none");
  assert.ok(none, "стиль none должен существовать");
  assert.equal(none?.suffix, "");
  for (const s of INSPIRATION_STYLES.filter((x) => x.id !== "none")) {
    assert.ok(s.suffix.trim().length > 20, `у стиля ${s.id} пустой суффикс`);
    assert.ok(s.suffix.startsWith(", "), `суффикс ${s.id} должен продолжаться через запятую`);
  }
});

test("неизвестный id не ломает выбор — стиль не найден", () => {
  assert.equal(inspirationStyle("нет-такого"), null);
  assert.equal(inspirationStyle(""), null);
});

test("набор стилей — те самые пресеты старого дока", () => {
  assert.deepEqual(
    INSPIRATION_STYLES.map((s) => s.id),
    ["none", "photo", "cinematic", "3d", "anime", "oil", "cyberpunk", "fantasy"],
  );
});
