"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Mic, Pause, Play, Plus, Search, X } from "lucide-react";
import {
  RU_VOICES,
  STANDARD_ELEVENLABS_VOICES,
  type ElevenLabsVoice,
} from "@/lib/elevenlabs-voices";
import {
  isVoiceCloneReady,
  isVoiceLabUnavailable,
  listVoiceLabVoices,
  voiceLabSampleUrl,
  voiceLabStatusLabel,
  type VoiceLabStatus,
  type VoiceLabVoice,
} from "@/lib/voice-lab-api";
import { rememberCloneVoices, resolveVoiceName } from "@/components/outsee/voice-library-modal";
import { useTranslation } from "@/lib/i18n";

type VoiceSource = "clone" | "catalog" | "standard";

type VoiceTab = "all" | "clones" | "catalog" | "standard" | "history";

type LanguageFilter = "all" | "ru" | "en";

type SortMode = "name" | "female" | "male" | "index" | "newest";

type VoiceOption = {
  key: string;
  /** Что уходит в onChange: у клона — external_voice_id, если он уже есть. */
  id: string;
  name: string;
  description: string;
  gender?: "female" | "male";
  index?: number;
  /** Язык для фильтра: ru, en или код из реестра клонов. */
  language: string;
  source: VoiceSource;
  /** null — образца нет (стандартные голоса ElevenLabs). */
  sampleUrl: string | null;
  statusLabel?: string;
  statusTone?: string;
  disabled?: boolean;
  createdAt?: string | null;
};

type HistoryEntry = { id: string; name: string; ts: number };

const HISTORY_KEY = "via:voice-history";
const HISTORY_LIMIT = 10;

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

/** Инициалы для аватара: «Анна-реклама» → «АР», «Adam» → «AD». */
function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0] ?? "";
  if (words.length === 1) return first.slice(0, 2).toUpperCase();
  const second = words[1] ?? "";
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function avatarTone(option: VoiceOption): string {
  if (option.source === "clone") {
    return "bg-[#2dd4bf]/15 text-[#2dd4bf] ring-1 ring-inset ring-[#2dd4bf]/25";
  }
  if (option.gender === "female") return "bg-rose-500/15 text-rose-300";
  if (option.gender === "male") return "bg-blue-500/15 text-blue-300";
  return "bg-white/[0.06] text-white/60";
}

function genderRank(option: VoiceOption, sort: SortMode): number {
  if (sort === "female") {
    if (option.gender === "female") return 0;
    if (option.gender === "male") return 1;
    return 2;
  }
  if (option.gender === "male") return 0;
  if (option.gender === "female") return 1;
  return 2;
}

function sortOptions(list: VoiceOption[], sort: SortMode): VoiceOption[] {
  const byName = (a: VoiceOption, b: VoiceOption) => a.name.localeCompare(b.name, "ru");
  const copy = [...list];
  switch (sort) {
    case "female":
    case "male":
      copy.sort((a, b) => genderRank(a, sort) - genderRank(b, sort) || byName(a, b));
      break;
    case "index":
      copy.sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER) || byName(a, b));
      break;
    case "newest":
      copy.sort((a, b) => {
        const at = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
        const bt = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
        const aTime = Number.isFinite(at) ? at : 0;
        const bTime = Number.isFinite(bt) ? bt : 0;
        return bTime - aTime || byName(a, b);
      });
      break;
    default:
      copy.sort(byName);
  }
  return copy;
}

/** «5 мин назад», «вчера» — для строк истории. */
function historyWhen(ts: number): string {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff) || diff < 60_000) return "только что";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 30) return `${days} дн назад`;
  return new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function readHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list: HistoryEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.name !== "string") continue;
      if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) continue;
      list.push({ id: record.id, name: record.name, ts: record.ts });
    }
    return list.slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeHistory(list: HistoryEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* приватный режим или переполнение — история просто не сохранится */
  }
}

function catalogOption(voice: ElevenLabsVoice): VoiceOption {
  return {
    key: `catalog:${voice.id}`,
    id: voice.id,
    name: voice.name,
    description: voice.description,
    gender: voice.gender,
    index: voice.index,
    language: "ru",
    source: "catalog",
    sampleUrl: voice.sample_url || `/api/voices/${voice.id}/sample`,
  };
}

function standardOption(voice: ElevenLabsVoice): VoiceOption {
  return {
    key: `standard:${voice.id}`,
    id: voice.id,
    name: voice.name,
    description: voice.description,
    gender: voice.gender,
    index: voice.index,
    language: "en",
    source: "standard",
    // У стандартных ElevenLabs образцов в студии нет.
    sampleUrl: voice.sample_url || null,
  };
}

type Props = {
  value: string;
  onChange: (voiceId: string, name: string) => void;
  onClone?: () => void;
  disabled?: boolean;
};

type PanelPos = { top: number; left: number; width: number; height: number };

/**
 * Строка «Голос» для окна «Параметры» + выезжающая панель выбора у ПРАВОГО
 * КРАЯ окна (как мастер клонирования), а не плавающий список у «Параметров».
 *
 * Панель живёт порталом в body, помечена `data-params-flyout="true"` — по ней
 * окно «Параметры» понимает, что клик внутри не должен его закрывать.
 */
export function VoicePickerRow({ value, onChange, onClone, disabled }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<VoiceTab>("all");
  const [search, setSearch] = useState("");
  const [language, setLanguage] = useState<LanguageFilter>("all");
  const [sort, setSort] = useState<SortMode>("name");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [pos, setPos] = useState<PanelPos | null>(null);

  const [clones, setClones] = useState<VoiceLabVoice[]>([]);
  const [clonesLoading, setClonesLoading] = useState(false);
  const [clonesLoaded, setClonesLoaded] = useState(false);
  const [clonesAvailable, setClonesAvailable] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audioRef.current = null;
    }
    setPlayingKey(null);
  }, []);

  const loadClones = useCallback(async () => {
    setClonesLoading(true);
    try {
      const data = await listVoiceLabVoices();
      setClones(data.voices);
      rememberCloneVoices(data.voices);
      setClonesAvailable(true);
    } catch (err) {
      // 404/401/403 — ручек нет (участник): тихо прячем клоны, остальное работает.
      if (!isVoiceLabUnavailable(err)) {
        console.warn("Не удалось загрузить клоны голосов:", err);
      }
      setClones([]);
      setClonesAvailable(false);
    } finally {
      setClonesLoading(false);
      setClonesLoaded(true);
    }
  }, []);

  const pushHistory = useCallback((id: string, name: string) => {
    setHistory((prev) => {
      const next = [{ id, name, ts: Date.now() }, ...prev.filter((entry) => entry.id !== id)].slice(
        0,
        HISTORY_LIMIT,
      );
      writeHistory(next);
      return next;
    });
  }, []);

  // История и клоны — только на клиенте.
  useEffect(() => {
    setHistory(readHistory());
  }, []);

  useEffect(() => {
    void loadClones();
  }, [loadClones]);

  useEffect(() => {
    if (!open) return;
    void loadClones();
  }, [open, loadClones]);

  // Закрытие: клик вне строки и вне панели, Escape, прокрутка/ресайз окна.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Звук не должен играть после закрытия панели или размонтирования строки.
  useEffect(() => {
    if (!open) stopPlayback();
  }, [open, stopPlayback]);

  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const toggle = () => {
    if (!open) {
      setSearch("");
      // Низ меню — ровно по низу «Параметров», высота в 1.5 раза больше их,
      // значит верх поднимается выше верха параметров.
      const panel = rowRef.current?.closest("[data-params-panel]");
      const rect = (panel instanceof HTMLElement ? panel : rowRef.current)?.getBoundingClientRect();
      if (rect) {
        const gap = 8;
        const width = 470;
        const height = Math.max(360, Math.min(rect.height * 1.5, rect.bottom - 8));
        const top = Math.max(8, rect.bottom - height);
        const left = Math.max(8, Math.min(rect.right + gap, window.innerWidth - width - 12));
        setPos({ top, left, width, height });
      }
    }
    setOpen((prev) => !prev);
  };

  const catalogOptions = useMemo<VoiceOption[]>(() => RU_VOICES.map(catalogOption), []);
  const standardOptions = useMemo<VoiceOption[]>(() => STANDARD_ELEVENLABS_VOICES.map(standardOption), []);

  const cloneOptions = useMemo<VoiceOption[]>(
    () =>
      clones.map((clone) => {
        const ready = isVoiceCloneReady(clone);
        return {
          key: `clone:${clone.id}`,
          id: clone.external_voice_id || clone.id,
          name: clone.name,
          description: clone.description || `Клон голоса · ${clone.language || "ru"}`,
          language: (clone.language || "ru").toLowerCase(),
          source: "clone" as const,
          sampleUrl: clone.sample_url || voiceLabSampleUrl(clone.id),
          statusLabel: ready ? undefined : voiceLabStatusLabel(clone.status),
          statusTone: ready ? undefined : cloneStatusTone(clone.status),
          disabled: !ready,
          createdAt: clone.created_at,
        };
      }),
    [clones],
  );

  const showClonesTab = clonesAvailable || clonesLoading || !clonesLoaded;
  const activeTab: VoiceTab = tab === "clones" && !showClonesTab ? "all" : tab;

  const tabOptions = useMemo<VoiceOption[]>(() => {
    switch (activeTab) {
      case "clones":
        return cloneOptions;
      case "catalog":
        return catalogOptions;
      case "standard":
        return standardOptions;
      case "history":
        return [];
      default:
        return showClonesTab
          ? [...cloneOptions, ...catalogOptions, ...standardOptions]
          : [...catalogOptions, ...standardOptions];
    }
  }, [activeTab, cloneOptions, catalogOptions, standardOptions, showClonesTab]);

  const filtered = useMemo(() => {
    let list = tabOptions;
    if (language !== "all") {
      list = list.filter((option) => option.language === language);
    }
    const query = search.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (option) =>
          option.name.toLowerCase().includes(query) ||
          option.description.toLowerCase().includes(query) ||
          option.id.toLowerCase().includes(query),
      );
    }
    return sortOptions(list, sort);
  }, [tabOptions, language, search, sort]);

  const historyFiltered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return history;
    return history.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) || entry.id.toLowerCase().includes(query),
    );
  }, [history, search]);

  const tabs: Array<{ value: VoiceTab; label: string; count: number; visible: boolean }> = [
    {
      value: "all",
      label: t("voices.tabs.all"),
      count: showClonesTab
        ? cloneOptions.length + catalogOptions.length + standardOptions.length
        : catalogOptions.length + standardOptions.length,
      visible: true,
    },
    { value: "clones", label: t("voices.tabs.clones"), count: cloneOptions.length, visible: showClonesTab },
    { value: "catalog", label: t("voices.tabs.catalog"), count: catalogOptions.length, visible: true },
    { value: "standard", label: t("voices.tabs.standard"), count: standardOptions.length, visible: true },
    { value: "history", label: t("voices.tabs.history"), count: history.length, visible: true },
  ];

  // В проект уходит external_voice_id, а кэш resolveVoiceName ключуется по
  // внутреннему id — поэтому сначала смотрим клона по id в ElevenLabs.
  const currentName = useMemo(() => {
    const clean = value.trim();
    if (!clean) return t("voices.picker.selectVoice");
    const byExternal = clones.find((clone) => clone.external_voice_id && clone.external_voice_id === clean);
    if (byExternal) return byExternal.name;
    return resolveVoiceName(clean) || clean;
  }, [value, clones, t]);

  const selectOption = (option: VoiceOption) => {
    if (option.disabled) return;
    pushHistory(option.id, option.name);
    onChange(option.id, option.name);
    setOpen(false);
  };

  const selectHistoryEntry = (entry: HistoryEntry) => {
    pushHistory(entry.id, entry.name);
    onChange(entry.id, entry.name);
    setOpen(false);
  };

  const togglePlay = (option: VoiceOption, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!option.sampleUrl) return;
    if (playingKey === option.key) {
      stopPlayback();
      return;
    }
    stopPlayback();
    const audio = new Audio(option.sampleUrl);
    audioRef.current = audio;
    setPlayingKey(option.key);
    audio.play().catch((err: unknown) => {
      console.warn("Не удалось прослушать образец голоса:", err);
      setPlayingKey(null);
      audioRef.current = null;
    });
    audio.onended = () => {
      setPlayingKey(null);
      audioRef.current = null;
    };
    audio.onerror = () => {
      setPlayingKey(null);
      audioRef.current = null;
    };
  };

  const shownCount = activeTab === "history" ? historyFiltered.length : filtered.length;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={rowRef}
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-[12px] text-white/80 transition hover:border-white/15 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Mic className="h-3.5 w-3.5 shrink-0 text-[#2dd4bf]" />
          <span className="shrink-0 text-white/55">{t("voices.picker.voice")}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate">{currentName}</span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-white/40 transition ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              data-params-flyout="true"
              role="dialog"
              aria-label={t("voices.picker.title")}
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                width: pos.width,
                height: pos.height,
              }}
              className="z-[1200] flex flex-col overflow-hidden rounded-xl border border-white/15 bg-[#121216]/[0.98] shadow-[0_18px_45px_rgba(0,0,0,0.85)] ring-1 ring-white/10 backdrop-blur-2xl"
            >
              {/* Шапка */}
              <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Mic className="h-4 w-4 text-[#2dd4bf]" />
                  <span className="text-[13px] font-semibold text-white">{t("voices.picker.title")}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title={t("common.close")}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-white/40 transition hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Поиск */}
              <div className="shrink-0 px-3 pt-2.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
                  <input
                    type="text"
                    value={search}
                    autoFocus
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("voices.picker.searchPlaceholder")}
                    className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] py-1.5 pl-8 pr-2 text-[12px] text-white placeholder-white/35 outline-none transition focus:border-[#2dd4bf]/50"
                  />
                </div>
              </div>

              {/* Фильтры */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-2">
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-white/35">{t("voices.picker.language")}</span>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as LanguageFilter)}
                    className="h-7 rounded-lg border border-white/[0.08] bg-[#161720] px-1.5 text-[11px] text-white outline-none transition focus:border-[#2dd4bf]/50"
                  >
                    <option value="all">{t("voices.picker.all")}</option>
                    <option value="ru">{t("voices.picker.russian")}</option>
                    <option value="en">{t("voices.picker.english")}</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-white/35">{t("voices.picker.sort")}</span>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortMode)}
                    className="h-7 rounded-lg border border-white/[0.08] bg-[#161720] px-1.5 text-[11px] text-white outline-none transition focus:border-[#2dd4bf]/50"
                  >
                    <option value="name">{t("voices.picker.byName")}</option>
                    <option value="female">{t("voices.picker.femaleFirst")}</option>
                    <option value="male">{t("voices.picker.maleFirst")}</option>
                    <option value="index">{t("voices.picker.byNumber")}</option>
                    <option value="newest">{t("voices.picker.newestFirst")}</option>
                  </select>
                </label>
              </div>

              {/* Табы */}
              <div className="mt-2 flex shrink-0 items-center gap-0.5 overflow-x-auto px-3">
                {tabs
                  .filter((item) => item.visible)
                  .map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setTab(item.value)}
                      className={`shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-[10.5px] font-medium transition ${
                        activeTab === item.value
                          ? "bg-[#2dd4bf]/15 text-[#2dd4bf] ring-1 ring-inset ring-[#2dd4bf]/30"
                          : "text-white/50 hover:bg-white/[0.06] hover:text-white"
                      }`}
                    >
                      {item.label} ({item.count})
                    </button>
                  ))}
              </div>

              {/* Список */}
              <div className="mt-1.5 flex-1 overflow-y-auto px-2 pb-2" role="listbox">
                {activeTab === "history" ? (
                  historyFiltered.length === 0 ? (
                    <p className="px-2 py-8 text-center text-[11px] text-white/40">
                      {t("voices.picker.emptyHistory")}
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between px-1 pb-1">
                        <span className="text-[10px] uppercase tracking-wide text-white/30">
                          {t("voices.tabs.history")}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setHistory([]);
                            writeHistory([]);
                          }}
                          className="rounded-md px-1.5 py-0.5 text-[10px] text-white/40 transition hover:bg-white/10 hover:text-white"
                        >
                          {t("voices.buttons.clearAll")}
                        </button>
                      </div>
                      {historyFiltered.map((entry) => (
                        <button
                          key={`${entry.id}:${entry.ts}`}
                          type="button"
                          onClick={() => selectHistoryEntry(entry)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.06]"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-[10px] font-semibold text-white/60">
                            {initialsOf(entry.name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] text-white/85">
                              {entry.name}
                            </span>
                            <span className="block truncate text-[10px] text-white/40">
                              {historyWhen(entry.ts)}
                            </span>
                          </span>
                        </button>
                      ))}
                    </>
                  )
                ) : activeTab === "clones" && clonesLoading && cloneOptions.length === 0 ? (
                  <p className="px-2 py-8 text-center text-[11px] text-white/40">{t("voices.buttons.creating")}</p>
                ) : filtered.length === 0 ? (
                  <p className="px-2 py-8 text-center text-[11px] text-white/40">{t("voices.search.noResults")}</p>
                ) : (
                  filtered.map((option) => {
                    const selected = value === option.id;
                    const playing = playingKey === option.key;
                    const hasSample = Boolean(option.sampleUrl);
                    return (
                      <div
                        key={option.key}
                        role="option"
                        aria-selected={selected}
                        onClick={() => selectOption(option)}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition ${
                          option.disabled
                            ? "cursor-not-allowed opacity-50"
                            : "cursor-pointer hover:bg-white/[0.06]"
                        } ${selected ? "bg-[#2dd4bf]/10 ring-1 ring-inset ring-[#2dd4bf]/30" : ""}`}
                      >
                        <span
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold ${avatarTone(
                            option,
                          )}`}
                        >
                          {initialsOf(option.name)}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[12px] text-white/85">{option.name}</span>
                            {option.source === "clone" ? (
                              <span className="shrink-0 rounded bg-[#2dd4bf]/20 px-1 py-0.5 text-[9px] font-medium text-[#2dd4bf]">
                                Клон
                              </span>
                            ) : null}
                            {option.statusLabel ? (
                              <span
                                className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium ${
                                  option.statusTone ?? "bg-white/10 text-white/50"
                                }`}
                              >
                                {option.statusLabel}
                              </span>
                            ) : null}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[10px] text-white/40">
                              {option.description}
                            </span>
                          </span>
                        </span>

                        <button
                          type="button"
                          onClick={(e) => togglePlay(option, e)}
                          disabled={!hasSample}
                          title={
                            hasSample
                              ? playing
                                ? t("voices.buttons.pause")
                                : t("voices.buttons.playSample")
                              : t("voices.search.noResults")
                          }
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          {playing ? (
                            <Pause className="h-3.5 w-3.5 fill-current" />
                          ) : (
                            <Play className="h-3.5 w-3.5 fill-current" />
                          )}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Футер */}
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 px-3 py-2">
                <span className="text-[11px] text-white/40">Найдено: {shownCount}</span>
                {onClone && clonesAvailable ? (
                  <button
                    type="button"
                    onClick={() => {
                      onClone();
                      setOpen(false);
                    }}
                    className="flex items-center gap-1 rounded-lg border border-[#2dd4bf]/30 bg-[#2dd4bf]/10 px-2 py-1 text-[11px] font-medium text-[#2dd4bf] transition hover:bg-[#2dd4bf]/20"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("voices.buttons.cloneVoice")}
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
