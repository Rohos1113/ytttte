"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Loader2,
  Mic,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import RU_VOICES_DATA from "@/lib/ru-voices.json";
import { STANDARD_ELEVENLABS_VOICES } from "@/lib/elevenlabs-voices";
import {
  deleteVoiceClone,
  isVoiceCloneReady,
  isVoiceLabUnavailable,
  listVoiceLabVoices,
  updateVoiceClone,
  voiceLabSampleUrl,
  voiceLabStatusLabel,
  type VoiceLabStatus,
  type VoiceLabVoice,
} from "@/lib/voice-lab-api";
import { CloneVoiceDialog } from "@/components/voices/clone-voice-dialog";
import { useTranslation } from "@/lib/i18n";

export type RuVoice = {
  id: string;
  index: number;
  name: string;
  description: string;
  gender: "female" | "male";
  filename: string;
  sample_url: string;
};

const ALL_VOICES: RuVoice[] = RU_VOICES_DATA as RuVoice[];

export function getVoiceById(voiceId: string): RuVoice | undefined {
  if (!voiceId) return undefined;
  return ALL_VOICES.find((v) => v.id === voiceId.trim());
}

/**
 * Кэш загруженных клонов на уровне модуля: модалку и ноду «Озвучка» открывают
 * порознь, а чипу «Голос» в Create нужно имя клона без повторного запроса.
 */
let CLONE_VOICE_CACHE: VoiceLabVoice[] = [];

/** Запомнить список клонов для `resolveVoiceName` (зовётся после загрузки списка). */
export function rememberCloneVoices(voices: VoiceLabVoice[]): void {
  CLONE_VOICE_CACHE = voices;
}

/** Имя голоса по id: клон → RU-каталог → стандартные ElevenLabs; null — не нашли. */
export function resolveVoiceName(voiceId: string): string | null {
  const clean = voiceId?.trim();
  if (!clean) return null;
  // Клон ищем и по локальному id записи, и по voice_id провайдера: в проекты
  // пишется второе (его понимает ElevenLabs), а карточки живут на первом.
  const clone = CLONE_VOICE_CACHE.find(
    (v) => v.id === clean || v.external_voice_id === clean,
  );
  if (clone) return clone.name;
  const ru = getVoiceById(clean);
  if (ru) return ru.name;
  const standard = STANDARD_ELEVENLABS_VOICES.find((v) => v.id === clean);
  return standard ? standard.name : null;
}

/** Источник голоса в модалке: клон студии, русский каталог или стандартный ElevenLabs. */
type VoiceSource = "clones" | "catalog" | "standard";

/** Унифицированная карточка: у каталога и стандартных пола/номера больше, у клона — статус. */
type VoiceEntry = {
  key: string;
  id: string;
  name: string;
  description: string;
  gender?: "female" | "male";
  index?: number;
  sampleUrl: string;
  source: VoiceSource;
  clone?: VoiceLabVoice;
};

const CLONE_STATUS_TONE: Record<string, string> = {
  ready: "bg-emerald-500/20 text-emerald-300",
  pending_provider: "bg-amber-500/20 text-amber-300",
  error: "bg-rose-500/20 text-rose-300",
  failed: "bg-rose-500/20 text-rose-300",
  training: "bg-blue-500/20 text-blue-300",
};

function cloneStatusTone(status: VoiceLabStatus): string {
  return CLONE_STATUS_TONE[status] ?? "bg-white/10 text-white/50";
}

/** «создан 12 ноя» / «вчера»: дата из реестра приходит с часовым поясом. */
function cloneCreatedLabel(iso: string | null): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const days = Math.floor((Date.now() - time) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 30) return `${days} дн назад`;
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Подпись карточки клона, когда у него нет описания. */
function cloneSubtitle(clone: VoiceLabVoice): string {
  const created = cloneCreatedLabel(clone.created_at);
  return ["Клон голоса", clone.language || "ru", created].filter(Boolean).join(" · ");
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedVoiceId: string;
  onSelectVoice: (voiceId: string, voiceName: string) => void;
};

export function VoiceLibraryModal({
  open,
  onOpenChange,
  selectedVoiceId,
  onSelectVoice,
}: Props) {
  const [search, setSearch] = useState("");
  const [genderFilter, setGenderFilter] = useState<"all" | "female" | "male">("all");
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [source, setSource] = useState<VoiceSource>("clones");

  // Реестр клонов: ручки owner-only, участнику отдают 404 — тогда таба и кнопки нет.
  const [clones, setClones] = useState<VoiceLabVoice[]>([]);
  const [clonesLoading, setClonesLoading] = useState(false);
  // Первую попытку загрузки сделали — можно решать, куда открывать модалку.
  const [clonesLoaded, setClonesLoaded] = useState(false);
  const [clonesAvailable, setClonesAvailable] = useState(false);
  const [cloneLimits, setCloneLimits] = useState<{ used: number; limit: number } | null>(null);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);

  // Действия над клоном: меню «…», переименование на месте, занятость строки.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Длина списка для отката «недоступно»: не тянем её в зависимости loadClones,
  // иначе загрузка перезапускалась бы после каждого изменения списка.
  const clonesRef = useRef<VoiceLabVoice[]>([]);

  useEffect(() => {
    clonesRef.current = clones;
  }, [clones]);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    setPlayingVoiceId(null);
  }, []);

  const loadClones = useCallback(async () => {
    setClonesLoading(true);
    try {
      const data = await listVoiceLabVoices();
      setClones(data.voices);
      rememberCloneVoices(data.voices);
      setClonesAvailable(true);
      setCloneLimits({ used: data.daily_used, limit: data.daily_limit });
    } catch (err) {
      if (isVoiceLabUnavailable(err)) {
        // Участник студии или ручки ещё нет: клонирование просто не показываем.
        setClones([]);
        setClonesAvailable(false);
      } else {
        console.warn("Не удалось загрузить клоны голосов:", err);
        if (clonesRef.current.length === 0) setClonesAvailable(false);
      }
    } finally {
      setClonesLoaded(true);
      setClonesLoading(false);
    }
  }, []);

  // Закрытие и размонтирование обязаны глушить звук: образец не должен играть «в фоне».
  useEffect(() => {
    if (!open) {
      stopAudio();
      return;
    }
    setActionError("");
    setMenuId(null);
    setRenamingId(null);
    void loadClones();
  }, [open, loadClones, stopAudio]);

  useEffect(() => () => stopAudio(), [stopAudio]);

  // Переключение источника тоже останавливает образец.
  useEffect(() => {
    stopAudio();
  }, [source, stopAudio]);

  // Клик мимо меню «…» закрывает его.
  useEffect(() => {
    if (!menuId) return;
    const closeMenu = () => setMenuId(null);
    window.addEventListener("mousedown", closeMenu);
    return () => window.removeEventListener("mousedown", closeMenu);
  }, [menuId]);

  // Если клоны недоступны — молча возвращаемся в каталог.
  useEffect(() => {
    if (clonesLoaded && !clonesAvailable && source === "clones") {
      setSource("catalog");
    }
  }, [clonesLoaded, clonesAvailable, source]);

  // Handle ESC key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (renamingId) {
          setRenamingId(null);
          return;
        }
        // Мастер клонирования — отдельное окно: ESC закрывает его, а не модалку.
        if (cloneDialogOpen) return;
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange, renamingId, cloneDialogOpen]);

  const togglePlay = (entry: VoiceEntry, e: React.MouseEvent) => {
    e.stopPropagation();

    if (playingVoiceId === entry.key) {
      stopAudio();
      return;
    }
    stopAudio();

    const audio = new Audio(entry.sampleUrl);
    audioRef.current = audio;
    setPlayingVoiceId(entry.key);

    audio.play().catch((err) => {
      console.warn("Failed to play voice sample:", err);
      setPlayingVoiceId(null);
      audioRef.current = null;
    });

    audio.onended = () => {
      setPlayingVoiceId(null);
      audioRef.current = null;
    };

    audio.onerror = () => {
      setPlayingVoiceId(null);
      audioRef.current = null;
    };
  };

  const catalogEntries = useMemo<VoiceEntry[]>(
    () =>
      ALL_VOICES.map((v) => ({
        key: `catalog:${v.id}`,
        id: v.id,
        name: v.name,
        description: v.description,
        gender: v.gender,
        index: v.index,
        sampleUrl: v.sample_url || `/api/voices/${v.id}/sample`,
        source: "catalog" as const,
      })),
    [],
  );

  const standardEntries = useMemo<VoiceEntry[]>(
    () =>
      STANDARD_ELEVENLABS_VOICES.map((v) => ({
        key: `standard:${v.id}`,
        id: v.id,
        name: v.name,
        description: v.description,
        gender: v.gender,
        sampleUrl: v.sample_url || `/api/voices/${v.id}/sample`,
        source: "standard" as const,
      })),
    [],
  );

  const cloneEntries = useMemo<VoiceEntry[]>(
    () =>
      clones.map((c) => ({
        key: `clone:${c.id}`,
        id: c.id,
        name: c.name,
        description: c.description,
        sampleUrl: c.sample_url || voiceLabSampleUrl(c.id),
        source: "clones" as const,
        clone: c,
      })),
    [clones],
  );

  const tabEntries =
    source === "clones" ? cloneEntries : source === "standard" ? standardEntries : catalogEntries;

  const filteredVoices = useMemo(() => {
    let list = tabEntries;
    // У клонов пола нет: под фильтром «Ж»/«М» они остаются — иначе пропадут из поиска.
    if (genderFilter !== "all") {
      list = list.filter((v) => !v.gender || v.gender === genderFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (v) =>
          v.name.toLowerCase().includes(q) ||
          v.description.toLowerCase().includes(q) ||
          v.id.toLowerCase().includes(q) ||
          (v.index != null && String(v.index).includes(q)) ||
          (v.clone ? (v.clone.language || "").toLowerCase().includes(q) : false),
      );
    }
    return list;
  }, [tabEntries, genderFilter, search]);

  const femaleCount = useMemo(
    () => tabEntries.filter((v) => v.gender === "female").length,
    [tabEntries],
  );
  const maleCount = useMemo(
    () => tabEntries.filter((v) => v.gender === "male").length,
    [tabEntries],
  );

  const canUseClones = clonesAvailable || clones.length > 0;
  // Пока идёт первая загрузка, таб уже на месте — иначе он «прыгает» после ответа.
  const showClonesTab = canUseClones || clonesLoading;

  const startRename = (clone: VoiceLabVoice) => {
    setMenuId(null);
    setRenamingId(clone.id);
    setRenameDraft(clone.name);
    setActionError("");
  };

  const saveRename = async (clone: VoiceLabVoice) => {
    const next = renameDraft.trim();
    if (!next) {
      setActionError("Название голоса не может быть пустым.");
      return;
    }
    setBusyId(clone.id);
    setActionError("");
    try {
      await updateVoiceClone(clone.id, {
        name: next,
        description: clone.description || "",
      });
      setRenamingId(null);
      await loadClones();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Не удалось переименовать голос");
    } finally {
      setBusyId(null);
    }
  };

  const removeClone = async (clone: VoiceLabVoice) => {
    setMenuId(null);
    const confirmed = window.confirm(
      `Удалить голос «${clone.name}»? Сэмплы и сам голос удалятся из студии и ElevenLabs.`,
    );
    if (!confirmed) return;
    setBusyId(clone.id);
    setActionError("");
    try {
      await deleteVoiceClone(clone.id);
      await loadClones();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Не удалось удалить голос");
    } finally {
      setBusyId(null);
    }
  };

  const selectEntry = (entry: VoiceEntry) => {
    if (entry.clone && !isVoiceCloneReady(entry.clone)) {
      setActionError(
        `Голос «${entry.clone.name}» пока не создан в ElevenLabs (${voiceLabStatusLabel(
          entry.clone.status,
        )}) — выбрать его для озвучки нельзя.`,
      );
      return;
    }
    // В проект уходит voice_id провайдера: локальный uuid записи ElevenLabs не
    // знает, и генерация упала бы на «голос не найден». Клон без провайдера
    // отсекается выше, поэтому здесь external есть всегда.
    const providerId = entry.clone?.external_voice_id?.trim();
    onSelectVoice(providerId || entry.id, entry.name);
    onOpenChange(false);
  };

  const handleCloneCreated = () => {
    setSource("clones");
    void loadClones();
  };

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { t } = useTranslation();

  if (!open || !mounted) return null;

  const sourceTabs: Array<{ value: VoiceSource; label: string; count: number }> = [
    { value: "clones", label: t("voices.tabs.clones"), count: clones.length },
    { value: "catalog", label: t("voices.tabs.catalog"), count: ALL_VOICES.length },
  ];

  const visibleSourceTabs = showClonesTab
    ? sourceTabs
    : sourceTabs.filter((t) => t.value !== "clones");

  const countSuffix = (n: number) => (n > 0 ? ` (${n})` : "");

  // Первый заход в таб клонов: пока список не пришёл, показываем загрузку, а не «пусто».
  const clonesFirstLoad = source === "clones" && !clonesLoaded;
  const showCloneEmpty =
    source === "clones" && clonesLoaded && !clonesLoading && cloneEntries.length === 0;
  const showGrid = !showCloneEmpty && filteredVoices.length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4 sm:p-6 backdrop-blur-md animate-in fade-in duration-200"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="relative flex h-[85vh] max-h-[820px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f1015] text-white shadow-2xl shadow-black/90"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#22d3ee]/10 text-[#22d3ee] ring-1 ring-[#22d3ee]/25">
              <Mic className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-lg font-semibold tracking-wide text-white">
                  {t("voices.title")}
                </h2>
                <span className="shrink-0 rounded-full bg-[#22d3ee]/20 px-2 py-0.5 text-[11px] font-medium text-[#22d3ee]">
                  v4
                </span>
              </div>
              <p className="truncate text-[12px] text-white/50">
                {t("voices.subtitle")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {canUseClones ? (
              <button
                type="button"
                onClick={() => setCloneDialogOpen(true)}
                className="flex h-9 items-center gap-1.5 rounded-xl bg-[#22d3ee] px-3 text-[12px] font-semibold text-black transition hover:bg-[#67e8f9]"
              >
                <Plus className="h-4 w-4" />
                {t("voices.buttons.cloneVoice")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filter bar: Search + Gender Tabs + Source Tabs */}
        <div className="flex shrink-0 flex-col gap-3 border-b border-white/10 bg-white/[0.02] px-6 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("voices.search.placeholder")}
                className="w-full rounded-xl border border-white/10 bg-[#161720] py-2 pl-9 pr-3 text-[13px] text-white placeholder-white/35 outline-none transition focus:border-[#22d3ee]/50 focus:ring-1 focus:ring-[#22d3ee]/30"
                autoFocus
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/40 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Gender Filter Buttons */}
            <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-[#161720] p-1">
              <button
                type="button"
                onClick={() => setGenderFilter("all")}
                className={`rounded-lg px-3 py-1 text-[12px] font-medium transition ${
                  genderFilter === "all"
                    ? "bg-[#22d3ee]/20 text-[#22d3ee]"
                    : "text-white/60 hover:text-white"
                }`}
              >
                {t("voices.tabs.all")} ({tabEntries.length})
              </button>
              <button
                type="button"
                onClick={() => setGenderFilter("female")}
                className={`rounded-lg px-3 py-1 text-[12px] font-medium transition ${
                  genderFilter === "female"
                    ? "bg-rose-500/25 text-rose-300"
                    : "text-white/60 hover:text-white"
                }`}
              >
                {t("voices.badges.female")}{countSuffix(femaleCount)}
              </button>
              <button
                type="button"
                onClick={() => setGenderFilter("male")}
                className={`rounded-lg px-3 py-1 text-[12px] font-medium transition ${
                  genderFilter === "male"
                    ? "bg-blue-500/25 text-blue-300"
                    : "text-white/60 hover:text-white"
                }`}
              >
                {t("voices.badges.male")}{countSuffix(maleCount)}
              </button>
            </div>
          </div>

          {/* Source Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto">
            {visibleSourceTabs.map((tab) => {
              const active = source === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setSource(tab.value)}
                  className={`shrink-0 rounded-lg px-3 py-1 text-[12px] font-medium transition ${
                    active
                      ? "bg-[#22d3ee]/15 text-[#22d3ee] ring-1 ring-inset ring-[#22d3ee]/30"
                      : "text-white/50 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {tab.label} ({tab.count})
                </button>
              );
            })}
          </div>
        </div>

        {/* Voices Grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {actionError ? (
            <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-200">
              {actionError}
            </div>
          ) : null}

          {source === "clones" && (clonesLoading || clonesFirstLoad) && cloneEntries.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-[#22d3ee]" />
              <p className="text-[13px] text-white/50">Загружаем клоны…</p>
            </div>
          ) : showCloneEmpty ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
              <Volume2 className="h-10 w-10 text-white/20" />
              <p className="text-[14px] text-white/60">
                {t("voices.search.noClones")}
              </p>
              <p className="max-w-md text-[12px] text-white/35">
                {t("voices.search.noClonesHint")}
              </p>
              {canUseClones ? (
                <button
                  type="button"
                  onClick={() => setCloneDialogOpen(true)}
                  className="mt-2 flex h-9 items-center gap-1.5 rounded-xl bg-[#22d3ee] px-3 text-[12px] font-semibold text-black transition hover:bg-[#67e8f9]"
                >
                  <Plus className="h-4 w-4" />
                  {t("voices.buttons.cloneVoice")}
                </button>
              ) : null}
            </div>
          ) : !showGrid ? (
            <div className="flex h-64 flex-col items-center justify-center text-center">
              <Volume2 className="h-10 w-10 text-white/20 mb-2" />
              <p className="text-[14px] text-white/60">{t("voices.search.noResults")}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-2">
              {filteredVoices.map((entry) => {
                const isSelected = selectedVoiceId === entry.id;
                const isPlaying = playingVoiceId === entry.key;
                const isFemale = entry.gender === "female";
                const clone = entry.clone;
                const renaming = clone != null && renamingId === clone.id;
                const busy = clone != null && busyId === clone.id;
                const ready = clone == null || isVoiceCloneReady(clone);

                return (
                  <div
                    key={entry.key}
                    onClick={() => {
                      if (renaming) return;
                      selectEntry(entry);
                    }}
                    title={
                      clone && !ready
                        ? t("voices.errors.voiceNotReady", {
                            name: clone.name,
                            status: voiceLabStatusLabel(clone.status),
                          })
                        : undefined
                    }
                    className={`group relative flex items-center justify-between rounded-xl border p-3 transition duration-150 ${
                      renaming ? "cursor-default" : "cursor-pointer"
                    } ${
                      isSelected
                        ? "border-[#22d3ee] bg-[#22d3ee]/10 shadow-md shadow-[#22d3ee]/10"
                        : "border-white/[0.08] bg-[#14151c]/90 hover:border-white/20 hover:bg-[#1a1b24]"
                    } ${clone && !ready ? "opacity-90" : ""}`}
                  >
                    {/* Left: Play button + Info */}
                    <div className="flex min-w-0 items-center gap-3 overflow-hidden">
                      {/* Play/Pause Button */}
                      <button
                        type="button"
                        onClick={(e) => togglePlay(entry, e)}
                        title={isPlaying ? t("voices.buttons.pause") : t("voices.buttons.playSample")}
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                          isPlaying
                            ? "bg-[#22d3ee] text-black shadow-lg shadow-[#22d3ee]/30 animate-pulse"
                            : clone
                              ? "bg-[#22d3ee]/15 text-[#22d3ee] group-hover:bg-[#22d3ee]/25"
                              : isFemale
                                ? "bg-rose-500/15 text-rose-300 group-hover:bg-rose-500/25"
                                : "bg-blue-500/15 text-blue-300 group-hover:bg-blue-500/25"
                        }`}
                      >
                        {isPlaying ? (
                          <Pause className="h-4 w-4 fill-current" />
                        ) : (
                          <Play className="h-4 w-4 fill-current ml-0.5" />
                        )}
                      </button>

                      {/* Info */}
                      <div className="min-w-0 flex-1">
                        {renaming && clone ? (
                          <div
                            className="flex min-w-0 flex-col gap-1.5"
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <input
                              type="text"
                              value={renameDraft}
                              autoFocus
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveRename(clone);
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                              className="w-full rounded-lg border border-[#22d3ee]/40 bg-[#0f1015] px-2 py-1 text-[12px] text-white outline-none focus:border-[#22d3ee]"
                            />
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void saveRename(clone)}
                                disabled={busy}
                                className="rounded-md bg-[#22d3ee] px-2 py-0.5 text-[11px] font-semibold text-black disabled:opacity-50"
                              >
                                {t("common.save")}
                              </button>
                              <button
                                type="button"
                                onClick={() => setRenamingId(null)}
                                className="rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-white/60 hover:text-white"
                              >
                                {t("common.cancel")}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[13px] font-semibold text-white">
                                {entry.name}
                              </span>
                              {clone ? (
                                <span className="shrink-0 rounded bg-[#22d3ee]/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-[#22d3ee]">
                                  {t("voices.badges.clone")}
                                </span>
                              ) : null}
                              {clone ? (
                                <span
                                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${cloneStatusTone(
                                    clone.status,
                                  )}`}
                                >
                                  {t("voices.statuses." + clone.status) || voiceLabStatusLabel(clone.status)}
                                </span>
                              ) : null}
                              {!clone && entry.gender ? (
                                <span
                                  className={`rounded px-1.5 py-0.2 text-[10px] font-medium uppercase ${
                                    isFemale
                                      ? "bg-rose-500/20 text-rose-300"
                                      : "bg-blue-500/20 text-blue-300"
                                  }`}
                                >
                                  {isFemale ? "Ж" : "М"}
                                </span>
                              ) : null}
                              {!clone && entry.index != null ? (
                                <span className="font-mono text-[10px] text-white/30">
                                  #{entry.index}
                                </span>
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] text-white/55">
                              {entry.description ||
                                (clone ? cloneSubtitle(clone) : "Натуральный чистый голос")}
                            </p>
                            {clone && menuId === clone.id ? (
                              <div
                                className="mt-1.5 flex flex-wrap items-center gap-1.5"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => startRename(clone)}
                                  className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70 transition hover:bg-white/10 hover:text-white"
                                >
                                  <Pencil className="h-3 w-3" />
                                  {t("voices.buttons.rename")}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void removeClone(clone)}
                                  className="flex items-center gap-1 rounded-md border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-300 transition hover:bg-rose-500/20"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  {t("voices.buttons.delete")}
                                </button>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right: menu (clone) + select indicator */}
                    <div className="ml-2 flex shrink-0 items-center gap-1">
                      {clone ? (
                        <div
                          className="relative"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            title="Действия с голосом"
                            onClick={() => setMenuId(menuId === clone.id ? null : clone.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white"
                          >
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MoreHorizontal className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      ) : null}

                      {isSelected ? (
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#22d3ee] text-black shadow-sm">
                          <Check className="h-4 w-4 stroke-[2.5]" />
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] font-medium text-white/50 opacity-0 transition group-hover:opacity-100 hover:border-white/30 hover:text-white"
                        >
                          {t("voices.buttons.selectVoice")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-[#0d0e13] px-6 py-3 text-[12px] text-white/45">
          <span className="truncate">
            {source === "clones"
              ? `Показано: ${filteredVoices.length} из ${clones.length} клонов`
              : source === "standard"
                ? `Показано: ${filteredVoices.length} из ${STANDARD_ELEVENLABS_VOICES.length} голосов`
                : `Показано: ${filteredVoices.length} из ${ALL_VOICES.length} голосов`}
            {source === "clones" && cloneLimits
              ? ` · лимит клонов: ${cloneLimits.used} из ${cloneLimits.limit} сегодня`
              : ""}
            {source === "clones" && genderFilter !== "all" ? " · пол у клонов не задан" : ""}
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-4 py-1.5 text-[12px] font-medium text-white transition hover:bg-white/10"
          >
            Закрыть
          </button>
        </div>

        <CloneVoiceDialog
          open={cloneDialogOpen}
          onOpenChange={setCloneDialogOpen}
          onCreated={handleCloneCreated}
          dailyUsed={cloneLimits?.used}
          dailyLimit={cloneLimits?.limit}
        />
      </div>
    </div>,
    document.body,
  );
}
