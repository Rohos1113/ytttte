"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { NodeResultSnapshot } from "@/lib/node-result-resolver";
import { getNodeSpec } from "@/lib/node-catalog";
import { useTranslation } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { NodeResultViewBody } from "./node-result-views";

const WIDE_MODES = new Set([
  "director_plan",
  "xlsx_general_plan",
  "voiceover_wide",
  "xlsx_split_row",
  "frame_prompts",
  "frame_images",
  "frame_videos",
  "topic_edit",
  "html_report",
  "sfx_plan",
  "sfx_gen",
]);

export function NodeResultPanel({
  open,
  onOpenChange,
  projectId,
  nodeKey,
  nodeType,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  nodeKey?: string | null;
  nodeType: string;
  snapshot: NodeResultSnapshot;
}) {
  const qc = useQueryClient();
  const { t, locale } = useTranslation();
  const spec = getNodeSpec(nodeType, locale);
  const isExcelGpt = nodeType === "excel_gpt" || Boolean(nodeType?.startsWith("enrich_"));
  const wide = WIDE_MODES.has(snapshot.viewMode) || isExcelGpt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onPointerDownOutside={(e) => {
          // Предотвратить закрытие диалога при протяжке выделения текста за границы окна
          e.preventDefault();
        }}
        onInteractOutside={(e) => {
          e.preventDefault();
        }}
        className={cn(
          "flex flex-col overflow-hidden",
          wide
            ? snapshot.viewMode === "html_report"
              ? "h-[92vh] max-h-[92vh] w-[calc(100vw-110px)] max-w-[calc(100vw-110px)] left-[calc(50%+36px)] gap-0 bg-black p-0"
              : "h-[92vh] max-h-[92vh] w-[calc(100vw-110px)] max-w-[calc(100vw-110px)] left-[calc(50%+36px)] gap-2 p-4 sm:p-5"
            : "max-h-[85vh] max-w-2xl sm:left-[calc(50%+36px)]",
        )}
      >
        <DialogHeader
          className={cn(
            "shrink-0",
            snapshot.viewMode === "html_report" && "px-4 pt-4 pb-2",
          )}
        >
          <DialogTitle>{t("common.result")} — {spec.label}</DialogTitle>
          {snapshot.summary && snapshot.summary !== "Ответ GPT готов" && snapshot.summary !== "Ответ GPT на диске" ? (
            <DialogDescription>{snapshot.summary}</DialogDescription>
          ) : null}
        </DialogHeader>

        {!snapshot.hasResult && snapshot.viewMode === "default" && !isExcelGpt ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t("canvas.nodeResult.notReady")}
          </p>
        ) : (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              snapshot.viewMode === "html_report"
                ? "overflow-hidden bg-black"
                : isExcelGpt
                  ? "overflow-hidden"
                  : "overflow-y-auto [scrollbar-gutter:stable] [scrollbar-width:thin] [scrollbar-color:hsl(0_0%_55%_/_0.55)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/25 [&::-webkit-scrollbar-thumb:hover]:bg-white/45 [&::-webkit-scrollbar-track]:bg-transparent",
            )}
          >
            <NodeResultViewBody
              projectId={projectId}
              nodeKey={nodeKey}
              nodeType={nodeType}
              snapshot={snapshot}
              onHeroReplaced={() => {
                qc.invalidateQueries({ queryKey: ["project-assets", projectId] });
                qc.invalidateQueries({ queryKey: ["media-review", projectId] });
              }}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
