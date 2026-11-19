"use client";

/**
 * «Вдохновение» — кнопка над вертикальными «Фото / Видео / Аудио» и каталог стилей
 * помощника. Механика окна выбора модели: три колонки — слева категории картинками,
 * в центре стили выбранной категории, справа открывается карточка стиля
 * с крупной картинкой, описанием и промптом.
 * Выбранный стиль пишется в те же ключи localStorage, что и панель помощника,
 * и дописывается к промпту фото при генерации.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
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

/** Габариты окна: слева категории, в центре стили, справа карточка. */
const PANEL_W = 860;
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

function Grid3x3Glyph({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="3" height="3" rx="0.5" />
      <rect x="4.5" y="0.5" width="3" height="3" rx="0.5" />
      <rect x="8.5" y="0.5" width="3" height="3" rx="0.5" />
      <rect x="0.5" y="4.5" width="3" height="3" rx="0.5" />
      <rect x="4.5" y="4.5" width="3" height="3" rx="0.5" />
      <rect x="8.5" y="4.5" width="3" height="3" rx="0.5" />
      <rect x="0.5" y="8.5" width="3" height="3" rx="0.5" />
      <rect x="4.5" y="8.5" width="3" height="3" rx="0.5" />
      <rect x="8.5" y="8.5" width="3" height="3" rx="0.5" />
    </svg>
  );
}

function ColumnsGlyph({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className={className} aria-hidden="true">
      <rect x="0.5" y="0.5" width="3" height="11" rx="0.5" />
      <rect x="4.5" y="0.5" width="7" height="11" rx="0.5" />
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
  /** Режим отображения: сетка 3x3 (по 9 стилей) или список стилей с карточкой справа. */
  const [viewMode, setViewMode] = useState<"grid9" | "detail">(() => {
    if (typeof window === "undefined") return "grid9";
    try {
      const saved = window.localStorage.getItem("inspiration.viewMode");
      if (saved === "detail" || saved === "grid9") return saved;
    } catch {
      /* ignore */
    }
    return "grid9";
  });

  const onToggleViewMode = (mode: "grid9" | "detail") => {
    setViewMode(mode);
    try {
      window.localStorage.setItem("inspiration.viewMode", mode);
    } catch {
      /* ignore */
    }
  };

  /** Поиск по всем 406+ стилям: в категории их бывает до 65, глазами не найти. */
  const [query, setQuery] = useState("");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const active = value ? inspirationStyle(value) : null;
  const category = useMemo(
    () => INSPIRATION_CATEGORIES.find((c) => c.id === catId) ?? INSPIRATION_CATEGORIES[0] ?? null,
    [catId],
  );
  const detail = detailId ? inspirationStyle(detailId) : null;

  const needle = query.trim().toLowerCase();
  const visibleStyles = useMemo(() => {
    if (!needle) return category?.styles ?? [];
    return INSPIRATION_STYLES.filter((s) =>
      `${s.name} ${s.desc} ${s.id} ${(s.tags ?? []).join(" ")}`.toLowerCase().includes(needle),
    );
  }, [needle, category]);

  const categoryNameOf = useCallback((styleId: string) => {
    return INSPIRATION_CATEGORIES.find((c) => c.styles.some((s) => s.id === styleId))?.name ?? "";
  }, []);

  useEffect(() => {
    if (!open) return;
    setArtUrls(readArtUrls());
    setQuery("");
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
          style={{ width: viewMode === "grid9" ? PANEL_W : detail ? PANEL_W : PANEL_W - 398, height: PANEL_H }}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute bottom-full left-[-20px] z-50 mb-3 flex flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#121216]/95 shadow-[0_25px_70px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
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
              {/* Переключатель режима: Сетка 3×3 (по 9 стилей) vs Список с карточкой */}
              <div
                className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] p-0.5"
                role="group"
                aria-label="Вариант просмотра каталога стилей"
              >
                <button
                  type="button"
                  title="Сетка 3×3 (по 9 стилей)"
                  onClick={() => onToggleViewMode("grid9")}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium transition",
                    viewMode === "grid9"
                      ? "bg-[#2dd4bf]/20 font-semibold text-[#2dd4bf] shadow-sm"
                      : "text-white/45 hover:text-white",
                  )}
                >
                  <Grid3x3Glyph className="h-3 w-3" />
                  <span>По 9</span>
                </button>
                <button
                  type="button"
                  title="Список стилей с карточкой описания справа"
                  onClick={() => onToggleViewMode("detail")}
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] font-medium transition",
                    viewMode === "detail"
                      ? "bg-[#2dd4bf]/20 font-semibold text-[#2dd4bf] shadow-sm"
                      : "text-white/45 hover:text-white",
                  )}
                >
                  <ColumnsGlyph className="h-3 w-3" />
                  <span>Список</span>
                </button>
              </div>

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

          {/* Слева категории · по центру/справа стили */}
          <div className="flex min-h-0 flex-1">
            <div
              data-testid="inspiration-categories"
              className="w-[196px] shrink-0 overflow-y-auto border-r border-white/[0.08] p-2"
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
                      className="h-[36px] w-[36px] shrink-0 rounded-lg"
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

            {viewMode === "grid9" ? (
              /* РЕЖИМ 2: Сетка 3×3 (по 9 стилей на экран) */
              <div
                data-testid="inspiration-styles-grid9"
                className="flex min-w-0 flex-1 flex-col overflow-hidden p-2.5"
              >
                <div className="relative mb-2 shrink-0 px-0.5">
                  <Search className="pointer-events-none absolute top-1/2 left-3 h-3 w-3 -translate-y-1/2 text-white/35" />
                  <input
                    data-testid="inspiration-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Поиск по всем стилям…"
                    className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-1 pr-[22px] pl-[28px] text-[11px] text-white/85 placeholder:text-white/30 focus:border-[#2dd4bf]/60 focus:outline-none"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      aria-label="Очистить поиск"
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-white/40 transition hover:text-white"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  ) : null}
                </div>
                <div className="mb-1.5 flex shrink-0 items-center justify-between px-1">
                  <p className="text-[9px] font-bold tracking-[0.14em] text-white/30 uppercase">
                    {needle ? `Найдено · ${visibleStyles.length}` : `Сетка стилей · ${visibleStyles.length}`}
                  </p>
                  <span className="text-[9.5px] text-white/40">
                    Клик — выбрать стиль
                  </span>
                </div>
                <div className="grid flex-1 content-start grid-cols-3 gap-2 overflow-y-auto pr-1">
                  {visibleStyles.map((s) => {
                    const isSelected = s.id === value;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        data-testid={`inspiration-style-${s.id}`}
                        data-style-id={s.id}
                        onClick={() => {
                          setDetailId(s.id);
                          pick(s, category?.id);
                        }}
                        title={`${s.name} — ${s.desc}\n\nПромпт: ${s.promptCore}`}
                        className={cn(
                          "group relative h-[116px] overflow-hidden rounded-xl border text-left transition hover:shadow-lg",
                          isSelected
                            ? "border-[#2dd4bf] ring-2 ring-[#2dd4bf]/50 shadow-[0_0_20px_rgba(45,212,191,0.25)]"
                            : "border-white/10 bg-[#16161c] hover:border-white/30 hover:scale-[1.01]",
                        )}
                      >
                        <StyleThumb style={s} artUrl={artUrls[s.id]} className="h-full w-full" />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2.5 pt-8 pb-1.5">
                          <div className="line-clamp-1 text-[12px] font-bold text-white group-hover:text-[#2dd4bf] transition-colors">
                            {s.name}
                          </div>
                          <div className="line-clamp-1 text-[10px] text-white/60">
                            {needle ? categoryNameOf(s.id) : s.desc}
                          </div>
                        </div>
                        {isSelected ? (
                          <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-[#2dd4bf] px-1.5 py-0.5 text-[9px] font-bold text-black shadow-md">
                            <Check className="h-2.5 w-2.5 stroke-[3]" /> выбран
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  {visibleStyles.length === 0 ? (
                    <div className="col-span-3 py-10 text-center text-[11px] text-white/40">
                      Ничего не нашлось. Попробуй короче: «аниме», «нуар», «бумага», «киберпанк».
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              /* РЕЖИМ 1: Список стилей в 1 колонку + карточка стиля с промптом справа */
              <>
                <div
                  data-testid="inspiration-styles"
                  className="w-[264px] shrink-0 overflow-y-auto border-r border-white/[0.08] p-2"
                >
                  <div className="relative mb-1.5 px-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3 w-3 -translate-y-1/2 text-white/35" />
                    <input
                      data-testid="inspiration-search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Поиск по всем стилям"
                      className="w-full rounded-lg border border-white/10 bg-white/[0.04] py-1 pr-[22px] pl-[26px] text-[10.5px] text-white/85 placeholder:text-white/30 focus:border-[#2dd4bf]/60 focus:outline-none"
                    />
                    {query ? (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Очистить поиск"
                        className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-white/40 transition hover:text-white"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    ) : null}
                  </div>
                  <p className="mb-1.5 px-1 text-[9px] font-bold tracking-[0.14em] text-white/30 uppercase">
                    {needle ? `Найдено · ${visibleStyles.length}` : `Стили · ${visibleStyles.length}`}
                  </p>
                  {visibleStyles.map((s) => {
                    const isOpen = s.id === detailId;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        data-testid={`inspiration-style-${s.id}`}
                        data-style-id={s.id}
                        onClick={() => setDetailId(s.id)}
                        title={s.desc}
                        className={cn(
                          "group relative mb-2 block w-full overflow-hidden rounded-xl border text-left transition",
                          isOpen
                            ? "border-[#2dd4bf] ring-2 ring-[#2dd4bf]/40"
                            : s.id === value
                              ? "border-[#2dd4bf]/50"
                              : "border-white/10 hover:border-white/30",
                        )}
                      >
                        {/* Одна карточка в ширину — картинка крупная */}
                        <StyleThumb style={s} artUrl={artUrls[s.id]} className="h-[116px] w-full" />
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent px-2 pt-8 pb-1.5">
                          <div className="line-clamp-1 text-[12px] font-bold text-white">{s.name}</div>
                          <div className="line-clamp-1 text-[10px] text-white/55">
                            {needle ? categoryNameOf(s.id) : s.desc}
                          </div>
                        </div>
                        {s.id === value ? (
                          <span className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-[#2dd4bf] px-1 py-0.5 text-[9px] font-bold text-black">
                            <Check className="h-2.5 w-2.5" /> выбран
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                  {visibleStyles.length === 0 ? (
                    <p className="px-1 py-3 text-[10.5px] leading-relaxed text-white/40">
                      Ничего не нашлось. Попробуй короче: «аниме», «нуар», «бумага», «киберпанк».
                    </p>
                  ) : null}
                </div>

                {/* Справа открывается карточка выбранного стиля; без выбора третьей колонки нет */}
                {detail ? (
                  <div data-testid="inspiration-detail" className="flex min-w-0 flex-1 flex-col overflow-hidden p-2.5">
                    <>
                      <StyleThumb
                        style={detail}
                        artUrl={artUrls[detail.id]}
                        className="h-[190px] w-full shrink-0 rounded-xl border border-white/10"
                      />
                      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">
                        <div data-testid="inspiration-style-name" className="text-[13px] font-bold text-white">
                          {detail.name}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-white/60">{detail.desc}</div>
                        {detail.tags?.length ? (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {detail.tags.slice(0, 6).map((t) => (
                              <span key={t} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9.5px] text-white/50">
                                {t}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="mt-2 mb-1 text-[10px] font-semibold tracking-wide text-white/40 uppercase">
                          Промпт
                        </div>
                        <div
                          data-testid="inspiration-style-prompt"
                          className="max-h-[96px] overflow-y-auto rounded-lg border border-white/8 bg-black/30 p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap text-white/70"
                        >
                          {detail.promptCore}
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid="inspiration-apply"
                        onClick={() => pick(detail, category?.id)}
                        className={cn(
                          "mt-2 flex shrink-0 items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-bold transition",
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
                    </>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
