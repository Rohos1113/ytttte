"use client";

import React, { useMemo, useState } from "react";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Search,
  Table as TableIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface InteractiveTableProps {
  headers: string[];
  rows: string[][];
  title?: string;
  renderCellContent?: (text: string) => React.ReactNode;
}

export function InteractiveTable({
  headers,
  rows,
  title,
  renderCellContent,
}: InteractiveTableProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);
  const [copied, setCopied] = useState(false);
  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const pageSize = 10;

  // Search filtering
  const filteredRows = useMemo(() => {
    if (!searchQuery.trim()) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) =>
      r.some((cell) => cell.toLowerCase().includes(q))
    );
  }, [rows, searchQuery]);

  // Column sorting
  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return filteredRows;

    return [...filteredRows].sort((a, b) => {
      const valA = (a[sortCol] ?? "").trim();
      const valB = (b[sortCol] ?? "").trim();

      // Числовая сортировка (если оба значения — числа или валюта/проценты)
      const cleanA = valA.replace(/[^0-9.,-]/g, "").replace(",", ".");
      const cleanB = valB.replace(/[^0-9.,-]/g, "").replace(",", ".");
      const numA = parseFloat(cleanA);
      const numB = parseFloat(cleanB);

      const bothNumeric =
        !isNaN(numA) &&
        !isNaN(numB) &&
        cleanA.length > 0 &&
        cleanB.length > 0 &&
        /^[-+]?[\d.]+$/.test(cleanA) &&
        /^[-+]?[\d.]+$/.test(cleanB);

      let cmp = 0;
      if (bothNumeric) {
        cmp = numA - numB;
      } else {
        cmp = valA.localeCompare(valB, "ru", { numeric: true, sensitivity: "base" });
      }

      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredRows, sortCol, sortDir]);

  // Pagination
  const totalPages = Math.ceil(sortedRows.length / pageSize) || 1;
  const currentPage = Math.min(page, totalPages);
  const displayedRows = showAll
    ? sortedRows
    : sortedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const handleSort = (colIdx: number) => {
    if (sortCol === colIdx) {
      if (sortDir === "asc") setSortDir("desc");
      else if (sortDir === "desc") {
        setSortCol(null);
        setSortDir(null);
      }
    } else {
      setSortCol(colIdx);
      setSortDir("asc");
    }
  };

  const handleCopyTSV = async () => {
    try {
      const headerLine = headers.join("\t");
      const rowLines = sortedRows.map((r) => r.join("\t")).join("\n");
      const tsv = `${headerLine}\n${rowLines}`;
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  const handleDownloadCSV = () => {
    try {
      const escapeCsvCell = (str: string) => {
        if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes(";")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const headerLine = headers.map(escapeCsvCell).join(";");
      const rowLines = sortedRows.map((r) => r.map(escapeCsvCell).join(";")).join("\r\n");
      const csvContent = `\uFEFF${headerLine}\r\n${rowLines}`; // UTF-8 BOM для корректного открытия в Excel

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title ? title.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, "_") : "table"}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  };

  const renderCell = (cellText: string) => {
    if (renderCellContent) {
      return renderCellContent(cellText);
    }
    return cellText;
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/15 bg-[#121216]/95 shadow-lg group">
      {/* Table Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-white/[0.03] px-3.5 py-2 text-xs">
        <div className="flex items-center gap-2 text-white/80">
          <TableIcon className="h-4 w-4 text-[#2dd4bf]" />
          <span className="font-semibold text-white/95">{title || "Таблица"}</span>
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/40 font-mono">
            {sortedRows.length} {sortedRows.length === 1 ? "строка" : sortedRows.length < 5 ? "строки" : "строк"}
            {headers.length > 0 && ` · ${headers.length} кол.`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search box (when table has > 2 rows) */}
          {rows.length > 2 && (
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2 h-3 w-3 text-white/40" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Поиск по таблице…"
                className="h-6.5 w-32 sm:w-40 rounded-lg border border-white/10 bg-black/40 pl-6 pr-2 text-[11px] text-white placeholder-white/30 outline-none focus:border-[#2dd4bf]/50 focus:ring-1 focus:ring-[#2dd4bf]/30 transition"
              />
            </div>
          )}

          {/* Copy as TSV button */}
          <button
            type="button"
            onClick={handleCopyTSV}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-all outline-none",
              copied
                ? "bg-[#2dd4bf]/20 text-[#2dd4bf] border border-[#2dd4bf]/40"
                : "border border-white/10 bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white"
            )}
            title="Скопировать для вставки в Excel или Google Таблицы"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-[#2dd4bf]" />
                <span>Скопировано (Excel)</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                <span className="hidden sm:inline">Копировать</span>
              </>
            )}
          </button>

          {/* Download CSV button */}
          <button
            type="button"
            onClick={handleDownloadCSV}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-white/70 hover:bg-white/[0.08] hover:text-white transition outline-none"
            title="Скачать файл .CSV (открывается в Excel)"
          >
            <Download className="h-3 w-3" />
            <span className="hidden sm:inline">CSV</span>
          </button>
        </div>
      </div>

      {/* Table Container */}
      <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
        <table className="w-full text-left text-xs text-white/80 border-collapse">
          <thead className="sticky top-0 z-10 border-b border-white/10 bg-[#16171d] font-semibold text-white shadow-sm">
            <tr>
              {headers.map((col, idx) => {
                const isSorted = sortCol === idx;
                return (
                  <th
                    key={idx}
                    onClick={() => handleSort(idx)}
                    className="cursor-pointer select-none px-3.5 py-2.5 hover:bg-white/[0.04] transition-colors whitespace-nowrap"
                    title="Нажмите для сортировки"
                  >
                    <div className="flex items-center gap-1.5 justify-between">
                      <span>{renderCell(col.trim())}</span>
                      <span className="shrink-0 text-white/40">
                        {isSorted ? (
                          sortDir === "asc" ? (
                            <ChevronUp className="h-3.5 w-3.5 text-[#2dd4bf]" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-[#2dd4bf]" />
                          )
                        ) : (
                          <ArrowUpDown className="h-3 w-3 opacity-30 hover:opacity-80 transition" />
                        )}
                      </span>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {displayedRows.length > 0 ? (
              displayedRows.map((row, rIdx) => (
                <tr
                  key={rIdx}
                  className="even:bg-white/[0.015] hover:bg-[#2dd4bf]/[0.06] transition-colors"
                >
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="px-3.5 py-2 leading-relaxed">
                      {renderCell((row[cIdx] ?? "").trim())}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={Math.max(headers.length, 1)}
                  className="px-4 py-8 text-center text-xs text-white/40 italic"
                >
                  {searchQuery ? "Ничего не найдено по запросу" : "Таблица пуста"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {sortedRows.length > pageSize && (
        <div className="flex items-center justify-between border-t border-white/[0.08] bg-white/[0.02] px-3.5 py-1.5 text-[11px] text-white/50">
          <div>
            {showAll ? (
              <span>Все {sortedRows.length} строк</span>
            ) : (
              <span>
                Строки {(currentPage - 1) * pageSize + 1}–
                {Math.min(currentPage * pageSize, sortedRows.length)} из {sortedRows.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="rounded px-2 py-0.5 text-white/60 hover:text-[#2dd4bf] hover:bg-white/[0.04] transition outline-none"
            >
              {showAll ? "Постранично" : `Показать все (${sortedRows.length})`}
            </button>

            {!showAll && totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="rounded p-1 text-white/60 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none transition outline-none"
                  title="Предыдущая страница"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="font-mono text-[10px] text-white/70">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="rounded p-1 text-white/60 hover:text-white hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none transition outline-none"
                  title="Следующая страница"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
