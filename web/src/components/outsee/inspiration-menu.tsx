"use client";

/**
 * «Вдохновение» — кнопка-иконка над фото в окне генерации.
 * Без подписи: понятно по иконке палитры. Открывает каталог стилей
 * (те самые пресеты дока: Фото, Кино, 3D, Аниме, Живопись, Киберпанк, Фэнтези).
 * Выбранный стиль дописывается к промпту при генерации изображения.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { INSPIRATION_STYLES } from "@/lib/inspiration-styles";

type Props = {
  /** id выбранного стиля, "none" — без стиля. */
  value: string;
  onChange: (id: string) => void;
  className?: string;
};

/** Иконка «каталог стилей»: четыре цветных образца, как в палитре. */
function PaletteGlyph({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px]">
      <rect x="2" y="2" width="9" height="9" rx="2.6" fill="#fb923c" opacity={active ? 1 : 0.95} />
      <rect x="13" y="2" width="9" height="9" rx="2.6" fill="#c084fc" opacity={active ? 1 : 0.95} />
      <rect x="2" y="13" width="9" height="9" rx="2.6" fill="#2dd4bf" opacity={active ? 1 : 0.95} />
      <rect x="13" y="13" width="9" height="9" rx="2.6" fill="#f472b6" opacity={active ? 1 : 0.95} />
    </svg>
  );
}

export function InspirationMenu({ value, onChange, className }: Props) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [anchor, setAnchor] = useState({ left: 12, top: 80, width: 430, maxH: 460 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const activeId = value || "none";
  const activeStyle = INSPIRATION_STYLES.find((s) => s.id === activeId) ?? null;
  const hasStyle = activeId !== "none";

  // Позиция меню под кнопкой (портал в body — поверх окна генерации).
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(430, window.innerWidth - 24);
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, r.right - width));
      const top = r.bottom + 8;
      const maxH = Math.max(240, Math.min(window.innerHeight - top - 16, 470));
      setAnchor({ left, top, width, maxH });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Esc и клик мимо — закрыть.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Вдохновение — каталог стилей"
        data-testid="inspiration-button"
        title={
          hasStyle && activeStyle
            ? `Вдохновение — каталог стилей. Выбран: ${activeStyle.label}`
            : "Вдохновение — каталог стилей"
        }
        className={cn(
          "relative inline-flex h-10 w-10 items-center justify-center rounded-xl border backdrop-blur transition",
          open
            ? "border-[#2dd4bf]/70 bg-[#2dd4bf]/20 shadow-[0_0_22px_rgba(45,212,191,0.35)]"
            : "border-white/15 bg-white/[0.05] hover:border-[#2dd4bf]/50 hover:bg-[#2dd4bf]/12",
        )}
      >
        <PaletteGlyph active={open || hasStyle} />
        {hasStyle && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-[#2dd4bf] shadow-[0_0_6px_#2dd4bf]" />
        )}
      </button>

      {open && mounted && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Вдохновение — каталог стилей"
              data-testid="inspiration-menu"
              style={{ left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxH }}
              className="fixed z-[200] flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#0f1015]/98 text-white shadow-[0_24px_70px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
                <PaletteGlyph active />
                <div className="leading-tight">
                  <div className="text-[12px] font-bold">Вдохновение</div>
                  <div className="text-[10px] text-white/45">
                    стиль допишется к промпту при генерации
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/60 transition hover:bg-white/[0.1] hover:text-white"
                  title="Закрыть"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                <div className="grid grid-cols-2 gap-1.5">
                  {INSPIRATION_STYLES.map((s) => {
                    const selected = s.id === activeId;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          onChange(s.id);
                          setOpen(false);
                        }}
                        data-testid={`inspiration-style-${s.id}`}
                        title={s.suffix || "Стиль выключен"}
                        className={cn(
                          "flex items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition",
                          selected
                            ? "border-[#2dd4bf] bg-[#2dd4bf]/10 ring-1 ring-[#2dd4bf]/40"
                            : "border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.07]",
                        )}
                      >
                        <span className="mt-0.5 shrink-0 text-[16px] leading-none">{s.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            <span
                              className={cn(
                                "block text-[12px] font-semibold",
                                selected ? "text-[#2dd4bf]" : "text-white/90",
                              )}
                            >
                              {s.label}
                            </span>
                            {selected && <Check className="h-3 w-3 shrink-0 text-[#2dd4bf]" />}
                          </span>
                          <span className="mt-0.5 block text-[10px] text-white/45">{s.hint}</span>
                          <span className="mt-0.5 block truncate font-mono text-[9px] text-white/25">
                            {s.suffix || "без суффикса"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
