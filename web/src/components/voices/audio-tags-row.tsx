"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Sparkles } from "lucide-react";
import { AUDIO_TAG_CATEGORIES } from "@/lib/audio-tags";

type Props = {
  onInsertTag: (tag: string) => void;
};

/**
 * Строка «Аудио-теги» для окна «Параметры»: категории и моно-чипы справа.
 *
 * Компонент ничего не знает про поле ввода: он отдаёт тег колбэком, а вставку в
 * позицию курсора делает тот, кто его встраивает.
 */
export function AudioTagsRow({ onInsertTag }: Props) {
  const [open, setOpen] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState(AUDIO_TAG_CATEGORIES[0]?.id ?? "mood");
  /**
   * Список рисуется порталом в body с fixed-координатами: окно «Параметры»
   * скроллится, и абсолютная выпадашка справа обрезалась бы его границей.
   */
  const [pos, setPos] = useState<{ top: number; left: number; height: number } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Клик вне и Escape закрывают список.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Прокрутка/ресайз сдвигают строку — fixed-координаты устаревают, закрываем.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const activeCategory =
    AUDIO_TAG_CATEGORIES.find((c) => c.id === activeCategoryId) ?? AUDIO_TAG_CATEGORIES[0];

  const toggle = () => {
    if (!open) {
      // Низ меню — ровно по низу «Параметров».
      const panel = rowRef.current?.closest("[data-params-panel]");
      const rect = (panel instanceof HTMLElement ? panel : rowRef.current)?.getBoundingClientRect();
      if (rect) {
        const gap = 8;
        const width = 300;
        const height = Math.max(300, Math.min(rect.height * 1.5, rect.bottom - 8));
        const top = Math.max(8, rect.bottom - height);
        const left = Math.max(8, Math.min(rect.right + gap, window.innerWidth - width - 12));
        setPos({ top, left, height });
      }
    }
    setOpen((prev) => !prev);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={rowRef}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-[12px] text-white/80 transition hover:border-white/15 hover:bg-white/[0.06]"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#2dd4bf]" />
          <span className="shrink-0 text-white/55">Аудио-теги</span>
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">Эмоции и звуки</span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-white/40 transition ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && pos
        ? createPortal(
        <div
          ref={panelRef}
          data-params-flyout="true"
          style={{ position: "fixed", top: pos.top, left: pos.left, height: pos.height }}
          className="z-[1200] flex w-[300px] flex-col overflow-hidden rounded-xl border border-white/15 bg-[#121216]/[0.97] p-2 shadow-xl backdrop-blur"
        >
          <div className="mb-2">
            <p className="text-[12px] font-semibold text-white/85">Аудио-теги</p>
            <p className="text-[10px] text-white/40">Вставляется в позицию курсора</p>
          </div>

          {/* Категории */}
          <div className="mb-2 flex flex-wrap gap-1">
            {AUDIO_TAG_CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategoryId(category.id)}
                title={`${category.label}: ${category.tags.length} тегов`}
                className={`rounded-lg px-1.5 py-1 text-[10.5px] font-medium transition ${
                  category.id === activeCategory?.id
                    ? "bg-[#2dd4bf]/15 text-[#2dd4bf] ring-1 ring-inset ring-[#2dd4bf]/30"
                    : "bg-white/[0.03] text-white/55 hover:bg-white/[0.07] hover:text-white"
                }`}
              >
                {category.label}
              </button>
            ))}
          </div>

          {/* Теги активной категории */}
          <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto">
            {(activeCategory?.tags ?? []).map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => {
                  onInsertTag(tag);
                  setOpen(false);
                }}
                title={`Вставить ${tag} в позицию курсора`}
                className="inline-flex items-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-white/80 transition hover:border-[#2dd4bf]/60 hover:bg-[#2dd4bf]/15 hover:text-[#2dd4bf] active:scale-95"
              >
                {tag}
              </button>
            ))}
          </div>
        </div>,
            document.body,
          )
        : null}
    </div>
  );
}
