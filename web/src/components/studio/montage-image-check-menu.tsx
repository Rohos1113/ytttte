"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  History,
  Images,
  Loader2,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Video,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import type {
  MontageCheckDTO,
  MontageCheckHistoryItem,
  MontageCheckSettings,
} from "@/lib/types";

/** Подписи фаз прогона (montage_check_images.run_image_check). */
const PHASE_LABELS: Record<string, string> = {
  sheets: "Собираем листы 2×2 из картинок кадров",
  check: "Агент проверяет листы",
  regen: "Перегенерируем плохие кадры",
  recheck: "Перепроверяем кадры после регена",
};

const LIMIT_CHOICES = [0, 1, 2, 3, 4, 5] as const;

const MODE_CHOICES: Array<{ id: "notify" | "auto"; label: string; hint: string }> = [
  {
    id: "notify",
    label: "Уведомлять",
    hint: "Только показываем проблемы по кадрам — картинки не меняются",
  },
  {
    id: "auto",
    label: "Авто-перегенерация",
    hint: "Плохие кадры перегенерируются сами, в пределах лимитов ниже",
  },
];

type CheckView = "check" | "settings" | "history";

/** Пункты диалога: те же, что в выпадающем меню «Проверка». */
const CHECK_VIEWS: Array<{ id: CheckView; label: string }> = [
  { id: "check", label: "Проверка" },
  { id: "settings", label: "Настройки" },
  { id: "history", label: "История" },
];

function phaseLabel(phase?: string | null): string {
  return (phase && PHASE_LABELS[phase]) || "Проверка идёт…";
}

function shortDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceLabel(source: MontageCheckHistoryItem["source"]): string {
  if (source === "regen") return "перегенерация";
  if (source === "archive") return "архив";
  return "сгенерирована";
}

function verdictBadgeClass(verdict: MontageCheckHistoryItem["verdict"]): string {
  if (verdict === "pass") return "border-emerald-400/40 bg-emerald-500/15 text-emerald-300";
  if (verdict === "fail") return "border-red-400/40 bg-red-500/15 text-red-300";
  return "border-white/15 bg-white/5 text-white/60";
}

function verdictShort(verdict: MontageCheckHistoryItem["verdict"]): string {
  if (verdict === "pass") return "ок";
  if (verdict === "fail") return "брак";
  return "?";
}

/**
 * Radix после портальных операций оставляет body { pointer-events: none } —
 * та же страховка, что в assemble-montage-board (restoreDocumentPointerEvents).
 */
function restoreDocumentPointerEvents() {
  if (typeof document === "undefined") return;
  document.body.style.removeProperty("pointer-events");
  document.documentElement.style.removeProperty("pointer-events");
}

/**
 * Выпадающее меню «Проверка» в шапке панели монтажа
 * (docs/MONTAGE-IMAGE-CHECK.md §11). Пункты меню — разные кнопки:
 * «Проверка картинок», «Проверка видео» (скоро), «Настройки проверки»,
 * «История перегенераций». Открывают диалог на своей вкладке.
 */
export function MontageImageCheckMenu({
  projectId,
  onChanged,
}: {
  projectId: number | null;
  /** Доска/кэш обновились: run, apply-image, конец прогона. */
  onChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, setView] = useState<CheckView>("check");
  const [polling, setPolling] = useState(false);
  const [notifiedStatus, setNotifiedStatus] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState("");
  const [taskDirty, setTaskDirty] = useState(false);
  /** Первый ответ GET /check не должен стрелять уведомлением о старом прогоне. */
  const seenAnyRef = useRef(false);

  const checkQ = useQuery<MontageCheckDTO>({
    queryKey: ["montage-check", projectId],
    queryFn: () => api.getMontageCheck(projectId!),
    enabled: projectId != null && (dialogOpen || polling),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.job?.status;
      return status === "running" || polling ? 2000 : false;
    },
  });

  const data = checkQ.data;
  const settings = data?.settings;
  const job = data?.job;
  const running = job?.status === "running";

  // Черновик задачи: подтягиваем из настроек, пока пользователь не начал править.
  useEffect(() => {
    if (taskDirty) return;
    setTaskDraft(settings?.task ?? "");
  }, [settings?.task, taskDirty]);

  useEffect(() => {
    if (running) setPolling(true);
    else if (job?.status === "done" || job?.status === "error" || job?.status === "cancelled") {
      setPolling(false);
    }
  }, [running, job?.status]);

  // Уведомления о конце прогона и проблемах по кадрам.
  useEffect(() => {
    if (!data) return;
    const status = data.job?.status;
    if (!seenAnyRef.current) {
      seenAnyRef.current = true;
      if (status && status !== "running") {
        // Старый итог с сервера — молча принимаем, без toast.
        setNotifiedStatus(status);
        return;
      }
    }
    if (!status || status === "running" || status === "idle") return;
    if (notifiedStatus === status) return;
    setNotifiedStatus(status);
    if (status === "done") {
      const summary = data.summary;
      const failFrames = data.frames.filter((f) => f.verdict === "fail");
      if (summary && summary.fail > 0) {
        const nums = failFrames.map((f) => `#${f.frame_number}`).join(", ");
        toast.message(
          `Проверка картинок: проблем ${summary.fail}${nums ? ` — кадры ${nums}` : ""}`,
        );
      } else {
        toast.success("Проверка картинок: всё ок");
      }
      onChanged?.();
    } else if (status === "error") {
      toast.error(data.job?.error || "Проверка картинок не удалась");
      onChanged?.();
    } else if (status === "cancelled") {
      toast.message("Проверка картинок остановлена");
      onChanged?.();
    }
  }, [data, notifiedStatus, onChanged]);

  const saveMut = useMutation({
    mutationFn: (patch: Partial<MontageCheckSettings>) =>
      api.saveMontageCheckSettings(projectId!, patch),
    onSuccess: (res) => {
      queryClient.setQueryData<MontageCheckDTO>(
        ["montage-check", projectId],
        (old) => (old ? { ...old, settings: res.settings } : old),
      );
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const runMut = useMutation({
    mutationFn: () => api.runMontageCheck(projectId!, {}),
    onSuccess: (res) => {
      if (res.already_running) {
        toast.message("Проверка уже выполняется");
        setPolling(true);
        return;
      }
      seenAnyRef.current = true;
      setNotifiedStatus(null);
      setPolling(true);
      toast.message("Проверка картинок запущена");
      void checkQ.refetch();
      onChanged?.();
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const cancelMut = useMutation({
    mutationFn: () => api.cancelMontageCheck(projectId!),
    onSuccess: (res) => {
      toast.message(
        res.cancelled ? "Останавливаем проверку…" : "Проверка уже не выполняется",
      );
      void checkQ.refetch();
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const applyMut = useMutation({
    mutationFn: (body: { frame_number: number; file: string }) =>
      api.applyMontageCheckImage(projectId!, body),
    onSuccess: (res) => {
      toast.success(`Картинка кадра #${res.frame_number} поставлена активной`);
      void checkQ.refetch();
      onChanged?.();
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
    onSettled: () => {
      queueMicrotask(restoreDocumentPointerEvents);
    },
  });

  const agents = data?.agents ?? [];
  const summary = data?.summary ?? { total: 0, pass: 0, fail: 0, skip: 0 };
  const failFrames = (data?.frames ?? []).filter((f) => f.verdict === "fail");
  const skipFrames = (data?.frames ?? []).filter((f) => f.verdict === "skip");
  const busy = running || runMut.isPending;

  /** История по кадрам: свежие сверху, активная — первой. */
  const historyByFrame = useMemo(() => {
    const map = new Map<number, MontageCheckHistoryItem[]>();
    for (const item of data?.history ?? []) {
      const list = map.get(item.frame_number) ?? [];
      list.push(item);
      map.set(item.frame_number, list);
    }
    for (const [frameNumber, list] of map) {
      list.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return (b.created_at ?? "").localeCompare(a.created_at ?? "");
      });
      map.set(frameNumber, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [data?.history]);

  const mode = settings?.mode ?? "notify";
  const done = job?.done ?? 0;
  const total = job?.total ?? 0;
  const progressPct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-1.5 text-xs"
            disabled={!projectId}
            title="Проверка кадров: механика, настройки, вердикты и история версий"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Проверка
            <ChevronDown className="h-3.5 w-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="z-[10070] w-60">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Механика проверки
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              setView("check");
              setDialogOpen(true);
            }}
          >
            <Images className="h-4 w-4" />
            Проверка картинок
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled
            onSelect={() => toast.message("Проверка видео ещё не включена")}
          >
            <Video className="h-4 w-4" />
            Проверка видео
            <span className="ml-auto text-[10px] text-muted-foreground">скоро</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setView("settings");
              setDialogOpen(true);
            }}
          >
            <Settings2 className="h-4 w-4" />
            Настройки проверки
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setView("history");
              setDialogOpen(true);
            }}
          >
            <History className="h-4 w-4" />
            История перегенераций
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) restoreDocumentPointerEvents();
        }}
      >
        <DialogContent className="z-[10110] max-h-[85vh] w-[min(96vw,520px)] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5 text-sm">
              <ScanSearch className="h-4 w-4" />
              Проверка картинок
            </DialogTitle>
          </DialogHeader>

          <div className="mb-2 flex flex-wrap gap-1">
            {CHECK_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-[11px] transition-colors",
                  view === v.id
                    ? "border-amber-400/70 bg-amber-500/15 text-amber-100"
                    : "border-border hover:bg-muted/40",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>

          {projectId == null ? (
            <p className="text-xs text-muted-foreground">Проект не выбран</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {view === "check" ? (
                <>
            {/* Запуск / стоп */}
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-8 flex-1 text-xs"
                disabled={busy}
                onClick={() => runMut.mutate()}
              >
                {runMut.isPending ? "Запускаем…" : "Проверить картинки"}
              </Button>
              {running ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={cancelMut.isPending}
                  onClick={() => cancelMut.mutate()}
                >
                  Стоп
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={checkQ.isFetching}
                  onClick={() => void checkQ.refetch()}
                  title="Обновить данные проверки"
                >
                  {checkQ.isFetching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Обновить"
                  )}
                </Button>
              )}
            </div>

            {checkQ.isError ? (
              <p className="text-[11px] text-destructive">
                Не удалось прочитать проверку: {errorMessageFromUnknown(checkQ.error)}
              </p>
            ) : null}

            {/* Прогресс */}
            {running ? (
              <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-2 py-1.5">
                <p className="text-[11px] text-amber-200">
                  {phaseLabel(job?.phase)}
                  {total > 0 ? ` · ${done}/${total}` : ""}
                </p>
                {job?.phase_detail ? (
                  <p className="truncate text-[10px] text-amber-200/70" title={job.phase_detail}>
                    {job.phase_detail}
                  </p>
                ) : null}
                {total > 0 ? (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-black/40">
                    <div
                      className="h-full bg-amber-400 transition-all"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}

            {job?.status === "error" && job.error ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
                {job.error}
              </p>
            ) : null}

            {job?.status === "cancelled" ? (
              <p className="text-[11px] text-muted-foreground">Прошлый прогон остановлен</p>
            ) : null}

            {/* Итог */}
            {summary.total > 0 || job?.status === "done" || job?.status === "error" ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border px-2 py-1.5 text-[11px]">
                <span className="font-medium text-emerald-400">ок {summary.pass}</span>
                <span className="text-white/30">·</span>
                <span className="font-medium text-red-400">проблемы {summary.fail}</span>
                <span className="text-white/30">·</span>
                <span className="text-muted-foreground">пропущено {summary.skip}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  всего {summary.total}
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Проверок ещё не было — нажми «Проверить картинки».
              </p>
            )}

            {/* Проблемы по кадрам — уведомления */}
            {failFrames.length > 0 ? (
              <section>
                <h4 className="mb-1 flex items-center gap-1 text-[11px] font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
                  Проблемы по кадрам
                </h4>
                <ul className="flex flex-col gap-1">
                  {failFrames.map((f) => (
                    <li
                      key={f.frame_number}
                      className="rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1 text-[11px]"
                    >
                      <span className="font-semibold text-red-300">
                        Кадр #{f.frame_number}
                      </span>
                      <span className="text-red-200/80">
                        {f.problems.length > 0
                          ? ` — ${f.problems.join("; ")}`
                          : " — проблемы без описания"}
                      </span>
                      {f.prompt_match === false ? (
                        <span className="text-red-200/60"> · не совпал с промтом</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {skipFrames.length > 0 ? (
              <p
                className="text-[10px] text-muted-foreground"
                title={skipFrames
                  .map((f) => `#${f.frame_number}: ${f.problems.join("; ") || "пропущен"}`)
                  .join("\n")}
              >
                Пропущены кадры: {skipFrames.map((f) => `#${f.frame_number}`).join(", ")}
              </p>
            ) : null}
                </>
              ) : null}

              {view === "settings" ? (
                <>
                  <div className="flex items-center justify-between rounded-lg border border-border px-2 py-1.5 text-xs">
                    <span>
                      Механика: <span className="font-medium">картинки</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground">видео — скоро</span>
                  </div>
            {/* Режим: уведомлять / авто-перегенерация */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                режим
              </span>
              <div className="grid grid-cols-2 gap-1">
                {MODE_CHOICES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busy}
                    onClick={() => saveMut.mutate({ mode: m.id })}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50",
                      mode === m.id
                        ? "border-amber-400/70 bg-amber-500/15 text-amber-100"
                        : "border-border hover:bg-muted/40",
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                {MODE_CHOICES.find((m) => m.id === mode)?.hint}
              </p>
            </div>
            {/* Агент проверки */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                агент проверки
              </span>
              <div className="flex flex-col gap-1.5">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    disabled={busy}
                    onClick={() => saveMut.mutate({ agent: a.id })}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50",
                      settings?.agent === a.id
                        ? "border-amber-400/70 bg-amber-500/15"
                        : "border-border hover:bg-muted/40",
                    )}
                  >
                    <span className="block text-xs font-medium">{a.title || a.id}</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                      {a.summary}
                    </span>
                  </button>
                ))}
                {agents.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">
                    Агенты проверки не найдены
                  </p>
                ) : null}
              </div>
            </div>
            {/* Задача проверки */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                задача проверки
              </span>
              <Textarea
                value={taskDraft}
                rows={3}
                disabled={busy}
                placeholder="Например: следи за числом персонажей и руками; не пропускай текст в кадре"
                className="min-h-[64px] resize-y text-xs"
                onChange={(e) => {
                  setTaskDirty(true);
                  setTaskDraft(e.target.value);
                }}
                onBlur={() => {
                  if (!taskDirty) return;
                  const next = taskDraft.trim();
                  if (next !== (settings?.task ?? "")) saveMut.mutate({ task: next });
                  setTaskDirty(false);
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">
                  Сохраняется по blur или кнопкой
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={busy || !taskDirty || saveMut.isPending}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    saveMut.mutate({ task: taskDraft.trim() });
                    setTaskDirty(false);
                  }}
                >
                  Сохранить
                </Button>
              </div>
            </div>
            {/* Лимиты: перепроверки / перегенерации */}
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  перепроверок
                </span>
                <select
                  value={settings?.max_rechecks ?? 1}
                  disabled={busy}
                  onChange={(e) =>
                    saveMut.mutate({ max_rechecks: Number(e.target.value) })
                  }
                  className="h-8 rounded-lg border border-white/10 bg-black/40 px-2 text-xs disabled:opacity-50"
                  title="Сколько раз перепроверять кадр после перегенерации"
                >
                  {LIMIT_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  перегенераций
                </span>
                <select
                  value={settings?.max_regens ?? 1}
                  disabled={busy}
                  onChange={(e) =>
                    saveMut.mutate({ max_regens: Number(e.target.value) })
                  }
                  className="h-8 rounded-lg border border-white/10 bg-black/40 px-2 text-xs disabled:opacity-50"
                  title="Сколько раз перегенерировать кадр за один прогон"
                >
                  {LIMIT_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
                </>
              ) : null}

              {view === "history" ? (
                <>
            {/* История версий картинки кадра */}
            <section className="border-t border-border pt-2">
              <h4 className="mb-1 text-[11px] font-semibold">История версий картинки</h4>
              {historyByFrame.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  Версий пока нет: они появятся после проверки и перегенераций.
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {historyByFrame.map(([frameNumber, items]) => (
                    <div
                      key={frameNumber}
                      className="rounded-lg border border-border p-1.5"
                    >
                      <p className="mb-1 text-[11px] font-semibold">
                        Кадр #{frameNumber}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((item) => {
                          const applying =
                            applyMut.isPending &&
                            applyMut.variables?.frame_number === frameNumber &&
                            applyMut.variables?.file === item.file;
                          return (
                            <div
                              key={`${frameNumber}:${item.file}:${item.created_at ?? ""}`}
                              className="w-[86px]"
                            >
                              {item.url ? (
                                <img
                                  src={item.url}
                                  alt={`Кадр ${frameNumber}: ${item.file}`}
                                  width={72}
                                  height={72}
                                  loading="lazy"
                                  className={cn(
                                    "h-[72px] w-[72px] rounded border object-cover",
                                    item.active
                                      ? "border-emerald-400/70"
                                      : "border-white/15",
                                  )}
                                />
                              ) : (
                                <div className="flex h-[72px] w-[72px] items-center justify-center rounded border border-white/15 text-[10px] text-muted-foreground">
                                  нет файла
                                </div>
                              )}
                              <div className="mt-0.5 flex items-center gap-1">
                                <span
                                  className={cn(
                                    "rounded-full border px-1 py-0 text-[9px] font-medium uppercase tracking-wide",
                                    verdictBadgeClass(item.verdict),
                                  )}
                                >
                                  {verdictShort(item.verdict)}
                                </span>
                                {item.active ? (
                                  <span className="text-[9px] text-emerald-400">активна</span>
                                ) : null}
                              </div>
                              <p
                                className="mt-0.5 text-[9px] leading-tight text-muted-foreground"
                                title={`${sourceLabel(item.source)} · ${item.file}`}
                              >
                                {shortDate(item.created_at) || sourceLabel(item.source)}
                              </p>
                              {item.active ? null : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="mt-0.5 h-6 w-full text-[10px]"
                                  disabled={applyMut.isPending || !item.url}
                                  onClick={() =>
                                    applyMut.mutate({
                                      frame_number: frameNumber,
                                      file: item.file,
                                    })
                                  }
                                >
                                  {applying ? "Ставим…" : "Поставить"}
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
                </>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
