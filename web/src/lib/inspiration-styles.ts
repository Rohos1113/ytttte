/**
 * «Вдохновение» — тот же каталог стилей, что и в окне «Помощник» над промптом.
 * Источник один: lib/gen-assistant-styles. Здесь только адаптер и ключи localStorage,
 * чтобы выбранный стиль был общим для кнопки и панели помощника.
 */

import {
  GEN_ASSISTANT_ALL_STYLES,
  GEN_ASSISTANT_CATEGORIES,
  type GenCategoryDef,
  type GenStyleDef,
} from "./gen-assistant-styles";

export type { GenCategoryDef, GenStyleDef };

export const INSPIRATION_CATEGORIES: GenCategoryDef[] = GEN_ASSISTANT_CATEGORIES;
export const INSPIRATION_STYLES: GenStyleDef[] = GEN_ASSISTANT_ALL_STYLES;

/** Ключи ровно те же, что пишет панель помощника. */
export const INSPIRATION_LS_STYLE = "genAssistant.style";
export const INSPIRATION_LS_CATEGORY = "genAssistant.category";
export const INSPIRATION_ART_PREFIX = "genAssistant.styleArt.";

export function inspirationStyle(id: string): GenStyleDef | null {
  if (!id) return null;
  return GEN_ASSISTANT_ALL_STYLES.find((s) => s.id === id) ?? null;
}

/** Суффикс к промпту при генерации фото: ядро стиля из библиотеки промптов. */
export function inspirationPromptSuffix(style: GenStyleDef | null): string {
  const core = style?.promptCore?.trim();
  return core ? `, ${core}` : "";
}
