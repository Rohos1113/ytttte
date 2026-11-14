"use client";

import * as React from "react";
import { Braces, ChevronDown, ChevronRight, Copy, Table2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Универсальный просмотрщик JSON-ответов: превращает любой JSON в таблицу.
 *
 * Разбор идёт «по форме», а не по схеме:
 *  - массив объектов           → таблица, колонки = объединение ключей;
 *  - объект с массивами        → блок «ключ: значение» + отдельная таблица на каждый массив;
 *  - массив примитивов         → таблица из одной колонки;
 *  - вложенные объекты/массивы → «плоские» колонки вида `obj.field[0].name`;
 *  - что не удалось разложить  → секция «JSON» с полным текстом (ничего не теряется).
 *
 * Строки не обрезаются: ячейка переносит текст, таблица прокручивается, а по клику
 * на строку раскрывается исходный JSON этой строки.
 */

const ROW_CHUNK = 200;
const MAX_COLS = 48;
const MAX_DEPTH = 3;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Сбалансированный JSON-объект/массив, начинающийся ровно в позиции start. */
function balancedFrom(text: string, start: number): string | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Найти в тексте первый сбалансированный JSON-массив/объект. */
function balancedSlice(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  return balancedFrom(text, start);
}

/**
 * Ответы GPT часто склеены из нескольких JSON-документов подряд (батчи:
 * `{...}{...}{...}` или по одному на строку). Разбираем их все, а не первый.
 */
function parseJsonStream(text: string): unknown[] {
  const docs: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (i >= text.length) break;
    const slice = balancedFrom(text, i);
    if (!slice) break;
    try {
      docs.push(JSON.parse(slice) as unknown);
    } catch {
      break;
    }
    i += slice.length;
  }
  return docs;
}

/** Склеить документы: массивы дополняются, объекты объединяются, скаляры — последний. */
function mergeJsonDocs(docs: unknown[]): unknown {
  if (docs.length === 1) return docs[0];
  const objects = docs.filter(isObject);
  if (objects.length === docs.length) {
    const out: JsonObject = {};
    for (const obj of objects) {
      for (const [key, value] of Object.entries(obj)) {
        const prev = out[key];
        if (Array.isArray(prev) && Array.isArray(value)) out[key] = [...prev, ...value];
        else if (isObject(prev) && isObject(value)) out[key] = { ...prev, ...value };
        else out[key] = value;
      }
    }
    return out;
  }
  const arrays = docs.filter(Array.isArray);
  if (arrays.length === docs.length) return arrays.flat();
  return docs;
}

function sameKeySet(a: JsonObject, b: JsonObject): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every((key) => key in b);
}

/**
 * Ответ приходит батчами: несколько одинаковых по структуре документов
 * (`{ops:[…],report:…}{ops:[…],report:…}`, по одному на строку) — их надо
 * склеить в один, иначе видна только часть строк.
 * Настоящий JSONL из строк-записей (без массивов или с разными ключами)
 * оставляем списком.
 */
function looksLikeBatches(docs: unknown[]): boolean {
  if (docs.length < 2) return false;
  if (!docs.every(isObject)) return false;
  const [first, ...rest] = docs as JsonObject[];
  if (!Object.values(first).some(Array.isArray)) return false;
  return rest.every((doc) => sameKeySet(doc, first));
}

function combineDocs(docs: unknown[]): unknown {
  if (docs.length === 1) return docs[0];
  return looksLikeBatches(docs) ? mergeJsonDocs(docs) : docs;
}

export type ParsedJsonPayload = { value: unknown; partial: boolean };

function closers(stack: string[]): string {
  let suffix = "";
  for (let i = stack.length - 1; i >= 0; i -= 1) suffix += stack[i] === "{" ? "}" : "]";
  return suffix;
}

/**
 * Восстановить обрезанный JSON: если текст оборван на середине (превью сервера),
 * отрезаем последний неполный элемент, закрываем скобки и парсим что осталось —
 * так в таблицу попадают все целиком пришедшие строки, а не «сырой» обрывок.
 */
function repairTruncatedJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const body = text.slice(start);

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const commas: Array<{ index: number; stack: string[] }> = [];

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      continue;
    }
    if (ch === ",") commas.push({ index: i, stack: [...stack] });
  }

  const attempts = Math.min(commas.length, 40);
  for (let k = 0; k < attempts; k += 1) {
    const point = commas[commas.length - 1 - k];
    const candidate = body.slice(0, point.index) + closers(point.stack);
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* пробуем предыдущую границу */
    }
  }
  return undefined;
}

/** Разобрать JSON из ответа GPT: чистый JSON, ```json-блок```, JSONL, JSON в тексте, обрезанный JSON. */
export function parseJsonPayload(raw: string): ParsedJsonPayload | null {
  const text = (raw || "").trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced?.[1]?.trim()) candidates.push(fenced[1].trim());
  candidates.push(text);

  // JSONL: по объекту в строке (в т.ч. батчи ответа — combineDocs их склеит).
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => line.startsWith("{") && line.endsWith("}"))) {
    try {
      const docs = lines.map((line) => JSON.parse(line) as unknown);
      return { value: combineDocs(docs), partial: false };
    } catch {
      /* не JSONL — идём дальше */
    }
  }

  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) as unknown, partial: false };
    } catch {
      /* возможно, это несколько документов подряд */
    }
    // Батчи: {…}{…}{…} / по одному документу на строку — объединяем все.
    const docs = parseJsonStream(candidate);
    if (docs.length) {
      return { value: combineDocs(docs), partial: false };
    }
    const slice = balancedSlice(candidate);
    if (slice) {
      try {
        return { value: JSON.parse(slice) as unknown, partial: false };
      } catch {
        /* блок неполный — попробуем восстановить */
      }
    }
    const repaired = repairTruncatedJson(candidate);
    if (repaired !== undefined) return { value: repaired, partial: true };
  }
  return null;
}

function primitiveText(value: unknown): string {
  if (value === null) return "—";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function cellText(value: unknown): string {
  // В ячейках — только человеческий текст, без JSON/кода: вложенные структуры
  // показываем кратко, а раскрываются они отдельными секциями/таблицами.
  if (isObject(value)) {
    return Object.entries(value)
      .map(([key, val]) => `${key}: ${isObject(val) || Array.isArray(val) ? "…" : primitiveText(val)}`)
      .join(" · ");
  }
  if (Array.isArray(value)) {
    if (!value.length) return "—";
    if (value.every((item) => !isObject(item) && !Array.isArray(item))) {
      return value.map((item) => primitiveText(item)).join(" · ");
    }
    return `${value.length} элем.`;
  }
  return primitiveText(value);
}

function flattenRow(
  row: JsonObject,
  prefix: string[],
  out: Record<string, string>,
  depth: number,
): void {
  for (const [key, value] of Object.entries(row)) {
    const path = [...prefix, key];
    if (isObject(value) && depth < MAX_DEPTH && Object.keys(value).length > 0) {
      flattenRow(value, path, out, depth + 1);
      continue;
    }
    out[path.join(".")] = cellText(value);
  }
}

type TableModel = {
  columns: string[];
  rows: string[][];
  values: JsonObject[];
};

function buildTable(items: unknown[]): TableModel {
  const values = items.filter(isObject) as JsonObject[];
  const flatRows = values.map((row) => {
    const flat: Record<string, string> = {};
    flattenRow(row, [], flat, 0);
    return flat;
  });
  const columns: string[] = [];
  for (const flat of flatRows) {
    for (const key of Object.keys(flat)) {
      if (columns.length >= MAX_COLS) break;
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const rows = flatRows.map((flat) => columns.map((column) => flat[column] ?? ""));
  return { columns, rows, values };
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function TableCell({ text }: { text: string }) {
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words align-top leading-relaxed">
      {text || "—"}
    </div>
  );
}

function ObjectTable({ rows }: { rows: JsonObject[] }) {
  const model = React.useMemo(() => buildTable(rows), [rows]);
  const [limit, setLimit] = React.useState(ROW_CHUNK);

  if (!model.values.length) {
    return <p className="text-xs text-muted-foreground">Пустой список.</p>;
  }

  const visible = model.rows.slice(0, limit);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">
          {model.values.length} строк
        </span>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5">
          {model.columns.length} колонок
        </span>
        {model.columns.length >= MAX_COLS ? <span>показаны первые {MAX_COLS} колонок</span> : null}
      </div>
      <div className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 [scrollbar-gutter:stable] [scrollbar-width:thin] [scrollbar-color:hsl(0_0%_55%_/_0.55)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/25 [&::-webkit-scrollbar-thumb:hover]:bg-white/45 [&::-webkit-scrollbar-track]:bg-transparent">
        <table className="w-full border-collapse text-left text-[11px]">
          <thead>
            <tr className="sticky top-0 z-10 bg-[#17171d]">
              <th className="w-10 border-b border-white/10 px-2 py-2 font-medium text-muted-foreground">
                #
              </th>
              {model.columns.map((column) => (
                <th
                  key={column}
                  className="border-b border-white/10 px-2 py-2 align-top font-medium break-words text-foreground/80"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <tr key={index} className="align-top odd:bg-white/[0.02] hover:bg-white/[0.05]">
                <td className="px-2 py-2 font-mono text-[10px] text-muted-foreground">{index + 1}</td>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-2 py-2 align-top text-foreground/90">
                    <TableCell text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {model.rows.length > limit ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setLimit((prev) => prev + ROW_CHUNK)}
        >
          Показать ещё {Math.min(ROW_CHUNK, model.rows.length - limit)} из {model.rows.length}
        </Button>
      ) : null}
    </div>
  );
}

function KeyValueGrid({ entries }: { entries: Array<[string, unknown]> }) {
  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <table className="w-full border-collapse text-left text-[11px]">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key} className="odd:bg-white/[0.02]">
              <td className="w-[220px] border-b border-white/5 px-2 py-1.5 align-top font-medium text-foreground/80">
                {key}
              </td>
              <td className="border-b border-white/5 px-2 py-1.5 align-top text-foreground/90">
                {isObject(value) || Array.isArray(value) ? (
                  <JsonBranch value={value} depth={1} />
                ) : (
                  <span className="whitespace-pre-wrap break-words">{primitiveText(value)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1.5 text-xs font-medium text-foreground/80 hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {title}
      </button>
      {open ? <div className="space-y-2 pl-1">{children}</div> : null}
    </section>
  );
}

function JsonBranch({ value, depth }: { value: unknown; depth: number }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-xs text-muted-foreground">пусто</span>;
    const objectRows = value.filter(isObject) as JsonObject[];
    if (objectRows.length === value.length) {
      return <ObjectTable rows={objectRows} />;
    }
    if (value.every((item) => !isObject(item) && !Array.isArray(item))) {
      return <ObjectTable rows={value.map((item, index) => ({ "#": index + 1, значение: item }))} />;
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-lg border border-white/10 p-2">
            <p className="mb-1 font-mono text-[10px] text-muted-foreground">[{index}]</p>
            <JsonBranch value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (isObject(value)) {
    const scalarEntries = Object.entries(value).filter(
      ([, val]) => !isObject(val) && !Array.isArray(val),
    );
    const complexEntries = Object.entries(value).filter(
      ([, val]) => isObject(val) || Array.isArray(val),
    );
    return (
      <div className="space-y-3">
        {scalarEntries.length ? <KeyValueGrid entries={scalarEntries} /> : null}
        {complexEntries.map(([key, val]) => (
          <Section key={key} title={`${key}${Array.isArray(val) ? ` (${val.length})` : ""}`}>
            <JsonBranch value={val} depth={depth + 1} />
          </Section>
        ))}
      </div>
    );
  }

  return <span className="whitespace-pre-wrap break-words">{primitiveText(value)}</span>;
}

export function JsonTableView({
  value,
  raw,
  className,
  partial,
}: {
  value: unknown;
  raw?: string;
  className?: string;
  /** Ответ пришёл обрезанным (превью сервера) — показываем только целые элементы. */
  partial?: boolean;
}) {
  const [mode, setMode] = React.useState<"table" | "json">("table");
  const text = React.useMemo(() => raw ?? prettyJson(value), [raw, value]);

  const copy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("JSON скопирован");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }, [text]);

  return (
    <div className={cn("space-y-2", className)}>
      {partial ? (
        <p className="rounded-md border border-amber-400/25 bg-amber-400/[0.06] px-2 py-1 text-[11px] text-amber-200/90">
          Ответ пришёл обрезанным (сервер отдал превью) — в таблице только целиком
          пришедшие строки.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-white/10">
          <button
            type="button"
            onClick={() => setMode("table")}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-[11px]",
              mode === "table" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Table2 className="h-3.5 w-3.5" /> Таблица
          </button>
          <button
            type="button"
            onClick={() => setMode("json")}
            className={cn(
              "flex items-center gap-1 px-2 py-1 text-[11px]",
              mode === "json" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Braces className="h-3.5 w-3.5" /> JSON
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">{text.length.toLocaleString("ru-RU")} симв.</span>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px]" onClick={copy}>
          <Copy className="h-3.5 w-3.5" /> Копировать
        </Button>
      </div>

      {mode === "json" ? (
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-[11px] leading-relaxed select-text [scrollbar-gutter:stable] [scrollbar-width:thin] [scrollbar-color:hsl(0_0%_55%_/_0.55)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/25 [&::-webkit-scrollbar-thumb:hover]:bg-white/45 [&::-webkit-scrollbar-track]:bg-transparent">
          {text}
        </pre>
      ) : (
        <JsonBranch value={value} depth={0} />
      )}
    </div>
  );
}
