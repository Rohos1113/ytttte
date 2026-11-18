"use client";

/**
 * «Настройки» ноды: мастер-промты видны целиком, подписаны и правятся здесь.
 *
 * Персонажи собирают запрос из двух файлов (формат аватара + стиль аватара),
 * предметы — из одного (формат/стиль предмета). Заголовок и имя файла стоят
 * одной строкой сверху; ниже текст и кнопка сохранения.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { Button } from "@/components/ui/button";

export type PromptTextSlot = {
  slotId: string;
  stepCode: string;
  title: string;
};

const HERO_PROMPT_SLOTS: PromptTextSlot[] = [
  { slotId: "main", stepCode: "hero", title: "Текст промта: формат аватара" },
  { slotId: "style", stepCode: "hero_style", title: "Текст промта: стиль аватара" },
];

const ITEMS_PROMPT_SLOTS: PromptTextSlot[] = [
  { slotId: "main", stepCode: "items", title: "Текст промта: предмет" },
];

/** Какие промты показывать в настройках для типа ноды. */
export function promptTextSlotsFor(nodeType: string): PromptTextSlot[] {
  if (nodeType === "hero" || nodeType === "hitl_hero") return HERO_PROMPT_SLOTS;
  if (nodeType === "items") return ITEMS_PROMPT_SLOTS;
  return [];
}

const POLL_MS = 15_000;

function PromptTextBlock({
  projectId,
  nodeKey,
  slotId,
  stepCode,
  title,
}: {
  projectId: number;
  nodeKey: string;
  slotId: string;
  stepCode: string;
  title: string;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);

  const resolved = useQuery({
    queryKey: ["prompt-resolve", stepCode, projectId, nodeKey, slotId],
    queryFn: () => api.resolvePromptFile(stepCode, { projectId, nodeKey, slotId }),
    refetchInterval: POLL_MS,
  });

  const name = resolved.data?.name;

  const body = useQuery({
    queryKey: ["prompt-file", stepCode, slotId, name, projectId],
    queryFn: () => api.getPromptFile(stepCode, name!, { projectId }),
    enabled: Boolean(name),
    refetchInterval: POLL_MS,
  });

  const text = body.data?.content ?? "";
  const sourceLabel = resolved.data?.source_label;

  // Пока не правили руками — следуем за сервером.
  useEffect(() => {
    if (dirty) return;
    if (text) setDraft(text);
  }, [text, dirty]);

  useEffect(() => {
    if (name) setNameDraft(name);
  }, [name]);

  const save = async () => {
    if (!name) return;
    setSaving(true);
    try {
      await api.savePromptFile(stepCode, name, draft);
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["prompt-file"] });
      await qc.invalidateQueries({ queryKey: ["prompt-files"] });
      await qc.invalidateQueries({ queryKey: ["prompt-resolve"] });
      toast.success(`Промт «${name}» сохранён`);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setSaving(false);
    }
  };

  const commitName = async () => {
    const next = nameDraft.trim().replace(/\.(md|txt)$/i, "");
    if (!name || !next || next === name) {
      setNameDraft(name ?? "");
      return;
    }
    setRenaming(true);
    try {
      const info = await api.renamePromptFile(stepCode, name, next);
      setNameDraft(info.name);
      await qc.invalidateQueries({ queryKey: ["prompt-file"] });
      await qc.invalidateQueries({ queryKey: ["prompt-files"] });
      await qc.invalidateQueries({ queryKey: ["prompt-resolve"] });
      toast.success(`Файл промта переименован: ${info.name}.md`);
    } catch (e) {
      setNameDraft(name);
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setRenaming(false);
    }
  };

  return (
    <section className="flex flex-col gap-1.5 rounded-[10px] border border-white/[0.08] bg-black/25 p-2.5">
      <div className="flex items-center gap-2">
        <h4 className="shrink-0 text-[13px] font-semibold text-white/85">{title}</h4>
        <input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
          title="Имя файла промта. Enter — переименовать"
          className="h-7 min-w-0 flex-1 rounded-md border border-white/10 bg-[#0a0a0a] px-2 text-[12px] text-white outline-none focus:border-white/30"
          placeholder="имя файла промта"
        />
        <span className="shrink-0 text-[11px] text-white/40">{renaming ? "…" : sourceLabel ?? ""}</span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => {
          setDirty(true);
          setDraft(e.target.value);
        }}
        spellCheck={false}
        className="h-52 w-full resize-y whitespace-pre-wrap rounded-lg border border-white/[0.08] bg-[#111114] p-2.5 font-mono text-[12.5px] leading-relaxed text-white/85 outline-none focus:border-white/25"
        placeholder={body.isLoading ? "Загрузка…" : "Текст промта…"}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-white/35">
          {draft ? `${draft.length} симв · ` : ""}
          {body.isError ? "промт не читается — правка сохранится поверх" : dirty ? "есть несохранённые изменения" : "сохранено"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!dirty || saving || !name}
          onClick={() => void save()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Сохранить промт
        </Button>
      </div>
    </section>
  );
}

export function NodePromptTexts({
  projectId,
  nodeKey,
  nodeType,
}: {
  projectId: number;
  nodeKey: string;
  nodeType: string;
}) {
  const slots = promptTextSlotsFor(nodeType);
  if (!slots.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {slots.map((slot) => (
        <PromptTextBlock
          key={slot.slotId}
          projectId={projectId}
          nodeKey={nodeKey}
          slotId={slot.slotId}
          stepCode={slot.stepCode}
          title={slot.title}
        />
      ))}
    </div>
  );
}
