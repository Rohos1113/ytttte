"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileAudio,
  Loader2,
  Mic,
  Upload,
  X,
} from "lucide-react";
import {
  CLONE_SAMPLE_EXTENSIONS,
  CLONE_SAMPLE_MAX_BYTES,
  createVoiceClone,
  formatBytes,
  sampleExtension,
  type VoiceLabVoice,
} from "@/lib/voice-lab-api";
import { useTranslation } from "@/lib/i18n";

const LANGUAGES_RU: Array<{ value: string; label: string }> = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "Английский" },
  { value: "de", label: "Немецкий" },
  { value: "es", label: "Испанский" },
  { value: "fr", label: "Французский" },
  { value: "it", label: "Итальянский" },
  { value: "pl", label: "Польский" },
  { value: "pt", label: "Португальский" },
  { value: "tr", label: "Турецкий" },
  { value: "uk", label: "Украинский" },
];

const LANGUAGES_EN: Array<{ value: string; label: string }> = [
  { value: "ru", label: "Russian" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "it", label: "Italian" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
];

const ACCEPT_ATTR = ".mp3,.wav,.m4a,.ogg,.flac,audio/*";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Голос создан (пусть даже без ключа провайдера) — списку клонов пора обновиться. */
  onCreated?: (voice: VoiceLabVoice, providerError: string | null) => void;
  /** Сколько созданий уже израсходовано сегодня — для предупреждения о лимите. */
  dailyUsed?: number;
  /** Дневной лимит созданий; по умолчанию 10, как на бэкенде. */
  dailyLimit?: number;
};

/**
 * Мастер клонирования голоса: имя → сэмплы → согласие.
 *
 * Открывается из модалки «Голоса». Отправляет один multipart-запрос
 * `POST /api/voice-lab/clones`; при отсутствии ключа ElevenLabs бэкенд всё равно
 * сохраняет сэмплы и отдаёт голос со статусом `pending_provider` — тогда мастер
 * честно говорит, что голос появится позже, и не притворяется успехом.
 */
export function CloneVoiceDialog({
  open,
  onOpenChange,
  onCreated,
  dailyUsed,
  dailyLimit,
}: Props) {
  const { t, isEn } = useTranslation();
  const languages = isEn ? LANGUAGES_EN : LANGUAGES_RU;
  const steps = [
    { n: 1, label: t("voices.cloneDialog.step1") },
    { n: 2, label: t("voices.cloneDialog.step2") },
    { n: 3, label: t("voices.cloneDialog.step3") },
  ];
  const [mounted, setMounted] = useState(false);
  // Появление панели сдвигом справа: первый кадр за экраном, второй — на месте.
  const [entered, setEntered] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("ru");
  const [files, setFiles] = useState<File[]>([]);
  const [consent, setConsent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [providerError, setProviderError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  /** Координаты панели: справа от «Параметров», высотой в 1.5 раза выше них. */
  const [pos, setPos] = useState<{ top: number; left: number; width: number; height: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open) return;
    const panel = document.querySelector("[data-params-panel]");
    const rect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
    const width = 470;
    if (rect && rect.height > 0) {
      // Как и меню голосов: низ по низу «Параметров», высота в 1.5 раза больше.
      const height = Math.max(380, Math.min(rect.height * 1.5, rect.bottom - 8));
      const top = Math.max(8, rect.bottom - height);
      const left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 12));
      setPos({ top, left, width, height });
      return;
    }
    // «Параметры» закрыты — держим панель в правой части окна, но не у самого края.
    const height = Math.min(560, window.innerHeight - 16);
    setPos({
      top: Math.max(8, (window.innerHeight - height) / 2),
      left: Math.max(8, window.innerWidth - width - 80),
      width,
      height,
    });
  }, [open]);

  useEffect(() => setMounted(true), []);

  // Панель выезжает справа: держим её за экраном один кадр, затем сдвигаем.
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
    };
  }, [open]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Каждое открытие — с чистого листа: остатки прошлой попытки не должны пугать.
  useEffect(() => {
    if (!open) return;
    clearCloseTimer();
    setStep(1);
    setName("");
    setDescription("");
    setLanguage("ru");
    setFiles([]);
    setConsent(false);
    setDragging(false);
    setError("");
    setProviderError(null);
    setSuccess(false);
    setSubmitting(false);
  }, [open, clearCloseTimer]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  // ESC закрывает мастер, пока идёт отправка — нет.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, submitting, onOpenChange]);

  const totalBytes = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files]);
  const limit = dailyLimit && dailyLimit > 0 ? dailyLimit : 10;
  const used = typeof dailyUsed === "number" && dailyUsed > 0 ? dailyUsed : 0;

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (!incoming.length) return;
      const problems: string[] = [];
      const accepted: File[] = [];
      let total = files.reduce((sum, f) => sum + f.size, 0);
      for (const file of incoming) {
        const ext = sampleExtension(file.name);
        if (!CLONE_SAMPLE_EXTENSIONS.includes(ext)) {
          problems.push(`«${file.name}» не подходит: нужен mp3, wav, m4a, ogg или flac.`);
          continue;
        }
        if (file.size > CLONE_SAMPLE_MAX_BYTES) {
          problems.push(`«${file.name}» больше 25 МБ.`);
          continue;
        }
        if (total + file.size > CLONE_SAMPLE_MAX_BYTES) {
          problems.push(`«${file.name}» не помещается: суммарно получится больше 25 МБ.`);
          continue;
        }
        total += file.size;
        accepted.push(file);
      }
      if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
      setError(problems.join(" "));
    },
    [files],
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setError("");
  };

  const canGoNext = step === 1 ? name.trim().length > 0 : step === 2 ? files.length > 0 : false;

  const submit = async () => {
    if (submitting || !consent || files.length === 0) return;
    setSubmitting(true);
    setError("");
    setProviderError(null);
    try {
      const result = await createVoiceClone({
        name: name.trim(),
        description,
        language,
        kind: "instant",
        samples: files,
      });
      setProviderError(result.provider_error);
      onCreated?.(result.voice, result.provider_error);
      if (result.provider_error) {
        // Сэмплы сохранены, но голос ещё не создан — мастер не закрываем:
        // человек должен увидеть, что именно пошло не так.
        return;
      }
      setSuccess(true);
      clearCloseTimer();
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        onOpenChange(false);
      }, 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать голос");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !mounted) return null;

  const submitLabel = submitting
    ? t("voices.buttons.creating")
    : t("voices.buttons.createClone");

  return createPortal(
    <div
      data-params-flyout="true"
      role="dialog"
      aria-label="Новый голос"
      style={{
        position: "fixed",
        top: pos?.top ?? 40,
        left: pos?.left ?? 40,
        width: pos?.width ?? 470,
        height: pos?.height ?? 560,
      }}
      className={`z-[1200] flex flex-col overflow-hidden rounded-xl border border-white/15 bg-[#121216]/[0.98] text-white shadow-[0_18px_45px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl transition-opacity duration-150 ${
        entered ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* Шапка */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#2dd4bf]/10 text-[#2dd4bf] ring-1 ring-[#2dd4bf]/25">
              <Mic className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-white">Новый голос</h2>
                <span className="rounded-full bg-[#22d3ee]/20 px-1.5 py-0.5 text-[10px] font-medium text-[#22d3ee]">
                  Мгновенное клонирование
                </span>
              </div>
              <p className="text-[11px] text-white/50">
                Загрузите записи диктора — голос появится в табе «Мои клоны»
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
            title="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Шаги */}
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.02] px-3 py-2">
          {steps.map((s, i) => {
            const done = step > s.n;
            const active = step === s.n;
            return (
              <div key={s.n} className="flex flex-1 items-center gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                      done
                        ? "bg-emerald-500/20 text-emerald-300"
                        : active
                          ? "bg-[#22d3ee] text-black"
                          : "bg-white/10 text-white/45"
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5 stroke-[3]" /> : s.n}
                  </span>
                  <span
                    className={`text-[12px] font-medium ${
                      active ? "text-white" : done ? "text-emerald-300/90" : "text-white/40"
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                {i < steps.length - 1 ? (
                  <div className={`h-px flex-1 ${step > s.n ? "bg-emerald-500/40" : "bg-white/10"}`} />
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Тело мастера */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {success ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-400" />
              <p className="text-[14px] font-semibold text-white">{t("voices.cloneDialog.success")}</p>
            </div>
          ) : step === 1 ? (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-white">{t("voices.cloneDialog.voiceNameLabel")}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("voices.cloneDialog.voiceNamePlaceholder")}
                  className="w-full rounded-xl border border-white/10 bg-[#161720] px-3 py-2 text-[13px] text-white placeholder-white/35 outline-none transition focus:border-[#22d3ee]/50 focus:ring-1 focus:ring-[#22d3ee]/30"
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-white">{t("voices.cloneDialog.descLabel")}</span>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder={t("voices.cloneDialog.descPlaceholder")}
                  className="w-full resize-none rounded-xl border border-white/10 bg-[#161720] px-3 py-2 text-[13px] text-white placeholder-white/35 outline-none transition focus:border-[#22d3ee]/50 focus:ring-1 focus:ring-[#22d3ee]/30"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-white">{t("voices.cloneDialog.languageLabel")}</span>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="h-9 w-full max-w-[260px] rounded-xl border border-white/10 bg-[#161720] px-2 text-[13px] text-white outline-none focus:border-[#22d3ee]/50"
                >
                  {languages.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : step === 2 ? (
            <div className="flex flex-col gap-3">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  addFiles(Array.from(e.dataTransfer.files));
                }}
                className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center transition ${
                  dragging
                    ? "border-[#22d3ee]/70 bg-[#22d3ee]/10"
                    : "border-white/15 bg-[#161720]/70 hover:border-white/25"
                }`}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#22d3ee]/10 text-[#22d3ee]">
                  <Upload className="h-5 w-5" />
                </div>
                <p className="text-[13px] font-medium text-white">{t("voices.cloneDialog.dragTitle")}</p>
                <p className="text-[11px] text-white/45">
                  {t("voices.cloneDialog.dragHint")}
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-1 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-white/10"
                >
                  {t("voices.buttons.selectFiles")}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPT_ATTR}
                  className="hidden"
                  onChange={(e) => {
                    addFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-white/45">
                <span>
                  {t("voices.cloneDialog.filesSummary", { count: files.length, size: formatBytes(totalBytes) })}
                </span>
                {files.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setFiles([])}
                    className="text-[11px] text-white/40 transition hover:text-white"
                  >
                    {t("voices.buttons.clearAll")}
                  </button>
                ) : null}
              </div>

              {files.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {files.map((file, index) => (
                    <div
                      key={`${file.name}-${file.lastModified}-${index}`}
                      className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-[#161720] px-3 py-2"
                    >
                      <FileAudio className="h-4 w-4 shrink-0 text-[#22d3ee]" />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-white">{file.name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-white/40">
                        {formatBytes(file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(index)}
                        title={t("voices.buttons.removeFile")}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/35 transition hover:bg-white/10 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-white/35">
                  {t("voices.cloneDialog.sampleTip")}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-white/10 bg-[#161720]/70 p-4">
                <p className="text-[13px] font-medium text-white">
                  {name.trim() || (isEn ? "Untitled" : "Без названия")}
                  <span className="ml-2 text-[11px] font-normal text-white/40">
                    {languages.find((l) => l.value === language)?.label ?? language}
                  </span>
                </p>
                {description.trim() ? (
                  <p className="mt-1 text-[12px] text-white/55">{description.trim()}</p>
                ) : null}
                <p className="mt-2 text-[11px] text-white/40">
                  {t("voices.cloneDialog.filesSummary", { count: files.length, size: formatBytes(totalBytes) })}
                </p>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/10 bg-[#161720]/70 p-3">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#22d3ee]"
                />
                <span className="text-[12px] text-white/75">
                  {t("voices.cloneDialog.consentCheckbox")}
                </span>
              </label>

              <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-[12px] text-amber-200/90">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                <div>
                  {t("voices.cloneDialog.paidWarning", { used, limit })}
                </div>
              </div>

              {providerError ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-200">
                  {t("voices.cloneDialog.providerSaved", { error: providerError })}
                </div>
              ) : null}

              {error ? (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[12px] text-rose-200">
                  {error}
                </div>
              ) : null}
            </div>
          )}

          {step !== 3 && error ? (
            <p className="mt-3 text-[12px] text-rose-300">{error}</p>
          ) : null}
        </div>

        {/* Подвал */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-white/[0.02] px-3 py-2">
          <button
            type="button"
            onClick={() => (step === 1 ? onOpenChange(false) : setStep(step - 1))}
            disabled={submitting}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-white/10 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {step === 1 ? t("voices.buttons.backToVoices") : t("voices.buttons.back")}
          </button>

          <div className="flex items-center gap-2">
            <span className="hidden text-[11px] text-white/35 sm:block">
              {t("voices.cloneDialog.stepProgress", { step, total: steps.length })}
            </span>
            {success ? null : providerError ? (
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg bg-[#22d3ee] px-4 py-1.5 text-[12px] font-semibold text-black transition hover:bg-[#67e8f9]"
              >
                {t("voices.buttons.done")}
              </button>
            ) : step < 3 ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={!canGoNext}
                className="flex items-center gap-1 rounded-lg bg-[#22d3ee] px-4 py-1.5 text-[12px] font-semibold text-black transition hover:bg-[#67e8f9] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("voices.buttons.next")}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!consent || submitting || files.length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-[#22d3ee] px-4 py-1.5 text-[12px] font-semibold text-black transition hover:bg-[#67e8f9] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {submitLabel}
              </button>
            )}
          </div>
        </div>
    </div>,
    document.body,
  );
}
