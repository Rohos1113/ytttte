"use client";

/**
 * Детали дока «Генерация» в стиле outsee.io/create (новый дизайн):
 * — квадратные плитки референсов с номером внутри категории и меткой типа
 *   (фото / видео / аудио), счётчики вида «Фото 2/9»;
 * — меню вставки референса по «@» с фактическими именами вложений;
 * — сегментные переключатели Seedance: Omni / Первый+Последний, Fast / Quality;
 * — чип параметра (иконка + значение + шеврон) и панель предпросмотра модели.
 *
 * Акцент один: GEN_ACCENT (изумрудный студии). Все остальные цвета — существующая
 * тёмная палитра окна генерации.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  Clock,
  Eye,
  Film,
  ImageIcon,
  Layers,
  Loader2,
  Maximize2,
  Music,
  Plus,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import type { KieField } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Изумрудный акцент студии; им помечены активные элементы окна генерации. */
export const GEN_ACCENT = "#2dd4bf";

export type RefKind = "image" | "video" | "audio";

export type GenRef = {
  /** Уникальный ключ: `<field>:<index>`. */
  id: string;
  /** Имя поля KIE-модели, из которого пришёл референс. */
  field: string;
  url: string;
  /** Фактическое имя (имя загруженного файла), а не «Реф #N». */
  name: string;
  kind: RefKind;
  /** Порядковый номер внутри своей категории, с 1. */
  categoryIndex: number;
  /** Всего слотов в категории (для счётчика «N/M»). */
  categoryMax: number;
};

const KIND_BY_FIELD_KIND: Record<string, RefKind> = {
  images: "image",
  videos: "video",
  audios: "audio",
};

export const REF_KIND_LABEL: Record<RefKind, string> = {
  image: "Фото",
  video: "Видео",
  audio: "Аудио",
};

/** Имя файла без расширения — то, что уходит в промт после «@». */
export function refToken(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() || name || "ref";
  const dot = base.lastIndexOf(".");
  const raw = dot > 0 ? base.slice(0, dot) : base;
  return raw.replace(/\s+/g, "_").slice(0, 40) || "ref";
}

/** Имя из URL, когда файл пришёл ссылкой: последний сегмент пути. */
export function nameFromUrl(url: string): string {
  try {
    const clean = url.split("?")[0] ?? url;
    const seg = clean.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : url;
  } catch {
    return url;
  }
}

export function refKindIcon(kind: RefKind, className = "h-3 w-3") {
  if (kind === "video") return <Film className={className} />;
  if (kind === "audio") return <Music className={className} />;
  return <ImageIcon className={className} />;
}

/**
 * Собирает референсы из значений KIE-модели. Параллельно с URL держим имена:
 * `names[field][i]` — фактическое имя i-го вложения (после загрузки файла).
 */
export function refsFromKieFields(
  fields: KieField[],
  values: Record<string, unknown>,
  names: Record<string, string[]>,
): GenRef[] {
  const out: GenRef[] = [];
  for (const f of fields) {
    const kind = KIND_BY_FIELD_KIND[f.kind];
    if (!kind) continue;
    const raw = values[f.name];
    const urls = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && !!u) : [];
    const fieldNames = names[f.name] || [];
    urls.forEach((url, i) => {
      out.push({
        id: `${f.name}:${i}`,
        field: f.name,
        url,
        name: fieldNames[i] || nameFromUrl(url),
        kind,
        categoryIndex: i + 1,
        categoryMax: f.max_items ?? 99,
      });
    });
  }
  return out;
}

/** Кадры «первый / последний» в режиме Первый+Последний. */
export function framesFromKieValues(
  fields: KieField[],
  values: Record<string, unknown>,
  names: Record<string, string[]>,
): GenRef[] {
  const out: GenRef[] = [];
  const add = (field: string, kind: RefKind) => {
    const raw = values[field];
    const urls = Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && !!u) : [];
    urls.forEach((url, i) => {
      out.push({
        id: `${field}:${i}`,
        field,
        url,
        name: (names[field] || [])[i] || nameFromUrl(url),
        kind,
        categoryIndex: i + 1,
        categoryMax: 1,
      });
    });
  };
  if (fields.some((f) => f.name === "first_frame_url")) add("first_frame_url", "image");
  if (fields.some((f) => f.name === "last_frame_url")) add("last_frame_url", "image");
  return out;
}

/** Одна квадратная плитка референса: 68×68, номер категории, метка типа, удаление. */
export function RefTile({
  refItem,
  label,
  showNumber = true,
  onRemove,
  onPreview,
}: {
  refItem: GenRef;
  /** Для кадров: подпись под плиткой («Первый кадр» / «Последний кадр»). */
  label?: string;
  /** В режиме кадров номера не рисуем — там важен только смысл слота. */
  showNumber?: boolean;
  onRemove: () => void;
  onPreview?: () => void;
}) {
  const isMedia = refItem.kind !== "image";
  return (
    <div data-ref-tile={refItem.field} data-ref-kind={refItem.kind} data-ref-number={showNumber ? refItem.categoryIndex : ""} className="group relative h-[68px] w-[68px] shrink-0 overflow-hidden rounded-lg ring-1 ring-white/15 transition hover:ring-[#2dd4bf]/50">
      {refItem.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={refItem.url} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : refItem.kind === "video" ? (
        <video
          src={refItem.url}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 bg-[#16161b] text-white/70">
          {refKindIcon(refItem.kind, "h-5 w-5")}
          <span className="max-w-[60px] truncate px-1 text-[8px] leading-tight">
            {refItem.name}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Убрать референс"
        title={`Убрать «${refItem.name}»`}
        className="absolute right-0.5 top-0.5 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/85 transition hover:bg-red-500/80"
      >
        <X className="h-2.5 w-2.5" />
      </button>
      {label ? (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/65 px-1 py-0.5 text-center text-[8px] font-medium leading-tight text-white/90">
          {label}
        </span>
      ) : showNumber ? (
        <span
          className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 font-mono text-[8px] text-white/90"
          title={`${REF_KIND_LABEL[refItem.kind]} ${refItem.categoryIndex}`}
        >
          {refItem.categoryIndex}
        </span>
      ) : null}
      {isMedia && (
        <span className="pointer-events-none absolute bottom-0.5 right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded bg-black/60 text-white/85">
          {refKindIcon(refItem.kind, "h-2.5 w-2.5")}
        </span>
      )}
      {onPreview && (
        <button
          type="button"
          onClick={onPreview}
          aria-label="Посмотреть крупно"
          className="absolute bottom-1.5 right-1.5 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white/85 backdrop-blur group-hover:flex"
        >
          <Eye className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** Пунктирная плитка «+ Фото 2/9». */
export function AddTile({
  kind,
  label,
  count,
  max,
  showCount = true,
  busy,
  disabled,
  onClick,
  onDropFiles,
}: {
  kind: RefKind;
  label?: string;
  count: number;
  max: number;
  /** Для аудио и кадров счётчик не нужен — только подпись. */
  showCount?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDropFiles?: (files: File[]) => void;
}) {
  const base = label || REF_KIND_LABEL[kind];
  const text = showCount ? `${base} ${count}/${max}` : base;
  return (
    <button
      type="button"
      data-ref-add={kind}
      onClick={onClick}
      disabled={disabled || busy}
      title={label ? `Добавить: ${label}` : `Добавить ${REF_KIND_LABEL[kind].toLowerCase()} (${count}/${max})`}
      onDragOver={
        onDropFiles
          ? (e) => {
              e.preventDefault();
            }
          : undefined
      }
      onDrop={
        onDropFiles
          ? (e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files || []);
              if (files.length) onDropFiles(files);
            }
          : undefined
      }
      className={cn(
        "flex h-[68px] w-[68px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border-dashed bg-white/[0.025] text-white/45 transition-colors",
        "border-[1.5px] border-white/10 hover:bg-white/[0.06] hover:text-white/80",
        (disabled || busy) && "cursor-not-allowed opacity-40 hover:bg-white/[0.025]",
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <>
          {refKindIcon(kind, "h-3.5 w-3.5")}
          <span className="max-w-[62px] text-center text-[10px] font-medium leading-[1.1]">{text}</span>
        </>
      )}
    </button>
  );
}

/** Группа плиток одной категории + кнопка добавления, если есть место. */
export function RefCategory({
  kind,
  items,
  max,
  busy,
  labels,
  showNumber = true,
  showCount = true,
  addLabel,
  onAddFiles,
  onAddClick,
  onRemove,
  onPreview,
}: {
  kind: RefKind;
  items: GenRef[];
  max: number;
  busy?: boolean;
  /** Для кадров — подписи плиток. */
  labels?: (refItem: GenRef) => string | undefined;
  /** Показывать ли номер внутри категории (у кадров номеров нет). */
  showNumber?: boolean;
  showCount?: boolean;
  /** Подпись пунктирной плитки (по умолчанию «Фото N/M»). */
  addLabel?: string;
  onAddFiles?: (files: File[]) => void;
  onAddClick: () => void;
  onRemove: (refItem: GenRef) => void;
  onPreview?: (refItem: GenRef) => void;
}) {
  if (max <= 0) return null;
  return (
    <>
      {items.map((item) => (
        <RefTile
          key={item.id}
          refItem={item}
          label={labels?.(item)}
          showNumber={showNumber}
          onRemove={() => onRemove(item)}
          onPreview={onPreview ? () => onPreview(item) : undefined}
        />
      ))}
      {items.length < max && (
        <AddTile
          kind={kind}
          label={addLabel}
          count={items.length}
          max={max}
          showCount={showCount}
          busy={busy}
          disabled={items.length >= max}
          onClick={onAddClick}
          onDropFiles={onAddFiles}
        />
      )}
    </>
  );
}

/** Пункт меню «@»: превью, фактическое имя, категория и номер. */
export function MentionMenuItem({
  refItem,
  active,
  onPointerEnter,
  onPick,
}: {
  refItem: GenRef;
  active: boolean;
  onPointerEnter: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onPointerEnter}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition",
        active ? "bg-[#2dd4bf]/15 text-white" : "text-white/80 hover:bg-white/[0.06]",
      )}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-black/50 ring-1 ring-white/10">
        {refItem.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={refItem.url} alt="" className="h-full w-full object-cover" />
        ) : (
          refKindIcon(refItem.kind, "h-3.5 w-3.5 text-white/70")
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">{refItem.name}</span>
        <span className="block text-[10px] text-white/40">
          {REF_KIND_LABEL[refItem.kind]} · №{refItem.categoryIndex}
        </span>
      </span>
      <span className="shrink-0 rounded bg-white/10 px-1 font-mono text-[9px] text-white/60">
        @{refToken(refItem.name)}
      </span>
    </button>
  );
}

/** Выпадающее меню «@» над полем промта. */
export function MentionMenu({
  open,
  items,
  activeIndex,
  onHover,
  onPick,
  emptyHint,
}: {
  open: boolean;
  items: GenRef[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (refItem: GenRef) => void;
  emptyHint: string;
}) {
  if (!open) return null;
  return (
    <div
      className="absolute bottom-full left-0 right-0 z-[1000] mb-2 overflow-hidden rounded-xl border border-white/15 bg-[#121216]/97 shadow-[0_18px_45px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
      role="listbox"
      aria-label="Вставить референс"
    >
      <div className="flex items-center justify-between border-b border-white/[0.08] px-2.5 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/45">
          Референсы
        </span>
        <span className="font-mono text-[10px] text-white/35">↑↓ Enter Esc</span>
      </div>
      <div className="max-h-56 overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <div className="px-2 py-3 text-[11px] leading-relaxed text-white/45">{emptyHint}</div>
        ) : (
          items.map((item, i) => (
            <MentionMenuItem
              key={item.id}
              refItem={item}
              active={i === activeIndex}
              onPointerEnter={() => onHover(i)}
              onPick={() => onPick(item)}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** Сегментированный переключатель в стиле нового дизайна (пилюли). */
export function SegmentedPills<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string; icon?: ReactNode; title?: string }[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.04] p-0.5"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={o.title || o.label}
            onClick={() => onChange(o.id)}
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-transparent px-3 py-1 text-[11px] font-medium transition-all",
              active
                ? "bg-[#2dd4bf]/15 text-[#2dd4bf] shadow-[inset_0_0_0_1px_rgba(45,212,191,0.35)]"
                : "text-white/45 hover:text-white/85",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Чип параметра: иконка + значение + шеврон (умеет и в режим переключателя). */
export function ParamChip({
  icon,
  value,
  title,
  active,
  chevron = true,
  onClick,
}: {
  icon?: ReactNode;
  value: string;
  title?: string;
  active?: boolean;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition",
        active
          ? "border-[#2dd4bf]/50 bg-[#2dd4bf]/12 text-[#2dd4bf]"
          : "border-white/[0.08] bg-white/[0.04] text-white/70 hover:border-white/20 hover:text-white",
      )}
    >
      {icon && <span className="flex h-3 w-3 items-center justify-center opacity-80">{icon}</span>}
      <span className="tabular-nums">{value}</span>
      {chevron && <ChevronDown className="h-3 w-3 opacity-60" />}
    </button>
  );
}

/** Строка «характеристик» модели в панели предпросмотра пикера. */
export function ModelPreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-white/40">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-white/85">{value}</span>
    </div>
  );
}

/** Плюсик для пунктирных кнопок-плиток (экспорт для единообразия). */
export function PlusGlyph({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <Plus className={className} />;
}

/** Раздел панели «Параметры»: подпись + содержимое. */
function PaneSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">
        {title}
      </p>
      {children}
    </div>
  );
}

/** Крошечный прямоугольник-превью соотношения сторон. */
function RatioGlyph({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(":").map((v) => Number(v) || 1);
  const scale = Math.min(16 / (w || 1), 16 / (h || 1));
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-[2px] border border-current opacity-70"
      style={{
        width: Math.max(6, Math.round((w || 1) * scale)),
        height: Math.max(6, Math.round((h || 1) * scale)),
      }}
    />
  );
}

/** Тумблер «вкл/выкл» для панели параметров. */
function ToggleSwitch({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition",
        on ? "border-[#2dd4bf]/60 bg-[#2dd4bf]/25" : "border-white/[0.12] bg-white/[0.06]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all",
          on ? "left-[18px] bg-[#2dd4bf]" : "left-0.5 bg-white/70",
        )}
      />
    </button>
  );
}

/** Подсказки под разрешением — как в эталоне: у части значений свой пресет. */
const RESOLUTION_HINT: Record<string, string> = {
  "480p": "только Fast",
  "1080p": "только Quality",
  "4k": "только Quality",
  "4K": "только Quality",
};

/**
 * Нижняя строка Seedance: четыре чипа (формат · разрешение · время · звук),
 * которые открывают ОДНУ панель «Параметры» с разделами, плюс переключатели
 * Omni/Первый+Последний и Fast/Quality.
 *
 * Пресет Fast = 480p, Quality = 720p (бэкенд хранит это как resolution).
 */
export function SeedanceDock({
  fields,
  values,
  onChange,
  onReset,
  mode,
  onMode,
  preset,
  onPreset,
}: {
  fields: KieField[];
  values: Record<string, unknown>;
  onChange: (name: string, v: unknown) => void;
  /** Сброс параметров к дефолтам модели. */
  onReset: () => void;
  mode: "omni" | "frames";
  onMode: (m: "omni" | "frames") => void;
  preset: "fast" | "quality";
  onPreset: (p: "fast" | "quality") => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const aspect = fields.find((f) => f.name === "aspect_ratio");
  const res = fields.find((f) => f.name === "resolution");
  const dur = fields.find((f) => f.name === "duration");
  const audio = fields.find((f) => f.name === "generate_audio" && f.kind === "toggle");

  const aspectValue = String(values.aspect_ratio ?? aspect?.default ?? "16:9");
  const resValue = String(values.resolution ?? res?.default ?? "720p");
  const durValue = Number(values.duration ?? dur?.default ?? 5);
  const audioOn = values.generate_audio === true || String(values.generate_audio) === "true";

  const ratioOptions = aspect?.options?.length
    ? aspect.options
    : ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"];

  const durationOptions: number[] = [];
  if (dur) {
    const min = Math.max(1, Math.round(Number(dur.min ?? 4)));
    const max = Math.min(60, Math.round(Number(dur.max ?? 15)));
    for (let d = min; d <= max; d += 1) durationOptions.push(d);
  }

  const togglePanel = () => setOpen((v) => !v);

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <div ref={boxRef} className="relative inline-flex flex-wrap items-center gap-1.5">
        {aspect && (
          <span data-chip="aspect">
            <ParamChip
              icon={<Maximize2 className="h-3 w-3" />}
              value={aspectValue}
              title="Соотношение сторон"
              active={open}
              onClick={togglePanel}
            />
          </span>
        )}
        {res && (
          <span data-chip="resolution">
            <ParamChip
              icon={<Layers className="h-3 w-3" />}
              value={resValue}
              title="Разрешение · Fast = 480p, Quality = 720p+"
              active={open}
              onClick={togglePanel}
            />
          </span>
        )}
        {dur && durationOptions.length > 0 && (
          <span data-chip="duration">
            <ParamChip
              icon={<Clock className="h-3 w-3" />}
              value={`${durValue}s`}
              title="Длительность"
              active={open}
              onClick={togglePanel}
            />
          </span>
        )}
        {audio && (
          <span data-chip="sound">
            <ParamChip
              icon={audioOn ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
              value={audioOn ? "Звук вкл" : "Звук выкл"}
              title="Звук"
              active={open}
              onClick={togglePanel}
            />
          </span>
        )}

        {open && (
          <div
            data-params-panel="true"
            className="absolute bottom-full left-0 z-[1000] mb-2 w-[322px] rounded-xl border border-white/15 bg-[#121216]/97 p-3 shadow-[0_18px_45px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
          >
            <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
              Параметры
            </p>

            {aspect && (
              <PaneSection title="Соотношение сторон">
                <div className="grid grid-cols-3 gap-1.5">
                  {ratioOptions.map((o) => {
                    const active = o === aspectValue;
                    return (
                      <button
                        key={o}
                        type="button"
                        data-ratio={o}
                        onClick={() => onChange("aspect_ratio", o)}
                        className={cn(
                          "flex h-9 items-center justify-center gap-1.5 rounded-lg border text-[11px] font-medium transition",
                          active
                            ? "border-[#2dd4bf]/55 bg-[#2dd4bf]/12 text-[#2dd4bf]"
                            : "border-white/[0.08] bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white",
                        )}
                      >
                        <RatioGlyph ratio={o} />
                        {o}
                      </button>
                    );
                  })}
                </div>
              </PaneSection>
            )}

            {res && (
              <PaneSection title="Разрешение">
                <div className="grid grid-cols-2 gap-1.5">
                  {(res.options || []).map((o) => {
                    const active = o === resValue;
                    const hint = RESOLUTION_HINT[o];
                    return (
                      <button
                        key={o}
                        type="button"
                        data-resolution={o}
                        onClick={() => onChange("resolution", o)}
                        className={cn(
                          "flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-left transition",
                          active
                            ? "border-[#2dd4bf]/55 bg-[#2dd4bf]/12 text-[#2dd4bf]"
                            : "border-white/[0.08] bg-white/[0.03] text-white/75 hover:border-white/20 hover:text-white",
                        )}
                      >
                        <span className="text-[12px] font-medium">{o}</span>
                        {hint && <span className="text-[9px] text-white/35">{hint}</span>}
                      </button>
                    );
                  })}
                </div>
              </PaneSection>
            )}

            {dur && durationOptions.length > 0 && (
              <PaneSection title="Длительность">
                <div className="grid grid-cols-6 gap-1.5">
                  {durationOptions.map((d) => {
                    const active = d === durValue;
                    return (
                      <button
                        key={d}
                        type="button"
                        data-duration={d}
                        onClick={() => onChange("duration", d)}
                        className={cn(
                          "h-8 rounded-lg border text-[11px] font-medium tabular-nums transition",
                          active
                            ? "border-[#2dd4bf]/55 bg-[#2dd4bf]/12 text-[#2dd4bf]"
                            : "border-white/[0.08] bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white",
                        )}
                      >
                        {d}s
                      </button>
                    );
                  })}
                </div>
              </PaneSection>
            )}

            {audio && (
              <PaneSection title="Звук">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2">
                  <span className="text-[11px] leading-tight text-white/75">
                    Сгенерировать аудио-дорожку
                  </span>
                  <ToggleSwitch
                    on={audioOn}
                    label="Сгенерировать аудио-дорожку"
                    onToggle={() => onChange("generate_audio", !audioOn)}
                  />
                </div>
              </PaneSection>
            )}

            <div className="mt-3 flex items-center justify-between border-t border-white/[0.08] pt-2">
              <button
                type="button"
                data-action="reset-params"
                onClick={() => {
                  onReset();
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/[0.06] hover:text-white"
              >
                <RotateCcw className="h-3 w-3" />
                Сбросить
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-[#2dd4bf]/15 px-2.5 py-1 text-[11px] font-medium text-[#2dd4bf] transition hover:bg-[#2dd4bf]/25"
              >
                Готово
              </button>
            </div>
          </div>
        )}
      </div>

      <SegmentedPills<"omni" | "frames">
        ariaLabel="Режим Seedance"
        options={[
          { id: "omni", label: "Omni", title: "Ссылки: фото, видео, аудио" },
          { id: "frames", label: "Первый+Последний", title: "Только первый и последний кадр" },
        ]}
        value={mode}
        onChange={onMode}
      />

      <SegmentedPills<"fast" | "quality">
        ariaLabel="Пресет качества"
        options={[
          {
            id: "fast",
            label: "Fast",
            icon: <Zap className="h-2.5 w-2.5" />,
            title: "Fast: 480p — дешевле и быстрее",
          },
          {
            id: "quality",
            label: "Quality",
            icon: <Zap className="h-2.5 w-2.5" />,
            title: "Quality: 720p и выше — дороже",
          },
        ]}
        value={preset}
        onChange={onPreset}
      />
    </div>
  );
}
