import { http } from "@/lib/api";

/** Документ полного ответа ЛЛМ по ноде — общее окно «JSON ответа». */

export type NodeLlmDocKind = "file" | "project_text" | "meta_json" | "snapshot";

export interface NodeLlmDocument {
  id: string;
  name: string;
  label: string;
  kind: NodeLlmDocKind;
  /** Путь на диске (для файловых документов). */
  path?: string | null;
  /** Размер в байтах (для непрочитанного документа — размер файла). */
  size: number;
  updatedAt?: string | null;
  isJson: boolean;
  /** false — ответа ещё нет, документ-заготовка: сохранение создаст файл. */
  exists: boolean;
  editable: boolean;
  /** Поле проекта для project_text. */
  field?: string | null;
}

export interface NodeLlmDocumentsResponse {
  nodeKey: string;
  nodeType: string;
  label: string;
  llm: boolean;
  documents: NodeLlmDocument[];
}

export interface NodeLlmDocumentText extends NodeLlmDocument {
  text: string;
  chars: number;
}

export interface NodeLlmSaveResponse {
  ok: boolean;
  id: string;
  name: string;
  savedAt: string;
  chars: number;
  size: number;
  kind?: NodeLlmDocKind;
  path?: string | null;
  backup?: string | null;
  field?: string | null;
}

const BASE = "/api/projects";

export const nodeLlmJson = {
  /** Список документов ответа для ноды (файлы ноды + поля проекта/meta). */
  documents: (projectId: number, nodeKey: string) =>
    http<NodeLlmDocumentsResponse>(
      `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/documents`,
      {},
      60_000,
    ),
  /** Полный текст документа — без обрезки до preview из meta. */
  document: (projectId: number, nodeKey: string, docId: string) =>
    http<NodeLlmDocumentText>(
      `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/documents/${encodeURIComponent(docId)}`,
      {},
      60_000,
    ),
  /** Сохранить правку (бэкап старой версии — .bak_llmjson_*). */
  save: (projectId: number, nodeKey: string, docId: string, text: string) =>
    http<NodeLlmSaveResponse>(
      `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/documents/${encodeURIComponent(docId)}`,
      { method: "PUT", body: JSON.stringify({ text }) },
      90_000,
    ),
};

/** Медиа-ноды: генерируют картинки/видео/звук, ответа ЛЛМ у них нет. */
const MEDIA_NODE_TYPES = new Set([
  "images",
  "videos",
  "audio",
  "music",
  "sfx_gen",
  "sfx",
  "assemble",
  "publish",
  "hero_images",
  "items",
  "frames",
]);

/** Типы нод, в которых шаг зовёт LLM: кнопка «JSON ответа» есть до первого прогона. */
export function isLlmNodeType(nodeType: string | null | undefined): boolean {
  const type = String(nodeType || "");
  if (!type) return false;
  if (MEDIA_NODE_TYPES.has(type)) return false;
  if (type.startsWith("sfx_")) return type === "sfx_plan";
  if (type === "excel_gpt" || type.startsWith("enrich")) return true;
  return (
    type === "topic" ||
    type === "plan" ||
    type === "script" ||
    type === "split" ||
    type === "hero" ||
    type === "backgrounds" ||
    type === "scene_design" ||
    type === "sd_agent" ||
    type === "sd_assemble" ||
    type === "style_extract" ||
    type === "image_prompts" ||
    type === "animation_prompts" ||
    type === "check" ||
    type === "report"
  );
}

/** Похоже ли содержимое на JSON (чтобы показать «JSON ок / битый»). */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

export function tryPrettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Показать JSON с отступами, чтобы ответ не был одной длинной строкой. */
export function prettyJsonOrRaw(text: string): string {
  if (!looksLikeJson(text)) return text;
  return tryPrettyJson(text) ?? text;
}
