"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquareText, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { api } from "@/lib/api";
import {
  AUTO_REVIEW_KINDS,
  autoReviewKindForNodeType,
  getAutoReviewKindLabel,
  readAiNewWindowPerCheck,
  readAutoReviewKinds,
} from "@/lib/control-mode";
import { defaultPromptSlots } from "@/lib/node-prompts";
import { getNodeSpec, resolveDisplayNodeLabel } from "@/lib/node-catalog";
import { nodeSupportsGptText } from "@/lib/gpt-text-steps";
import { useTranslation } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function AiControlEdgeDialog({
  open,
  onOpenChange,
  projectId,
  projectMeta,
  sourceKey,
  targetKey,
  targetType,
  onOpenPrompt,
  onOpenGptText,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: number;
  projectMeta: Record<string, unknown>;
  sourceKey: string;
  targetKey: string;
  targetType: string;
  onOpenPrompt: (nodeKey: string, nodeType: string) => void;
  onOpenGptText: (nodeKey: string, nodeType: string) => void;
}) {
  const { t, locale } = useTranslation();
  const qc = useQueryClient();
  const kindsOn = new Set(readAutoReviewKinds(projectMeta));
  const newWindow = readAiNewWindowPerCheck(projectMeta);
  const targetKind = autoReviewKindForNodeType(targetType);
  const targetLabel = resolveDisplayNodeLabel(targetType, getNodeSpec(targetType).label, locale);

  const patch = useMutation({
    mutationFn: (meta: Record<string, unknown>) => api.patchProject(projectId, { meta }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const persist = (patchMeta: Record<string, unknown>) => {
    patch.mutate(patchMeta);
  };

  const toggleKind = (kind: string) => {
    const next = new Set(kindsOn);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    persist({ auto_review_kinds: [...next] });
    const label = getAutoReviewKindLabel(kind, locale);
    toast.message(
      next.has(kind)
        ? t("canvas.aiControl.toastGptCheck", { kind: label })
        : t("canvas.aiControl.toastAutoApprove", { kind: label }),
    );
  };

  const slots = defaultPromptSlots(targetType).slice(0, 4);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-red-400" />
            {t("canvas.aiControl.titleEdge", { targetLabel })}
          </DialogTitle>
          <DialogDescription>
            {t("canvas.aiControl.subtitleEdge")} {t("canvas.aiControl.edgeLabel", { source: sourceKey, target: targetKey })}
          </DialogDescription>
        </DialogHeader>

        <Section title={t("canvas.aiControl.nodePrompts")}>
          <div className="flex flex-wrap gap-1.5">
            {slots.map((slot) => (
              <Button
                key={slot.id}
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-[11px]"
                onClick={() => onOpenPrompt(targetKey, targetType)}
              >
                {slot.title}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => onOpenPrompt(targetKey, targetType)}
            >
              {t("canvas.aiControl.allPrompts")}
            </Button>
          </div>
        </Section>

        {nodeSupportsGptText(targetType) && (
          <Section title={t("canvas.aiControl.textForGpt")}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs"
              onClick={() => onOpenGptText(targetKey, targetType)}
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              {t("canvas.aiControl.textVariant")}
            </Button>
          </Section>
        )}

        <Section title={t("canvas.aiControl.stepGptCheck")}>
          <p className="mb-2 text-[10px] text-muted-foreground">
            {t("canvas.aiControl.stepGptCheckDesc")}
          </p>
          <div className="flex flex-col gap-1">
            {(targetKind
              ? AUTO_REVIEW_KINDS.filter((k) => k.kind === targetKind)
              : AUTO_REVIEW_KINDS
            ).map(({ kind }) => {
              const on = kindsOn.has(kind);
              const label = getAutoReviewKindLabel(kind, locale);
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={patch.isPending}
                  onClick={() => toggleKind(kind)}
                  className={cn(
                    "flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs transition",
                    on
                      ? "border-red-500/40 bg-red-500/10 text-red-200"
                      : "border-border/60 hover:bg-accent/30",
                  )}
                >
                  <span>{label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {on ? t("canvas.aiControl.gptChecking") : t("canvas.aiControl.autoApprove")}
                  </span>
                </button>
              );
            })}
          </div>
        </Section>

        <Section title={t("canvas.aiControl.browserWindow")}>
          <ToggleLine
            label={t("canvas.aiControl.newWindowPerCheck")}
            hint={t("canvas.aiControl.newWindowHint")}
            active={newWindow}
            disabled={patch.isPending}
            onClick={() => {
              persist({ ai_new_window_per_check: !newWindow });
              toast.success(!newWindow ? t("canvas.aiControl.newWindowToast") : t("canvas.aiControl.singleWindowToast"));
            }}
          />
        </Section>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("canvas.aiControl.close")}
          </Button>
          {patch.isPending && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("canvas.aiControl.saving")}
            </span>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/8 bg-white/[0.02] p-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </span>
      {children}
    </div>
  );
}

function ToggleLine({
  label,
  hint,
  active,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-2 text-left",
        active ? "border-red-500/40 bg-red-500/10" : "border-border/60",
      )}
    >
      <span className="flex flex-col">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-[10px] text-muted-foreground">{hint}</span>
      </span>
      <span
        className={cn(
          "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5",
          active ? "bg-red-600" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "block h-4 w-4 rounded-full bg-white shadow transition-transform",
            active && "translate-x-4",
          )}
        />
      </span>
    </button>
  );
}
