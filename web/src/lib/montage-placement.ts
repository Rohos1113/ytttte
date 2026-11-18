"use client";

/**
 * Привязка единиц результата к их месту на доске: кадр или сцена.
 *
 * Источники — то, что уже есть у фронта:
 *  - `attrs` кадров (`GET /api/projects/{id}/frames`): `сцена`, `кадры`,
 *    `речь`, `место`, `событие`, `id_плана` — шоты, сцены по плану, диалоги,
 *    каркас;
 *  - JSON-файлы слотов excel_gpt (`qc_report.json`, `style_report.json`) по
 *    ссылкам из `montage/variables` (переменная `output_files`).
 *
 * Место единицы: `{kind:"scene", sceneIndex}` (номер сцены = номер кадра-
 * родителя сцены) или `{kind:"frame", frameNumbers}`; остальное — `full`.
 */

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import type {
  FrameDTO,
  MontageVariableItem,
  MontageVariableNode,
} from "@/lib/types";
import type {
  MontageResultNode,
  ResultRowLayout,
} from "@/components/canvas/montage-node-results";
import type { NodeResultItem, NodeResultPlacement } from "@/lib/node-result-resolver";

/** Слот excel_gpt, у которого результат раскладывается по кадрам/сценам. */
const PLACED_SLOTS = new Set(["scenes", "shots", "dialogues", "skeleton", "qc", "style"]);

/** Слоты, данные которых лежат в файлах слотов. */
const SLOT_FILES = {
  qc: "qc_report.json",
  style: "style_report.json",
} as const;

type SlotName = keyof typeof SLOT_FILES;

interface SlotItem {
  id: string;
  label: string;
  content: string;
  placement: NodeResultPlacement;
}

export interface SlotPlacements {
  /** node_key → единицы результата с местом на доске. */
  byNode: Map<string, SlotItem[]>;
  /** node_key → слот excel_gpt. */
  slotByNode: Map<string, string>;
}

function text(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((entry) => text(entry)).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value).trim();
}

function attrsOf(frame: FrameDTO): Record<string, unknown> {
  return frame.attrs && typeof frame.attrs === "object" ? frame.attrs : {};
}

function sceneOf(frame: FrameDTO): number {
  return frame.number;
}

function scenePlacement(scene: number): NodeResultPlacement {
  return { kind: "scene", sceneIndex: scene };
}

function slotOfNode(node: MontageVariableNode): string | null {
  const match = /pk_([a-z0-9_]+)$/i.exec(node.node_key);
  if (match) return match[1].toLowerCase();
  return null;
}

function slotFileUrl(node: MontageVariableNode, filename: string): string | null {
  for (const variable of node.vars ?? []) {
    if (variable.key !== "output_files") continue;
    const value = variable.value;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== "object" || entry == null) continue;
      const item = entry as MontageVariableItem;
      if (!item.url) continue;
      if (item.url.toLowerCase().includes(filename.toLowerCase())) return item.url;
    }
  }
  return null;
}

// ── Атрибуты кадров ──────────────────────────────────────────────────────

/** «Шоты»: по шоту на сцену, из `attrs.кадры`. */
export function shotsFromFrames(frames: FrameDTO[]): SlotItem[] {
  const items: SlotItem[] = [];
  for (const frame of frames) {
    const shots = attrsOf(frame)["кадры"];
    if (!Array.isArray(shots)) continue;
    shots.forEach((shot, index) => {
      if (typeof shot !== "object" || shot == null) return;
      const row = shot as Record<string, unknown>;
      const code = text(row["id"]) || `K${index + 1}`;
      const plan = text(row["план"]);
      const scene = Number(row["сцена"]);
      items.push({
        id: `shot_${code}`,
        label: plan ? `${code} · ${plan}` : code,
        content: text(row["действие"]),
        placement: scenePlacement(Number.isFinite(scene) && scene > 0 ? scene : sceneOf(frame)),
      });
    });
  }
  return items;
}

/** «Сцены по плану»: текст сцены из `attrs.сцена`. */
export function scenesFromFrames(frames: FrameDTO[]): SlotItem[] {
  const items: SlotItem[] = [];
  for (const frame of frames) {
    const attrs = attrsOf(frame);
    const sceneText = text(attrs["сцена"]);
    if (!sceneText) continue;
    const scene = sceneOf(frame);
    const planIds = text(attrs["id_плана"]);
    const place = text(attrs["место"]);
    items.push({
      id: `scene_${scene}`,
      label: `Сцена ${scene}` + (planIds ? ` · ${planIds}` : ""),
      content: sceneText + (place ? `\n\nМесто: ${place}` : ""),
      placement: scenePlacement(scene),
    });
  }
  return items;
}

/** «Диалоги»: реплики сцены из `attrs.речь`. */
export function dialoguesFromFrames(frames: FrameDTO[]): SlotItem[] {
  const items: SlotItem[] = [];
  for (const frame of frames) {
    const speech = attrsOf(frame)["речь"];
    if (typeof speech !== "object" || speech == null) continue;
    const replies = (speech as Record<string, unknown>)["реплики"];
    if (!Array.isArray(replies)) continue;
    const lines: string[] = [];
    for (const reply of replies) {
      if (typeof reply !== "object" || reply == null) continue;
      const row = reply as Record<string, unknown>;
      const who = text(row["кто"]);
      const line = text(row["текст"]);
      if (line) lines.push(who ? `${who}: ${line}` : line);
    }
    if (lines.length === 0) continue;
    const scene = sceneOf(frame);
    items.push({
      id: `dialogue_${scene}`,
      label: `Диалог · сцена ${scene}`,
      content: lines.join("\n"),
      placement: scenePlacement(scene),
    });
  }
  return items;
}

/** «Каркас»: сцена из `attrs` — место, событие, план, персонажи. */
export function skeletonFromFrames(frames: FrameDTO[]): SlotItem[] {
  const items: SlotItem[] = [];
  for (const frame of frames) {
    const attrs = attrsOf(frame);
    const sceneText = text(attrs["сцена"]);
    const place = text(attrs["место"]);
    if (!sceneText && !place) continue;
    const scene = sceneOf(frame);
    const parts = [
      place ? `место: ${place}` : "",
      text(attrs["событие"]) ? `событие: ${text(attrs["событие"])}` : "",
      text(attrs["id_плана"]) ? `план: ${text(attrs["id_плана"])}` : "",
      text(attrs["персонажи"]) ? `персонажи: ${text(attrs["персонажи"])}` : "",
      text(attrs["фон"]) ? `фон: ${text(attrs["фон"])}` : "",
    ];
    items.push({
      id: `skeleton_${scene}`,
      label: `Каркас · сцена ${scene}`,
      content: parts.filter(Boolean).join("\n"),
      placement: scenePlacement(scene),
    });
  }
  return items;
}

// ── Файлы слотов ─────────────────────────────────────────────────────────

/** `qc_report.json`: вердикт и нарушения по сценам. */
export function parseQc(raw: unknown): SlotItem[] {
  const scenes = (raw as { сцены?: unknown })?.сцены;
  if (!Array.isArray(scenes)) return [];
  const items: SlotItem[] = [];
  for (const scene of scenes) {
    if (typeof scene !== "object" || scene == null) continue;
    const row = scene as Record<string, unknown>;
    const number = Number(row["номер"]);
    if (!Number.isFinite(number)) continue;
    const verdict = text(row["verdict"]) || "—";
    const violations = Array.isArray(row["violations"]) ? row["violations"] : [];
    const lines = violations.map((entry) => {
      if (typeof entry !== "object" || entry == null) return "";
      const violation = entry as Record<string, unknown>;
      const code = text(violation["code"]);
      const shot = text(violation["shot"]);
      const detail = text(violation["detail"]);
      return `${code}${shot ? ` (${shot})` : ""}: ${detail}`.replace(/^:\s*/, "");
    });
    items.push({
      id: `qc_${number}`,
      label: `QC · сцена ${number} · ${verdict}`,
      content: [`вердикт: ${verdict}`, ...lines.filter(Boolean)].join("\n"),
      placement: scenePlacement(number),
    });
  }
  return items;
}

/** `style_report.json`: кадры стиля по сценам. */
export function parseStyle(raw: unknown): SlotItem[] {
  const scenes = (raw as { сцены?: unknown })?.сцены;
  if (!Array.isArray(scenes)) return [];
  const style = text((raw as { style?: unknown })?.style);
  const items: SlotItem[] = [];
  for (const scene of scenes) {
    if (typeof scene !== "object" || scene == null) continue;
    const row = scene as Record<string, unknown>;
    const number = Number(row["номер"]);
    if (!Number.isFinite(number)) continue;
    const counts = [
      row["кадров"] != null ? `кадров ${text(row["кадров"])}` : "",
      row["мастер"] != null ? `мастер ${text(row["мастер"])}` : "",
      row["дети"] != null ? `дети ${text(row["дети"])}` : "",
      Number(row["обрезано"]) ? `обрезано ${text(row["обрезано"])}` : "",
    ].filter(Boolean);
    items.push({
      id: `style_${number}`,
      label: `Стиль · сцена ${number}`,
      content: [...counts, style ? `стиль: ${style}` : ""].filter(Boolean).join("\n"),
      placement: scenePlacement(number),
    });
  }
  return items;
}

// ── Хук ──────────────────────────────────────────────────────────────────

/**
 * Раскладка результатов по местам: node_key → единицы с `placement`.
 * Шоты/сцены/диалоги/каркас — из attrs кадров, QC/стиль — из файлов слотов.
 */
export function useMontagePlacements(
  variables: MontageVariableNode[] | undefined,
  frames: FrameDTO[],
): SlotPlacements {
  const slotNodes = useMemo(() => {
    const out = new Map<string, SlotName>();
    for (const node of variables ?? []) {
      const slot = slotOfNode(node);
      if (!slot || !(slot in SLOT_FILES)) continue;
      out.set(node.node_key, slot as SlotName);
    }
    return out;
  }, [variables]);

  const fileQueries = useQueries({
    queries: [...slotNodes.entries()].map(([nodeKey, slot]) => {
      const node = (variables ?? []).find((candidate) => candidate.node_key === nodeKey);
      const url = node ? slotFileUrl(node, SLOT_FILES[slot]) : null;
      return {
        queryKey: ["montage-slot-file", nodeKey, SLOT_FILES[slot], url],
        queryFn: async (): Promise<unknown> => {
          const response = await fetch(url as string);
          if (!response.ok) throw new Error(`slot file ${response.status}`);
          return response.json() as Promise<unknown>;
        },
        enabled: Boolean(url),
        staleTime: 60_000,
      };
    }),
  });

  return useMemo(() => {
    const byNode = new Map<string, SlotItem[]>();
    const slotByNode = new Map<string, string>();
    const fileData = new Map<string, unknown>();
    [...slotNodes.entries()].forEach(([nodeKey], index) => {
      const data = fileQueries[index]?.data;
      if (data != null) fileData.set(nodeKey, data);
    });

    for (const node of variables ?? []) {
      const slot = slotOfNode(node);
      if (!slot || !PLACED_SLOTS.has(slot)) continue;
      if (slot in SLOT_FILES) continue;
      const items =
        slot === "shots"
          ? shotsFromFrames(frames)
          : slot === "scenes"
            ? scenesFromFrames(frames)
            : slot === "dialogues"
              ? dialoguesFromFrames(frames)
              : slot === "skeleton"
                ? skeletonFromFrames(frames)
                : [];
      if (items.length === 0) continue;
      byNode.set(node.node_key, items);
      slotByNode.set(node.node_key, slot);
    }

    for (const [nodeKey, slot] of slotNodes.entries()) {
      const data = fileData.get(nodeKey);
      if (data == null) continue;
      const items = slot === "qc" ? parseQc(data) : parseStyle(data);
      if (items.length === 0) continue;
      byNode.set(nodeKey, items);
      slotByNode.set(nodeKey, slot);
    }
    return { byNode, slotByNode };
  }, [fileQueries, slotNodes, variables, frames]);
}

/** Все единицы шага → элементы результата доски (с placement). */
function toResultItems(items: SlotItem[]): NodeResultItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    kind: "text" as const,
    content: item.content,
    placement: item.placement,
  }));
}

/** Единица-файл (xlsx/pdf/json/архив): её нельзя терять при раскладке. */
function isFileItem(item: NodeResultItem): boolean {
  return (
    (item.kind === "xlsx" || item.kind === "file") &&
    Boolean(item.downloadUrl || item.previewUrl || item.filePath)
  );
}

/**
 * Добавить привязку к результатам шагов: если для ноды есть единицы с местом,
 * они заменяют плоский список, а строка доски раскладывается по кадрам/сценам.
 *
 * Единицы-файлы (xlsx-снимок слота, отчёт) при этом не теряются: у них нет
 * своего места на доске, поэтому они остаются в списке без placement — доска
 * покажет имя файла и ссылку «скачать» в строке ноды.
 */
export function applyPlacements(
  nodes: MontageResultNode[],
  placements: SlotPlacements,
): MontageResultNode[] {
  if (placements.byNode.size === 0) return nodes;
  return nodes.map((node) => {
    const items = placements.byNode.get(node.nodeKey);
    if (!items || items.length === 0) return node;
    const files = node.snapshot.items
      .filter(isFileItem)
      .map((file) => ({ ...file, placement: undefined }));
    const placed = toResultItems(items);
    return {
      ...node,
      snapshot: {
        ...node.snapshot,
        hasResult: true,
        itemCount: placed.length + files.length,
        items: [...placed, ...files],
      },
    };
  });
}

/** Сводка привязки для панели: сколько клеток и по каким кадрам/сценам. */
export interface PlacementSummary {
  layout: ResultRowLayout;
  cells: number;
  units: number;
  /** Номера сцен/кадров, в которые что-то ляжет. */
  keys: number[];
}

export function placementSummary(items: NodeResultItem[]): PlacementSummary | null {
  const placed = items.filter((item) => item.placement && item.placement.kind !== "full");
  if (placed.length === 0) return null;
  const sceneKeys = new Set<number>();
  const frameKeys = new Set<number>();
  for (const item of placed) {
    const placement = item.placement;
    if (!placement) continue;
    if (placement.kind === "scene") sceneKeys.add(placement.sceneIndex);
    if (placement.kind === "frame") placement.frameNumbers.forEach((n) => frameKeys.add(n));
  }
  if (frameKeys.size > 0 && sceneKeys.size === 0) {
    return { layout: "frame", cells: frameKeys.size, units: placed.length, keys: [...frameKeys] };
  }
  if (sceneKeys.size > 0) {
    return { layout: "scene", cells: sceneKeys.size, units: placed.length, keys: [...sceneKeys] };
  }
  return null;
}
