"use client";

/**
 * Панель «Переменные проекта» — РЕЗУЛЬТАТЫ нод ролика (вид 17.11 18:49).
 *
 * Слева — шаги, справа — результаты выбранного шага. У шага с привязкой к
 * кадрам/сценам одна кнопка на весь шаг: «Показать на доске по кадрам» /
 * «по сценам» (строка `res:<node_key>:spread`). У остальных шагов кнопка у
 * КАЖДОЙ единицы: «Показать на доске» / «Скрыть с доски» (строка
 * `res:<node_key>:<item_id>`). Состояние видно в панели («в монтаже: да/нет»).
 *
 * Что показываем справа: зависит от того, что нода реально произвела.
 *   - картинки/кадры/рефы/фоны/still — РЕАЛЬНЫЕ превью (<img>), клик открывает
 *     оригинал; никаких путей и слова «изображение»;
 *   - тексты (сценарий, тема, сцены по плану, диалоги, каркас, QC, стиль,
 *     отчёт) — текст целиком, обрезка с раскрытием, в порядке единиц;
 *   - видео/аудио — плеер и ссылка на файл;
 *   - файлы (xlsx/pdf/json) — имя файла и ссылка скачать;
 *   - пусто — явно «нет результата».
 *
 * Промт-переменные (тексты, кадры-значения) здесь не показываются: только то,
 * что шаг произвёл.
 *
 * Запрос ленивый: пока панель закрыта, сетевого вызова нет (`enabled`).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleDot,
  Clapperboard,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Image as ImageIcon,
  Layers,
  Lightbulb,
  ListChecks,
  ListMusic,
  Loader2,
  Mic,
  Music,
  Music2,
  Package,
  PenLine,
  RefreshCw,
  ScrollText,
  Send,
  Users,
  Video,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import type {
  MontageBoardFrame,
  MontageVariableNode,
  MontageVariablesDTO,
} from "@/lib/types";
import type { NodeResultItem, NodeResultItemKind } from "@/lib/node-result-resolver";
import {
  resultRowKey,
  resultRowLayout,
  SPREAD_ITEM_ID,
  type MontageResultNode,
  type ResultRowLayout,
} from "@/components/canvas/montage-node-results";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type IconComponent = typeof CircleDot;

/** Иконка ноды по её типу; неизвестный тип — нейтральная точка. */
const NODE_ICONS: Record<string, IconComponent> = {
  topic: Lightbulb,
  plan: FileText,
  script: ScrollText,
  split: Layers,
  scene_design: Users,
  sd_agent: Users,
  sd_assemble: Users,
  excel_gpt: Bot,
  hero: Users,
  items: Package,
  backgrounds: ImageIcon,
  image_prompts: PenLine,
  images: ImageIcon,
  animation_prompts: PenLine,
  videos: Video,
  audio: Mic,
  music: Music,
  sfx_plan: ListMusic,
  sfx_gen: Music2,
  assemble: Clapperboard,
  publish: Send,
};

/** Строка-раскладка шага (по кадрам/по сценам) — одна на шаг. */
function spreadRowKey(nodeKey: string): string {
  return resultRowKey(nodeKey, SPREAD_ITEM_ID);
}

/**
 * Сколько ячеек заполнит раскладка шага: кадры с рефами (персонажи/предметы)
 * или кадры с фоном (сцены). Это та же величина, что видит доска.
 */
function spreadCellCount(
  node: MontageVariableNode | null,
  layout: ResultRowLayout,
  frames: MontageBoardFrame[],
): number {
  if (!node) return 0;
  if (layout === "scene") {
    return frames.filter((fr) => Boolean(fr.background_ref)).length;
  }
  const refsOf = (fr: MontageBoardFrame) =>
    node.node_type === "items" || node.node_type === "hitl_items"
      ? (fr.item_refs ?? [])
      : (fr.character_refs ?? []);
  return frames.filter((fr) => refsOf(fr).length > 0).length;
}

/** Кнопка «Показать на доске»/«Скрыть с доски» у одной единицы результата. */
function UnitToggleButton({
  item,
  shown,
  disabled,
  onToggle,
}: {
  item: NodeResultItem;
  shown: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-action="toggle-unit"
      aria-pressed={shown}
      aria-label={shown ? "Скрыть с доски" : "Показать на доске"}
      title={shown ? "Убрать эту единицу с доски" : "Показать эту единицу строкой на доске"}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium transition disabled:opacity-50",
        shown
          ? "border-[rgba(209,254,23,0.45)] bg-[rgba(209,254,23,0.12)] text-[rgba(209,254,23,0.95)] hover:bg-[rgba(209,254,23,0.2)]"
          : "border-white/15 bg-black/25 text-white/70 hover:bg-white/10 hover:text-white/90",
      )}
    >
      {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      {shown ? "Скрыть с доски" : "Показать на доске"}
      <span className="max-w-[9rem] truncate text-white/40">{item.label}</span>
    </button>
  );
}

/** Состояние кнопок единиц: ключи `res:<node>:<item>` в meta доски. */
interface UnitToggleState {
  nodeKey: string;
  rowsVisible: Record<string, boolean>;
  onSetRows: (rowKeys: string[], visible: boolean) => void;
  rowsSaving: boolean;
}

const KIND_ORDER: NodeResultItemKind[] = [
  "image",
  "text",
  "video",
  "audio",
  "xlsx",
  "file",
  "frames",
];

const KIND_LABEL: Record<NodeResultItemKind, string> = {
  image: "картинки",
  text: "текст",
  video: "видео",
  audio: "аудио",
  file: "файл",
  xlsx: "xlsx",
  frames: "кадры",
};

/** Тип выхода ноды по её единицам результата — для подписи в списке и в шапке. */
function outputKindLabel(items: NodeResultItem[]): string {
  if (items.length === 0) return "нет результата";
  const kinds = new Set(items.map((item) => item.kind));
  const parts: string[] = [];
  for (const kind of KIND_ORDER) {
    if (!kinds.has(kind)) continue;
    // xlsx — тоже файл, но подписываем его отдельно, чтобы не дублировать.
    if (kind === "file" && kinds.has("xlsx")) continue;
    parts.push(KIND_LABEL[kind]);
  }
  return parts.length > 0 ? parts.join(" + ") : "нет результата";
}

/** Сколько единиц у ноды (у таблиц/кадров резолвер считает их отдельно). */
function unitCount(result: MontageResultNode | undefined): number {
  if (!result) return 0;
  return Math.max(result.snapshot.items.length, result.snapshot.itemCount ?? 0);
}

/** Слот ноды на доске (`image1`, `video1`, `voiceover`, …) либо её тип. */
function nodeSlot(node: MontageVariableNode): string {
  const rows = node.montage_rows ?? [];
  return rows.length > 0 ? rows.join(", ") : node.node_type;
}

function baseName(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Техническая подпись единицы (`hero_reference`, `scene_image`, …) — это вид
 * файла, а не имя. Владелец просил показать картинки картинками, поэтому такую
 * подпись заменяем человеческой и нумеруем.
 */
const TECHNICAL_IMAGE_LABEL: Record<string, string> = {
  hero_reference: "Персонаж",
  hero: "Персонаж",
  hitl_hero: "Персонаж",
  background_reference: "Фон",
  background: "Фон",
  scene_image: "Кадр",
  item_reference: "Предмет",
  item: "Предмет",
  still: "Кадр",
};

function isTechnicalLabel(label: string | null | undefined): boolean {
  const text = (label ?? "").trim();
  if (!text) return true;
  return /^[a-z][a-z0-9_]*$/i.test(text);
}

function imageTitle(item: NodeResultItem, index: number): string {
  const raw = (item.label ?? "").trim();
  if (!isTechnicalLabel(raw)) return raw;
  const base = TECHNICAL_IMAGE_LABEL[raw.toLowerCase()] ?? "Картинка";
  return `${base} ${index + 1}`;
}

// ── Текст единицы: целиком, с обрезкой и раскрытием ─────────────────────

const TEXT_CLIP_CHARS = 900;

function ExpandableText({ item }: { item: NodeResultItem }) {
  const [expanded, setExpanded] = useState(false);
  const text = (item.content ?? "").trim();
  if (!text) {
    return <p className="text-[11px] text-white/35">текста нет</p>;
  }
  const long = text.length > TEXT_CLIP_CHARS;
  const toggle = () => {
    if (long) setExpanded((prev) => !prev);
  };
  return (
    <div
      tabIndex={long ? 0 : undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        if (!long) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setExpanded((prev) => !prev);
      }}
      title={long ? (expanded ? "Свернуть текст" : "Развернуть текст") : undefined}
      className={cn("space-y-1", long && "cursor-pointer")}
    >
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/80",
          long && !expanded && "line-clamp-6",
        )}
      >
        {text}
      </p>
      {long ? (
        <span className="text-[10px] font-medium text-[rgba(209,254,23,0.85)]">
          {expanded
            ? "свернуть"
            : `развернуть (${text.length.toLocaleString("ru-RU")} симв.)`}
        </span>
      ) : null}
    </div>
  );
}

// ── Единица результата: вид по её типу ─────────────────────────────────

/** Превью картинки: сам кадр, подпись, клик открывает оригинал. */
function SafeImage({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        data-image-state="missing"
        className="flex h-40 w-full flex-col items-center justify-center gap-1 bg-black/40 px-2 text-center"
      >
        <ImageIcon className="h-5 w-5 text-white/20" />
        <span className="text-[10px] text-white/35">файл картинки не найден</span>
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={title}
      title={title}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-40 w-full object-cover transition hover:opacity-90"
    />
  );
}

function ImageTile({ item, index }: { item: NodeResultItem; index: number }) {
  const url = item.previewUrl || item.downloadUrl || null;
  const title = imageTitle(item, index);
  const rawCaption = (item.content ?? "").trim();
  // Служебную подпись («hero_reference») вторым текстом не дублируем.
  const caption =
    rawCaption && !isTechnicalLabel(rawCaption) && rawCaption !== item.label
      ? rawCaption
      : "";
  if (!url) {
    return (
      <figure className="flex min-h-24 flex-col justify-center rounded-md border border-dashed border-white/15 bg-black/20 px-2 py-3">
        <p className="truncate text-[10px] font-medium text-white/60">{title}</p>
        <p className="mt-1 text-[10px] text-white/35">файл картинки не найден</p>
      </figure>
    );
  }
  return (
    <figure className="overflow-hidden rounded-md border border-white/10 bg-black/30">
      <a href={url} target="_blank" rel="noreferrer" title={`Открыть оригинал: ${title}`} className="block">
        <SafeImage src={url} title={title} />
      </a>
      <figcaption className="space-y-0.5 px-1.5 py-1">
        <p className="truncate text-[10px] font-medium text-white/80">{title}</p>
        {caption ? (
          <p className="line-clamp-2 whitespace-pre-wrap break-words text-[10px] leading-snug text-white/45">
            {caption}
          </p>
        ) : item.frameNumber != null ? (
          <p className="text-[10px] text-white/35">кадр {item.frameNumber}</p>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** Файл (xlsx/pdf/json/архив): имя файла + ссылка скачать. */
function FileRow({ item }: { item: NodeResultItem }) {
  const url = item.downloadUrl || item.previewUrl || null;
  const name = baseName(item.filePath) || item.label;
  return (
    <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-2 py-1.5">
      <FileText className="h-4 w-4 shrink-0 text-white/40" />
      <span className="min-w-0 flex-1 truncate text-[11px] text-white/75" title={name}>
        {name}
      </span>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[10px] text-[rgba(209,254,23,0.85)] hover:underline"
        >
          <Download className="h-3 w-3" /> скачать
        </a>
      ) : (
        <span className="shrink-0 text-[10px] text-white/30">файла нет</span>
      )}
    </div>
  );
}

/** Кадры: таблица номеров и закадра — для нод раскладки/сцен. */
function FramesTable({ frames }: { frames: MontageBoardFrame[] }) {
  if (frames.length === 0) {
    return <p className="text-[11px] text-white/35">кадров пока нет</p>;
  }
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-white/10">
      <table className="w-full border-collapse text-[11px]">
        <tbody>
          {frames.slice(0, 200).map((frame) => (
            <tr key={frame.frame_id} className="border-t border-white/5 first:border-t-0">
              <td className="whitespace-nowrap px-2 py-1 align-top text-white/40">
                #{frame.number}
              </td>
              <td className="px-2 py-1 align-top text-white/75">
                {frame.voiceover_text ? (
                  <span className="line-clamp-2">{frame.voiceover_text}</span>
                ) : (
                  <span className="text-white/25">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Заголовок единицы: подпись + номер кадра (без служебных «типов»). */
function ItemCaption({ item }: { item: NodeResultItem }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-white/45">
      <span className="truncate font-medium text-white/65">{item.label}</span>
      {item.frameNumber != null ? (
        <span className="text-white/30">кадр {item.frameNumber}</span>
      ) : null}
    </p>
  );
}

type ResultGroup =
  | { kind: "images"; items: NodeResultItem[] }
  | { kind: "single"; item: NodeResultItem };

/** Картинки идут сеткой, остальное — блоками во всю ширину, порядок единиц сохранён. */
function groupResultItems(items: NodeResultItem[]): ResultGroup[] {
  const groups: ResultGroup[] = [];
  let buffer: NodeResultItem[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      groups.push({ kind: "images", items: buffer });
      buffer = [];
    }
  };
  for (const item of items) {
    if (item.kind === "image") {
      buffer.push(item);
      continue;
    }
    flush();
    groups.push({ kind: "single", item });
  }
  flush();
  return groups;
}

function ResultItemView({
  item,
  frames,
}: {
  item: NodeResultItem;
  frames: MontageBoardFrame[];
}) {
  const url = item.previewUrl || item.downloadUrl || null;
  switch (item.kind) {
    case "text":
      return (
        <div className="space-y-1 rounded-md border border-white/10 bg-white/[0.02] p-2">
          <ItemCaption item={item} />
          <ExpandableText item={item} />
        </div>
      );
    case "video":
      return (
        <div className="space-y-1 rounded-md border border-white/10 bg-white/[0.02] p-2">
          <ItemCaption item={item} />
          {url ? (
            <>
              <video
                src={url}
                controls
                preload="metadata"
                className="max-h-64 w-full rounded-md bg-black"
              />
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-[rgba(209,254,23,0.85)] hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> открыть видео
              </a>
            </>
          ) : (
            <p className="text-[11px] text-white/35">видеофайла пока нет</p>
          )}
        </div>
      );
    case "audio":
      return (
        <div className="space-y-1 rounded-md border border-white/10 bg-white/[0.02] p-2">
          <ItemCaption item={item} />
          {url ? (
            <audio src={url} controls preload="none" className="w-full" />
          ) : (
            <p className="text-[11px] text-white/35">аудиофайла пока нет</p>
          )}
        </div>
      );
    case "file":
    case "xlsx":
      return <FileRow item={item} />;
    case "frames":
      return (
        <div className="space-y-1 rounded-md border border-white/10 bg-white/[0.02] p-2">
          <ItemCaption item={item} />
          <FramesTable frames={frames} />
        </div>
      );
    default:
      return (
        <div className="space-y-1 rounded-md border border-white/10 bg-white/[0.02] p-2">
          <ItemCaption item={item} />
          {item.content ? <ExpandableText item={item} /> : null}
        </div>
      );
  }
}

/** Кнопка единицы, если панель показывает шаг с кнопкой у каждой единицы. */
function UnitToggleFor({
  item,
  toggle,
}: {
  item: NodeResultItem;
  toggle?: UnitToggleState;
}) {
  if (!toggle) return null;
  const rowKey = resultRowKey(toggle.nodeKey, item.id);
  const shown = toggle.rowsVisible[rowKey] === true;
  return (
    <UnitToggleButton
      item={item}
      shown={shown}
      disabled={toggle.rowsSaving}
      onToggle={() => toggle.onSetRows([rowKey], !shown)}
    />
  );
}

function ResultContent({
  items,
  frames,
  toggle,
}: {
  items: NodeResultItem[];
  frames: MontageBoardFrame[];
  /** Есть — у каждой единицы своя кнопка «Показать на доске»/«Скрыть с доски». */
  toggle?: UnitToggleState;
}) {
  const groups = useMemo(() => groupResultItems(items), [items]);
  return (
    <div className="flex flex-col gap-2">
      {groups.map((group, index) => {
        if (group.kind === "images") {
          return (
            <div
              key={`images-${index}-${group.items[0]?.id ?? index}`}
              className="grid grid-cols-2 gap-2"
            >
              {group.items.map((item, itemIndex) => (
                <div key={item.id} className="flex flex-col gap-1">
                  <ImageTile item={item} index={itemIndex} />
                  <UnitToggleFor item={item} toggle={toggle} />
                </div>
              ))}
            </div>
          );
        }
        return (
          <div key={group.item.id} className="space-y-1">
            <ResultItemView item={group.item} frames={frames} />
            <UnitToggleFor item={group.item} toggle={toggle} />
          </div>
        );
      })}
    </div>
  );
}

// ── Панель ─────────────────────────────────────────────────────────────

function defaultNodeKey(
  nodes: MontageVariableNode[],
  resultByKey: Map<string, MontageResultNode>,
): string | null {
  if (nodes.length === 0) return null;
  const withItems = nodes.find(
    (node) => (resultByKey.get(node.node_key)?.snapshot.items.length ?? 0) > 0,
  );
  return (withItems ?? nodes[0]).node_key;
}

export function MontageVariablesPanel({
  open,
  onOpenChange,
  projectId,
  rowsVisible,
  onSetRows,
  rowsSaving = false,
  results,
  frames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number | null;
  /** Видимость строк доски по ключу строки; спец-строка без ключа = видима. */
  rowsVisible: Record<string, boolean>;
  /** Включить/выключить набор строк доски (клик по шагу включает его строки). */
  onSetRows: (rowKeys: string[], visible: boolean) => void;
  rowsSaving?: boolean;
  /** РЕЗУЛЬТАТЫ шагов (`resolveNodeResult`) — то, что ноды реально произвели. */
  results: MontageResultNode[];
  /** Кадры доски — для нод-раскладок (кадры/сцены). */
  frames: MontageBoardFrame[];
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const variables = useQuery({
    queryKey: ["montage-variables", projectId],
    queryFn: () => api.getMontageVariables(projectId as number),
    enabled: open && projectId != null,
    staleTime: 15_000,
  });

  const data = variables.data;
  const nodes = data?.nodes ?? [];

  const resultByKey = useMemo(
    () => new Map(results.map((result) => [result.nodeKey, result])),
    [results],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Доска монтажа слушает тот же Escape (window, всплытие): перехватываем
      // на capture и закрываем только панель, иначе Esc гасит всю доску.
      event.stopImmediatePropagation();
      event.preventDefault();
      onOpenChange(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  // Выбор ноды — производная от данных: выбранной может не быть в новом ответе.
  const activeKey = useMemo(() => {
    if (selectedKey && nodes.some((node) => node.node_key === selectedKey)) {
      return selectedKey;
    }
    return data ? defaultNodeKey(nodes, resultByKey) : null;
  }, [data, nodes, selectedKey, resultByKey]);
  const activeNode = nodes.find((node) => node.node_key === activeKey) ?? null;
  const activeResult = activeKey ? resultByKey.get(activeKey) ?? null : null;
  const activeItems = activeResult?.snapshot.items ?? [];
  const activeType = outputKindLabel(activeItems);
  const activeCount = unitCount(activeResult ?? undefined);
  const activeLayout: ResultRowLayout = activeNode
    ? resultRowLayout(activeNode.node_type, activeItems)
    : "full";
  const activeSpreadKey = activeKey != null ? spreadRowKey(activeKey) : null;
  const activeSpreadOn = activeSpreadKey != null && rowsVisible[activeSpreadKey] === true;
  const activeSpreadCells = spreadCellCount(activeNode, activeLayout, frames);
  const activeSpreadTitle = activeLayout === "frame" ? "по кадрам" : "по сценам";

  if (!open) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start gap-2 border-b border-white/10 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-white/90">
            <ListChecks className="h-4 w-4 text-[rgba(209,254,23,0.9)]" />
            Переменные проекта
          </p>
          <p className="mt-1 truncate text-[11px] text-white/40">
            {data
              ? `${data.nodes.length} шагов · кадров ${data.totals.frames} · картинок ${data.totals.images} · видео ${data.totals.videos} · персонажей ${data.totals.heroes} · фонов ${data.totals.backgrounds}`
              : "Что произвели ноды ролика"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Закрыть"
          onClick={() => onOpenChange(false)}
          className="shrink-0 rounded-md p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white/80"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 py-2.5">
        {variables.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : variables.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-destructive">Не удалось получить переменные проекта</p>
            <p className="max-w-xl whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {variables.error instanceof Error
                ? variables.error.message || String(variables.error)
                : String(variables.error ?? "неизвестная ошибка")}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void variables.refetch()}
            >
              <RefreshCw className="mr-1 h-4 w-4" />
              Повторить
            </Button>
          </div>
        ) : nodes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">
              В графе проекта нет нод с переменными.
            </p>
            <p className="text-xs text-white/35">
              Проверьте граф ролика на канвасе — панель показывает только реальные ноды.
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-white/10">
            <aside className="w-[250px] shrink-0 overflow-y-auto border-r border-white/10 bg-black/20 p-1.5">
              {nodes.map((node) => {
                const Icon = NODE_ICONS[node.node_type] ?? CircleDot;
                const active = node.node_key === activeKey;
                const result = resultByKey.get(node.node_key);
                const items = result?.snapshot.items ?? [];
                const type = outputKindLabel(items);
                const count = unitCount(result);
                const layout = resultRowLayout(node.node_type, items);
                const cells = spreadCellCount(node, layout, frames);
                const spreadLabel =
                  layout === "frame"
                    ? "по кадрам"
                    : layout === "scene"
                      ? "по сценам"
                      : "";
                return (
                  <div
                    key={node.node_key}
                    data-node-key={node.node_key}
                    data-node-type={node.node_type}
                    data-output-type={type}
                    data-unit-count={count}
                    tabIndex={0}
                    onClick={() => setSelectedKey(node.node_key)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedKey(node.node_key);
                    }}
                    title={node.step_code ? `${node.label} · ${node.step_code}` : node.label}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-1.5 rounded-md px-2 py-1.5 text-left transition",
                      active ? "bg-white/[0.08]" : "hover:bg-white/[0.04]",
                    )}
                  >
                    <Icon
                      className={cn(
                        "mt-0.5 h-4 w-4 shrink-0",
                        active ? "text-[rgba(209,254,23,0.9)]" : "text-white/40",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-white/85">
                        {node.label}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-white/40">
                        {node.montage_rows && node.montage_rows.length > 0
                          ? `${nodeSlot(node)} · `
                          : ""}
                        результат: {type}
                        {count > 0 ? ` · единиц: ${count}` : ""}
                        {spreadLabel ? ` · ${spreadLabel}: ${cells}` : ""}
                      </span>
                    </span>
                  </div>
                );
              })}
            </aside>

            <section
              data-panel-node={activeKey ?? undefined}
              className="min-w-0 flex-1 overflow-y-auto p-2.5"
            >
              {activeNode && activeKey ? (
                <>
                  <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-sm font-semibold text-white/90">{activeNode.label}</h3>
                    <span className="font-mono text-[10px] text-white/30">
                      {activeNode.node_key}
                    </span>
                    {activeNode.montage_rows && activeNode.montage_rows.length > 0 ? (
                      <span className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-white/40">
                        слот {nodeSlot(activeNode)}
                      </span>
                    ) : null}
                    {activeNode.step_code ? (
                      <span className="rounded border border-white/10 bg-black/30 px-1.5 py-0.5 text-[10px] text-white/40">
                        шаг {activeNode.step_code}
                      </span>
                    ) : null}
                  </div>

                  {activeLayout === "frame" || activeLayout === "scene" ? (
                    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
                      {activeResult?.snapshot.summary ? (
                        <span className="text-[11px] text-white/55">
                          {activeResult.snapshot.summary}
                        </span>
                      ) : null}
                      <span className="text-[10px] text-white/35">
                        {activeSpreadTitle}: непустых ячеек {activeSpreadCells}
                        {activeCount > 0 ? ` · единиц: ${activeCount}` : ""}
                      </span>
                      <span
                        className={cn(
                          "text-[10px]",
                          activeSpreadOn ? "text-[rgba(209,254,23,0.75)]" : "text-white/25",
                        )}
                      >
                        в монтаже: {activeSpreadOn ? "да" : "нет"}
                      </span>
                      <button
                        type="button"
                        data-action="toggle-spread"
                        aria-pressed={activeSpreadOn}
                        aria-label={`${activeSpreadOn ? "Скрыть с доски" : "Показать на доске"} ${activeSpreadTitle}`}
                        title={
                          activeSpreadCells === 0 && !activeSpreadOn
                            ? "У шага нет данных для раскладки"
                            : activeSpreadOn
                              ? `Убрать строку шага с доски (${activeSpreadTitle})`
                              : `Показать строку шага на доске (${activeSpreadTitle})`
                        }
                        disabled={rowsSaving || (activeSpreadCells === 0 && !activeSpreadOn)}
                        onClick={() =>
                          activeSpreadKey && onSetRows([activeSpreadKey], !activeSpreadOn)
                        }
                        className={cn(
                          "ml-auto inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-50",
                          activeSpreadOn
                            ? "border-[rgba(209,254,23,0.45)] bg-[rgba(209,254,23,0.12)] text-[rgba(209,254,23,0.95)] hover:bg-[rgba(209,254,23,0.2)]"
                            : "border-white/15 bg-black/25 text-white/70 hover:bg-white/10 hover:text-white/90",
                        )}
                      >
                        {activeSpreadOn ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                        {activeSpreadOn ? "Скрыть с доски" : "Показать на доске"}{" "}
                        {activeSpreadTitle}
                      </button>
                    </div>
                  ) : (
                    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-white/10 bg-black/20 px-2 py-1.5">
                      {activeResult?.snapshot.summary ? (
                        <span className="text-[11px] text-white/55">
                          {activeResult.snapshot.summary}
                        </span>
                      ) : null}
                      <span className="text-[10px] text-white/35">тип выхода: {activeType}</span>
                      {activeCount > 0 ? (
                        <span className="text-[10px] text-white/35">единиц: {activeCount}</span>
                      ) : null}
                      <span className="text-[10px] text-white/30">
                        у каждой единицы своя кнопка «Показать на доске» / «Скрыть с доски»
                      </span>
                    </div>
                  )}

                  {activeResult ? (
                    activeItems.length > 0 ? (
                      <ResultContent
                        items={activeItems}
                        frames={frames}
                        toggle={
                          activeLayout === "frame" ||
                          activeLayout === "scene" ||
                          activeKey == null
                            ? undefined
                            : {
                                nodeKey: activeKey,
                                rowsVisible,
                                onSetRows,
                                rowsSaving,
                              }
                        }
                      />
                    ) : (
                      <p className="text-xs text-white/35">
                        нет результата — шаг ещё не произвёл данных.
                      </p>
                    )
                  ) : (
                    <p className="text-xs text-white/35">
                      нет результата — данные шага ещё загружаются.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-white/35">Выберите шаг слева.</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
