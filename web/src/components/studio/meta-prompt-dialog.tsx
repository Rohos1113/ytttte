"use client";

import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  CheckCircle2,
  Wand2,
  ShieldCheck,
  Zap,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function MetaPromptDialog({
  stepCode,
  projectId,
  onSaved,
  trigger,
  initialIntent = "",
  initialPresetName = "",
}: {
  stepCode: string;
  projectId?: number;
  onSaved?: (fileName: string) => void;
  trigger?: React.ReactNode;
  initialIntent?: string;
  initialPresetName?: string;
}) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState(initialIntent);
  const [presetName, setPresetName] = useState(initialPresetName);
  const [compiledPrompt, setCompiledPrompt] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    length_chars: number;
    lines_count: number;
    has_schema: boolean;
    has_guards: boolean;
  } | null>(null);

  const compileMutation = useMutation({
    mutationFn: async () => {
      if (!intent.trim()) {
        throw new Error("Введите описание задачи для Агента");
      }
      return await api.compileMetaPrompt({
        step_code: stepCode,
        user_intent: intent,
        project_id: projectId,
        target_name: presetName.trim() || undefined,
      });
    },
    onSuccess: (data) => {
      setCompiledPrompt(data.compiled_prompt);
      setStats(data.stats);
      if (!presetName.trim() && data.name) {
        setPresetName(data.name);
      }
      toast.success("Промпт успешно скомпилирован ИИ-Агентом!");
    },
    onError: (err) => {
      toast.error(errorMessageFromUnknown(err));
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!compiledPrompt) return;
      const name = presetName.trim() || "custom_meta_prompt";
      return await api.saveAndActivateMetaPrompt({
        step_code: stepCode,
        name,
        content: compiledPrompt,
        project_id: projectId,
        activate: true,
      });
    },
    onSuccess: (data) => {
      if (!data) return;
      toast.success(`Личный промпт ${data.file_name} сохранён и активирован!`);
      qc.invalidateQueries({ queryKey: ["prompt-files"] });
      qc.invalidateQueries({ queryKey: ["project"] });
      if (onSaved) {
        onSaved(data.file_name);
      }
      setOpen(false);
      setCompiledPrompt(null);
      setIntent("");
      setPresetName("");
    },
    onError: (err) => {
      toast.error(errorMessageFromUnknown(err));
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-400/60 shadow-sm transition-all"
          >
            <Wand2 className="h-3.5 w-3.5 text-emerald-400" />
            Создать с ИИ-агентом
          </Button>
        )}
      </DialogTrigger>

      <DialogContent
        overlayClassName="z-[200] bg-black/85 backdrop-blur-sm"
        className="z-[210] w-[94vw] max-w-4xl max-h-[88vh] overflow-y-auto overflow-x-hidden rounded-2xl border border-white/10 bg-[#0e0e12]/95 backdrop-blur-xl p-6 shadow-2xl [contain:paint]"
      >
        <DialogHeader className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#2dd4bf]/35 bg-[#2dd4bf]/15 text-[#2dd4bf] shadow-[0_0_15px_rgba(45,212,191,0.2)]">
              <Wand2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-semibold leading-tight text-white flex items-center gap-2">
                <span>Конструктор мастер-промптов ИИ-Агентом</span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[#2dd4bf]/15 text-[#2dd4bf] border border-[#2dd4bf]/30">
                  ИИ-Агент
                </span>
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-400 break-words mt-1">
                Шаг: <span className="font-mono text-[#2dd4bf] font-semibold px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/10">{stepCode}</span> — напишите задачу своими словами или загрузите текст из файла, агент скомпилирует системный .md промпт под этот шаг.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Имя пресета и задача */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1 flex flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5 space-y-2">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Имя файла (.md):
                </label>
                <Input
                  placeholder="авто-генерация или имя"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  className="h-9 bg-black/40 border-white/10 text-xs font-mono text-zinc-100 placeholder:text-zinc-500 focus-visible:border-white/20 focus-visible:ring-0 focus-visible:outline-none focus-visible:shadow-none"
                />
              </div>
              <span className="text-[11px] text-zinc-500 leading-tight">
                Создаёт личный промпт, изолированный для вашего аккаунта
              </span>
            </div>
            <div className="sm:col-span-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
                  Что должен делать этот промпт:
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1.5 px-2 text-[11px] font-medium text-zinc-400 hover:text-[#2dd4bf] hover:bg-[#2dd4bf]/10 border border-transparent hover:border-[#2dd4bf]/20 rounded-lg transition-all"
                  onClick={() => fileInputRef.current?.click()}
                  title="Загрузить текст из файла (.txt, .md)"
                >
                  <Upload className="h-3 w-3" />
                  <span>Из файла</span>
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (event) => {
                      const text = event.target?.result;
                      if (typeof text === "string" && text.trim()) {
                        setIntent(text.trim());
                        if (!presetName.trim()) {
                          const autoName = file.name
                            .replace(/\.[^/.]+$/, "")
                            .replace(/[^a-zA-Z0-9_-]+/g, "_")
                            .toLowerCase();
                          setPresetName(autoName);
                        }
                        toast.success(`Текст из файла «${file.name}» загружен`);
                      }
                    };
                    reader.readAsText(file, "utf-8");
                    e.target.value = "";
                  }}
                />
              </div>
              <Textarea
                placeholder="Опишите желаемую логику, стиль, правила или вставьте свой черновик промпта..."
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                className="min-h-[100px] bg-black/40 border-white/10 text-xs text-zinc-100 placeholder:text-zinc-500 focus-visible:border-white/20 focus-visible:ring-0 focus-visible:outline-none focus-visible:shadow-none resize-none leading-relaxed rounded-xl"
              />
            </div>
          </div>

          {/* Кнопка запуска компиляции */}
          <Button
            type="button"
            className={cn(
              "w-full gap-2 text-xs font-extrabold uppercase tracking-wider h-11 rounded-xl transition-all duration-200",
              compileMutation.isPending || !intent.trim()
                ? "bg-zinc-800 text-zinc-500 border border-white/5 cursor-not-allowed"
                : "bg-gradient-to-r from-[#2dd4bf] to-[#0d9488] text-black shadow-[0_0_20px_rgba(45,212,191,0.35)] hover:brightness-110 active:scale-[0.99] cursor-pointer"
            )}
            disabled={compileMutation.isPending || !intent.trim()}
            onClick={() => compileMutation.mutate()}
          >
            {compileMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-black" />
                <span>Компилируем промпт через ИИ-Агента...</span>
              </>
            ) : (
              <>
                <Zap className="h-4 w-4 fill-black text-black" />
                <span>Скомпилировать системный .md промпт</span>
              </>
            )}
          </Button>

          {/* Результат компиляции */}
          {compiledPrompt && (
            <div className="space-y-2.5 rounded-xl border border-[#2dd4bf]/30 bg-[#2dd4bf]/10 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#2dd4bf]">
                  <CheckCircle2 className="h-4 w-4 text-[#2dd4bf]" />
                  <span>Готовый результат компиляции</span>
                </div>
                {stats && (
                  <div className="flex items-center gap-2.5 text-[11px] text-zinc-400">
                    <span className="font-mono text-zinc-300">{stats.lines_count} строк</span>
                    <span>·</span>
                    <span className="font-mono text-zinc-300">{stats.length_chars} символов</span>
                    {stats.has_guards && (
                      <span className="flex items-center gap-1 rounded bg-[#2dd4bf]/15 border border-[#2dd4bf]/30 px-1.5 py-0.5 text-[#2dd4bf] font-medium text-[10px]">
                        <ShieldCheck className="h-3 w-3 text-[#2dd4bf]" /> No-Chat Guard
                      </span>
                    )}
                  </div>
                )}
              </div>

              <Textarea
                value={compiledPrompt}
                onChange={(e) => setCompiledPrompt(e.target.value)}
                className="min-h-[320px] font-mono text-[11px] leading-relaxed bg-black/60 border-white/10 rounded-xl text-zinc-100 whitespace-pre-wrap break-words resize-y focus-visible:border-white/20 focus-visible:ring-0 focus-visible:outline-none focus-visible:shadow-none p-3"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between pt-2 border-t border-white/[0.08] mt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="text-xs text-zinc-400 hover:text-white rounded-xl"
          >
            Отмена
          </Button>

          {compiledPrompt && (
            <Button
              type="button"
              size="sm"
              className="w-36 h-9 rounded-xl bg-gradient-to-r from-[#2dd4bf] to-[#0d9488] text-black text-xs font-extrabold uppercase tracking-wider shadow-[0_0_15px_rgba(45,212,191,0.3)] hover:brightness-110"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin text-black" />
              ) : null}
              Сохранить
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
