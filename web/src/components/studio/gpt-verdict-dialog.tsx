"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { api } from "@/lib/api";
import { GptVerdictPanel } from "@/components/studio/gpt-verdict-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getNodeSpec } from "@/lib/node-catalog";
import { useTranslation } from "@/lib/i18n";

export function GptVerdictDialog({
  open,
  onOpenChange,
  projectId,
  stepCode,
  nodeType,
  projectMeta,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: number;
  stepCode: string;
  nodeType: string;
  projectMeta: Record<string, unknown>;
}) {
  const qc = useQueryClient();
  const { t, locale } = useTranslation();
  const label = getNodeSpec(nodeType, locale).label;

  const patch = useMutation({
    mutationFn: (meta: Record<string, unknown>) => api.patchProject(projectId, { meta }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("hitl.verdict.title", { label })}</DialogTitle>
          <DialogDescription>
            {t("hitl.verdict.description", { stepCode })}
          </DialogDescription>
        </DialogHeader>
        <GptVerdictPanel
          projectId={projectId}
          stepCode={stepCode}
          projectMeta={projectMeta}
          onPersistMeta={(meta) => patch.mutate(meta)}
        />
      </DialogContent>
    </Dialog>
  );
}
