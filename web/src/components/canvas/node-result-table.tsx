"use client";

/**
 * Универсальная таблица «Результата» ЛЛМ-ноды.
 *
 * Показывается во вкладке «Результат» вместо прежнего разбора по типу ноды,
 * когда кнопка «JSON» не нажата. Данные готовит бэкенд
 * (`/node-llm/{nodeKey}/table`), здесь только показ: таблица тянется до низа
 * панели, сортировка по клику на заголовок, «показать ещё», параметры.
 *
 * Если таблиц нет (пустой ответ) или запрос упал — рендерится `fallback`,
 * то есть прежний вид результата ноды. Медиа-ноды этот компонент не используют.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronsUpDown,
  Download,
  Loader2,
  RotateCcw,
  Table2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessageFromUnknown } from "@/lib/error-message";
import {
  cellText,
  hasNodeTableContent,
  nodeTables,
  type NodeTable,
  type NodeTableColumnType,
  type NodeTableResponse,
} from "@/lib/node-tables";
import { cn } from "@/lib/utils";

/** Сколько строк показываем сразу и сколько добавляет «Показать ещё». */
const PAGE_SIZE = 200;
/** Обрезка длинных значений в ячейке до раскрытия по клику. */
const LONG_PREVIEW = 120;
/** Обрезка json-ячейки — она должна читаться в узкой панели. */
const JSON_PREVIEW = 90;

type SortDir = "asc" | "desc";

/** Что сейчас с данными — по этому сигналу панель решает, показывать прежний вид. */
export type NodeTableState = "loading" | "error" | "empty" | "data";

export function NodeResultTable({
  projectId,
  nodeKey,
  nodeType,
  active,
  fallback,
  onState,
}: {
  projectId: number;
  nodeKey: string | null | undefined;
  nodeType?: string | null;
  active: boolean;
  /** Прежний вид «Результата» — на случай пустого ответа или ошибки API. */
  fallback?: ReactNode;
  /**
   * Состояние данных для родителя. Когда оно задано и таблиц нет, компонент
   * сам ничего не рисует про «пусто»: прежний вид результата показывает панель.
   */
  onState?: (state: NodeTableState) => void;
}) {
  const query = useQuery({
    // Префикс ключа — ["node-tables", projectId, nodeKey], по нему можно
    // инвалидировать кэш снаружи.
    queryKey: ["node-tables", projectId, nodeKey],
    queryFn: () => nodeTables.get(projectId, nodeKey!),
    enabled: active && Boolean(nodeKey) && projectId > 0,
    staleTime: 15_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const data: NodeTableResponse | null = query.data ?? null;
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Без docId сервер берёт основной документ ноды — тот же, что у nodeTables.get.
  const onDownloadXlsx = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await nodeTables.downloadXlsx(projectId, nodeKey!, undefined);
      toast.success("xlsx скачан");
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setDownloading(false);
    }
  };

  // Загруженный файл сервер сверяет с таблицей и пишет правки в документ ноды.
  const onUploadFile = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    try {
      const result = await nodeTables.uploadTable(projectId, nodeKey!, undefined, file);
      toast.success(`Обновлено строк: ${result.updatedRows}, ячеек: ${result.updatedCells}`);
      for (const warning of result.warnings.slice(0, 3)) toast.message(warning);
      // Перечитываем таблицу тем же ключом, что у useQuery.
      await qc.invalidateQueries({ queryKey: ["node-tables", projectId, nodeKey] });
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setUploading(false);
    }
  };
  const tables = useMemo(() => (data?.tables ?? []).filter((t) => t.columns.length > 0), [data]);
  const shownTables = useMemo(() => tables.filter((t) => t.rows.length > 0), [tables]);
  const isEmpty = !hasNodeTableContent(data);

  // Сообщаем панели, можно ли показать таблицу вместо прежнего вида результата.
  useEffect(() => {
    if (!onState) return;
    if (query.isLoading) onState("loading");
    else if (query.isError) onState("error");
    else if (isEmpty) onState("empty");
    else onState("data");
  }, [onState, query.isLoading, query.isError, isEmpty]);

  if (query.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2" aria-busy="true" aria-live="polite">
        <div className="h-6 w-40 animate-pulse rounded bg-white/[0.07]" />
        <div className="h-7 w-full animate-pulse rounded bg-white/[0.05]" />
        <div className="h-24 w-full animate-pulse rounded bg-white/[0.04]" />
        <div className="h-24 w-full animate-pulse rounded bg-white/[0.04]" />
        <span className="sr-only">Загрузка таблиц ответа</span>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex shrink-0 items-start gap-2 rounded-[10px] border border-rose-400/25 bg-rose-500/[0.06] px-2.5 py-2 text-[11px] text-rose-200/90">
          <span className="min-w-0 flex-1 break-words">
            Не удалось получить таблицы: {errorMessageFromUnknown(query.error)}
          </span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="flex shrink-0 items-center gap-1 rounded border border-rose-300/30 px-2 py-0.5 text-[10px] transition hover:border-rose-200/60"
          >
            <RotateCcw className="h-3 w-3" />
            Повторить
          </button>
        </div>
        {fallback ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]">{fallback}</div>
        ) : null}
      </div>
    );
  }

  if (isEmpty) {
    // Пустой ответ/нет JSON с массивами — оставляем прежний вид результата.
    if (fallback) return <>{fallback}</>;
    if (onState) return null;
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 py-10 text-center">
        <Table2 className="h-5 w-5 text-zinc-600" />
        <p className="text-[12px] text-zinc-400">Нет структурированных данных</p>
        <p className="text-[10px] text-zinc-600">
          {nodeType ? `Ответ ноды «${nodeType}» пуст или без массивов объектов.` : "Ответ ноды пуст или без массивов объектов."}
        </p>
      </div>
    );
  }

  return (
    <div className="nodrag flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1.5 pb-1.5">
        <button
          type="button"
          onClick={() => void onDownloadXlsx()}
          disabled={downloading}
          title="Скачать текущую таблицу в xlsx"
          className="flex h-7 items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2.5 text-[11px] text-white/85 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          Скачать xlsx
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title="Загрузить xlsx/json/csv с правками"
          className="flex h-7 items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2.5 text-[11px] text-white/85 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Загрузить
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.json,.csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void onUploadFile(file);
          }}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5 [scrollbar-color:hsl(0_0%_55%_/_0.55)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-thumb:hover]:bg-white/40 [&::-webkit-scrollbar-track]:bg-transparent">
        {/* Только основная таблица. Спутниковые коллекции и второй документ
            в «Результат» не выводим — иначе в окне появляется лишняя таблица. */}
        {shownTables.slice(0, 1).map((table) => (
          <TableView key={table.id} table={table} />
        ))}
      </div>
    </div>
  );
}

function TableView({ table }: { table: NodeTable }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // Другая таблица/сортировка — показываем первые 200 строк.
  useEffect(() => {
    setVisible(PAGE_SIZE);
    // Раскрытые ячейки привязаны к позиции строки: после пересортировки они уже не те.
    setExpanded({});
  }, [sortKey, sortDir, table.id]);

  const filtered = useMemo(() => {
    if (!sortKey || !sortDir) return table.rows;
    const sign = sortDir === "asc" ? 1 : -1;
    return [...table.rows].sort((a, b) => sign * compareCells(a[sortKey], b[sortKey]));
  }, [table, sortKey, sortDir]);

  const shown = filtered.slice(0, visible);

  const toggleSort = (key: string) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    if (sortDir === "asc") {
      setSortDir("desc");
      return;
    }
    setSortKey(null);
    setSortDir(null);
  };

  return (
    <div className="flex shrink-0 flex-col rounded-[10px] border border-white/10 bg-black/30">
      <div className="max-h-[calc(100vh-280px)] overflow-auto [scrollbar-color:hsl(0_0%_55%_/_0.5)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent">
        <table className="min-w-max border-collapse text-left text-[11px]">
          <thead className="sticky top-0 z-10 bg-[#121214]">
            <tr>
              {table.columns.map((c) => {
                const activeSort = sortKey === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className="border-b border-white/10 px-2 py-1.5 font-medium align-bottom text-zinc-300"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      title={`Сортировать: ${humanizeColumnLabel(c.label, c.key)}`}
                      className={cn(
                        "flex items-center gap-1 text-left text-[10px] tracking-wide transition",
                        activeSort ? "text-white" : "text-zinc-400 hover:text-white",
                      )}
                    >
                      <span className="max-w-[220px] truncate">{humanizeColumnLabel(c.label, c.key)}</span>
                      {activeSort && sortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3 shrink-0" />
                      ) : activeSort && sortDir === "desc" ? (
                        <ArrowDown className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-40" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-white/[0.06] last:border-0 hover:bg-white/[0.03]">
                {table.columns.map((c) => {
                  const cellKey = `${rowIndex}:${c.key}`;
                  return (
                    <td key={c.key} className="px-2 py-1 align-top text-white/80">
                      <CellValue
                        value={row[c.key]}
                        type={c.type}
                        expanded={Boolean(expanded[cellKey])}
                        onToggle={() => setExpanded((prev) => ({ ...prev, [cellKey]: !prev[cellKey] }))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > visible || table.truncated ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/[0.06] px-2 py-1">
          {filtered.length > visible ? (
            <button
              type="button"
              onClick={() => setVisible((v) => v + PAGE_SIZE)}
              className="flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-zinc-300 transition hover:border-white/30 hover:text-white"
            >
              <ChevronDown className="h-3 w-3" />
              Показать ещё {Math.min(PAGE_SIZE, filtered.length - visible)}
            </button>
          ) : null}
          {table.truncated ? (
            <span className="text-[10px] text-amber-200/50">
              сервер отдал {table.rows.length} из {table.total} строк
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CellValue({
  value,
  type,
  expanded,
  onToggle,
}: {
  value: unknown;
  type: NodeTableColumnType;
  expanded: boolean;
  onToggle: () => void;
}) {
  const text = cellText(value);
  if (!text) return <span className="text-zinc-600">—</span>;

  const isJson = type === "json";
  const limit = isJson ? JSON_PREVIEW : LONG_PREVIEW;
  const cut = text.length > limit;

  // Любая обрезанная ячейка раскрывается по клику целиком и сворачивается обратно.
  if (!cut) {
    return (
      <span
        className={cn(
          "block max-w-[320px] whitespace-pre-wrap break-words",
          isJson && "max-w-[260px] truncate font-mono text-[10px] leading-[1.45] text-cyan-200/80",
          type === "number" && "font-mono text-amber-100/80",
          type === "bool" && "text-emerald-200/80",
        )}
      >
        {isJson ? text.replace(/\s+/g, " ") : text}
      </span>
    );
  }

  const preview = isJson ? text.replace(/\s+/g, " ").slice(0, limit) : text.slice(0, limit);

  return (
    <button
      type="button"
      onClick={onToggle}
      title={expanded ? "Свернуть" : "Показать целиком"}
      className="block w-full max-w-[420px] cursor-pointer text-left"
    >
      {expanded ? (
        <span
          className={cn(
            "block whitespace-pre-wrap break-words text-white",
            isJson && "font-mono text-[10px] leading-[1.45] text-cyan-200/90",
          )}
        >
          {text}
        </span>
      ) : (
        <span
          className={cn(
            "block truncate text-white/80 hover:text-white",
            isJson && "max-w-[260px] font-mono text-[10px] leading-[1.45] text-cyan-200/80",
          )}
        >
          {preview}…
        </span>
      )}
    </button>
  );
}

function compareCells(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "ru", { numeric: true, sensitivity: "base" });
}

const CYRILLIC_RE = /[\u0400-\u04FF]/;
const LATIN_RE = /[A-Za-z]/;

/** Сравниваем ключ и подпись без регистра и разделителей: `FRAME_UUID` ≈ `frame_uuid`. */
function normalizedColumnToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Первая буква заглавная, остальное не трогаем. */
function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Человеческий заголовок колонки.
 *
 * Бэкенд часто отдаёт технический ключ и в `label` (`frame_uuid`, `FRAME_UUID`,
 * `FIELDS.КАДРЫ`, `ЗАКАДР_ПЛАН.НОМЕР`). Показываем словами: разделители →
 * пробелы, точки → « · », латинские слова в нижний регистр, кириллица как есть,
 * первая буква заголовка — заглавная. Сортировка, поиск и скачивание остаются
 * по `key`: здесь меняется только текст.
 */
export function humanizeColumnLabel(
  label: string | null | undefined,
  key: string | null | undefined,
): string {
  const rawKey = String(key ?? "").trim();
  const rawLabel = String(label ?? "").trim();
  // Сервер уже дал человеческую подпись — не переписываем, только первую букву.
  if (rawLabel) {
    const sameAsKey =
      !rawKey || normalizedColumnToken(rawLabel) === normalizedColumnToken(rawKey);
    if (!sameAsKey || /[\s·]/.test(rawLabel)) return capitalizeFirst(rawLabel);
  }
  const source = rawKey || rawLabel;
  if (!source) return "";
  const segments = source
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) =>
      segment
        // camelCase → «camel Case»
        .replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, "$1 $2")
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((word) =>
          LATIN_RE.test(word) && !CYRILLIC_RE.test(word) ? word.toLowerCase() : word,
        )
        .join(" "),
    )
    .filter(Boolean);
  if (!segments.length) return source;
  return capitalizeFirst(segments.join(" · "));
}
