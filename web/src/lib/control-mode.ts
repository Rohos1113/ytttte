/** Режим контроля пайплайна: только ИИ (ручной HITL-режим убран). */

import { useI18nStore, type Locale } from "./i18n.ts";

export type ControlMode = "manual" | "ai";

export const AUTO_REVIEW_KINDS = [
  { kind: "approve_plan", label: "Сценарий" },
  { kind: "approve_script", label: "Закадровый текст" },
  { kind: "approve_hero", label: "Персонажи" },
  { kind: "approve_images", label: "Картинки" },
  { kind: "approve_videos", label: "Видео" },
  { kind: "approve_final", label: "Финальный ролик" },
] as const;

export type AutoReviewKind = (typeof AUTO_REVIEW_KINDS)[number]["kind"];

const AUTO_REVIEW_LABELS_EN: Record<string, string> = {
  approve_plan: "Script Plan",
  approve_script: "Voiceover Script",
  approve_hero: "Characters",
  approve_images: "Images",
  approve_videos: "Videos",
  approve_final: "Final Video",
};

export function getAutoReviewKindLabel(kind: string, locale?: Locale): string {
  const loc = locale ?? useI18nStore.getState().locale;
  if (loc === "en") {
    return AUTO_REVIEW_LABELS_EN[kind] ?? kind;
  }
  const item = AUTO_REVIEW_KINDS.find((k) => k.kind === kind);
  return item?.label ?? kind;
}

export function readControlMode(_meta: Record<string, unknown> | undefined): ControlMode {
  return "ai";
}

export function isAiControlMode(_meta: Record<string, unknown> | undefined): boolean {
  return true;
}

export function readAutoReviewKinds(meta: Record<string, unknown> | undefined): string[] {
  const raw = meta?.auto_review_kinds;
  return Array.isArray(raw) ? raw.map(String) : [];
}

export function readAiNewWindowPerCheck(meta: Record<string, unknown> | undefined): boolean {
  return meta?.ai_new_window_per_check === true;
}

/** HITL-kind для типа целевой ноды (для переключателей GPT-проверки на ребре). */
export function autoReviewKindForNodeType(nodeType: string): AutoReviewKind | null {
  const map: Record<string, AutoReviewKind> = {
    plan: "approve_plan",
    script: "approve_script",
    hero: "approve_hero",
    hitl_hero: "approve_hero",
    images: "approve_images",
    hitl_images: "approve_images",
    videos: "approve_videos",
    hitl_videos: "approve_videos",
    assemble: "approve_final",
    hitl_final: "approve_final",
  };
  return map[nodeType] ?? null;
}
