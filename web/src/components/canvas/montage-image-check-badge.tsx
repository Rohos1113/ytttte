"use client";

import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Бейдж вердикта проверки картинки кадра (docs/MONTAGE-IMAGE-CHECK.md §11).
 * Лежит в overlay поверх картинки: клики не перехватывает (pointer-events-none),
 * подсказка — нативный title со списком проблем.
 */
export function MontageImageCheckBadge({
  verdict,
  problems,
  onClick,
}: {
  verdict: "pass" | "fail" | "skip";
  problems?: string[];
  /** Если передан — бейдж становится кнопкой (только тогда ловит клики). */
  onClick?: () => void;
}) {
  const list = problems ?? [];
  const n = list.length;
  const title =
    verdict === "pass"
      ? "Проверка: ок"
      : verdict === "skip"
        ? "Проверка: пропущен (нет картинки или мало кадров)"
        : n > 0
          ? `Проверка: проблемы (${n})\n${list.map((p) => `· ${p}`).join("\n")}`
          : "Проверка: проблемы";

  const tone =
    verdict === "pass"
      ? "border-emerald-400/70 bg-emerald-500/90 text-black"
      : verdict === "fail"
        ? "border-red-400/70 bg-red-500/90 text-white"
        : "border-white/30 bg-black/60 text-white/70";

  const inner = (
    <>
      {verdict === "pass" ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : verdict === "fail" ? (
        <AlertTriangle className="h-3.5 w-3.5" />
      ) : (
        <MinusCircle className="h-3.5 w-3.5" />
      )}
      {verdict === "fail" && n > 0 ? (
        <span className="text-[10px] font-semibold leading-none">{n}</span>
      ) : null}
    </>
  );

  const base = cn(
    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 shadow-md shadow-black/40",
    tone,
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cn(base, "pointer-events-auto cursor-pointer hover:brightness-110")}
        title={title}
        onClick={onClick}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {inner}
      </button>
    );
  }

  return (
    <span className={cn(base, "pointer-events-none")} title={title}>
      {inner}
    </span>
  );
}
