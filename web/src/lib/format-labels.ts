/** Русские подписи для UI — без технических slug с подчёркиваниями. */

import type { ProjectStatus } from "./types";
import type { NodeCategory } from "./node-catalog";
import { useI18nStore, type Locale } from "./i18n.ts";

const PROJECT_STATUS_RU: Partial<Record<ProjectStatus, string>> = {
  new: "новый",
  planning: "сценарий",
  plan_ready: "сценарий готов",
  scripting: "закадровый текст",
  script_ready: "закадровый текст готов",
  splitting: "разбивка",
  frames_ready: "кадры готовы",
  scene_designing: "сцены (агенты)",
  scene_agents_ready: "агенты сцен готовы",
  scene_assembling: "сборка сцен",
  scene_design_ready: "сцены готовы",
  generating_hero: "персонажи",
  hero_ready: "персонажи готовы",
  generating_items: "предметы",
  items_ready: "предметы готовы",
  generating_image_prompts: "промты картинок",
  image_prompts_ready: "промты картинок готовы",
  generating_images: "картинки",
  images_ready: "картинки готовы",
  generating_animation_prompts: "промты анимации",
  animation_prompts_ready: "промты анимации готовы",
  generating_videos: "видео",
  videos_ready: "видео готово",
  generating_audio: "озвучка",
  audio_ready: "озвучка готова",
  assembling: "сборка",
  assembled: "собрано",
  publishing: "публикация",
  published: "опубликовано",
  paused: "пауза",
  failed: "ошибка",
};

const PROJECT_STATUS_EN: Partial<Record<ProjectStatus, string>> = {
  new: "new",
  planning: "script plan",
  plan_ready: "script ready",
  scripting: "voiceover script",
  script_ready: "voiceover ready",
  splitting: "storyboarding",
  frames_ready: "frames ready",
  scene_designing: "scene design (agents)",
  scene_agents_ready: "scene agents ready",
  scene_assembling: "scene assembly",
  scene_design_ready: "scenes ready",
  generating_hero: "characters",
  hero_ready: "characters ready",
  generating_items: "objects",
  items_ready: "objects ready",
  generating_image_prompts: "frame prompts",
  image_prompts_ready: "frame prompts ready",
  generating_images: "images",
  images_ready: "images ready",
  generating_animation_prompts: "video prompts",
  animation_prompts_ready: "video prompts ready",
  generating_videos: "video",
  videos_ready: "video ready",
  generating_audio: "voiceover",
  audio_ready: "voiceover ready",
  assembling: "assembly",
  assembled: "assembled",
  publishing: "publishing",
  published: "published",
  paused: "paused",
  failed: "failed",
};

const NODE_CATEGORY_RU: Record<NodeCategory, string> = {
  planning: "планирование",
  objects: "объекты",
  enrich: "дополнение Excel",
  media: "медиа",
  audio: "аудио",
  assembly: "сборка",
  publish: "публикация",
  hitl: "проверка",
};

const NODE_CATEGORY_EN: Record<NodeCategory, string> = {
  planning: "planning",
  objects: "characters & objects",
  enrich: "scene enrich",
  media: "media",
  audio: "audio",
  assembly: "assembly",
  publish: "publishing",
  hitl: "review",
};

/** WorkflowRunStatus и NodeRunStatus из app/models.py (+ старое completed). */
const RUN_STATUS_RU: Record<string, string> = {
  new: "новый",
  pending: "ожидает",
  queued: "в очереди",
  running: "работает",
  paused: "пауза",
  waiting_hitl: "ждёт проверки",
  done: "готово",
  completed: "завершён",
  skipped: "пропущен",
  cancelled: "отменён",
  failed: "ошибка",
};

const RUN_STATUS_EN: Record<string, string> = {
  new: "new",
  pending: "pending",
  queued: "queued",
  running: "running",
  paused: "paused",
  waiting_hitl: "awaiting review",
  done: "done",
  completed: "completed",
  skipped: "skipped",
  cancelled: "cancelled",
  failed: "failed",
};

const HERO_MODE_RU: Record<string, string> = {
  auto: "авто",
  hero: "с персонажем",
  no_hero: "без персонажа",
};

const HERO_MODE_EN: Record<string, string> = {
  auto: "auto",
  hero: "with character",
  no_hero: "without character",
};

function getActiveLocale(override?: Locale): Locale {
  if (override === "ru" || override === "en") return override;
  try {
    return useI18nStore.getState().locale;
  } catch {
    return "ru";
  }
}

export function formatProjectStatus(status: string, localeOverride?: Locale): string {
  const loc = getActiveLocale(localeOverride);
  const dict = loc === "en" ? PROJECT_STATUS_EN : PROJECT_STATUS_RU;
  return dict[status as ProjectStatus] ?? humanizeSlug(status, loc);
}

export function formatNodeCategory(cat: string, localeOverride?: Locale): string {
  const loc = getActiveLocale(localeOverride);
  const dict = loc === "en" ? NODE_CATEGORY_EN : NODE_CATEGORY_RU;
  return dict[cat as NodeCategory] ?? humanizeSlug(cat, loc);
}

export function formatRunStatus(status: string | null | undefined, localeOverride?: Locale): string {
  if (typeof status !== "string" || status.length === 0) return "";
  const loc = getActiveLocale(localeOverride);
  const dict = loc === "en" ? RUN_STATUS_EN : RUN_STATUS_RU;
  return dict[status] ?? humanizeSlug(status, loc);
}

export function formatHeroMode(mode: string, localeOverride?: Locale): string {
  const loc = getActiveLocale(localeOverride);
  const dict = loc === "en" ? HERO_MODE_EN : HERO_MODE_RU;
  return dict[mode] ?? humanizeSlug(mode, loc);
}

const STEP_CODE_RU: Record<string, string> = {
  plan: "сценарий",
  script: "закадровый текст",
  split: "разбивка",
  scene_d: "сцены (агенты)",
  scene_asm: "сборка сцен",
  sd_char: "агент: персонажи",
  sd_world: "агент: мир",
  sd_style: "агент: стиль",
  sd_cam: "агент: камера",
  sd_act: "агент: действие",
  hero: "персонажи",
  items: "предметы",
  enrich_1: "дополнение 1",
  enrich_2: "дополнение 2",
  enrich_3: "дополнение 3",
  enrich_4: "дополнение 4",
  enrich_5: "дополнение 5",
  img_pr: "промты картинок",
  images: "картинки",
  anim_pr: "промты анимации",
  videos: "видео",
  audio: "озвучка",
  sfx_plan: "план звуков",
  sfx_gen: "звуки (sfx)",
  assemble: "сборка",
  publish: "публикация",
};

const STEP_CODE_EN: Record<string, string> = {
  plan: "script plan",
  script: "voiceover script",
  split: "storyboard",
  scene_d: "scenes (agents)",
  scene_asm: "scene assembly",
  sd_char: "agent: characters",
  sd_world: "agent: world",
  sd_style: "agent: style",
  sd_cam: "agent: camera",
  sd_act: "agent: action",
  hero: "characters",
  items: "objects",
  enrich_1: "enrichment 1",
  enrich_2: "enrichment 2",
  enrich_3: "enrichment 3",
  enrich_4: "enrichment 4",
  enrich_5: "enrichment 5",
  img_pr: "frame prompts",
  images: "images",
  anim_pr: "video prompts",
  videos: "videos",
  audio: "voiceover",
  sfx_plan: "sfx plan",
  sfx_gen: "sfx (audio)",
  assemble: "assembly",
  publish: "publishing",
};

export function formatStepCode(code: string, localeOverride?: Locale): string {
  const loc = getActiveLocale(localeOverride);
  const dict = loc === "en" ? STEP_CODE_EN : STEP_CODE_RU;
  return dict[code] ?? humanizeSlug(code, loc);
}

/** Заменяет _ на пробелы, убирает лишние технические префиксы. */
export function humanizeSlug(value: string | null | undefined, localeOverride?: Locale): string {
  if (typeof value !== "string") return "";
  const loc = getActiveLocale(localeOverride);
  return value
    .replace(/^n_/, "")
    .replace(/_/g, " ")
    .replace(/\bhitl\b/gi, loc === "en" ? "review" : "проверка")
    .replace(/\bgpt\b/gi, "GPT")
    .replace(/\boutsee\b/gi, loc === "en" ? "generator" : "генератор")
    .trim();
}

/**
 * Подпись строки Run в оверлее канваса.
 * null — пустой ответ (`[]`, null) или объект без status-slug: оверлей
 * показывает «не запущен», а не вызывает humanizeSlug(undefined).
 */
export function formatRunOverlayLabel(
  run: unknown,
  projectStatus?: string | null,
  localeOverride?: Locale,
): string | null {
  if (run == null || typeof run !== "object" || Array.isArray(run)) return null;
  const rec = run as { id?: unknown; status?: unknown };
  if (typeof rec.status !== "string" || rec.status.trim() === "") return null;
  if (typeof rec.id !== "number" && typeof rec.id !== "string") return null;
  // Запись прогона остаётся running, когда проект встал на паузу (бюджет, стоп, сбой):
  // «работает» при стоящем проекте вводило в заблуждение.
  const status = rec.status === "running" && projectStatus === "paused" ? "paused" : rec.status;
  const label = formatRunStatus(status, localeOverride);
  if (!label) return null;
  return `#${rec.id} · ${label}`;
}

/** node_runs из ответа /run. Пустой или кривой payload → пустой список, без throw. */
export function nodeRunsFromPayload<T>(run: unknown): T[] {
  if (run == null || typeof run !== "object" || Array.isArray(run)) return [];
  const rows = (run as { node_runs?: unknown }).node_runs;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export function formatNodeKeyLabel(key: string, localeOverride?: Locale): string {
  return humanizeSlug(key, localeOverride);
}

const STYLE_PRESET_RU: Record<string, string> = {
  cats_pixelart_short: "Коты пиксель-арт (shorts)",
  humans_documentary: "Документальный (люди)",
};

const STYLE_PRESET_EN: Record<string, string> = {
  cats_pixelart_short: "Pixel Art Cats (Shorts)",
  humans_documentary: "Documentary (Humans)",
};

export function formatStylePresetLabel(
  preset: { id: string; label?: string },
  localeOverride?: Locale,
): string {
  if (preset.label && !/^[A-Za-z][A-Za-z0-9 _-]+$/.test(preset.label.trim())) {
    return preset.label;
  }
  const loc = getActiveLocale(localeOverride);
  const dict = loc === "en" ? STYLE_PRESET_EN : STYLE_PRESET_RU;
  return dict[preset.id] ?? humanizeSlug(preset.id, loc);
}
