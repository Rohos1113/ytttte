import { http } from "@/lib/api";

/**
 * Универсальные таблицы ответа ЛЛМ-ноды.
 *
 * Разбором ответа (JSON → таблицы/параметры) занимается бэкенд:
 * `GET /api/projects/{projectId}/node-llm/{nodeKey}/table?doc=<id>`.
 * Здесь только типы, клиент и сборка CSV/JSON для скачивания — чтобы правила
 * нормализации не разъехались между сервером и панелью.
 */

export type NodeTableColumnType = "text" | "number" | "bool" | "json" | "long_text";

export type NodeTableCellValue = string | number | boolean | null;

export interface NodeTableColumn {
  key: string;
  label: string;
  type: NodeTableColumnType;
}

export interface NodeTableRow {
  [key: string]: NodeTableCellValue | undefined;
}

export interface NodeTable {
  id: string;
  title: string;
  columns: NodeTableColumn[];
  rows: NodeTableRow[];
  /** Сколько строк всего (rows может быть обрезан лимитом сервера). */
  total: number;
  truncated: boolean;
}

export interface NodeTableSource {
  id: string;
  name: string;
  size: number;
  kind: "json" | "text";
  rows: number;
  tables: number;
}

export interface NodeTableParam {
  key: string;
  label: string;
  value: string;
}

export interface NodeTableResponse {
  nodeKey: string;
  nodeType: string;
  label: string;
  sources: NodeTableSource[];
  tables: NodeTable[];
  params: NodeTableParam[];
  warnings: string[];
}

/** Ответ загрузки правок: сколько строк/ячеек обновилось и что не сошлось. */
export interface NodeTableUploadResult {
  updatedRows: number;
  updatedCells: number;
  warnings: string[];
}

const BASE = "/api/projects";

function tableQuery(docId?: string | null): string {
  return docId ? `?doc=${encodeURIComponent(docId)}` : "";
}

/** Текст ошибки из ответа API: `detail` из JSON, иначе тело как есть. */
async function tableErrorText(res: Response): Promise<string> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const detail = parsed?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail != null) return JSON.stringify(detail);
  } catch {
    // не JSON — отдаём текст как есть
  }
  return text.trim() || `HTTP ${res.status}`;
}

/** Отдать blob файлом через a[download]. */
function saveBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function requestTimeoutError(seconds: number): Error {
  return new Error(`Сервер не ответил за ${seconds} с — повторите`);
}

export const nodeTables = {
  /** Таблицы ответа ноды. Без `docId` сервер берёт основной источник ноды. */
  get: (projectId: number, nodeKey: string, docId?: string | null) =>
    http<NodeTableResponse>(
      `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/table${tableQuery(docId)}`,
      {},
      45_000,
    ),

  /**
   * Скачать текущую авто-таблицу ноды в xlsx (файл собирает сервер).
   * При ошибке бросает Error с текстом из `detail`.
   */
  downloadXlsx: async (projectId: number, nodeKey: string, docId?: string | null): Promise<void> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 60_000);
    try {
      let res: Response;
      try {
        res = await fetch(
          `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/table/xlsx${tableQuery(docId)}`,
          {
            signal: controller.signal,
            headers: {
              Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          },
        );
      } catch (e) {
        throw isAbortError(e) ? requestTimeoutError(60) : e;
      }
      if (!res.ok) throw new Error(await tableErrorText(res));
      saveBlobFile(`${safeFileStem(nodeKey)}-table.xlsx`, await res.blob());
    } finally {
      window.clearTimeout(timer);
    }
  },

  /**
   * Правка одной ячейки: сервер пишет значение в JSON-документ ноды (прежняя
   * версия файла уходит в `.bak`) и возвращает сохранённое значение.
   */
  updateCell: async (
    projectId: number,
    nodeKey: string,
    cell: {
      docId?: string | null;
      table: string;
      row: number;
      column: string;
      value: unknown;
    },
  ): Promise<{ value: unknown; changed: boolean; saved: boolean }> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 60_000);
    try {
      let res: Response;
      try {
        res = await fetch(
          `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/table/cell${tableQuery(cell.docId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              table: cell.table,
              row: cell.row,
              column: cell.column,
              value: cell.value,
            }),
            signal: controller.signal,
          },
        );
      } catch (e) {
        throw isAbortError(e) ? requestTimeoutError(60) : e;
      }
      if (!res.ok) throw new Error(await tableErrorText(res));
      const json = (await res.json()) as
        | { value?: unknown; changed?: boolean; saved?: boolean }
        | null;
      return {
        value: json?.value ?? null,
        changed: Boolean(json?.changed),
        saved: Boolean(json?.saved),
      };
    } finally {
      window.clearTimeout(timer);
    }
  },

  /**
   * Загрузить xlsx/json/csv с правками: сервер сверит колонки и строки и обновит
   * значения в документе ноды. Возвращает, сколько строк/ячеек обновлено.
   */
  uploadTable: async (
    projectId: number,
    nodeKey: string,
    docId: string | null | undefined,
    file: File,
  ): Promise<NodeTableUploadResult> => {
    const form = new FormData();
    form.append("file", file);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 120_000);
    try {
      let res: Response;
      try {
        res = await fetch(
          `${BASE}/${projectId}/node-llm/${encodeURIComponent(nodeKey)}/table/upload${tableQuery(docId)}`,
          { method: "POST", body: form, signal: controller.signal },
        );
      } catch (e) {
        throw isAbortError(e) ? requestTimeoutError(120) : e;
      }
      if (!res.ok) throw new Error(await tableErrorText(res));
      const json = (await res.json()) as Partial<NodeTableUploadResult> | null;
      return {
        updatedRows: Number(json?.updatedRows ?? 0) || 0,
        updatedCells: Number(json?.updatedCells ?? 0) || 0,
        warnings: Array.isArray(json?.warnings) ? json.warnings.map((w) => String(w)) : [],
      };
    } finally {
      window.clearTimeout(timer);
    }
  },
};

/** Есть ли что показывать: таблица без строк и без параметров — это «нет данных». */
export function hasNodeTableContent(res: NodeTableResponse | null | undefined): boolean {
  if (!res) return false;
  return res.tables.some((t) => t.rows.length > 0) || res.params.length > 0;
}

/** Суммарное число строк по всем таблицам (по серверному `total`, если он есть). */
export function nodeTablesRowCount(res: NodeTableResponse | null | undefined): number {
  if (!res) return 0;
  return res.tables.reduce(
    (sum, t) => sum + (Number.isFinite(t.total) && t.total > 0 ? t.total : t.rows.length),
    0,
  );
}

/** Значение ячейки как текст: bool по-русски, объекты — компактным JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

const CSV_SEP = ";";
const CSV_BOM = "\uFEFF";

function csvField(text: string): string {
  if (!/[";\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvLine(cells: string[]): string {
  return cells.map(csvField).join(CSV_SEP);
}

/** CSV одной таблицы. Полные значения (обрезает только сервер, до 2000 символов). */
export function buildTableCsv(table: NodeTable): string {
  const lines: string[] = [];
  lines.push(csvLine(table.columns.map((c) => c.label || c.key)));
  for (const row of table.rows) {
    lines.push(csvLine(table.columns.map((c) => cellText(row[c.key]))));
  }
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/**
 * CSV всего ответа. Несколько таблиц и параметры идут секциями: сначала строка
 * с названием, потом сама таблица. Одна таблица без параметров — обычный CSV.
 */
export function buildResponseCsv(res: NodeTableResponse): string {
  const withRows = res.tables.filter((t) => t.columns.length > 0);
  const multi = withRows.length + (res.params.length ? 1 : 0) > 1;
  if (!multi) {
    if (withRows.length === 1) return buildTableCsv(withRows[0]);
    if (res.params.length) {
      const lines = [csvLine(["Параметр", "Ключ", "Значение"])];
      for (const p of res.params) lines.push(csvLine([p.label || p.key, p.key, p.value]));
      return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
    }
    return `${CSV_BOM}`;
  }
  const chunks: string[] = [];
  for (const table of withRows) {
    chunks.push(csvLine([table.title || table.id]));
    chunks.push(csvLine(table.columns.map((c) => c.label || c.key)));
    for (const row of table.rows) {
      chunks.push(csvLine(table.columns.map((c) => cellText(row[c.key]))));
    }
    chunks.push("");
  }
  if (res.params.length) {
    chunks.push(csvLine(["Параметры"]));
    chunks.push(csvLine(["Параметр", "Ключ", "Значение"]));
    for (const p of res.params) chunks.push(csvLine([p.label || p.key, p.key, p.value]));
  }
  return `${CSV_BOM}${chunks.join("\r\n")}`;
}

/** JSON ответа целиком — ровно то, что отдал API (без UI-преобразований). */
export function buildResponseJson(res: NodeTableResponse): string {
  return JSON.stringify(res, null, 2);
}

/** Безопасное имя файла из ключа ноды/таблицы (кириллица и пробелы не ломают загрузку). */
export function safeFileStem(raw: string | null | undefined, fallback = "node"): string {
  const base = String(raw || "").trim() || fallback;
  const stem = base
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || fallback;
}

/** Скачать текст файлом (Blob → a[download]). */
export function downloadTextFile(filename: string, text: string, mime: string): void {
  saveBlobFile(filename, new Blob([text], { type: mime }));
}
