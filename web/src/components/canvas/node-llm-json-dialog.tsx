"use client";

/**
 * Полный JSON ответа ЛЛМ — отображается прямо внутри «Результатов» ноды и
 * только после нажатия кнопки «JSON ответа» (переключатель в шапке панели).
 *
 * Отдельного окна/модала нет: это обычный блок контента диалога результатов.
 * Источники: файл результата ноды из meta (shots.json, plan_scenes.json и т.п.),
 * иначе gpt_reply.txt, поле проекта (plan/script) или JSON из meta (sfx_plan).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Braces, Copy, Download, Loader2, RotateCcw, Save, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { errorMessageFromUnknown } from "@/lib/error-message";
import {
  nodeLlmJson,
  prettyJsonOrRaw,
  tryPrettyJson,
  type NodeLlmDocument,
} from "@/lib/node-llm-json";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const DOCS_KEY = "node-llm-docs";

export function NodeLlmJsonPanel({
  projectId,
  nodeKey,
  nodeType,
  active,
  snapshot,
}: {
  projectId: number;
  nodeKey?: string | null;
  nodeType?: string | null;
  active: boolean;
  snapshot?: unknown;
}) {
  const qc = useQueryClient();
  const docs = useQuery({
    queryKey: [DOCS_KEY, projectId, nodeKey],
    queryFn: () => nodeLlmJson.documents(projectId, nodeKey!),
    enabled: active && Boolean(nodeKey) && projectId > 0,
    staleTime: 15_000,
    retry: false,
  });

  // Полный JSON результата ноды — для нод без файла ответа на диске: у любой
  // ноды есть результат, и его видно целиком прямо в этом окне.
  const snapshotJson = useMemo(() => {
    if (snapshot === undefined || snapshot === null) return "";
    try {
      const json = JSON.stringify(snapshot, null, 2);
      return json && json !== "{}" && json !== "null" ? json : "";
    } catch {
      return "";
    }
  }, [snapshot]);

  const documents = useMemo<NodeLlmDocument[]>(() => {
    const files = docs.data?.documents ?? [];
    if (files.length) return files;
    if (!snapshotJson) return [];
    return [
      {
        id: "snapshot",
        name: `${nodeType || nodeKey || "node"}-result.json`,
        label: "Результат ноды (JSON)",
        kind: "snapshot",
        path: null,
        size: snapshotJson.length,
        updatedAt: null,
        isJson: true,
        exists: true,
        editable: true,
      },
    ];
  }, [docs.data, snapshotJson, nodeKey, nodeType]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [baseline, setBaseline] = useState("");
  const [baselineDocId, setBaselineDocId] = useState<string | null>(null);
  const [busyUpload, setBusyUpload] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Активный документ: первый (полный результат ноды) или прежний.
  useEffect(() => {
    if (!active) return;
    if (!documents.length) {
      setActiveId(null);
      return;
    }
    setActiveId((prev) =>
      prev && documents.some((d) => d.id === prev) ? prev : documents[0].id,
    );
  }, [active, documents]);

  const activeDoc = documents.find((d) => d.id === activeId) ?? null;
  const isSnapshot = activeId === "snapshot";

  const docQuery = useQuery({
    queryKey: ["node-llm-doc", projectId, nodeKey, activeId],
    queryFn: () => nodeLlmJson.document(projectId, nodeKey!, activeId!),
    enabled: active && Boolean(nodeKey) && Boolean(activeId) && !isSnapshot,
    staleTime: 10_000,
    retry: false,
  });

  // Текст с сервера: новый документ — всегда; тот же — только если правок нет.
  useEffect(() => {
    if (isSnapshot) {
      if (baselineDocId !== "snapshot") {
        setBaselineDocId("snapshot");
        setBaseline(snapshotJson);
        setText(snapshotJson);
      }
      return;
    }
    const data = docQuery.data;
    if (!data || !activeId || data.id !== activeId) return;
    if (baselineDocId !== data.id) {
      const shown = prettyJsonOrRaw(data.text);
      setBaselineDocId(data.id);
      setBaseline(shown);
      setText(shown);
      return;
    }
    if (text.trimEnd() === baseline.trimEnd()) {
      const shown = prettyJsonOrRaw(data.text);
      setBaseline(shown);
      setText(shown);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docQuery.data, activeId, isSnapshot, snapshotJson]);

  const dirty = Boolean(activeDoc) && text.trimEnd() !== baseline.trimEnd();

  const save = useMutation({
    // Правка JSON результата без файла сохраняется как ответ ноды (gpt_reply.txt).
    mutationFn: () =>
      nodeLlmJson.save(projectId, nodeKey!, isSnapshot ? "file:gpt_reply.txt" : activeId!, text),
    onSuccess: (res) => {
      setBaseline(text);
      setBaselineDocId(res.id);
      const cached = docQuery.data;
      if (cached) {
        qc.setQueryData(["node-llm-doc", projectId, nodeKey, res.id], {
          ...cached,
          text,
          chars: text.length,
          size: res.size,
          exists: true,
          updatedAt: res.savedAt,
        });
      }
      qc.invalidateQueries({ queryKey: [DOCS_KEY, projectId, nodeKey] });
      // Сохранённый вручную ответ сразу становится таблицей результата.
      qc.invalidateQueries({ queryKey: ["node-tables", projectId, nodeKey] });
      qc.invalidateQueries({ queryKey: ["gpt-operator-resolve", projectId, nodeKey] });
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success(`Сохранено: ${res.name}`);
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const pickDoc = (doc: NodeLlmDocument) => {
    if (doc.id === activeDoc?.id) return;
    if (dirty && !window.confirm("Есть несохранённые правки. Переключить документ без сохранения?")) {
      return;
    }
    setActiveId(doc.id);
  };

  const download = () => {
    const name = activeDoc?.name || `${nodeKey || "node"}-llm-json.txt`;
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("JSON скопирован");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  const formatJson = () => {
    const pretty = tryPrettyJson(text);
    if (pretty === null) {
      toast.error("Это не JSON — форматировать нечего");
      return;
    }
    setText(pretty);
  };

  const onUploadFile = async (file: File) => {
    setBusyUpload(true);
    try {
      const raw = await file.text();
      setText(prettyJsonOrRaw(raw));
      toast.info(`Файл «${file.name}» загружен в редактор — нажми «Сохранить»`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setBusyUpload(false);
    }
  };

  if (!active) return null;

  const loading = docQuery.isLoading || docs.isLoading;
  const empty = !documents.length && !docs.isLoading;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {documents.length > 1 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {documents.map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => pickDoc(doc)}
              title={doc.path || doc.label}
              className={cn(
                "max-w-[240px] truncate rounded-md border px-2 py-0.5 font-mono text-[10px] transition",
                doc.id === activeId
                  ? "border-cyan-400/40 bg-cyan-500/10 text-cyan-200"
                  : "border-white/10 bg-white/[0.02] text-zinc-400 hover:border-white/25 hover:text-zinc-200",
              )}
            >
              {doc.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={() => uploadRef.current?.click()}
          disabled={busyUpload || !activeDoc}
        >
          {busyUpload ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Загрузить
        </Button>
        <input
          ref={uploadRef}
          type="file"
          accept=".json,.jsonl,.txt,.md,application/json,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onUploadFile(file);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={download}
          disabled={!activeDoc}
        >
          <Download className="h-3.5 w-3.5" />
          Скачать
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={() => void copy()}
          disabled={!text}
        >
          <Copy className="h-3.5 w-3.5" />
          Копировать
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={formatJson}
          disabled={!text}
        >
          <Braces className="h-3.5 w-3.5" />
          Формат
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={() => setText(baseline)}
          disabled={!dirty}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Сбросить
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1.5 px-3 text-[11px]"
          onClick={() => save.mutate()}
          disabled={!activeDoc || !dirty || save.isPending}
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Сохранить
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              if (activeDoc && dirty && !save.isPending) save.mutate();
            }
          }}
          autoFocus
          spellCheck={false}
          placeholder={
            empty
              ? "У этой ноды нет сохранённого ответа."
              : activeDoc && !activeDoc.exists
                ? "Ответа ещё нет. Вставь JSON или нажми «Загрузить», потом «Сохранить»."
                : ""
          }
          className="h-full min-h-[240px] flex-1 resize-none whitespace-pre-wrap break-words rounded-lg border-white/10 bg-black/50 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90 focus-visible:border-white/25 focus-visible:ring-white/10"
        />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Выпадающее окно JSON — открывается кнопкой JSON в результатах ноды (на её
 * карточке на канвасе). Позиционируется рядом с кнопкой, закрывается по Esc,
 * клику мимо или крестику. Никакого модального диалога.
 */
export function NodeLlmJsonPopover({
  projectId,
  nodeKey,
  nodeType,
  snapshot,
  anchor,
  onClose,
}: {
  projectId: number;
  nodeKey?: string | null;
  nodeType?: string | null;
  snapshot?: unknown;
  anchor: { left: number; top: number; width: number; height: number };
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    const width = Math.min(760, Math.max(420, window.innerWidth - 24));
    const height = Math.min(640, Math.max(320, window.innerHeight - 24));
    const left = Math.min(
      Math.max(8, anchor.left + anchor.width - width),
      window.innerWidth - width - 8,
    );
    const below = anchor.top + anchor.height + 8;
    const top =
      below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, anchor.top - height - 8);
    setPos({ left, top, width, height });
  }, [anchor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!pos) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[90]" onMouseDown={onClose} />
      <div
        className="fixed z-[91] flex flex-col overflow-hidden rounded-xl border border-white/15 bg-zinc-950 p-2.5 shadow-2xl"
        style={{ left: pos.left, top: pos.top, width: pos.width, height: pos.height }}
        role="dialog"
        aria-label="JSON ответа"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 pb-1.5">
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400">
            <Braces className="h-3.5 w-3.5" />
            JSON ответа
          </span>
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground transition hover:bg-white/10 hover:text-white"
            onClick={onClose}
            title="Закрыть (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <NodeLlmJsonPanel
            projectId={projectId}
            nodeKey={nodeKey}
            nodeType={nodeType}
            active
            snapshot={snapshot}
          />
        </div>
      </div>
    </>,
    document.body,
  );
}
