"use client";

/**
 * РЕЗУЛЬТАТЫ шагов для доски монтажа: что нода реально произвела — текст ответа,
 * файлы, xlsx, картинки, видео, аудио, кадры. Источник — тот же резолвер, что в
 * студии (`web/src/lib/node-result-resolver.ts`), поэтому панель, карточка
 * результата и доска не расходятся.
 *
 * Ключ строки доски: `res:<node_key>:<item_id>` (пишется в
 * `project.meta.montage_rows_visible`).
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink } from "lucide-react";

import { api, type ProjectAsset } from "@/lib/api";
import type {
  ArtifactDTO,
  FrameDTO,
  MontageVariableNodeState,
  NodeRunStatus,
} from "@/lib/types";
import {
  resolveNodeResult,
  type NodeResultContext,
  type NodeResultItem,
  type NodeResultSnapshot,
} from "@/lib/node-result-resolver";
import { cn } from "@/lib/utils";

export const RES_ROW_PREFIX = "res:";

export function resultRowKey(nodeKey: string, itemId: string): string {
  return `${RES_ROW_PREFIX}${nodeKey}:${itemId}`;
}

export function resultShownOnBoard(
  nodeKey: string,
  itemId: string,
  rowsVisible: Record<string, boolean>,
): boolean {
  return rowsVisible[resultRowKey(nodeKey, itemId)] === true;
}

/** id строки-раскладки шага (кадры/сцены) — одна строка на шаг. */
export const SPREAD_ITEM_ID = "spread";

/**
 * Как результат шага ложится на доску:
 * `frame` — ячейка в колонке каждого кадра (персонажи, предметы),
 * `scene` — ячейка на сцену с colSpan по её кадрам (фоны, шоты/сцены/QC),
 * `full` — как было, во всю ширину (тексты, отчёты, глобальное).
 *
 * Для шагов без собственного типа раскладку задают единицы результата:
 * у них есть `placement` с номерами кадров/сцен.
 */
export type ResultRowLayout = "frame" | "scene" | "full";

export function resultRowLayout(
  nodeType: string,
  items?: NodeResultItem[] | null,
): ResultRowLayout {
  if (nodeType === "backgrounds") return "scene";
  if (
    nodeType === "hero" ||
    nodeType === "hitl_hero" ||
    nodeType === "items" ||
    nodeType === "hitl_items"
  ) {
    return "frame";
  }
  if (items && items.length > 0) {
    let frame = false;
    let scene = false;
    for (const item of items) {
      if (item.placement?.kind === "frame") frame = true;
      if (item.placement?.kind === "scene") scene = true;
    }
    if (frame) return "frame";
    if (scene) return "scene";
  }
  return "full";
}

export interface MontageResultNode {
  nodeKey: string;
  nodeType: string;
  label: string;
  state: MontageVariableNodeState;
  /** Строки доски, которые питает шаг (`image1`, `video1`, …). */
  montageRows: string[];
  snapshot: NodeResultSnapshot;
}

/** Состояние ноды из панели → статус запуска, который понимает резолвер. */
function runStatus(state: MontageVariableNodeState): NodeRunStatus {
  switch (state) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "error":
      return "failed";
    case "disabled":
      return "skipped";
    default:
      return "pending";
  }
}

interface MediaReviewRow {
  frame_id: number;
  number: number;
  voiceover_text: string;
  file_path: string | null;
  preview_url: string | null;
}

/**
 * Данные результата по всем шагам проекта. Ключи запросов совпадают со студией,
 * поэтому данные общие; `enabled` — грузим, только когда панель открыта или на
 * доске реально есть строки результатов.
 */
export function useMontageResults(projectId: number | null, enabled: boolean) {
  const montageVars = useQuery({
    queryKey: ["montage-variables", projectId],
    queryFn: () => api.getMontageVariables(projectId as number),
    enabled: enabled && projectId != null,
    staleTime: 15_000,
  });
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId as number),
    enabled: enabled && projectId != null,
    staleTime: 30_000,
  });
  const artifacts = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: () => api.listArtifacts({ project_id: projectId as number }),
    enabled: enabled && projectId != null,
    staleTime: 30_000,
  });
  const projectAssets = useQuery({
    queryKey: ["project-assets", projectId, "all"],
    queryFn: () => api.listProjectAssets(projectId as number, "all"),
    enabled: enabled && projectId != null,
    staleTime: 30_000,
  });
  const frames = useQuery({
    queryKey: ["frames", projectId],
    queryFn: () => api.listFrames(projectId as number),
    enabled: enabled && projectId != null,
    staleTime: 30_000,
  });
  const mediaImages = useQuery({
    queryKey: ["media-review", projectId, "images"],
    queryFn: () => api.listMediaReview(projectId as number, "images"),
    enabled: enabled && projectId != null,
    staleTime: 30_000,
  });
  const mediaVideos = useQuery({
    queryKey: ["media-review", projectId, "videos"],
    queryFn: () => api.listMediaReview(projectId as number, "videos"),
    enabled: enabled && projectId != null,
    staleTime: 30_000,
  });

  const context = useMemo<NodeResultContext>(() => {
    const mapMedia = (rows: MediaReviewRow[] | undefined, kind: "images" | "videos") =>
      (rows ?? [])
        .filter((r) => r.preview_url)
        .map((r): ProjectAsset => ({
          source: "frame",
          id: String(r.frame_id),
          kind,
          path: r.file_path,
          preview_url: r.preview_url,
          label: `Кадр ${r.number}`,
          frame_id: r.frame_id,
          voiceover: r.voiceover_text,
        }));
    return {
      project: project.data ?? null,
      artifacts: (artifacts.data ?? []) as ArtifactDTO[],
      assets: (projectAssets.data ?? []) as ProjectAsset[],
      frames: (frames.data ?? []) as FrameDTO[],
      mediaImages: mapMedia(mediaImages.data as MediaReviewRow[] | undefined, "images"),
      mediaVideos: mapMedia(mediaVideos.data as MediaReviewRow[] | undefined, "videos"),
    };
  }, [
    project.data,
    artifacts.data,
    projectAssets.data,
    frames.data,
    mediaImages.data,
    mediaVideos.data,
  ]);

  const nodes = useMemo<MontageResultNode[]>(() => {
    const list = montageVars.data?.nodes ?? [];
    return list.map((node) => ({
      nodeKey: node.node_key,
      nodeType: node.node_type,
      label: node.label,
      state: node.state,
      montageRows: node.montage_rows ?? [],
      snapshot: resolveNodeResult(
        node.node_type,
        context,
        runStatus(node.state),
        node.node_key,
      ),
    }));
  }, [montageVars.data, context]);

  const loading =
    montageVars.isLoading ||
    project.isLoading ||
    projectAssets.isLoading ||
    frames.isLoading;

  return { nodes, loading, frames: (frames.data ?? []) as FrameDTO[] };
}

// ── Строка результата на доске ──────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  text: "текст",
  image: "картинка",
  video: "видео",
  audio: "аудио",
  file: "файл",
  xlsx: "xlsx",
  frames: "кадры",
};

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 900;
  return (
    <div className="space-y-1">
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/80",
          !expanded && long && "line-clamp-5",
        )}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="text-[10px] font-medium text-[rgba(209,254,23,0.85)] hover:underline"
        >
          {expanded ? "свернуть" : `развернуть (${text.length.toLocaleString("ru-RU")} симв.)`}
        </button>
      ) : null}
    </div>
  );
}

/** Содержимое строки результата на доске: по виду единицы результата. */
export function MontageResultRowContent({
  node,
  item,
  frames,
}: {
  node: MontageResultNode;
  item: NodeResultItem;
  frames: FrameDTO[];
}) {
  const url = item.previewUrl || item.downloadUrl || null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-white/35">
        <span className="rounded border border-white/10 bg-black/25 px-1.5 py-0.5 text-white/55">
          {KIND_LABEL[item.kind] ?? item.kind}
        </span>
        <span className="truncate text-white/45">{item.label}</span>
        <span className="truncate text-white/25">{node.label}</span>
        {item.frameNumber != null ? (
          <span className="text-white/25">кадр {item.frameNumber}</span>
        ) : null}
      </div>

      {item.kind === "text" ? (
        item.content ? (
          <ExpandableText text={item.content} />
        ) : (
          <p className="text-[11px] text-white/35">текста пока нет</p>
        )
      ) : item.kind === "image" && url ? (
        <div className="flex flex-wrap items-start gap-2">
          <a href={url} target="_blank" rel="noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={item.label}
              loading="lazy"
              className="h-28 rounded-md border border-white/10 object-cover"
            />
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-[rgba(209,254,23,0.85)] hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> открыть
          </a>
        </div>
      ) : item.kind === "video" && url ? (
        <div className="flex flex-col gap-1">
          <video src={url} controls preload="metadata" className="max-h-60 w-full max-w-md rounded-md bg-black" />
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-[rgba(209,254,23,0.85)] hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> открыть видео
          </a>
        </div>
      ) : item.kind === "audio" && url ? (
        <div className="flex flex-col gap-1">
          <audio src={url} controls preload="none" className="w-full max-w-md" />
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[10px] text-[rgba(209,254,23,0.85)] hover:underline"
          >
            <Download className="h-3 w-3" /> скачать
          </a>
        </div>
      ) : item.kind === "frames" ? (
        <div className="max-h-56 overflow-auto rounded-md border border-white/10">
          {frames.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-white/35">кадров пока нет</p>
          ) : (
            <table className="w-full border-collapse text-[11px]">
              <tbody>
                {frames.slice(0, 200).map((frame) => (
                  <tr key={frame.id} className="border-t border-white/5 first:border-t-0">
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
          )}
        </div>
      ) : url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-[rgba(209,254,23,0.85)] hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {item.filePath || item.label}
        </a>
      ) : (
        <p className="text-[11px] text-white/35">файла пока нет</p>
      )}

      {item.kind !== "text" && item.kind !== "frames" && item.content ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-[10px] text-white/40">
          {item.content}
        </p>
      ) : null}
    </div>
  );
}

/** Компактное превью единицы результата для списка в панели. */
export function ResultItemPreview({ item }: { item: NodeResultItem }) {
  const url = item.previewUrl || item.downloadUrl || null;
  if (item.kind === "image" && url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={item.label}
        loading="lazy"
        className="h-10 w-14 shrink-0 rounded border border-white/10 object-cover"
      />
    );
  }
  if (item.kind === "text") {
    return (
      <span className="line-clamp-2 min-w-0 text-[10px] text-white/50">
        {item.content || "пусто"}
      </span>
    );
  }
  return (
    <span className="truncate text-[10px] text-white/40">
      {url ? item.filePath || url : item.content || "—"}
    </span>
  );
}

/**
 * Ячейка результатов на доске: единицы результата, привязанные к одному кадру
 * или сцене, идут стопкой (как персонажи) — у каждой подпись и текст.
 */
export function ResultPlacementCell({ items }: { items: NodeResultItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-1">
      {items.map((item) => {
        const url = item.previewUrl || item.downloadUrl || null;
        return (
          <figure
            key={item.id}
            className="w-full overflow-hidden rounded-lg border border-white/10 bg-black/30"
          >
            {item.kind === "image" && url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={item.label}
                loading="lazy"
                className="h-32 w-full object-cover"
              />
            ) : null}
            <figcaption className="space-y-0.5 px-1.5 py-1">
              <p className="truncate text-[10px] font-medium text-white/80">{item.label}</p>
              {item.content ? (
                <p className="line-clamp-4 whitespace-pre-wrap break-words text-[10px] leading-snug text-white/55">
                  {item.content}
                </p>
              ) : null}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
