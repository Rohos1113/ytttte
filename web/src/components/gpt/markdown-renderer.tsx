"use client";

import React, { useMemo, useState } from "react";
import { Check, Copy, FileCode, Table as TableIcon, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { InteractiveTable } from "./interactive-table";

interface CodeBlockProps {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const displayLang = (language || "text").toLowerCase();
  const isTabular = displayLang === "tsv" || displayLang === "csv";
  const [viewMode, setViewMode] = useState<"table" | "code">(isTabular ? "table" : "code");

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const lines = code.split("\n");
  const showLineNumbers = lines.length > 2;

  // Парсинг TSV/CSV для интерактивной таблицы
  const tableData = useMemo(() => {
    if (!isTabular) return null;
    const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);
    if (nonEmptyLines.length < 2) return null;
    const delimiter = displayLang === "tsv" ? "\t" : nonEmptyLines[0].includes(";") ? ";" : ",";
    const parsed = nonEmptyLines.map((l) => l.split(delimiter).map((c) => c.trim()));
    if (!parsed[0] || parsed[0].length < 2) return null;
    return {
      headers: parsed[0],
      rows: parsed.slice(1),
    };
  }, [code, isTabular, displayLang]);

  if (isTabular && viewMode === "table" && tableData) {
    return (
      <div className="relative">
        <InteractiveTable
          headers={tableData.headers}
          rows={tableData.rows}
          title={displayLang.toUpperCase()}
          renderCellContent={(cell) => parseInlineFormatting(cell)}
        />
        <div className="flex justify-end -mt-1 mb-2 pr-1">
          <button
            type="button"
            onClick={() => setViewMode("code")}
            className="flex items-center gap-1 text-[11px] text-white/40 hover:text-[#2dd4bf] transition outline-none"
          >
            <FileCode className="h-3 w-3" />
            <span>Показать как исходный код</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/[0.12] bg-[#121216]/95 shadow-lg group">
      <div className="flex items-center justify-between border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 text-xs text-white/60">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-white/70">
          {displayLang === "bash" || displayLang === "sh" || displayLang === "shell" ? (
            <Terminal className="h-3.5 w-3.5 text-[#2dd4bf]" />
          ) : (
            <FileCode className="h-3.5 w-3.5 text-[#2dd4bf]" />
          )}
          <span className="font-semibold">{displayLang}</span>
          <span className="text-[10px] text-white/30 lowercase font-normal">
            ({lines.length} {lines.length === 1 ? "строка" : lines.length < 5 ? "строки" : "строк"})
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isTabular && tableData && (
            <button
              type="button"
              onClick={() => setViewMode("table")}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-white/60 hover:text-[#2dd4bf] hover:bg-white/[0.06] transition outline-none"
              title="Открыть как интерактивную таблицу"
            >
              <TableIcon className="h-3 w-3 text-[#2dd4bf]" />
              <span>Таблица</span>
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-all outline-none",
              copied
                ? "bg-[#2dd4bf]/20 text-[#2dd4bf] border border-[#2dd4bf]/40"
                : "text-white/60 hover:bg-white/[0.08] hover:text-white"
            )}
            title="Копировать код"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-[#2dd4bf]" />
                <span>Скопировано</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span>Копировать код</span>
              </>
            )}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto p-3.5 font-mono text-[12px] leading-relaxed text-white/90 selection:bg-[#2dd4bf]/30">
        {showLineNumbers ? (
          <div className="flex">
            <div className="select-none pr-3 text-right text-white/25 border-r border-white/[0.08] font-mono text-[12px] leading-relaxed">
              {lines.map((_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="m-0 pl-3 whitespace-pre flex-1 font-mono text-[12px] leading-relaxed">{code}</pre>
          </div>
        ) : (
          <pre className="m-0 whitespace-pre font-mono text-[12px] leading-relaxed">{code}</pre>
        )}
      </div>
    </div>
  );
}

function parseInlineFormatting(text: string): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(text.substring(lastIndex, match.index));
    }
    const token = match[0];
    const key = `inline-${match.index}`;

    if (token.startsWith("`") && token.endsWith("`")) {
      elements.push(
        <code
          key={key}
          className="rounded-md border border-[#2dd4bf]/25 bg-[#2dd4bf]/[0.08] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#2dd4bf] break-all break-words [overflow-wrap:anywhere]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      elements.push(
        <strong key={key} className="font-semibold text-white">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      elements.push(
        <em key={key} className="italic text-white/80">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("[") && token.includes("](")) {
      const parts = token.match(/\[(.*?)\]\((.*?)\)/);
      if (parts) {
        elements.push(
          <a
            key={key}
            href={parts[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[#2dd4bf] underline decoration-[#2dd4bf]/40 underline-offset-2 hover:text-[#5eead4] hover:decoration-[#2dd4bf]"
          >
            {parts[1]}
          </a>
        );
      } else {
        elements.push(token);
      }
    } else {
      elements.push(token);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    elements.push(text.substring(lastIndex));
  }

  return elements;
}

export function MarkdownRenderer({ content }: { content: string }) {
  if (!content) return null;

  const lines = content.split("\n");
  const nodes: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  let inTable = false;
  let tableRows: string[][] = [];

  const flushTable = (key: string) => {
    if (tableRows.length === 0) return;
    const header = tableRows[0];
    const body = tableRows.slice(1);

    nodes.push(
      <InteractiveTable
        key={key}
        headers={header}
        rows={body}
        renderCellContent={(cell) => parseInlineFormatting(cell)}
      />
    );
    tableRows = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check code blocks
    if (line.trim().startsWith("```")) {
      if (!inCodeBlock) {
        if (inTable) flushTable(`table-${i}`);
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
        codeBuffer = [];
      } else {
        nodes.push(
          <CodeBlock
            key={`code-${i}`}
            language={codeLang}
            code={codeBuffer.join("\n")}
          />
        );
        inCodeBlock = false;
        codeLang = "";
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Check tables
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) {
        continue;
      }
      const cols = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      tableRows.push(cols);
      inTable = true;
      continue;
    } else if (inTable) {
      flushTable(`table-${i}`);
    }

    // Check # Лист: SheetName (TSV table from GPT / Excel mode)
    if (line.trim().startsWith("# Лист:") || line.trim().startsWith("# Лист：")) {
      if (inTable) flushTable(`table-${i}`);
      const sheetName = line.trim().replace(/^#\s*Лист[:：]\s*/i, "").trim();
      const tsvRows: string[][] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (!nextLine.trim()) {
          if (tsvRows.length > 0) break;
          j++;
          continue;
        }
        if (nextLine.includes("\t")) {
          tsvRows.push(nextLine.split("\t").map((c) => c.trim()));
          j++;
        } else if (tsvRows.length > 0 && nextLine.trim().startsWith("#")) {
          break;
        } else {
          break;
        }
      }
      if (tsvRows.length >= 2) {
        nodes.push(
          <InteractiveTable
            key={`sheet-${i}`}
            title={sheetName ? `Лист: ${sheetName}` : "Таблица Excel"}
            headers={tsvRows[0]}
            rows={tsvRows.slice(1)}
            renderCellContent={(cell) => parseInlineFormatting(cell)}
          />
        );
        i = j - 1;
        continue;
      }
    }

    // Headers
    if (line.startsWith("#### ")) {
      nodes.push(
        <h4 key={i} className="mb-1 mt-3 text-[13px] font-semibold tracking-tight text-white/95">
          {parseInlineFormatting(line.slice(5))}
        </h4>
      );
      continue;
    }
    if (line.startsWith("### ")) {
      nodes.push(
        <h3 key={i} className="mb-1.5 mt-4 text-sm font-bold tracking-tight text-white">
          {parseInlineFormatting(line.slice(4))}
        </h3>
      );
      continue;
    }
    if (line.startsWith("## ")) {
      nodes.push(
        <h2 key={i} className="mb-2 mt-5 text-base font-bold tracking-tight text-white">
          {parseInlineFormatting(line.slice(3))}
        </h2>
      );
      continue;
    }
    if (line.startsWith("# ")) {
      nodes.push(
        <h1 key={i} className="mb-2.5 mt-6 text-lg font-extrabold tracking-tight text-white">
          {parseInlineFormatting(line.slice(2))}
        </h1>
      );
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      nodes.push(
        <blockquote
          key={i}
          className="my-2 border-l-2 border-[#2dd4bf] bg-gradient-to-r from-[#2dd4bf]/10 to-transparent py-1 pl-3 pr-2 text-xs italic text-white/90 rounded-r-md"
        >
          {parseInlineFormatting(line.slice(2))}
        </blockquote>
      );
      continue;
    }

    // Unordered List
    if (/^\s*[-*•]\s+/.test(line)) {
      const content = line.replace(/^\s*[-*•]\s+/, "");
      nodes.push(
        <div key={i} className="my-1 flex items-start gap-2 text-xs leading-relaxed text-white/90 min-w-0">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#2dd4bf] shadow-[0_0_8px_rgba(45,212,191,0.5)]" />
          <div className="flex-1 min-w-0 break-words [overflow-wrap:anywhere]">{parseInlineFormatting(content)}</div>
        </div>
      );
      continue;
    }

    // Numbered List
    if (/^\s*\d+\.\s+/.test(line)) {
      const match = line.match(/^\s*(\d+)\.\s+(.*)$/);
      if (match) {
        nodes.push(
          <div key={i} className="my-1 flex items-start gap-2 text-xs leading-relaxed text-white/90 min-w-0">
            <span className="font-mono text-[11px] font-semibold text-[#2dd4bf] shrink-0">
              {match[1]}.
            </span>
            <div className="flex-1 min-w-0 break-words [overflow-wrap:anywhere]">{parseInlineFormatting(match[2])}</div>
          </div>
        );
        continue;
      }
    }

    // Empty line
    if (!line.trim()) {
      nodes.push(<div key={i} className="h-2" />);
      continue;
    }

    // Regular paragraph
    nodes.push(
      <p key={i} className="my-1 text-xs leading-relaxed text-white/90 break-words [overflow-wrap:anywhere] selection:bg-[#2dd4bf]/30">
        {parseInlineFormatting(line)}
      </p>
    );
  }

  if (inCodeBlock) {
    nodes.push(
      <CodeBlock
        key="code-unfinished"
        language={codeLang}
        code={codeBuffer.join("\n")}
      />
    );
  }
  if (inTable) {
    flushTable("table-unfinished");
  }

  return <div className="space-y-0.5 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]">{nodes}</div>;
}
