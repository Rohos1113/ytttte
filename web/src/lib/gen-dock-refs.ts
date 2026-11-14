/**
 * Чистая часть дока «Генерация» (перенос из webtest2): имена референсов,
 * «@»-токены для поля промта и сборка референсов из полей KIE-модели.
 *
 * Вынесено из `components/outsee/gen-dock-parts.tsx` без изменения поведения —
 * только чтобы @-меню и счётчики «N/M» можно было покрыть юнит-тестами.
 */

import type { KieField } from "./api";

export type RefKind = "image" | "video" | "audio";

export type GenRef = {
  /** Уникальный ключ: `<field>:<index>`. */
  id: string;
  /** Имя поля KIE-модели, из которого пришёл референс. */
  field: string;
  url: string;
  /** Фактическое имя (имя загруженного файла), а не «Реф #N». */
  name: string;
  kind: RefKind;
  /** Порядковый номер внутри своей категории, с 1. */
  categoryIndex: number;
  /** Всего слотов в категории (для счётчика «N/M»). */
  categoryMax: number;
};

const KIND_BY_FIELD_KIND: Record<string, RefKind> = {
  images: "image",
  videos: "video",
  audios: "audio",
};

export const REF_KIND_LABEL: Record<RefKind, string> = {
  image: "Фото",
  video: "Видео",
  audio: "Аудио",
};

/** Имя файла без расширения — то, что уходит в промт после «@». */
export function refToken(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() || name || "ref";
  const dot = base.lastIndexOf(".");
  const raw = dot > 0 ? base.slice(0, dot) : base;
  return raw.replace(/\s+/g, "_").slice(0, 40) || "ref";
}

/** Имя из URL, когда файл пришёл ссылкой: последний сегмент пути. */
export function nameFromUrl(url: string): string {
  try {
    const clean = url.split("?")[0] ?? url;
    const seg = clean.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : url;
  } catch {
    return url;
  }
}

/**
 * Собирает референсы из значений KIE-модели. Параллельно с URL держим имена:
 * `names[field][i]` — фактическое имя i-го вложения (после загрузки файла).
 */
export function refsFromKieFields(
  fields: KieField[],
  values: Record<string, unknown>,
  names: Record<string, string[]>,
): GenRef[] {
  const out: GenRef[] = [];
  for (const f of fields) {
    const kind = KIND_BY_FIELD_KIND[f.kind];
    if (!kind) continue;
    const raw = values[f.name];
    const urls = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && !!u) : [];
    const fieldNames = names[f.name] || [];
    urls.forEach((url, i) => {
      out.push({
        id: `${f.name}:${i}`,
        field: f.name,
        url,
        name: fieldNames[i] || nameFromUrl(url),
        kind,
        categoryIndex: i + 1,
        categoryMax: f.max_items ?? 99,
      });
    });
  }
  return out;
}

/** Кадры «первый / последний» в режиме Первый+Последний. */
export function framesFromKieValues(
  fields: KieField[],
  values: Record<string, unknown>,
  names: Record<string, string[]>,
): GenRef[] {
  const out: GenRef[] = [];
  const add = (field: string, kind: RefKind) => {
    const raw = values[field];
    const urls = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && !!u) : [];
    urls.forEach((url, i) => {
      out.push({
        id: `${field}:${i}`,
        field,
        url,
        name: (names[field] || [])[i] || nameFromUrl(url),
        kind,
        categoryIndex: i + 1,
        categoryMax: 1,
      });
    });
  };
  if (fields.some((f) => f.name === "first_frame_url")) add("first_frame_url", "image");
  if (fields.some((f) => f.name === "last_frame_url")) add("last_frame_url", "image");
  return out;
}
