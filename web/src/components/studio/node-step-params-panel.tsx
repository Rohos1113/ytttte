"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, ChevronDown, ChevronUp, Calculator, Mic, Play, Pause, Plus } from "lucide-react";
import { toast } from "sonner";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { api } from "@/lib/api";
import type { ProjectDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  findElevenLabsVoice,
} from "@/lib/elevenlabs-voices";
import { VoiceLibraryModal, getVoiceById, resolveVoiceName } from "@/components/outsee/voice-library-modal";
import { CloneVoiceDialog } from "@/components/voices/clone-voice-dialog";
import { VoicePickerRow } from "@/components/voices/voice-picker-row";
import { AudioTagsRow } from "@/components/voices/audio-tags-row";
import { voiceLabSampleUrl } from "@/lib/voice-lab-api";
import {
  charCountFromDuration,
  effectiveDurationSeconds,
  readNodeStepParams,
  withNodeStepParams,
  bgmLevelToDb,
  type AssembleStepParams,
  type AudioStepParams,
  type NodeStepParamsMeta,
  type PlanScriptStepParams,
  type SplitStepParams,
} from "@/lib/node-step-params";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

function NumField({
  label,
  description,
  value,
  onChange,
  placeholder = "____",
}: {
  label: string;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {description ? (
        <span className="text-xs text-muted-foreground">{description}</span>
      ) : null}
      <Input
        type="number"
        min={1}
        step={1}
        className="max-w-[200px] font-mono"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PlanScriptFields({
  header,
  step,
  params,
  inheritedFromPlan,
  onSave,
  saving,
}: {
  header: string;
  step: "plan" | "script";
  params: NodeStepParamsMeta;
  inheritedFromPlan: boolean;
  onSave: (patch: PlanScriptStepParams) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const own = params[step]?.duration_seconds;
  const effective = effectiveDurationSeconds(params, step);
  const [durDraft, setDurDraft] = useState(
    own != null && own > 0 ? String(own) : "",
  );

  useEffect(() => {
    setDurDraft(own != null && own > 0 ? String(own) : "");
  }, [own, step]);

  const charCount = charCountFromDuration(effective);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{header}</h3>
        {inheritedFromPlan ? (
          <p className="mt-1 text-xs text-amber-400/90">
            {t("params.planScript.inheritedNotice", { duration: effective ?? "" })}
          </p>
        ) : null}
      </div>
      <NumField
        label={step === "plan" ? t("params.planScript.planDuration") : t("params.planScript.scriptDuration")}
        value={durDraft}
        onChange={setDurDraft}
      />
      <div className="rounded-md border border-white/5 bg-black/20 px-3 py-2 text-sm">
        <p className="text-muted-foreground">
          {t("params.planScript.charCount", { count: charCount != null ? charCount : "____" })}
        </p>
      </div>
      <Button
        size="sm"
        className="w-fit self-start h-9 px-5 text-[13px] font-medium text-white border border-white/25 rounded-md shadow-none transition-colors hover:border-white/60 disabled:opacity-50"
        disabled={saving}
        onClick={() => {
          const trimmed = durDraft.trim();
          onSave({
            duration_seconds: trimmed ? Math.max(1, Math.round(Number(trimmed))) : null,
          });
        }}
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {t("common.save")}
      </Button>
    </section>
  );
}

function AudioFields({
  params,
  onSave,
  saving,
}: {
  params: NodeStepParamsMeta;
  onSave: (patch: AudioStepParams) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const savedId = params.audio?.elevenlabs_voice_id ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const [voiceDraft, setVoiceDraft] = useState(savedId);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [isPlayingSample, setIsPlayingSample] = useState(false);
  const sampleAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setVoiceDraft(savedId);
  }, [savedId]);

  useEffect(() => {
    return () => {
      if (sampleAudioRef.current) {
        sampleAudioRef.current.pause();
        sampleAudioRef.current = null;
      }
    };
  }, []);

  const selected = findElevenLabsVoice(voiceDraft);
  const ruVoice = getVoiceById(voiceDraft);
  const cloneVoiceName = resolveVoiceName(voiceDraft);
  const isClone = !selected && !ruVoice && Boolean(voiceDraft);

  const togglePlaySample = () => {
    if (isPlayingSample) {
      if (sampleAudioRef.current) {
        sampleAudioRef.current.pause();
        sampleAudioRef.current = null;
      }
      setIsPlayingSample(false);
      return;
    }
    const sampleUrl =
      ruVoice?.sample_url ||
      selected?.sample_url ||
      (isClone ? voiceLabSampleUrl(voiceDraft) : null) ||
      `/api/voices/${voiceDraft}/sample`;
    if (!sampleUrl) return;
    const a = new Audio(sampleUrl);
    sampleAudioRef.current = a;
    setIsPlayingSample(true);
    a.play().catch(() => setIsPlayingSample(false));
    a.onended = () => {
      setIsPlayingSample(false);
      sampleAudioRef.current = null;
    };
    a.onerror = () => {
      setIsPlayingSample(false);
      sampleAudioRef.current = null;
    };
  };

  const handleSelectVoiceFromModal = (voiceId: string, voiceName: string) => {
    setVoiceDraft(voiceId);
    onSave({ elevenlabs_voice_id: voiceId });
    toast.success(`Выбран голос: ${voiceName}`);
  };

  const displayName =
    selected?.name ||
    ruVoice?.name ||
    cloneVoiceName ||
    (voiceDraft ? `Клон голоса (${voiceDraft.slice(0, 8)})` : "Голос");
  const displayDesc =
    selected?.description ||
    ruVoice?.description ||
    (isClone ? "Пользовательский клон голоса ElevenLabs" : "");

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">11Labs — голос</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            200 русских премиум-голосов ElevenLabs v4 или ваш собственный клон голоса.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCloneOpen(true)}
            className="h-8 gap-1.5 border-teal-500/30 text-xs text-teal-400 hover:bg-teal-500/10 hover:text-teal-300"
          >
            <Plus className="h-3.5 w-3.5" />
            Клонировать голос
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLibraryOpen(true)}
            className="h-8 gap-1.5 border-cyan-500/30 text-xs text-cyan-400 hover:bg-cyan-500/10 hover:text-cyan-300"
          >
            <Mic className="h-3.5 w-3.5" />
            {t("voices.title")}
          </Button>
        </div>
      </div>

      {/* Меню выбора голоса и эмоциональных аудио-тегов ElevenLabs */}
      <div className="flex flex-col gap-2">
        <VoicePickerRow
          value={voiceDraft}
          onChange={handleSelectVoiceFromModal}
          onClone={() => setCloneOpen(true)}
        />
        <AudioTagsRow
          onInsertTag={(tag) => {
            const activeEl = document.activeElement;
            if (activeEl instanceof HTMLTextAreaElement || activeEl instanceof HTMLInputElement) {
              const start = activeEl.selectionStart ?? activeEl.value.length;
              const end = activeEl.selectionEnd ?? activeEl.value.length;
              activeEl.setRangeText(` ${tag} `, start, end, "end");
              activeEl.dispatchEvent(new Event("input", { bubbles: true }));
              toast.success(t("voices.tags.inserted", { tag }));
            } else {
              navigator.clipboard.writeText(tag).catch(() => {});
              toast.success(t("voices.tags.copied", { tag }));
            }
          }}
        />
      </div>

      {/* Карточка выбранного голоса */}
      {selected || ruVoice || isClone ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
                isClone
                  ? "border-teal-500/30 bg-teal-500/15 text-teal-300"
                  : "border-pink-500/30 bg-pink-500/15 text-pink-400",
              )}
            >
              <Mic className="h-4 w-4" />
            </div>
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-foreground">
                  {displayName}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded border px-1.5 py-0.5 text-[10px]",
                    isClone
                      ? "border-teal-500/30 bg-teal-500/15 text-teal-300"
                      : "border-cyan-500/30 bg-cyan-500/15 text-cyan-300",
                  )}
                >
                  {isClone
                    ? t("voices.badges.clone")
                    : selected?.gender === "female" || ruVoice?.gender === "female"
                      ? t("voices.badges.female")
                      : selected?.gender === "male" || ruVoice?.gender === "male"
                        ? t("voices.badges.male")
                        : t("voices.badges.standard")}
                  {selected?.index || ruVoice?.index ? ` #${selected?.index || ruVoice?.index}` : ""}
                </span>
              </div>
              <span className="truncate text-xs text-muted-foreground">
                {displayDesc}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={togglePlaySample}
              className="h-8 gap-1.5 text-xs text-foreground"
            >
              {isPlayingSample ? <Pause className="h-3.5 w-3.5 text-cyan-400" /> : <Play className="h-3.5 w-3.5 text-cyan-400" />}
              {isPlayingSample ? t("voices.buttons.pause") : t("voices.buttons.playSample")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLibraryOpen(true)}
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("voices.buttons.chooseOther")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-white/15 bg-white/[0.02] p-3">
          <span className="text-xs text-muted-foreground">{t("voices.search.noResults")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLibraryOpen(true)}
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("voices.buttons.chooseFromLib")}
          </Button>
        </div>
      )}

      <Button
        size="sm"
        className="w-fit self-start h-9 px-5 text-[13px] font-medium text-white border border-white/25 rounded-md shadow-none transition-colors hover:border-white/60 disabled:opacity-50"
        disabled={saving}
        onClick={() =>
          onSave({
            elevenlabs_voice_id: voiceDraft || DEFAULT_ELEVENLABS_VOICE_ID,
          })
        }
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {t("common.save")}
      </Button>

      <VoiceLibraryModal
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        selectedVoiceId={voiceDraft}
        onSelectVoice={handleSelectVoiceFromModal}
      />
      <CloneVoiceDialog
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        onCreated={(voice) => {
          const vid = voice.external_voice_id || voice.id;
          handleSelectVoiceFromModal(vid, voice.name);
        }}
      />
    </section>
  );
}

function StepperControl({
  label,
  description,
  value,
  min,
  max,
  step,
  valueLabel,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueLabel: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {description ? (
        <span className="text-xs text-muted-foreground">{description}</span>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled || value <= min}
          onClick={dec}
          aria-label="Уменьшить"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
        <span className="min-w-[7rem] text-center font-mono text-sm text-foreground">
          {valueLabel}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled || value >= max}
          onClick={inc}
          aria-label="Увеличить"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function AssembleFields({
  params,
  metaRecord,
  onSave,
  saving,
}: {
  params: NodeStepParamsMeta;
  metaRecord: Record<string, unknown>;
  onSave: (patch: AssembleStepParams) => void;
  saving: boolean;
}) {
  const subsOn = params.assemble?.subtitles_enabled === true;
  const tailSaved = params.assemble?.post_voiceover_tail_seconds ?? 0;
  const bgmFromMeta =
    typeof metaRecord.bgm_level === "number" ? Math.round(metaRecord.bgm_level) : 35;
  const bgmSaved = params.assemble?.bgm_level ?? bgmFromMeta;
  const sendToMain = params.assemble?.send_to_main_pc === true;
  const skipIntroOn = params.assemble?.skip_intro_enabled === true;
  const skipIntroSec = Math.min(
    2,
    Math.max(0, Number(params.assemble?.skip_intro_seconds ?? 0) || 0),
  );
  const skipIntroLabel = `${skipIntroSec.toFixed(2)} с`;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Сборка FFmpeg</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Субтитры, хвост после озвучки, пропуск начала ролика и громкость фона из music/.
        </p>
      </div>
      <StepperControl
        label="Время видео после окончания озвучки"
        description="Секунды: последний кадр держится после конца голоса; музыка продолжается."
        value={tailSaved}
        min={0}
        max={120}
        step={1}
        valueLabel={`${tailSaved} с`}
        disabled={saving}
        onChange={(next) => onSave({ post_voiceover_tail_seconds: next })}
      />
      <StepperControl
        label="Громкость фоновой музыки"
        description="Файл bgm.mp3 в music/. 100% = 0 дБ на шкале слайдера."
        value={bgmSaved}
        min={0}
        max={100}
        step={5}
        valueLabel={`${bgmSaved} · ${bgmLevelToDb(bgmSaved)}`}
        disabled={saving}
        onChange={(next) => onSave({ bgm_level: next })}
      />
      <button
        type="button"
        data-keep-bg
        disabled={saving}
        onClick={() => onSave({ send_to_main_pc: !sendToMain })}
        className={cn(
          "flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
          sendToMain
            ? "border-emerald-500/35 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.12]"
            : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]",
        )}
      >
        <span className="flex flex-col">
          <span className={cn("text-sm font-medium transition-colors", sendToMain ? "text-emerald-300" : "text-white/90")}>
            Отправить на основной ПК
          </span>
          <span className={cn("text-xs transition-colors", sendToMain ? "text-emerald-400/80" : "text-zinc-400")}>
            {sendToMain
              ? "После музыки проект уйдёт на hub для ASR и FFmpeg"
              : "Монтаж локально на этой станции"}
          </span>
        </span>
        <span
          data-keep-bg
          className={cn(
            "mt-0.5 h-5 w-9 shrink-0 rounded-full border p-0.5 transition-colors",
            sendToMain ? "border-emerald-500/60 bg-emerald-500" : "border-white/20 bg-zinc-800",
          )}
        >
          <span
            data-keep-bg
            className={cn(
              "block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
              sendToMain ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>
      <button
        type="button"
        data-keep-bg
        disabled={saving}
        onClick={() => onSave({ subtitles_enabled: !subsOn })}
        className={cn(
          "flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
          subsOn
            ? "border-emerald-500/35 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.12]"
            : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]",
        )}
      >
        <span className="flex flex-col">
          <span className={cn("text-sm font-medium transition-colors", subsOn ? "text-emerald-300" : "text-white/90")}>
            Субтитры в ролике
          </span>
          <span className={cn("text-xs transition-colors", subsOn ? "text-emerald-400/80" : "text-zinc-400")}>
            {subsOn ? "Включены — ASS вшивается при сборке" : "Выключены — без прожига текста"}
          </span>
        </span>
        <span
          data-keep-bg
          className={cn(
            "mt-0.5 h-5 w-9 shrink-0 rounded-full border p-0.5 transition-colors",
            subsOn ? "border-emerald-500/60 bg-emerald-500" : "border-white/20 bg-zinc-800",
          )}
        >
          <span
            data-keep-bg
            className={cn(
              "block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
              subsOn ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>
      <button
        type="button"
        data-keep-bg
        disabled={saving}
        onClick={() =>
          onSave({
            skip_intro_enabled: !skipIntroOn,
            skip_intro_seconds: skipIntroOn ? skipIntroSec : skipIntroSec || 0.5,
          })
        }
        className={cn(
          "flex w-full items-start justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-all",
          skipIntroOn
            ? "border-emerald-500/35 bg-emerald-500/[0.08] hover:bg-emerald-500/[0.12]"
            : "border-white/10 bg-white/[0.02] hover:bg-white/[0.05]",
        )}
      >
        <span className="flex flex-col">
          <span className={cn("text-sm font-medium transition-colors", skipIntroOn ? "text-emerald-300" : "text-white/90")}>
            Не учитывать первые секунды
          </span>
          <span className={cn("text-xs transition-colors", skipIntroOn ? "text-emerald-400/80" : "text-zinc-400")}>
            {skipIntroOn
              ? `Отрезаем начало ролика: ${skipIntroLabel}`
              : "Выкл — ролик с 0:00 без обрезки начала"}
          </span>
        </span>
        <span
          data-keep-bg
          className={cn(
            "mt-0.5 h-5 w-9 shrink-0 rounded-full border p-0.5 transition-colors",
            skipIntroOn ? "border-emerald-500/60 bg-emerald-500" : "border-white/20 bg-zinc-800",
          )}
        >
          <span
            data-keep-bg
            className={cn(
              "block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
              skipIntroOn ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>
      {skipIntroOn ? (
        <StepperControl
          label="Сколько секунд от начала отрезать"
          description="Шаг 0.01 с (сотые). Диапазон 0.00–2.00. Не учитываются в финальном mp4."
          value={Number(skipIntroSec.toFixed(2))}
          min={0}
          max={2}
          step={0.01}
          valueLabel={skipIntroLabel}
          disabled={saving}
          onChange={(next) =>
            onSave({
              skip_intro_enabled: true,
              skip_intro_seconds: Math.round(Math.min(2, Math.max(0, next)) * 100) / 100,
            })
          }
        />
      ) : null}
      {saving ? (
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Сохранение…
        </span>
      ) : null}
    </section>
  );
}

function SplitFields({
  params,
  project,
  onSave,
  saving,
}: {
  params: NodeStepParamsMeta;
  project?: ProjectDetail | null;
  onSave: (patch: SplitStepParams) => void;
  saving: boolean;
}) {
  const split = params.split || {};
  const [minDraft, setMinDraft] = useState(split.cell_min_chars != null ? String(split.cell_min_chars) : "30");
  const [maxDraft, setMaxDraft] = useState(split.cell_max_chars != null ? String(split.cell_max_chars) : "120");
  const [avgMinDraft, setAvgMinDraft] = useState(split.cell_avg_min != null ? String(split.cell_avg_min) : "50");
  const [avgMaxDraft, setAvgMaxDraft] = useState(split.cell_avg_max != null ? String(split.cell_avg_max) : "80");

  useEffect(() => {
    setMinDraft(split.cell_min_chars != null ? String(split.cell_min_chars) : "30");
    setMaxDraft(split.cell_max_chars != null ? String(split.cell_max_chars) : "120");
    setAvgMinDraft(split.cell_avg_min != null ? String(split.cell_avg_min) : "50");
    setAvgMaxDraft(split.cell_avg_max != null ? String(split.cell_avg_max) : "80");
  }, [split.cell_avg_max, split.cell_avg_min, split.cell_max_chars, split.cell_min_chars]);

  const generalPlan = (project?.general_plan || ((project?.meta as Record<string, unknown> | undefined)?.general_plan as string) || "").trim();
  const scriptText = (project?.script_text || "").trim();
  const charCount = scriptText.length;

  const targetFrames = useMemo(() => {
    if (!generalPlan) return null;
    const matches = Array.from(generalPlan.matchAll(/(?:Кадр|кадр)\s*(\d+)/g)).map((m) => parseInt(m[1], 10));
    if (matches.length > 0) return Math.max(...matches);
    const m = generalPlan.match(/(\d+)\s*(?:кадр|кадров|кадра)/i);
    if (m) return parseInt(m[1], 10);
    return null;
  }, [generalPlan]);

  const calc = useMemo(() => {
    if (!targetFrames || targetFrames <= 0 || charCount <= 0) return null;
    const avg = Math.round(charCount / targetFrames);
    const min = Math.max(10, Math.round(avg * 0.5));
    const max = Math.max(40, Math.round(avg * 1.8));
    const avgMin = Math.max(15, Math.round(avg * 0.8));
    const avgMax = Math.max(25, Math.round(avg * 1.15));
    return { avg, min, max, avgMin, avgMax };
  }, [targetFrames, charCount]);

  const parseOpt = (s: string) => {
    const t = s.trim();
    if (!t) return null;
    const n = Math.round(Number(t));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Разбивка</h3>
      </div>

      {calc && targetFrames ? (
        <div className="flex flex-col gap-2 rounded-xl border border-cyan-500/30 bg-cyan-950/30 p-3 text-xs text-cyan-200 backdrop-blur-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-cyan-100 flex items-center gap-1.5">
              <Calculator className="h-3.5 w-3.5 text-cyan-400" />
              Расчёт под сценарий ролика
            </span>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs bg-cyan-600 hover:bg-cyan-500 text-white font-medium rounded-lg border border-cyan-400/40 shadow-sm shadow-cyan-500/20"
              onClick={() => {
                setMinDraft(calc.min.toString());
                setMaxDraft(calc.max.toString());
                setAvgMinDraft(calc.avgMin.toString());
                setAvgMaxDraft(calc.avgMax.toString());
                toast.success(
                  `Подставлены параметры под ${targetFrames} кадров: ${calc.min} / ${calc.max} / ${calc.avgMin}–${calc.avgMax}`,
                );
              }}
            >
              Применить расчёт ({targetFrames} кадр.)
            </Button>
          </div>
          <p className="text-cyan-200/80 leading-relaxed">
            В сценарии <strong>{targetFrames} кадров</strong>, закадровый текст <strong>{charCount} знаков</strong>.
            Средняя длина кадра: <strong>~{calc.avg} знаков (~{Math.round((calc.avg / 14) * 10) / 10} сек)</strong>.
          </p>
        </div>
      ) : null}

      <NumField
        label="Минимальное количество символов в кадре"
        description="Стандартное значение: 30 символов (~2 сек озвучки)"
        placeholder="30"
        value={minDraft}
        onChange={setMinDraft}
      />
      <NumField
        label="Максимальное количество символов в кадре"
        description="Стандартное значение: 120 символов (~8 сек озвучки)"
        placeholder="120"
        value={maxDraft}
        onChange={setMaxDraft}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <NumField
          label="Среднее значение — от"
          description="Стандарт: 50 знаков"
          placeholder="50"
          value={avgMinDraft}
          onChange={setAvgMinDraft}
        />
        <NumField
          label="Среднее значение — до"
          description="Стандарт: 80 знаков"
          placeholder="80"
          value={avgMaxDraft}
          onChange={setAvgMaxDraft}
        />
      </div>
      <Button
        size="sm"
        className="w-fit self-start h-9 px-5 text-[13px] font-medium text-white border border-white/25 rounded-md shadow-none transition-colors hover:border-white/60 disabled:opacity-50"
        disabled={saving}
        onClick={() =>
          onSave({
            cell_min_chars: parseOpt(minDraft),
            cell_max_chars: parseOpt(maxDraft),
            cell_avg_min: parseOpt(avgMinDraft),
            cell_avg_max: parseOpt(avgMaxDraft),
          })
        }
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Сохранить
      </Button>
    </section>
  );
}

function MediaStreamsFields({
  metaRecord,
  onSave,
  saving,
  nodeType,
}: {
  metaRecord: Record<string, unknown>;
  onSave: (metaPatch: Record<string, unknown>) => void;
  saving: boolean;
  nodeType: "images" | "videos";
}) {
  const currentStreams = Number(
    metaRecord.outsee_streams ?? metaRecord.img_streams ?? 2,
  );
  const [streams, setStreams] = useState<number>(currentStreams);

  useEffect(() => {
    setStreams(
      Number(metaRecord.outsee_streams ?? metaRecord.img_streams ?? 2),
    );
  }, [metaRecord.outsee_streams, metaRecord.img_streams]);

  const handleSelect = (val: number) => {
    setStreams(val);
    onSave({
      ...metaRecord,
      img_streams: val,
      outsee_streams: val,
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          Параллельные потоки генерации
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Количество одновременных задач в VIA Render для генерации {nodeType === "images" ? "картинок" : "видео"}.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {[1, 2, 3, 4].map((num) => (
          <Button
            key={num}
            type="button"
            size="sm"
            variant={streams === num ? "default" : "outline"}
            disabled={saving}
            className={cn(
              "h-8 px-3.5 text-xs",
              streams === num
                ? "bg-white text-black font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => handleSelect(num)}
          >
            {num} {num === 1 ? "поток" : num < 5 ? "потока" : "потоков"}
            {num === 2 && <span className="ml-1 opacity-60 text-[10px]">(дефолт)</span>}
            {num === 4 && <span className="ml-1 opacity-60 text-[10px]">(макс)</span>}
          </Button>
        ))}
      </div>

    </section>
  );
}

export function NodeStepParamsPanel({
  projectId,
  nodeType,
}: {
  projectId: number;
  nodeType: string;
}) {
  const qc = useQueryClient();
  const step =
    nodeType === "plan" ||
    nodeType === "script" ||
    nodeType === "split" ||
    nodeType === "audio" ||
    nodeType === "assemble" ||
    nodeType === "images" ||
    nodeType === "videos"
      ? nodeType
      : null;

  const { t } = useTranslation();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    enabled: projectId > 0 && step != null,
  });

  const save = useMutation({
    mutationFn: async ({
      meta,
    }: {
      meta: Record<string, unknown>;
    }) => api.patchProject(projectId, { meta }),
    onSuccess: () => {
      toast.success(t("params.savedToast"));
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["gpt-text", projectId] });
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const metaRecord = (project.data?.meta || {}) as Record<string, unknown>;
  const params = useMemo(() => readNodeStepParams(metaRecord), [metaRecord]);

  if (!step || (project.isLoading && !project.data)) return null;

  const persist = (
    patch: PlanScriptStepParams | SplitStepParams | AudioStepParams | AssembleStepParams,
  ) => {
    if (step === "images" || step === "videos" || !step) return;
    save.mutate({ meta: withNodeStepParams(metaRecord, step, patch) });
  };

  const persistMeta = (metaPatch: Record<string, unknown>) => {
    save.mutate({ meta: metaPatch });
  };

  return (
    <div className="flex flex-col gap-4" data-params-panel="true">
      {step === "plan" ? (
        <PlanScriptFields
          header={t("canvas.nodes.plan")}
          step="plan"
          params={params}
          inheritedFromPlan={false}
          onSave={persist}
          saving={save.isPending}
        />
      ) : null}
      {step === "script" ? (
        <PlanScriptFields
          header={t("canvas.nodes.script")}
          step="script"
          params={params}
          inheritedFromPlan={
            !(params.script?.duration_seconds != null && params.script.duration_seconds > 0) &&
            effectiveDurationSeconds(params, "script") != null
          }
          onSave={persist}
          saving={save.isPending}
        />
      ) : null}
      {step === "split" ? (
        <SplitFields params={params} project={project.data} onSave={persist} saving={save.isPending} />
      ) : null}
      {step === "audio" ? (
        <AudioFields params={params} onSave={persist} saving={save.isPending} />
      ) : null}
      {step === "assemble" ? (
        <AssembleFields
          params={params}
          metaRecord={metaRecord}
          onSave={persist}
          saving={save.isPending}
        />
      ) : null}
      {false && (step === "images" || step === "videos") ? (
        <MediaStreamsFields
          metaRecord={metaRecord}
          onSave={persistMeta}
          saving={save.isPending}
          nodeType={step as "images" | "videos"}
        />
      ) : null}
    </div>
  );
}

/** Compact streams selector (project meta outsee_streams/img_streams, read by generate_images/videos/hero). */
export function StreamsPicker({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", projectId], queryFn: () => api.getProject(projectId), enabled: projectId > 0 });
  const meta = (project.data?.meta || {}) as Record<string, unknown>;
  const cur = Number(meta.outsee_streams ?? meta.img_streams ?? 2);
  const save = useMutation({
    mutationFn: (n: number) =>
      api.patchProject(projectId, { meta: { img_streams: n, outsee_streams: n } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });
  return (
    <div data-vp-streams className="flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-[0.12em] text-white/50">Потоки</span>
      <div className="flex">
        {[1, 2, 3, 4].map((n) => (
          <button
            key={n}
            type="button"
            disabled={save.isPending || !project.isSuccess}
            onClick={() => save.mutate(n)}
            className={cn("h-8 w-8 border text-[13px] first:rounded-l-md last:rounded-r-md", n === cur ? "border-white bg-white text-black" : "border-white/15 text-white/70 hover:text-white")}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
