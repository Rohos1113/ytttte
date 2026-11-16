"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Layers, Clapperboard, Check, Film } from "lucide-react";
import { toast } from "sonner";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { api } from "@/lib/api";
import { projectDisplayName } from "@/lib/project-display";
import { useTranslation } from "@/lib/i18n";
import type { PipelineMode, ProjectSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function NewProjectWizard({
  trigger,
  onCreated,
  folderId = null,
  open: openProp,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  onCreated: (p: ProjectSummary) => void;
  folderId?: string | null;
  /** Внешнее управление: нужно, когда окно открывают не кнопкой «+», а событием. */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = onOpenChange ?? setInnerOpen;
  const [projectTitle, setProjectTitle] = useState("");
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>("v1");
  const qc = useQueryClient();

  const reset = () => {
    setProjectTitle("");
    setPipelineMode("v1");
  };

  const create = useMutation({
    mutationFn: async () => {
      const rawTitle = projectTitle.trim() || t("projects.wizard.defaultNewTitle");
      const p = await api.createProject({
        title: rawTitle.slice(0, 120),
        topic: rawTitle,
        hero_mode: "auto",
        auto_mode: false,
        pipeline_mode: pipelineMode,
        sidebar_folder_id: folderId,
      });
      return p;
    },
    onSuccess: (p) => {
      try {
        localStorage.setItem("studio.pipeline_mode", JSON.stringify(p.pipeline_mode === "v2" ? "v2" : "v1"));
      } catch {}
      qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated(p);
      setOpen(false);
      reset();
      toast.success(t("projects.wizard.created", { name: projectDisplayName(p) }));
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent
        className="sm:max-w-[820px] max-h-[92vh] flex flex-col p-6 bg-zinc-950/95 border-white/10 shadow-[0_24px_80px_rgba(0,0,0,0.8)] [contain:paint] overflow-hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0 space-y-1.5 pb-2 border-b border-white/[0.08]">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 border border-cyan-400/20 text-cyan-400">
              <Film className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold tracking-tight text-white">
                {t("projects.wizard.title")}
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-400">
                {t("projects.wizard.description")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1 -mr-1 py-4 space-y-5">
          {/* Сетка двух механик с подробным описанием */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Карточка: Классический пайплайн (v1) */}
            <div
              onClick={() => setPipelineMode("v1")}
              className={cn(
                "relative flex flex-col justify-between rounded-2xl border p-5 transition-all duration-200 cursor-pointer text-left select-none",
                pipelineMode === "v1"
                  ? "border-cyan-400/50 bg-gradient-to-b from-cyan-950/30 to-zinc-900/40 shadow-lg shadow-cyan-950/20 ring-1 ring-cyan-500/30"
                  : "border-white/[0.08] bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]",
              )}
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 text-cyan-300">
                      <Layers className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                        {t("projects.wizard.v1Title")}
                      </h3>
                      <p className="text-[11px] font-medium text-cyan-300/80">{t("projects.wizard.v1Subtitle")}</p>
                    </div>
                  </div>

                  {pipelineMode === "v1" ? (
                    <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30 gap-1 text-[10px] font-semibold uppercase tracking-wider">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      {t("projects.wizard.selected")}
                    </Badge>
                  ) : (
                    <Badge variant="muted" className="text-zinc-500 border-white/10 text-[10px]">
                      v1
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-zinc-300 leading-relaxed mb-4">
                  {t("projects.wizard.v1Desc")}
                </p>

                {/* Что внутри */}
                <div className="space-y-2 mb-4 bg-black/30 rounded-xl p-3 border border-white/[0.05]">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    {t("projects.wizard.whatsInside")}
                  </span>
                  <ul className="space-y-1.5 text-xs text-zinc-300">
                    <li className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">•</span>
                      <span>{t("projects.wizard.v1Feature1")}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">•</span>
                      <span>{t("projects.wizard.v1Feature2")}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">•</span>
                      <span>{t("projects.wizard.v1Feature3")}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-cyan-400 font-bold">•</span>
                      <span>{t("projects.wizard.v1Feature4")}</span>
                    </li>
                  </ul>
                </div>

                {/* Рекомендации каналов */}
                <div className="rounded-lg bg-cyan-950/20 border border-cyan-800/30 px-3 py-2 mb-4">
                  <span className="text-[10px] font-semibold text-cyan-300 block mb-0.5">
                    {t("projects.wizard.v1ChannelsTitle")}
                  </span>
                  <p className="text-[11px] text-zinc-300 leading-snug">
                    {t("projects.wizard.v1ChannelsDesc")}
                  </p>
                </div>
              </div>

              <div
                className={cn(
                  "w-full text-xs font-semibold h-9 rounded-xl flex items-center justify-center transition-all",
                  pipelineMode === "v1"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 shadow-sm"
                    : "bg-white/[0.04] text-zinc-400 border border-white/10 hover:text-zinc-200",
                )}
              >
                {pipelineMode === "v1" ? (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1 text-emerald-400" />
                    {t("projects.wizard.v1Selected")}
                  </>
                ) : (
                  t("projects.wizard.v1Select")
                )}
              </div>
            </div>

            {/* Карточка: Режиссёрский монтаж (v2) */}
            <div
              onClick={() => setPipelineMode("v2")}
              className={cn(
                "relative flex flex-col justify-between rounded-2xl border p-5 transition-all duration-200 cursor-pointer text-left select-none",
                pipelineMode === "v2"
                  ? "border-violet-400/50 bg-gradient-to-b from-violet-950/30 to-zinc-900/40 shadow-lg shadow-violet-950/20 ring-1 ring-violet-500/30"
                  : "border-white/[0.08] bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]",
              )}
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-500/30 bg-violet-500/10 text-violet-300">
                      <Clapperboard className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
                        {t("projects.wizard.v2Title")}
                      </h3>
                      <p className="text-[11px] font-medium text-violet-300/80">{t("projects.wizard.v2Subtitle")}</p>
                    </div>
                  </div>

                  {pipelineMode === "v2" ? (
                    <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30 gap-1 text-[10px] font-semibold uppercase tracking-wider">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      {t("projects.wizard.selected")}
                    </Badge>
                  ) : (
                    <Badge variant="muted" className="text-zinc-500 border-white/10 text-[10px]">
                      v2
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-zinc-300 leading-relaxed mb-4">
                  {t("projects.wizard.v2Desc")}
                </p>

                {/* Что внутри */}
                <div className="space-y-2 mb-4 bg-black/30 rounded-xl p-3 border border-white/[0.05]">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                    {t("projects.wizard.whatsInside")}
                  </span>
                  <ul className="space-y-1.5 text-xs text-zinc-300">
                    <li className="flex items-start gap-2">
                      <span className="text-violet-400 font-bold">•</span>
                      <span>{t("projects.wizard.v2Feature1")}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-violet-400 font-bold">•</span>
                      <span>{t("projects.wizard.v2Feature2")}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-violet-400 font-bold">•</span>
                      <span>{t("projects.wizard.v2Feature3")}</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-violet-400 font-bold">•</span>
                      <span>{t("projects.wizard.v2Feature4")}</span>
                    </li>
                  </ul>
                </div>

                {/* Рекомендации каналов */}
                <div className="rounded-lg bg-violet-950/20 border border-violet-800/30 px-3 py-2 mb-4">
                  <span className="text-[10px] font-semibold text-violet-300 block mb-0.5">
                    {t("projects.wizard.v2ChannelsTitle")}
                  </span>
                  <p className="text-[11px] text-zinc-300 leading-snug">
                    {t("projects.wizard.v2ChannelsDesc")}
                  </p>
                </div>
              </div>

              <div
                className={cn(
                  "w-full text-xs font-semibold h-9 rounded-xl flex items-center justify-center transition-all",
                  pipelineMode === "v2"
                    ? "bg-violet-500/20 text-violet-300 border border-violet-400/40 shadow-sm"
                    : "bg-white/[0.04] text-zinc-400 border border-white/10 hover:text-zinc-200",
                )}
              >
                {pipelineMode === "v2" ? (
                  <>
                    <Check className="h-3.5 w-3.5 mr-1 text-emerald-400" />
                    {t("projects.wizard.v2Selected")}
                  </>
                ) : (
                  t("projects.wizard.v2Select")
                )}
              </div>
            </div>
          </div>

          {/* Название проекта */}
          <div className="space-y-2 pt-2 border-t border-white/[0.08]">
            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-300 flex items-center justify-between">
              <span>{t("projects.wizard.nameLabel")}</span>
              <span className="text-[11px] font-normal text-zinc-500 lowercase">
                {t("projects.wizard.nameRequired")}
              </span>
            </label>
            <Input
              placeholder={t("projects.wizard.namePlaceholder")}
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && projectTitle.trim() && !create.isPending) {
                  create.mutate();
                }
              }}
              className="h-10 bg-zinc-900/80 border-white/10 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-white/30 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:shadow-none"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter className="shrink-0 pt-3 flex items-center justify-between sm:justify-between border-t border-white/[0.08] mt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            className="text-xs text-zinc-400 hover:text-white"
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={create.isPending || !projectTitle.trim()}
            onClick={() => create.mutate()}
            className={cn(
              "min-w-[150px] h-9 text-xs font-semibold text-white shadow-md rounded-xl transition-all disabled:opacity-40",
              pipelineMode === "v2"
                ? "bg-violet-600 hover:bg-violet-500 border border-violet-400/50 shadow-violet-900/30"
                : "bg-cyan-600 hover:bg-cyan-500 border border-cyan-400/50 shadow-cyan-900/30",
            )}
          >
            {create.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("projects.wizard.creating")}
              </>
            ) : (
              t("projects.wizard.createBtn")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
