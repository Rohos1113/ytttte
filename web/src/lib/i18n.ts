"use client";

import { create } from "zustand";

import commonRu from "../locales/ru/common.json" with { type: "json" };
import commonEn from "../locales/en/common.json" with { type: "json" };
import canvasRu from "../locales/ru/canvas.json" with { type: "json" };
import canvasEn from "../locales/en/canvas.json" with { type: "json" };
import sfxRu from "../locales/ru/sfx.json" with { type: "json" };
import sfxEn from "../locales/en/sfx.json" with { type: "json" };
import voicesRu from "../locales/ru/voices.json" with { type: "json" };
import voicesEn from "../locales/en/voices.json" with { type: "json" };
import paramsRu from "../locales/ru/params.json" with { type: "json" };
import paramsEn from "../locales/en/params.json" with { type: "json" };
import hitlRu from "../locales/ru/hitl.json" with { type: "json" };
import hitlEn from "../locales/en/hitl.json" with { type: "json" };
import projectsRu from "../locales/ru/projects.json" with { type: "json" };
import projectsEn from "../locales/en/projects.json" with { type: "json" };

export type Locale = "ru" | "en";

export const LOCALES: Locale[] = ["ru", "en"];
export const DEFAULT_LOCALE: Locale = "ru";
export const LOCALE_STORAGE_KEY = "via:locale";

const DICTIONARIES: Record<Locale, Record<string, unknown>> = {
  ru: {
    common: commonRu,
    canvas: canvasRu,
    sfx: sfxRu,
    voices: voicesRu,
    params: paramsRu,
    hitl: hitlRu,
    projects: projectsRu,
  },
  en: {
    common: commonEn,
    canvas: canvasEn,
    sfx: sfxEn,
    voices: voicesEn,
    params: paramsEn,
    hitl: hitlEn,
    projects: projectsEn,
  },
};

function getStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "ru" || saved === "en") return saved;
    const browserLang = navigator.language?.toLowerCase() || "";
    if (browserLang.startsWith("en")) return "en";
  } catch {
    // LocalStorage может быть заблокирован в incognito/iframe
  }
  return DEFAULT_LOCALE;
}

interface I18nStore {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nStore>((set) => ({
  locale: typeof window !== "undefined" ? getStoredLocale() : DEFAULT_LOCALE,
  setLocale: (locale: Locale) => {
    if (locale !== "ru" && locale !== "en") return;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {}
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
    }
    set({ locale });
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("via:locale-changed", { detail: { locale } }),
      );
    }
  },
}));

function resolveKey(
  dict: Record<string, unknown>,
  path: string,
): string | undefined {
  const parts = path.split(".");
  let current: unknown = dict;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function formatTemplate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return key in params ? String(params[key]) : match;
  });
}

/**
 * Прямой перевод без вызова хука (для чистых функций, форматирования, тестов).
 */
export function getTranslation(
  key: string,
  params?: Record<string, string | number>,
  localeOverride?: Locale,
): string {
  const locale = localeOverride || useI18nStore.getState().locale;
  const currentDict = DICTIONARIES[locale] || DICTIONARIES[DEFAULT_LOCALE];
  const fallbackDict = DICTIONARIES[DEFAULT_LOCALE];

  const translated = resolveKey(currentDict, key);
  if (translated !== undefined) {
    return formatTemplate(translated, params);
  }

  // Строгий откат на дефолтный язык (ru)
  const fallback = resolveKey(fallbackDict, key);
  if (fallback !== undefined) {
    return formatTemplate(fallback, params);
  }

  // Если ключа нет ни в одном словаре — возвращаем сам ключ
  return key;
}

/**
 * Основной хук для компонентов React.
 */
export function useTranslation() {
  const locale = useI18nStore((s) => s.locale);
  const setLocale = useI18nStore((s) => s.setLocale);

  const t = (
    key: string,
    params?: Record<string, string | number>,
  ): string => {
    return getTranslation(key, params, locale);
  };

  return {
    t,
    locale,
    setLocale,
    isRu: locale === "ru",
    isEn: locale === "en",
  };
}
