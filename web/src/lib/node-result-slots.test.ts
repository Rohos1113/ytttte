import assert from "node:assert/strict";
import { test } from "node:test";

import { slotIndexFromItem } from "./node-result-slots.ts";

test("slotIndexFromItem: номер слота из имени файла cN.png", () => {
  assert.equal(slotIndexFromItem({ filePath: "/data/hero/c1.png" }, 99), 0);
  assert.equal(slotIndexFromItem({ filePath: "/data/hero/c3.jpg" }, 99), 2);
  assert.equal(slotIndexFromItem({ filePath: "/data/hero/c12.webp" }, 99), 11);
});

test("slotIndexFromItem: регистр расширения и индекса не важен", () => {
  assert.equal(slotIndexFromItem({ filePath: "/data/hero/C7.PNG" }, 99), 6);
  assert.equal(slotIndexFromItem({ filePath: "/data/hero/c5.JPeG" }, 99), 4);
});

test("slotIndexFromItem: ищет также в подписи и превью", () => {
  assert.equal(slotIndexFromItem({ label: "c4.png" }, 99), 3);
  assert.equal(slotIndexFromItem({ previewUrl: "/api/files?path=/data/c9.png" }, 99), 8);
});

test("slotIndexFromItem: frameNumber — запасной вариант, когда в имени нет cN", () => {
  assert.equal(slotIndexFromItem({ filePath: "/data/character_draft.png", frameNumber: 5 }, 99), 4);
});

test("slotIndexFromItem: имя файла важнее frameNumber", () => {
  assert.equal(slotIndexFromItem({ filePath: "/data/c2.png", frameNumber: 9 }, 99), 1);
});

test("slotIndexFromItem: без подсказок берётся позиция в списке", () => {
  assert.equal(slotIndexFromItem({}, 3), 3);
  assert.equal(slotIndexFromItem({ filePath: null, label: null, previewUrl: null }, 7), 7);
});

test("slotIndexFromItem: вырожденные номера не дают отрицательный слот", () => {
  assert.equal(slotIndexFromItem({ filePath: "/data/c0.png" }, 99), 0);
  assert.equal(slotIndexFromItem({ frameNumber: 0 }, 5), 5);
  assert.equal(slotIndexFromItem({ frameNumber: -2 }, 5), 5);
});

test("slotIndexFromItem: cN с четырьмя цифрами не считается номером кадра", () => {
  assert.equal(slotIndexFromItem({ filePath: "/data/c1000.png" }, 42), 42);
});
