"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessageFromUnknown } from "@/lib/error-message";

export function NodeDescriptionEditor({ nodeKey, description }: { nodeKey: string; description: string }) {
  const [draft, setDraft] = useState(description);
  useEffect(() => setDraft(description), [description]);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[13px] text-white/60">Описание ноды</span>
        <textarea className="nowheel min-h-[64px] rounded-md border border-white/10 bg-[#0a0a0a] p-2 text-[14px] text-white" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <button type="button" disabled={draft.trim() === description.trim()} className="h-9 w-fit rounded-md border border-white/25 px-5 text-[13px] text-white hover:border-white/60 disabled:opacity-40" onClick={() => {
        window.dispatchEvent(new CustomEvent("canvas-patch-node-data", { detail: { nodeKey, patch: { description: draft.trim() } } }));
        toast.success("Описание сохранено");
      }}>Сохранить описание</button>
    </div>
  );
}

/** Flat prompt editor at the bottom of the node settings. */
export function NodePromptBlock({
  stepCode,
  activeVariant,
  onActivate,
  nodeKey,
  projectId,
  description,
}: {
  stepCode: string;
  activeVariant?: string;
  onActivate?: (name: string) => void;
  nodeKey: string;
  projectId?: number;
  description: string;
}) {
  const qc = useQueryClient();
  const files = useQuery({
    queryKey: ["prompt-files", stepCode, nodeKey],
    queryFn: () => api.listPromptFiles(stepCode, { nodeKey }),
    enabled: Boolean(stepCode),
  });
  const list = files.data ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const userPickedRef = useRef(false);
  const lastKeyRef = useRef<string>("");

  useEffect(() => {
    const key = `${nodeKey}:${stepCode}`;
    if (lastKeyRef.current !== key) {
      lastKeyRef.current = key;
      userPickedRef.current = false;
    }
  }, [nodeKey, stepCode]);

  useEffect(() => {
    if (userPickedRef.current && sel && list.some((f) => f.name === sel)) return;
    const act = list.find((f) => f.name === activeVariant);
    if (act) {
      setSel(act.name);
      return;
    }
    if (sel && list.some((f) => f.name === sel)) return;
    setSel(list[0]?.name ?? null);
  }, [list, activeVariant, sel]);
  const content = useQuery({
    queryKey: ["prompt-file", stepCode, sel, nodeKey],
    queryFn: () =>
      api.getPromptFile(stepCode, sel!, { projectId, nodeKey }),
    enabled: Boolean(sel),
  });
  const [draft, setDraft] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  useEffect(() => setDraft(content.data?.content ?? ""), [content.data?.content]);
  useEffect(() => setNameDraft(sel ?? ""), [sel]);
  const inval = () => {
    qc.invalidateQueries({ queryKey: ["prompt-files"] });
    qc.invalidateQueries({ queryKey: ["prompt-file"] });
    qc.invalidateQueries({ queryKey: ["prompt-global-active"] });
  };
  const save = useMutation({
    mutationFn: async () => {
      let name = sel!;
      const nn = nameDraft.trim();
      if (nn && nn !== name) {
        const info = await api.renamePromptFile(stepCode, name, nn);
        name = info.name;
      }
      if (draft !== (content.data?.content ?? ""))
        await api.savePromptFile(stepCode, name, draft, { nodeKey });
      return name;
    },
    onSuccess: (name) => {
      setSel(name);
      inval();
      toast.success("Промт сохранён");
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });
  const dirty = draft !== (content.data?.content ?? "") || (nameDraft.trim() && nameDraft.trim() !== sel);
  return (
    <div data-vp-prompt-block className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[13px] text-white/60">Название промта (файл)</span>
        <input className="h-9 rounded-md border border-white/10 bg-[#0a0a0a] px-2 text-[14px] text-white" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[13px] text-white/60">Текст промта</span>
        <textarea
          className="nowheel min-h-[220px] rounded-md border border-white/10 bg-[#0a0a0a] p-2 font-mono text-[12.5px] leading-snug text-white"
          value={content.isLoading ? "Загрузка…" : draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        disabled={!sel || !dirty || save.isPending}
        className="h-9 w-fit rounded-md border border-white/25 px-5 text-[13px] text-white hover:border-white/60 disabled:opacity-40"
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Сохранение…" : "Сохранить промт"}
      </button>
    </div>
  );
}
