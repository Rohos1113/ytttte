/**
 * Клиентский расчёт цены Create в кредитах.
 */

import { formatUsd } from "./model-settings.ts";

export const TOKEN_USD = 1.0;

type Media = "image" | "video" | "audio";

const IMAGE_BASE: Record<string, number> = {
  "gpt-image-2": 1.95,
  "gpt-image-2-vip": 1.95,
  "gpt-image-2.5": 2.21,
  "gpt-image-2.6": 2.21,
  "nano-banana": 5.27,
  "nano-banana-fast": 5.27,
  "nano-banana-2-lite": 3.50,
  "nano-banana-2": 5.27,
  "nano-banana-2.1": 6.48,
  "nano-banana-pro": 6.08,
  "nano-banana-pro-vt": 6.08,
  "doubao-seedream-5.0-flash": 1.70,
  "doubao-seedream-5.0-pro": 4.08,
  "doubao-seedream-5.5": 1.87,
  "seedream-5-pro": 4.08,
  "seedream-5-lite": 1.70,
};

const VIDEO_BASE: Record<string, number> = {
  "sora-2": 0.8,
  "sora2-portrait": 0.8,
  "sora2-landscape": 0.8,
  "veo3.1-fast": 1.82,
  "veo-3.1-fast": 1.82,
  "veo3.1-pro": 4.05,
  "veo-3-1-lite": 1.82,
  "veo-3-fast": 1.82,
  "kling-4.0-k1": 9.92,
  "kling-3-0": 9.92,
  "kling-2-6": 9.92,
  "seedance-2.0-mini": 2.43,
  "seedance-2-0-mini": 2.43,
  "seedance-2.0-fast": 4.66,
  "seedance-2-0-fast": 4.66,
  "seedance-2.5": 12.56,
  "seedance-2-5": 12.56,
  "seedance-1-5-pro": 3.5,
  "wan3.0-video": 3.06,
  "MiniMax-H3": 1.70,
  "minimax-h3": 1.70,
};

const AUDIO_BASE: Record<string, number> = {
  "suno-5-5": 2.5,
  "elevenlabs-v3": 1,
};

function roundTokens(n: number): number {
  if (n <= 0) return 0;
  return Math.max(0.1, Math.round(n * 100) / 100);
}

/** Токены площадки → кредиты (4 знака внутри). */
export function tokensToUsdClient(tokens: number): number {
  return Math.round(tokens * 10000) / 10000;
}

function parseCatalogPrice(raw?: string | null): number | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase().replace(/^от\s*/, "").replace(",", ".");
  let num = "";
  for (const ch of s) {
    if ((ch >= "0" && ch <= "9") || ch === ".") num += ch;
    else if (num) break;
  }
  if (!num) return null;
  const val = Number(num);
  if (!Number.isFinite(val) || val <= 0) return null;
  if (val < 1) return val / TOKEN_USD;
  return val;
}

/**
 * Цена из каталога outsee (строка в токенах, например «от 3») → клиентская
 * в долларах с наценкой студии. Нужна, чтобы пикер показывал «от $X», а не токены.
 */
export function catalogPriceUsdClient(raw?: string | null): number | null {
  const tokens = parseCatalogPrice(raw ?? null);
  if (tokens == null || tokens <= 0) return null;
  return tokensToUsdClient(tokens);
}

export function estimateCreatePrice(opts: {
  media: Media;
  model: string;
  resolution?: string;
  duration?: number;
  size?: string;
  catalogPrice?: string;
}): { tokens: number; usd: number; usdClient: number; label: string } {
  const { media, model } = opts;
  let base = 0;
  if (media === "image") {
    base = IMAGE_BASE[model] ?? 0;
    const r = (opts.resolution || "1K").toUpperCase();
    if (r === "4K") base *= 2;
    else if (r === "2K" || r === "3K") base *= 1.5;
  } else if (media === "video") {
    base = VIDEO_BASE[model] ?? 0;
    const d = opts.duration || 10;
    if (model.startsWith("sora")) {
      if (d >= 15) base *= 1.5;
      if ((opts.size || "small") === "large") base *= 2;
    } else if (!model.startsWith("veo") && d > 0) {
      base *= Math.max(0.5, d / 5);
    }
  } else {
    base = AUDIO_BASE[model] ?? 0;
  }
  if (base <= 0) {
    const parsed = parseCatalogPrice(opts.catalogPrice);
    base = parsed && parsed > 0 ? parsed : 1;
  }
  const tokens = roundTokens(base);
  /** База в $ без наценки — для внутренних сверок. */
  const usd = Math.round(tokens * TOKEN_USD * 100) / 100;
  const usdClient = tokensToUsdClient(tokens);
  return { tokens, usd, usdClient, label: formatUsd(usdClient) };
}
