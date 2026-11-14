import assert from "node:assert/strict";
import { test } from "node:test";

import type { KieField } from "./api.ts";
import {
  REF_KIND_LABEL,
  framesFromKieValues,
  nameFromUrl,
  refToken,
  refsFromKieFields,
} from "./gen-dock-refs.ts";

function field(name: string, kind: KieField["kind"], max_items?: number): KieField {
  return { name, label: name, kind, max_items };
}

test("refToken: имя файла без пути и расширения — это токен для «@»", () => {
  assert.equal(refToken("ref.png"), "ref");
  assert.equal(refToken("C:\\pics\\my photo.JPG"), "my_photo");
  assert.equal(refToken("/srv/files/hero.one.webp"), "hero.one");
  assert.equal(refToken("без-точки"), "без-точки");
});

test("refToken: пустое имя и точки без расширения не ломают токен", () => {
  assert.equal(refToken(""), "ref");
  assert.equal(refToken(".hidden"), ".hidden");
  assert.equal(refToken("   "), "_");
});

test("refToken: длинное имя обрезается до 40 символов", () => {
  const long = `${"x".repeat(50)}.png`;
  assert.equal(refToken(long), "x".repeat(40));
});

test("nameFromUrl: последний сегмент пути без query", () => {
  assert.equal(nameFromUrl("https://cdn.example.com/pics/hero.png?token=1"), "hero.png");
  assert.equal(nameFromUrl("/api/files?path=/data/hero.png"), "files");
  assert.equal(nameFromUrl("https://cdn.example.com/pics/hero%20one.png"), "hero one.png");
});

test("nameFromUrl: вырожденные случаи не бросают исключение", () => {
  assert.equal(nameFromUrl(""), "");
  assert.equal(nameFromUrl("https://cdn.example.com/pics/"), "pics");
  // Битая percent-последовательность — возвращаем исходный URL, а не падаем.
  assert.equal(nameFromUrl("https://cdn.example.com/%E0%A4%A"), "https://cdn.example.com/%E0%A4%A");
});

test("REF_KIND_LABEL: подписи категорий", () => {
  assert.deepEqual(REF_KIND_LABEL, { image: "Фото", video: "Видео", audio: "Аудио" });
});

test("refsFromKieFields: референсы по категориям с номерами и лимитами", () => {
  const fields = [field("images", "images", 4), field("videos", "videos"), field("prompt", "textarea")];
  const values = {
    images: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png", ""],
    videos: ["https://cdn.example.com/v.mp4"],
    prompt: "текст, не референс",
  };
  const names = { images: ["a-real.png"] };

  const refs = refsFromKieFields(fields, values, names);

  assert.equal(refs.length, 3);
  assert.deepEqual(refs[0], {
    id: "images:0",
    field: "images",
    url: "https://cdn.example.com/a.png",
    name: "a-real.png",
    kind: "image",
    categoryIndex: 1,
    categoryMax: 4,
  });
  // Имя не задано — берём из URL; пустая строка в значениях пропущена.
  assert.equal(refs[1].name, "b.png");
  assert.equal(refs[1].categoryIndex, 2);
  assert.equal(refs[2].id, "videos:0");
  assert.equal(refs[2].kind, "video");
  assert.equal(refs[2].name, "v.mp4");
  // Без max_items лимит по умолчанию 99.
  assert.equal(refs[2].categoryMax, 99);
});

test("refsFromKieFields: не-массивы и не-строки не считаются референсами", () => {
  const fields = [field("images", "images"), field("videos", "videos")];
  const values = { images: "https://cdn.example.com/a.png", videos: ["https://cdn.example.com/v.mp4", 42, null] };

  const refs = refsFromKieFields(fields, values, {});

  assert.equal(refs.length, 1);
  assert.equal(refs[0].url, "https://cdn.example.com/v.mp4");
});

test("framesFromKieValues: только первый и последний кадр, лимит 1", () => {
  const fields = [
    field("first_frame_url", "images"),
    field("last_frame_url", "images"),
    field("prompt", "textarea"),
  ];
  const values = {
    first_frame_url: ["https://cdn.example.com/first.png"],
    last_frame_url: ["https://cdn.example.com/last.png"],
  };
  const names = { last_frame_url: ["last-real.png"] };

  const refs = framesFromKieValues(fields, values, names);

  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], {
    id: "first_frame_url:0",
    field: "first_frame_url",
    url: "https://cdn.example.com/first.png",
    name: "first.png",
    kind: "image",
    categoryIndex: 1,
    categoryMax: 1,
  });
  assert.equal(refs[1].name, "last-real.png");
  assert.equal(refs[1].categoryMax, 1);
});

test("framesFromKieValues: кадр без поля модели не появляется", () => {
  const fields = [field("last_frame_url", "images")];
  const values = {
    first_frame_url: ["https://cdn.example.com/first.png"],
    last_frame_url: [],
  };

  assert.deepEqual(framesFromKieValues(fields, values, {}), []);
});
