"use client";

/**
 * Детали дока «Генерация» в стиле outsee.io/create (новый дизайн):
 * — квадратные плитки референсов с номером внутри категории и меткой типа
 *   (фото / видео / аудио), счётчики вида «Фото 2/9»;
 * — меню вставки референса по «@» с фактическими именами вложений;
 * — общее окно настроек ModelSettingsDock: одни чипы открывают одну панель
 *   «Параметры» с секциями, у семейства — переключатель режимов;
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
  Hash,
  ImageIcon,
  Images,
  Layers,
  Loader2,
  Maximize2,
  Mic,
  Music,
  Plus,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Type,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { REF_KIND_LABEL, refToken, type GenRef, type RefKind } from "@/lib/gen-dock-refs";
import {
  durationNumbers,
  formatSettingChip,
  modelSettingValue,
  settingIsOn,
  type ModelSettingDescriptor,
  type ModelSettingIcon,
} from "@/lib/model-settings";
import { cn } from "@/lib/utils";

/** Изумрудный акцент студии; им помечены активные элементы окна генерации. */
export const GEN_ACCENT = "#2dd4bf";

// Чистая логика имён референсов живёт в lib/gen-dock-refs.ts (там её покрывают
// юнит-тесты); здесь — только UI-детали дока. Реэкспорт оставлен, чтобы
// существующие импорты из "./gen-dock-parts" не менялись.
export {
  REF_KIND_LABEL,
  framesFromKieValues,
  nameFromUrl,
  refToken,
  refsFromKieFields,
  type GenRef,
  type RefKind,
} from "@/lib/gen-dock-refs";

export function refKindIcon(kind: RefKind, className = "h-3 w-3") {
  if (kind === "video") return <Film className={className} />;
  if (kind === "audio") return <Music className={className} />;
  return <ImageIcon className={className} />;
}

/** Слот кадра: у «первого» и «последнего» кадра свои иконки, а не общая картинка. */
export type FrameSlot = "first" | "last";

/**
 * «Первый кадр»: рамка кадра + планка слева, стрелка указывает ВЛЕВО — на планку,
 * то есть в начало (кадр начинается с неё). Рисунок зеркален «последнему кадру»
 * (там планка справа и стрелка вправо), поэтому при 18 px глифы различаются
 * направлением, а не толщиной линий.
 */
function FirstFrameGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      className={className}
      aria-hidden="true"
    >
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
      <path d="M4.4 4.6v6.8" strokeLinecap="round" />
      <path d="M10.8 8H6.5M7.6 6.3 5.8 8 7.6 9.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** «Последний кадр»: рамка кадра + планка справа и стрелка в неё (кадр заканчивается). */
function LastFrameGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      className={className}
      aria-hidden="true"
    >
      <rect x="1.8" y="3" width="12.4" height="10" rx="1.6" />
      <path d="M11.6 4.6v6.8" strokeLinecap="round" />
      <path d="M5.2 8h4.3M8.4 6.3 10.2 8 8.4 9.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function frameSlotIcon(slot: FrameSlot, className = "h-3 w-3") {
  return slot === "first" ? <FirstFrameGlyph className={className} /> : <LastFrameGlyph className={className} />;
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

/** Пунктирная плитка референса: только иконка, высота вдвое меньше плитки (34 px). */
export function AddTile({
  kind,
  label,
  slot,
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
  /** Кадровые слоты рисуют свою иконку: первый кадр / последний кадр. */
  slot?: FrameSlot;
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
      data-ref-slot={slot}
      onClick={onClick}
      disabled={disabled || busy}
      title={showCount ? `Добавить: ${text}` : `Добавить: ${base}`}
      aria-label={showCount ? `Добавить: ${text}` : `Добавить: ${base}`}
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
        "flex h-[34px] w-[68px] shrink-0 items-center justify-center rounded-lg border-dashed bg-white/[0.025] text-white/45 transition-colors",
        "border-[1.5px] border-white/10 hover:bg-white/[0.06] hover:text-white/80",
        (disabled || busy) && "cursor-not-allowed opacity-40 hover:bg-white/[0.025]",
      )}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <span className="relative flex items-center justify-center">
          {/* У каждого типа свой рисунок: фото ≠ видео ≠ аудио ≠ первый/последний кадр */}
          {slot ? (
            frameSlotIcon(slot, "h-[18px] w-[18px]")
          ) : kind === "image" ? (
            <Images className="h-[18px] w-[18px]" />
          ) : (
            refKindIcon(kind, "h-[18px] w-[18px]")
          )}
          {/* Маленький плюс уголком: плитка именно добавляет, а не показывает */}
          <Plus className="absolute -right-[7px] -bottom-[5px] h-2.5 w-2.5 text-[#2dd4bf]" />
        </span>
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
  slot,
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
  /** Кадровый слот: рисует свою иконку на пунктирной плитке. */
  slot?: FrameSlot;
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
          slot={slot}
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
function PaneSection({
  title,
  children,
  hideTitle,
}: {
  title: string;
  children: ReactNode;
  hideTitle?: boolean;
}) {
  return (
    <div className="mt-3 first:mt-0">
      {!hideTitle && (
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/40">
          {title}
        </p>
      )}
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

/** Иконка чипа по смыслу настройки. */
function settingIcon(icon: ModelSettingIcon, value: unknown) {
  switch (icon) {
    case "aspect":
      return <Maximize2 className="h-3 w-3" />;
    case "resolution":
      return <Layers className="h-3 w-3" />;
    case "duration":
      return <Clock className="h-3 w-3" />;
    case "sound":
      return settingIsOn(value) ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />;
    case "voice":
      return <Mic className="h-3 w-3" />;
    case "number":
      return <Hash className="h-3 w-3" />;
    case "range":
      return <SlidersHorizontal className="h-3 w-3" />;
    case "toggle":
      return <Power className="h-3 w-3" />;
    case "select":
      return <ChevronDown className="h-3 w-3" />;
    case "text":
    default:
      return <Type className="h-3 w-3" />;
  }
}

/** Общие классы кнопки-опции в панели «Параметры». */
const OPTION_CLASS = (active: boolean) =>
  cn(
    "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-[11px] font-medium transition",
    active
      ? "border-[#2dd4bf]/55 bg-[#2dd4bf]/12 text-[#2dd4bf]"
      : "border-white/[0.08] bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white",
  );

/** Один контрол панели: select — сетка кнопок, toggle — тумблер, number — степпер, text — поле. */
function SettingControl({
  descriptor,
  value,
  onChange,
  onOpenVoiceModal,
  formatVoice,
}: {
  descriptor: ModelSettingDescriptor;
  value: unknown;
  onChange: (name: string, v: unknown) => void;
  onOpenVoiceModal?: () => void;
  formatVoice?: (value: unknown) => string;
}) {
  const d = descriptor;

  if (d.kind === "select") {
    const options = d.options ?? [];
    const current = String(value ?? "");
    const isAspect = d.name === "aspect" || d.name === "aspect_ratio";
    const cols = isAspect || options.length > 6 ? "grid-cols-3" : "grid-cols-2";
    return (
      <div className={cn("grid gap-1.5", cols)}>
        {options.map((o) => {
          const active = o.id === current;
          // Подсказка — только из данных опции. Никаких карт «1080p = только
          // Quality»: у разных моделей разрешения доступны на разных тирах.
          const hint = o.hint;
          return (
            <button
              key={o.id}
              type="button"
              {...(isAspect ? { "data-ratio": o.id } : {})}
              {...(d.name === "resolution" ? { "data-resolution": o.id } : {})}
              data-setting-option={o.id}
              onClick={() => onChange(d.name, o.id)}
              className={OPTION_CLASS(active)}
            >
              {isAspect && /^\d+:\d+$/.test(o.id) && <RatioGlyph ratio={o.id} />}
              <span>{o.label}</span>
              {hint && <span className="text-[9px] font-normal text-white/35">{hint}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  if (d.kind === "toggle") {
    const on = settingIsOn(value);
    return (
      <div
        data-setting-option={on ? "on" : "off"}
        className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-2"
      >
        <span className="text-[11px] font-medium leading-tight text-white/80" title={d.hint || undefined}>{d.label}</span>
        <ToggleSwitch on={on} label={d.label} onToggle={() => onChange(d.name, !on)} />
      </div>
    );
  }

  if (d.kind === "duration") {
    const current = Number(value);
    return (
      <div className="grid grid-cols-6 gap-1.5">
        {durationNumbers(d).map((n) => {
          const active = Number.isFinite(current) && current === n;
          return (
            <button
              key={n}
              type="button"
              data-duration={n}
              data-setting-option={String(n)}
              onClick={() => onChange(d.name, d.valueType === "string" ? String(n) : n)}
              className={cn(
                "h-8 rounded-lg border text-[11px] font-medium tabular-nums transition",
                active
                  ? "border-[#2dd4bf]/55 bg-[#2dd4bf]/12 text-[#2dd4bf]"
                  : "border-white/[0.08] bg-white/[0.03] text-white/70 hover:border-white/20 hover:text-white",
              )}
            >
              {n}
              {d.suffix ?? ""}
            </button>
          );
        })}
      </div>
    );
  }

  if (d.kind === "number") {
    const num = Number(value);
    const step = d.step ?? 1;
    const bump = (dir: 1 | -1) => {
      const base = Number.isFinite(num) ? num : Number(d.min ?? 0);
      let next = base + dir * step;
      if (d.min !== undefined) next = Math.max(d.min, next);
      if (d.max !== undefined) next = Math.min(d.max, next);
      onChange(d.name, Number(next.toFixed(6)));
    };
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`${d.label}: меньше`}
          onClick={() => bump(-1)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-[14px] text-white/70 transition hover:border-white/20 hover:text-white"
        >
          −
        </button>
        <input
          type="number"
          data-setting-option={Number.isFinite(num) ? String(num) : ""}
          value={Number.isFinite(num) ? String(num) : ""}
          min={d.min}
          max={d.max}
          step={step}
          onChange={(e) => onChange(d.name, e.target.value === "" ? undefined : Number(e.target.value))}
          className="h-8 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 font-mono text-[12px] text-white/90 outline-none focus:border-[#2dd4bf]/50"
        />
        <button
          type="button"
          aria-label={`${d.label}: больше`}
          onClick={() => bump(1)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-[14px] text-white/70 transition hover:border-white/20 hover:text-white"
        >
          +
        </button>
      </div>
    );
  }

  if (d.kind === "range") {
    const raw = Number(value);
    const num = Number.isFinite(raw) ? raw : Number(d.min ?? 0);
    return (
      <div className="flex items-center gap-2">
        <input
          type="range"
          data-setting-option={String(num)}
          min={d.min ?? 0}
          max={d.max ?? 1}
          step={d.step ?? 0.01}
          value={num}
          onChange={(e) => onChange(d.name, parseFloat(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-lg bg-white/20 accent-[#2dd4bf]"
        />
        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-[#2dd4bf]">
          {num.toFixed(2)}
        </span>
      </div>
    );
  }

  if (d.kind === "voice") {
    return (
      <button
        type="button"
        data-setting-option="voice"
        onClick={onOpenVoiceModal}
        className="inline-flex h-8 w-full items-center gap-1.5 rounded-lg border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-2 text-[12px] font-medium text-[#2dd4bf] transition hover:border-[#2dd4bf]/60 hover:bg-[#2dd4bf]/20"
      >
        <Mic className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate text-left">
          {formatVoice ? formatVoice(value) : String(value ?? "")}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
    );
  }

  return (
    <input
      data-setting-option="text"
      value={String(value ?? "")}
      onChange={(e) => onChange(d.name, e.target.value)}
      placeholder={d.hint || "—"}
      className="h-8 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 text-[12px] text-white/85 outline-none placeholder:text-white/25 focus:border-[#2dd4bf]/50"
    />
  );
}

/** Опция селектора режима семейства в панели «Параметры». */
export type ModelSettingModeOption = { id: string; label: string; hint?: string };

/**
 * Одно окно настроек для ВСЕХ моделей Create (как у Seedance): чипы параметров
 * открывают одну панель «Параметры» с секциями. Внутренности зависят только от
 * списка дескрипторов (lib/model-settings.ts) — KIE и outsee строят его по-своему.
 *
 * Если у модели есть режимы семейства (modes), первой секцией панели идёт
 * переключатель режима, а рядом с чипами — бейдж текущего режима.
 *
 * Особенности Seedance (Omni/Первый+Последний, Fast/Quality) передаются в
 * `extras` и остаются рядом с чипами.
 */
export function ModelSettingsDock({
  settings,
  values,
  onChange,
  onReset,
  onOpenVoiceModal,
  formatVoice,
  onPanelOpen,
  extras,
  panelExtras,
  renderVoice,
  modes = [],
  modeId,
  onModeChange,
  fieldsKnown,
  priceLabel,
}: {
  settings: ModelSettingDescriptor[];
  values: Record<string, unknown>;
  onChange: (name: string, v: unknown) => void;
  /** Сброс параметров к дефолтам модели; без него кнопки «Сбросить» нет. */
  onReset?: () => void;
  /** Голосовое поле — не панель, а модалка библиотеки голосов. */
  onOpenVoiceModal?: () => void;
  /** Как показать выбранный голос; по умолчанию — сырое значение. */
  formatVoice?: (value: unknown) => string;
  /** Перед открытием панели: закрыть пикер модели и чужие выпадашки. */
  onPanelOpen?: () => void;
  extras?: ReactNode;
  /**
   * Дополнительные строки ВНУТРИ панели «Параметры» (голоса, аудио-теги и
   * прочее, что хозяин модели захотел видеть в одном окне с настройками).
   */
  panelExtras?: ReactNode;
  /**
   * Своё рисование голосового поля внутри панели: выпадающий список справа
   * вместо модалки. Не задано — поле остаётся кнопкой `onOpenVoiceModal`.
   */
  renderVoice?: (descriptor: ModelSettingDescriptor) => ReactNode;
  /** Режимы семейства: первая секция панели + бейдж текущего режима. */
  modes?: ModelSettingModeOption[];
  modeId?: string | null;
  onModeChange?: (id: string) => void;
  /**
   * Схема полей режима/модели известна (fields_known). false — реально
   * неизвестная схема («настройки неизвестны»); true/undefined — полей просто
   * нет («нет дополнительных настроек»).
   */
  fieldsKnown?: boolean;
  /** Цена за текущие настройки — в шапке панели, пересчитывается на лету. */
  priceLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const closePanel = () => {
    setOpen(false);
    setActiveTarget(null);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Выпадашки-строки панели (голоса, аудио-теги) живут порталом вне boxRef:
      // клик по ним не должен закрывать панель до того, как сработает выбор.
      const target = e.target;
      if (target instanceof Element && target.closest("[data-params-flyout]")) return;
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const togglePanelFor = (target: string) => {
    if (open && activeTarget === target) {
      closePanel();
    } else {
      if (!open) onPanelOpen?.();
      setActiveTarget(target);
      setOpen(true);
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const selector =
              target === "mode"
                ? '[data-pane-section="mode"]'
                : `[data-setting-name="${target}"]`;
            const el = boxRef.current?.querySelector(selector);
            if (el && typeof el.scrollIntoView === "function") {
              el.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }
          }, 40);
        });
      }
    }
  };

  const sections: { title: string; items: ModelSettingDescriptor[] }[] = [];
  for (const d of settings) {
    const last = sections[sections.length - 1];
    if (last && last.title === d.section) last.items.push(d);
    else sections.push({ title: d.section, items: [d] });
  }

  const showModeBadge = modes.length > 1 && Boolean(onModeChange);
  const showModeSection = modes.length > 1 && Boolean(onModeChange);
  const activeMode = modes.find((m) => m.id === modeId) ?? modes[0] ?? null;

  /**
   * Текст пустой панели. «Настройки неизвестны» — только когда схема реально
   * неизвестна (fields_known === false). Если схема известна, а полей-настроек
   * нет (все поля файловые/промпт) — честное «нет дополнительных настроек».
   */
  const emptyNote: { attr: "no-fields" | "no-settings"; text: string } = !showModeSection
    ? {
        attr: "no-settings",
        text: "У этой модели нет отдельных настроек — доступны только промпт и файлы.",
      }
    : fieldsKnown === false
      ? {
          attr: "no-fields",
          text: "Настройки этого режима неизвестны — доступны только промпт и файлы.",
        }
      : {
          attr: "no-settings",
          text: "У этого режима нет дополнительных настроек — только промпт и файлы.",
        };

  return (
    <div ref={boxRef} className="inline-flex flex-wrap items-center gap-1.5">
      {showModeBadge && activeMode && (
        <button
          type="button"
          data-mode-badge={activeMode.id}
          title={`Режим: ${activeMode.label} — нажмите, чтобы переключить`}
          onClick={() => togglePanelFor("mode")}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition hover:bg-[#2dd4bf]/20",
            open && activeTarget === "mode"
              ? "border-[#2dd4bf]/80 bg-[#2dd4bf]/25 text-[#2dd4bf] ring-1 ring-[#2dd4bf]/40"
              : "border-[#2dd4bf]/45 bg-[#2dd4bf]/12 text-[#2dd4bf]",
          )}
        >
          <Layers className="h-3 w-3" />
          <span className="max-w-[200px] truncate">
            {activeMode.label.includes(":") ? activeMode.label.replace(":", " ·") : activeMode.label}
          </span>
        </button>
      )}
      <div className="relative inline-flex flex-wrap items-center gap-1.5">
        {/* Постоянная кнопка «Параметры»: панель доступна у любой модели,
            даже если у неё нет ни одного чипа-настройки. */}
        <button
          type="button"
          data-action="open-params"
          data-params-button="true"
          aria-label="Параметры"
          aria-expanded={open}
          title="Все настройки модели и цена"
          onClick={() => togglePanelFor("params")}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition",
            open && activeTarget === "params"
              ? "border-[#2dd4bf]/55 bg-[#2dd4bf]/12 text-[#2dd4bf]"
              : "border-white/[0.08] bg-white/[0.03] text-white/60 hover:border-white/20 hover:text-white",
          )}
        >
          <SlidersHorizontal className="h-3 w-3" />
          <span>Параметры</span>
        </button>

        {settings.map((d) => {
          const value = modelSettingValue(d, values);
          const isVoice = d.kind === "voice";
          const text = isVoice && formatVoice ? formatVoice(value) : formatSettingChip(d, values);
          const isChipActive = open && activeTarget === d.name;
          return (
            <span key={d.name} data-chip={d.chip}>
              <ParamChip
                icon={settingIcon(d.icon, value)}
                value={text}
                title={d.hint || d.label}
                active={isChipActive}
                // Если владелец нарисовал голос внутри панели (renderVoice),
                // чип ведёт в «Параметры»; иначе — в прежнюю модалку библиотеки.
                onClick={
                  isVoice
                    ? renderVoice
                      ? () => togglePanelFor(d.name)
                      : () => onOpenVoiceModal?.()
                    : () => togglePanelFor(d.name)
                }
              />
            </span>
          );
        })}

        {open && (
          <div
            data-params-panel="true"
            className="absolute bottom-full left-0 z-[1000] mb-2 max-h-[70vh] w-[322px] overflow-y-auto rounded-xl border border-white/15 bg-[#121216]/97 p-3 shadow-[0_18px_45px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">
                Параметры
              </p>
              {priceLabel && (
                <span
                  data-price-label="true"
                  className="font-mono text-[11px] font-semibold text-[#5eead4]"
                  title="Цена за выбранные настройки (с наценкой студии)"
                >
                  {priceLabel}
                </span>
              )}
            </div>

            {showModeSection && (
              <div data-pane-section="mode">
                <PaneSection title="Режим">
                  <div className="grid grid-cols-2 gap-1.5">
                  {modes.map((m) => {
                    const at = m.label.indexOf(":");
                    const title = at >= 0 ? m.label.slice(0, at).trim() : m.label;
                    const subtitle = at >= 0 ? m.label.slice(at + 1).trim() : null;
                    const isSelected = m.id === (activeMode?.id ?? "");
                    return (
                      <button
                        key={m.id}
                        type="button"
                        data-mode-option={m.id}
                        data-setting-option={m.id}
                        title={m.hint || m.label}
                        onClick={() => onModeChange?.(m.id)}
                        className={cn(
                          "flex flex-col items-start justify-center rounded-lg border px-2.5 py-1.5 text-left transition min-h-[40px]",
                          isSelected
                            ? "border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#2dd4bf] shadow-[0_0_12px_rgba(45,212,191,0.2)]"
                            : "border-white/10 bg-white/[0.04] text-white/80 hover:border-white/20 hover:bg-white/[0.08] hover:text-white",
                        )}
                      >
                        <span className="w-full truncate text-[11px] font-semibold leading-tight">{title}</span>
                        {subtitle ? (
                          <span
                            className={cn(
                              "w-full truncate text-[9px] leading-tight mt-0.5",
                              isSelected ? "text-[#5eead4]/80" : "text-white/45",
                            )}
                          >
                            {subtitle}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </PaneSection>
            </div>
          )}

            {sections.map((section) => {
              const isSingleToggle = section.items.length === 1 && section.items[0]?.kind === "toggle";
              const isSoundSection = section.title.toLowerCase() === "звук" || section.title.toLowerCase() === "sound";
              const hideTitle = isSingleToggle || isSoundSection;
              return (
                <PaneSection key={section.title} title={section.title} hideTitle={hideTitle}>
                  <div className="space-y-1.5">
                    {section.items.map((d) => (
                      <div key={d.name} data-setting-name={d.name} data-setting-kind={d.kind}>
                        {d.kind === "voice" && renderVoice ? (
                          renderVoice(d)
                        ) : (
                          <SettingControl
                            descriptor={d}
                            value={modelSettingValue(d, values)}
                            onChange={onChange}
                            onOpenVoiceModal={onOpenVoiceModal}
                            formatVoice={formatVoice}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </PaneSection>
              );
            })}

            {!sections.length && (
              <p
                data-params-note={emptyNote.attr}
                className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] leading-snug text-white/45"
              >
                {emptyNote.text}
              </p>
            )}

            {panelExtras && (
              <div className="mt-2 space-y-1.5 border-t border-white/[0.08] pt-2">
                {panelExtras}
              </div>
            )}

            <div className="mt-3 flex items-center justify-between border-t border-white/[0.08] pt-2">
              {onReset ? (
                <button
                  type="button"
                  data-action="reset-params"
                  onClick={() => {
                    onReset();
                    closePanel();
                  }}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/[0.06] hover:text-white"
                >
                  <RotateCcw className="h-3 w-3" />
                  Сбросить
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={closePanel}
                className="rounded-lg bg-[#2dd4bf]/15 px-2.5 py-1 text-[11px] font-medium text-[#2dd4bf] transition hover:bg-[#2dd4bf]/25"
              >
                Готово
              </button>
            </div>
          </div>
        )}
      </div>

      {extras}
    </div>
  );
}
