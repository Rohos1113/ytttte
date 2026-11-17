"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, Loader2, Play, ListVideo } from "lucide-react";
import { toast } from "sonner";
import { api, formatApiError } from "@/lib/api";
import type { ProjectDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return formatApiError(String(err));
}

export function MassFactoryPanel({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [fileName, setFileName] = useState<string | null>(null);
  const [localTopics, setLocalTopics] = useState<string[]>([]);

  const status = useQuery({
    queryKey: ["mass-factory", project.id],
    queryFn: () => api.getMassFactoryStatus(project.id),
    refetchInterval: 5000,
    retry: false,
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.parseMassTopicsXlsx(project.id, file),
    onSuccess: (r, file) => {
      setFileName(file.name);
      setLocalTopics(r.topics ?? []);
      qc.invalidateQueries({ queryKey: ["mass-factory", project.id] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      const hint = r.queued_after_current
        ? t("canvas.massFactory.hintQueuedAfterCurrent", { count: r.count })
        : (r.revision ?? 0) > 1
          ? t("canvas.massFactory.hintUpdated", { count: r.count })
          : t("canvas.massFactory.hintQueue", { count: r.count });
      toast.success(t("canvas.massFactory.toastExcelSummary", { count: r.count, hint }));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const start = useMutation({
    mutationFn: () => {
      const topics =
        (status.data?.topics?.length ? status.data.topics : localTopics) ?? [];
      return api.startMassLanes(project.id, topics.length ? { topics } : {});
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["mass-factory", project.id] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      toast.success(
        t("canvas.massFactory.toastStarted", {
          id: r.started_id ?? "",
          queue: r.queue_size ?? r.count,
          remaining: r.remaining ?? 0,
        }),
      );
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const qs = status.data;
  const topics = qs?.topics?.length ? qs.topics : localTopics;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-violet-300">
        <ListVideo className="h-3.5 w-3.5" />
        {t("canvas.massFactory.title")}
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        {t("canvas.massFactory.desc")}
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs font-semibold bg-zinc-800/90 text-zinc-200 border-zinc-700/80 hover:bg-zinc-700 hover:text-white rounded-lg"
          disabled={upload.isPending}
          onClick={() => fileRef.current?.click()}
        >
          {upload.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
          )}
          {t("canvas.massFactory.excelBtn")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 shadow-md shadow-emerald-500/20 border border-emerald-400/40 rounded-lg"
          disabled={start.isPending || topics.length === 0}
          onClick={() => start.mutate()}
        >
          {start.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {t("canvas.massFactory.startQueueBtn")}
        </Button>
      </div>

      {fileName || qs?.filename ? (
        <p className="text-[10px] text-muted-foreground">
          {t("canvas.massFactory.fileInfo", {
            file: fileName || qs?.filename || "",
            count: topics.length,
          })}
          {qs?.active ? t("canvas.massFactory.activeQueue") : ""}
        </p>
      ) : null}

      {topics.length > 0 && (
        <ul className="max-h-24 overflow-y-auto rounded border border-white/8 bg-black/20 px-2 py-1 text-[10px] text-muted-foreground">
          {topics.slice(0, 12).map((tVal, i) => (
            <li key={`${i}-${tVal}`} className="truncate">
              {i + 1}. {tVal}
              {qs?.cursor != null && i < qs.cursor ? " ✓" : ""}
            </li>
          ))}
          {topics.length > 12 && <li>{t("canvas.massFactory.moreTopics", { count: topics.length - 12 })}</li>}
        </ul>
      )}

      {(qs?.children?.length ?? 0) > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {t("canvas.massFactory.childProjects", {
            count: qs?.children?.length ?? 0,
            ready: qs?.children?.filter((c) => c.status === "assembled" || c.status === "published").length ?? 0,
          })}
        </p>
      )}
    </div>
  );
}
