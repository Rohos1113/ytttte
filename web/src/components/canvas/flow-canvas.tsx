"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionLineType,
  type Node,
  type Edge,
  useNodesState,
  useEdgesState,
  type NodeChange,
  type EdgeChange,
  type Connection,
  applyNodeChanges,
  addEdge,
  Position,
  Handle,
  useStore,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  ClipboardPaste,
  FileSpreadsheet,
  Film,
  ImageIcon,
  Loader2,
  Play,
  Save,
  Square,
  Trash2,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { api, subscribeWS } from "@/lib/api";
import type {
  NodeRunDTO,
  WorkflowDetail,
  WorkflowEdge,
  WorkflowEdgeKind,
  WorkflowNode,
  WorkflowRunDetail,
} from "@/lib/types";
import { getNodeSpec } from "@/lib/node-catalog";
import { stepCodeForNodeType } from "@/lib/node-step-map";
import {
  formatNodeKeyLabel,
  formatRunOverlayLabel,
  formatStepCode,
  nodeRunsFromPayload,
} from "@/lib/format-labels";
import { buildExcelLaneBindings } from "@/lib/excel-lane-bindings";
import { useTranslation } from "@/lib/i18n";
import {
  inferNodeStatusFromProject,
  reconcileNodeRunStatus,
  workflowStructureKey,
} from "@/lib/node-run-status";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { shouldShowStopBar } from "@/lib/project-running";
import { nodeTypeFromKey } from "@/lib/node-key";
import {
  isEditableTarget,
  readCanvasClipboard,
  writeCanvasClipboard,
  type CanvasClipboardPayload,
} from "@/lib/canvas-clipboard";
import { excelGptSlotIndex } from "@/lib/excel-gpt-config";
import { PipelineNode, type PipelineNodeData } from "./pipeline-node";
import { NodePalette } from "./node-palette";
import { GroupFrames } from "./group-frames";
import {
  assignExcelGptSlotIndices,
  migrateWorkflowNodes,
  workflowNodeFromCanvas,
} from "@/lib/workflow-node-serialize";
import {
  buildCanvasGraph,
  readCanvasGraph,
} from "@/lib/canvas-graph-storage";
import { mergeGraphNodesWithRuntime } from "@/lib/canvas-node-merge";
import {
  readPipelineViewport,
  writePipelineViewport,
} from "@/lib/pipeline-viewport";
import { defaultModelIdForNodeType, isTextNodeType } from "@/lib/node-model-catalog";
import { applyGlobalTextModel, applyNodeDataPatch } from "@/lib/node-model-patch";
import { EdgeKindControls } from "./edge-kind-controls";
import { SoftThreadEdge } from "./soft-thread-edge";
import { edgeKindLabel } from "@/lib/gpt-operator";
import { useRunEvents } from "@/hooks/use-bus";
import { Button } from "@/components/ui/button";
import { AutoAdvanceToggle } from "@/components/inspector/project-settings";
import { RightButtonMarquee } from "@/components/canvas/right-button-marquee";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const nodeTypes = {
  pipeline: PipelineNode,
};

const edgeTypes = {
  thread: SoftThreadEdge,
  /** Старые графы со smoothstep/default → та же мягкая нить. */
  smoothstep: SoftThreadEdge,
  default: SoftThreadEdge,
  bezier: SoftThreadEdge,
};

const THREAD_EDGE_STYLE = {
  stroke: "rgba(255, 255, 255, 0.5)",
  strokeWidth: 2,
  strokeDasharray: "5 6",
} as const;

export function FlowCanvas({
  projectId,
  selectedNodeKey,
  runStepNodeKey,
  onSelectNode,
  onNodeActivate,
  disabledNodes = new Set<string>(),
  onCanvasZoom,
}: {
  projectId: number | null;
  selectedNodeKey: string | null;
  /** Нода для «Создать Run» / сброса — по умолчанию selectedNodeKey. */
  runStepNodeKey?: string | null;
  onSelectNode: (key: string | null) => void;
  onNodeActivate?: (nodeKey: string, nodeType: string) => boolean | void;
  disabledNodes?: Set<string>;
  onCanvasZoom?: (zoom: number) => void;
}) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  // 1) Дефолтный Workflow с бэкенда.
  const workflows = useQuery({
    queryKey: ["workflows"],
    queryFn: api.listWorkflows,
  });
  const defaultWorkflow = useMemo(
    () => (workflows.data ?? []).find((w) => w.is_default) ?? (workflows.data ?? [])[0] ?? null,
    [workflows.data]
  );
  const workflow = useQuery({
    queryKey: ["workflow", defaultWorkflow?.id],
    queryFn: () => api.getWorkflow(defaultWorkflow!.id),
    enabled: !!defaultWorkflow,
    staleTime: 0,
  });

  // 2) Run для выбранного проекта (если есть).
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: projectId != null,
    refetchInterval: (q) =>
      shouldShowStopBar(q.state.data?.status, q.state.data?.generation_active) ? 1000 : 2500,
  });

  const run = useQuery({
    queryKey: ["project-run", projectId],
    queryFn: async () => {
      if (!projectId) return null;
      try {
        return await api.getProjectRun(projectId);
      } catch {
        return null;
      }
    },
    enabled: projectId != null,
    refetchInterval: 4000,
  });

  useEffect(() => {
    if (projectId == null) return;
    return subscribeWS(`projects.${projectId}`, (raw) => {
      const evt = raw as { type?: string; payload?: { stopped?: boolean } };
      if (
        evt.payload?.stopped ||
        evt.type === "node_status_changed" ||
        evt.type === "project_updated"
      ) {
        void qc.invalidateQueries({ queryKey: ["project-run", projectId] });
        void qc.invalidateQueries({ queryKey: ["project", projectId] });
      }
    });
  }, [projectId, qc]);

  // Базовая структура графа — из project.meta.canvas_graph (приоритет) или workflow.
  const canvasGraph = useMemo(() => {
    if (!project.data?.meta || !defaultWorkflow?.id) return null;
    return readCanvasGraph(
      project.data.meta as Record<string, unknown>,
      defaultWorkflow.id,
    );
  }, [project.data?.meta, defaultWorkflow?.id]);

  const graphSource = useMemo((): WorkflowDetail | null => {
    if (!workflow.data) return null;
    if (canvasGraph) {
      return {
        ...workflow.data,
        nodes: canvasGraph.nodes,
        edges: canvasGraph.edges,
      };
    }
    // Не рисуем factory-layout, пока project.meta ещё грузится — иначе
    // позиции залипают и потом перезаписывают canvas_graph при autosave.
    if (projectId != null && !project.isFetched) return null;
    // Пустой canvas_graph у дочерних — брать snapshot WorkflowRun, не дефолтный
    // шаблон на 16 нод (иначе пропадают excel_gpt / storage).
    const runNodes = run.data?.nodes_snapshot;
    const runEdges = run.data?.edges_snapshot;
    if (Array.isArray(runNodes) && runNodes.length > 0) {
      return {
        ...workflow.data,
        nodes: runNodes,
        edges: Array.isArray(runEdges) ? runEdges : [],
      };
    }
    return workflow.data;
  }, [workflow.data, canvasGraph, projectId, project.isFetched, run.data]);

  const baseNodes = useMemo(() => {
    if (!graphSource) return [];
    return workflowToReactFlowNodes(graphSource, null);
  }, [graphSource]);
  const baseEdges = useMemo(() => {
    if (!graphSource) return [];
    return workflowToReactFlowEdges(graphSource);
  }, [graphSource]);

  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<Node<PipelineNodeData>>([]);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState<Edge>([]);
  const [graphVersion, setGraphVersion] = useState<string>("");
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const selectedNodesRef = useRef<Node<PipelineNodeData>[]>([]);
  /** Ноды, которые пользователь тянет прямо сейчас: их позицию нельзя
   * перетирать серверной — она отстаёт (WS/autosave пришёл в середине
   * перетаскивания), и нода «прыгает» назад. */
  const draggingNodeIdsRef = useRef<Set<string>>(new Set());
  /** Подавить onSelectionChange после программного setNodes(selected). */
  const ignoreSelectionChangeRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const inlineClickTimerRef = useRef<number | null>(null);
  const persistInFlightRef = useRef(false);
  const persistQueuedRef = useRef(false);
  const reactFlowRef = useRef<ReactFlowInstance<Node<PipelineNodeData>, Edge> | null>(null);
  const persistProjectIdRef = useRef(projectId);
  persistProjectIdRef.current = projectId;
  const lastGraphProjectRef = useRef<number | null>(projectId);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const savedViewport = projectId != null ? readPipelineViewport(projectId) : null;

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Смена проекта — не тащим позиции/версию соседа с теми же node_key.
  useEffect(() => {
    setGraphVersion("");
    setNodes([]);
    setEdges([]);
  }, [projectId, setNodes, setEdges]);

  useEffect(() => {
    if (!graphSource) return;
    // Только структура + projectId (без saved_at): drag/autosave не пересобирает граф.
    // Позиции из source — ждём project.isFetched, чтобы не залипнуть на factory.
    const ver = `${projectId ?? "none"}|${workflowStructureKey(graphSource)}`;
    if (ver === graphVersion && nodes.length > 0) return;
    setGraphVersion(ver);
    const switched = lastGraphProjectRef.current !== projectId;
    lastGraphProjectRef.current = projectId;
    setNodes((prev) =>
      mergeGraphNodesWithRuntime(
        baseNodes as Node<PipelineNodeData>[],
        switched ? [] : prev,
        draggingNodeIdsRef.current,
      ) as Node<PipelineNodeData>[],
    );
    setEdges(baseEdges);
    if (switched && !canvasGraph?.saved_at && baseNodes.length > 0) {
      window.requestAnimationFrame(() => {
        reactFlowRef.current?.fitView({ padding: 0.12, maxZoom: 0.85, minZoom: 0.2 });
      });
    }
  }, [
    graphSource,
    baseNodes,
    baseEdges,
    graphVersion,
    nodes.length,
    projectId,
    setNodes,
    setEdges,
  ]);

  // excel_gpt: подтянуть inputSource/label из project.meta → data ноды (для V-меню).
  useEffect(() => {
    if (!project.data?.meta || nodes.length === 0) return;
    const configs = (project.data.meta as { excel_gpt_nodes?: Record<string, Record<string, unknown>> })
      .excel_gpt_nodes;
    if (!configs || !Object.keys(configs).length) return;
    setNodes((prev) => {
      let changed = false;
      const next = prev.map((n) => {
        const d = n.data as PipelineNodeData;
        if (d.type !== "excel_gpt") return n;
        const cfg = configs[n.id];
        if (!cfg) return n;
        const patch: Partial<PipelineNodeData> = {
          slotIndex: excelGptSlotIndex(n.id, (cfg.slotIndex as number | undefined) ?? d.slotIndex),
        };
        // label: canvas — source of truth. Не перетирать кастомное имя из meta
        // (resolve/default «Работа с GPT» / роль), иначе нода «переименовывается».
        if (cfg.inputSource && cfg.inputSource !== d.inputSource) {
          patch.inputSource = cfg.inputSource as PipelineNodeData["inputSource"];
        }
        if (cfg.uploadedFileName !== undefined && cfg.uploadedFileName !== d.uploadedFileName) {
          patch.uploadedFileName = cfg.uploadedFileName as string;
        }
        if (cfg.workMode && cfg.workMode !== d.workMode) {
          patch.workMode = cfg.workMode as PipelineNodeData["workMode"];
        }
        if (cfg.role && cfg.role !== d.role) {
          patch.role = cfg.role as string;
        }
        if (!Object.keys(patch).length) return n;
        changed = true;
        return { ...n, data: { ...d, ...patch } };
      });
      return changed ? next : prev;
    });
  }, [project.data?.meta, nodes.length, setNodes]);

  // Статусы run — NodeRun + лёгкий sync Project для линейных media
  // (не рисовать «прервано», пока Project.generating_* того же шага).
  useEffect(() => {
    if (nodes.length === 0) return;
    // Не сбрасываем в pending при кратковременном отсутствии run.data (refetch/invalidate)
    // и при пустом ответе ([] / объект без status): иначе node_runs.map падает.
    if (!formatRunOverlayLabel(run.data)) return;
    const projectStatus = project.data?.status;
    const meta = (project.data?.meta ?? {}) as Record<string, unknown>;
    const activeExcelGptKey =
      typeof meta.active_excel_gpt_node_key === "string"
        ? meta.active_excel_gpt_node_key
        : undefined;
    const completedExcelGptKeys = Array.isArray(meta.excel_gpt_completed_keys)
      ? meta.excel_gpt_completed_keys.map(String)
      : [];
    const nodeRunByKey = new Map(
      nodeRunsFromPayload<NodeRunDTO>(run.data).map((nr) => [nr.node_key, nr]),
    );
    setNodes((prev) =>
      prev.map((n) => {
        const nr = nodeRunByKey.get(n.id);
        if (!nr) {
          const status = inferNodeStatusFromProject(n.data.type, projectStatus);
          return {
            ...n,
            data: {
              ...n.data,
              status,
              progress: 0,
              progressText: null,
              updatedAt: null,
              error: null,
            },
          };
        }
        const status = reconcileNodeRunStatus(
          n.data.type,
          nr.status as PipelineNodeData["status"],
          projectStatus,
          {
            nodeKey: n.id,
            activeExcelGptKey,
            completedExcelGptKeys,
          },
        );
        const keepProgress = status === "running" || status === "waiting_hitl" || status === "failed";
        const progress = keepProgress ? (nr.progress ?? 0) : 0;
        const progressText = keepProgress ? (nr.progress_text ?? null) : null;
        return {
          ...n,
          data: {
            ...n.data,
            status,
            progress,
            progressText,
            updatedAt: nr.updated_at ?? null,
            error: nr.error ?? null,
            attempts: nr.attempts ?? 0,
            startedAt: nr.started_at ?? null,
            finishedAt: nr.finished_at ?? null,
          },
        };
      }),
    );
  }, [run.data, project.data?.status, project.data?.meta, setNodes, nodes.length, projectId]);

  // Выделение на канвасе ← selectedNodeKey (кнопка V без клика по телу ноды).
  useEffect(() => {
    setNodes((prev) => {
      const target = selectedNodeKey;
      const needsUpdate = prev.some(
        (n) => !!n.selected !== (target != null && n.id === target),
      );
      if (!needsUpdate) return prev;
      ignoreSelectionChangeRef.current += 1;
      return prev.map((n) => ({
        ...n,
        selected: target != null && n.id === target,
      }));
    });
  }, [selectedNodeKey, setNodes]);

  // WS: только по node_key — матч по node_type зажигал все ноды одного типа.
  useRunEvents(run.data?.id ?? null, (evt) => {
    if (
      typeof evt === "object" &&
      evt !== null &&
      (evt as { type?: string }).type === "node_status_changed"
    ) {
      const e = evt as { node_key?: string; to: string; error?: string | null };
      if (!e.node_key) return;
      setNodes((prev) =>
        prev.map((n) => {
          if (n.id !== e.node_key) return n;
          const meta = (project.data?.meta ?? {}) as Record<string, unknown>;
          const to = reconcileNodeRunStatus(
            n.data.type,
            e.to as PipelineNodeData["status"],
            project.data?.status,
            {
              nodeKey: n.id,
              activeExcelGptKey:
                typeof meta.active_excel_gpt_node_key === "string"
                  ? meta.active_excel_gpt_node_key
                  : undefined,
              completedExcelGptKeys: Array.isArray(meta.excel_gpt_completed_keys)
                ? meta.excel_gpt_completed_keys.map(String)
                : [],
            },
          );
          return {
            ...n,
            data: {
              ...n.data,
              status: to,
              progress: to === "running" ? n.data.progress : 0,
              progressText: to === "running" ? n.data.progressText : null,
              updatedAt: to === "running" ? n.data.updatedAt : null,
              // Мгновенно показываем ошибку из WS (не ждём refetch);
              // на успехе/сбросе — очищаем.
              error:
                e.error != null
                  ? e.error
                  : to === "done" || to === "pending" || to === "queued"
                    ? null
                    : n.data.error,
            },
          };
        }),
      );
    }
  });

  const scheduleSaveWorkflow = useCallback(() => {
    if (saveTimerRef.current != null) {
      window.clearTimeout(saveTimerRef.current);
    }
    // 1.2с: не спамить PATCH при серии drag (SQLite lock на Windows)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      window.dispatchEvent(new CustomEvent("canvas-save-workflow"));
    }, 1200);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns) as Node<PipelineNodeData>[]);
      // Тянутые ноды: пока их двигают, серверная позиция отстаёт — merge
      // не должен перетирать локальную (иначе нода прыгает назад).
      for (const c of changes) {
        if (c.type !== "position" || !("dragging" in c)) continue;
        if (c.dragging === true) {
          draggingNodeIdsRef.current.add(c.id);
        } else {
          draggingNodeIdsRef.current.delete(c.id);
        }
      }
      if (
        changes.some(
          (c) => c.type === "position" && "dragging" in c && c.dragging === false,
        )
      ) {
        scheduleSaveWorkflow();
      }
    },
    [setNodes, scheduleSaveWorkflow],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChangeInternal(changes);
      if (changes.some((c) => c.type === "remove" || c.type === "add")) {
        scheduleSaveWorkflow();
      }
    },
    [onEdgesChangeInternal, scheduleSaveWorkflow],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `e_${connection.source}_${connection.target}_${Date.now()}`,
            type: "thread",
            animated: true,
            style: { ...THREAD_EDGE_STYLE },
            data: { kind: "after" },
            label: edgeKindLabel("after"),
          },
          eds,
        ),
      );
      toast.message(t("canvas.toasts.edgeAdded"));
      scheduleSaveWorkflow();
    },
    [setEdges, scheduleSaveWorkflow, t],
  );

  const [saving, setSaving] = useState(false);
  const [selectedCount, setSelectedCount] = useState(0);
  const [hasClipboard, setHasClipboard] = useState(false);

  useEffect(() => {
    setHasClipboard(!!readCanvasClipboard()?.nodes.length);
  }, [projectId]);

  const persistWorkflow = useCallback(async () => {
    if (!workflow.data && !projectId) return;
    if (persistInFlightRef.current) {
      persistQueuedRef.current = true;
      return;
    }
    persistInFlightRef.current = true;
    setSaving(true);
    try {
      const currentNodes = nodesRef.current;
      const currentEdges = edgesRef.current;
      const wfNodes: WorkflowNode[] = assignExcelGptSlotIndices(
        currentNodes.map((n) => workflowNodeFromCanvas(n)),
      );
      const wfEdges: WorkflowEdge[] = currentEdges.map((e) => {
        const raw = String((e.data as { kind?: string } | undefined)?.kind || "after");
        const normalized =
          raw === "feed" || raw === "review"
            ? "after"
            : (["after", "gate", "pass", "fail"] as const).includes(
                  raw as "after" | "gate" | "pass" | "fail",
                )
              ? raw
              : "after";
        const kind: WorkflowEdgeKind = normalized as WorkflowEdgeKind;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? "out",
          targetHandle: e.targetHandle ?? "in",
          label: typeof e.label === "string" ? e.label : edgeKindLabel(kind),
          data: { ...((e.data as object) || {}), kind },
        };
      });
      const check = await api.validateWorkflow({ nodes: wfNodes, edges: wfEdges });
      if (!check.valid) {
        const cycle = (check.errors || []).find((e) => e.includes("цикл"));
        toast.error(
          cycle
            ? t("canvas.toasts.cycleDetected")
            : t("canvas.toasts.graphSaveError", { errors: check.errors.join("; ") }),
        );
        return;
      }
      const patches = Array.isArray(check.edge_patches) ? check.edge_patches : [];
      if (patches.length) {
        const kindById = new Map(
          patches.map((p) => [p.id, String(p.kind || "fail") as WorkflowEdgeKind]),
        );
        for (let i = 0; i < wfEdges.length; i++) {
          const kind = kindById.get(wfEdges[i].id);
          if (!kind) continue;
          wfEdges[i] = {
            ...wfEdges[i],
            label: edgeKindLabel(kind),
            data: { ...((wfEdges[i].data as object) || {}), kind },
          };
        }
        setEdges((prev) =>
          prev.map((e) => {
            const kind = kindById.get(e.id);
            if (!kind) return e;
            return {
              ...e,
              label: edgeKindLabel(kind),
              data: { ...((e.data as object) || {}), kind },
            };
          }),
        );
      }
      if (check.warnings.length) {
        const soft = check.warnings.find((w) => w.includes("Не ок") || w.includes("петля"));
        if (soft) toast.message(soft);
        else toast.message(check.warnings[0]);
      }
      if (projectId) {
        if (persistProjectIdRef.current !== projectId) return;
        // Только дельта: НЕ слать весь meta из кэша — иначе stale
        // gpt_operator_results/storage_nodes затирают результаты всех нод.
        const projectData = project.data ?? (await api.getProject(projectId));
        const prevMeta = (projectData.meta || {}) as Record<string, unknown>;
        const topics = Array.isArray(prevMeta.mass_excel_topics)
          ? (prevMeta.mass_excel_topics as string[])
          : [];
        const bindings = buildExcelLaneBindings(currentNodes, currentEdges, topics);
        const wfId = workflow.data?.id ?? defaultWorkflow?.id ?? 1;
        const meta: Record<string, unknown> = {
          canvas_graph: buildCanvasGraph(wfId, wfNodes, wfEdges),
          ai_control: true,
        };
        if (bindings.length) {
          meta.excel_lane_bindings = bindings;
        }
        if (persistProjectIdRef.current !== projectId) return;
        await api.patchProject(projectId, { meta });
        await qc.invalidateQueries({ queryKey: ["project", projectId] });
      } else if (workflow.data) {
        await api.saveWorkflow(workflow.data.id, {
          nodes: wfNodes,
          edges: wfEdges,
        });
      }
      toast.success(t("canvas.toasts.graphSaved"));
    } catch (e) {
      toast.error(t("canvas.toasts.saveFailed", { error: errorMessageFromUnknown(e) }));
    } finally {
      setSaving(false);
      persistInFlightRef.current = false;
      if (persistQueuedRef.current) {
        persistQueuedRef.current = false;
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("canvas-save-workflow"));
        }, 200);
      }
    }
  }, [workflow, projectId, project.data, qc, setEdges]);

  useEffect(() => {
    const onPatch = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          nodeKey: string;
          patch: Record<string, unknown>;
          globalText?: boolean;
        }>
      ).detail;
      if (!detail?.nodeKey) return;
      const patch = detail.patch;
      // Модель — per-step: патчим только целевую ноду (globalText игнорируется).
      setNodes((prev) => {
        const next = applyNodeDataPatch(prev, detail.nodeKey, patch);
        nodesRef.current = next;
        return next;
      });
      const isModelChange =
        patch.modelId != null ||
        patch.modelChannel != null ||
        patch.reasoningEffort != null;
      if (isModelChange) {
        // Сохраняем сразу, без 1.2с debounce: перезагрузка не должна терять выбор.
        if (saveTimerRef.current != null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("canvas-save-workflow"));
        }, 0);
      } else if (
        detail.patch.imageResolution != null ||
        detail.patch.imageQuality != null ||
        detail.patch.aspectRatio != null ||
        detail.patch.label != null ||
        detail.patch.description != null ||
        detail.patch.customBg != null ||
        detail.patch.reasoningEffort != null
      ) {
        scheduleSaveWorkflow();
      }
    };
    const onGlobalModel = (ev: Event) => {
      const detail = (ev as CustomEvent<{ modelId: string }>).detail;
      if (!detail?.modelId) return;
      // Глобальный дефолт не трогает ноды с явным выбором (modelPinned).
      setNodes((prev) =>
        applyGlobalTextModel(prev, detail.modelId, (n) =>
          isTextNodeType((n.data as PipelineNodeData).type),
        ),
      );
      scheduleSaveWorkflow();
    };

    window.addEventListener("canvas-patch-node-data", onPatch);
    window.addEventListener("canvas-patch-global-model", onGlobalModel);
    return () => {
      window.removeEventListener("canvas-patch-node-data", onPatch);
      window.removeEventListener("canvas-patch-global-model", onGlobalModel);
    };
  }, [setNodes, scheduleSaveWorkflow]);

  useEffect(() => {
    const onDetach = (ev: Event) => {
      const detail = (ev as CustomEvent<{ nodeKey: string; autoSave?: boolean }>).detail;
      const key = detail?.nodeKey;
      if (!key) return;
      setEdges((prev) => prev.filter((e) => e.source !== key && e.target !== key));
      if (detail?.autoSave) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("canvas-save-workflow"));
        }, 50);
      }
    };
    // Отсоединить только одну сторону ноды (in/out) — через крестик
    // на hover'е соединительного кружка.
    const onDetachHandle = (ev: Event) => {
      const detail = (ev as CustomEvent<{
        nodeKey: string;
        side: "in" | "out";
        autoSave?: boolean;
      }>).detail;
      const key = detail?.nodeKey;
      const side = detail?.side;
      if (!key || (side !== "in" && side !== "out")) return;
      setEdges((prev) =>
        prev.filter((e) =>
          side === "in" ? e.target !== key : e.source !== key,
        ),
      );
      if (detail?.autoSave) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("canvas-save-workflow"));
        }, 50);
      } else {
        toast.success(
          side === "in"
            ? t("canvas.toasts.incomingDisconnected")
            : t("canvas.toasts.outgoingDisconnected"),
        );
      }
    };
    const onDelete = (ev: Event) => {
      const detail = (ev as CustomEvent<{ nodeKey: string; autoSave?: boolean }>).detail;
      const key = detail?.nodeKey;
      if (!key) return;
      setNodes((prev) => prev.filter((n) => n.id !== key));
      setEdges((prev) => prev.filter((e) => e.source !== key && e.target !== key));
      if (detail?.autoSave) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("canvas-save-workflow"));
        }, 50);
      } else {
        toast.success(t("canvas.toasts.nodeDeletedSave"));
      }
    };
    const onSaveRequest = () => {
      void persistWorkflow();
    };
    window.addEventListener("canvas-detach-node", onDetach);
    window.addEventListener("canvas-detach-handle", onDetachHandle);
    window.addEventListener("canvas-delete-node", onDelete);
    window.addEventListener("canvas-save-workflow", onSaveRequest);
    return () => {
      window.removeEventListener("canvas-detach-node", onDetach);
      window.removeEventListener("canvas-detach-handle", onDetachHandle);
      window.removeEventListener("canvas-delete-node", onDelete);
      window.removeEventListener("canvas-save-workflow", onSaveRequest);
    };
  }, [setNodes, setEdges, persistWorkflow, t]);

  const deleteNodesByIds = useCallback(
    (ids: Set<string>, opts?: { toast?: boolean }) => {
      if (!ids.size) return;
      setNodes((prev) => prev.filter((n) => !ids.has(n.id)));
      setEdges((prev) =>
        prev.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
      );
      if (selectedNodeKey && ids.has(selectedNodeKey)) {
        onSelectNode(null);
      }
      selectedNodesRef.current = selectedNodesRef.current.filter((n) => !ids.has(n.id));
      setSelectedCount(selectedNodesRef.current.length);
      scheduleSaveWorkflow();
      if (opts?.toast !== false) {
        toast.success(
          ids.size === 1
            ? t("canvas.toasts.nodeDeleted")
            : t("canvas.toasts.nodesDeleted", { count: ids.size }),
        );
      }
    },
    [onSelectNode, scheduleSaveWorkflow, selectedNodeKey, setEdges, setNodes, t],
  );

  const copySelectedNodes = useCallback(() => {
    const selected = selectedNodesRef.current;
    if (!selected.length) {
      toast.error(t("canvas.toasts.selectNodesToCopy"));
      return;
    }
    const ids = new Set(selected.map((n) => n.id));
    const payload: CanvasClipboardPayload = {
      version: 1,
      sourceProjectId: projectId,
      copiedAt: Date.now(),
      nodes: selected.map((n) => {
        const wf = workflowNodeFromCanvas(n);
        return {
          id: wf.id,
          type: wf.type,
          position: wf.position,
          data: wf.data ?? {},
        };
      }),
      edges: edgesRef.current
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? "out",
          targetHandle: e.targetHandle ?? "in",
        })),
    };
    writeCanvasClipboard(payload);
    setHasClipboard(true);
    const edgesSuffix = payload.edges.length
      ? t("canvas.toasts.copiedEdgesSuffix", { count: payload.edges.length })
      : "";
    toast.success(
      t("canvas.toasts.copiedNodes", {
        nodes: selected.length,
        edges: edgesSuffix,
      }),
    );
  }, [projectId, t]);

  const pasteFromClipboard = useCallback(() => {
    const clip = readCanvasClipboard();
    if (!clip?.nodes.length) {
      toast.error(t("canvas.toasts.clipboardEmpty"));
      return;
    }
    const stamp = Date.now();
    const idMap = new Map<string, string>();
    clip.nodes.forEach((n, idx) => {
      idMap.set(n.id, `n_${n.type}_${stamp}_${idx}`);
    });
    const excelRemap: Record<string, string> = {};
    clip.nodes.forEach((n) => {
      if (n.type !== "excel_gpt") return;
      const newId = idMap.get(n.id);
      if (newId) excelRemap[n.id] = newId;
    });
    const offsetX = 56;
    const offsetY = 56;
    // Слоты заняты уже существующими нодами «ИИ-редактор сцен»: вставленная
    // нода копирует слот оригинала → две ноды в одном слоте. Даём вставленным
    // нодам свободные слоты по очереди (как новым нодам на холсте).
    const occupiedSlots = new Set<number>();
    for (const n of nodes) {
      const d = n.data as PipelineNodeData;
      if (d.type !== "excel_gpt" || d.sdAgent || d.slotOverflow) continue;
      const slot = d.slotIndex;
      if (typeof slot === "number" && slot >= 1 && slot <= 5) occupiedSlots.add(slot);
    }
    const freeSlots = [1, 2, 3, 4, 5].filter((s) => !occupiedSlots.has(s));
    let freeSlotIdx = 0;
    /** Следующий свободный слот для вставленной excel-ноды (undefined — слотов нет). */
    const takeFreeSlot = (): number | undefined => {
      const slot = freeSlots[freeSlotIdx];
      if (slot === undefined) return undefined;
      freeSlotIdx += 1;
      return slot;
    };
    /** Слот, выданный каждой вставленной excel-ноде (для meta.excel_gpt_nodes). */
    const pastedSlotById = new Map<string, number | undefined>();
    const newNodes: Node<PipelineNodeData>[] = clip.nodes.map((n) => {
      const newId = idMap.get(n.id)!;
      const srcData = (n.data ?? {}) as Partial<PipelineNodeData>;
      const isExcelGpt =
        srcData.type === "excel_gpt" &&
        typeof srcData.sdAgent !== "string" &&
        srcData.slotOverflow !== true;
      const pastedSlot = isExcelGpt ? takeFreeSlot() : undefined;
      return {
        id: newId,
        type: "pipeline",
        position: {
          x: n.position.x + offsetX,
          y: n.position.y + offsetY,
        },
        data: {
          nodeKey: newId,
          type: n.type,
          label: (srcData.label as string | undefined) ?? (n.data?.label as string | undefined),
          description: srcData.description ?? (n.data?.description as string | undefined),
          // Слот не копируем (иначе дубль слота) — вставленная нода
          // получает свободный слот; undefined — слотов не осталось (overflow).
          slotIndex: isExcelGpt
            ? pastedSlot
            : ((srcData.slotIndex as number | undefined) ?? (n.data?.slotIndex as number | undefined)),
          inputSource: (srcData.inputSource as PipelineNodeData["inputSource"]) ??
            (n.data?.inputSource as PipelineNodeData["inputSource"]),
          uploadedFileName:
            (srcData.uploadedFileName as string | undefined) ??
            (n.data?.uploadedFileName as string | undefined),
          workMode:
            (srcData.workMode as PipelineNodeData["workMode"]) ??
            (n.data?.workMode as PipelineNodeData["workMode"]),
          modelId:
            (srcData.modelId as string | undefined) ??
            (n.data?.modelId as string | undefined) ??
            defaultModelIdForNodeType(n.type),
          modelChannel: "stable",
          status: "pending",
          progress: 0,
          progressText: null,
          error: null,
          attempts: 0,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        selected: true,
      };
    });
    const newEdges: Edge[] = clip.edges.map((e, idx) => ({
      id: `e_paste_${stamp}_${idx}`,
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
      sourceHandle: e.sourceHandle ?? "out",
      targetHandle: e.targetHandle ?? "in",
      type: "thread",
      animated: true,
      style: { ...THREAD_EDGE_STYLE },
    }));
    for (const n of newNodes) {
      const d = n.data as PipelineNodeData;
      if (d.type === "excel_gpt") pastedSlotById.set(n.id, d.slotIndex);
    }
    setNodes((prev) => [
      ...prev.map((n) => ({ ...n, selected: false })),
      ...newNodes,
    ]);
    setEdges((prev) => [...prev, ...newEdges]);
    selectedNodesRef.current = newNodes;
    setSelectedCount(newNodes.length);
    if (newNodes[0]) {
      onSelectNode((newNodes[0].data as PipelineNodeData).nodeKey);
    }
    if (projectId && Object.keys(excelRemap).length > 0) {
      void api.remapExcelGptNodes(projectId, excelRemap).catch((e) => {
        toast.error(t("canvas.toasts.excelMigrateError", { error: errorMessageFromUnknown(e) }));
      });
      for (const [oldId, newId] of Object.entries(excelRemap)) {
        const src = clip.nodes.find((n) => n.id === oldId);
        const cfg = (src?.data ?? {}) as Record<string, unknown>;
        void api
          .patchExcelGptConfig(projectId, newId, {
            label: cfg.label as string | undefined,
            inputSource: cfg.inputSource as string | undefined,
            uploadedFileName: cfg.uploadedFileName as string | undefined,
            // Слот оригинала не переносим: он уже занят оригиналом.
            // Ключ карты — НОВЫЙ id вставленной ноды (excelRemap: old → new).
            slotIndex: cfg.slotIndex === undefined ? undefined : pastedSlotById.get(newId),
            workMode: cfg.workMode as string | undefined,
          })
          .catch(() => undefined);
      }
    }
    scheduleSaveWorkflow();
    const fromOther =
      clip.sourceProjectId != null &&
      projectId != null &&
      clip.sourceProjectId !== projectId;
    toast.success(
      fromOther
        ? t("canvas.toasts.pastedFromProject", {
            count: newNodes.length,
            projectId: clip.sourceProjectId ?? 0,
          })
        : t("canvas.toasts.pastedNodes", { count: newNodes.length }),
    );
  }, [onSelectNode, projectId, scheduleSaveWorkflow, setEdges, setNodes, t]);

  const deleteSelectedNodes = useCallback(() => {
    const selected = selectedNodesRef.current;
    if (!selected.length && selectedNodeKey) {
      deleteNodesByIds(new Set([selectedNodeKey]));
      return;
    }
    if (!selected.length) {
      toast.error(t("canvas.toasts.selectNodesToCopy"));
      return;
    }
    deleteNodesByIds(new Set(selected.map((n) => n.id)));
  }, [deleteNodesByIds, selectedNodeKey, t]);

  useEffect(() => {
    if (!projectId) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isEditableTarget(ev.target)) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === "c") {
        ev.preventDefault();
        copySelectedNodes();
        return;
      }
      if (mod && ev.key.toLowerCase() === "v") {
        ev.preventDefault();
        pasteFromClipboard();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [projectId, copySelectedNodes, pasteFromClipboard]);

  const addNode = useCallback(
    (type: string) => {
      const id = `n_${type}_${Date.now()}`;
      const spec = getNodeSpec(type);
      // scene-агенты (sdAgent) слоты enrich не занимают — не считаем их.
      const excelCount = nodes.filter(
        (n) =>
          (n.data as PipelineNodeData).type === "excel_gpt" &&
          !(n.data as PipelineNodeData).sdAgent,
      ).length;

      let position = { x: 120, y: 200 };
      const rf = reactFlowRef.current;
      const pane = paneRef.current;
      if (rf && pane) {
        const rect = pane.getBoundingClientRect();
        position = rf.screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        position.x -= 110;
        position.y -= 36;
      }

      const newNode: Node<PipelineNodeData> = {
        id,
        type: "pipeline",
        position,
        data: {
          nodeKey: id,
          type,
          label: spec.label,
          ...(type === "excel_gpt"
            ? { slotIndex: Math.min(excelCount + 1, 5) }
            : {}),
          modelId: defaultModelIdForNodeType(type),
          modelChannel: "stable",
          status: "pending",
          progress: 0,
          progressText: null,
          error: null,
          attempts: 0,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
      setNodes((prev) => [...prev, newNode]);
      nodesRef.current = [...nodesRef.current, newNode];
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void persistWorkflow();
      toast.message(`Добавлена нода: ${spec.label}`);
    },
    [nodes, setNodes, persistWorkflow],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      const ids = new Set(deleted.map((n) => n.id));
      setEdges((prev) =>
        prev.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
      );
      selectedNodesRef.current = selectedNodesRef.current.filter(
        (n) => !ids.has(n.id),
      );
      setSelectedCount(selectedNodesRef.current.length);
      if (selectedNodeKey && ids.has(selectedNodeKey)) {
        onSelectNode(null);
      }
      scheduleSaveWorkflow();
      toast.success(
        deleted.length === 1
          ? t("canvas.toasts.nodeDeleted")
          : t("canvas.toasts.nodesDeleted", { count: deleted.length }),
      );
    },
    [onSelectNode, scheduleSaveWorkflow, selectedNodeKey, setEdges, t],
  );

  const canvasBootLoading =
    (workflows.isLoading && !workflows.data) ||
    (Boolean(defaultWorkflow) && workflow.isLoading && !workflow.data);
  if (canvasBootLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (workflows.isError) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <h3 className="text-sm font-semibold text-destructive">
            {t("canvas.emptyState.backendUnreachable")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("canvas.emptyState.backendStartCmd", { cmd: "python -m app.main" })}
          </p>
        </div>
      </div>
    );
  }

  // Пустой выбор → онбординг.
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState />
      </div>
    );
  }

  return (
    <>
      <div ref={paneRef} className="relative h-full w-full">
      <ReactFlow
        key={projectId ?? "none"}
        className="neural-flow"
        nodes={nodes}
        edges={edges}
        onInit={(inst) => {
          reactFlowRef.current = inst;
          if (projectId != null) {
            const vp = readPipelineViewport(projectId);
            if (vp) inst.setViewport(vp, { duration: 0 });
          }
        }}
        onMoveEnd={(_event, vp) => {
          if (projectId != null) writePipelineViewport(projectId, vp);
        }}
        defaultViewport={savedViewport ?? undefined}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView={!canvasGraph?.saved_at}
        fitViewOptions={{ padding: 0.12, maxZoom: 0.85, minZoom: 0.2 }}
        minZoom={0.15}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable
        edgesReconnectable
        nodeDragThreshold={4}
        selectNodesOnDrag={false}
        selectionOnDrag={false}
        panOnDrag={[0, 1]}
        multiSelectionKeyCode={["Control", "Meta"]}
        selectionKeyCode={null}
        onPaneContextMenu={(e) => e.preventDefault()}
        onConnect={onConnect}
        connectionLineType={ConnectionLineType.Bezier}
        connectionLineStyle={{
          strokeDasharray: "5 6",
          stroke: "rgba(255, 255, 255, 0.6)",
          strokeWidth: 2,
          strokeLinecap: "round",
        }}
        edgeTypes={edgeTypes}
        elementsSelectable
        deleteKeyCode={["Backspace", "Delete"]}
        onNodesDelete={onNodesDelete}
        onNodeDoubleClick={(ev, node) => {
          if (inlineClickTimerRef.current) {
            window.clearTimeout(inlineClickTimerRef.current);
            inlineClickTimerRef.current = null;
          }
          const t = ev.target as HTMLElement;
          if (t.closest(".node-v-trigger") || t.closest(".node-v-menu") || t.closest("button")) return;
          const d = node.data as PipelineNodeData;
          window.dispatchEvent(
            new CustomEvent("studio-open-node-prompts", {
              detail: { nodeKey: d.nodeKey, initialTab: "settings", nodeData: d },
            }),
          );
        }}
        onNodeClick={(ev, node) => {
          const t = ev.target as HTMLElement | null;
          if (
            !t ||
            ev.detail > 1 ||
            t.closest?.(
              "button, input, textarea, select, a, label, [role=switch], .react-flow__handle, .node-v-trigger, .node-v-menu, .node-ai-review-trigger"
            )
          ) {
            return;
          }
          const d = node.data as PipelineNodeData;
          onSelectNode(d.nodeKey);
          const handled = onNodeActivate?.(d.nodeKey, d.type);
          if (handled) {
            if (inlineClickTimerRef.current) {
              window.clearTimeout(inlineClickTimerRef.current);
              inlineClickTimerRef.current = null;
            }
            return;
          }
          if (inlineClickTimerRef.current) window.clearTimeout(inlineClickTimerRef.current);
          inlineClickTimerRef.current = window.setTimeout(() => {
            inlineClickTimerRef.current = null;
            window.dispatchEvent(
              new CustomEvent("studio-open-node-prompts", {
                detail: { nodeKey: d.nodeKey, initialTab: "settings", nodeData: d },
              }),
            );
          }, 0);
        }}
        onSelectionChange={(sel) => {
          selectedNodesRef.current = sel.nodes as Node<PipelineNodeData>[];
          setSelectedCount(sel.nodes.length);
          if (ignoreSelectionChangeRef.current > 0) {
            ignoreSelectionChangeRef.current -= 1;
            return;
          }
          // Мультивыделение (marquee правой кнопкой): не сводить к одной ноде —
          // onSelectNode(first) переключил бы selectedNodeKey, а эффект синка
          // выделения стёр бы остальные. Инспектор keeps последнюю одиночную.
          if (sel.nodes.length > 1) {
            return;
          }
          const first = sel.nodes[0];
          if (first) {
            onSelectNode((first.data as PipelineNodeData).nodeKey);
          } else if (sel.nodes.length === 0) {
            onSelectNode(null);
          }
        }}
        defaultEdgeOptions={{
          type: "thread",
          animated: true,
          style: { ...THREAD_EDGE_STYLE },
        }}
      >
        <Background
          color="hsl(var(--canvas-grid))"
          gap={20}
          size={1}
          variant={BackgroundVariant.Dots}
        />
        {onCanvasZoom ? <ViewportZoomReporter onZoom={onCanvasZoom} /> : null}
        <GroupFrames />
        {/* edge kind labels removed */}
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          style={{ width: 172, height: 116 }}
          bgColor="#0c0c0e"
          maskColor="rgba(0, 0, 0, 0.65)"
          maskStrokeColor="rgba(255, 255, 255, 0.45)"
          maskStrokeWidth={1.5}
          nodeStrokeWidth={1.5}
          nodeBorderRadius={3}
          nodeStrokeColor={(node) => {
            const data = node.data as PipelineNodeData;
            if (data?.status === "done") return "#16a34a";
            if (data?.status === "running" || data?.status === "waiting_hitl" || data?.status === "queued") return "#d97706";
            if (data?.status === "failed") return "#dc2626";
            return "rgba(255, 255, 255, 0.4)";
          }}
          nodeColor={(node) => {
            const data = node.data as PipelineNodeData;
            if (data?.status === "done") return "#22c55e"; // Зеленый (готово)
            if (data?.status === "running" || data?.status === "waiting_hitl" || data?.status === "queued") return "#f59e0b"; // Оранжевый (в процессе / ожидание)
            if (data?.status === "failed") return "#ef4444"; // Красный (ошибка)
            return "#ffffff"; // Белый (по умолчанию / готов к запуску)
          }}
        />
        <RightButtonMarquee />
      </ReactFlow>
      </div>
      <WorkflowToolbar
        workflowId={workflow.data?.id}
        projectId={projectId}
        onSave={persistWorkflow}
        saving={saving}
        onAddNode={addNode}
        getSelectedNodeIds={() => selectedNodesRef.current.map((n) => n.id)}
        onCopy={copySelectedNodes}
        onPaste={pasteFromClipboard}
        canPaste={hasClipboard}
        onDelete={deleteSelectedNodes}
        canDelete={selectedCount > 0 || !!selectedNodeKey}
        onAddExcelFeed={() => {
          const stamp = Date.now();
          const id = `excel_feed_${stamp}`;
          const minX = nodes.reduce((m, n) => Math.min(m, n.position.x), 0);
          const minY = nodes.reduce((m, n) => Math.min(m, n.position.y), 0);
          setNodes((prev) => [
            ...prev,
            {
              id,
              type: "pipeline",
              position: { x: minX - 320, y: minY },
              data: {
                nodeKey: id,
                type: "excel_feed",
                modelId: defaultModelIdForNodeType("excel_feed"),
                modelChannel: "stable",
                status: "pending",
                progress: 0,
                progressText: null,
                error: null,
                attempts: 0,
              },
              sourcePosition: Position.Right,
              targetPosition: Position.Left,
            } as Node<PipelineNodeData>,
          ]);
          scheduleSaveWorkflow();
          toast.success(t("canvas.toasts.excelNodeAdded"));
        }}
        onDuplicateBelow={() => {
          if (nodes.length === 0) return;
          const offsetY = 480;
          const stamp = Date.now();
          const idMap = new Map<string, string>();
          const clones = nodes
            .filter((n) => (n.data as PipelineNodeData).type !== "excel_feed")
            .map((n) => {
              const newId = `${n.id}_lane_${stamp}`;
              idMap.set(n.id, newId);
              const d = n.data as PipelineNodeData;
              return {
                ...n,
                id: newId,
                position: { x: n.position.x, y: n.position.y + offsetY },
                data: { ...d, nodeKey: newId },
                selected: false,
              };
            });
          const cloneEdges = edges
            .filter(
              (e) =>
                idMap.has(e.source) &&
                idMap.has(e.target) &&
                (nodes.find((n) => n.id === e.source)?.data as PipelineNodeData)?.type !==
                  "excel_feed",
            )
            .map((e) => ({
              ...e,
              id: `${e.id}_lane_${stamp}`,
              source: idMap.get(e.source) ?? e.source,
              target: idMap.get(e.target) ?? e.target,
              type: "thread",
              animated: true,
              style: { ...THREAD_EDGE_STYLE },
            }));
          const excelNode = nodes.find(
            (n) => (n.data as PipelineNodeData).type === "excel_feed",
          );
          const excelEdges: Edge[] = [];
          if (excelNode) {
            for (const p of clones) {
              const dt = (p.data as PipelineNodeData).type;
              if (dt === "plan" || dt === "topic") {
                excelEdges.push({
                  id: `excel_${stamp}_${p.id}`,
                  source: excelNode.id,
                  target: p.id,
                  type: "thread",
                  animated: true,
                  style: { ...THREAD_EDGE_STYLE },
                  className: "excel-lane-edge",
                });
              }
            }
          }
          setNodes((prev) => [...prev, ...clones]);
          setEdges((prev) => [...prev, ...cloneEdges, ...excelEdges]);
          scheduleSaveWorkflow();
          toast.success(
            excelEdges.length
              ? t("canvas.toasts.graphDuplicatedEdges", { count: excelEdges.length })
              : t("canvas.toasts.graphDuplicatedDown"),
          );
        }}
      />
      <RunOverlay
        projectId={projectId}
        project={project.data ?? null}
        workflow={workflow.data ?? null}
        run={run.data ?? null}
        onRunCreated={() => run.refetch()}
      />
    </>
  );
}

function WorkflowToolbar({
  workflowId,
  projectId,
  onSave,
  saving,
  onAddNode,
  getSelectedNodeIds,
  onCopy,
  onPaste,
  canPaste,
  onDelete,
  canDelete,
  onDuplicateBelow,
  onAddExcelFeed,
}: {
  workflowId?: number;
  projectId?: number | null;
  onSave: () => Promise<void> | void;
  saving: boolean;
  onAddNode: (type: string) => void;
  getSelectedNodeIds: () => string[];
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
  onDelete: () => void;
  canDelete: boolean;
  onDuplicateBelow: () => void;
  onAddExcelFeed: () => void;
}) {
  const qc = useQueryClient();
  const { t } = useTranslation();

  const duplicateWf = async () => {
    if (!workflowId) return;
    try {
      await api.duplicateWorkflow(workflowId);
      await qc.invalidateQueries({ queryKey: ["workflows"] });
      toast.success(t("canvas.toasts.workflowCopiedServer"));
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    }
  };

  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-10 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap gap-2">
      <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-card/90 p-1 backdrop-blur-md shadow-md">
        <NodePalette
          projectId={projectId ?? null}
          onAddNode={onAddNode}
          getSelectedNodeIds={getSelectedNodeIds}
          onPersistCanvas={onSave}
        />
        <div className="h-4 w-px bg-white/10" />
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs hover:bg-white/5"
          onClick={onPaste}
          disabled={!canPaste}
          title={t("canvas.toolbar.pasteCopied")}
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
        </Button>
        <div className="h-4 w-px bg-white/10" />
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs hover:bg-white/5"
          onClick={onDuplicateBelow}
          title={t("canvas.toolbar.duplicateGraph")}
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
          disabled={!canDelete}
          title={t("canvas.toolbar.deleteSelected")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-md flex-col items-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Play className="h-5 w-5 text-primary" />
      </div>
      <h2 className="text-lg font-semibold tracking-tight">{t("canvas.emptyState.selectProject")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("canvas.emptyState.selectProjectDesc")}
      </p>
    </div>
  );
}

function RunOverlay({
  projectId,
  project,
  workflow,
  run,
  onRunCreated,
}: {
  projectId: number;
  project: import("@/lib/types").ProjectDetail | null;
  workflow: WorkflowDetail | null;
  run: WorkflowRunDetail | null;
  onRunCreated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [pausing, setPausing] = useState(false);
  const qc = useQueryClient();
  const { t } = useTranslation();

  if (!workflow) return null;

  const isRunning = shouldShowStopBar(
    project?.status,
    project?.generation_active,
  );

  const handlePause = async () => {
    setPausing(true);
    try {
      await api.pauseProject(projectId);
      toast.success(t("canvas.toasts.projectPaused"));
      onRunCreated();
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setPausing(false);
    }
  };

  const handleResume = async () => {
    setPausing(true);
    try {
      const r = await api.continueProject(projectId);
      if (r.advanced) {
        toast.success(t("canvas.toasts.nextStep", { step: r.status }));
      } else if (r.action === "resumed") {
        toast.success(t("canvas.toasts.projectResumed"));
      } else {
        toast.message(t("canvas.toasts.noStepAdvance"));
      }
      onRunCreated();
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setPausing(false);
    }
  };

  const handleStopProject = async () => {
    setBusy(true);
    try {
      const r = await api.stopProject(projectId);
      toast.success(r.message || t("canvas.toasts.stepStopped"));
      qc.invalidateQueries({ queryKey: ["project-run", projectId] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      await qc.refetchQueries({ queryKey: ["project", projectId] });
      await qc.refetchQueries({ queryKey: ["project-run", projectId] });
      qc.invalidateQueries({ queryKey: ["runs"] });
      onRunCreated();
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setBusy(false);
    }
  };

  const controls = (
    <div className="flex flex-col gap-2.5 border-b border-white/10 pb-3">
      <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("canvas.toolbar.runLabel")}</span>
          <span className="font-medium">
            {formatRunOverlayLabel(run, project?.status) ?? t("canvas.toolbar.notRunning")}
          </span>
        </div>
      {project ? (
        <div>
          <div>
            <AutoAdvanceToggle project={project} />
          </div>
        </div>
      ) : null}

      {/* Верхняя компактная панель управления процессом */}
      <div className="flex flex-wrap items-center gap-2">
        

        {isRunning ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={handlePause}
              disabled={pausing}
              className="pointer-events-auto gap-1 text-xs border-white/20 bg-zinc-800/80 hover:bg-zinc-700"
            >
              {pausing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("canvas.toolbar.pause")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleStopProject}
              disabled={busy}
              className="pointer-events-auto gap-1.5 text-xs font-semibold shadow-lg shadow-red-500/25 bg-red-600 hover:bg-red-500 text-white"
              title={t("canvas.toolbar.stopStepTitle")}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3 fill-current" />}
              {t("canvas.toolbar.stopStep")}
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleResume}
              disabled={pausing}
              className="pointer-events-auto transition-all duration-200 gap-2 h-9 px-4 font-semibold text-xs bg-[#2bb8a0]/20 hover:bg-[#2bb8a0]/30 text-[#bff3e8] active:scale-[0.98] border border-[#2bb8a0]/35 rounded-xl backdrop-blur-md"
              title={t("canvas.toolbar.resumeTitle")}
            >
              {pausing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-200" /> : <Play className="h-3.5 w-3.5 fill-current" />}
              {t("canvas.toolbar.resume")}
            </Button>
            {project?.status && project.status !== "new" && project.status !== "published" && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleStopProject}
                disabled={busy}
                className="pointer-events-auto gap-1 text-xs border-white/10 text-muted-foreground hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400"
                title={t("canvas.toolbar.stopTitle")}
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3 fill-current text-destructive/80" />}
                {t("canvas.toolbar.stop")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
  return <PortalTo id="vp-right-controls">{controls}</PortalTo>;
}

function PortalTo({ id, children }: { id: string; children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const pick = () => {
      const e = document.getElementById(id);
      setEl((prev) => (prev === e ? prev : e));
    };
    pick();
    const t = window.setInterval(pick, 400);
    return () => window.clearInterval(t);
  }, [id]);
  return el ? createPortal(children, el) : null;
}

function workflowToReactFlowNodes(
  wf: WorkflowDetail,
  run: WorkflowRunDetail | null
): Node<PipelineNodeData>[] {
  const nodeRunByKey = new Map<string, NodeRunDTO>();
  for (const nr of nodeRunsFromPayload<NodeRunDTO>(run)) {
    if (nr && typeof nr.node_key === "string") nodeRunByKey.set(nr.node_key, nr);
  }
  const migrated = migrateWorkflowNodes(wf.nodes);
  return migrated.map((n) => {
    const nr = nodeRunByKey.get(n.id);
    const spec = getNodeSpec(n.type);
    const data = (n.data ?? {}) as Record<string, unknown>;
    return {
      id: n.id,
      type: "pipeline",
      position: n.position,
      data: {
        nodeKey: n.id,
        type: n.type,
        label: (typeof data.label === "string" && data.label.trim()) || spec.label,
        description: (data.description as string | undefined) ?? spec.description,
        slotIndex: data.slotIndex as number | undefined,
        slotOverflow: data.slotOverflow === true ? true : undefined,
        inputSource: data.inputSource as PipelineNodeData["inputSource"],
        uploadedFileName: data.uploadedFileName as string | undefined,
        workMode: data.workMode as PipelineNodeData["workMode"],
        role: data.role as string | undefined,
        agent: data.agent as string | undefined,
        sdAgent: (data.sd_agent ?? data.agent) as string | undefined,
        groupId: data.groupId as string | undefined,
        groupTitle: data.groupTitle as string | undefined,
        customBg: typeof data.customBg === "string" && data.customBg.trim() ? data.customBg.trim() : undefined,
        modelId: (typeof data.modelId === "string" && data.modelId.trim())
          ? data.modelId.trim()
          : defaultModelIdForNodeType(n.type),
        modelChannel: "stable",
        imageResolution:
          typeof data.imageResolution === "string" && data.imageResolution.trim()
            ? data.imageResolution.trim()
            : undefined,
        imageQuality:
          typeof data.imageQuality === "string" && data.imageQuality.trim()
            ? data.imageQuality.trim()
            : undefined,
        aspectRatio:
          typeof data.aspectRatio === "string" && data.aspectRatio.trim()
            ? data.aspectRatio.trim()
            : undefined,
        reasoningEffort:
          typeof data.reasoningEffort === "string" && data.reasoningEffort.trim()
            ? data.reasoningEffort.trim()
            : undefined,
        status: (nr?.status ?? "pending") as PipelineNodeData["status"],
        progress: nr?.progress ?? 0,
        progressText: nr?.progress_text ?? null,
        updatedAt: nr?.updated_at ?? null,
        error: nr?.error ?? null,
        attempts: nr?.attempts ?? 0,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });
}

function workflowToReactFlowEdges(wf: WorkflowDetail): Edge[] {
  return wf.edges.map((e) => {
    const kind =
      (e.data?.kind as string | undefined) ||
      ((e as { kind?: string }).kind as string | undefined) ||
      "after";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      type: "thread",
      animated: true,
      style: { ...THREAD_EDGE_STYLE },
      label: e.label ?? edgeKindLabel(kind),
      data: { ...(e.data || {}), kind },
    };
  });
}

function ViewportZoomReporter({ onZoom }: { onZoom: (zoom: number) => void }) {
  const zoom = useStore((s) => s.transform[2]);
  useEffect(() => {
    onZoom(zoom);
  }, [zoom, onZoom]);
  return null;
}

// Re-export для удобства внешних компонентов.
export { Handle, Position };
