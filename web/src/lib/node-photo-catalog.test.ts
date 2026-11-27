import assert from "node:assert/strict";
import { test } from "node:test";

import { formatProjectStatus } from "./format-labels.ts";
import { mediaOptionsForModel } from "./node-media-options.ts";
import { catalogForNodeType, findCatalogModel, localCatalog } from "./node-model-catalog.ts";

const EXPECTED_PHOTO_IDS = [
  "gpt-image-2",
  "gpt-image-2-5",
  "gpt-image-2-6",
  "nano-banana-2",
  "nano-banana-2-1",
  "seedream-5-pro",
  "seedream-5-flash",
  "seedream-5-5",
  "flux-2-pro",
  "flux-3",
  "qwen3-image",
  "minimax-h3-image",
  "wan-2-7-image",
];

test("formatProjectStatus translates enrich and music statuses without raw slugs", () => {
  assert.equal(formatProjectStatus("enriching_1", "ru"), "редактор сцен 1");
  assert.equal(formatProjectStatus("enrich_1_ready", "ru"), "редактор сцен 1 готов");
  assert.equal(formatProjectStatus("enrich_2_ready", "ru"), "редактор сцен 2 готов");
  assert.equal(formatProjectStatus("generating_music", "ru"), "музыка");
  assert.equal(formatProjectStatus("music_ready", "ru"), "музыка готова");

  assert.equal(formatProjectStatus("enriching_1", "en"), "scene editor 1");
  assert.equal(formatProjectStatus("enrich_1_ready", "en"), "scene editor 1 ready");
  assert.equal(formatProjectStatus("music_ready", "en"), "music ready");
});

test("localCatalog photo models match curated Create tab lineup across hero/items/images nodes", () => {
  const full = localCatalog();
  for (const nodeType of ["hero", "items", "images", "hitl_images"]) {
    const filtered = catalogForNodeType(full, nodeType);
    const ids = filtered.models.map((m) => m.id);
    assert.deepEqual(ids, EXPECTED_PHOTO_IDS);
    assert.ok(!ids.includes("nano-banana-2-lite"));
  }
  assert.equal(findCatalogModel(full, "nano-banana-2-lite")?.id, "nano-banana-2");
  assert.equal(findCatalogModel(full, "flux-2-pro")?.id, "flux-2-pro");
});

test("mediaOptionsForModel supports all 13 curated photo models", () => {
  for (const id of EXPECTED_PHOTO_IDS) {
    const opts = mediaOptionsForModel(id);
    assert.ok(opts, `missing media options for ${id}`);
    assert.ok(opts.resolutions.length > 0, `empty resolutions for ${id}`);
    assert.ok(opts.aspects.length > 0, `empty aspects for ${id}`);
  }
  assert.equal(mediaOptionsForModel("gpt-image-2-6")?.qualities.length, 3);
  assert.equal(mediaOptionsForModel("nano-banana-2-1")?.qualities.length, 0);
  assert.deepEqual(mediaOptionsForModel("seedream-5-flash")?.resolutions, ["1K", "1.5K", "2K"]);
});

const EXPECTED_VIDEO_IDS = [
  "veo-3-1-lite",
  "veo-3-1",
  "seedance-2-0",
  "seedance-2-0-fast",
  "seedance-2-5",
  "kling-2-6",
  "kling-3-0",
  "kling-4-0",
  "hailuo-2-3-i2v",
  "minimax-h3-t2v",
  "wan-3-0",
];

test("localCatalog video models match curated Create tab lineup across videos/hitl_videos nodes", () => {
  const full = localCatalog();
  for (const nodeType of ["videos", "hitl_videos"]) {
    const filtered = catalogForNodeType(full, nodeType);
    const ids = filtered.models.map((m) => m.id);
    assert.deepEqual(ids, EXPECTED_VIDEO_IDS);
  }
});

test("mediaOptionsForModel supports all 11 curated video models", () => {
  for (const id of EXPECTED_VIDEO_IDS) {
    const opts = mediaOptionsForModel(id);
    assert.ok(opts, `missing media options for ${id}`);
    assert.ok(opts.resolutions.length > 0, `empty resolutions for ${id}`);
    assert.ok(opts.aspects.length > 0, `empty aspects for ${id}`);
  }
  assert.deepEqual(mediaOptionsForModel("seedance-2-0-fast")?.resolutions, ["480p", "720p"]);
  assert.deepEqual(mediaOptionsForModel("veo-3-1")?.resolutions, ["720p", "1080p", "4k"]);
});
