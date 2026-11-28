import type { VibecodeSnapshotModel } from "./vibecode-models-snapshot.ts";
import { VIBECODE_MODELS_SNAPSHOT } from "./vibecode-models-snapshot.ts";

export type ModelChannel = "stable";
export type ModelKind = "text" | "image" | "video";
export type ModelVendorId =
  | "anthropic"
  | "openai"
  | "glm"
  | "gemini"
  | "deepseek"
  | "kimi"
  | "xai"
  | "images"
  | "video"
  | "other";

export type RawVibecodePricing = {
  currency?: string;
  input_usd_per_m?: number | null;
  output_usd_per_m?: number | null;
  cache_read_usd_per_m?: number | null;
  cache_create_usd_per_m?: number | null;
  usd_per_image?: number | null;
  usd_per_video?: number | null;
};

export type DisplayPricing = {
  currency: string;
  markup: number;
  input_usd_per_m?: number;
  output_usd_per_m?: number;
  cache_read_usd_per_m?: number;
  cache_create_usd_per_m?: number;
  usd_per_image?: number;
  usd_per_video?: number;
};

export type CatalogModel = {
  id: string;
  label: string;
  vendor: ModelVendorId;
  kind: ModelKind;
  online: boolean;
  is_top?: boolean;
  resolution?: string | null;
  pricing: DisplayPricing;
  api_model: string;
  provider: string;
  image_generator?: string | null;
  video_generator?: string | null;
  channel?: ModelChannel;
};

export type CatalogVendor = {
  id: ModelVendorId | string;
  label: string;
  icon: string;
  count: number;
  models: CatalogModel[];
};

export type ModelCatalogPayload = {
  channel: ModelChannel;
  markup?: number;
  markup_stable?: number;
  vendors: CatalogVendor[];
  models: CatalogModel[];
};

export const PRICE_MARKUP = 1;
export const PRICE_MARKUP_STABLE = PRICE_MARKUP;
export const DEFAULT_TEXT_MODEL_ID = "gpt-6.1-sol";
export const DEFAULT_IMAGE_MODEL_ID = "gpt-image-2";
export const DEFAULT_VIDEO_MODEL_ID = "veo-3-1-lite";
export const IMAGE_NODE_TYPES = new Set(["images", "hero", "items", "hitl_images"]);
export const VIDEO_NODE_TYPES = new Set(["videos", "hitl_videos"]);
export const MEDIA_NODE_TYPES = new Set([
  "images",
  "hero",
  "items",
  "hitl_images",
  "videos",
  "hitl_videos",
]);
export function isTextNodeType(nodeType: string): boolean {
  return !MEDIA_NODE_TYPES.has(nodeType);
}
export const IMAGE_MODEL_ALIASES: Record<string, string> = {
  "gpt-image-2-vip": "gpt-image-2",
  "gpt-image-2.5": "gpt-image-2-5",
  "nano-banana-2-lite": "nano-banana-2",
};
export const HIDDEN_IMAGE_IDS = new Set([
  "nano-banana",
  "nano-banana-2-lite",
  "seedream-4.5",
  "gpt-image-1.5",
]);

export const VENDOR_META: Record<
  Exclude<ModelVendorId, "other">,
  { id: Exclude<ModelVendorId, "other">; label: string; icon: string }
> = {
  anthropic: { id: "anthropic", label: "Anthropic", icon: "A" },
  openai: { id: "openai", label: "OpenAI", icon: "hex" },
  glm: { id: "glm", label: "GLM", icon: "Z" },
  gemini: { id: "gemini", label: "Gemini", icon: "spark" },
  deepseek: { id: "deepseek", label: "DeepSeek", icon: "D" },
  kimi: { id: "kimi", label: "Kimi", icon: "K" },
  xai: { id: "xai", label: "xAI", icon: "X" },
  images: { id: "images", label: "Изображения", icon: "image" },
  video: { id: "video", label: "Видео", icon: "image" },
};

const VENDOR_ORDER: Exclude<ModelVendorId, "other">[] = [
  "anthropic",
  "openai",
  "glm",
  "gemini",
  "deepseek",
  "kimi",
  "xai",
  "images",
  "video",
];

type SnapshotRow = VibecodeSnapshotModel;

function vendorOf(id: string, isImage: boolean, isVideo = false): ModelVendorId {
  if (isVideo) return "video";
  if (isImage) return "images";
  const mid = id.toLowerCase();
  if (mid.startsWith("claude")) return "anthropic";
  if (mid.startsWith("glm")) return "glm";
  if (mid.startsWith("gemini")) return "gemini";
  if (mid.startsWith("deepseek")) return "deepseek";
  if (mid.startsWith("kimi")) return "kimi";
  if (mid.startsWith("grok")) return "xai";
  return "openai";
}

function resolutionBadge(displayName: string, modelId: string): string | null {
  const name = `${displayName} ${modelId}`.toLowerCase();
  if (name.includes("1k/2k/4k") || modelId === "nano-banana-2" || modelId === "nano-banana-pro") {
    return "1K/2K/4K";
  }
  return null;
}

export function markupForChannel(_channel?: ModelChannel | string | null): number {
  return PRICE_MARKUP;
}

export function applyMarkup(
  pricing: RawVibecodePricing | null | undefined,
  _channel: ModelChannel | string = "stable",
): DisplayPricing {
  const factor = PRICE_MARKUP;
  const out: DisplayPricing = { currency: pricing?.currency || "usd", markup: factor };
  const keys = [
    "input_usd_per_m",
    "output_usd_per_m",
    "cache_read_usd_per_m",
    "cache_create_usd_per_m",
    "usd_per_image",
    "usd_per_video",
  ] as const;
  for (const key of keys) {
    const raw = pricing?.[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = Math.round(raw * factor * 1e6) / 1e6;
    }
  }
  return out;
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 0.1) return value.toFixed(2).replace(/\.00$/, ".00");
  if (value >= 0.01) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") || "0";
  return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export function formatUsdPrice(value: number | null | undefined): string {
  const n = formatUsd(value);
  return n === "—" ? n : `${n} кр.`;
}

export function defaultModelIdForNodeType(nodeType: string | null | undefined): string {
  if (IMAGE_NODE_TYPES.has(nodeType || "")) return DEFAULT_IMAGE_MODEL_ID;
  if (VIDEO_NODE_TYPES.has(nodeType || "")) return DEFAULT_VIDEO_MODEL_ID;
  return DEFAULT_TEXT_MODEL_ID;
}

function kindOf(row: SnapshotRow, isVideo = false): ModelKind {
  if (isVideo) return "video";
  return row.is_image ? "image" : "text";
}

const TOP_MODEL_IDS = new Set([
  "seedream-5-pro",
  "gpt-image-2-vip",
  "gpt-image-2",
  "nano-banana-2",
  "seedance-2-5",
  "seedance-1-5-pro",
  "kling-3-0",
  "kling-v3-turbo-t2v",
  "kling-v3-turbo-i2v",
  "kling-3-0-omni-t2v",
  "hailuo-2-3-i2v",
  "wan-2-7-t2v",
  "topaz-video-upscale",
  "veo-3-1-lite",
]);

function imgExtra(
  id: string,
  label: string,
  usdPerImage: number,
  options: { resolution: string; provider: string; isTop?: boolean },
): CatalogModel {
  return {
    id,
    label,
    vendor: "images",
    kind: "image",
    online: true,
    is_top: options.isTop,
    resolution: options.resolution,
    pricing: { currency: "usd", markup: PRICE_MARKUP, usd_per_image: usdPerImage },
    api_model: id,
    provider: options.provider,
    image_generator: id.replace(/-/g, "_"),
    channel: "stable",
  };
}

const IMAGE_EXTRA: CatalogModel[] = [
  imgExtra("gpt-image-2", "GPT Image 2", 0.0375, { resolution: "1K/2K/4K", provider: "52pay / kie", isTop: true }),
  imgExtra("gpt-image-2-5", "GPT Image 2.5", 0.0375, { resolution: "1K/2K/4K", provider: "52pay / kie" }),
  imgExtra("gpt-image-2-6", "GPT Image 2.6", 0.0312, { resolution: "1K/2K/4K", provider: "52pay / kie" }),
  imgExtra("nano-banana-2", "Nano Banana 2", 0.05, { resolution: "1K/2K/4K", provider: "52pay / kie", isTop: true }),
  imgExtra("nano-banana-2-1", "Nano Banana 2.1", 0.025, { resolution: "1K/2K/4K", provider: "52pay / kie" }),
  imgExtra("nano-banana-pro", "Nano Banana Pro", 0.05, { resolution: "1K/2K/4K", provider: "52pay / kie" }),
  imgExtra("seedream-5-pro", "Seedream 5 Pro", 0.0438, { resolution: "1K/1.5K/2K", provider: "52pay / kie", isTop: true }),
  imgExtra("seedream-5-flash", "Seedream 5 Flash", 0.0202, { resolution: "1K/1.5K/2K", provider: "52pay / kie" }),
  imgExtra("seedream-5-5", "Seedream 5.5", 0.0225, { resolution: "1K/1.5K/2K", provider: "52pay / kie" }),
  imgExtra("flux-2-pro", "Flux 2 Pro", 0.035, { resolution: "1K/2K", provider: "kie" }),
  imgExtra("flux-3", "Flux 3", 0.01, { resolution: "1K/2K/4K", provider: "kie" }),
  imgExtra("qwen3-image", "Qwen3 Image", 0.03, { resolution: "1K/2K", provider: "kie" }),
  imgExtra("minimax-h3-image", "MiniMax H3 (картинки)", 0.0112, { resolution: "1K/2K/4K", provider: "kie" }),
  imgExtra("wan-2-7-image", "WAN 2.7 Image", 0.03, { resolution: "1K/2K", provider: "kie" }),
];

function videoExtra(
  id: string,
  label: string,
  usdPerVideo: number,
  provider: string,
): CatalogModel {
  return {
    id,
    label,
    vendor: "video",
    kind: "video",
    online: true,
    pricing: { currency: "usd", markup: PRICE_MARKUP, usd_per_video: usdPerVideo },
    api_model: id,
    provider,
    video_generator: id.replace(/-/g, "_"),
    channel: "stable",
  };
}

const VIDEO_EXTRA: CatalogModel[] = [
  videoExtra("veo-3-1-lite", "Veo 3.1 Fast (52pay)", 0.0182, "52pay"),
  videoExtra("veo-3-1", "Veo 3.1", 0.0312, "kie"),
  videoExtra("seedance-2-0-mini", "Seedance 2.0 Mini", 0.0243, "52pay"),
  videoExtra("seedance-2-0-fast", "Seedance 2.0 Fast", 0.0466, "52pay"),
  videoExtra("seedance-2-5", "Seedance 2.5", 0.1063, "52pay"),
  videoExtra("kling-2-6", "Kling 2.6", 0.0788, "kie"),
  videoExtra("kling-3-0", "Kling 3.0", 0.0944, "kie"),
  videoExtra("kling-4-0", "Kling 4.0", 0.0706, "52pay / kie"),
  videoExtra("hailuo-2-3-i2v", "Hailuo 2.3", 0.1875, "kie"),
  videoExtra("minimax-h3-t2v", "MiniMax H3 (52pay)", 0.0263, "52pay"),
  videoExtra("wan-3-0", "WAN 3.0 (52pay)", 0.0625, "52pay"),
];

function normalizeSnapshot(row: SnapshotRow): CatalogModel {
  const isImage = Boolean(row.is_image);
  const pricing = applyMarkup(row.pricing as RawVibecodePricing);
  const label = (row.id === "gpt-image-2" || row.id === "gpt-image-2-vip") ? "GPT Image 2" : row.display_name.replace(/[-_]vip$/i, "");
  return {
    id: row.id,
    label,
    vendor: vendorOf(row.id, isImage),
    kind: kindOf(row),
    online: true,
    is_top: TOP_MODEL_IDS.has(row.id),
    resolution: resolutionBadge(row.display_name, row.id),
    pricing,
    api_model: row.id,
    provider: isImage ? "outsee" : "52pay",
    channel: "stable",
  };
}

export function localCatalog(): ModelCatalogPayload {
  const models = [
    ...VIBECODE_MODELS_SNAPSHOT.filter((row) => !row.is_image && !HIDDEN_IMAGE_IDS.has(row.id)).map(
      (row) => normalizeSnapshot(row),
    ),
    ...IMAGE_EXTRA,
    ...VIDEO_EXTRA,
  ];
  const vendors: CatalogVendor[] = [];
  for (const vid of VENDOR_ORDER) {
    const items = models.filter((m) => m.vendor === vid);
    if (!items.length) continue;
    vendors.push({ ...VENDOR_META[vid], count: items.length, models: items });
  }
  return {
    channel: "stable",
    markup: PRICE_MARKUP,
    markup_stable: PRICE_MARKUP,
    vendors,
    models,
  };
}

export function catalogForNodeType(
  catalog: ModelCatalogPayload,
  nodeType: string | null | undefined,
): ModelCatalogPayload {
  const kind: ModelKind = IMAGE_NODE_TYPES.has(nodeType || "")
    ? "image"
    : VIDEO_NODE_TYPES.has(nodeType || "")
      ? "video"
      : "text";
  let models = catalog.models.filter((m) => m.kind === kind);
  let vendors = catalog.vendors
    .map((v) => {
      const items = v.models.filter((m) => m.kind === kind);
      return { ...v, models: items, count: items.length };
    })
    .filter((v) => v.count > 0);
  if (models.length === 0 && (kind === "image" || kind === "video")) {
    const loc = localCatalog();
    models = loc.models.filter((m) => m.kind === kind);
    vendors = loc.vendors
      .map((v) => {
        const items = v.models.filter((m) => m.kind === kind);
        return { ...v, models: items, count: items.length };
      })
      .filter((v) => v.count > 0);
  }
  return { ...catalog, models, vendors };
}

export function findCatalogModel(
  catalog: ModelCatalogPayload | null | undefined,
  modelId: string | null | undefined,
): CatalogModel | undefined {
  if (!catalog || !modelId) return undefined;
  let want = IMAGE_MODEL_ALIASES[modelId] || modelId;
  if (want.endsWith("-vibecode")) {
    want = want.slice(0, -9);
  }
  return catalog.models.find((m) => m.id === want || m.id === modelId || m.api_model === want);
}

export function vendorForModel(model: CatalogModel | undefined): ModelVendorId {
  return (model?.vendor as ModelVendorId) || "openai";
}
