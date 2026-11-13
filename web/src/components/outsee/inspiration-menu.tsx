"use client";

/**
 * «Вдохновение» — кнопка над вертикальными «Фото / Видео / Аудио» и каталог стилей
 * в том же виде, что в окне помощника над промптом (категории + плитки с обложками).
 * Выбранный стиль пишется в те же ключи localStorage, что и панель помощника,
 * и дописывается к промпту фото при генерации.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import { toast } from "sonner";

import { GenStyleArt as GenStyleArtView } from "@/components/outsee/gen-style-art";
import { GEN_STYLE_COLORS } from "@/lib/gen-assistant-styles";
import {
  INSPIRATION_ART_PREFIX,
  INSPIRATION_CATEGORIES,
  INSPIRATION_LS_CATEGORY,
  INSPIRATION_LS_STYLE,
  INSPIRATION_STYLES,
  inspirationStyle,
  type GenStyleDef,
} from "@/lib/inspiration-styles";
import { cn } from "@/lib/utils";

const PANEL_W = 760;

/** Обложки, которые пользователь уже сгенерировал в помощнике (genAssistant.styleArt.<id>). */
function readArtUrls(): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === "undefined") return out;
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(INSPIRATION_ART_PREFIX)) continue;
      const value = window.localStorage.getItem(key);
      if (value) out[key.slice(INSPIRATION_ART_PREFIX.length)] = value;
    }
  } catch {
    /* приватный режим — просто без обложек */
  }
  return out;
}

function SwatchGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="0.5" y="0.5" width="8.5" height="8.5" rx="2.5" fill="#fb923c" />
      <rect x="11" y="0.5" width="8.5" height="8.5" rx="2.5" fill="#c084fc" />
      <rect x="0.5" y="11" width="8.5" height="8.5" rx="2.5" fill="#2dd4bf" />
      <rect x="11" y="11" width="8.5" height="8.5" rx="2.5" fill="#f472b6" />
    </svg>
  );
}

function StyleTile({
  style,
  artUrl,
  selected,
  onPick,
}: {
  style: GenStyleDef;
  artUrl?: string;
  selected: boolean;
  onPick: () => void;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  const cover = !imgBroken ? (artUrl ?? style.cover) : undefined;
  const dot = GEN_STYLE_COLORS[style.color] ?? GEN_STYLE_COLORS.cyan;

  return (
    <button
      type="button"
      role="button"
      data-testid={`inspiration-style-${style.id}`}
      data-style-id={style.id}
      onClick={onPick}
      title={style.desc}
      className={cn(
        "group relative h-[116px] overflow-hidden rounded-xl border text-left transition-all duration-200",
        selected
          ? "border-[#2dd4bf] ring-2 ring-[#2dd4bf]/40 shadow-[0_0_20px_rgba(45,212,191,0.3)]"
          : "border-white/10 hover:border-white/30",
      )}
    >
      <div className="absolute inset-0 flex items-center justify-center bg-[#16161c]">
        <div className="max-h-[80%] max-w-[80%] opacity-90">
          <GenStyleArtView art={style.art} color={style.color} />
        </div>
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => setImgBroken(true)}
          />
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2 pt-8 pb-1.5">
        <div className="line-clamp-1 text-[12px] font-bold text-white">{style.name}</div>
        <div className="line-clamp-1 text-[10px] text-white/55">{style.desc}</div>
      </div>
      <span
        className="absolute top-1.5 left-1.5 h-2 w-2 rounded-full border border-black/40"
        style={{ backgroundColor: dot }}
      />
      {selected ? (
        <span className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-[#2dd4bf] px-1 py-0.5 text-[9px] font-bold text-black">
          <Check className="h-2.5 w-2.5" /> выбран
        </span>
      ) : null}
    </button>
  );
}

export function InspirationMenu({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [catFilter, setCatFilter] = useState<string>("all");
  const [artUrls, setArtUrls] = useState<Record<string, string>>({});
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const active = value ? inspirationStyle(value) : null;

  const displayed = useMemo(() => {
    const rows = INSPIRATION_STYLES.map((style) => {
      const cat = INSPIRATION_CATEGORIES.find((c) => c.styles.some((s) => s.id === style.id));
      return { style, cat };
    });
    if (catFilter === "all") return rows;
    return rows.filter((r) => r.cat?.id === catFilter);
  }, [catFilter]);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const width = Math.min(PANEL_W, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    setPos({ left, bottom: window.innerHeight - rect.top + 10, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setArtUrls(readArtUrls());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const pick = useCallback(
    (style: GenStyleDef, catId?: string) => {
      try {
        window.localStorage.setItem(INSPIRATION_LS_STYLE, style.id);
        if (catId) window.localStorage.setItem(INSPIRATION_LS_CATEGORY, catId);
      } catch {
        /* ignore */
      }
      onChange(style.id);
      setOpen(false);
      toast.success(`Стиль «${style.name}» выбран`);
    },
    [onChange],
  );

  const reset = useCallback(() => {
    try {
      window.localStorage.setItem(INSPIRATION_LS_STYLE, "");
    } catch {
      /* ignore */
    }
    onChange("");
    setOpen(false);
  }, [onChange]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="inspiration-button"
        aria-label="Вдохновение — каталог стилей"
        aria-pressed={open}
        title={
          active
            ? `Вдохновение — каталог стилей. Выбран «${active.name}»`
            : "Вдохновение — каталог стилей"
        }
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "relative flex h-[59px] min-w-[76px] items-center justify-center rounded-xl border px-3 py-2.5 transition-all duration-200",
          open || active
            ? "border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#2dd4bf] shadow-[0_0_18px_rgba(45,212,191,0.25)]"
            : "border-white/10 bg-[#16161b]/90 text-white/45 hover:border-white/20 hover:bg-[#1e1e24] hover:text-white",
          className,
        )}
      >
        <SwatchGlyph />
        {active ? (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-[#2dd4bf] shadow-[0_0_6px_#2dd4bf]" />
        ) : null}
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              data-testid="inspiration-menu"
              role="dialog"
              aria-label="Каталог стилей"
              style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}
              className="fixed z-[120] flex max-h-[70vh] flex-col overflow-hidden rounded-2xl border border-white/12 bg-[#121216]/97 shadow-[0_24px_70px_rgba(0,0,0,0.65)] backdrop-blur-xl"
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
                <div>
                  <div className="text-[14px] font-semibold text-white">Каталог стилей</div>
                  <div className="text-[11px] text-white/45">
                    {INSPIRATION_STYLES.length} стилей · тот же набор, что в помощнике над промптом
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {active ? (
                    <button
                      type="button"
                      onClick={reset}
                      className="rounded-lg border border-white/12 px-2.5 py-1 text-[11px] text-white/60 transition hover:border-[#2dd4bf]/50 hover:text-white"
                    >
                      Без стиля
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Закрыть каталог"
                    className="rounded-lg border border-white/10 p-1 text-white/50 transition hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 border-b border-white/8 px-4 py-2">
                <button
                  type="button"
                  onClick={() => setCatFilter("all")}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] transition",
                    catFilter === "all"
                      ? "bg-[#22d3ee] font-semibold text-black"
                      : "bg-white/[0.05] text-white/60 hover:bg-white/[0.08] hover:text-white",
                  )}
                >
                  Все ({INSPIRATION_STYLES.length})
                </button>
                {INSPIRATION_CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCatFilter(c.id)}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] transition",
                      catFilter === c.id
                        ? "bg-[#22d3ee] font-semibold text-black"
                        : "bg-white/[0.05] text-white/60 hover:bg-white/[0.08] hover:text-white",
                    )}
                  >
                    {c.name} ({c.styles.length})
                  </button>
                ))}
              </div>

              <div className="grid flex-1 grid-cols-4 gap-2 overflow-y-auto p-3">
                {displayed.map(({ style, cat }) => (
                  <StyleTile
                    key={style.id}
                    style={style}
                    artUrl={artUrls[style.id]}
                    selected={style.id === value}
                    onPick={() => pick(style, cat?.id)}
                  />
                ))}
              </div>

              <div className="border-t border-white/8 px-4 py-2 text-[11px] text-white/40">
                Стиль допишется к промпту при генерации фото — как в старом доке. Esc закрывает.
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
