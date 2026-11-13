"use client";

/**
 * «Вдохновение» — кнопка над вертикальными «Фото / Видео / Аудио» и каталог стилей
 * помощника. Механика окна выбора модели: слева категории картинками, справа стили
 * выбранной категории; клик по стилю — карточка с крупной картинкой, описанием и промптом.
 * Выбранный стиль пишется в те же ключи localStorage, что и панель помощника,
 * и дописывается к промпту фото при генерации.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";
import { toast } from "sonner";

import { GenStyleArt as GenStyleArtView } from "@/components/outsee/gen-style-art";
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

/** Габариты как у окна выбора модели: ширина 700, высота min(480px, 72vh). */
const PANEL_W = 700;
const PANEL_H = "min(480px, 72vh)";

/** Категория выбранного стиля — чтобы окно открывалось на нужном месте. */
function positiveCatFor(styleId: string): string | null {
  if (!styleId) return null;
  const cat = INSPIRATION_CATEGORIES.find((c) => c.styles.some((s) => s.id === styleId));
  return cat?.id ?? null;
}

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

/** Картинка стиля: обложка, если есть, иначе SVG-эскиз в тон стиля. */
function StyleThumb({
  style,
  artUrl,
  className,
  children,
}: {
  style: GenStyleDef;
  artUrl?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  const cover = !broken ? (artUrl ?? style.cover) : undefined;

  return (
    <div className={cn("relative overflow-hidden bg-[#16161c]", className)}>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="max-h-[78%] max-w-[78%] opacity-90">
          <GenStyleArtView art={style.art} color={style.color} />
        </div>
      </div>
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cover}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : null}
      {children}
    </div>
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
  const [artUrls, setArtUrls] = useState<Record<string, string>>({});
  const [catId, setCatId] = useState<string>(INSPIRATION_CATEGORIES[0]?.id ?? "");
  const [detailId, setDetailId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const active = value ? inspirationStyle(value) : null;
  const category = useMemo(
    () => INSPIRATION_CATEGORIES.find((c) => c.id === catId) ?? INSPIRATION_CATEGORIES[0] ?? null,
    [catId],
  );
  const detail = detailId ? inspirationStyle(detailId) : null;

  useEffect(() => {
    if (!open) return;
    setArtUrls(readArtUrls());
    // Открываем на категории выбранного стиля, иначе на сохранённой, иначе на первой.
    let saved = "";
    try {
      saved = window.localStorage.getItem(INSPIRATION_LS_CATEGORY) ?? "";
    } catch {
      /* ignore */
    }
    const target = positiveCatFor(value) ?? saved;
    if (target && INSPIRATION_CATEGORIES.some((c) => c.id === target)) setCatId(target);
    setDetailId(null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDetailId((prev) => {
        if (prev) return null;
        setOpen(false);
        return prev;
      });
    };
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (panelRef.current?.contains(node) || buttonRef.current?.contains(node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, value]);

  const pick = useCallback(
    (style: GenStyleDef, cat?: string) => {
      try {
        window.localStorage.setItem(INSPIRATION_LS_STYLE, style.id);
        if (cat) window.localStorage.setItem(INSPIRATION_LS_CATEGORY, cat);
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
    <div className="relative">
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

      {open ? (
        <div
          ref={panelRef}
          data-testid="inspiration-menu"
          role="dialog"
          aria-label="Каталог стилей"
          style={{ width: PANEL_W, height: PANEL_H }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-full left-0 z-50 mb-3 flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#121216]/95 shadow-[0_25px_70px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
        >
          {/* Шапка */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.08] bg-[#16161b]/95 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span data-testid="inspiration-title" className="text-[13px] font-bold tracking-tight text-white/90">
                Каталог стилей
              </span>
              <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#2dd4bf]">
                {INSPIRATION_CATEGORIES.length} кат. · {INSPIRATION_STYLES.length} стилей
              </span>
              {active ? (
                <span className="truncate text-[10.5px] text-white/40">выбран «{active.name}»</span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
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

          {/* Слева категории, справа — стили выбранной категории */}
          <div className="flex min-h-0 flex-1">
            <div
              data-testid="inspiration-categories"
              className="w-[214px] shrink-0 overflow-y-auto border-r border-white/[0.08] p-2"
              role="tablist"
              aria-label="Категории стилей"
            >
              <p className="mb-1.5 px-1 text-[9px] font-bold tracking-[0.14em] text-white/30 uppercase">
                Категории
              </p>
              {INSPIRATION_CATEGORIES.map((c) => {
                const isActive = c.id === category?.id;
                const coverStyle = c.styles.find((s) => artUrls[s.id] ?? s.cover) ?? c.styles[0];
                const hasSelected = c.styles.some((s) => s.id === value);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    data-testid={`inspiration-category-${c.id}`}
                    onClick={() => {
                      setCatId(c.id);
                      setDetailId(null);
                    }}
                    className={cn(
                      "mb-1 flex w-full items-center gap-2 rounded-xl border p-1.5 text-left transition",
                      isActive
                        ? "border-[#2dd4bf] bg-[#2dd4bf]/12 shadow-[0_0_18px_rgba(45,212,191,0.18)]"
                        : "border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]",
                    )}
                  >
                    <StyleThumb
                      style={coverStyle}
                      artUrl={artUrls[coverStyle.id]}
                      className="h-[38px] w-[38px] shrink-0 rounded-lg"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[12px] font-semibold",
                          isActive ? "text-[#2dd4bf]" : "text-white/90",
                        )}
                      >
                        {c.name}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 text-[10px] text-white/40">
                        {c.styles.length} стилей
                        {hasSelected ? <Check className="h-2.5 w-2.5 text-[#2dd4bf]" /> : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {detail ? (
                /* Карточка стиля: крупная картинка, описание, промпт */
                <div className="flex flex-1 gap-3 overflow-hidden p-2.5">
                  <div className="flex w-[42%] shrink-0 flex-col gap-2">
                    <button
                      type="button"
                      data-testid="inspiration-back"
                      onClick={() => setDetailId(null)}
                      className="inline-flex items-center gap-1 self-start rounded-lg border border-white/10 px-2 py-1 text-[11px] text-white/60 transition hover:bg-white/10 hover:text-white"
                    >
                      <ArrowLeft className="h-3 w-3" /> к стилям
                    </button>
                    <StyleThumb
                      style={detail}
                      artUrl={artUrls[detail.id]}
                      className="h-[190px] w-full rounded-xl border border-white/10"
                    />
                    <button
                      type="button"
                      data-testid="inspiration-apply"
                      onClick={() => pick(detail, category?.id)}
                      className={cn(
                        "flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-bold transition",
                        detail.id === value
                          ? "bg-[#2dd4bf]/15 text-[#2dd4bf] ring-1 ring-[#2dd4bf]/50"
                          : "bg-gradient-to-r from-[#2dd4bf] to-[#0d9488] text-black hover:brightness-110",
                      )}
                    >
                      {detail.id === value ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Выбран
                        </>
                      ) : (
                        "Выбрать стиль"
                      )}
                    </button>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
                    <div>
                      <div data-testid="inspiration-style-name" className="text-[13px] font-bold text-white">
                        {detail.name}
                      </div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-white/60">{detail.desc}</div>
                      {detail.tags?.length ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {detail.tags.slice(0, 8).map((t) => (
                            <span key={t} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9.5px] text-white/50">
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div>
                      <div className="mb-1 text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                        Промпт
                      </div>
                      <div
                        data-testid="inspiration-style-prompt"
                        className="max-h-[150px] overflow-y-auto rounded-lg border border-white/8 bg-black/30 p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap text-white/70"
                      >
                        {detail.promptCore}
                      </div>
                    </div>
                    {detail.negativePrompt ? (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                          Чего избегать
                        </div>
                        <div className="max-h-[80px] overflow-y-auto rounded-lg border border-white/8 bg-black/20 p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap text-white/50">
                          {detail.negativePrompt}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                /* Стили выбранной категории — справа от категорий */
                <div data-testid="inspiration-styles" className="grid flex-1 grid-cols-2 gap-2 overflow-y-auto p-2.5">
                  {(category?.styles ?? []).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      data-testid={`inspiration-style-${s.id}`}
                      data-style-id={s.id}
                      onClick={() => setDetailId(s.id)}
                      title={s.desc}
                      className={cn(
                        "group relative h-[112px] overflow-hidden rounded-xl border text-left transition",
                        s.id === value
                          ? "border-[#2dd4bf] ring-2 ring-[#2dd4bf]/40"
                          : "border-white/10 hover:border-white/30",
                      )}
                    >
                      <StyleThumb style={s} artUrl={artUrls[s.id]} className="absolute inset-0 h-full w-full" />
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2 pt-8 pb-1.5">
                        <div className="line-clamp-1 text-[12px] font-bold text-white">{s.name}</div>
                        <div className="line-clamp-1 text-[10px] text-white/55">{s.desc}</div>
                      </div>
                      {s.id === value ? (
                        <span className="absolute top-1 right-1 rounded bg-[#2dd4bf] px-1 py-0.5 text-[9px] font-bold text-black">
                          выбран
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
