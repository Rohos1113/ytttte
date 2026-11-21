"use client";

import {
  memo,
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FileText,
  GripVertical,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Scissors,
  Settings2,
  Trash2,
  Unlink2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  api,
  subscribeWS,
  type MontagePendingOp,
  type SceneAnchorRow,
} from "@/lib/api";
import { errorMessageFromUnknown } from "@/lib/error-message";
import {
  montageOpSelectKey,
  montageOpsToApply,
  pendingApplyFrameNumbers,
  queueAfterApply,
  queueAfterCoverageApply,
  reconcileIdleQueue,
  serverQueueReplacesLocal,
} from "@/lib/montage-apply-queue";
import {
  readMontageAiChangeText,
  writeMontageAiChangeText,
} from "@/lib/montage-ai-change-memory";
import type {
  MontageAnchorRow,
  MontageBoardCharacterRef,
  MontageBoardDTO,
  MontageBoardFrame,
  MontageBoardShot,
  MontageImproveReport,
  ProjectDetail,
} from "@/lib/types";
import type { NodeResultItem } from "@/lib/node-result-resolver";
import type { MontageResultNode } from "@/components/canvas/montage-node-results";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NodeStepParamsPanel } from "@/components/studio/node-step-params-panel";
import { AudioAlignPopover } from "@/components/studio/audio-align-dialog";
import {
  ActionCell,
  AnchorCell,
  CoverageMenu,
  RoleCell,
  SceneActionBlock,
  SceneCell,
  SceneGenerateBlock,
  VoUnusedWarn,
  type CoverageMenuGroup,
} from "@/components/canvas/montage-scene-cells";
import { FrameRefsStrip } from "@/components/canvas/montage-frame-refs";
import { MontageVariablesPanel } from "@/components/canvas/montage-variables-panel";
import { useMontagePlacements, applyPlacements } from "@/lib/montage-placement";
import {
  MontageResultRowContent,
  ResultPlacementCell,
  RES_ROW_PREFIX,
  SPREAD_ITEM_ID,
  resultRowKey,
  resultRowLayout,
  useMontageResults,
  type ResultRowLayout,
} from "@/components/canvas/montage-node-results";
import {
  MontageRowsMenu,
  type MontageRowsMenuItem,
} from "@/components/canvas/montage-rows-menu";

/** Единая ширина колонок кадров (+30% к v215). */
const FRAME_COL_REM = 15;
/** Горизонтальный кадр 16:9 сплющен по высоте — колонке даём больше ширины. */
const FRAME_COL_REM_WIDE = 21;

/** Пропорция кадра ш/в из слага проекта («9:16», «16:9», «1:1»). */
function frameAspectRatio(aspect?: string | null): number {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*[:x/]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(
    aspect ?? "",
  );
  const w = m ? Number(m[1].replace(",", ".")) : 0;
  const h = m ? Number(m[2].replace(",", ".")) : 0;
  return w > 0 && h > 0 ? w / h : 9 / 16;
}

function frameColRem(aspect?: string | null): number {
  return frameAspectRatio(aspect) >= 1 ? FRAME_COL_REM_WIDE : FRAME_COL_REM;
}

function frameColStyle(rem: number): CSSProperties {
  const w = `${rem}rem`;
  return { width: w, minWidth: w, maxWidth: w };
}
const ROW_LABEL_CLASS = "w-[11rem] min-w-[11rem] max-w-[11rem]";
/** Шов между сценами — сюда же вставка новой VO-ячейки. */
const SCENE_GAP_REM = 5.5;
const SCENE_GAP_CLASS = "w-[5.5rem] min-w-[5.5rem] max-w-[5.5rem] p-0 align-middle";
/** Между шотами одной сцены — вплотную, только узкий + при наведении. */
const SHOT_GAP_REM = 0.25;
const SHOT_GAP_CLASS = "w-1 min-w-[4px] max-w-[4px] p-0 align-middle";

const SCENE_GENERATE_CLEAR_TYPES = new Set<MontagePendingOp["type"]>([
  "coverage_scene_action",
  "coverage_sense",
  "coverage_visual_type",
  "coverage_place",
  "coverage_characters",
  "coverage_props",
  "coverage_bg",
  "coverage_accent",
  "coverage_feature",
  "coverage_set",
  "coverage_light",
]);

/** «Улучшить сцену» переписывает покрытие всех шотов ячейки и берёт якоря с доски. */
const SCENE_IMPROVE_CLEAR_TYPES = new Set<MontagePendingOp["type"]>([
  ...SCENE_GENERATE_CLEAR_TYPES,
  "coverage_plan",
  "coverage_action",
  "coverage_angle",
  "coverage_move",
  "coverage_stitch",
  "coverage_anchors",
  "coverage_template",
  "coverage_kind",
]);

type RowKey =
  | "voiceover"
  | "scene_info"
  | "scene_master"
  | "role"
  | "action"
  | "anchor"
  | "image1"
  | "image2"
  | "video1"
  | "video2"
  | "timestamps";

const GRID_ROWS: { key: RowKey; label: string }[] = [
  { key: "voiceover", label: "Закадровый текст" },
  { key: "image1", label: "Кадры" },
  { key: "video1", label: "Видео 1" },
  { key: "timestamps", label: "Таймкоды" },
];

/**
 * Данные отдельного кадра — под блоком сцены. Крупность / ракурс / движение /
 * стык отдельными строками не показываем: они в меню покрытия под картинкой.
 */
const SCENE_SHOT_ROWS: { key: RowKey; label: string }[] = [
  { key: "voiceover", label: "Закадр кадра" },
  { key: "action", label: "Действие кадра" },
];

/** Эти строки общие для VO-ячейки — одна клетка на всю сцену. */
const SCENE_SPAN_ROWS = new Set<RowKey>(["scene_info"]);
/** Эти строки правятся у каждого кадра отдельно (роль — на картинке). */
const SCENE_FRAME_ROWS = new Set<RowKey>(["action"]);

type MediaPreview = {
  url: string;
  kind: "image" | "video";
  label: string;
};

type VideoTrim = { start: number; end: number };

type PromptModalState = {
  kind: "image" | "video";
  frameNumber: number;
  shot: 1 | 2;
  title: string;
  initialText: string;
  mode: "prompt" | "correction";
} | null;

/** Промт картинки одного шота плана (S1-K1) — правится прямо на доске. */
type ShotPromptState = {
  frameNumber: number;
  shotId: string;
  initialText: string;
} | null;

type AiChangeModalState = {
  kind: "image" | "video";
  frameNumber: number;
  shot: 1 | 2;
  initialText?: string;
} | null;

function trimKey(frameNumber: number, shot: 1 | 2): string {
  return `${frameNumber}:${shot}`;
}

/** Ключ слота: image → `N:imageS`, video → `N:S`. */
function slotKeyFromOp(
  op: Pick<MontagePendingOp, "type" | "frame_number" | "shot" | "slot">,
): string {
  const t = String(op.type || "");
  if (t === "coverage_plan") return `${op.frame_number}:plan`;
  if (t === "coverage_action") return `${op.frame_number}:action`;
  if (t === "coverage_angle") return `${op.frame_number}:angle`;
  if (t === "coverage_move") return `${op.frame_number}:move`;
  if (t === "coverage_stitch") return `${op.frame_number}:stitch`;
  if (t === "coverage_light") return `${op.frame_number}:light`;
  if (t === "coverage_set") return `${op.frame_number}:set`;
  if (t === "coverage_scene_action") return `${op.frame_number}:scene_action`;
  if (t === "coverage_sense") return `${op.frame_number}:sense`;
  if (t === "coverage_visual_type") return `${op.frame_number}:visual_type`;
  if (t === "coverage_place") return `${op.frame_number}:place`;
  if (t === "coverage_characters") return `${op.frame_number}:characters`;
  if (t === "coverage_props") return `${op.frame_number}:props`;
  if (t === "coverage_bg") return `${op.frame_number}:bg`;
  if (t === "coverage_accent") return `${op.frame_number}:accent`;
  if (t === "coverage_feature") return `${op.frame_number}:feature`;
  if (t.startsWith("coverage_")) return `${op.frame_number}:kind`;
  if (t.startsWith("image_")) {
    if (op.slot === "parent") return `${op.frame_number}:image_parent`;
    return `${op.frame_number}:image${op.shot}`;
  }
  return trimKey(op.frame_number, op.shot);
}

/** Один живой тост очереди вместо стопки на каждый клик по чипу. */
const QUEUE_TOAST_ID = "montage-queue";

function editsWord(n: number): string {
  const ones = n % 10;
  const tens = n % 100;
  if (ones === 1 && tens !== 11) return "правка";
  if (ones >= 2 && ones <= 4 && (tens < 10 || tens > 20)) return "правки";
  return "правок";
}

function framesWord(n: number): string {
  const ones = n % 10;
  const tens = n % 100;
  if (ones === 1 && tens !== 11) return "кадр";
  if (ones >= 2 && ones <= 4 && (tens < 10 || tens > 20)) return "кадра";
  return "кадров";
}

function toastQueued(text: string): void {
  toast.message(text, { id: QUEUE_TOAST_ID });
}

function opSelectKey(op: MontagePendingOp): string {
  return montageOpSelectKey(op);
}

function describePendingOp(op: MontagePendingOp): string {
  const n = op.shot === 2 ? `#${op.frame_number}.2` : `#${op.frame_number}`;
  const value =
    op.sense ||
    op.visual_type ||
    op.place ||
    op.characters ||
    op.props ||
    op.bg ||
    op.accent ||
    op.feature ||
    op.set ||
    op.light ||
    op.plan ||
    op.angle ||
    op.move ||
    op.stitch ||
    op.action ||
    op.template ||
    op.instruction ||
    op.prompt ||
    op.correction ||
    "";
  const labels: Record<string, string> = {
    coverage_scene_action: "последовательность кадров",
    coverage_sense: "смысл",
    coverage_visual_type: "тип",
    coverage_place: "место",
    coverage_characters: "персонажи",
    coverage_props: "предметы",
    coverage_bg: "фон",
    coverage_accent: "акцент",
    coverage_feature: "особенность",
    coverage_set: "набор",
    coverage_light: "свет",
    coverage_plan: "крупность",
    coverage_angle: "ракурс",
    coverage_move: "движение",
    coverage_stitch: "стык",
    coverage_action: "действие",
    coverage_template: "формат",
    coverage_anchors: "якоря",
    coverage_vo_span: "закадр сцены",
    coverage_kind: "роль",
    coverage_delete: "удаление",
    image_regen: "переген картинки",
    image_regen_prompt: "промт картинки",
    image_regen_correction: "правка картинки",
    image_ai_change: op.instruction ? "ИИзменение по тексту" : "ИИзменение картинки",
    video_regen: "переген видео",
    video_regen_prompt: "промт видео",
    video_ai_change: op.instruction ? "ИИзменение видео по тексту" : "ИИзменение видео",
  };
  const title = labels[op.type] || op.type;
  return value ? `${n} · ${title}: ${value}` : `${n} · ${title}`;
}

/** Мгновенный preview URL после regen (без ждать полный refetch доски). */
function filesUrlFromAbsPath(absPath: string): string {
  return `/api/files?path=${encodeURIComponent(absPath)}&v=${Date.now()}`;
}

function frameStillUrl(fr: MontageBoardFrame): string {
  const parent = (fr.image_parent_url || "").trim();
  const shot1 = (fr.image_shot1_url || "").trim();
  if (fr.shot_kind === "parent") return parent || shot1;
  return shot1 || parent;
}

function startStillUrl(fr: MontageBoardFrame): string {
  return (fr.image_shot1_url || "").trim();
}

type EndStillState = "yes" | "no" | "unknown";

/** Конечный still только у СТАРТ/КОНЕЦ. Пустая раскладка — не угадываем. */
function endStillState(fr: MontageBoardFrame): EndStillState {
  if (fr.has_end_still === true) return "yes";
  if (fr.has_layout === false) return "unknown";
  if (fr.has_layout === true) return "no";
  if (fr.has_end_still === false) return "no";
  return "unknown";
}

function frameNeedsEndStill(fr: MontageBoardFrame): boolean {
  return endStillState(fr) === "yes";
}

function framePairRem(fr: MontageBoardFrame, colRem: number): number {
  return endStillState(fr) === "yes" ? colRem * 2 : colRem;
}

function patchBoardFrameMedia(
  data: MontageBoardDTO,
  frameNumber: number,
  shot: 1 | 2,
  absPath: string,
  highlight: string,
): MontageBoardDTO {
  const url = filesUrlFromAbsPath(absPath);
  const isImage = highlight.includes(":image");
  const isParentStill =
    highlight.includes("image_parent") || /_parent/i.test(absPath);
  let changed = false;
  const frames = data.frames.map((fr) => {
    if (fr.number !== frameNumber) return fr;
    changed = true;
    if (isImage) {
      if (shot === 2) return { ...fr, image_shot2_url: url };
      if (isParentStill) return { ...fr, image_parent_url: url };
      return { ...fr, image_shot1_url: url };
    }
    return shot === 2
      ? { ...fr, video_shot2_url: url }
      : { ...fr, video_shot1_url: url };
  });
  return changed ? { ...data, frames } : data;
}

type SlotTone = "applied" | "pending" | "failed";

function slotToneRing(tone: SlotTone | undefined): string | false {
  if (tone === "failed") return "ring-2 ring-rose-500/80";
  if (tone === "pending") return "ring-2 ring-amber-400/70";
  if (tone === "applied") return "ring-2 ring-emerald-400/60";
  return false;
}

function voiceoverForFrame(fr: MontageBoardFrame): string {
  return (fr.voiceover_text || fr.voiceover_excel || "").trim();
}

const COVERAGE_QUEUE_TYPES = new Set([
  "coverage_plan",
  "coverage_action",
  "coverage_kind",
  "coverage_delete",
  "coverage_template",
  "coverage_anchors",
  "coverage_vo_span",
  "coverage_angle",
  "coverage_move",
  "coverage_stitch",
  "coverage_light",
  "coverage_set",
  "coverage_scene_action",
  "coverage_sense",
  "coverage_visual_type",
  "coverage_place",
  "coverage_characters",
  "coverage_props",
  "coverage_bg",
  "coverage_accent",
  "coverage_feature",
]);

type PendingCoverage = {
  plan?: string;
  action?: string;
  kind?: "parent" | "child";
  parent_number?: number;
  deleted?: boolean;
  template?: string;
  anchors?: SceneAnchorRow[];
  angle?: string;
  move?: string;
  stitch?: string;
  light?: string;
  set?: string;
  sense?: string;
  visual_type?: string;
  place?: string;
  characters?: string;
  props?: string;
  bg?: string;
  accent?: string;
  feature?: string;
  scene_action?: string;
};

function pendingCoverageForFrame(
  ops: MontagePendingOp[],
  frameNumber: number,
): PendingCoverage {
  const out: PendingCoverage = {};
  for (const op of ops) {
    if (op.frame_number !== frameNumber) continue;
    if (op.type === "coverage_plan" && op.plan) out.plan = op.plan;
    if (op.type === "coverage_action" && op.action) out.action = op.action;
    if (op.type === "coverage_angle" && op.angle) out.angle = op.angle;
    if (op.type === "coverage_move" && op.move) out.move = op.move;
    if (op.type === "coverage_stitch" && op.stitch) out.stitch = op.stitch;
    if (op.type === "coverage_light" && op.light) out.light = op.light;
    if (op.type === "coverage_set" && op.set) out.set = op.set;
    if (op.type === "coverage_sense" && op.sense) out.sense = op.sense;
    if (op.type === "coverage_visual_type" && op.visual_type) out.visual_type = op.visual_type;
    if (op.type === "coverage_place" && op.place) out.place = op.place;
    if (op.type === "coverage_characters" && op.characters) out.characters = op.characters;
    if (op.type === "coverage_props" && op.props) out.props = op.props;
    if (op.type === "coverage_bg" && op.bg) out.bg = op.bg;
    if (op.type === "coverage_accent" && op.accent) out.accent = op.accent;
    if (op.type === "coverage_feature" && op.feature) out.feature = op.feature;
    if (op.type === "coverage_scene_action" && op.action) out.scene_action = op.action;
    if (op.type === "coverage_template" && op.template) out.template = op.template;
    if (op.type === "coverage_anchors" && op.anchors) out.anchors = op.anchors;
    if (op.type === "coverage_kind") {
      out.kind = op.kind;
      out.parent_number = op.parent_number;
    }
    if (op.type === "coverage_delete") out.deleted = true;
  }
  return out;
}

function coverageCorrection(
  pending: PendingCoverage,
  fr: MontageBoardFrame | undefined,
): string {
  const plan = (pending.plan || fr?.shot_plan || "").trim();
  const angle = (pending.angle || fr?.shot_angle || "").trim();
  const move = (pending.move || fr?.shot_move || "").trim();
  const action = (pending.action || fr?.shot_action || "").trim();
  const characters = (fr?.characters || "").trim();
  return [
    `План: ${plan || "как в кадре"}`,
    angle ? `Ракурс: ${angle}` : "",
    move ? `Движение: ${move}` : "",
    characters ? `Персонажи: ${characters}` : "",
    `Действие: ${action || "как в кадре"}`,
  ]
    .filter(Boolean)
    .join(". ");
}

/** Сначала still сцены, затем кадры: старт и при freeze — конец. leftover пропускаем. */
function sceneImageOpsForFrames(
  frames: MontageBoardFrame[],
  scenePrompt?: string,
): MontagePendingOp[] {
  const live = frames.filter((fr) => !fr.shot_leftover);
  if (!live.length) return [];
  const byNumber = new Map(frames.map((fr) => [fr.number, fr]));
  const parentNums = new Set<number>();
  for (const fr of live) {
    if (fr.shot_kind === "parent") parentNums.add(fr.number);
    const p = fr.shot_parent_number;
    if (typeof p === "number" && p >= 1 && p !== fr.number) parentNums.add(p);
  }
  const ops: MontagePendingOp[] = [];
  const instructionOf = (fr: MontageBoardFrame, master: boolean) => {
    const pending: PendingCoverage = {
      plan: fr.shot_plan,
      action: fr.shot_action,
      angle: fr.shot_angle,
      move: fr.shot_move,
      characters: (fr.characters || "").trim(),
    };
    return coverageCorrection(pending, fr);
  };
  const sceneInstr = (scenePrompt || "").trim();
  for (const n of [...parentNums].sort((a, b) => a - b)) {
    const fr = byNumber.get(n);
    if (!fr) continue;
    ops.push({
      type: "image_ai_change",
      frame_number: n,
      shot: 1,
      slot: "parent",
      instruction: sceneInstr || instructionOf(fr, true),
    });
  }
  for (const fr of live) {
    ops.push({
      type: "image_ai_change",
      frame_number: fr.number,
      shot: 1,
      instruction: instructionOf(fr, false),
    });
    if (frameNeedsEndStill(fr)) {
      ops.push({
        type: "image_ai_change",
        frame_number: fr.number,
        shot: 2,
        instruction: `${instructionOf(fr, false)} Конечный кадр сцены.`,
      });
    }
  }
  return ops;
}

function formatTs(sec: number | null | undefined): string {
  if (sec == null || Number.isNaN(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function PromptModal({
  state,
  onClose,
  onSubmit,
  busy,
}: {
  state: PromptModalState;
  onClose: () => void;
  onSubmit: (text: string) => void;
  busy: boolean;
}) {
  if (!state) return null;
  // key — remount с исходным промптом сразу в textarea (не пустой useState + useEffect).
  return (
    <PromptModalBody
      key={`${state.kind}:${state.frameNumber}:${state.shot}:${state.mode}`}
      state={state}
      onClose={onClose}
      onSubmit={onSubmit}
      busy={busy}
    />
  );
}

function PromptModalBody({
  state,
  onClose,
  onSubmit,
  busy,
}: {
  state: NonNullable<PromptModalState>;
  onClose: () => void;
  onSubmit: (text: string) => void;
  busy: boolean;
}) {
  const [text, setText] = useState(state.initialText);

  return createPortal(
    <div
      className="fixed inset-0 z-[10110] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/15 bg-card p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">{state.title}</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Исходный промт кадра — отредактируйте и поставьте в очередь.
        </p>
        <textarea
          className="mt-3 min-h-[160px] w-full rounded-lg border border-white/15 bg-black/30 p-3 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Промт исходника не найден — вставьте текст вручную…"
          autoFocus
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => onSubmit(text.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "В очередь"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function lastAiInstruction(
  ops: MontagePendingOp[],
  kind: "image" | "video",
  frameNumber: number,
  shot: 1 | 2,
): string {
  const want = kind === "image" ? "image_ai_change" : "video_ai_change";
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const op = ops[i];
    if (
      op.type === want &&
      op.frame_number === frameNumber &&
      (op.shot ?? 1) === shot
    ) {
      return String(op.instruction || op.correction || "").trim();
    }
  }
  return "";
}

function AiChangeModal({
  state,
  onClose,
  onAutomatic,
  onWithText,
}: {
  state: AiChangeModalState;
  onClose: () => void;
  onAutomatic: (text: string) => void;
  onWithText: (text: string) => void;
}) {
  const [text, setText] = useState(state?.initialText ?? "");
  useEffect(() => {
    setText(state?.initialText ?? "");
  }, [state?.kind, state?.frameNumber, state?.shot, state?.initialText]);
  if (!state) return null;
  const kindLabel = state.kind === "image" ? "изображение" : "видео";
  return createPortal(
    <div
      className="fixed inset-0 z-[10110] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/15 bg-card p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">
          ИИзменение · кадр #{state.frameNumber} · {kindLabel} {state.shot}
        </h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Автоматически — агент картинок пишет промт по карточке и закадру, как
          сейчас. Если в окне есть текст — агент обрабатывает его и из этого
          получается промт генерации.
        </p>
        <textarea
          className="mt-3 min-h-[140px] w-full rounded-lg border border-white/15 bg-black/30 p-3 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Пусто = автоматически. Или напишите, что изменить: крупнее руки, холодный свет…"
          autoFocus
        />
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Отмена
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onAutomatic(text.trim())}
          >
            Автоматически
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!text.trim()}
            onClick={() => onWithText(text.trim())}
          >
            По тексту
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function effectiveShotKind(
  fr: MontageBoardFrame,
  pending: PendingCoverage,
  override?: "parent" | "child",
): "parent" | "child" | "" {
  if (override) return override;
  if (pending.kind) return pending.kind;
  if (fr.shot_kind === "child" || fr.shot_kind === "parent") return fr.shot_kind;
  return "";
}

function frameForRefs(
  fr: MontageBoardFrame,
  pending: PendingCoverage,
  override?: "parent" | "child",
): MontageBoardFrame {
  const kind = effectiveShotKind(fr, pending, override);
  if (kind === "parent") {
    return {
      ...fr,
      shot_kind: "parent",
      shot_parent_number: null,
      ref_parent: null,
    };
  }
  if (kind === "child") {
    return {
      ...fr,
      shot_kind: "child",
      shot_parent_number: pending.parent_number ?? fr.shot_parent_number ?? null,
    };
  }
  return fr;
}

function parentFrameOf(
  frames: MontageBoardFrame[],
  fr: MontageBoardFrame,
): MontageBoardFrame | null {
  const n =
    typeof fr.shot_parent_number === "number" &&
    fr.shot_parent_number > 0 &&
    fr.shot_parent_number !== fr.number
      ? fr.shot_parent_number
      : fr.ref_parent?.number ||
        (typeof fr.vo_scene_number === "number" &&
        fr.vo_scene_number > 0 &&
        fr.vo_scene_number !== fr.number
          ? fr.vo_scene_number
          : null);
  if (!n) return null;
  return frames.find((f) => f.number === n) ?? null;
}

function voSceneNumber(fr: MontageBoardFrame): number {
  const n = fr.vo_scene_number;
  if (typeof n === "number" && n > 0) return n;
  const parent = fr.shot_parent_number;
  if (typeof parent === "number" && parent > 0) return parent;
  return fr.number;
}

function isChildOfScene(fr: MontageBoardFrame, sceneKey: number): boolean {
  return voSceneNumber(fr) === sceneKey && fr.number !== sceneKey;
}

type SceneRange = {
  /** Уникальный ключ блока = номер первого кадра на пайплайне, не VO-сцена. */
  key: number;
  scene: number;
  start: number;
  end: number;
  frames: MontageBoardFrame[];
};

function visibleSceneFrames(frames: MontageBoardFrame[]): MontageBoardFrame[] {
  // leftover-клей прячем. Длина scene_chain — не число шотов: у ячейки
  // часто 1 N. и 3–8 живых дочерних кадров.
  return frames.filter((fr) => !fr.shot_leftover);
}

function sceneRanges(frames: MontageBoardFrame[]): SceneRange[] {
  const out: SceneRange[] = [];
  frames.forEach((fr, i) => {
    if (fr.shot_leftover) return;
    const scene = voSceneNumber(fr);
    const last = out[out.length - 1];
    if (last && (last.scene === scene || isChildOfScene(fr, last.scene))) {
      last.end = i;
      last.frames.push(fr);
    } else {
      out.push({ key: fr.number, scene, start: i, end: i, frames: [fr] });
    }
  });
  return out.map((range) => {
    const vis = visibleSceneFrames(range.frames);
    return { ...range, frames: vis };
  }).filter((range) => range.frames.length > 0);
}

/** Действия кадров ячейки через « → » — вместо одного главного действия. */
function sceneShotSequence(
  range: SceneRange,
  pendingOps: MontagePendingOp[],
  pendingScene: PendingCoverage,
): string {
  const queued = (pendingScene.scene_action || "").trim();
  if (queued) return queued;
  const fromCell = (range.frames[0]?.scene_action || "").trim();
  if (fromCell) return fromCell;
  const steps = range.frames
    .map((fr) => {
      const pending = pendingCoverageForFrame(pendingOps, fr.number);
      return ((pending.action ?? fr.shot_action) || "").trim();
    })
    .filter(Boolean);
  if (steps.length) return steps.join(" → ");
  return "";
}

function pendingAnchorsForRange(
  ops: MontagePendingOp[],
  range: SceneRange,
): SceneAnchorRow[] | undefined {
  for (const fr of range.frames) {
    const pending = pendingCoverageForFrame(ops, fr.number);
    if (pending.anchors) return pending.anchors;
  }
  return undefined;
}

function sceneColSpan(frameCount: number): number {
  return Math.max(1, frameCount * 2 - 1);
}

/**
 * Колонка доски = запланированный шот кадра (`attrs["кадры"]`).
 * Доска без шотов живёт по-старому: одна колонка на кадр (старт+конец внутри).
 */
type ShotUnit = {
  key: string;
  frame: MontageBoardFrame;
  shot: MontageBoardShot | null;
  /** Таймлайн шота внутри сцены: секунды от её начала (по «длительность»). */
  timelineStart?: number;
  timelineEnd?: number;
};

function shotUnitsForFrame(frame: MontageBoardFrame): ShotUnit[] {
  const shots = frame.planned_shots ?? [];
  if (shots.length === 0) {
    return [{ key: `${frame.frame_id}-frame`, frame, shot: null }];
  }
  return [...shots]
    .sort((a, b) => (Number(a.порядок ?? 0) || 0) - (Number(b.порядок ?? 0) || 0))
    .map((shot, index) => ({
      key: `${frame.frame_id}-${shot.id || index}`,
      frame,
      shot,
    }));
}

function rangeShotUnits(range: SceneRange): ShotUnit[] {
  const units = range.frames.flatMap(shotUnitsForFrame);
  let cursor = 0;
  for (const unit of units) {
    const duration = Number(unit.shot?.длительность ?? 0);
    if (Number.isFinite(duration) && duration > 0) {
      unit.timelineStart = Math.round(cursor * 100) / 100;
      cursor += duration;
      unit.timelineEnd = Math.round(cursor * 100) / 100;
    }
  }
  return units;
}

/**
 * Место единицы результата на доске глазами доски. `shot` доска понимает
 * сама (панель пишет только `res:<node>:shown`), остальное — кадр/сцена/общая.
 */
type BoardPlaced = {
  kind?: string;
  shotId?: string;
  frameNumber?: number;
  frameNumbers?: number[];
  sceneIndex?: number;
};

function boardPlacement(item: { placement?: unknown } | null | undefined): BoardPlaced | null {
  const raw = item?.placement;
  if (!raw || typeof raw !== "object") return null;
  return raw as BoardPlaced;
}

function ShotColGroup({
  ranges,
  colRem,
}: {
  ranges: SceneRange[];
  colRem: number;
}) {
  return (
    <colgroup>
      <col style={{ width: 11 * 16 }} />
      {ranges.flatMap((range) =>
        rangeShotUnits(range).map((unit) => (
          // В режиме шотов колонка = один шот: ширина ровно colRem,
          // иначе кадры с двумя слотами получали двойную колонку и теряли
          // половину картинки.
          <col key={`col-${unit.key}`} style={{ width: colRem * 16 }} />
        )),
      )}
    </colgroup>
  );
}

function sceneBlockWidthPx(frames: MontageBoardFrame[], colRem: number): number {
  const cols = frames.reduce((sum, fr) => sum + framePairRem(fr, colRem), 0);
  return cols * 16 + Math.max(0, frames.length - 1) * SHOT_GAP_REM * 16;
}

const ROW_HEIGHT_MIN = 40;
const ROW_HEIGHT_MAX = 600;
const ROW_HEIGHT_DEFAULT = 128;

function clampRowHeight(value: number): number {
  return Math.round(Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, value)));
}

/**
 * Миниатюры рефов (персонажи/предметы) в колонке своего кадра — размером как
 * картинка в строке «Кадры»: на ширину колонки, object-cover, подпись код/имя.
 * Несколько персон в кадре идут стопкой, каждая на всю ширину — читаемо.
 */
function FrameRefThumbs({
  refs,
  tall = false,
  tallAspect = null,
  compact = false,
}: {
  refs: MontageBoardCharacterRef[];
  tall?: boolean;
  tallAspect?: string | null;
  /** Размер как у still'а шота: картинка на ширину колонки, не выше 96px. */
  compact?: boolean;
}) {
  if (refs.length === 0) {
    return <span className="block text-[10px] text-muted-foreground/30">—</span>;
  }
  const mediaBox = tall ? tallMediaStyle(tallAspect) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {refs.map((ref) => (
        <figure
          key={`${ref.id}-${ref.image_url ?? ""}`}
          className="w-full min-w-0"
          title={ref.name || ref.code || ref.id}
        >
          {ref.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ref.image_url}
              alt={ref.name || ref.id}
              loading="lazy"
              decoding="async"
              style={mediaBox}
              className={cn(
                "block w-full rounded-lg border border-white/10 bg-black object-cover",
                tall ? null : compact ? "h-24" : "h-32",
              )}
            />
          ) : (
            <div
              style={mediaBox}
              className={cn(
                "w-full rounded-lg border border-dashed border-white/15 bg-black/30",
                tall ? null : compact ? "h-24" : "h-32",
              )}
            />
          )}
          <figcaption className="mt-0.5 truncate text-center font-mono text-[10px] text-muted-foreground/70">
            {ref.code || ref.name}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/**
 * Фон сцены: одна ячейка на сцену (колонки всех её кадров), картинка на ширину
 * сцены — тот же размер, что у «Кадров», не мельче.
 */
function SceneBackgroundCell({
  frames,
  tall = false,
  tallAspect = null,
}: {
  frames: MontageBoardFrame[];
  tall?: boolean;
  tallAspect?: string | null;
}) {
  const bg = frames.find((fr) => fr.background_ref)?.background_ref ?? null;
  if (!bg) {
    return <span className="block text-[10px] text-muted-foreground/30">—</span>;
  }
  const mediaBox = tall ? tallMediaStyle(tallAspect) : undefined;
  return (
    <figure className="w-full min-w-0" title={`${bg.name} · кадров в сцене: ${frames.length}`}>
      {bg.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={bg.image_url}
          alt={bg.name}
          loading="lazy"
          decoding="async"
          style={mediaBox}
          className={cn(
            "block w-full rounded-lg border border-white/10 bg-black object-cover",
            tall ? null : "h-32",
          )}
        />
      ) : (
        <div
          style={mediaBox}
          className={cn(
            "w-full rounded-lg border border-dashed border-white/15 bg-black/30",
            tall ? null : "h-32",
          )}
        />
      )}
      <figcaption className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
        <span className="truncate font-mono">{bg.name}</span>
        <span className="shrink-0 text-muted-foreground/50">{frames.length} кадр(ов)</span>
      </figcaption>
    </figure>
  );
}

/** Ручка перетаскивания строки в липкой первой колонке (pointer-drag). */
function RowGrip({
  rowKey,
  active,
  onStart,
}: {
  rowKey: string;
  active: boolean;
  onStart: (rowKey: string, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label="Перетащить строку"
      title="Потяни, чтобы поднять/опустить строку"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onStart(rowKey, event);
      }}
      className={cn(
        "mt-0.5 shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground/50 transition hover:bg-white/10 hover:text-foreground active:cursor-grabbing",
        active && "bg-[rgba(209,254,23,0.14)] text-[rgba(209,254,23,0.95)]",
      )}
    >
      <GripVertical className="h-3.5 w-3.5" />
    </span>
  );
}

/** Нижняя ручка высоты строки; двойной клик — сброс к авто. */
function RowResizer({
  hasHeight,
  onMouseDown,
  onReset,
}: {
  hasHeight: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onReset: () => void;
}) {
  return (
    <span
      role="separator"
      aria-label="Высота строки"
      title="Потяни вниз/вверх: высота строки · двойной клик — сброс"
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 h-2 cursor-row-resize transition",
        hasHeight
          ? "bg-[rgba(209,254,23,0.28)] hover:bg-[rgba(209,254,23,0.5)]"
          : "bg-transparent hover:bg-[rgba(209,254,23,0.35)]",
      )}
    />
  );
}

function MontageColGroup({
  ranges,
  colRem,
}: {
  ranges: SceneRange[];
  colRem: number;
}) {
  const label = 11 * 16;
  const scene = SCENE_GAP_REM * 16;
  const shot = SHOT_GAP_REM * 16;
  return (
    <colgroup>
      <col style={{ width: label }} />
      {ranges.map((range) => (
        <Fragment key={`col-${range.key}`}>
          <col style={{ width: scene }} />
          {range.frames.map((fr, fi) => (
            <Fragment key={`colf-${fr.frame_id}`}>
              <col style={{ width: framePairRem(fr, colRem) * 16 }} />
              {fi < range.frames.length - 1 ? (
                <col style={{ width: shot }} />
              ) : null}
            </Fragment>
          ))}
        </Fragment>
      ))}
      <col style={{ width: scene }} />
    </colgroup>
  );
}

/**
 * Вставка кадра в зазоре между колонками. Плюс не мозолит глаза: появляется
 * только под курсором и только в одной строке сверху.
 */
function InsertGutter({
  as,
  label,
  onClick,
  mergeLabel,
  onMerge,
  mergeDisabled,
  gap = "scene",
}: {
  as: "th" | "td";
  label: string;
  onClick: () => void;
  mergeLabel?: string;
  onMerge?: () => void;
  mergeDisabled?: boolean;
  gap?: "scene" | "shot";
}) {
  const scene = gap === "scene";
  const plusBtn = (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        "group/add flex items-center justify-center transition",
        scene
          ? "h-7 w-full text-white/30 hover:text-black"
          // Зазор между шотами всего 4px — кнопка вылезает за колонку, чтобы в
          // неё можно было попасть мышью, но саму таблицу не расширяет.
          : "absolute inset-y-0 left-1/2 z-20 w-6 -translate-x-1/2 text-white/20 hover:text-black",
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-full border border-dashed border-transparent opacity-0 transition",
          scene ? "h-6 w-6" : "h-5 w-5",
          "group-hover/add:border-transparent group-hover/add:bg-[rgba(209,254,23,1)] group-hover/add:opacity-100",
        )}
      >
        <Plus className="h-3 w-3" />
      </span>
    </button>
  );
  const inner = scene ? (
    <div className="flex h-full min-h-[3.25rem] w-full flex-col items-center justify-center gap-0.5 self-stretch border-l border-white/20 bg-white/[0.03]">
      {plusBtn}
      {onMerge ? (
        <button
          type="button"
          title={mergeLabel || "Объединить ячейки в одну сцену"}
          disabled={mergeDisabled}
          onClick={onMerge}
          className="flex h-6 w-6 items-center justify-center rounded-md text-white/45 transition hover:bg-[rgba(209,254,23,0.2)] hover:text-[rgba(209,254,23,1)] disabled:opacity-40"
        >
          <Link2 className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  ) : (
    plusBtn
  );
  const cls = scene ? SCENE_GAP_CLASS : SHOT_GAP_CLASS;
  if (as === "th") {
    return (
      <th className={cn(cls, "relative border-b border-white/10")}>{inner}</th>
    );
  }
  return <td className={cn(cls, scene ? null : "relative")}>{inner}</td>;
}

/**
 * Тот же зазор между кадрами, но без кнопки: плюсик живёт только в одной
 * строке сверху, а колонки-разделители нужны всем строкам, иначе fixed-таблица
 * разъедется.
 */
function GapCell({
  as,
  gap = "scene",
}: {
  as: "th" | "td";
  gap?: "scene" | "shot";
}) {
  const cls = gap === "scene" ? SCENE_GAP_CLASS : SHOT_GAP_CLASS;
  if (as === "th") {
    return <th className={cn(cls, "border-b border-white/10")} />;
  }
  return <td className={cls} />;
}

function VoiceoverCell({
  frame,
  busy,
  onSave,
  onDelete,
  unusedBefore,
  unusedAfter,
  unusedBetween,
}: {
  frame: MontageBoardFrame;
  busy: boolean;
  onSave: (text: string) => Promise<void>;
  onDelete: () => void;
  unusedBefore?: string;
  unusedAfter?: string;
  unusedBetween?: string[];
}) {
  const source = voiceoverForFrame(frame);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(source);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(source);
  }, [source, frame.frame_id]);

  const save = async () => {
    const next = text.trim();
    if (next === source) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-end">
          <VoUnusedWarn
            before={unusedBefore}
            after={unusedAfter}
            between={unusedBetween}
          />
        </div>
        <textarea
          className="min-h-[88px] w-full rounded-md border border-white/15 bg-black/40 p-2 text-xs leading-snug"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoFocus
          disabled={saving || busy}
        />
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={saving}
            onClick={() => {
              setText(source);
              setEditing(false);
            }}
          >
            Отмена
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={saving || busy}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Сохранить"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/vo flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex justify-end">
          <VoUnusedWarn
            before={unusedBefore}
            after={unusedAfter}
            between={unusedBetween}
          />
        </div>
      <button
        type="button"
        className="min-w-0 w-full whitespace-pre-wrap text-left text-xs leading-snug text-foreground/90 hover:text-white"
        title="Клик — править закадр"
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        {source || <span className="text-muted-foreground">— добавить закадр</span>}
      </button>
      </div>
      <button
        type="button"
        className={cn(
          "shrink-0 rounded-md p-1 opacity-0 group-hover/vo:opacity-100",
          frame.удалён
            ? "text-amber-200 hover:bg-amber-500/15"
            : "text-white/30 hover:bg-rose-500/15 hover:text-rose-200",
        )}
        title={frame.удалён ? "Вернуть кадр в ленту" : "Удалить кадр"}
        disabled={busy}
        onClick={onDelete}
      >
        {frame.удалён ? (
          <span className="px-0.5 text-[10px] font-semibold">вернуть</span>
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function AddFrameModal({
  afterLabel,
  busy,
  onClose,
  onSubmit,
}: {
  afterLabel: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (voiceover: string) => void;
}) {
  const [text, setText] = useState("");
  return createPortal(
    <div
      className="fixed inset-0 z-[10110] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-white/15 bg-card p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">Новая сцена {afterLabel}</h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Это новая ячейка закадра, не шот внутри текущей сцены. Шот внутри
          сцены — плюс справа от номера кадра.
        </p>
        <textarea
          className="mt-3 min-h-[88px] w-full rounded-lg border border-white/15 bg-black/30 p-3 text-sm"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Закадр новой ячейки (можно пусто)"
          autoFocus
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => onSubmit(text.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Добавить"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Своё состояние open — клик не перерисовывает всю таблицу кадров. */
function MontageExtrasPopover({
  projectId,
}: {
  projectId: number | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-9 gap-1.5 text-xs">
          <Settings2 className="h-4 w-4" />
          Доп. функции
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="z-[10060] max-h-[min(80vh,640px)] w-[min(96vw,420px)] overflow-y-auto p-3"
      >
        {open ? (
          <>
            <h3 className="mb-3 text-sm font-semibold">Настройки сборки</h3>
            {projectId != null ? (
              <>
                <MontageMediaExtras
                  onVoiceUpload={async (file) => {
                    try {
                      await api.uploadMontageVoice(projectId, file);
                      toast.success("Озвучка загружена → audio/voice_full.*");
                    } catch (e) {
                      toast.error(errorMessageFromUnknown(e));
                    }
                  }}
                  onMusicUpload={async (file) => {
                    try {
                      await api.uploadMontageMusic(projectId, file);
                      toast.success("Музыка загружена → music/bgm.*");
                    } catch (e) {
                      toast.error(errorMessageFromUnknown(e));
                    }
                  }}
                />
                <NodeStepParamsPanel projectId={projectId} nodeType="assemble" />
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Проект не выбран</p>
            )}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function MontageMediaExtras({
  onVoiceUpload,
  onMusicUpload,
}: {
  onVoiceUpload: (file: File) => void;
  onMusicUpload: (file: File) => void;
}) {
  const voiceRef = useRef<HTMLInputElement>(null);
  const musicRef = useRef<HTMLInputElement>(null);

  return (
    <div className="mb-4 space-y-2 rounded-lg border border-white/10 bg-black/20 p-3">
      <p className="text-xs font-medium text-foreground">Замена озвучки и музыки</p>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Сохраняются как <code className="text-[10px]">audio/voice_full.*</code> и{" "}
        <code className="text-[10px]">music/bgm.*</code> (имена для монтажа).
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => voiceRef.current?.click()}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Голос с компьютера
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() => musicRef.current?.click()}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Музыка с компьютера
        </Button>
      </div>
      <input
        ref={voiceRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onVoiceUpload(f);
          e.target.value = "";
        }}
      />
      <input
        ref={musicRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onMusicUpload(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function MediaLightbox({
  preview,
  onClose,
}: {
  preview: MediaPreview | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, onClose]);

  if (!preview) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/90 p-4"
      onMouseDown={onClose}
    >
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
        onClick={onClose}
        aria-label="Закрыть просмотр"
      >
        <X className="h-5 w-5" />
      </button>
      <div className="max-h-[92vh] max-w-[96vw]" onMouseDown={(e) => e.stopPropagation()}>
        {preview.kind === "video" ? (
          <video
            src={preview.url}
            className="max-h-[92vh] max-w-[96vw] rounded-lg"
            controls
            autoPlay
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview.url}
            alt={preview.label}
            className="max-h-[92vh] max-w-[96vw] rounded-lg object-contain"
          />
        )}
        <p className="mt-2 text-center text-sm text-white/80">{preview.label}</p>
      </div>
    </div>,
    document.body,
  );
}

type SwapSlotPick = {
  kind: "image" | "video";
  frameNumber: number;
  shot: 1 | 2;
};

const MediaActionBar = memo(function MediaActionBar({
  kind,
  actions: actionsOverride,
  onRegen,
  onEditPrompt,
  onAiChange,
  onRegenWithCorrection,
  onDelete,
  onUpload,
  onSwapPick,
  swapSelected,
  swapBusy,
}: {
  kind: "image" | "video";
  /** Свой набор пунктов меню «Действия» (например, ручки шота). */
  actions?: { label: string; action: () => void }[];
  onRegen: () => void;
  onEditPrompt: () => void;
  onAiChange: () => void;
  onRegenWithCorrection?: () => void;
  onDelete: () => void;
  onUpload: (file: File) => void;
  /** Кнопка обмена: первый клик — выбор, второй — swap с другим слотом. */
  onSwapPick?: () => void;
  swapSelected?: boolean;
  swapBusy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const imageActions = [
    { label: "Перегенерация без редакции", action: onRegen },
    { label: "Редактировать промт", action: onEditPrompt },
    { label: "ИИзменение", action: onAiChange },
    ...(onRegenWithCorrection
      ? [{ label: "Перегенерация существующего изображения", action: onRegenWithCorrection }]
      : []),
  ];
  const videoActions = [
    { label: "Перегенерация без редакции", action: onRegen },
    { label: "Редактировать промт", action: onEditPrompt },
    { label: "ИИзменение", action: onAiChange },
  ];
  const actions =
    actionsOverride ??
    (kind === "image" ? imageActions : videoActions);

  return (
    <div className="mt-2 flex items-center gap-1">
      {onSwapPick && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={swapBusy}
          className={cn(
            "h-7 w-7 shrink-0",
            swapSelected
              ? "border-amber-400/70 bg-amber-500/25 text-amber-100"
              : "text-muted-foreground hover:border-amber-400/50 hover:text-amber-200",
          )}
          title={
            swapSelected
              ? "Выбрано — нажмите ↔ на другом слоте того же типа"
              : "Обмен: нажмите ↔ на двух слотах (картинка↔картинка или видео↔видео)"
          }
          onClick={onSwapPick}
        >
          {swapBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowLeftRight className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7 flex-1 px-2 text-[10px]">
            <MoreHorizontal className="mr-1 h-3.5 w-3.5" />
            Действия
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-[10060] min-w-[14rem]">
          {actions.map((item) => (
            <DropdownMenuItem key={item.label} onSelect={item.action}>
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-7 w-7 shrink-0 text-destructive/80"
        title="Удалить"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-7 w-7 shrink-0"
        title="Загрузить с компьютера"
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-3.5 w-3.5" />
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={kind === "image" ? "image/*" : "video/*"}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />
    </div>
  );
});

/**
 * Действия картинки шота на доске (режим «колонка = шот»).
 *
 * В режиме шотов ячейка «Кадры» — это `images/<S1-K1>.png`, а не кадр целиком,
 * поэтому полоса действий кадра сюда не подходила: у шота свои ручки
 * (`shot-image-regen` / `shot-prompt` / `shot-image-upload` / `shot-image-delete`).
 */
function ShotMediaBar({
  busy,
  disabled,
  onRegen,
  onEditPrompt,
  onUpload,
  onDelete,
}: {
  busy: boolean;
  disabled?: boolean;
  onRegen: () => void;
  onEditPrompt: () => void;
  onUpload: (file: File) => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const off = busy || disabled;
  // Та же полоса, что в кадровой сетке: меню «Действия», корзина, загрузка.
  // У шота просто другой набор пунктов и ручек — вид не меняется.
  return (
    <div className={cn(off && "opacity-60")}>
      <MediaActionBar
        kind="image"
        actions={[
          { label: "Перегенерация без редакции", action: onRegen },
          { label: "Редактировать промт", action: onEditPrompt },
        ]}
        onRegen={onRegen}
        onEditPrompt={onEditPrompt}
        onAiChange={onEditPrompt}
        onDelete={onDelete}
        onUpload={onUpload}
      />
    </div>
  );
}

/** Промт картинки шота: правка сохраняется в план сразу, без очереди кадра. */
function ShotPromptModal({
  state,
  busy,
  onClose,
  onSubmit,
}: {
  state: ShotPromptState;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  if (!state) return null;
  return (
    <ShotPromptModalBody
      key={`${state.frameNumber}:${state.shotId}`}
      state={state}
      busy={busy}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  );
}

function ShotPromptModalBody({
  state,
  busy,
  onClose,
  onSubmit,
}: {
  state: NonNullable<ShotPromptState>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState(state.initialText);
  return createPortal(
    <div
      className="fixed inset-0 z-[10110] flex items-center justify-center bg-black/70 p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-white/15 bg-card p-4 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">
          Промт картинки · шот {state.shotId} · кадр #{state.frameNumber}
        </h3>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Сохраняется в план шотов сразу. Картинку перерисует кнопка
          «Перерисовать» — отдельного шага в очереди кадра для шота нет.
        </p>
        <textarea
          className="mt-3 min-h-[220px] w-full rounded-lg border border-white/15 bg-black/30 p-3 text-xs leading-snug"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Промт картинки шота не найден — вставьте текст вручную…"
          autoFocus
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || !text.trim()}
            onClick={() => onSubmit(text.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Сохранить"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const MONTAGE_IMAGE_DRAG = "application/x-vp-montage-image";

type ImageSlotRef = { frameNumber: number; shot: 1 | 2; slot?: "parent" };

/** Chrome часто не отдаёт custom mime в dragOver.types — держим активный drag здесь. */
let activeImageDrag: ImageSlotRef | null = null;

function parseImageDrag(e: ReactDragEvent): ImageSlotRef | null {
  if (activeImageDrag) return activeImageDrag;
  try {
    const raw =
      e.dataTransfer.getData(MONTAGE_IMAGE_DRAG) ||
      e.dataTransfer.getData("text/plain");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImageSlotRef;
    if (
      typeof parsed.frameNumber === "number" &&
      (parsed.shot === 1 || parsed.shot === 2)
    ) {
      return {
        frameNumber: parsed.frameNumber,
        shot: parsed.shot,
        slot: parsed.slot === "parent" ? "parent" : undefined,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Бокс большого кадра под формат проекта: вертикаль 9:16 упирается в три
 * строки, горизонт 16:9 берёт высоту по пропорции — без пустых полей.
 */
function tallMediaStyle(aspect?: string | null): CSSProperties {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*[:x/]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(
    aspect ?? "",
  );
  const w = m ? Number(m[1].replace(",", ".")) : 0;
  const h = m ? Number(m[2].replace(",", ".")) : 0;
  const ratio = w > 0 && h > 0 ? w / h : 9 / 16;
  return { aspectRatio: String(ratio), maxHeight: "19rem", minHeight: "6rem" };
}

const ClickableMedia = memo(function ClickableMedia({
  url,
  kind,
  label,
  onPreview,
  onRegen,
  onEditPrompt,
  onAiChange,
  onRegenWithCorrection,
  onDelete,
  onUpload,
  slotTone,
  stale,
  scrollRootRef,
  imageSlot,
  onImageDrop,
  onSwapPick,
  swapSelected,
  swapBusy,
  tall,
  tallAspect,
  caption,
  overlay,
}: {
  url: string | null;
  kind: "image" | "video";
  label: string;
  onPreview: (p: MediaPreview) => void;
  onRegen: () => void;
  onEditPrompt: () => void;
  onAiChange: () => void;
  onRegenWithCorrection?: () => void;
  onDelete: () => void;
  onUpload: (file: File) => void;
  /** applied=зелёный, pending=янтарь (очередь), failed=красный. */
  slotTone?: SlotTone;
  stale?: boolean;
  scrollRootRef?: RefObject<HTMLDivElement | null>;
  /** Слот картинки: drag с файла + drop в пустую/занятую ячейку. */
  imageSlot?: ImageSlotRef;
  onImageDrop?: (from: ImageSlotRef) => void;
  onSwapPick?: () => void;
  swapSelected?: boolean;
  swapBusy?: boolean;
  /** Кадр в центре доски — картинка на три строки в высоту. */
  tall?: boolean;
  /** Формат проекта («9:16» / «16:9») — задаёт высоту большого кадра. */
  tallAspect?: string | null;
  /** Данные кадра прямо под картинкой (меню покрытия, якорь, рефы). */
  caption?: ReactNode;
  /** Родитель / дочерний — поверх картинки сверху. */
  overlay?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mediaH = tall ? null : "h-32";
  const mediaBox = tall ? tallMediaStyle(tallAspect) : undefined;
  // Не монтировать сотни <video>/<img> сразу — Chrome зависает на 150×2 клипах.
  const [inView, setInView] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const canDropImage = kind === "image" && !!imageSlot && !!onImageDrop;

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !url) return;
    const root = scrollRootRef?.current ?? null;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setInView(true);
      },
      { root, rootMargin: "120px 160px", threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [url, scrollRootRef]);

  const dropHandlers = canDropImage
    ? {
        onDragOver: (e: ReactDragEvent) => {
          if (!activeImageDrag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDragOver(true);
        },
        onDragLeave: () => setDragOver(false),
        onDrop: (e: ReactDragEvent) => {
          e.preventDefault();
          setDragOver(false);
          const from = parseImageDrag(e);
          activeImageDrag = null;
          if (!from || !imageSlot || !onImageDrop) return;
          if (
            from.frameNumber === imageSlot.frameNumber &&
            from.shot === imageSlot.shot &&
            (from.slot || "") === (imageSlot.slot || "")
          ) {
            return;
          }
          onImageDrop(from);
        },
      }
    : {};

  const overlayBar =
    overlay && kind === "image" ? (
      <div
        className="absolute inset-x-0 top-0 z-10 p-1"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {overlay}
      </div>
    ) : null;

  if (!url) {
    return (
      <div
        className={cn(
          "rounded-lg",
          slotToneRing(slotTone),
          swapSelected && "ring-2 ring-amber-400/70",
          dragOver && "ring-2 ring-sky-400/70",
        )}
        {...dropHandlers}
      >
        <div className="relative">
          <div
            className={cn(
              "flex w-full items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground",
              mediaH,
              tall ? "bg-white/[0.06]" : "bg-black/20",
              dragOver ? "border-sky-400/60 bg-sky-500/10 text-sky-100" : "border-white/15",
              swapSelected && "border-amber-400/50 bg-amber-500/10",
            )}
            style={mediaBox}
          >
            {dragOver ? "отпустить сюда" : canDropImage ? "нет файла · можно бросить" : "нет файла"}
          </div>
          {overlayBar}
        </div>
        {caption ? <div className="mt-1">{caption}</div> : null}
        <MediaActionBar
          kind={kind}
          onRegen={onRegen}
          onEditPrompt={onEditPrompt}
          onAiChange={onAiChange}
          onRegenWithCorrection={onRegenWithCorrection}
          onDelete={onDelete}
          onUpload={onUpload}
          onSwapPick={onSwapPick}
          swapSelected={swapSelected}
          swapBusy={swapBusy}
        />
      </div>
    );
  }

  const open = () => onPreview({ url, kind, label });

  return (
    <div
      ref={hostRef}
      className={cn(
        "rounded-lg",
        slotToneRing(slotTone),
        // stale только если нет статуса apply (иначе failed/pending важнее).
        !slotTone && stale && "ring-2 ring-amber-500/50",
        swapSelected && "ring-2 ring-amber-400/70",
        dragOver && "ring-2 ring-sky-400/70",
      )}
      {...dropHandlers}
    >
      <div className="relative">
      {kind === "video" ? (
        <button
          type="button"
          className={cn(
            "group relative block w-full overflow-hidden rounded-lg border border-white/10 bg-black",
            mediaH,
          )}
          style={mediaBox}
          onClick={open}
          title={`Открыть ${label}`}
        >
          {inView ? (
            <video
              key={url}
              src={url}
              className="h-full w-full object-cover transition group-hover:brightness-110"
              preload="metadata"
              muted
              playsInline
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-black/40 text-2xl text-white/50">
              ▶
            </div>
          )}
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 text-xs font-medium text-white opacity-0 transition group-hover:opacity-100">
            ▶ Открыть
          </span>
        </button>
      ) : (
        <button
          type="button"
          draggable={!!imageSlot}
          className={cn(
            "group block w-full cursor-grab overflow-hidden rounded-lg border border-white/10 bg-black active:cursor-grabbing",
            mediaH,
          )}
          style={mediaBox}
          onClick={open}
          title={
            imageSlot
              ? `Открыть ${label} · перетащи в другую ячейку (в т.ч. пустую)`
              : `Открыть ${label}`
          }
          onDragStart={(e) => {
            if (!imageSlot) return;
            activeImageDrag = imageSlot;
            const payload = JSON.stringify(imageSlot);
            e.dataTransfer.setData(MONTAGE_IMAGE_DRAG, payload);
            e.dataTransfer.setData("text/plain", payload);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            activeImageDrag = null;
            setDragOver(false);
          }}
        >
          {inView ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              key={url}
              src={url}
              alt={label}
              loading="lazy"
              decoding="async"
              draggable={false}
              className={cn(
                "h-full w-full transition group-hover:brightness-110",
                // Кадр в центре доски показываем целиком: вертикаль 9:16 при
                // object-cover теряла треть картинки.
                tall ? "object-contain" : "object-cover group-hover:scale-[1.02]",
              )}
            />
          ) : (
            <div className="h-full w-full bg-black/30" />
          )}
        </button>
      )}
      {overlayBar}
      </div>
      {caption ? <div className="mt-1">{caption}</div> : null}
      <MediaActionBar
        kind={kind}
        onRegen={onRegen}
        onEditPrompt={onEditPrompt}
        onAiChange={onAiChange}
        onRegenWithCorrection={onRegenWithCorrection}
        onDelete={onDelete}
        onUpload={onUpload}
        onSwapPick={onSwapPick}
        swapSelected={swapSelected}
        swapBusy={swapBusy}
      />
    </div>
  );
});

function formatSecShort(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  return sec.toFixed(1);
}

function clampTrim(
  start: number,
  end: number,
  fileMax: number,
  maxSpan: number,
  moved: "start" | "end",
  minGap = 0.1,
): VideoTrim {
  let s = Math.max(0, Math.min(start, fileMax));
  let e = Math.max(0, Math.min(end, fileMax));
  if (moved === "start") {
    s = Math.min(s, fileMax - minGap);
    if (e < s + minGap) e = s + minGap;
    if (e - s > maxSpan) e = Math.min(fileMax, s + maxSpan);
  } else {
    e = Math.max(minGap, e);
    if (e < s + minGap) s = e - minGap;
    if (e - s > maxSpan) s = Math.max(0, e - maxSpan);
  }
  s = Math.max(0, Math.min(s, fileMax - minGap));
  e = Math.max(s + minGap, Math.min(e, fileMax));
  if (e - s > maxSpan) {
    if (moved === "start") e = Math.min(fileMax, s + maxSpan);
    else s = Math.max(0, e - maxSpan);
  }
  return { start: s, end: e };
}

function DualRangeSlider({
  fileMax,
  maxSpan,
  trim,
  onTrimChange,
}: {
  fileMax: number;
  maxSpan: number;
  trim: VideoTrim;
  onTrimChange: (next: VideoTrim) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<"start" | "end" | null>(null);

  const startPct = fileMax > 0 ? (trim.start / fileMax) * 100 : 0;
  const endPct = fileMax > 0 ? (trim.end / fileMax) * 100 : 100;

  const valueFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || fileMax <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(ratio * fileMax * 10) / 10;
    },
    [fileMax],
  );

  useEffect(() => {
    if (!active) return;
    const onMove = (e: PointerEvent) => {
      const v = valueFromClientX(e.clientX);
      if (active === "start") {
        onTrimChange(clampTrim(v, trim.end, fileMax, maxSpan, "start"));
      } else {
        onTrimChange(clampTrim(trim.start, v, fileMax, maxSpan, "end"));
      }
    };
    const onUp = () => setActive(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [active, fileMax, maxSpan, onTrimChange, trim.end, trim.start, valueFromClientX]);

  if (fileMax <= 0) return null;

  return (
    <div className="relative isolate mt-2 px-1 py-2">
      <div
        ref={trackRef}
        className="relative mx-1.5 h-2.5 rounded-full bg-white/15"
        role="presentation"
      >
        <div
          className="absolute top-0 h-2.5 rounded-full bg-amber-500/80 shadow-sm"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />
        <button
          type="button"
          className={cn(
            "absolute top-1/2 z-10 h-4.5 w-4.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400 bg-amber-200 shadow-md transition-transform",
            active === "start" && "scale-125 ring-2 ring-amber-400/50",
          )}
          style={{ left: `${startPct}%` }}
          aria-label="Начало фрагмента"
          onPointerDown={(e) => {
            e.preventDefault();
            setActive("start");
          }}
        />
        <button
          type="button"
          className={cn(
            "absolute top-1/2 z-10 h-4.5 w-4.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-400 bg-amber-200 shadow-md transition-transform",
            active === "end" && "scale-125 ring-2 ring-amber-400/50",
          )}
          style={{ left: `${endPct}%` }}
          aria-label="Конец фрагмента"
          onPointerDown={(e) => {
            e.preventDefault();
            setActive("end");
          }}
        />
      </div>
    </div>
  );
}

function VideoTrimSlider({
  fileDuration,
  sceneUse,
  trim,
  onTrimChange,
}: {
  fileDuration: number | null;
  sceneUse: number | null;
  trim: VideoTrim | undefined;
  onTrimChange: (next: VideoTrim) => void;
}) {
  if (sceneUse == null) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Нет меток озвучки для расчёта длительности сцены
      </p>
    );
  }

  const fileMax = fileDuration ?? sceneUse;
  const current = trim ?? clampTrim(0, Math.min(sceneUse, fileMax), fileMax, sceneUse, "end");
  const usedLen = Math.max(0, current.end - current.start);

  return (
    <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2.5 pb-3 shadow-inner">
      <p className="text-xs text-zinc-300 font-medium">
        В сцене:{" "}
        <span className="font-mono font-bold text-amber-300">{formatSecShort(usedLen)}</span>{" "}
        из{" "}
        <span className="font-mono font-bold text-zinc-100">{formatSecShort(sceneUse)}</span> с
      </p>
      <DualRangeSlider
        fileMax={fileMax}
        maxSpan={sceneUse}
        trim={current}
        onTrimChange={onTrimChange}
      />
    </div>
  );
}

const VideoMediaCell = memo(function VideoMediaCell({
  fr,
  shot,
  url,
  onPreview,
  trim,
  onTrimChange,
  onRegen,
  onEditPrompt,
  onAiChange,
  onDelete,
  onUpload,
  slotTone,
  stale,
  scrollRootRef,
  onSwapPick,
  swapSelected,
  swapBusy,
}: {
  fr: MontageBoardFrame;
  shot: 1 | 2;
  url: string | null;
  onPreview: (p: MediaPreview) => void;
  trim: VideoTrim | undefined;
  onTrimChange: (next: VideoTrim) => void;
  onRegen: () => void;
  onEditPrompt: () => void;
  onAiChange: () => void;
  onDelete: () => void;
  onUpload: (file: File) => void;
  slotTone?: SlotTone;
  stale?: boolean;
  scrollRootRef?: RefObject<HTMLDivElement | null>;
  onSwapPick?: () => void;
  swapSelected?: boolean;
  swapBusy?: boolean;
}) {
  const isShot2 = shot === 2;
  const sceneUse = isShot2 ? fr.shot2_use_seconds : fr.shot1_use_seconds;
  const fileDur = isShot2 ? fr.video_shot2_duration : fr.video_shot1_duration;
  const label = `Видео ${shot} · кадр #${fr.number}`;

  if (isShot2 && !fr.has_shot2) {
    return (
      <p className="text-xs text-muted-foreground">Второй кадр не задан</p>
    );
  }

  return (
    <div>
      <ClickableMedia
        url={url}
        kind="video"
        label={label}
        onPreview={onPreview}
        onRegen={onRegen}
        onEditPrompt={onEditPrompt}
        onAiChange={onAiChange}
        onDelete={onDelete}
        onUpload={onUpload}
        slotTone={slotTone}
        stale={stale}
        scrollRootRef={scrollRootRef}
        onSwapPick={onSwapPick}
        swapSelected={swapSelected}
        swapBusy={swapBusy}
      />
      <VideoTrimSlider
        fileDuration={fileDur}
        sceneUse={sceneUse}
        trim={trim}
        onTrimChange={onTrimChange}
      />
    </div>
  );
});

function TimestampCell({ fr }: { fr: MontageBoardFrame }) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2">
      <div className="font-mono text-xs font-semibold text-amber-300">
        {formatTs(fr.start_ts)} → {formatTs(fr.end_ts)}
      </div>
      {fr.duration_seconds != null ? (
        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
          {fr.duration_seconds.toFixed(1)} с
        </div>
      ) : null}
    </div>
  );
}

function buildDefaultTrims(frames: MontageBoardFrame[]): Record<string, VideoTrim> {
  const out: Record<string, VideoTrim> = {};
  for (const fr of frames) {
    for (const shot of [1, 2] as const) {
      if (shot === 2 && !fr.has_shot2) continue;
      const use = shot === 1 ? fr.shot1_use_seconds : fr.shot2_use_seconds;
      const file = shot === 1 ? fr.video_shot1_duration : fr.video_shot2_duration;
      if (use == null) continue;
      const fileMax = file ?? use;
      const end = Math.min(use, fileMax);
      out[trimKey(fr.number, shot)] = clampTrim(0, end, fileMax, use, "end");
    }
  }
  return out;
}

function mergeTrimsFromMeta(
  frames: MontageBoardFrame[],
  metaTrims: Record<string, { start: number; end: number }>,
): Record<string, VideoTrim> {
  const defaults = buildDefaultTrims(frames);
  const merged = { ...defaults };
  for (const [key, t] of Object.entries(metaTrims)) {
    if (t && typeof t.start === "number" && typeof t.end === "number") {
      merged[key] = { start: t.start, end: t.end };
    }
  }
  return merged;
}

/** Radix Dropdown/Popover после apply часто оставляет body { pointer-events: none }. */
function restoreDocumentPointerEvents() {
  if (typeof document === "undefined") return;
  document.body.style.removeProperty("pointer-events");
  document.documentElement.style.removeProperty("pointer-events");
}

export function AssembleMontageBoard({
  open,
  projectId,
  montageBusy = false,
  onClose,
}: {
  open: boolean;
  projectId: number | null;
  montageBusy?: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const [collapsedRows, setCollapsedRows] = useState<Set<RowKey>>(new Set());
  /** Панель «Переменные проекта» (кнопка «+» над первой строкой доски). */
  const [variablesOpen, setVariablesOpen] = useState(false);
  /** Меню «Шаги на доске» у места клика: правый клик по доске или кнопка «⋯». */
  const [rowsMenu, setRowsMenu] = useState<{ x: number; y: number } | null>(null);
  const [trims, setTrims] = useState<Record<string, VideoTrim>>({});
  const [pendingOps, setPendingOps] = useState<MontagePendingOp[]>([]);
  const [promptModal, setPromptModal] = useState<PromptModalState>(null);
  const [aiChangeModal, setAiChangeModal] = useState<AiChangeModalState>(null);
  /** Действия картинки шота в режиме «колонка = шот». */
  const [shotPrompt, setShotPrompt] = useState<ShotPromptState>(null);
  const [shotBusyKey, setShotBusyKey] = useState<string | null>(null);
  const [selectedOpKeys, setSelectedOpKeys] = useState<Set<string>>(new Set());
  const [highlights, setHighlights] = useState<string[]>([]);
  const [failedHighlights, setFailedHighlights] = useState<string[]>([]);
  const [staleVideos, setStaleVideos] = useState<string[]>([]);
  const [montageRunning, setMontageRunning] = useState(false);
  const [applyRunning, setApplyRunning] = useState(false);
  const applyRunningRef = useRef(false);
  const setApplyRunningNow = (value: boolean) => {
    applyRunningRef.current = value;
    setApplyRunning(value);
  };
  const [recoverRunning, setRecoverRunning] = useState(false);
  const [swapPick, setSwapPick] = useState<SwapSlotPick | null>(null);
  const [swapBusy, setSwapBusy] = useState(false);
  const [moveImageBusy, setMoveImageBusy] = useState(false);
  const [frameEditBusy, setFrameEditBusy] = useState(false);
  /** Роль, которую только что нажали — до ответа сервера. */
  const [kindOverride, setKindOverride] = useState<
    Record<number, "parent" | "child">
  >({});
  const [addFrame, setAddFrame] = useState<{
    afterFrameId: number | null;
    kind: "parent" | "child";
  } | null>(null);
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const pendingOpsRef = useRef<MontagePendingOp[]>([]);
  const sentApplyKeysRef = useRef<string[]>([]);
  /** pending_ops чужого или своего job: done/idle сверяет очередь без submittedApplyRef. */
  const jobAppliedOpsRef = useRef<MontagePendingOp[]>([]);
  const montageActive = montageRunning || montageBusy;
  pendingOpsRef.current = pendingOps;
  /** Пользователь набрал очередь локально — не затирать пустым meta с сервера. */
  const localQueueDirtyRef = useRef(false);
  /** Мы сами отправили apply (started) — можно чистить/синхронизировать очередь. */
  const submittedApplyRef = useRef(false);
  const trimsDirtyRef = useRef(false);
  const lastApplyToastKeyRef = useRef("");
  /** Этот прогон apply наш: принимаем done/idle даже если running не успел прийти. */
  const applySeenRunningRef = useRef(false);
  const lastPatchedPathRef = useRef("");
  const lastMontageToastKeyRef = useRef("");
  const lastRecoverToastKeyRef = useRef("");

  const contentScrollRef = useRef<HTMLDivElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const hBarRef = useRef<HTMLDivElement>(null);

  const board = useQuery({
    queryKey: ["montage-board", projectId],
    queryFn: () => api.getMontageBoard(projectId!),
    enabled: open && projectId != null,
    retry: 2,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 4000),
    refetchOnMount: "always",
    staleTime: 0,
    // НЕ placeholderData/keepPreviousData: иначе очередь/кадры чужого проекта
    // остаются на кнопке «Применить правки» при переключении.
  });

  // Пустая доска сама наполняется: шаги создают кадры в фоне, поэтому пока
  // кадров нет — тянем доску раз в 5 с. Иначе только что открытый проект
  // выглядит «монтаж не работает, там ничего нет».
  useEffect(() => {
    if (!open || projectId == null) return;
    if (board.isLoading || board.isError) return;
    if ((board.data?.frames?.length ?? 0) > 0) return;
    const timer = window.setInterval(() => void board.refetch(), 5000);
    return () => window.clearInterval(timer);
  }, [open, projectId, board.isLoading, board.isError, board.data, board.refetch]);

  // Видимость строк доски хранится в meta проекта (переживает перезагрузку),
  // читаем её из того же кэша ["project", projectId], что и остальная студия.
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId as number),
    enabled: open && projectId != null,
    staleTime: 30_000,
  });

  // Сброс локальной очереди при смене проекта — СНАЧАЛА flush старой очереди.
  const prevProjectIdRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevProjectIdRef.current;
    prevProjectIdRef.current = projectId;
    if (prev != null && prev !== projectId && localQueueDirtyRef.current) {
      const ops = pendingOpsRef.current;
      void api.saveMontageQueue(prev, { pending_ops: ops, force_clear: ops.length === 0 }).catch(() => {});
    }
    setPendingOps([]);
    pendingOpsRef.current = [];
    localQueueDirtyRef.current = false;
    trimsDirtyRef.current = false;
    submittedApplyRef.current = false;
    applySeenRunningRef.current = false;
    setTrims({});
    setHighlights([]);
    setFailedHighlights([]);
    setStaleVideos([]);
    setApplyRunningNow(false);
    setApplyProgress(null);
    setMontageRunning(false);
    setRecoverRunning(false);
    setPromptModal(null);
    setAiChangeModal(null);
    setSelectedOpKeys(new Set());
    setPreview(null);
    setSwapPick(null);
    setSwapBusy(false);
    lastApplyToastKeyRef.current = "";
    restoreDocumentPointerEvents();
  }, [projectId]);

  // Прогрев «Доп. функции» — getProject не блокирует первый клик.
  useEffect(() => {
    if (!open || projectId == null) return;
    void queryClient.prefetchQuery({
      queryKey: ["project", projectId],
      queryFn: () => api.getProject(projectId),
      staleTime: 30_000,
    });
    // После regen staleTime/кэш иначе показывает старые клипы и пустую
    // подсветку. invalidate, не reset: прошлая доска висит до новых данных.
    void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
  }, [open, projectId, queryClient]);

  // При закрытии панели — сразу сохранить очередь (не ждать debounce).
  useEffect(() => {
    if (open || projectId == null) return;
    if (!localQueueDirtyRef.current) return;
    const ops = pendingOpsRef.current;
    void api
      .saveMontageQueue(projectId, { pending_ops: ops, force_clear: ops.length === 0 })
      .then(() => {
        localQueueDirtyRef.current = false;
      })
      .catch(() => {});
  }, [open, projectId]);

  const frames = board.data?.frames ?? [];
  const ranges = useMemo(() => sceneRanges(frames), [frames]);
  /** Колонки доски по шотам: одна колонка = один запланированный шот кадра. */
  const shotUnits = useMemo<ShotUnit[]>(() => ranges.flatMap(rangeShotUnits), [ranges]);
  // Доска показывает РЕАЛЬНОЕ число кадров: колонка = запланированный шот из
  // attrs["кадры"] (S1-K1…). Проекты без плана живут в старой сетке по кадрам.
  // Раскладка по шотам — только если план шотов есть у ВСЕХ кадров. Иначе
  // кадры без плана попадали в шотовую ветку и их ячейки «Кадры»/«Закадр»
  // оставались пустыми без картинки и кнопок (а доска выглядела сломанной).
  const shotMode = useMemo(
    () => shotUnits.length > 0 && shotUnits.every((unit) => unit.shot),
    [shotUnits],
  );
  const coverageOn = Boolean(board.data?.show_coverage_rows);
  const frameAspect = board.data?.frame_aspect ?? null;
  const colRem = coverageOn ? frameColRem(frameAspect) : FRAME_COL_REM;
  const gridRows = useMemo(() => {
    if (!coverageOn) return GRID_ROWS;
    // 18:49: строки тела — Кадры, Закадр кадра, Действие кадра, Видео 1,
    // Таймкоды. Отдельной строки «Сцена» нет (её вернули в task-17 — убрали).
    const frameRow = GRID_ROWS.filter((r) => r.key === "image1");
    const rest = GRID_ROWS.filter((r) => r.key !== "image1" && r.key !== "voiceover");
    return [...frameRow, ...SCENE_SHOT_ROWS, ...rest];
  }, [coverageOn]);

  // Видимость строк доски: ключ строки → false значит «скрыта». Нет ключа —
  // строка видима (дефолт для новых строк и для проекта без meta).
  const rowsVisible = useMemo<Record<string, boolean>>(() => {
    const raw = (projectQuery.data?.meta ?? {})["montage_rows_visible"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const parsed: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "boolean") parsed[key] = value;
    }
    return parsed;
  }, [projectQuery.data]);

  const rowsVisibility = useMutation({
    mutationFn: (next: Record<string, boolean>) => {
      if (projectId == null) throw new Error("проект не выбран");
      return api.patchProject(projectId, { meta: { montage_rows_visible: next } });
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });
      const prev = queryClient.getQueryData<ProjectDetail>(["project", projectId]);
      queryClient.setQueryData<ProjectDetail>(["project", projectId], (old) =>
        old ? { ...old, meta: { ...(old.meta ?? {}), montage_rows_visible: next } } : old,
      );
      return { prev };
    },
    onError: (error, _next, context) => {
      // Строки не должны «прыгать» молча: откат + тост, человек видит, что не записалось.
      if (context?.prev) queryClient.setQueryData(["project", projectId], context.prev);
      toast.error(errorMessageFromUnknown(error));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["project", projectId], data);
    },
  });

  /**
   * Порядок и высота строк доски — тоже в meta проекта, рядом с видимостью.
   * Порядок: `montage_rows_order` = ключи всех строк (спец + node:* + res:*).
   * Высота: `montage_row_heights` = {ключ: px} (40–600), нет ключа — авто.
   */
  const rowsOrder = useMemo<string[]>(() => {
    const raw = (projectQuery.data?.meta ?? {})["montage_rows_order"];
    if (!Array.isArray(raw)) return [];
    return raw.filter((key): key is string => typeof key === "string");
  }, [projectQuery.data]);
  const rowHeights = useMemo<Record<string, number>>(() => {
    const raw = (projectQuery.data?.meta ?? {})["montage_row_heights"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const parsed: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        parsed[key] = clampRowHeight(value);
      }
    }
    return parsed;
  }, [projectQuery.data]);

  const rowsLayout = useMutation({
    mutationFn: (patch: {
      montage_rows_order?: string[];
      montage_row_heights?: Record<string, number>;
    }) => {
      if (projectId == null) throw new Error("проект не выбран");
      return api.patchProject(projectId, { meta: patch });
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });
      const prev = queryClient.getQueryData<ProjectDetail>(["project", projectId]);
      queryClient.setQueryData<ProjectDetail>(["project", projectId], (old) =>
        old ? { ...old, meta: { ...(old.meta ?? {}), ...patch } } : old,
      );
      return { prev };
    },
    onError: (error, _patch, context) => {
      if (context?.prev) queryClient.setQueryData(["project", projectId], context.prev);
      toast.error(errorMessageFromUnknown(error));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["project", projectId], data);
    },
  });
  const saveRowsLayout = useCallback(
    (patch: {
      montage_rows_order?: string[];
      montage_row_heights?: Record<string, number>;
    }) => {
      if (projectId == null) return;
      rowsLayout.mutate(patch);
    },
    [projectId, rowsLayout],
  );

  // Перетаскивание строк: HTML5 drag & drop, порядок пишется в meta.
  const [draggingRow, setDraggingRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  // Изменение высоты: тянем за нижнюю ручку первой ячейки.
  const [resizeRow, setResizeRow] = useState<{
    key: string;
    startY: number;
    startHeight: number;
  } | null>(null);
  const [resizeHeight, setResizeHeight] = useState<number | null>(null);

  const effectiveRowHeights = useMemo<Record<string, number>>(() => {
    const next = { ...rowHeights };
    if (resizeRow && resizeHeight != null) next[resizeRow.key] = resizeHeight;
    return next;
  }, [rowHeights, resizeRow, resizeHeight]);

  useEffect(() => {
    if (!resizeRow) return;
    const onMove = (event: MouseEvent) => {
      const next = clampRowHeight(resizeRow.startHeight + (event.clientY - resizeRow.startY));
      setResizeHeight(next);
    };
    const onUp = () => {
      setResizeHeight((current) => {
        if (current != null) {
          const key = resizeRow.key;
          const base = rowsLayout.isPending ? rowHeights : rowHeights;
          saveRowsLayout({ montage_row_heights: { ...base, [key]: current } });
        }
        return null;
      });
      setResizeRow(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizeRow, rowHeights, saveRowsLayout, rowsLayout.isPending]);

  const startRowResize = useCallback(
    (key: string) => (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const row = (event.currentTarget.closest("tr") as HTMLElement | null) ?? null;
      const startHeight = row?.getBoundingClientRect().height ?? ROW_HEIGHT_DEFAULT;
      setResizeRow({ key, startY: event.clientY, startHeight });
      setResizeHeight(clampRowHeight(startHeight));
    },
    [],
  );
  const resetRowHeight = useCallback(
    (key: string) => {
      if (!(key in rowHeights)) return;
      const next = { ...rowHeights };
      delete next[key];
      saveRowsLayout({ montage_row_heights: next });
    },
    [rowHeights, saveRowsLayout],
  );

  /**
   * Включить/выключить набор строк (клик по шагу или глаз в панели «Переменные
   * проекта»). Пишем в тот же meta.montage_rows_visible, что и раньше: доска
   * фильтрует строки по нему, значение переживает перезагрузку. Спец-строки по
   * умолчанию видимы, обобщённые строки шагов (`node:<node_key>`) — скрыты.
   *
   * Ключи результатов (`res:*`) храним только как `true`: «убрать с доски» =
   * удалить ключ. Иначе в meta проекта копится мусор `res:<node>:shown=false`,
   * и его видят все, кто читает meta (панель, отчёты, повторные проекты).
   */
  const setBoardRows = useCallback(
    (rowKeys: string[], visible: boolean) => {
      if (rowKeys.length === 0) return;
      const next: Record<string, boolean> = {};
      // Заодно вычищаем старые false-ключи результатов, накопленные до правки.
      for (const [key, value] of Object.entries(rowsVisible)) {
        if (!(value === true) && key.startsWith(RES_ROW_PREFIX)) continue;
        next[key] = value;
      }
      let changed = false;
      for (const key of rowKeys) {
        // Обычные строки доски видимы по умолчанию, строки результатов — нет.
        const hiddenByDefault = key.startsWith(RES_ROW_PREFIX);
        const current = hiddenByDefault ? next[key] === true : next[key] !== false;
        if (current !== visible) changed = true;
        if (visible) {
          next[key] = true;
        } else if (hiddenByDefault) {
          delete next[key];
        } else {
          next[key] = false;
        }
      }
      if (!changed) return;
      rowsVisibility.mutate(next);
    },
    [rowsVisible, rowsVisibility],
  );

  /** Есть ли включённые строки результатов (`res:<node>:<item>`) — тогда грузим. */
  const hasShownResRows = useMemo(
    () =>
      Object.entries(rowsVisible).some(
        ([key, value]) => key.startsWith(RES_ROW_PREFIX) && value === true,
      ),
    [rowsVisible],
  );
  const stepVariablesQuery = useQuery({
    queryKey: ["montage-variables", projectId],
    queryFn: () => api.getMontageVariables(projectId as number),
    enabled:
      open &&
      projectId != null &&
      (variablesOpen || hasShownResRows || rowsMenu != null || open),
    staleTime: 15_000,
  });
  // Результаты шагов: панель открыта или на доске уже есть строки результатов.
  const { nodes: rawResultNodes, frames: resultFrames } = useMontageResults(
    projectId,
    open && (variablesOpen || hasShownResRows || open),
  );
  const stepNodes = stepVariablesQuery.data?.nodes ?? [];
  // Привязка единиц результата к своим кадрам/сценам: шоты, сцены по плану,
  // диалоги, каркас, QC, стиль ложатся в колонки вместо общей строки.
  const placements = useMontagePlacements(stepNodes, resultFrames);
  const resultNodes = useMemo(
    () => applyPlacements(rawResultNodes, placements),
    [rawResultNodes, placements],
  );

  // Полная ширина строки таблицы — чтобы обобщённая строка шага встала ровно.
  // В режиме шотов: подпись строки + по колонке на каждый шот (без зазоров).
  const gridColSpan = useMemo(
    () =>
      shotMode
        ? 1 + shotUnits.length
        : 1 + ranges.reduce((sum, range) => sum + 1 + sceneColSpan(range.frames.length), 0) + 1,
    [ranges, shotMode, shotUnits.length],
  );

  // Строки результатов: любую единицу результата шага можно вывести на доску
  // (`res:<node_key>:<item_id>`), а панель включает строку ноды целиком
  // (`res:<node_key>:shown`) — тогда доска сама раскладывает ВСЕ её единицы.
  // Персонажи/предметы ложатся по кадрам, фоны — по сценам (в режиме шотов —
  // по шотам), шоты — в колонку своего шота, остальное — общей строкой.
  const visibleResRows = useMemo(() => {
    const rows: Array<{
      node: MontageResultNode;
      item: NodeResultItem | null;
      layout: ResultRowLayout;
      rowKey: string;
    }> = [];
    for (const node of resultNodes) {
      const baseLayout = resultRowLayout(node.nodeType, node.snapshot.items);
      const hasShotPlacement = node.snapshot.items.some(
        (candidate) => boardPlacement(candidate)?.kind === "shot",
      );
      // В режиме шотов фоны раскладываем по шотам, а не сценой.
      const layout: ResultRowLayout = !shotMode
        ? baseLayout
        : node.nodeType === "backgrounds" || hasShotPlacement
          ? "frame"
          : baseLayout;
      const nodeShown = rowsVisible[`res:${node.nodeKey}:shown`] === true;
      if (layout !== "full") {
        const rowKey = resultRowKey(node.nodeKey, SPREAD_ITEM_ID);
        if (nodeShown || rowsVisible[rowKey] === true) {
          rows.push({ node, item: null, layout, rowKey });
        }
        continue;
      }
      // Общая строка ноды (отчёт/сводка): панель включает её целиком.
      if (nodeShown && node.snapshot.items.length > 0) {
        rows.push({
          node,
          item: node.snapshot.items[0],
          layout,
          rowKey: `res:${node.nodeKey}:shown`,
        });
      }
      for (const item of node.snapshot.items) {
        const rowKey = resultRowKey(node.nodeKey, item.id);
        if (rowsVisible[rowKey] === true) {
          rows.push({ node, item, layout, rowKey });
        }
      }
    }
    return rows;
  }, [resultNodes, rowsVisible, shotMode]);

  const visibleGridRows = useMemo(
    () => gridRows.filter((row) => rowsVisible[row.key] !== false),
    [gridRows, rowsVisible],
  );

  /**
   * Все видимые строки доски одним списком: спец-строки, строки шагов
   * (`node:*`) и строки результатов (`res:*`). Порядок — из meta
   * `montage_rows_order`; неизвестные ключи идут в конец в порядке графа.
   */
  const renderEntries = useMemo(() => {
    const entries: Array<{ kind: "grid" | "result"; key: string }> = [];
    for (const row of visibleGridRows) entries.push({ kind: "grid", key: row.key });
    for (const row of visibleResRows) entries.push({ kind: "result", key: row.rowKey });
    const gridByKey = new Map(visibleGridRows.map((row) => [row.key, row]));
    const resByKey = new Map(visibleResRows.map((row) => [row.rowKey, row]));
    const rank = new Map<string, number>();
    rowsOrder.forEach((key, index) => rank.set(key, index));
    const ordered = entries
      .filter((entry) => rank.has(entry.key))
      .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
    const unordered = entries.filter((entry) => !rank.has(entry.key));
    return [...ordered, ...unordered].map((entry) =>
      entry.kind === "grid"
        ? { kind: "grid" as const, key: entry.key, row: gridByKey.get(entry.key as RowKey)! }
        : { kind: "result" as const, key: entry.key, row: resByKey.get(entry.key)! },
    );
  }, [visibleGridRows, visibleResRows, rowsOrder]);

  /** Переставить строку `fromKey` на место `toKey` и сохранить весь порядок. */
  const moveRowBefore = useCallback(
    (fromKey: string, toKey: string) => {
      const keys = renderEntries.map((entry) => entry.key);
      const from = keys.indexOf(fromKey);
      const to = keys.indexOf(toKey);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...keys];
      next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, fromKey);
      if (next.every((key, index) => key === keys[index])) return;
      const visibleSet = new Set(next);
      const hiddenKnown = rowsOrder.filter((key) => !visibleSet.has(key));
      saveRowsLayout({ montage_rows_order: [...next, ...hiddenKnown] });
    },
    [renderEntries, rowsOrder, saveRowsLayout],
  );

  /**
   * Перетаскивание строки мышью: тянем за ручку, ищем целевую строку под
   * курсором (data-row-key), подсвечиваем её и на отпускании меняем порядок.
   * Pointer-вариант выбран вместо HTML5 DnD — не зависит от drag-режима браузера.
   */
  const rowDragRef = useRef<{ key: string; startY: number; moved: boolean } | null>(null);
  const dropTargetRef = useRef<string | null>(null);

  const startRowDrag = useCallback(
    (rowKey: string, event: ReactMouseEvent<HTMLElement>) => {
      rowDragRef.current = { key: rowKey, startY: event.clientY, moved: false };
      dropTargetRef.current = null;
      setDraggingRow(rowKey);
      setDropRow(null);
      const onMove = (moveEvent: MouseEvent) => {
        const drag = rowDragRef.current;
        if (!drag) return;
        if (!drag.moved && Math.abs(moveEvent.clientY - drag.startY) < 3) return;
        drag.moved = true;
        const element = document.elementFromPoint(
          moveEvent.clientX,
          moveEvent.clientY,
        ) as HTMLElement | null;
        const rowElement = element?.closest("tbody tr");
        const targetKey = rowElement?.getAttribute("data-row-key") ?? "";
        const nextTarget = targetKey && targetKey !== drag.key ? targetKey : null;
        if (dropTargetRef.current !== nextTarget) {
          dropTargetRef.current = nextTarget;
          setDropRow(nextTarget);
        }
      };
      const onUp = () => {
        const drag = rowDragRef.current;
        const target = dropTargetRef.current;
        rowDragRef.current = null;
        dropTargetRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setDraggingRow(null);
        setDropRow(null);
        if (drag?.moved && target && target !== drag.key) {
          moveRowBefore(drag.key, target);
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [moveRowBefore],
  );

  /**
   * Содержимое меню «Шаги на доске»: сначала строки, которые сейчас на доске
   * (порядок доски), затем скрытые — сначала спец-строки, потом обобщённые
   * строки шагов в порядке графа. Скрытые остаются в списке, иначе не вернуть.
   */
  const rowsMenuItems = useMemo<MontageRowsMenuItem[]>(() => {
    const specialNodesByRow = new Map<string, string[]>();
    for (const node of stepNodes) {
      for (const rowKey of node.montage_rows ?? []) {
        const names = specialNodesByRow.get(rowKey) ?? [];
        names.push(node.label);
        specialNodesByRow.set(rowKey, names);
      }
    }
    const specialVisible = visibleGridRows.map((row) => ({
      key: row.key,
      label: row.label,
      visible: true,
      hint: specialNodesByRow.get(row.key)?.join(" · "),
    }));
    const specialHidden = gridRows
      .filter((row) => rowsVisible[row.key] === false)
      .map((row) => ({
        key: row.key,
        label: row.label,
        visible: false,
        hint: specialNodesByRow.get(row.key)?.join(" · "),
      }));
    return [...specialVisible, ...specialHidden];
  }, [stepNodes, visibleGridRows, gridRows, rowsVisible]);

  const toggleRowFromMenu = useCallback(
    (rowKey: string, visible: boolean) => setBoardRows([rowKey], visible),
    [setBoardRows],
  );

  // Правый клик по доске: меню строк у курсора. В полях ввода не перехватываем.
  const handleBoardContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true'], [role='menu']")) return;
    event.preventDefault();
    setRowsMenu({ x: event.clientX, y: event.clientY });
  }, []);

  // Доска закрылась — меню не должно висеть поверх студии.
  useEffect(() => {
    if (!open) setRowsMenu(null);
  }, [open]);

  const meta = board.data?.meta;
  const pendingOpsKey = JSON.stringify(meta?.pending_ops ?? []);

  useEffect(() => {
    const live = new Set(pendingOps.map(opSelectKey));
    setSelectedOpKeys((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)));
      if (next.size === prev.size && [...next].every((k) => prev.has(k))) return prev;
      return next;
    });
  }, [pendingOps]);

  const parsePendingOps = useCallback((raw: unknown): MontagePendingOp[] => {
    if (!Array.isArray(raw)) return [];
    const restored: MontagePendingOp[] = [];
    for (const op of raw) {
      if (!op || typeof op !== "object") continue;
      const rec = op as Record<string, unknown>;
      const t = String(rec.type || "");
      if (
        t !== "image_regen" &&
        t !== "image_regen_prompt" &&
        t !== "image_regen_correction" &&
        t !== "image_ai_change" &&
        t !== "video_regen" &&
        t !== "video_regen_prompt" &&
        t !== "video_ai_change" &&
        !COVERAGE_QUEUE_TYPES.has(t)
      ) {
        continue;
      }
      const frameNumber = Number(rec.frame_number);
      if (!Number.isFinite(frameNumber) || frameNumber < 1) continue;
      const shot = rec.shot === 2 ? 2 : 1;
      const item: MontagePendingOp = {
        type: t as MontagePendingOp["type"],
        frame_number: frameNumber,
        shot,
      };
      if (typeof rec.prompt === "string") item.prompt = rec.prompt;
      if (typeof rec.correction === "string") item.correction = rec.correction;
      if (typeof rec.instruction === "string") item.instruction = rec.instruction;
      if (typeof rec.plan === "string") item.plan = rec.plan;
      if (typeof rec.action === "string") item.action = rec.action;
      if (typeof rec.template === "string") item.template = rec.template;
      if (typeof rec.angle === "string") item.angle = rec.angle;
      if (typeof rec.move === "string") item.move = rec.move;
      if (typeof rec.stitch === "string") item.stitch = rec.stitch;
      if (typeof rec.light === "string") item.light = rec.light;
      if (typeof rec.set === "string") item.set = rec.set;
      if (typeof rec.sense === "string") item.sense = rec.sense;
      if (typeof rec.visual_type === "string") item.visual_type = rec.visual_type;
      if (typeof rec.place === "string") item.place = rec.place;
      if (typeof rec.characters === "string") item.characters = rec.characters;
      if (typeof rec.props === "string") item.props = rec.props;
      if (typeof rec.bg === "string") item.bg = rec.bg;
      if (typeof rec.accent === "string") item.accent = rec.accent;
      if (typeof rec.feature === "string") item.feature = rec.feature;
      if (Array.isArray(rec.anchors)) item.anchors = rec.anchors as SceneAnchorRow[];
      if (typeof rec.start === "number") item.start = rec.start;
      if (typeof rec.end === "number") item.end = rec.end;
      if (typeof rec.text === "string") item.text = rec.text;
      if (rec.clear === true) item.clear = true;
      if (rec.vo_span && typeof rec.vo_span === "object") {
        item.vo_span = rec.vo_span as MontagePendingOp["vo_span"];
      }
      if (rec.kind === "parent" || rec.kind === "child") item.kind = rec.kind;
      const parentNumber = Number(rec.parent_number);
      if (Number.isFinite(parentNumber) && parentNumber >= 1) {
        item.parent_number = parentNumber;
      }
      restored.push(item);
    }
    return restored;
  }, []);

  useEffect(() => {
    if (frames.length === 0) return;
    // Ждём settled fetch — иначе stale meta восстанавливает уже сделанные ops.
    if (board.isFetching) return;

    setHighlights(meta?.highlights ?? []);
    setFailedHighlights(meta?.failed_highlights ?? []);
    setStaleVideos(meta?.stale_videos ?? []);
    if (!trimsDirtyRef.current) {
      setTrims(mergeTrimsFromMeta(frames, meta?.video_trims ?? {}));
    }

    if (applyRunning) return;

    // Данные доски должны быть от текущего projectId (не stale кэш чужого).
    if (board.data == null) return;

    const restored = parsePendingOps(meta?.pending_ops);
    // Пока пользователь набирает очередь (dirty) — НИКОГДА не затирать её
    // серверным meta. Иначе: локально 40+, на сервере старые 8 → «стало 8».
    // То же после удаления чужого кадра: refetch не должен снимать правки.
    if (localQueueDirtyRef.current) {
      return;
    }
    if (
      pendingOpsRef.current.length > 0 &&
      !serverQueueReplacesLocal(pendingOpsRef.current, restored, opSelectKey)
    ) {
      return;
    }
    const nextKey = JSON.stringify(restored);
    if (nextKey === JSON.stringify(pendingOpsRef.current)) return;
    pendingOpsRef.current = restored;
    setPendingOps(restored);
  }, [
    projectId,
    board.data,
    board.dataUpdatedAt,
    board.isFetching,
    frames.length,
    meta?.video_trims,
    meta?.highlights,
    meta?.failed_highlights,
    meta?.stale_videos,
    pendingOpsKey,
    applyRunning,
    parsePendingOps,
  ]);

  const showPreview = useCallback((p: MediaPreview) => {
    setPreview(p);
  }, []);

  const queueSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistQueue = useCallback(
    (ops: MontagePendingOp[], immediate = false) => {
      if (projectId == null) return;
      // Во время apply очередь пишет сам apply (_finish_op) — клиентский
      // debounce с [] или устаревшим списком иначе затирает remaining.
      if (applyRunningRef.current) return;
      if (queueSaveTimerRef.current) clearTimeout(queueSaveTimerRef.current);
      const save = () => {
        void api
          .saveMontageQueue(projectId, {
            pending_ops: ops,
            video_trims: trimsDirtyRef.current ? trims : undefined,
            force_clear: ops.length === 0,
          })
          .catch(() => {
            // Не мешаем набору очереди — при следующем add/retry сохранится.
          });
      };
      if (immediate) {
        save();
        return;
      }
      queueSaveTimerRef.current = setTimeout(save, 400);
    },
    [projectId, trims],
  );

  useEffect(() => {
    if (applyRunning) return;
    if (!localQueueDirtyRef.current) return;
    if (pendingOpsRef.current.length === 0) return;
    persistQueue(pendingOpsRef.current);
  }, [applyRunning, persistQueue]);

  useEffect(() => {
    setKindOverride((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [raw, kind] of Object.entries(prev)) {
        const num = Number(raw);
        const fr = frames.find((f) => f.number === num);
        if (fr && fr.shot_kind === kind) {
          delete next[num];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [frames]);

  const queueOp = useCallback(
    (op: MontagePendingOp) => {
      localQueueDirtyRef.current = true;
      setPendingOps((prev) => {
        const next = [...prev, op];
        pendingOpsRef.current = next;
        persistQueue(next);
        return next;
      });
      toastQueued("Операция в очереди — нажмите «Применить правки»");
    },
    [persistQueue],
  );

  const queueCoverageAndRegen = useCallback(
    (coverageOp: MontagePendingOp, regen: "ai" | "same" | "none") => {
      localQueueDirtyRef.current = true;
      setPendingOps((prev) => {
        const frameNumber = coverageOp.frame_number;
        let next = prev.filter(
          (x) => !(x.frame_number === frameNumber && x.type === coverageOp.type),
        );
        if (coverageOp.type === "coverage_delete") {
          next = next.filter(
            (x) =>
              !(
                x.frame_number === frameNumber &&
                (String(x.type).startsWith("image_") ||
                  String(x.type).startsWith("coverage_"))
              ),
          );
        }
        next = [...next, coverageOp];
        if (regen !== "none") {
          next = next.filter(
            (x) =>
              !(
                x.frame_number === frameNumber &&
                x.shot === 1 &&
                String(x.type).startsWith("image_")
              ),
          );
          const fr = frames.find((f) => f.number === frameNumber);
          const pending = pendingCoverageForFrame(next, frameNumber);
          const imageOp: MontagePendingOp =
            regen === "ai"
              ? {
                  type: "image_ai_change",
                  frame_number: frameNumber,
                  shot: 1,
                  correction: coverageCorrection(pending, fr),
                }
              : {
                  type: "image_regen",
                  frame_number: frameNumber,
                  shot: 1,
                };
          next = [...next, imageOp];
        }
        pendingOpsRef.current = next;
        persistQueue(next);
        return next;
      });
      toastQueued("Операция в очереди — нажмите «Применить правки»");
    },
    [persistQueue, frames],
  );

  const applyCoverageNow = useCallback(
    async (ops: MontagePendingOp[]) => {
      if (!ops.length || projectId == null) return;
      const visualTypes = new Set([
        "coverage_template",
        "coverage_plan",
        "coverage_action",
        "coverage_angle",
        "coverage_move",
        "coverage_light",
        "coverage_set",
        "coverage_sense",
        "coverage_visual_type",
        "coverage_place",
        "coverage_characters",
        "coverage_props",
        "coverage_bg",
        "coverage_accent",
        "coverage_feature",
      ]);
      const needsImage = ops.some((o) => visualTypes.has(String(o.type)));
      const numbers = [...new Set(ops.map((o) => o.frame_number))];
      const changedTypes = new Set(ops.map((o) => String(o.type)));
      setFrameEditBusy(true);
      try {
        for (const op of ops) {
          await api.applyMontageCoverage(projectId, op);
        }
        localQueueDirtyRef.current = true;
        setPendingOps((prev) => {
          let next = queueAfterCoverageApply(prev, numbers, changedTypes);
          if (needsImage) {
            for (const frameNumber of numbers) {
              next = next.filter(
                (x) =>
                  !(
                    x.frame_number === frameNumber &&
                    x.shot === 1 &&
                    String(x.type).startsWith("image_")
                  ),
              );
              const fr = frames.find((f) => f.number === frameNumber);
              const pending = pendingCoverageForFrame(
                [...next, ...ops.filter((o) => o.frame_number === frameNumber)],
                frameNumber,
              );
              next = [
                ...next,
                {
                  type: "image_ai_change",
                  frame_number: frameNumber,
                  shot: 1,
                  correction: coverageCorrection(pending, fr),
                },
              ];
            }
          }
          pendingOpsRef.current = next;
          persistQueue(next);
          return next;
        });
        void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
        toast.success(
          needsImage
            ? `Кадр #${numbers[0]}: записано · картинка в «Применить правки»`
            : ops[0].type === "coverage_anchors"
              ? "Якоря записаны"
              : `Кадр #${numbers[0]}: записано`,
        );
      } catch (err) {
        toast.error(errorMessageFromUnknown(err));
      } finally {
        setFrameEditBusy(false);
      }
    },
    [frames, persistQueue, projectId, queryClient],
  );

  /** Настройки пишутся сразу. В очередь — только картинка, если смысл кадра сменился. */
  const queueSceneOps = useCallback(
    (ops: MontagePendingOp[]) => {
      void applyCoverageNow(ops);
    },
    [applyCoverageNow],
  );

  const toggleOpSelected = useCallback((key: string) => {
    setSelectedOpKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAllPending = useCallback(() => {
    setSelectedOpKeys(new Set(pendingOpsRef.current.map(opSelectKey)));
  }, []);

  const cancelSelectedOps = useCallback(() => {
    if (selectedOpKeys.size === 0) return;
    localQueueDirtyRef.current = true;
    setPendingOps((prev) => {
      const next = prev.filter((op) => !selectedOpKeys.has(opSelectKey(op)));
      pendingOpsRef.current = next;
      persistQueue(next);
      return next;
    });
    setSelectedOpKeys(new Set());
    toastQueued("Выбранные правки сняты с очереди");
  }, [persistQueue, selectedOpKeys]);

  const openAiChangeModal = useCallback(
    (kind: "image" | "video", frameNumber: number, shot: 1 | 2) => {
      const remembered =
        projectId != null
          ? readMontageAiChangeText(projectId, kind, frameNumber, shot)
          : "";
      const fromQueue = lastAiInstruction(
        pendingOpsRef.current,
        kind,
        frameNumber,
        shot,
      );
      setAiChangeModal({
        kind,
        frameNumber,
        shot,
        initialText: remembered || fromQueue,
      });
    },
    [projectId],
  );

  const queueAiChange = useCallback(
    (kind: "image" | "video", frameNumber: number, shot: 1 | 2, instruction?: string) => {
      const op: MontagePendingOp =
        kind === "image"
          ? {
              type: "image_ai_change",
              frame_number: frameNumber,
              shot,
              ...(instruction ? { instruction } : {}),
            }
          : {
              type: "video_ai_change",
              frame_number: frameNumber,
              shot,
              ...(instruction ? { instruction } : {}),
            };
      queueOp(op);
    },
    [queueOp],
  );

  const applyMutation = useMutation({
    mutationFn: (opts?: { frameNumbers?: number[] }) => {
      const all = pendingOpsRef.current;
      const ops = montageOpsToApply(all, opts?.frameNumbers);
      sentApplyKeysRef.current = ops.map(opSelectKey);
      const wanted = opts?.frameNumbers?.length ? new Set(opts.frameNumbers) : null;
      const frameNs = [...new Set(ops.map((op) => op.frame_number))];
      if (ops.length > 0) {
        toast.message(
          wanted
            ? `Кадр #${[...wanted].join(", #")}…`
            : `Правки: ${frameNs.length} ${framesWord(frameNs.length)}… (VIA Render)`,
        );
      }
      return api.applyMontageBoard(projectId!, {
        video_trims: trims,
        pending_ops: ops,
        ...(frameNs.length ? { frame_numbers: frameNs } : {}),
      });
    },
    onSuccess: (res) => {
      const sent = new Set(sentApplyKeysRef.current);
      const queued = sent.size;
      const keepUnsent = (list: MontagePendingOp[]) =>
        queueAfterApply(list, sent, opSelectKey);
      if (res.started) {
        submittedApplyRef.current = true;
        trimsDirtyRef.current = false;
        if (queueSaveTimerRef.current) {
          clearTimeout(queueSaveTimerRef.current);
          queueSaveTimerRef.current = null;
        }
        const keep = keepUnsent(pendingOpsRef.current);
        localQueueDirtyRef.current = keep.length > 0;
        pendingOpsRef.current = keep;
        setPendingOps(keep);
        setSelectedOpKeys((prev) => {
          const live = new Set(keep.map(opSelectKey));
          return new Set([...prev].filter((k) => live.has(k)));
        });
        setFailedHighlights([]);
        applySeenRunningRef.current = true;
        lastPatchedPathRef.current = "";
        setApplyRunningNow(true);
        queueMicrotask(restoreDocumentPointerEvents);
        lastApplyToastKeyRef.current = "";
        toast.message(res.message || `Генерация ${queued} операций через API…`);
        return;
      }
      if (res.already_running) {
        // Чужой/текущий job — НЕ чистим локальную очередь пользователя.
        applySeenRunningRef.current = true;
        setApplyRunningNow(true);
        queueMicrotask(restoreDocumentPointerEvents);
        toast.message("Генерация уже выполняется");
        return;
      }
      submittedApplyRef.current = false;
      trimsDirtyRef.current = false;
      const keep = keepUnsent(pendingOpsRef.current);
      localQueueDirtyRef.current = keep.length > 0;
      pendingOpsRef.current = keep;
      setPendingOps(keep);
      setSelectedOpKeys((prev) => {
        const live = new Set(keep.map(opSelectKey));
        return new Set([...prev].filter((k) => live.has(k)));
      });
      if (res.meta) {
        setHighlights(res.meta.highlights ?? []);
        setFailedHighlights(res.meta.failed_highlights ?? []);
        setStaleVideos(res.meta.stale_videos ?? []);
        if (res.meta.video_trims) {
          setTrims(mergeTrimsFromMeta(frames, res.meta.video_trims));
        }
        const restored = parsePendingOps(res.meta.pending_ops);
        if (restored.length > 0) {
          const seen = new Set(keep.map(opSelectKey));
          const extra = restored.filter((op) => !seen.has(opSelectKey(op)));
          const next = [...keep, ...extra];
          pendingOpsRef.current = next;
          setPendingOps(next);
        }
      }
      void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
      if (!res.ok && res.errors?.length) {
        toast.error(res.errors.join("; "));
        return;
      }
      if (queued === 0) {
        toast.success("Trim сохранён");
      } else {
        // Фоновый job должен вернуть started/already_running. Иначе не врём «завершено».
        toast.message(res.message || "Генерация принята — ждём статус…");
        applySeenRunningRef.current = true;
        setApplyRunningNow(true);
        queueMicrotask(restoreDocumentPointerEvents);
      }
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const montageMutation = useMutation({
    mutationFn: () => api.runMontageBoard(projectId!),
    onSuccess: (res) => {
      if (res.already_running) {
        toast.message("Монтаж уже выполняется");
        setMontageRunning(true);
        return;
      }
      if (res.started) {
        lastMontageToastKeyRef.current = "";
        setMontageRunning(true);
        toast.message("Монтаж запущен в фоне");
      }
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const recoverOutseeMutation = useMutation({
    mutationFn: () => api.recoverMontageFromOutsee(projectId!),
    onSuccess: (res) => {
      if (res.started || res.already_running || res.job?.status === "running") {
        lastRecoverToastKeyRef.current = "";
        setRecoverRunning(true);
        toast.message(res.message || "Забираем правки из генератора…");
        return;
      }
      // Совместимость со старым синхронным ответом (если бэкенд ещё не обновлён).
      const n = res.saved_count ?? res.saved?.length ?? 0;
      if (n > 0) {
        toast.success(`Забрано и заменено из генератора: ${n} кадр(ов)`);
        localQueueDirtyRef.current = false;
        setPendingOps([]);
      } else if (res.errors?.length) {
        toast.error(res.errors.join("; "));
      } else {
        toast.message(
          `В истории генератора нет карточек для выделенных правок (просмотрено ${res.hits_scanned ?? 0})`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  useEffect(() => {
    if (!open || projectId == null) return;
    void api.getMontageBoardStatus(projectId).then((st) => {
      if (st.job?.status === "running") setMontageRunning(true);
    }).catch(() => {});
    void api.getMontageApplyStatus(projectId).then((st) => {
      if (st.job?.status === "running") {
        applySeenRunningRef.current = true;
        setApplyRunningNow(true);
      }
    }).catch(() => {});
    void api.getMontageRecoverOutseeStatus(projectId).then((st) => {
      if (st.job?.status === "running") setRecoverRunning(true);
    }).catch(() => {});
  }, [open, projectId]);

  const handleApplyTerminal = useCallback(
    (status: string, errText?: string, progressKey?: string) => {
      // Тост дедупим; invalidate/highlights — всегда (иначе повторный done:
      // ключ "done:" совпадает с прошлым прогоном → зелёная подсветка не подтягивается).
      const toastKey = `${status}:${errText || ""}:${progressKey || ""}`;
      const showToast = lastApplyToastKeyRef.current !== toastKey;
      if (showToast) lastApplyToastKeyRef.current = toastKey;

      const keepLocal =
        localQueueDirtyRef.current && pendingOpsRef.current.length > 0;
      const localKept = keepLocal ? [...pendingOpsRef.current] : [];
      applySeenRunningRef.current = false;
      setApplyRunningNow(false);
      setApplyProgress(null);
      restoreDocumentPointerEvents();
      if (submittedApplyRef.current) submittedApplyRef.current = false;
      if (showToast) {
        if (status === "done") toast.success("Генерация завершена");
        else if (status === "error") toast.error(errText || "Генерация не удалась");
        else if (status === "cancelled") toast.message("Генерация остановлена");
      }
      // Без resetQueries: доска остаётся на экране (скролл, открытые клетки),
      // данные подменяются, когда придёт ответ.
      void queryClient
        .fetchQuery({
          queryKey: ["montage-board", projectId],
          queryFn: () => api.getMontageBoard(projectId!),
          staleTime: 0,
        })
        .then((data) => {
          const hl = data?.meta?.highlights;
          if (Array.isArray(hl)) setHighlights(hl.map(String));
          const failed = data?.meta?.failed_highlights;
          if (Array.isArray(failed)) setFailedHighlights(failed.map(String));
          const stale = data?.meta?.stale_videos;
          if (Array.isArray(stale)) setStaleVideos(stale.map(String));
          const restored = parsePendingOps(data?.meta?.pending_ops);
          const applied = new Set<string>([
            ...sentApplyKeysRef.current,
            ...jobAppliedOpsRef.current.map(opSelectKey),
          ]);
          const base = keepLocal ? localKept : pendingOpsRef.current;
          const next = reconcileIdleQueue(base, restored, opSelectKey, applied);
          const changed =
            JSON.stringify(next) !== JSON.stringify(pendingOpsRef.current);
          pendingOpsRef.current = next;
          setPendingOps(next);
          if (keepLocal || (changed && applied.size > 0)) persistQueue(next, true);
        })
        .catch(() => {
          void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
        });
    },
    [projectId, queryClient, parsePendingOps, persistQueue],
  );

  const handleRecoverTerminal = useCallback(
    (status: string, errText?: string, savedCount?: number) => {
      const key = `${status}:${errText || ""}:${savedCount ?? ""}`;
      if (lastRecoverToastKeyRef.current === key) return;
      lastRecoverToastKeyRef.current = key;
      setRecoverRunning(false);
      const n = savedCount ?? 0;
      if (status === "done" && n > 0) {
        toast.success(`Забрано и заменено из генератора: ${n} кадр(ов)`);
        localQueueDirtyRef.current = false;
        setPendingOps([]);
      } else if (status === "done") {
        toast.message(errText || "В истории генератора нет подходящих карточек");
      } else if (status === "error") {
        toast.error(errText || "Не удалось забрать из генератора");
      } else if (status === "cancelled") {
        toast.message("Забор из генератора остановлен");
      }
      void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
    },
    [projectId, queryClient],
  );

  const handleMontageTerminal = useCallback(
    (status: string, errText?: string) => {
      const key = `${status}:${errText || ""}`;
      if (lastMontageToastKeyRef.current === key) return;
      lastMontageToastKeyRef.current = key;
      setMontageRunning(false);
      if (status === "done") {
        toast.success("Монтаж завершён");
        void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
      } else if (status === "error") toast.error(errText || "Монтаж не удался");
      else if (status === "cancelled") toast.message("Монтаж остановлен");
    },
    [projectId, queryClient],
  );

  useEffect(() => {
    if (!open || projectId == null) return;
    return subscribeWS(`projects.${projectId}`, (raw) => {
      const evt = raw as {
        type?: string;
        payload?: {
          stopped?: boolean;
          montage_board_montage?: boolean;
          montage_board_apply?: boolean;
          montage_outsee_recover?: boolean;
          status?: string;
          errors?: string[];
          error?: string;
          done_ops?: number;
          total_ops?: number;
          saved_count?: number;
          refresh_board?: boolean;
          montage_scene_action_generate?: boolean;
          montage_scenes_split?: boolean;
          montage_scenes_merged?: boolean;
          highlight?: string;
          frame_number?: number;
          shot?: number;
          path?: string;
        };
      };
      if (evt.payload?.montage_scene_action_generate) {
        void queryClient.invalidateQueries({
          queryKey: ["montage-board", projectId],
        });
      }
      if (evt.payload?.montage_scenes_split || evt.payload?.montage_scenes_merged) {
        void queryClient.invalidateQueries({
          queryKey: ["montage-board", projectId],
        });
      }
      if (evt.payload?.stopped) {
        setMontageRunning(false);
        setApplyRunningNow(false);
        setRecoverRunning(false);
        setApplyProgress(null);
        applySeenRunningRef.current = false;
        restoreDocumentPointerEvents();
        return;
      }
      if (evt.payload?.montage_outsee_recover) {
        const status = evt.payload.status;
        if (status === "running") {
          setRecoverRunning(true);
          lastRecoverToastKeyRef.current = "";
        } else if (status === "done" || status === "error" || status === "cancelled") {
          handleRecoverTerminal(
            status,
            evt.payload.error ||
              (Array.isArray(evt.payload.errors)
                ? evt.payload.errors.join("; ")
                : undefined),
            typeof evt.payload.saved_count === "number"
              ? evt.payload.saved_count
              : undefined,
          );
        }
        return;
      }
      if (evt.payload?.montage_board_apply) {
        const status = evt.payload.status;
        const doneOps = evt.payload.done_ops as number | undefined;
        const totalOps = evt.payload.total_ops as number | undefined;
        if (status === "running") {
          applySeenRunningRef.current = true;
          setApplyRunningNow(true);
          if (typeof doneOps === "number" && typeof totalOps === "number") {
            startTransition(() => {
              setApplyProgress({ done: doneOps, total: totalOps });
            });
          }
          const hl = evt.payload.highlight;
          if (typeof hl === "string" && hl) {
            setHighlights((prev) => (prev.includes(hl) ? prev : [...prev, hl]));
            setFailedHighlights((prev) => prev.filter((k) => k !== hl));
          }
          // Сразу подменить превью кадра из path — полный refetch доски слишком редкий/тяжёлый.
          const absPath = evt.payload.path;
          const frNum = Number(evt.payload.frame_number);
          const shotRaw = Number(evt.payload.shot);
          const shot: 1 | 2 = shotRaw === 2 ? 2 : 1;
          if (
            typeof absPath === "string" &&
            absPath &&
            Number.isFinite(frNum) &&
            frNum >= 1 &&
            typeof hl === "string" &&
            hl
          ) {
            queryClient.setQueryData<MontageBoardDTO>(
              ["montage-board", projectId],
              (old) =>
                old
                  ? patchBoardFrameMedia(old, frNum, shot, absPath, hl)
                  : old,
            );
          } else if (evt.payload.refresh_board) {
            void queryClient.invalidateQueries({
              queryKey: ["montage-board", projectId],
            });
          }
        } else if (status === "done" || status === "error" || status === "cancelled") {
          if (
            !applySeenRunningRef.current &&
            !applyRunningRef.current &&
            status !== "cancelled"
          ) {
            return;
          }
          const err =
            evt.payload.error ||
            (Array.isArray(evt.payload.errors) ? evt.payload.errors.join("; ") : undefined);
          const pk =
            typeof evt.payload.done_ops === "number" &&
            typeof evt.payload.total_ops === "number"
              ? `${evt.payload.done_ops}/${evt.payload.total_ops}`
              : undefined;
          handleApplyTerminal(status, err, pk);
        }
        return;
      }
      if (!evt.payload?.montage_board_montage) return;
      const status = evt.payload.status;
      if (status === "running") {
        setMontageRunning(true);
        lastMontageToastKeyRef.current = "";
      } else if (status === "done" || status === "error" || status === "cancelled") {
        handleMontageTerminal(status, evt.payload.error);
      }
    });
  }, [open, projectId, queryClient, handleApplyTerminal, handleMontageTerminal, handleRecoverTerminal]);

  useEffect(() => {
    if (!open || projectId == null || !montageRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await api.getMontageBoardStatus(projectId);
        const status = st.job?.status;
        if (cancelled) return;
        if (status === "running" || !status) return;
        handleMontageTerminal(status, st.job?.error || undefined);
      } catch {
        // Сетевой сбой — не сбрасываем running, ждём следующий poll.
      }
    };
    const id = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, projectId, montageRunning, handleMontageTerminal]);

  useEffect(() => {
    if (!open || projectId == null || !applyRunning) return;
    let cancelled = false;
    let lastDone = -1;
    const poll = async () => {
      try {
        const st = await api.getMontageApplyStatus(projectId);
        const status = st.job?.status;
        const doneOps = st.job?.done_ops;
        const totalOps = st.job?.total_ops;
        if (cancelled) return;
        if (Array.isArray(st.job?.pending_ops)) {
          jobAppliedOpsRef.current = st.job.pending_ops as MontagePendingOp[];
        }
        if (status === "running") {
          applySeenRunningRef.current = true;
          if (typeof doneOps === "number" && typeof totalOps === "number") {
            if (doneOps !== lastDone) {
              lastDone = doneOps;
              startTransition(() => {
                setApplyProgress({ done: doneOps, total: totalOps });
              });
            }
          }
          // WS может не дойти — подменяем превью из apply-status.
          const lastPath = st.job?.last_path;
          const lastHl = st.job?.last_highlight;
          const lastFr = Number(st.job?.last_frame_number);
          const lastShot: 1 | 2 = Number(st.job?.last_shot) === 2 ? 2 : 1;
          if (
            typeof lastPath === "string" &&
            lastPath &&
            lastPath !== lastPatchedPathRef.current &&
            typeof lastHl === "string" &&
            lastHl &&
            Number.isFinite(lastFr) &&
            lastFr >= 1
          ) {
            lastPatchedPathRef.current = lastPath;
            queryClient.setQueryData<MontageBoardDTO>(
              ["montage-board", projectId],
              (old) =>
                old
                  ? patchBoardFrameMedia(old, lastFr, lastShot, lastPath, lastHl)
                  : old,
            );
          }
          return;
        }
        // Этот эффект живёт только пока applyRunning: idle/пусто = job уже кончился.
        // Раньше ждали «видели running» и при быстром coverage кнопки оставались disabled.
        if (!status || status === "idle") {
          handleApplyTerminal("done");
          return;
        }
        const pk =
          typeof doneOps === "number" && typeof totalOps === "number"
            ? `${doneOps}/${totalOps}`
            : undefined;
        handleApplyTerminal(status, st.job?.error || undefined, pk);
      } catch {
        // Сетевой сбой — не сбрасываем running.
      }
    };
    const id = window.setInterval(() => void poll(), 2500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, projectId, applyRunning, handleApplyTerminal, queryClient]);

  useEffect(() => {
    if (!open) return;
    restoreDocumentPointerEvents();
  }, [open]);

  useEffect(() => {
    if (!applyRunning) restoreDocumentPointerEvents();
  }, [applyRunning]);

  useEffect(() => {
    if (!open || projectId == null || !recoverRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await api.getMontageRecoverOutseeStatus(projectId);
        const status = st.job?.status;
        if (cancelled) return;
        if (status === "running" || !status) return;
        handleRecoverTerminal(
          status,
          st.job?.error || undefined,
          typeof st.job?.saved_count === "number" ? st.job.saved_count : undefined,
        );
      } catch {
        // Сетевой сбой — не сбрасываем running.
      }
    };
    const id = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, projectId, recoverRunning, handleRecoverTerminal]);

  const refreshBoard = useCallback(() => {
    void board.refetch();
  }, [board]);

  const handleSaveVoiceover = async (frameId: number, text: string) => {
    if (!projectId) return;
    await api.setMontageVoiceover(projectId, frameId, text);
    refreshBoard();
    toast.success("Закадр сохранён");
  };

  const handleRestoreFrame = async (fr: MontageBoardFrame) => {
    if (!projectId) return;
    setFrameEditBusy(true);
    try {
      await api.restoreMontageFrame(projectId, fr.frame_id);
      refreshBoard();
      toast.success(`Кадр #${fr.number} снова в ленте`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const handleDeleteFrame = async (fr: MontageBoardFrame) => {
    if (!projectId) return;
    const ok = window.confirm(
      // Бэкенд удаляет строку кадра с текстами и промтами (montage_board_frames.delete_montage_frame);
      // картинка и клип уходят в old/scenes. Ручки «вернуть» нет — обещать возврат нельзя.
      `Удалить кадр #${fr.number}? Его тексты и промты удалятся, картинка и клип уйдут в папку old/scenes проекта.`,
    );
    if (!ok) return;
    setFrameEditBusy(true);
    try {
      localQueueDirtyRef.current = true;
      const next = pendingOpsRef.current.filter(
        (op) =>
          op.frame_number !== fr.number &&
          op.parent_number !== fr.number,
      );
      pendingOpsRef.current = next;
      setPendingOps(next);
      persistQueue(next, true);
      await api.deleteMontageFrame(projectId, fr.frame_id);
      refreshBoard();
      toast.success(`Кадр #${fr.number} удалён. Картинка и клип лежат в old/scenes.`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const handleInsertFrame = async (voiceover: string) => {
    if (!projectId || !addFrame) return;
    setFrameEditBusy(true);
    try {
      const res = await api.insertMontageFrame(
        projectId,
        addFrame.afterFrameId,
        voiceover,
        addFrame.kind,
      );
      setAddFrame(null);
      refreshBoard();
      toast.success(`Кадр #${res.number} добавлен`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const mergeScenesAt = async (left: MontageBoardFrame, right: MontageBoardFrame) => {
    if (!projectId) return;
    const ok = window.confirm(
      `Объединить ячейки #${left.number} и #${right.number} в одну сцену?`,
    );
    if (!ok) return;
    setFrameEditBusy(true);
    try {
      const res = await api.mergeMontageScenes(
        projectId,
        left.frame_id,
        right.frame_id,
      );
      refreshBoard();
      toast.success(
        `Сцена #${res.parent_number}: ${res.vo_scene_size} кадров`,
      );
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const splitSceneAt = async (
    frame: MontageBoardFrame,
    sceneFrameIds: number[],
  ) => {
    if (!projectId) return;
    const ok = window.confirm(
      `Отделить кадр #${frame.number} и все правее в новую сцену?`,
    );
    if (!ok) return;
    setFrameEditBusy(true);
    try {
      const res = await api.splitMontageScene(
        projectId,
        frame.frame_id,
        false,
        sceneFrameIds,
      );
      refreshBoard();
      toast.success(
        `Сцены #${res.left_number} (${res.left_size}) и #${res.right_number} (${res.right_size})`,
      );
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const splitSceneAll = async (head: MontageBoardFrame, sceneFrameIds: number[]) => {
    if (!projectId) return;
    const ok = window.confirm(
      `Разделить сцену #${head.number} на ${sceneFrameIds.length} отдельных сцен? Каждый кадр станет своей ячейкой закадра.`,
    );
    if (!ok) return;
    setFrameEditBusy(true);
    try {
      const res = await api.splitMontageScene(
        projectId,
        head.frame_id,
        true,
        sceneFrameIds,
      );
      refreshBoard();
      toast.success(`Сцена разделена на ${res.scenes} ячеек`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const insertChildAfter = async (afterFrameId: number) => {
    if (!projectId) return;
    setFrameEditBusy(true);
    try {
      const res = await api.insertMontageFrame(projectId, afterFrameId, "", "child");
      refreshBoard();
      toast.success(`Кадр #${res.number} вставлен в сцену`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setFrameEditBusy(false);
    }
  };

  const addFrameLabel = (() => {
    if (!addFrame) return "";
    if (addFrame.afterFrameId == null) return "в начало ленты";
    const n = frames.find((f) => f.frame_id === addFrame.afterFrameId)?.number;
    return n != null ? `после #${n}` : "в ленту";
  })();

  const handleDeleteImage = async (
    frameNumber: number,
    shot: 1 | 2,
    slot?: "parent",
  ) => {
    if (!projectId) return;
    try {
      await api.deleteMontageImage(projectId, frameNumber, shot, slot);
      setStaleVideos((prev) =>
        prev.includes(trimKey(frameNumber, shot)) ? prev : [...prev, trimKey(frameNumber, shot)],
      );
      refreshBoard();
      toast.success("Изображение удалено");
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    }
  };

  const handleMoveImage = async (from: ImageSlotRef, to: ImageSlotRef) => {
    if (!projectId || moveImageBusy) return;
    if (
      from.frameNumber === to.frameNumber &&
      from.shot === to.shot &&
      (from.slot || "") === (to.slot || "")
    )
      return;
    setMoveImageBusy(true);
    try {
      const res = await api.moveMontageImage(
        projectId,
        from.frameNumber,
        from.shot,
        to.frameNumber,
        to.shot,
        from.slot,
        to.slot,
      );
      setStaleVideos((prev) => {
        const next = new Set(prev);
        next.add(trimKey(from.frameNumber, from.shot));
        next.add(trimKey(to.frameNumber, to.shot));
        return [...next];
      });
      refreshBoard();
      toast.success(
        res.mode === "move"
          ? `Картинка → #${to.frameNumber} shot${to.shot}`
          : `Обмен #${from.frameNumber}.${from.shot} ↔ #${to.frameNumber}.${to.shot}`,
      );
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setMoveImageBusy(false);
    }
  };

  const handleDeleteVideo = async (frameNumber: number, shot: 1 | 2) => {
    if (!projectId) return;
    try {
      await api.deleteMontageVideo(projectId, frameNumber, shot);
      refreshBoard();
      toast.success("Видео удалено");
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    }
  };

  const handleUploadImage = async (
    frameNumber: number,
    shot: 1 | 2,
    file: File,
    slot?: "parent",
  ) => {
    if (!projectId) return;
    try {
      await api.uploadMontageImage(projectId, frameNumber, shot, file, slot);
      setStaleVideos((prev) =>
        prev.includes(trimKey(frameNumber, shot)) ? prev : [...prev, trimKey(frameNumber, shot)],
      );
      refreshBoard();
      toast.success("Изображение загружено");
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    }
  };

  const handleUploadVideo = async (frameNumber: number, shot: 1 | 2, file: File) => {
    if (!projectId) return;
    try {
      await api.uploadMontageVideo(projectId, frameNumber, shot, file);
      setStaleVideos((prev) => prev.filter((k) => k !== trimKey(frameNumber, shot)));
      refreshBoard();
      toast.success("Видео загружено");
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    }
  };

  const isSwapSelected = (kind: "image" | "video", frameNumber: number, shot: 1 | 2) =>
    swapPick?.kind === kind &&
    swapPick.frameNumber === frameNumber &&
    swapPick.shot === shot;

  const handleSwapPick = async (slot: SwapSlotPick) => {
    if (!projectId || swapBusy) return;
    if (!swapPick) {
      setSwapPick(slot);
      toast.message(
        slot.kind === "image"
          ? `Выбрано изображение #${slot.frameNumber}.${slot.shot} — нажмите ↔ на другом`
          : `Выбрано видео #${slot.frameNumber}.${slot.shot} — нажмите ↔ на другом`,
      );
      return;
    }
    if (
      swapPick.kind === slot.kind &&
      swapPick.frameNumber === slot.frameNumber &&
      swapPick.shot === slot.shot
    ) {
      setSwapPick(null);
      return;
    }
    if (swapPick.kind !== slot.kind) {
      setSwapPick(slot);
      toast.message(
        slot.kind === "image"
          ? `Выбрано изображение #${slot.frameNumber}.${slot.shot} — нажмите ↔ на другом`
          : `Выбрано видео #${slot.frameNumber}.${slot.shot} — нажмите ↔ на другом`,
      );
      return;
    }
    setSwapBusy(true);
    try {
      const res = await api.swapMontageSlots(projectId, slot.kind, swapPick, slot);
      if (slot.kind === "video") {
        setTrims((prev) => {
          const k1 = trimKey(swapPick.frameNumber, swapPick.shot);
          const k2 = trimKey(slot.frameNumber, slot.shot);
          const t1 = prev[k1];
          const t2 = prev[k2];
          if (t1 == null && t2 == null) return prev;
          const next = { ...prev };
          if (t2 == null) delete next[k1];
          else next[k1] = t2;
          if (t1 == null) delete next[k2];
          else next[k2] = t1;
          return next;
        });
      }
      setStaleVideos((prev) => {
        const next = new Set(prev);
        next.add(trimKey(swapPick.frameNumber, swapPick.shot));
        next.add(trimKey(slot.frameNumber, slot.shot));
        return [...next];
      });
      setSwapPick(null);
      refreshBoard();
      const label = slot.kind === "image" ? "картинки" : "видео";
      toast.success(
        res.mode === "move"
          ? `${label}: перенос #${res.from_frame}.${res.from_shot} → #${res.to_frame}.${res.to_shot}`
          : `${label}: обмен #${swapPick.frameNumber}.${swapPick.shot} ↔ #${slot.frameNumber}.${slot.shot}`,
      );
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setSwapBusy(false);
    }
  };

  const sourcePromptFor = (
    kind: "image" | "video",
    frameNumber: number,
    shot: 1 | 2,
  ): string => {
    const fr = frames.find((f) => f.number === frameNumber);
    if (!fr) return "";
    if (kind === "image") {
      if (shot === 1) {
        return (
          (fr.image_prompt_shot1 || fr.layout_start || "")
        ).trim();
      }
      return (
        (fr.image_prompt_shot2 || fr.layout_end || "")
      ).trim();
    }
    return (
      (shot === 1 ? fr.animation_prompt_shot1 : fr.animation_prompt_shot2) ?? ""
    ).trim();
  };

  const openPromptModal = (
    kind: "image" | "video",
    frameNumber: number,
    shot: 1 | 2,
    mode: "prompt" | "correction",
  ) => {
    // В textarea сразу кладём промт исходника (Excel/БД) — его и редактируют.
    // Для correction: если есть сохранённая заметка — она, иначе тоже исходник.
    const source = sourcePromptFor(kind, frameNumber, shot);
    const correction = meta?.corrections?.[trimKey(frameNumber, shot)] ?? "";
    const initialText =
      mode === "correction" ? (correction.trim() || source) : source;
    setPromptModal({
      kind,
      frameNumber,
      shot,
      mode,
      title:
        mode === "correction"
          ? `Корректировка · кадр #${frameNumber} · ${kind === "image" ? "изображение" : "видео"} ${shot}`
          : `Промт · кадр #${frameNumber} · ${kind === "image" ? "изображение" : "видео"} ${shot}`,
      initialText,
    });
  };

  const submitPromptModal = (text: string) => {
    if (!promptModal) return;
    const { kind, frameNumber, shot, mode } = promptModal;
    let op: MontagePendingOp;
    if (mode === "correction" && kind === "image") {
      op = {
        type: "image_regen_correction",
        frame_number: frameNumber,
        shot,
        correction: text,
      };
    } else if (kind === "image") {
      op = {
        type: "image_regen_prompt",
        frame_number: frameNumber,
        shot,
        prompt: text,
      };
    } else {
      op = {
        type: "video_regen_prompt",
        frame_number: frameNumber,
        shot,
        prompt: text,
      };
    }
    setPromptModal(null);
    queueOp(op);
  };

  // ── Действия картинки шота (режим «колонка = шот») ───────────────────────
  // У шота своя ручка в плане: и промт, и перерисовка идут по shot_id, а не
  // через очередь кадра. Ошибку показываем тостом, занятость — по ячейке.
  const shotBusyId = (frameNumber: number, shotId: string) =>
    `${frameNumber}:${shotId}`;

  const runShotAction = async (
    frameNumber: number,
    shotId: string,
    action: () => Promise<unknown>,
    okText: string,
  ) => {
    if (projectId == null || !shotId) return;
    const key = shotBusyId(frameNumber, shotId);
    setShotBusyKey(key);
    try {
      await action();
      toast.success(okText);
      await board.refetch();
    } catch (error) {
      toast.error(errorMessageFromUnknown(error));
    } finally {
      setShotBusyKey((current) => (current === key ? null : current));
    }
  };

  const regenShotImage = (frameNumber: number, shotId: string) => {
    if (projectId == null) return;
    void runShotAction(
      frameNumber,
      shotId,
      () => api.regenMontageShotImage(projectId, frameNumber, shotId),
      `Картинка шота ${shotId} перерисована`,
    );
  };

  const uploadShotImage = (frameNumber: number, shotId: string, file: File) => {
    if (projectId == null) return;
    void runShotAction(
      frameNumber,
      shotId,
      () => api.uploadMontageShotImage(projectId, frameNumber, shotId, file),
      `Картинка шота ${shotId} загружена`,
    );
  };

  const deleteShotImage = (frameNumber: number, shotId: string) => {
    if (projectId == null) return;
    void runShotAction(
      frameNumber,
      shotId,
      () => api.deleteMontageShotImage(projectId, frameNumber, shotId),
      `Картинка шота ${shotId} удалена`,
    );
  };

  const submitShotPrompt = (text: string) => {
    if (projectId == null || !shotPrompt) return;
    const { frameNumber, shotId } = shotPrompt;
    setShotPrompt(null);
    void runShotAction(
      frameNumber,
      shotId,
      () => api.saveMontageShotPrompt(projectId, frameNumber, shotId, text),
      `Промт шота ${shotId} сохранён`,
    );
  };

  const pendingSlotKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const op of pendingOps) {
      keys.add(slotKeyFromOp(op));
    }
    return keys;
  }, [pendingOps]);

  const failedSlotKeys = useMemo(() => new Set(failedHighlights), [failedHighlights]);
  const appliedSlotKeys = useMemo(() => new Set(highlights), [highlights]);

  const toneForSlot = useCallback(
    (key: string): SlotTone | undefined => {
      // failed > pending (доделать) > applied
      if (failedSlotKeys.has(key)) return "failed";
      if (pendingSlotKeys.has(key)) return "pending";
      if (appliedSlotKeys.has(key)) return "applied";
      return undefined;
    },
    [failedSlotKeys, pendingSlotKeys, appliedSlotKeys],
  );

  const pendingOnlyCount = useMemo(() => {
    let n = 0;
    for (const key of pendingSlotKeys) {
      if (!failedSlotKeys.has(key)) n += 1;
    }
    return n;
  }, [pendingSlotKeys, failedSlotKeys]);

  const pendingFrameNumbers = useMemo(
    () => pendingApplyFrameNumbers(pendingOps),
    [pendingOps],
  );

  const isStaleVideo = (frameNumber: number, shot: 1 | 2) =>
    staleVideos.includes(trimKey(frameNumber, shot));

  const tableWidthPx = useMemo(() => {
    const rowLabel = 11 * 16;
    if (shotMode) {
      // Режим шотов: ширина = подпись + колонка на каждый шот (зазоров нет).
      return (
        rowLabel +
        shotUnits.reduce((sum, unit) => sum + framePairRem(unit.frame, colRem) * 16, 0)
      );
    }
    const sceneGap = SCENE_GAP_REM * 16;
    const shotGap = SHOT_GAP_REM * 16;
    const sceneGaps = frames.length > 0 ? ranges.length + 1 : 0;
    const shotGaps = ranges.reduce(
      (n, r) => n + Math.max(0, r.frames.length - 1),
      0,
    );
    const framePx = frames.reduce(
      (sum, fr) => sum + framePairRem(fr, colRem) * 16,
      0,
    );
    return rowLabel + framePx + sceneGaps * sceneGap + shotGaps * shotGap;
  }, [frames, ranges, colRem, shotMode, shotUnits]);

  const syncScrollLeft = useCallback((from: HTMLDivElement, to: HTMLDivElement) => {
    if (Math.abs(to.scrollLeft - from.scrollLeft) < 0.5) return;
    to.scrollLeft = from.scrollLeft;
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const tableWrap = tableScrollRef.current;
    const hBar = hBarRef.current;
    if (!tableWrap || !hBar) return;

    const onTable = () => syncScrollLeft(tableWrap, hBar);
    const onBar = () => syncScrollLeft(hBar, tableWrap);

    tableWrap.addEventListener("scroll", onTable, { passive: true });
    hBar.addEventListener("scroll", onBar, { passive: true });
    // Выровнять после mount (после close/reopen listeners иначе мертвы).
    hBar.scrollLeft = tableWrap.scrollLeft;
    return () => {
      tableWrap.removeEventListener("scroll", onTable);
      hBar.removeEventListener("scroll", onBar);
    };
  }, [open, frames.length, syncScrollLeft, tableWidthPx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (swapPick) {
        e.preventDefault();
        setSwapPick(null);
        return;
      }
      // Открытый диалог поверх доски (например «Переменные проекта») гасит
      // Esc сам; доску при этом закрывать не надо.
      if (!preview && !variablesOpen) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, preview, swapPick, variablesOpen]);

  const sceneDisabled = applyRunning || applyMutation.isPending || frameEditBusy;

  const applyKindNow = useCallback(
    async (
      frameNumber: number,
      nextKind: "parent" | "child",
      nextParent?: number | null,
    ) => {
      if (projectId == null) return;
      setKindOverride((prev) => ({ ...prev, [frameNumber]: nextKind }));
      try {
        const fallbackParent = frames.find((f) => f.number !== frameNumber)?.number;
        const parentNum =
          nextKind === "child"
            ? nextParent && nextParent !== frameNumber
              ? nextParent
              : fallbackParent
            : undefined;
        const res = await api.applyMontageCoverage(projectId, {
          type: "coverage_kind",
          frame_number: frameNumber,
          shot: 1,
          kind: nextKind,
          ...(parentNum ? { parent_number: parentNum } : {}),
        });
        queryClient.setQueryData<MontageBoardDTO>(
          ["montage-board", projectId],
          (old) => {
            if (!old) return old;
            if (res.frame) {
              return {
                ...old,
                frames: old.frames.map((row) =>
                  row.number === frameNumber ? { ...row, ...res.frame } : row,
                ),
              };
            }
            return {
              ...old,
              frames: old.frames.map((row) =>
                row.number === frameNumber
                  ? {
                      ...row,
                      shot_kind: res.shot_kind ?? nextKind,
                      shot_parent_number: res.shot_parent_number ?? null,
                      ref_parent: res.ref_parent ?? row.ref_parent,
                    }
                  : row,
              ),
            };
          },
        );
        setPendingOps((prev) => {
          const next = prev.filter(
            (x) => !(x.frame_number === frameNumber && x.type === "coverage_kind"),
          );
          pendingOpsRef.current = next;
          persistQueue(next);
          return next;
        });
        if (res.shot_kind === nextKind || res.frame?.shot_kind === nextKind) {
          setKindOverride((prev) => {
            const next = { ...prev };
            delete next[frameNumber];
            return next;
          });
        }
        toast.success(
          nextKind === "parent"
            ? `Кадр #${frameNumber}: родительский, still родителя снят`
            : `Кадр #${frameNumber}: дочерний`,
        );
      } catch (e) {
        setKindOverride((prev) => {
          const next = { ...prev };
          delete next[frameNumber];
          return next;
        });
        toast.error(errorMessageFromUnknown(e));
      }
    },
    [projectId, persistQueue, queryClient, frames],
  );

  const hasPendingType = useCallback(
    (frameNumber: number, type: MontagePendingOp["type"]) =>
      pendingOps.some((o) => o.frame_number === frameNumber && o.type === type),
    [pendingOps],
  );

  const parentChoicesFor = useCallback(
    (frameNumber: number) => {
      return frames
        .filter((f) => f.number !== frameNumber)
        .slice()
        .sort((a, b) => a.number - b.number)
        .map((f) => ({
          number: f.number,
          kind: f.shot_kind || "",
          vo: (f.voiceover_text || "").slice(0, 70),
        }));
    },
    [frames],
  );

  /** Одна правка = сразу в очередь: строки сцены не открывают отдельное окно. */
  const queueCoverage = useCallback(
    (op: MontagePendingOp) => queueSceneOps([op]),
    [queueSceneOps],
  );

  /** Клетка кадра для строк роль / крупность / ракурс / движение / стык / действие / якорь. */
  const renderSceneFrameCell = (key: RowKey, fr: MontageBoardFrame) => {
    const pending = pendingCoverageForFrame(pendingOps, fr.number);
    const base = { frame_number: fr.number, shot: 1 as const };
    if (key === "role") {
      if (pending.deleted) {
        return (
          <p className="text-[10px] leading-snug text-rose-200/80">
            кадр в очереди на удаление
          </p>
        );
      }
      const kind = effectiveShotKind(fr, pending, kindOverride[fr.number]);
      const parentNumber = pending.parent_number ?? fr.shot_parent_number ?? null;
      return (
        <RoleCell
          compact
          kind={kind}
          parentNumber={parentNumber}
          frameNumber={fr.number}
          parentChoices={parentChoicesFor(fr.number)}
          fallbackParentNumber={
            typeof fr.vo_scene_number === "number" &&
            fr.vo_scene_number > 0 &&
            fr.vo_scene_number !== fr.number
              ? fr.vo_scene_number
              : parentNumber
          }
          pending={hasPendingType(fr.number, "coverage_kind") || Boolean(kindOverride[fr.number])}
          disabled={sceneDisabled}
          onKind={(nextKind, nextParent) =>
            void applyKindNow(fr.number, nextKind, nextParent)
          }
          onDeleteChild={() => queueCoverage({ ...base, type: "coverage_delete" })}
        />
      );
    }
    if (key === "action") {
      return (
        <ActionCell
          projectId={projectId}
          frameId={fr.frame_id}
          value={(pending.action ?? fr.shot_action ?? "").trim()}
          plan={(pending.plan ?? fr.shot_plan ?? "").trim()}
          pending={hasPendingType(fr.number, "coverage_action")}
          disabled={frameEditBusy}
          onCommit={(action, plan) =>
            queueSceneOps([
              { ...base, type: "coverage_action", action },
              ...(plan ? [{ ...base, type: "coverage_plan" as const, plan }] : []),
            ])
          }
        />
      );
    }
    return null;
  };

  /** Ячейка строки в режиме шотов: колонка = один запланированный шот кадра. */
  const renderShotFrameCell = (key: RowKey, unit: ShotUnit): ReactNode => {
    const shot = unit.shot;
    if (!shot) return renderSceneFrameCell(key, unit.frame);
    if (key === "action") {
      const action = (shot.действие || "").trim();
      const meta = [shot.план, shot.где, shot.место].filter(Boolean).join(" · ");
      return (
        <div className="flex flex-col gap-1">
          <div className="whitespace-pre-wrap break-words text-[11px] leading-snug">
            {action || <span className="text-muted-foreground/40">—</span>}
          </div>
          {meta ? (
            <div className="font-mono text-[9px] leading-tight text-white/30">{meta}</div>
          ) : null}
        </div>
      );
    }
    if (key === "voiceover") {
      const vo = (shot.закадр || "").trim();
      return (
        <div className="whitespace-pre-wrap break-words text-[11px] leading-snug">
          {vo || <span className="text-muted-foreground/40">—</span>}
        </div>
      );
    }
    if (key === "image1") {
      const url = shot.image_url ?? null;
      const prompt = (shot.промт_картинки || "").trim();
      return (
        <div className="flex flex-col gap-1">
          {url ? (
            <button
              type="button"
              title={`Открыть ${shot.id || "шот"}`}
              onClick={() =>
                showPreview({
                  url,
                  kind: "image",
                  label: `${shot.id || "шот"} · кадр #${unit.frame.number}`,
                })
              }
              className="group block w-full overflow-hidden rounded-lg border border-white/10 bg-black"
              style={tallMediaStyle(frameAspect)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={shot.id || "шот"}
                loading="lazy"
                decoding="async"
                // object-contain: кадр показываем целиком, без обрезки по краям.
                className="h-full w-full object-contain transition group-hover:brightness-110"
              />
            </button>
          ) : (
            <div
              title={`${shot.id || "шот"}: кадр не сгенерирован`}
              style={tallMediaStyle(frameAspect)}
              className="flex items-center justify-center rounded-md border border-dashed border-white/10 bg-black/20 text-[10px] text-white/25"
            >
              нет кадра
            </div>
          )}
          <div className="flex items-center justify-between gap-1 font-mono text-[9px] leading-tight text-white/40">
            <span className="truncate">{shot.id || "шот"}</span>
            <span className="truncate">{shot.план || ""}</span>
          </div>
          {prompt ? (
            <details className="rounded border border-white/10 bg-black/30 px-1 py-0.5">
              <summary className="cursor-pointer list-none font-mono text-[9px] text-white/50 hover:text-white/80">
                промт картинки · {prompt.length} зн.
              </summary>
              <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-snug text-white/60">
                {prompt}
              </div>
            </details>
          ) : null}
          <ShotMediaBar
            busy={shotBusyKey === shotBusyId(unit.frame.number, shot.id || "")}
            onRegen={() => regenShotImage(unit.frame.number, shot.id || "")}
            onEditPrompt={() =>
              setShotPrompt({
                frameNumber: unit.frame.number,
                shotId: shot.id || "",
                initialText: prompt,
              })
            }
            onUpload={(file) =>
              uploadShotImage(unit.frame.number, shot.id || "", file)
            }
            onDelete={() => deleteShotImage(unit.frame.number, shot.id || "")}
          />
        </div>
      );
    }
    if (key === "timestamps") {
      const parts: string[] = [];
      const duration = Number(shot.длительность ?? 0);
      if (unit.timelineStart != null && unit.timelineEnd != null) {
        parts.push(`${unit.timelineStart}–${unit.timelineEnd} с`);
      }
      if (Number.isFinite(duration) && duration > 0) {
        parts.push(`длит ${duration} с`);
      }
      return (
        <div className="font-mono text-[10px] leading-tight text-white/40">
          {parts.length ? parts.map((x) => <div key={x}>{x}</div>) : "—"}
        </div>
      );
    }
    if (key === "video1" || key === "video2") {
      // Видео пока живёт на кадре, а не на шоте: в колонке шота пусто.
      return <div className="text-[10px] text-muted-foreground/30">—</div>;
    }
    return renderSceneFrameCell(key, unit.frame);
  };

  const applySceneActionNow = useCallback(
    (frameNumber: number, action: string) => {
      void applyCoverageNow([
        {
          type: "coverage_scene_action",
          frame_number: frameNumber,
          shot: 1,
          action,
        },
      ]);
    },
    [applyCoverageNow],
  );

  const afterSceneActionGenerate = useCallback(
    (
      frameNumber: number,
      frameNumbers: number[] = [frameNumber],
      types: Set<MontagePendingOp["type"]> = SCENE_GENERATE_CLEAR_TYPES,
    ) => {
      localQueueDirtyRef.current = true;
      const numbers = new Set([frameNumber, ...frameNumbers]);
      const next = pendingOpsRef.current.filter(
        (x) => !(numbers.has(x.frame_number) && types.has(x.type)),
      );
      pendingOpsRef.current = next;
      persistQueue(next);
      setPendingOps(next);
      void queryClient.invalidateQueries({ queryKey: ["montage-board", projectId] });
    },
    [persistQueue, projectId, queryClient],
  );

  const improveSceneNow = useCallback(
    async (
      frameId: number,
      frameNumber: number,
      prompt: string,
      anchors: MontageAnchorRow[],
      frameNumbers: number[],
    ): Promise<MontageImproveReport | undefined> => {
      if (projectId == null) return undefined;
      setFrameEditBusy(true);
      try {
        toast.message("Сцена идёт через 3 ноды: действие → кадры → QC…");
        const res = await api.improveScene(projectId, frameId, {
          prompt,
          anchors: anchors
            .filter((r) => (r["якорь"] || "").trim())
            .map((r) => ({
              "якорь": r["якорь"],
              "изменение": r["изменение"] || "",
              "главный": Boolean(r["главный"]),
            })),
        });
        afterSceneActionGenerate(frameNumber, frameNumbers, SCENE_IMPROVE_CLEAR_TYPES);
        const extra = Number(res.inserted_frames || 0);
        const live = frames.filter(
          (fr) => frameNumbers.includes(fr.number) && !fr.shot_leftover,
        );
        const apiOps = Array.isArray(res.image_ops)
          ? (res.image_ops.filter(
              (op) =>
                op &&
                typeof op === "object" &&
                String(op.type || "").startsWith("image_"),
            ) as MontagePendingOp[])
          : [];
        const ops = apiOps.length ? apiOps : sceneImageOpsForFrames(live, prompt);
        if (ops.length) {
          const numbers = [
            ...new Set(ops.map((op) => Number(op.frame_number))),
          ].filter((n) => n >= 1);
          localQueueDirtyRef.current = true;
          setPendingOps((prev) => {
            const next = [
              ...prev.filter(
                (x) =>
                  !numbers.includes(x.frame_number) ||
                  !String(x.type).startsWith("image_"),
              ),
              ...ops,
            ];
            pendingOpsRef.current = next;
            persistQueue(next, true);
            return next;
          });
          toast.message(
            res.message ||
              `Сцена улучшена${extra ? ` · +${extra} кадров` : ""} · картинки: сцена → кадры`,
          );
          await applyMutation.mutateAsync({ frameNumbers: numbers });
        } else {
          toast.message(
            res.message || `Сцена улучшена${extra ? ` · +${extra} кадров` : ""}`,
          );
        }
        return res.improve_report;
      } catch (err) {
        toast.error(errorMessageFromUnknown(err));
        return undefined;
      } finally {
        setFrameEditBusy(false);
      }
    },
    [afterSceneActionGenerate, applyMutation, frames, persistQueue, projectId],
  );

  const generateSceneImagesNow = useCallback(
    async (range: SceneRange, scenePrompt?: string) => {
      if (projectId == null) return;
      const ops = sceneImageOpsForFrames(range.frames, scenePrompt);
      if (!ops.length) {
        toast.error("Нет живых кадров сцены для картинок");
        return;
      }
      const numbers = [...new Set(ops.map((op) => op.frame_number))];
      localQueueDirtyRef.current = true;
      setPendingOps((prev) => {
        const next = [
          ...prev.filter(
            (x) =>
              !numbers.includes(x.frame_number) ||
              !String(x.type).startsWith("image_"),
          ),
          ...ops,
        ];
        pendingOpsRef.current = next;
        persistQueue(next, true);
        return next;
      });
      await applyMutation.mutateAsync({ frameNumbers: numbers });
    },
    [applyMutation, persistQueue, projectId],
  );

  /** Клетка на всю VO-ячейку: последовательность кадров и якоря. */
  const renderSceneSpanCell = (key: RowKey, range: SceneRange) => {
    const head = range.frames[0];
    const tail = range.frames[range.frames.length - 1] ?? head;
    if (!head) return null;
    const pending = pendingCoverageForFrame(pendingOps, head.number);
    const base = { frame_number: head.number, shot: 1 as const };
    if (key !== "scene_info") return null;
    const cellText = (head.vo_cell_full || voiceoverForFrame(head)).trim();
    const queuedAnchors = pendingAnchorsForRange(pendingOps, range);
    const cellRows = head.scene_anchor_rows ?? [];
    const anchorRows: MontageAnchorRow[] = !queuedAnchors
      ? cellRows
      : queuedAnchors.map((r) => ({
          "якорь": r["якорь"],
          "изменение": r["изменение"] || "",
          "главный": Boolean(r["главный"]),
          cell_index: r.cell_index ?? null,
          frame_number: r.frame_number ?? null,
        }));
    const anchorsPending = range.frames.some((fr) =>
      hasPendingType(fr.number, "coverage_anchors"),
    );
    const parentStill = (head.image_parent_url || "").trim();
    return (
      <SceneCell
        still={
          parentStill ? (
            <button
              type="button"
              title="Still сцены"
              className="block overflow-hidden rounded-md border border-white/10"
              onClick={() =>
                showPreview({
                  url: parentStill,
                  kind: "image",
                  label: `Сцена · #${head.number}`,
                })
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={parentStill}
                alt={`Сцена #${head.number}`}
                className="max-h-28 w-full object-cover"
              />
            </button>
          ) : null
        }
        generate={
          projectId != null ? (
            <SceneGenerateBlock
              projectId={projectId}
              frameId={head.frame_id}
              chain={head.scene_chain ?? []}
              disabled={sceneDisabled || applyMutation.isPending || applyRunning}
              onDone={(result) => {
                const nums =
                  result?.frame_numbers?.filter((n) => Number.isFinite(n) && n >= 1) ??
                  [];
                afterSceneActionGenerate(
                  head.number,
                  nums.length ? nums : range.frames.map((fr) => fr.number),
                  SCENE_GENERATE_CLEAR_TYPES,
                );
              }}
              onImprove={(prompt) =>
                improveSceneNow(
                  head.frame_id,
                  head.number,
                  prompt,
                  anchorRows,
                  range.frames.map((fr) => fr.number),
                )
              }
              onGenerateImages={() => generateSceneImagesNow(range)}
            />
          ) : null
        }
        action={
          <SceneActionBlock
            value={sceneShotSequence(range, pendingOps, pending)}
            pending={hasPendingType(head.number, "coverage_scene_action")}
            disabled={sceneDisabled}
            applyBusy={applyMutation.isPending || applyRunning || frameEditBusy}
            onQueue={(action) =>
              queueCoverage({ ...base, type: "coverage_scene_action", action })
            }
            onApply={(action) => applySceneActionNow(head.number, action)}
          />
        }
        anchors={
          <div className="rounded-lg border border-white/10 bg-black/20 p-2">
            <AnchorCell
              projectId={projectId}
              frameId={head.frame_id}
              frameNumber={tail.number}
              frameText={cellText}
              cellText={cellText}
              rows={anchorRows}
              cellRows={cellRows}
              canAdd
              heading="якоря"
              pending={anchorsPending}
              disabled={sceneDisabled}
              voSpan={head.vo_span ?? null}
              onCommit={(anchors) =>
                queueCoverage({
                  frame_number: tail.number,
                  shot: 1,
                  type: "coverage_anchors",
                  anchors,
                })
              }
              onSaveVoSpan={(next) => {
                if (projectId == null) return;
                void api
                  .applyMontageCoverage(projectId, {
                    type: "coverage_vo_span",
                    frame_number: head.number,
                    shot: 1,
                    ...(next
                      ? {
                          start: next.start,
                          end: next.end,
                          text: next.text,
                          ...(next.full ? { full: next.full } : {}),
                        }
                      : { clear: true }),
                  })
                  .then(() => {
                    toast.success(
                      next
                        ? "Закадр сцены сохранён — перегенерация возьмёт этот кусок"
                        : "Выделение закадра снято",
                    );
                    void queryClient.invalidateQueries({
                      queryKey: ["montage-board", projectId],
                    });
                  })
                  .catch((err) => toast.error(errorMessageFromUnknown(err)));
              }}
            />
          </div>
        }
      />
    );
  };

  /** Свет — свойство сцены: op уходит на головной кадр её VO-ячейки. */
  const sceneLightGroup = (range: SceneRange): CoverageMenuGroup => {
    const head = range.frames[0];
    const pending = pendingCoverageForFrame(pendingOps, head.number);
    return {
      key: "light",
      label: "Свет",
      value: (pending.light ?? head.scene_lighting ?? "").trim(),
      choices: board.data?.coverage_light_choices,
      pending: hasPendingType(head.number, "coverage_light"),
      onPick: (light) =>
        queueCoverage({
          frame_number: head.number,
          shot: 1,
          type: "coverage_light",
          light,
        }),
    };
  };

  /**
   * Крупность / ракурс / движение / стык — свойства кадра; свет — свойство
   * сцены, но выбирается в том же меню покрытия под картинкой (op на голову
   * VO-ячейки, пишется всем шотам).
   */
  const coverageGroups = (fr: MontageBoardFrame): CoverageMenuGroup[] => {
    const pending = pendingCoverageForFrame(pendingOps, fr.number);
    const base = { frame_number: fr.number, shot: 1 as const };
    const range = ranges.find((r) =>
      r.frames.some((f) => f.frame_id === fr.frame_id),
    );
    return [
      {
        key: "plan",
        label: "Крупность",
        value: (pending.plan ?? fr.shot_plan ?? "").trim(),
        choices: board.data?.coverage_plan_choices,
        pending: hasPendingType(fr.number, "coverage_plan"),
        onPick: (plan) => queueCoverage({ ...base, type: "coverage_plan", plan }),
      },
      {
        key: "angle",
        label: "Ракурс",
        value: (pending.angle ?? fr.shot_angle ?? "").trim(),
        choices: board.data?.coverage_angle_choices,
        pending: hasPendingType(fr.number, "coverage_angle"),
        onPick: (angle) => queueCoverage({ ...base, type: "coverage_angle", angle }),
      },
      {
        key: "move",
        label: "Движение",
        value: (pending.move ?? fr.shot_move ?? "").trim(),
        choices: board.data?.coverage_move_choices,
        pending: hasPendingType(fr.number, "coverage_move"),
        onPick: (move) => queueCoverage({ ...base, type: "coverage_move", move }),
      },
      {
        key: "stitch",
        label: "Стык",
        value: (pending.stitch ?? fr.shot_stitch ?? "").trim(),
        choices: board.data?.coverage_stitch_choices,
        pending: hasPendingType(fr.number, "coverage_stitch"),
        onPick: (stitch) => queueCoverage({ ...base, type: "coverage_stitch", stitch }),
      },
      range
        ? sceneLightGroup(range)
        : {
            key: "light",
            label: "Свет",
            value: (pending.light ?? fr.scene_lighting ?? "").trim(),
            choices: board.data?.coverage_light_choices,
            pending: hasPendingType(fr.number, "coverage_light"),
            onPick: (light) =>
              queueCoverage({ ...base, type: "coverage_light", light }),
          },
    ];
  };

  const toggleRow = (key: RowKey) => {
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const updateTrim = (key: string, next: VideoTrim) => {
    trimsDirtyRef.current = true;
    setTrims((prev) => ({ ...prev, [key]: next }));
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="pointer-events-auto fixed inset-0 z-[10050] flex flex-col bg-card"
        onContextMenu={handleBoardContextMenu}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-3">
            <Clapperboard className="h-7 w-7 text-amber-400" />
            <div>
              <h2 className="text-base font-semibold">
                Панель монтажа
                {projectQuery.data?.title ? (
                  <span className="ml-2 font-normal text-muted-foreground">
                    · {projectQuery.data.title}
                  </span>
                ) : null}
              </h2>
              <p className="text-xs text-muted-foreground">
                {swapPick
                  ? `Обмен ${swapPick.kind === "image" ? "картинок" : "видео"}: выбран #${swapPick.frameNumber}.${swapPick.shot} — нажмите ↔ на другом слоте (Esc — отмена)`
                  : "Кадры ролика — ↔ на двух слотах меняет местами картинки или видео"}
              </p>
              {/* Строка счётчиков всегда держит высоту: её появление на первой
                  правке сдвигало доску вниз и клик уезжал с кнопки. */}
              <p className="mt-1 flex min-h-[1rem] flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span className="text-muted-foreground/80">
                  кадров {frames.length} · шотов {shotUnits.length}
                </span>
                {highlights.length > 0 && (
                  <span>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400/80" />
                    применено {highlights.length}
                  </span>
                )}
                {pendingOnlyCount > 0 && (
                  <span>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400/80" />
                    в очереди {pendingOnlyCount}
                  </span>
                )}
                {failedHighlights.length > 0 && (
                  <span>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-500/80" />
                    ошибка {failedHighlights.length}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="default"
                className="h-9 text-xs"
                disabled={
                  !projectId ||
                  applyMutation.isPending ||
                  applyRunning ||
                  pendingFrameNumbers.length === 0
                }
                onClick={() => applyMutation.mutate({})}
              >
                {applyMutation.isPending || applyRunning ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : null}
                Применить правки
                {applyRunning && applyProgress
                  ? ` (${applyProgress.done}/${applyProgress.total})`
                  : pendingFrameNumbers.length > 0
                    ? ` (${pendingFrameNumbers.length} ${framesWord(pendingFrameNumbers.length)})`
                    : ""}
              </Button>
              {pendingFrameNumbers.length > 0 && !applyRunning ? (
                <div className="flex max-w-[22rem] flex-wrap items-center gap-1">
                  {pendingFrameNumbers.map((n) => (
                    <button
                      key={n}
                      type="button"
                      disabled={!projectId || applyMutation.isPending}
                      title={`Применить правки кадра #${n}`}
                      onClick={() => applyMutation.mutate({ frameNumbers: [n] })}
                      className="h-7 rounded-md border border-white/15 bg-white/5 px-1.5 text-[10px] font-semibold text-white/80 transition hover:border-white/35 hover:bg-white/10 disabled:opacity-40"
                    >
                      #{n}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9 text-xs"
                  disabled={pendingFrameNumbers.length === 0 || applyRunning}
                >
                  Очередь
                  {pendingFrameNumbers.length > 0
                    ? ` (${pendingFrameNumbers.length})`
                    : ""}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="z-[10080] w-[22rem] border-white/15 bg-card p-2"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                  <p className="text-[10px] uppercase tracking-wide text-white/40">
                    правки в очереди
                  </p>
                  <button
                    type="button"
                    className="text-[10px] text-white/50 underline decoration-dotted hover:text-white"
                    onClick={selectAllPending}
                  >
                    выбрать все
                  </button>
                </div>
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {montageOpsToApply(pendingOps).map((op) => {
                    const key = opSelectKey(op);
                    const checked = selectedOpKeys.has(key);
                    return (
                      <li key={key}>
                        <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-[11px] hover:bg-white/5">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={checked}
                            onChange={() => toggleOpSelected(key)}
                          />
                          <span className={checked ? "text-amber-100" : "text-white/70"}>
                            {describePendingOp(op)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </PopoverContent>
            </Popover>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              disabled={selectedOpKeys.size === 0 || applyRunning}
              onClick={cancelSelectedOps}
            >
              Отменить выбранные
              {selectedOpKeys.size > 0 ? ` (${selectedOpKeys.size})` : ""}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 gap-1.5 text-xs"
              disabled={
                !projectId ||
                recoverOutseeMutation.isPending ||
                recoverRunning ||
                applyRunning
              }
              title="Опционально: CDP-подбор готовых карточек из галереи генератора (перегенерация через API этого не требует)"
              onClick={() => recoverOutseeMutation.mutate()}
            >
              {recoverOutseeMutation.isPending || recoverRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {recoverRunning ? "Забираем из галереи…" : "Галерея генератора (CDP)"}
            </Button>
            <AudioAlignPopover
              projectId={projectId}
              onFinished={() => {
                void queryClient.invalidateQueries({
                  queryKey: ["montage-board", projectId],
                });
                void board.refetch();
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 gap-1.5 text-xs"
              disabled={!projectId || montageMutation.isPending || montageActive}
              onClick={() => montageMutation.mutate()}
            >
              {montageMutation.isPending || montageActive ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Clapperboard className="h-4 w-4" />
              )}
              Монтаж
            </Button>
            <MontageExtrasPopover projectId={projectId} />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 text-xs"
              disabled={board.isFetching}
              onClick={() => board.refetch()}
            >
              {board.isFetching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Обновить
            </Button>
            <button
              type="button"
              className="rounded-md p-2 text-muted-foreground hover:bg-white/10 hover:text-foreground"
              onClick={onClose}
              aria-label="Закрыть"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Доску не перезагружаем: пока летит refetch — тонкая полоска, не пустой экран. */}
        <div className="h-0.5 shrink-0 overflow-hidden bg-transparent">
          {board.isFetching && frames.length > 0 ? (
            <div className="h-full w-1/3 animate-montage-sweep rounded-full bg-[rgba(209,254,23,0.85)]" />
          ) : null}
        </div>

        <div ref={contentScrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div className="p-4 pb-2">
            {board.isLoading && (
              <div className="flex h-40 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}
            {!board.isLoading && board.isError && (
              <div className="flex flex-col items-center gap-3 py-10 px-4 text-center">
                <p className="text-sm text-destructive">Не удалось загрузить данные монтажа</p>
                <p className="max-w-lg text-xs text-muted-foreground break-words whitespace-pre-wrap">
                  {board.error instanceof Error
                    ? board.error.message || String(board.error)
                    : String(board.error ?? "неизвестная ошибка")}
                  {projectId != null ? `\nproject #${projectId}` : ""}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void queryClient.resetQueries({ queryKey: ["montage-board", projectId] });
                    void board.refetch();
                  }}
                >
                  Повторить
                </Button>
              </div>
            )}
            {!board.isLoading && !board.isError && frames.length === 0 && (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">
                  В проекте
                  {projectQuery.data?.title ? ` «${projectQuery.data.title}»` : ""} пока
                  0 кадров — доска заполнится сама, когда пройдёт шаг
                  «Разбивка на кадры» (панель подтягивает данные каждые 5 с).
                  Можно добавить кадр вручную.
                </p>
                <Button
                  type="button"
                  size="sm"
                  disabled={frameEditBusy || projectId == null}
                  onClick={() =>
                    setAddFrame({ afterFrameId: null, kind: "parent" })
                  }
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Добавить кадр
                </Button>
              </div>
            )}

            {/* «+» в тулбаре доски: все переменные проекта по нодам, поповером
                рядом с кнопкой (доска остаётся видна). Данные ленивые — запрос
                уходит только при открытии панели или включённых строках шагов. */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Popover open={variablesOpen} onOpenChange={setVariablesOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs"
                    disabled={projectId == null}
                    title="Переменные проекта по нодам графа"
                  >
                    <Plus className="h-4 w-4" />
                    Переменные проекта
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  sideOffset={6}
                  avoidCollisions={false}
                  className="z-[10070] w-[740px] max-w-[calc(100vw-2rem)] overflow-hidden border-white/15 bg-[#101013] p-0 shadow-2xl"
                  onOpenAutoFocus={(event) => event.preventDefault()}
                >
                  <div className="flex h-[70vh] flex-col">
                    <MontageVariablesPanel
                      open={variablesOpen}
                      onOpenChange={setVariablesOpen}
                      projectId={projectId}
                      rowsVisible={rowsVisible}
                      onSetRows={setBoardRows}
                      rowsSaving={rowsVisibility.isPending}
                      results={resultNodes}
                      frames={frames}
                    />
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={frameEditBusy || projectId == null}
                title="Добавить новую сцену (ячейку закадра) в конец ленты"
                onClick={() =>
                  setAddFrame({
                    kind: "parent",
                    afterFrameId: frames[frames.length - 1]?.frame_id ?? null,
                  })
                }
              >
                <Plus className="h-4 w-4" />
                Добавить кадр
              </Button>
            </div>

            {frames.length > 0 && (
              <div
                ref={tableScrollRef}
                className="overflow-x-auto overflow-y-visible [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {/* Высота строки из meta: tr задаёт высоту, содержимое ячеек
                    обрезается/скроллится — как у ресайза колонок. */}
                <style>{`
                  tr[data-row-height] > td,
                  tr[data-row-height] > th { overflow: hidden; }
                  tr[data-row-height] > td > *,
                  tr[data-row-height] > th > * {
                    max-height: calc(var(--row-h, 240px) - 0.5rem);
                    overflow-y: auto;
                    overflow-x: hidden;
                  }
                `}</style>
                <table
                  className="border-collapse text-[13px]"
                  style={{ width: tableWidthPx, tableLayout: "fixed" }}
                >
                  {shotMode ? (
                    <ShotColGroup ranges={ranges} colRem={colRem} />
                  ) : (
                    <MontageColGroup ranges={ranges} colRem={colRem} />
                  )}
                  <thead>
                    <tr>
                      <th
                        className={cn(
                          "sticky left-0 z-10 border-b border-r border-white/10 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground",
                          ROW_LABEL_CLASS,
                        )}
                      >
                        Строка
                      </th>
                      {shotMode ? (
                        <>
                          {ranges.map((range) => {
                            const units = rangeShotUnits(range);
                            return units.map((unit, ui) => {
                              const firstOfScene = ui === 0;
                              const firstOfFrame =
                                ui === 0 ||
                                units[ui - 1].frame.frame_id !== unit.frame.frame_id;
                              const frameIndex = range.frames.findIndex(
                                (f) => f.frame_id === unit.frame.frame_id,
                              );
                              const splitHere =
                                frameIndex > 0 &&
                                firstOfFrame &&
                                range.frames.length > 1;
                              return (
                                <th
                                  key={`shot-n-${unit.key}`}
                                  className={cn(
                                    "border-b border-white/10 px-1 py-1.5 text-center font-mono text-[11px]",
                                    firstOfScene ? "border-l border-white/15" : null,
                                    unit.frame.удалён
                                      ? "bg-rose-950/40 text-rose-200/80"
                                      : null,
                                  )}
                                  style={frameColStyle(colRem)}
                                  title={
                                    unit.shot
                                      ? `${unit.shot.id || "шот"} · кадр #${unit.frame.number}${
                                          unit.shot.действие ? ` · ${unit.shot.действие}` : ""
                                        }`
                                      : `#${unit.frame.number}`
                                  }
                                >
                                  {unit.shot ? (
                                    <span className="flex flex-col items-center gap-0.5">
                                      <span>{unit.shot.id || `#${unit.frame.number}`}</span>
                                      <span className="text-[9px] font-normal text-white/40">
                                        {`#${unit.frame.number} · ${
                                          unit.shot.parent_id
                                            ? `ребёнок ${unit.shot.parent_id}`
                                            : "родитель"
                                        }`}
                                      </span>
                                    </span>
                                  ) : (
                                    <span>#{unit.frame.number}</span>
                                  )}
                                  {/* Кнопки по кадру: сценовые живут в строке
                                      «Сцены» второй строкой шапки. */}
                                  <span className="mt-1 flex flex-wrap items-center justify-center gap-0.5">
                                    {firstOfFrame ? (
                                      <>
                                        <button
                                          type="button"
                                          title={`Добавить кадр в сцену после #${unit.frame.number}`}
                                          disabled={frameEditBusy}
                                          onClick={() =>
                                            void insertChildAfter(unit.frame.frame_id)
                                          }
                                          className="rounded p-0.5 text-white/35 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                                        >
                                          <Plus className="h-3 w-3" />
                                        </button>
                                        <button
                                          type="button"
                                          title={
                                            unit.frame.удалён
                                              ? `Вернуть кадр #${unit.frame.number}`
                                              : `Удалить кадр #${unit.frame.number}`
                                          }
                                          disabled={frameEditBusy}
                                          onClick={() =>
                                            void (unit.frame.удалён
                                              ? handleRestoreFrame(unit.frame)
                                              : handleDeleteFrame(unit.frame))
                                          }
                                          className={cn(
                                            "rounded p-0.5 transition disabled:opacity-40",
                                            unit.frame.удалён
                                              ? "text-amber-200 hover:bg-amber-500/15"
                                              : "text-white/30 hover:bg-rose-500/15 hover:text-rose-200",
                                          )}
                                        >
                                          {unit.frame.удалён ? (
                                            <span className="px-0.5 text-[9px] font-semibold">
                                              вернуть
                                            </span>
                                          ) : (
                                            <Trash2 className="h-3 w-3" />
                                          )}
                                        </button>
                                      </>
                                    ) : null}
                                    {splitHere ? (
                                      <button
                                        type="button"
                                        title={`Отделить #${unit.frame.number} в новую сцену`}
                                        disabled={frameEditBusy}
                                        onClick={() =>
                                          void splitSceneAt(
                                            unit.frame,
                                            range.frames.map((f) => f.frame_id),
                                          )
                                        }
                                        className="rounded p-0.5 text-white/25 transition hover:text-[rgba(209,254,23,1)] disabled:opacity-40"
                                      >
                                        <Scissors className="h-3 w-3" />
                                      </button>
                                    ) : null}
                                  </span>
                                </th>
                              );
                            });
                          })}
                        </>
                      ) : (
                        <>
                      {ranges.map((range, ri) => (
                        <Fragment key={`scene-n-${range.key}`}>
                          <InsertGutter
                            as="th"
                            gap="scene"
                            label={
                              ri === 0
                                ? "Новая сцена в начало ленты"
                                : "Новая сцена между блоками (новая ячейка закадра)"
                            }
                            onClick={() =>
                              setAddFrame({
                                kind: "parent",
                                afterFrameId:
                                  ri === 0
                                    ? null
                                    : ranges[ri - 1].frames[
                                        ranges[ri - 1].frames.length - 1
                                      ].frame_id,
                              })
                            }
                            mergeLabel={
                              ri > 0
                                ? `Объединить сцену ${ri} и сцену ${ri + 1} в одну`
                                : undefined
                            }
                            onMerge={
                              ri > 0
                                ? () =>
                                    void mergeScenesAt(
                                      ranges[ri - 1].frames[0],
                                      range.frames[0],
                                    )
                                : undefined
                            }
                            mergeDisabled={frameEditBusy}
                          />
                          {range.frames.map((fr, fi) => (
                            <Fragment key={fr.frame_id}>
                              <th
                                className={cn(
                                  "border-b border-white/10 px-1.5 py-2 text-center font-mono text-xs",
                                  fi === 0 ? "border-l border-white/15" : null,
                                  fr.удалён ? "bg-rose-950/40 text-rose-200/80 line-through" : null,
                                )}
                                style={frameColStyle(framePairRem(fr, colRem))}
                              >
                                <span className="flex items-center justify-center gap-1">
                                  <span>#{fr.number}</span>
                                  <button
                                    type="button"
                                    title={`Шот в эту сцену после #${fr.number}`}
                                    disabled={frameEditBusy}
                                    onClick={() => void insertChildAfter(fr.frame_id)}
                                    className="rounded p-0.5 text-white/35 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                                  >
                                    <Plus className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    title={
                                      fr.удалён
                                        ? `Вернуть кадр #${fr.number}`
                                        : `Удалить кадр #${fr.number}`
                                    }
                                    disabled={frameEditBusy}
                                    onClick={() =>
                                      void (fr.удалён
                                        ? handleRestoreFrame(fr)
                                        : handleDeleteFrame(fr))
                                    }
                                    className={cn(
                                      "rounded p-0.5 transition disabled:opacity-40",
                                      fr.удалён
                                        ? "text-amber-200 hover:bg-amber-500/15"
                                        : "text-white/30 hover:bg-rose-500/15 hover:text-rose-200",
                                    )}
                                  >
                                    {fr.удалён ? (
                                      <span className="text-[9px] font-semibold no-underline">вернуть</span>
                                    ) : (
                                      <Trash2 className="h-3 w-3" />
                                    )}
                                  </button>
                                </span>
                              </th>
                              {fi < range.frames.length - 1 ? (
                                <th className={cn(SHOT_GAP_CLASS, "relative border-b border-white/10")}>
                                  <button
                                    type="button"
                                    title={`Отделить #${range.frames[fi + 1].number} в новую сцену`}
                                    disabled={frameEditBusy}
                                    onClick={() =>
                                      void splitSceneAt(
                                        range.frames[fi + 1],
                                        range.frames.map((f) => f.frame_id),
                                      )
                                    }
                                    className="absolute inset-y-0 left-1/2 z-20 flex w-6 -translate-x-1/2 items-center justify-center text-white/25 transition hover:text-[rgba(209,254,23,1)] disabled:opacity-40"
                                  >
                                    <Scissors className="h-3 w-3" />
                                  </button>
                                </th>
                              ) : null}
                            </Fragment>
                          ))}
                        </Fragment>
                      ))}
                      <InsertGutter
                        as="th"
                        gap="scene"
                        label="Новая сцена в конец ленты"
                        onClick={() =>
                          setAddFrame({
                            kind: "parent",
                            afterFrameId: frames[frames.length - 1]?.frame_id ?? null,
                          })
                        }
                      />
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {renderEntries.map((entry) => {
                      const rowHeight = effectiveRowHeights[entry.key];
                      if (entry.kind === "grid") {
                        const row = entry.row;
                        const rowKey = entry.key;
                        const collapsed = collapsedRows.has(row.key);
                        return (
                          <Fragment key={entry.key}>
                        <Fragment key={row.key}>
                        <tr
                          className={cn(
                            "border-b border-white/5",
                            draggingRow === rowKey && "opacity-50",
                            dropRow === rowKey &&
                              "bg-[rgba(209,254,23,0.06)] outline outline-1 -outline-offset-1 outline-[rgba(209,254,23,0.55)]",
                          )}
                          data-row-height={rowHeight ? "" : undefined}
                          style={
                            rowHeight
                              ? ({ height: rowHeight, "--row-h": `${rowHeight}px` } as CSSProperties)
                              : undefined
                          }
                          data-row-key={rowKey}
                        >
                          <td
                            className={cn(
                              "relative sticky left-0 z-10 border-r border-white/10 bg-card/95 px-2 py-2 align-top",
                              ROW_LABEL_CLASS,
                            )}
                          >
                            <div className="flex items-start gap-0.5">
                              <RowGrip
                                rowKey={rowKey}
                                active={draggingRow === rowKey}
                                onStart={startRowDrag}
                              />
                              <button
                                type="button"
                                className={cn(
                                  "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium transition",
                                  collapsed
                                    ? "text-muted-foreground hover:bg-white/5"
                                    : "text-foreground hover:bg-white/5",
                                )}
                                onClick={() => toggleRow(row.key)}
                                title={collapsed ? "Развернуть строку" : "Свернуть строку"}
                              >
                                {collapsed ? (
                                  <ChevronRight className="h-4 w-4 shrink-0" />
                                ) : (
                                  <ChevronDown className="h-4 w-4 shrink-0" />
                                )}
                                <span>{row.label}</span>
                              </button>
                              {/* «⋯» — то же меню «Шаги на доске» рядом с кнопкой. */}
                              <button
                                type="button"
                                aria-label="Шаги на доске"
                                title="Показать/скрыть шаги на доске"
                                className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground/60 transition hover:bg-white/10 hover:text-foreground"
                                onClick={(event) => {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  setRowsMenu({ x: rect.left, y: rect.bottom + 4 });
                                }}
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <RowResizer
                              hasHeight={rowHeights[rowKey] != null}
                              onMouseDown={startRowResize(rowKey)}
                              onReset={() => resetRowHeight(rowKey)}
                            />
                          </td>
                          {shotMode ? (
                            <>
                              {ranges.map((range) => {
                                const units = rangeShotUnits(range);
                                // Видео живёт на кадре, а не на шоте: в режиме
                                // колонок-шотов ячейка видео одна на кадр и
                                // растянута на все его шоты — иначе строка
                                // «Видео» оставалась без кнопок и ползунков.
                                if (row.key === "video1" || row.key === "video2") {
                                  const vidShot: 1 | 2 = row.key === "video2" ? 2 : 1;
                                  return range.frames.map((fr) => {
                                    const frameUnits = units.filter(
                                      (unit) => unit.frame.number === fr.number,
                                    );
                                    const span = Math.max(frameUnits.length, 1);
                                    return (
                                      <td
                                        key={`${row.key}-shot-video-${fr.number}`}
                                        colSpan={span}
                                        style={{ width: span * colRem * 16 }}
                                        className="border-l border-white/15 px-2 py-2 align-top"
                                      >
                                        {collapsed ? (
                                          <div className="h-8 rounded-md bg-black/10" />
                                        ) : (
                                          <VideoMediaCell
                                            fr={fr}
                                            shot={vidShot}
                                            url={
                                              vidShot === 1
                                                ? fr.video_shot1_url
                                                : fr.video_shot2_url
                                            }
                                            onPreview={showPreview}
                                            scrollRootRef={tableScrollRef}
                                            trim={trims[trimKey(fr.number, vidShot)]}
                                            onTrimChange={(t) =>
                                              updateTrim(trimKey(fr.number, vidShot), t)
                                            }
                                            onRegen={() =>
                                              queueOp({
                                                type: "video_regen",
                                                frame_number: fr.number,
                                                shot: vidShot,
                                              })
                                            }
                                            onEditPrompt={() =>
                                              openPromptModal("video", fr.number, vidShot, "prompt")
                                            }
                                            onAiChange={() =>
                                              openAiChangeModal("video", fr.number, vidShot)
                                            }
                                            onDelete={() =>
                                              void handleDeleteVideo(fr.number, vidShot)
                                            }
                                            onUpload={(file) =>
                                              void handleUploadVideo(fr.number, vidShot, file)
                                            }
                                            slotTone={toneForSlot(trimKey(fr.number, vidShot))}
                                            stale={isStaleVideo(fr.number, vidShot)}
                                            onSwapPick={() =>
                                              void handleSwapPick({
                                                kind: "video",
                                                frameNumber: fr.number,
                                                shot: vidShot,
                                              })
                                            }
                                            swapSelected={isSwapSelected(
                                              "video",
                                              fr.number,
                                              vidShot,
                                            )}
                                            swapBusy={swapBusy}
                                          />
                                        )}
                                      </td>
                                    );
                                  });
                                }
                                if (SCENE_SPAN_ROWS.has(row.key)) {
                                  return (
                                    <td
                                      key={`${row.key}-shot-scene-${range.key}`}
                                      colSpan={units.length}
                                      style={{ width: units.length * colRem * 16 }}
                                      className="border-l border-white/15 px-2 py-2 align-top"
                                    >
                                      {collapsed ? (
                                        <div className="h-8 rounded-md bg-black/10" />
                                      ) : (
                                        renderSceneSpanCell(row.key, range)
                                      )}
                                    </td>
                                  );
                                }
                                return units.map((unit, ui) => (
                                  <td
                                    key={`${row.key}-${unit.key}`}
                                    className={cn(
                                      "relative isolate px-1.5 py-2 align-top",
                                      row.key !== "voiceover" && "overflow-hidden",
                                      ui === 0 ? "border-l border-white/15" : null,
                                    )}
                                    style={{
                                      ...frameColStyle(colRem),
                                      contentVisibility: "auto",
                                      containIntrinsicSize: "auto 240px auto 180px",
                                    }}
                                  >
                                    {collapsed ? (
                                      <div className="h-8 rounded-md bg-black/10" />
                                    ) : (
                                      renderShotFrameCell(row.key, unit)
                                    )}
                                  </td>
                                ));
                              })}
                            </>
                          ) : (
                            <>
                          {ranges.map((range, ri) => (
                          <Fragment key={`${row.key}-scene-${range.key}`}>
                          <GapCell as="td" gap="scene" />
                          {SCENE_SPAN_ROWS.has(row.key) ? (
                            <td
                              colSpan={sceneColSpan(range.frames.length)}
                              style={{ width: sceneBlockWidthPx(range.frames, colRem) }}
                              className="border-l border-white/15 px-2 py-2 align-top"
                            >
                              {collapsed ? (
                                <div className="h-8 rounded-md bg-black/10" />
                              ) : (
                                renderSceneSpanCell(row.key, range)
                              )}
                            </td>
                          ) : (
                          range.frames.map((fr, fi) => {
                            const pairRem = framePairRem(fr, colRem);
                            const endState = endStillState(fr);
                            const isMediaRow =
                              row.key.startsWith("image") || row.key.startsWith("video");
                            const mediaUrl =
                              row.key === "image1"
                                ? `${startStillUrl(fr)}|${endState === "yes" ? fr.image_shot2_url || "" : ""}`
                                : row.key === "video1"
                                  ? fr.video_shot1_url
                                  : row.key === "video2"
                                    ? fr.video_shot2_url
                                    : "";
                            return (
                            <Fragment key={
                              isMediaRow
                                ? `${fr.frame_id}-${row.key}-${mediaUrl || ""}`
                                : `${fr.frame_id}-${row.key}`
                            }>
                            <td
                              className={cn(
                                "relative isolate px-1.5 py-2 align-top",
                                row.key !== "voiceover" && "overflow-hidden",
                                fi === 0 ? "border-l border-white/15" : null,
                              )}
                              style={
                                isMediaRow || row.key === "voiceover"
                                  ? frameColStyle(pairRem)
                                  : {
                                      ...frameColStyle(pairRem),
                                      contentVisibility: "auto",
                                      // `auto` = помнить последний размер клетки:
                                      // иначе отрисовка соседней строки меняла
                                      // 180px заглушку на реальную высоту и доска
                                      // дёргалась под курсором.
                                      containIntrinsicSize: "auto 240px auto 180px",
                                    }
                              }
                            >
                              {collapsed ? (
                                <div className="h-8 rounded-md bg-black/10" />
                              ) : row.key === "voiceover" ? (
                                <VoiceoverCell
                                  frame={fr}
                                  busy={frameEditBusy || applyRunning}
                                  unusedBefore={
                                    fr.number === fr.vo_unused_after_number
                                      ? fr.vo_unused_before || ""
                                      : ""
                                  }
                                  unusedAfter={
                                    fr.number === fr.vo_unused_after_number
                                      ? fr.vo_unused_after || ""
                                      : ""
                                  }
                                  unusedBetween={
                                    fr.number === fr.vo_unused_after_number
                                      ? fr.vo_unused_between || []
                                      : []
                                  }
                                  onSave={(text) => handleSaveVoiceover(fr.frame_id, text)}
                                  onDelete={() =>
                                    void (fr.удалён
                                      ? handleRestoreFrame(fr)
                                      : handleDeleteFrame(fr))
                                  }
                                />
                              ) : SCENE_FRAME_ROWS.has(row.key) ? (
                                renderSceneFrameCell(row.key, fr)
                              ) : row.key === "timestamps" ? (
                                <TimestampCell fr={fr} />
                              ) : row.key === "image1" ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-start gap-1">
                                    <div className="min-w-0 flex-1">
                                      <ClickableMedia
                                        url={startStillUrl(fr)}
                                        kind="image"
                                        tall={coverageOn}
                                        tallAspect={frameAspect}
                                        overlay={null}
                                        label={`Начальный кадр · #${fr.number}`}
                                        onPreview={showPreview}
                                        scrollRootRef={tableScrollRef}
                                        imageSlot={{ frameNumber: fr.number, shot: 1 }}
                                        onImageDrop={(from) =>
                                          void handleMoveImage(from, {
                                            frameNumber: fr.number,
                                            shot: 1,
                                          })
                                        }
                                        onRegen={() =>
                                          queueOp({
                                            type: "image_regen",
                                            frame_number: fr.number,
                                            shot: 1,
                                            prompt: sourcePromptFor("image", fr.number, 1),
                                          })
                                        }
                                        onEditPrompt={() =>
                                          openPromptModal("image", fr.number, 1, "prompt")
                                        }
                                        onAiChange={() =>
                                          openAiChangeModal("image", fr.number, 1)
                                        }
                                        onRegenWithCorrection={() =>
                                          openPromptModal(
                                            "image",
                                            fr.number,
                                            1,
                                            "correction",
                                          )
                                        }
                                        onDelete={() =>
                                          void handleDeleteImage(fr.number, 1)
                                        }
                                        onUpload={(file) =>
                                          void handleUploadImage(fr.number, 1, file)
                                        }
                                        slotTone={toneForSlot(`${fr.number}:image1`)}
                                        onSwapPick={() =>
                                          void handleSwapPick({
                                            kind: "image",
                                            frameNumber: fr.number,
                                            shot: 1,
                                          })
                                        }
                                        swapSelected={isSwapSelected(
                                          "image",
                                          fr.number,
                                          1,
                                        )}
                                        swapBusy={swapBusy}
                                      />
                                    </div>
                                    {endState === "yes" ? (
                                      <div className="min-w-0 flex-1">
                                        <ClickableMedia
                                          url={fr.image_shot2_url}
                                          kind="image"
                                          tall={coverageOn}
                                          tallAspect={frameAspect}
                                          label={`Конечный кадр · #${fr.number}`}
                                          onPreview={showPreview}
                                          scrollRootRef={tableScrollRef}
                                          imageSlot={{
                                            frameNumber: fr.number,
                                            shot: 2,
                                          }}
                                          onImageDrop={(from) =>
                                            void handleMoveImage(from, {
                                              frameNumber: fr.number,
                                              shot: 2,
                                            })
                                          }
                                          onRegen={() =>
                                            queueOp({
                                              type: "image_regen",
                                              frame_number: fr.number,
                                              shot: 2,
                                              prompt: sourcePromptFor(
                                                "image",
                                                fr.number,
                                                2,
                                              ),
                                            })
                                          }
                                          onEditPrompt={() =>
                                            openPromptModal(
                                              "image",
                                              fr.number,
                                              2,
                                              "prompt",
                                            )
                                          }
                                          onAiChange={() =>
                                            openAiChangeModal("image", fr.number, 2)
                                          }
                                          onRegenWithCorrection={() =>
                                            openPromptModal(
                                              "image",
                                              fr.number,
                                              2,
                                              "correction",
                                            )
                                          }
                                          onDelete={() =>
                                            void handleDeleteImage(fr.number, 2)
                                          }
                                          onUpload={(file) =>
                                            void handleUploadImage(fr.number, 2, file)
                                          }
                                          slotTone={toneForSlot(
                                            `${fr.number}:image2`,
                                          )}
                                          onSwapPick={() =>
                                            void handleSwapPick({
                                              kind: "image",
                                              frameNumber: fr.number,
                                              shot: 2,
                                            })
                                          }
                                          swapSelected={isSwapSelected(
                                            "image",
                                            fr.number,
                                            2,
                                          )}
                                          swapBusy={swapBusy}
                                        />
                                      </div>
                                    ) : null}
                                  </div>
                                  {endState === "unknown" ? (
                                    <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">
                                      Раскладка пустая — неясно, нужен ли конечный
                                      кадр
                                    </p>
                                  ) : null}
                                  {coverageOn ? renderSceneFrameCell("role", fr) : null}
                                  {coverageOn ? (
                                    <CoverageMenu
                                      title={`покрытие кадра #${fr.number}`}
                                      groups={coverageGroups(fr)}
                                      disabled={sceneDisabled}
                                    />
                                  ) : null}
                                  <FrameRefsStrip
                                    projectId={projectId}
                                    frame={frameForRefs(
                                      fr,
                                      pendingCoverageForFrame(pendingOps, fr.number),
                                      kindOverride[fr.number],
                                    )}
                                    parentFrame={
                                      effectiveShotKind(
                                        fr,
                                        pendingCoverageForFrame(pendingOps, fr.number),
                                        kindOverride[fr.number],
                                      ) === "parent"
                                        ? null
                                        : parentFrameOf(frames, fr)
                                    }
                                    pendingKind={
                                      effectiveShotKind(
                                        fr,
                                        pendingCoverageForFrame(pendingOps, fr.number),
                                        kindOverride[fr.number],
                                      ) || undefined
                                    }
                                    onPromoteToParent={() =>
                                      applyKindNow(fr.number, "parent")
                                    }
                                    kinds={board.data?.ref_kind_choices}
                                    disabled={frameEditBusy || applyRunning}
                                    onPreview={showPreview}
                                    onChanged={() => void board.refetch()}
                                  />
                                </div>
                              ) : row.key === "video1" ? (
                                <VideoMediaCell
                                  fr={fr}
                                  shot={1}
                                  url={fr.video_shot1_url}
                                  onPreview={showPreview}
                                  scrollRootRef={tableScrollRef}
                                  trim={trims[trimKey(fr.number, 1)]}
                                  onTrimChange={(t) => updateTrim(trimKey(fr.number, 1), t)}
                                  onRegen={() =>
                                    queueOp({
                                      type: "video_regen",
                                      frame_number: fr.number,
                                      shot: 1,
                                    })
                                  }
                                  onEditPrompt={() => openPromptModal("video", fr.number, 1, "prompt")}
                                  onAiChange={() =>
                                    openAiChangeModal("video", fr.number, 1)
                                  }
                                  onDelete={() => void handleDeleteVideo(fr.number, 1)}
                                  onUpload={(file) => void handleUploadVideo(fr.number, 1, file)}
                                  slotTone={toneForSlot(trimKey(fr.number, 1))}
                                  stale={isStaleVideo(fr.number, 1)}
                                  onSwapPick={() =>
                                    void handleSwapPick({
                                      kind: "video",
                                      frameNumber: fr.number,
                                      shot: 1,
                                    })
                                  }
                                  swapSelected={isSwapSelected("video", fr.number, 1)}
                                  swapBusy={swapBusy}
                                />
                              ) : (
                                <VideoMediaCell
                                  fr={fr}
                                  shot={2}
                                  url={fr.video_shot2_url}
                                  onPreview={showPreview}
                                  scrollRootRef={tableScrollRef}
                                  trim={trims[trimKey(fr.number, 2)]}
                                  onTrimChange={(t) => updateTrim(trimKey(fr.number, 2), t)}
                                  onRegen={() =>
                                    queueOp({
                                      type: "video_regen",
                                      frame_number: fr.number,
                                      shot: 2,
                                    })
                                  }
                                  onEditPrompt={() => openPromptModal("video", fr.number, 2, "prompt")}
                                  onAiChange={() =>
                                    openAiChangeModal("video", fr.number, 2)
                                  }
                                  onDelete={() => void handleDeleteVideo(fr.number, 2)}
                                  onUpload={(file) => void handleUploadVideo(fr.number, 2, file)}
                                  slotTone={toneForSlot(trimKey(fr.number, 2))}
                                  stale={isStaleVideo(fr.number, 2)}
                                  onSwapPick={() =>
                                    void handleSwapPick({
                                      kind: "video",
                                      frameNumber: fr.number,
                                      shot: 2,
                                    })
                                  }
                                  swapSelected={isSwapSelected("video", fr.number, 2)}
                                  swapBusy={swapBusy}
                                />
                              )}
                            </td>
                            {fi < range.frames.length - 1 ? (
                              <GapCell as="td" gap="shot" />
                            ) : null}
                            </Fragment>
                            );
                          })
                          )}
                          </Fragment>
                          ))}
                          <GapCell as="td" gap="scene" />
                                                    </>
                          )}
                        </tr>
                        </Fragment>
                          </Fragment>
                        );
                      }
                      const { node, item, layout, rowKey } = entry.row;
const rowLabel = item
                        ? `${node.label} · ${item.label}`
                        : `${node.label} · ${layout === "scene" ? "по сценам" : "по кадрам"}`;
                      const rowHint = item
                        ? `${item.kind} · ${node.nodeKey}`
                        : `${layout} · ${node.nodeKey}`;
                      // Единицы-файлы (xlsx-снимок слота, отчёт): у них нет
                      // своего места на доске, поэтому показываем имя файла и
                      // ссылку в подписи строки — файл не теряется.
                      const fileItems = node.snapshot.items.filter(
                        (candidate) =>
                          (candidate.kind === "xlsx" || candidate.kind === "file") &&
                          Boolean(candidate.downloadUrl || candidate.previewUrl) &&
                          !candidate.placement,
                      );
                      // Единицы результата с привязкой к месту (шоты, сцены по
                      // плану, диалоги, каркас, QC, стиль) — в колонку своего
                      // кадра/сцены; персонажи/фоны рисуются как раньше, рефами.
                      const placedItems =
                        layout === "full"
                          ? []
                          : node.snapshot.items.filter(
                              (candidate) =>
                                candidate.placement && candidate.placement.kind !== "full",
                            );
                      const hasPlacement = placedItems.length > 0;
                      const itemsForScene = (range: SceneRange) =>
                        placedItems.filter(
                          (candidate) =>
                            candidate.placement?.kind === "scene" &&
                            candidate.placement.sceneIndex === range.scene,
                        );
                      const itemsForFrame = (fr: MontageBoardFrame) =>
                        placedItems.filter(
                          (candidate) =>
                            candidate.placement?.kind === "frame" &&
                            candidate.placement.frameNumbers.includes(fr.number),
                        );
                      // Единица в колонке своего шота: shot-привязка по id,
                      // кадровая — только в первой колонке кадра (не дублируем).
                      const itemsForUnit = (unit: ShotUnit, firstOfFrame: boolean) =>
                        placedItems.filter((candidate) => {
                          const placement = boardPlacement(candidate);
                          if (!placement) return false;
                          if (placement.kind === "shot") {
                            return unit.shot
                              ? unit.shot.id === placement.shotId
                              : placement.frameNumber === unit.frame.number;
                          }
                          if (placement.kind === "frame") {
                            return (
                              firstOfFrame &&
                              (placement.frameNumbers ?? []).includes(unit.frame.number)
                            );
                          }
                          return false;
                        });
                      return (
                        <tr
                          key={rowKey}
                          className={cn(
                            "border-t border-white/10",
                            draggingRow === rowKey && "opacity-50",
                            dropRow === rowKey &&
                              "bg-[rgba(209,254,23,0.06)] outline outline-1 -outline-offset-1 outline-[rgba(209,254,23,0.55)]",
                          )}
                          data-row-height={rowHeight ? "" : undefined}
                          style={
                            rowHeight
                              ? ({ height: rowHeight, "--row-h": `${rowHeight}px` } as CSSProperties)
                              : undefined
                          }
                          data-row-key={rowKey}
                        >
                          <th
                            scope="row"
                            className="relative sticky left-0 z-10 border-r border-white/10 bg-card/95 px-2 py-2 text-left align-top"
                          >
                            <div className="flex items-start gap-1">
                              <RowGrip
                                rowKey={rowKey}
                                active={draggingRow === rowKey}
                                onStart={startRowDrag}
                              />
                              <button
                                type="button"
                                aria-label="Убрать результат с доски"
                                title="Убрать строку с доски"
                                className="shrink-0 rounded p-1 text-muted-foreground/60 transition hover:bg-rose-500/15 hover:text-rose-200"
                                onClick={() => setBoardRows([rowKey], false)}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                              <span className="min-w-0 text-[11px] font-medium text-muted-foreground">
                                <span className="block truncate">{rowLabel}</span>
                                <span className="block truncate font-mono text-[9px] text-white/25">
                                  {rowHint}
                                </span>
                                {fileItems.map((file) => (
                                  <a
                                    key={file.id}
                                    href={file.downloadUrl || file.previewUrl || "#"}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={`Скачать ${file.label}`}
                                    className="mt-1 flex items-center gap-1 truncate text-[10px] font-normal text-[rgba(209,254,23,0.85)] hover:underline"
                                  >
                                    <FileText className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{file.label || "файл"}</span>
                                    <span className="shrink-0 text-white/45">скачать</span>
                                  </a>
                                ))}
                              </span>
                            </div>
                            <RowResizer
                              hasHeight={rowHeights[rowKey] != null}
                              onMouseDown={startRowResize(rowKey)}
                              onReset={() => resetRowHeight(rowKey)}
                            />
                          </th>
                          {layout === "full" ? (
                            <td
                              colSpan={gridColSpan - 1}
                              className="border-l border-white/10 px-3 py-2 align-top"
                            >
                              {rowKey.endsWith(":shown") ? (
                                <div className="flex flex-col gap-2">
                                  {node.snapshot.items
                                    .filter(
                                      (candidate) =>
                                        candidate.kind !== "xlsx" &&
                                        candidate.kind !== "file",
                                    )
                                    .map((candidate) => (
                                      <MontageResultRowContent
                                        key={candidate.id}
                                        node={node}
                                        item={candidate}
                                        frames={resultFrames}
                                      />
                                    ))}
                                </div>
                              ) : item ? (
                                <MontageResultRowContent
                                  node={node}
                                  item={item}
                                  frames={resultFrames}
                                />
                              ) : null}
                            </td>
                          ) : (
                            shotMode ? (
                              ranges.map((range) => {
                                const units = rangeShotUnits(range);
                                if (layout === "scene") {
                                  return (
                                    <td
                                      key={`${rowKey}-shot-scene-${range.key}`}
                                      colSpan={units.length}
                                      style={{ width: units.length * colRem * 16 }}
                                      className="border-l border-white/15 px-2 py-2 align-top"
                                    >
                                      {hasPlacement ? (
                                        <ResultPlacementCell items={itemsForScene(range)} />
                                      ) : (
                                        <SceneBackgroundCell
                                          frames={range.frames}
                                          tall={coverageOn}
                                          tallAspect={frameAspect}
                                        />
                                      )}
                                    </td>
                                  );
                                }
                                const refsForUnit = (unit: ShotUnit) => {
                                  if (node.nodeType === "backgrounds") {
                                    const bg =
                                      unit.shot?.background_ref ?? unit.frame.background_ref ?? null;
                                    return bg ? ([bg] as MontageBoardCharacterRef[]) : [];
                                  }
                                  if (
                                    node.nodeType === "items" ||
                                    node.nodeType === "hitl_items"
                                  ) {
                                    return unit.shot?.item_refs ?? unit.frame.item_refs ?? [];
                                  }
                                  return unit.shot?.character_refs ?? unit.frame.character_refs ?? [];
                                };
                                return units.map((unit, ui) => {
                                  const firstShotOfFrame =
                                    ui === 0 ||
                                    units[ui - 1].frame.frame_id !== unit.frame.frame_id;
                                  return (
                                    <td
                                      key={`${rowKey}-${unit.key}`}
                                      className={cn(
                                        "relative isolate overflow-hidden px-1.5 py-2 align-top",
                                        ui === 0 && "border-l border-white/15",
                                      )}
                                      style={frameColStyle(framePairRem(unit.frame, colRem))}
                                    >
                                      {hasPlacement ? (
                                        <ResultPlacementCell
                                          items={itemsForUnit(unit, firstShotOfFrame)}
                                        />
                                      ) : (
                                        <FrameRefThumbs
                                          compact
                                          tall={coverageOn}
                                          tallAspect={frameAspect}
                                          refs={refsForUnit(unit)}
                                        />
                                      )}
                                    </td>
                                  );
                                });
                              })
                            ) : (
                            <>
                              {ranges.map((range, ri) => (
                                <Fragment key={`${rowKey}-scene-${range.key}`}>
                                  <GapCell as="td" gap="scene" />
                                  {layout === "scene" ? (
                                    <td
                                      colSpan={sceneColSpan(range.frames.length)}
                                      style={{ width: sceneBlockWidthPx(range.frames, colRem) }}
                                      className="border-l border-white/15 px-2 py-2 align-top"
                                    >
                                      {hasPlacement ? (
                                        <ResultPlacementCell items={itemsForScene(range)} />
                                      ) : (
                                        <SceneBackgroundCell
                                          frames={range.frames}
                                          tall={coverageOn}
                                          tallAspect={frameAspect}
                                        />
                                      )}
                                    </td>
                                  ) : (
                                    range.frames.map((fr, fi) => (
                                      <Fragment key={`${rowKey}-fr-${fr.frame_id}`}>
                                        <td
                                          className={cn(
                                            "relative isolate overflow-hidden px-1.5 py-2 align-top",
                                            fi === 0 && ri >= 0 && "border-l border-white/15",
                                          )}
                                          style={frameColStyle(framePairRem(fr, colRem))}
                                        >
                                          {hasPlacement ? (
                                            <ResultPlacementCell items={itemsForFrame(fr)} />
                                          ) : (
                                            <FrameRefThumbs
                                              tall={coverageOn}
                                              tallAspect={frameAspect}
                                              refs={
                                                node.nodeType === "items" ||
                                                node.nodeType === "hitl_items"
                                                  ? (fr.item_refs ?? [])
                                                  : (fr.character_refs ?? [])
                                              }
                                            />
                                          )}
                                        </td>
                                        {fi < range.frames.length - 1 ? (
                                          <GapCell as="td" gap="shot" />
                                        ) : null}
                                      </Fragment>
                                    ))
                                  )}
                                </Fragment>
                              ))}
                              <GapCell as="td" gap="scene" />
                            </>
                            )
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {frames.length > 0 && (
          <footer className="shrink-0 border-t border-white/10 bg-card px-4 py-2">
            <div
              ref={hBarRef}
              className="overflow-x-auto overflow-y-hidden"
              aria-label="Горизонтальная прокрутка таблицы"
            >
              <div style={{ width: tableWidthPx, height: 14 }} className="shrink-0" />
            </div>
          </footer>
        )}
      </div>
      {rowsMenu ? (
        <MontageRowsMenu
          items={rowsMenuItems}
          x={rowsMenu.x}
          y={rowsMenu.y}
          onToggle={toggleRowFromMenu}
          onClose={() => setRowsMenu(null)}
        />
      ) : null}
      <MediaLightbox preview={preview} onClose={() => setPreview(null)} />
      <PromptModal
        state={promptModal}
        onClose={() => setPromptModal(null)}
        onSubmit={submitPromptModal}
        busy={applyMutation.isPending}
      />
      <ShotPromptModal
        state={shotPrompt}
        onClose={() => setShotPrompt(null)}
        onSubmit={submitShotPrompt}
        busy={
          shotPrompt
            ? shotBusyKey === shotBusyId(shotPrompt.frameNumber, shotPrompt.shotId)
            : false
        }
      />
      <AiChangeModal
        state={aiChangeModal}
        onClose={() => setAiChangeModal(null)}
        onAutomatic={(text) => {
          if (!aiChangeModal) return;
          if (projectId != null && text) {
            writeMontageAiChangeText(
              projectId,
              aiChangeModal.kind,
              aiChangeModal.frameNumber,
              aiChangeModal.shot,
              text,
            );
          }
          queueAiChange(aiChangeModal.kind, aiChangeModal.frameNumber, aiChangeModal.shot);
          setAiChangeModal(null);
        }}
        onWithText={(text) => {
          if (!aiChangeModal) return;
          if (projectId != null && text) {
            writeMontageAiChangeText(
              projectId,
              aiChangeModal.kind,
              aiChangeModal.frameNumber,
              aiChangeModal.shot,
              text,
            );
          }
          queueAiChange(
            aiChangeModal.kind,
            aiChangeModal.frameNumber,
            aiChangeModal.shot,
            text,
          );
          setAiChangeModal(null);
        }}
      />
      {addFrame ? (
        <AddFrameModal
          afterLabel={addFrameLabel}
          busy={frameEditBusy}
          onClose={() => setAddFrame(null)}
          onSubmit={(text) => void handleInsertFrame(text)}
        />
      ) : null}
    </>,
    document.body,
  );
}

/** Кнопка «Монтаж» на общей панели над канвасом. */
export function AssembleMontageTrigger({
  onClick,
  active,
  busy,
}: {
  onClick: () => void;
  active?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      title={busy ? "Монтаж выполняется — панель можно открыть" : "Панель монтажа"}
      className={cn(
        "flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition",
        busy
          ? "border-amber-400/40 bg-amber-500/15 text-amber-200/90"
          : active
            ? "border-amber-400/60 bg-amber-500/25 text-amber-100"
            : "border-amber-400/40 bg-amber-500/15 text-amber-200 hover:border-amber-300/70 hover:bg-amber-500/25",
      )}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Clapperboard className="h-3.5 w-3.5" />
      )}
      {busy ? "Монтаж…" : "Монтаж"}
    </button>
  );
}
