"use client";

/**
 * Outsee Create (глобально):
 * — настройки общие (data/outsee_create_settings.json), не project
 * — история общая по всем проектам
 * — typetoggle Фото / Видео / Аудио + feed Все/Фото/Видео/Аудио
 * — полный picker моделей как на outsee.io/create
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Clock,
  Coins,
  Copy,
  CornerDownLeft,
  Dices,
  Disc,
  Download,
  ExternalLink,
  FileText,
  History,
  ImageIcon,
  Layers,
  Link2,
  Loader2,
  Maximize2,
  Mic,
  Music,
  Paperclip,
  Pause,
  Play,
  Radio,
  Repeat,
  RotateCcw,
  RotateCw,
  Scissors,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  Video,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { usePipelineMode } from "@/hooks/use-pipeline-mode";
import { api } from "@/lib/api";
import type { KieField, KieModelSpec } from "@/lib/api";
import { errorMessageFromUnknown, humanizeErrorMessage } from "@/lib/error-message";
import { toThumbnailUrl } from "@/lib/thumbnail-url";
import { isUnfilledAssistantPrompt } from "@/lib/gen-assistant-styles";
import { cn, parseUtcDate } from "@/lib/utils";
import {
  OUTSEE_ACCENT,
  OUTSEE_CHIP_LABELS,
  OUTSEE_DETAIL_LEVELS,
  OUTSEE_FEED_TABS,
  OUTSEE_ORIGIN,
  OUTSEE_TYPE_TABS,
  chipOptions,
  clampToOptions,
  detailLabel,
  dockChipsForModel,
  getAudioModel,
  getImageModel,
  getVideoModel,
  outseeCreateUrl,
  pickerModelsForType,
  slugToStudioId,
  modelIconForId,
  type OutseeChip,
  type OutseeFeedKind,
  type OutseeMediaType,
} from "@/lib/outsee-catalog";
import { estimateCreatePrice } from "@/lib/create-pricing";
import { GenAssistantPanel } from "@/components/outsee/gen-assistant-panel";
import { inspirationPromptSuffix, inspirationStyle } from "@/lib/inspiration-styles";
import { InspirationMenu } from "./inspiration-menu";
import { getVoiceById, resolveVoiceName } from "./voice-library-modal";
import { CloneVoiceDialog } from "@/components/voices/clone-voice-dialog";
import {
  MentionMenu,
  RefCategory,
  SeedanceDock,
  ElevenLabsDock,
  framesFromKieValues,
  refToken,
  refsFromKieFields,
  REF_KIND_LABEL,
  type GenRef,
  type RefKind,
} from "./gen-dock-parts";
import {
  estimateKie,
  kieChipFields,
  kieFileFields,
  kieMainTextField,
} from "@/lib/kie-pricing";

// Kie-каталог включен по умолчанию; выключить: NEXT_PUBLIC_KIE_CREATE=0.
// (Сравнение с "1" ломалось: Next компилировал флаг в runtime-доступ
// к process.env вместо baked-значения, и в браузере он был выключен.)
const KIE_CREATE_ENABLED = process.env.NEXT_PUBLIC_KIE_CREATE !== "0";

/** Поля KIE-каталога «первый / последний кадр» — это не референсы, у них свой слот. */
const KIE_FRAME_FIELDS = new Set(["first_frame_url", "last_frame_url", "first_frame", "last_frame"]);

/** Seedance (KIE): единственное семейство с режимом Omni и пресетами Fast/Quality. */
function isSeedanceModel(m: KieModelSpec | null): boolean {
  return Boolean(m && m.id.toLowerCase().startsWith("seedance"));
}

/** Поля Seedance, которые рисует SeedanceDock, — из общего списка чипов их убираем. */
const SEEDANCE_DOCK_FIELDS = new Set(["aspect_ratio", "resolution", "duration", "generate_audio"]);

/** Поля ElevenLabs, которые рисует ElevenLabsDock (голос + слайдеры), — из чипов убираем. */
const ELEVENLABS_DOCK_FIELDS = new Set(["voice_id", "stability", "similarity"]);

/**
 * Крупные PNG Kie рвёт на загрузке (ReadError). Перед отправкой ужимаем фото
 * в браузере: максимум 2048 px по длинной стороне, JPEG вместо PNG.
 */
async function shrinkImageForUpload(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= 1.5 * 1024 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function refKindOfField(f: KieField): RefKind {
  return f.kind === "videos" ? "video" : f.kind === "audios" ? "audio" : "image";
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Опционально: «применить к проекту» — не источник настроек. */
  projectId: number | null;
};

type RefImage = { id: string; url: string; name: string; file?: File; sourceKey?: string };

type DraftJob = {
  job_id: string;
  history_id: string;
  status: "processing";
  media: "image";
  model: string;
  prompt_preview: string;
  provider: "draft";
  created_at: string;
  started_at: string;
};

type HistoryItem = {
  id: string;
  kind: string;
  preview_url: string | null;
  raw_url?: string | null;
  path?: string | null;
  label: string;
  project_id: number | null;
  project_slug: string | null;
  prompt: string | null;
  status?: string | null;
  job_id?: string | null;
  error?: string | null;
  model?: string | null;
  elapsed_sec?: number | null;
  elapsed_label?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  mtime?: number | null;
  params?: Record<string, unknown> | null;
  reference_images?: string[] | null;
  first_frame_url?: string | null;
  provider?: "outsee" | "kie" | string | null;
};

/**
 * URL миниатюры для сетки истории: сервер отдаёт кэшированный WebP 320px.
 * Только для `/api/files` картинок; фулл-вью, скачивание, кадры и референсы
 * идут полным файлом и этот хелпер не используют.
 */
function thumbUrl(previewUrl: string | null): string | undefined {
  return toThumbnailUrl(previewUrl);
}

function makeRefFromFile(file: File): RefImage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    url: URL.createObjectURL(file),
    name: file.name,
    file,
  };
}

function revokeRefUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * Минимальный размер скачанного кадра/референса. Меньше — недогруженный или
 * битый файл (заглушка в байты): такой data:URL гарантированно отвергнет
 * бэкенд-валидация (`first_frame_url: не URL` у kie) или, хуже, уйдёт в
 * провайдер мусором. Проверяем до dataUrl, с понятным текстом.
 */
const MIN_FRAME_BYTES = 2048;

function assertFrameBlob(res: Response, blob: Blob): boolean {
  if (!res.ok || blob.size < MIN_FRAME_BYTES) {
    toast.error("Кадр не загрузился полностью — дождитесь загрузки и попробуйте снова");
    return false;
  }
  return true;
}

async function resolveReferenceUrls(refs: RefImage[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs) {
    if (r.file) out.push(await readFileAsDataUrl(r.file));
    else out.push(r.url);
  }
  return [...new Set(out)];
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function formatElapsedMinSec(totalSec: number | null | undefined): string {
  const n = Math.max(0, Math.round(Number(totalSec) || 0));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m} мин ${s} сек`;
}


export const RANDOM_PROMPTS = [
  // Кинематографичные сюжеты и кинокадры
  "Cinematic film still of a detective in a trench coat standing under a flickering street lamp on a rainy night in 1950s Chicago, dramatic shadows, 35mm film look",
  "A dusty desert highway at sunset with a classic vintage muscle car parked on the roadside, golden hour light, anamorphic lens flare",
  "Astronaut sitting on a rocky cliff overlooking a vast crimson Martian canyon, twin moons in the starry night sky, cinematic lighting",
  "Close-up portrait of an old weathered sea captain looking into a fierce ocean storm, sea salt in his gray beard, intense dramatic gaze",
  "A neon-lit ramen bar in downtown Tokyo during a heavy downpour, steam rising from fresh bowls, reflections on wet asphalt, moody atmosphere",
  "A lone mountaineer reaching the summit of a snowy Alpine peak at sunrise, sea of clouds below, crisp clear mountain air, wide angle lens",
  "Dark gothic ballroom with grand chandeliers, mysterious masquerade dancers in elaborate dark attire, candlelit ambience, deep shadows",
  "Cyberpunk courier speeding through a rainy futuristic megacity on an illuminated hoverbike, holographic signs reflecting on helmet visor",
  "Retro 1980s synthwave night drive, sports car dashboard view, purple and teal sunset over distant palm trees and grid skyline",
  "A medieval blacksmith hammering a glowing red sword blade in a dim stone forge, bright flying sparks, fiery rim lighting",

  // Уют, быт и атмосфера
  "Cozy rustic kitchen in morning sunlight, fresh warm croissants on a wooden board, steam rising from ceramic coffee cup, soft dust motes",
  "Rainy afternoon in an old bookstore, stacks of antique books reaching the ceiling, a cat napping on a green velvet armchair by the window",
  "A serene wooden cabin on the edge of a misty pine lake, warm amber glow in the windows, smoking chimney, autumn dawn reflection",
  "A vinyl record spinning on a vintage turntable, warm amber lamp glow, soft bokeh lights, cozy evening living room",
  "Sunny glass greenhouse conservatory overflowing with exotic tropical monstera and ferns, hanging brass lanterns, golden sunbeams",
  "A street artist painting a colorful mural on an old brick wall in a sunlit European alley, paint splatters, authentic candid moment",
  "A camper van parked on an ocean cliff edge with the back doors open, two cups of tea, overlooking crashing waves at twilight",
  "An artisan pottery workshop, potter's hands shaping wet clay on a spinning wheel, natural window light, rustic ceramics on wooden shelves",

  // Животные и дикая природа
  "A cute fluffy red fox curled up asleep on a blanket of freshly fallen snow in a quiet winter birch forest",
  "Charming capybara relaxing in an outdoor Japanese hot spring bath with a small yuzu fruit balanced on its head, gentle rising steam",
  "Macro close-up shot of a chameleon with vibrant neon scales and an iridescent eye perched on a lush tropical branch",
  "A majestic humpback whale breaching out of calm Arctic waters, dramatic golden sunset sky, glistening water splash",
  "A wise barn owl perched on a moss-covered oak branch in twilight mist, soft detailed feathers, striking amber eyes",
  "Playful golden retriever puppy running through a vibrant meadow of wild blooming poppies, sunny summer afternoon",
  "A tiny colorful tree frog resting inside a wet exotic jungle flower, glistening translucent water dewdrops, shallow focus",

  // Еда, напитки и коммерческий предметный стиль
  "Gourmet smash burger with melting aged cheddar, crispy bacon, caramelized onions and sauce dripping onto craft paper, mouthwatering food photography",
  "Crystal cocktail glass with an artisan amber whiskey, spherical clear ice cube, orange peel garnish, moody speakeasy bar lighting",
  "A slice of decadent dark chocolate cake with glossy dripping ganache and fresh ripe raspberries on a matte ceramic plate",
  "Overhead flat lay of an authentic Italian Neapolitan pizza fresh from a wood-fired oven, blistered crust, creamy mozzarella and fresh basil leaves",
  "A matcha latte in a minimalist ceramic cup with delicate foam leaf latte art, bamboo whisk and green powder on a raw stone slate",
  "Fresh chilled glass bottle of sparkling soda with ice condensation droplets, floating lime slices and fresh mint leaves, bright summer sunlight",

  // Фэнтези, мистика и Sci-Fi
  "Ancient colossal stone temple ruins hidden deep inside a bioluminescent jungle, glowing vines, cascading emerald waterfalls",
  "Majestic celestial dragon with shimmering pearl scales soaring through pastel sunset clouds above floating mountain islands",
  "Enchanted library where glowing magical origami birds fly between high bookshelves, magical stardust swirling in the air",
  "A futuristic botanical dome on the moon, lush green trees inside glass dome with Earth rising above the barren lunar landscape",
  "Ethereal underwater crystal palace with glowing jellyfish drifting past carved coral arches, tranquil turquoise atmosphere",
  "A friendly small maintenance robot tending to bonsai trees in a minimalist futuristic apartment, soft daylight, warm feeling",
  "A solitary wizard tower on a sharp sea cliff during an epic thunderstorm, glowing blue runes carved into dark stone, violent lightning",
  "A mysterious alchemist workstation with glass retorts bubbling with glowing luminescent liquids, ancient scrolls, dried lavender bunches",

  // Архитектура и дизайн
  "Minimalist brutalist villa made of raw concrete and warm cedar wood, floor-to-ceiling glass windows facing a serene misty pine forest",
  "Cozy Scandinavian interior living room with a crackling fireplace, beige linen sofa, wool knit throw, and large window with mountain view",
  "Futuristic organic architecture city with flowing white curves, green sky terraces, elevated pedestrian bridges and clean blue sky",
  "Traditional Kyoto machiya courtyard garden with smooth stepping stones, bamboo fountain, and vibrant red Japanese maple leaves in autumn",
  "Modern luxury penthouse bedroom at night overlooking Manhattan skyline, dark moody tones, plush king bed, floor-to-ceiling city panorama",

  // Графика, 3D и креативные концепты
  "Vibrant 3D isometric cutaway illustration of a cozy gamer room with dual monitors, glowing RGB lights, mini fridge, and posters",
  "Retro travel poster illustration of a futuristic vacation to Saturn's rings, bold vintage typography, stylish mid-century palette",
  "Whimsical miniature clay diorama of a tiny bakery run by mice, micro loaves of bread, flour dusting, handcrafted stop-motion look",
  "Cute cartoon astronaut cat exploring an alien planet covered in candy-colored giant mushrooms, playful vibrant colors",
  "Editorial fashion studio portrait of a woman wearing a holographic geometric dress, high-fashion makeup, dramatic studio split lighting",
  "A vintage steam locomotive rushing through a snowy mountain gorge over an arched stone viaduct, billowing white steam clouds",
];

function downloadMediaFile(
  url: string,
  filename: string,
  format: "png" | "jpg" | "webp" | "mp4" | "mp3" | string = "png",
  path?: string | null,
) {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (url) params.set("url", url);
  params.set("format", format);
  params.set("filename", filename);

  const downloadUrl = `/api/outsee-create/download?${params.toString()}`;
  const a = document.createElement("a");
  a.href = downloadUrl;
  a.download = `${filename.replace(/\.[^/.]+$/, "")}.${format}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function AudioStudioPlayer({
  item,
  onInspect,
}: {
  item: HistoryItem;
  onInspect?: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLooping, setIsLooping] = useState(false);
  const [copied, setCopied] = useState(false);
  const speedRef = useRef<HTMLDivElement>(null);
  const [speedOpen, setSpeedOpen] = useState(false);

  useEffect(() => {
    if (!speedOpen) return;
    const onDown = (e: MouseEvent) => {
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) {
        setSpeedOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [speedOpen]);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.playbackRate = playbackRate;
      audioRef.current.loop = isLooping;
    }
  }, [item.preview_url, item.id]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch((err) => {
        console.warn("Audio playback error:", err);
      });
    }
  };

  const seekBy = (sec: number) => {
    if (!audioRef.current) return;
    const target = Math.max(0, Math.min(duration || 0, audioRef.current.currentTime + sec));
    audioRef.current.currentTime = target;
    setCurrentTime(target);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || !audioRef.current || !duration) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, clickX / rect.width));
    const target = percent * duration;
    audioRef.current.currentTime = target;
    setCurrentTime(target);
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    if (isMuted) {
      audioRef.current.muted = false;
      setIsMuted(false);
    } else {
      audioRef.current.muted = true;
      setIsMuted(true);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    if (audioRef.current) {
      audioRef.current.volume = val;
      if (val === 0) {
        audioRef.current.muted = true;
        setIsMuted(true);
      } else if (isMuted) {
        audioRef.current.muted = false;
        setIsMuted(false);
      }
    }
  };

  const cyclePlaybackRate = () => {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
    const nextRate = rates[nextIdx];
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  const toggleLoop = () => {
    const nextLoop = !isLooping;
    setIsLooping(nextLoop);
    if (audioRef.current) {
      audioRef.current.loop = nextLoop;
    }
  };

  const handleCopyLink = () => {
    const url = item.preview_url || item.raw_url || "";
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      toast.success("Ссылка на аудио скопирована");
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownload = () => {
    const url = item.preview_url || item.raw_url || "";
    if (!url) return;
    const title = (item.params?.title as string) || item.label || "audio_track";
    void downloadMediaFile(url, title, "mp3", item.path);
  };

  const formatTime = (seconds: number): string => {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  const trackTitle =
    (item.params?.title as string) ||
    item.label ||
    "Сгенерированный аудио трек";

  const trackStyle =
    (item.params?.style as string) ||
    item.prompt ||
    "";

  const modelBadge =
    (item.params?.model as string) ||
    (item.model?.includes("ElevenLabs") || item.model?.includes("elevenlabs")
      ? "ElevenLabs v4"
      : item.model?.includes("V5_5")
        ? "V5.5"
        : item.model?.includes("V5")
          ? "V5"
          : "Suno AI");

  const WAVE_BARS = useMemo(
    () => [
      22, 38, 55, 78, 48, 92, 68, 54, 82, 96, 64, 46, 76, 92, 58, 42,
      66, 86, 98, 74, 52, 82, 100, 88, 64, 48, 72, 88, 96, 72, 48, 64,
      86, 76, 54, 72, 92, 82, 58, 76, 92, 64, 44, 62, 82, 96, 58, 34,
    ],
    [],
  );

  return (
    <div className="relative flex w-full max-w-3xl lg:max-w-4xl flex-col gap-5 rounded-3xl border border-white/15 bg-[#121216]/95 p-6 md:p-8 backdrop-blur-2xl shadow-[0_30px_90px_rgba(0,0,0,0.9)] ring-1 ring-white/10 animate-in fade-in duration-300">
      <audio
        ref={audioRef}
        src={item.preview_url || undefined}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          if (!isLooping) setIsPlaying(false);
        }}
        onTimeUpdate={() => {
          if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
        }}
        onLoadedMetadata={() => {
          if (audioRef.current) {
            setDuration(audioRef.current.duration);
            audioRef.current.playbackRate = playbackRate;
            audioRef.current.loop = isLooping;
          }
        }}
      />

      {/* Top: Vinyl + Track info + Actions */}
      <div className="flex items-center gap-4 md:gap-5">
        <div className="relative flex h-20 w-20 md:h-24 md:w-24 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1a1a24] to-[#0a0a0f] ring-1 ring-white/15 shadow-2xl overflow-hidden">
          <div
            className={cn(
              "absolute inset-1.5 rounded-full border border-white/10 bg-gradient-to-tr from-black via-zinc-900 to-black transition-transform duration-700",
              isPlaying && "animate-[spin_4s_linear_infinite]",
            )}
          >
            <div className="absolute inset-2.5 rounded-full border border-white/5" />
            <div className="absolute inset-5 rounded-full border border-white/5" />
            <div className="absolute inset-0 m-auto h-6 w-6 md:h-7 md:w-7 rounded-full bg-gradient-to-br from-[#2dd4bf] to-[#5eead4] shadow-[0_0_12px_rgba(45,212,191,0.6)] flex items-center justify-center">
              <div className="h-2 w-2 rounded-full bg-black" />
            </div>
          </div>
          <Disc className={cn("h-8 w-8 md:h-9 md:w-9 text-white/70 relative z-10 transition-opacity", isPlaying ? "opacity-0" : "opacity-80")} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="truncate text-base md:text-xl font-bold text-white tracking-tight" title={trackTitle}>
              {trackTitle}
            </h3>
            <span className="shrink-0 rounded-md bg-[#2dd4bf]/15 px-2 py-0.5 font-mono text-[10px] md:text-xs font-bold text-[#2dd4bf] ring-1 ring-[#2dd4bf]/30">
              {modelBadge}
            </span>
          </div>
          {trackStyle && (
            <p className="mt-1 line-clamp-2 text-xs md:text-sm text-white/60 leading-relaxed" title={trackStyle}>
              {trackStyle}
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-white/40 font-mono">
            <span>ID: {item.id ? String(item.id).slice(0, 8) : "—"}</span>
            {item.elapsed_sec && (
              <>
                <span>•</span>
                <span>ген: {Math.round(item.elapsed_sec)}с</span>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleCopyLink}
            className="flex h-9 w-9 md:h-10 md:w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
            title="Скопировать ссылку на аудио"
          >
            {copied ? <Check className="h-4 w-4 text-[#2dd4bf]" /> : <Copy className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="flex h-9 w-9 md:h-10 md:w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-[#2dd4bf]/40 hover:bg-[#2dd4bf]/10 hover:text-[#2dd4bf]"
            title="Скачать трек (MP3)"
          >
            <Download className="h-4 w-4" />
          </button>
          {onInspect && (
            <button
              type="button"
              onClick={onInspect}
              className="flex h-9 w-9 md:h-10 md:w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
              title="Открыть инспектор и детали промпта"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Waveform Visualizer & Seek Area */}
      <div
        ref={progressBarRef}
        onClick={handleSeek}
        className="group relative flex h-16 md:h-22 w-full cursor-pointer items-end justify-between gap-1 md:gap-1.5 rounded-2xl bg-black/45 px-4 py-3 ring-1 ring-white/10 transition hover:ring-[#2dd4bf]/40 overflow-hidden"
      >
        {isPlaying && (
          <div className="absolute inset-0 bg-gradient-to-t from-[#2dd4bf]/[0.08] to-transparent pointer-events-none" />
        )}

        {WAVE_BARS.map((heightPercent, idx) => {
          const barProgress = idx / (WAVE_BARS.length - 1);
          const currentProgress = duration > 0 ? currentTime / duration : 0;
          const isPassed = barProgress <= currentProgress;

          return (
            <div
              key={idx}
              className="relative flex h-full flex-1 items-end justify-center"
            >
              <div
                style={{ height: `${heightPercent}%` }}
                className={cn(
                  "w-1.5 md:w-2 rounded-full transition-all duration-150",
                  isPassed
                    ? "bg-[#2dd4bf] shadow-[0_0_10px_rgba(45,212,191,0.55)]"
                    : "bg-white/15 group-hover:bg-white/25",
                  isPlaying && isPassed && "brightness-125",
                )}
              />
            </div>
          );
        })}

        <div
          style={{ left: `${progressPercent}%` }}
          className="pointer-events-none absolute top-0 bottom-0 w-1 bg-white shadow-[0_0_14px_#2dd4bf] transition-all"
        />
      </div>

      {/* Scrubber slider and time display */}
      <div className="space-y-2">
        <div
          onClick={handleSeek}
          className="group relative flex h-2.5 w-full cursor-pointer items-center rounded-full bg-white/10"
        >
          <div
            style={{ width: `${progressPercent}%` }}
            className="h-full rounded-full bg-gradient-to-r from-[#2dd4bf] to-[#5eead4] shadow-[0_0_14px_rgba(45,212,191,0.5)]"
          />
          <div
            style={{ left: `calc(${progressPercent}% - 7px)` }}
            className="absolute h-3.5 w-3.5 rounded-full bg-white ring-2 ring-[#2dd4bf] shadow-[0_0_10px_#2dd4bf] opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>

        <div className="flex items-center justify-between font-mono text-xs md:text-sm text-white/50">
          <span className="text-white/90 font-semibold">{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleLoop}
            className={cn(
              "flex h-9 md:h-10 items-center gap-1.5 rounded-xl px-3 text-xs font-mono transition ring-1",
              isLooping
                ? "bg-[#2dd4bf]/20 text-[#2dd4bf] ring-[#2dd4bf]/40 shadow-[0_0_14px_rgba(45,212,191,0.25)]"
                : "bg-white/[0.04] text-white/50 ring-white/10 hover:bg-white/[0.08] hover:text-white",
            )}
            title="Зациклить трек (Loop)"
          >
            <Repeat className="h-4 w-4" />
            <span>Loop</span>
          </button>

          <div className="relative" ref={speedRef}>
            <button
              type="button"
              onClick={() => setSpeedOpen((v) => !v)}
              className={cn(
                "flex h-9 md:h-10 items-center gap-1.5 rounded-xl px-3 font-mono text-xs ring-1 transition",
                speedOpen
                  ? "bg-[#2dd4bf]/20 text-[#2dd4bf] ring-[#2dd4bf]/40 shadow-[0_0_14px_rgba(45,212,191,0.25)]"
                  : "bg-white/[0.04] text-white/70 ring-white/10 hover:bg-white/[0.08] hover:text-white",
              )}
              title="Выбрать скорость воспроизведения"
            >
              <span>{playbackRate}x</span>
              <ChevronDown className={cn("h-3.5 w-3.5 text-white/50 transition-transform duration-200", speedOpen && "rotate-180")} />
            </button>

            {speedOpen && (
              <div className="absolute bottom-full left-0 mb-2 z-50 flex flex-col min-w-[130px] rounded-xl border border-white/15 bg-[#121216]/98 p-1 backdrop-blur-2xl shadow-[0_15px_40px_rgba(0,0,0,0.85)] ring-1 ring-white/10 animate-in fade-in zoom-in-95 duration-150">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white/40 border-b border-white/[0.08] mb-1">
                  Скорость
                </div>
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => {
                  const isActive = playbackRate === rate;
                  return (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => {
                        setPlaybackRate(rate);
                        if (audioRef.current) audioRef.current.playbackRate = rate;
                        setSpeedOpen(false);
                      }}
                      className={cn(
                        "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left font-mono text-xs transition",
                        isActive
                          ? "bg-[#2dd4bf]/20 text-[#2dd4bf] font-bold"
                          : "text-white/75 hover:bg-white/[0.08] hover:text-white",
                      )}
                    >
                      <span>{rate}x {rate === 1 ? "(1.0)" : ""}</span>
                      {isActive && <Check className="h-3.5 w-3.5 text-[#2dd4bf]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Center: Rewind / Play / Forward */}
        <div className="flex items-center gap-3 md:gap-4">
          <button
            type="button"
            onClick={() => seekBy(-10)}
            className="flex h-10 w-10 md:h-11 md:w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/70 transition hover:scale-105 hover:border-white/20 hover:bg-white/[0.08] hover:text-white active:scale-95"
            title="Перемотать назад на 10 сек"
          >
            <RotateCcw className="h-4.5 w-4.5" />
          </button>

          <button
            type="button"
            onClick={togglePlay}
            className="flex h-13 w-13 md:h-15 md:w-15 items-center justify-center rounded-2xl bg-gradient-to-r from-[#2dd4bf] to-[#0d9488] text-black shadow-[0_0_30px_rgba(45,212,191,0.45)] transition hover:scale-105 hover:brightness-110 active:scale-95"
            title={isPlaying ? "Пауза" : "Воспроизвести"}
          >
            {isPlaying ? (
              <Pause className="h-6 w-6 md:h-7 md:w-7 fill-current" />
            ) : (
              <Play className="h-6 w-6 md:h-7 md:w-7 fill-current translate-x-0.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => seekBy(10)}
            className="flex h-10 w-10 md:h-11 md:w-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-white/70 transition hover:scale-105 hover:border-white/20 hover:bg-white/[0.08] hover:text-white active:scale-95"
            title="Перемотать вперёд на 10 сек"
          >
            <RotateCw className="h-4.5 w-4.5" />
          </button>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={toggleMute}
            className="text-white/60 transition hover:text-white"
            title={isMuted ? "Включить звук" : "Выключить звук"}
          >
            {isMuted || volume === 0 ? (
              <VolumeX className="h-4.5 w-4.5 text-rose-400" />
            ) : (
              <Volume2 className="h-4.5 w-4.5" />
            )}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            className="h-1.5 w-20 md:w-28 cursor-pointer appearance-none rounded-lg bg-white/20 accent-[#2dd4bf]"
            title={`Громкость: ${Math.round((isMuted ? 0 : volume) * 100)}%`}
          />
        </div>
      </div>
    </div>
  );
}

// Глобальный in-memory кэш предзагруженных URL: исключает повторные задержки
// и спиннеры при переключении между уже просмотренными кадрами (0 мс)
const globalLoadedImageUrls = new Set<string>();

function CreateImageViewer({
  item,
  onInspect,
}: {
  item: HistoryItem;
  onInspect: () => void;
}) {
  const fullUrl = item.preview_url || "";
  const thumb = thumbUrl(item.preview_url);
  const isAlreadyCached = Boolean(fullUrl && globalLoadedImageUrls.has(fullUrl));

  const [loaded, setLoaded] = useState(isAlreadyCached);
  const [hasError, setHasError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (fullUrl && globalLoadedImageUrls.has(fullUrl)) {
      setLoaded(true);
      setHasError(false);
    } else {
      setLoaded(false);
      setHasError(false);
    }
  }, [item.id, fullUrl]);

  // Если браузер уже сохранил кадр в дисковом/памятном кэше
  useEffect(() => {
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      if (fullUrl) globalLoadedImageUrls.add(fullUrl);
      setLoaded(true);
    }
  }, [fullUrl]);

  return (
    <div className="relative flex max-h-[calc(100vh-360px)] max-w-full items-center justify-center">
      {/* 1. Мгновенный тамбнейл из памяти, пока качается оригинальный 2K файл */}
      {thumb && !loaded && !hasError && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt=""
          className="max-h-[calc(100vh-360px)] max-w-full rounded-2xl border border-white/15 bg-black/80 object-contain filter blur-[1px] transition-opacity"
        />
      )}

      {/* 2. Деликатный индикатор загрузки оригинального качества — в углу, не блокируя просмотр */}
      {!loaded && !hasError && (
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-3 py-1.5 text-xs text-white/90 backdrop-blur-md pointer-events-none shadow-lg">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#2dd4bf]" />
          <span className="font-medium">Загрузка оригинала...</span>
        </div>
      )}

      {/* 3. Полноразмерное изображение */}
      {!hasError ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          key={item.id}
          src={fullUrl}
          alt=""
          onLoad={() => {
            if (fullUrl) globalLoadedImageUrls.add(fullUrl);
            setLoaded(true);
          }}
          onError={() => setHasError(true)}
          onClick={onInspect}
          className={cn(
            "max-h-[calc(100vh-360px)] max-w-full cursor-zoom-in rounded-2xl border border-white/15 bg-black/80 object-contain shadow-[0_20px_50px_rgba(0,0,0,0.8)] transition duration-200 hover:brightness-105",
            !loaded && "absolute inset-0 opacity-0 pointer-events-none",
          )}
        />
      ) : (
        <div className="flex flex-col items-center justify-center p-8 text-center rounded-2xl border border-red-500/30 bg-red-500/10 text-red-300">
          <ImageIcon className="h-8 w-8 mb-2 opacity-60" />
          <span className="text-sm font-semibold">Не удалось загрузить изображение</span>
          <span className="text-xs text-white/40 mt-1 font-mono">{item.label}</span>
        </div>
      )}
    </div>
  );
}

export function OutseeCreateWorkspace({ open, onOpenChange, projectId }: Props) {
  const qc = useQueryClient();
  const [mediaType, setMediaType] = useState<OutseeMediaType>("image");
  const [feedKind, setFeedKind] = useState<OutseeFeedKind>("all");
  const [imageSlug, setImageSlug] = useState("gpt-image-2");
  const [videoSlug, setVideoSlug] = useState("veo-3-1-lite");
  const [audioSlug, setAudioSlug] = useState("kie:suno-music");
  const [aspect, setAspect] = useState("16:9");
  const [resolution, setResolution] = useState("2K");
  const [detail, setDetail] = useState("medium");
  const [videoResolution, setVideoResolution] = useState("720p");
  const [duration, setDuration] = useState("5");
  const [generateAudio, setGenerateAudio] = useState(false);
  const [orientation, setOrientation] = useState<"video" | "image">("video");
  const [motionQuality, setMotionQuality] = useState("std");
  const [instrumental, setInstrumental] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [showNegativePrompt, setShowNegativePrompt] = useState(false);
  /** Стиль из «Вдохновения» — каталог помощника; ядро стиля дописывается к промпту фото. */
  const [stylePreset, setStylePreset] = useState("");
  const activeStyle = inspirationStyle(stylePreset);
  const [downloadFormat, setDownloadFormat] = useState<"png" | "jpg" | "webp">("png");
  const [batchCount, setBatchCount] = useState<1 | 2 | 4>(1);
  const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false);
  const [soraSize, setSoraSize] = useState<"small" | "large">("small");
  const [firstFrameDataUrl, setFirstFrameDataUrl] = useState<string | null>(null);
  const [lastFrameDataUrl, setLastFrameDataUrl] = useState<string | null>(null);
  const [firstFrameName, setFirstFrameName] = useState<string | null>(null);
  const [lastFrameName, setLastFrameName] = useState<string | null>(null);
  const [referenceImages, setReferenceImages] = useState<RefImage[]>([]);
  // ---- Новый док генерации (стиль outsee.io/create) ----
  /** Фактические имена вложений KIE: field → имена в том же порядке, что и URL-ы. */
  const [kieRefNames, setKieRefNames] = useState<Record<string, string[]>>({});
  /** Seedance: omni (фото/видео/аудио) или первый+последний кадр. */
  const [seedanceMode, setSeedanceMode] = useState<"omni" | "frames">("omni");
  /** Seedance: Fast (480p) или Quality (720p и выше). */
  const [seedancePreset, setSeedancePreset] = useState<"fast" | "quality">("quality");
  /** Поле, в которое сейчас грузится файл-референс. */
  const [refBusyField, setRefBusyField] = useState<string | null>(null);
  /** Меню «@» в поле промта. */
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  /** Просмотр референса крупно (лайтбокс). */
  const [refPreview, setRefPreview] = useState<GenRef | null>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const pendingRefFieldRef = useRef<KieField | null>(null);
  const [draftJobs, setDraftJobs] = useState<DraftJob[]>([]);
  const [trackingJobs, setTrackingJobs] = useState<
    { provider: "outsee" | "kie"; jobId: string; historyId: string }[]
  >(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem("studio_tracking_jobs");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("studio_tracking_jobs", JSON.stringify(trackingJobs));
    } catch {
      // ignore
    }
  }, [trackingJobs]);
  const [modelOpen, setModelOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantExpanded, setAssistantExpanded] = useState(true);
  // Помощник — инструмент v2-механики: в воркспейсе v1 его нет (R1).
  const [workspaceMode] = usePipelineMode();
  const [appliedPrompt, setAppliedPrompt] = useState<{ text: string; ts: number } | null>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [kieValues, setKieValues] = useState<Record<string, unknown>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  // Якорь выбора модели, когда открыт помощник промпта (док скрыт)
  const modelRef2 = useRef<HTMLDivElement>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const multiRefInputRef = useRef<HTMLInputElement>(null);
  const [cloneVoiceOpen, setCloneVoiceOpen] = useState(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);

  const handleInsertAudioTag = (tag: string) => {
    const textarea = promptTextareaRef.current;
    if (!textarea) {
      setPrompt((prev) => (prev ? `${prev} ${tag} ` : `${tag} `));
      return;
    }
    const start = textarea.selectionStart ?? prompt.length;
    const end = textarea.selectionEnd ?? prompt.length;
    const before = prompt.slice(0, start);
    const after = prompt.slice(end);
    const spacerBefore = before.length > 0 && !before.endsWith(" ") ? " " : "";
    const spacerAfter = after.length > 0 && !after.startsWith(" ") ? " " : "";
    const inserted = `${spacerBefore}${tag}${spacerAfter}`;
    const nextPrompt = `${before}${inserted}${after}`;
    setPrompt(nextPrompt);
    requestAnimationFrame(() => {
      textarea.focus();
      const newPos = start + inserted.length;
      textarea.setSelectionRange(newPos, newPos);
    });
  };

  /** Выбор голоса из выпадающего меню ElevenLabsDock (вместо старого модала). */
  const handleVoiceChange = (voiceId: string, name: string) => {
    setKieValues((prev) => ({ ...prev, voice_id: voiceId }));
    toast.success(`Выбран голос: ${name}`);
  };
  const referenceImagesRef = useRef<RefImage[]>([]);

  const settingsQ = useQuery({
    queryKey: ["outsee-create-settings"],
    queryFn: api.getOutseeCreateSettings,
    enabled: open && KIE_CREATE_ENABLED,
  });

  const outseeStatusQ = useQuery({
    queryKey: ["outsee-status"],
    queryFn: api.outseeStatus,
    enabled: open && KIE_CREATE_ENABLED,
    staleTime: 30_000,
  });

  const createQueueQ = useQuery({
    queryKey: ["create-queue"],
    queryFn: api.createQueue,
    enabled: open && KIE_CREATE_ENABLED,
    refetchInterval: open ? 1200 : false,
  });

  const kieCatalogQ = useQuery({
    queryKey: ["kie-catalog"],
    queryFn: api.kieCatalog,
    enabled: open && KIE_CREATE_ENABLED,
    staleTime: 60_000,
  });
  const kieCreditsQ = useQuery({
    queryKey: ["kie-credits"],
    queryFn: api.kieCredits,
    enabled: open && KIE_CREATE_ENABLED,
    refetchInterval: open ? 60_000 : false,
  });

  const serverRunningCount =
    createQueueQ.data?.running_count ?? (createQueueQ.data?.running?.length ?? 0);
  const serverWaitingCount =
    createQueueQ.data?.waiting_count ?? (createQueueQ.data?.waiting?.length ?? 0);
  const queueCount =
    (createQueueQ.data?.total_active ?? 0) ||
    (serverRunningCount + serverWaitingCount);

  // Идентификаторы задач, запущенных текущим пользователем / сессией
  const myJobIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of trackingJobs) {
      if (t.jobId) s.add(t.jobId);
      if (t.historyId) s.add(t.historyId);
    }
    for (const d of draftJobs) {
      if (d.job_id) s.add(d.job_id);
      if (d.history_id) s.add(d.history_id);
    }
    for (const r of createQueueQ.data?.running ?? []) {
      if (r.job_id) s.add(r.job_id);
      if (r.history_id) s.add(r.history_id);
    }
    for (const w of createQueueQ.data?.waiting ?? []) {
      if (w.job_id) s.add(w.job_id);
      if (w.history_id) s.add(w.history_id);
    }
    return s;
  }, [trackingJobs, draftJobs, createQueueQ.data?.running, createQueueQ.data?.waiting]);

  // Автосинхронизация с сервером: если вкладка была закрыта или страница перезагружена,
  // все активные задачи с сервера гарантированно подхватываются в trackingJobs
  useEffect(() => {
    const activeFromServer = [
      ...(createQueueQ.data?.running ?? []),
      ...(createQueueQ.data?.waiting ?? []),
    ];
    if (!activeFromServer.length) return;
    setTrackingJobs((prev) => {
      const existing = new Set(prev.map((t) => t.jobId));
      const toAdd: { provider: "outsee" | "kie"; jobId: string; historyId: string }[] = [];
      for (const job of activeFromServer) {
        if (job.job_id && !existing.has(job.job_id)) {
          toAdd.push({
            provider: (job.provider === "outsee" ? "outsee" : "kie") as "outsee" | "kie",
            jobId: job.job_id,
            historyId: job.history_id || `gen-${job.job_id}`,
          });
        }
      }
      return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
    });
  }, [createQueueQ.data?.running, createQueueQ.data?.waiting]);

  const runningJobs = useMemo(() => {
    const fromQueue = createQueueQ.data?.running ?? [];
    const qFiltered = fromQueue.filter((j) => {
      const jId = j.history_id || j.job_id;
      return myJobIds.has(j.job_id) || (jId ? myJobIds.has(jId) : false);
    });
    return [...draftJobs, ...qFiltered];
  }, [draftJobs, createQueueQ.data?.running, myJobIds]);

  const waitingJobs = useMemo(() => {
    const fromQueue = createQueueQ.data?.waiting ?? [];
    return fromQueue.filter((j) => {
      const jId = j.history_id || j.job_id;
      return myJobIds.has(j.job_id) || (jId ? myJobIds.has(jId) : false);
    });
  }, [createQueueQ.data?.waiting, myJobIds]);

  const historyBusy = queueCount > 0 || draftJobs.length > 0 || trackingJobs.length > 0;

  const historyQ = useQuery({
    queryKey: ["outsee-create-history", feedKind],
    queryFn: () =>
      api.listOutseeCreateHistory(feedKind, { scope: "create", limit: 60 }),
    enabled: open && KIE_CREATE_ENABLED,
    // Не долбим диск/сеть: часто только пока есть очередь, иначе редко.
    refetchInterval: open ? (historyBusy ? 3000 : 12_000) : false,
  });

  useEffect(() => {
    if (!open || !settingsQ.data || settingsHydrated) return;
    const s = settingsQ.data;
    const mt = (s.media_type as OutseeMediaType) || "image";
    const rawImg = String(s.image_slug || "nano-banana-2").replace("kie:", "");
    if (rawImg === "gpt-image-2" || rawImg === "nano-banana-2") {
      setImageSlug(rawImg);
    } else if (rawImg === "gpt-image-2.5") {
      setImageSlug("nano-banana-2");
    } else {
      setImageSlug(rawImg.startsWith("kie:") ? rawImg : `kie:${rawImg}`);
    }
    const rawVid = String(s.video_slug || "veo-3-1-lite").replace("kie:", "");
    if (rawVid === "veo-3-1-lite" || rawVid === "veo-3-1") {
      setVideoSlug("veo-3-1-lite");
    } else {
      setVideoSlug(rawVid.startsWith("kie:") ? rawVid : `kie:${rawVid}`);
    }
    const rawAud = String(s.audio_slug || "kie:suno-music");
    setAudioSlug(
      rawAud.startsWith("kie:")
        ? rawAud
        : rawAud === "suno-5-5"
          ? "kie:suno-music"
          : rawAud === "elevenlabs-v3"
            ? "kie:elevenlabs-tts-multilingual"
            : `kie:${rawAud}`,
    );
    setAspect(String(s.aspect || "16:9"));
    setResolution(String(s.image_resolution || "2K"));
    setDetail(String(s.image_quality || "medium"));
    setVideoResolution(String(s.video_resolution || "720p"));
    setDuration(String(s.duration || "5"));
    const restoredVideo = rawVid;
    setGenerateAudio(
      restoredVideo === "veo-3-1-lite" ? false : Boolean(s.generate_audio),
    );
    setOrientation(s.orientation === "image" ? "image" : "video");
    setMotionQuality(String(s.motion_quality || "std"));
    setInstrumental(Boolean(s.instrumental));
    setPrompt("");
    setSoraSize(s.sora_size === "large" ? "large" : "small");
    setSettingsHydrated(true);
  }, [open, settingsQ.data, settingsHydrated]);

  useEffect(() => {
    if (!open) {
      setModelOpen(false);
      setOpenChip(null);
      setSettingsHydrated(false);
      setPrompt("");
    }
  }, [open]);

  useEffect(() => {
    referenceImagesRef.current = referenceImages;
  }, [referenceImages]);
  useEffect(() => {
    return () => {
      referenceImagesRef.current.forEach((r) => revokeRefUrl(r.url));
    };
  }, []);

  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (modelRef.current?.contains(t) || modelRef2.current?.contains(t)) return;
      setModelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelOpen]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen]);

  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const localJobStartRef = useRef<Map<string, number>>(new Map());

  const getLiveElapsed = (
    item?:
      | HistoryItem
      | {
          id?: string;
          history_id?: string;
          job_id?: string | null;
          created_at?: string | null;
          started_at?: string | null;
          elapsed_sec?: number | null;
          elapsed_label?: string | null;
          status?: string | null;
        }
      | null,
  ) => {
    if (!item) return "0 мин 00 сек";
    const isPending = item.status === "queued" || item.status === "processing";
    const jobKey = item.id || (item as any).history_id || item.job_id;
    if (!isPending) {
      if (jobKey) localJobStartRef.current.delete(jobKey);
      if (item.elapsed_label) return item.elapsed_label;
      if (item.elapsed_sec != null) return formatElapsedMinSec(item.elapsed_sec);
    }
    // Проверяем соответствующую задачу в активной очереди
    const activeJob =
      runningJobs.find(
        (j) =>
          (item.id && (j.history_id === item.id || j.job_id === item.id)) ||
          ((item as any).history_id && (j.history_id === (item as any).history_id || j.job_id === (item as any).history_id)) ||
          (item.job_id && (j.job_id === item.job_id || j.history_id === item.job_id)),
      ) ||
      waitingJobs.find(
        (j) =>
          (item.id && (j.history_id === item.id || j.job_id === item.id)) ||
          ((item as any).history_id && (j.history_id === (item as any).history_id || j.job_id === (item as any).history_id)) ||
          (item.job_id && (j.job_id === item.job_id || j.history_id === item.job_id)),
      );

    const isRunning = item.status === "processing" || activeJob?.status === "processing";
    const iso = isRunning
      ? (activeJob?.started_at || item.started_at || activeJob?.created_at || item.created_at)
      : (activeJob?.created_at || item.created_at || activeJob?.started_at || item.started_at);

    const rawServerSec = (activeJob as any)?.elapsed_sec ?? item.elapsed_sec;
    const serverSec =
      typeof rawServerSec === "number" && !Number.isNaN(rawServerSec) && rawServerSec >= 0
        ? rawServerSec
        : null;

    let candidateStartMs: number | null = null;
    if (iso) {
      try {
        const parsed = parseUtcDate(iso).getTime();
        if (!Number.isNaN(parsed) && parsed > 0) {
          const isoElapsed = Math.max(0, Math.floor((nowTs - parsed) / 1000));
          const effectiveElapsed =
            serverSec != null ? Math.max(isoElapsed, serverSec) : isoElapsed;
          candidateStartMs = nowTs - effectiveElapsed * 1000;
        }
      } catch {
        /* fallback to serverSec */
      }
    }
    if (candidateStartMs == null && serverSec != null) {
      candidateStartMs = nowTs - serverSec * 1000;
    }

    let finalStartMs = nowTs;
    if (jobKey && localJobStartRef.current.has(jobKey)) {
      const cached = localJobStartRef.current.get(jobKey)!;
      if (candidateStartMs != null && Math.abs(candidateStartMs - cached) > 2000) {
        // Сервер вернул более актуальную метку старта (после обновления страницы или рассинхронизации)
        finalStartMs = candidateStartMs;
        localJobStartRef.current.set(jobKey, candidateStartMs);
      } else {
        finalStartMs = cached;
      }
    } else if (candidateStartMs != null) {
      finalStartMs = candidateStartMs;
      if (jobKey) localJobStartRef.current.set(jobKey, candidateStartMs);
    } else if (jobKey) {
      localJobStartRef.current.set(jobKey, nowTs);
    }

    const diffSec = Math.max(0, Math.floor((nowTs - finalStartMs) / 1000));
    return formatElapsedMinSec(diffSec);
  };

  const activeSlug =
    mediaType === "image" ? imageSlug : mediaType === "video" ? videoSlug : audioSlug;
  const imageModel = getImageModel(imageSlug);
  const videoModel = getVideoModel(videoSlug);
  const audioModel = getAudioModel(audioSlug);
  const dockChips = dockChipsForModel(activeSlug, mediaType);

  // ---- KIE: модель выбрана из общего пикера (slug "kie:<id>") ----
  const kieModels = useMemo(
    () =>
      (kieCatalogQ.data?.models ?? []).filter((m) => {
        const id = m.id.toLowerCase();
        // GPT Image 2, Nano Banana 2, Veo 3.1 Lite — строго Outsee
        if (id.includes("veo") || id.includes("gpt-image") || id.includes("banana")) {
          return false;
        }
        return true;
      }),
    [kieCatalogQ.data],
  );
  const kieModel = useMemo(() => {
    if (!activeSlug.startsWith("kie:")) return null;
    return kieModels.find((m) => m.id === activeSlug.slice(4)) ?? null;
  }, [activeSlug, kieModels]);
  const kieActive = kieModel != null;
  const kieTextField = kieModel ? kieMainTextField(kieModel) : null;

  // ---- Seedance (KIE): плитки референсов, режим Omni / Первый+Последний ----
  const seedanceIsKie = mediaType === "video" && kieActive && isSeedanceModel(kieModel);

  const kieFileFieldList = useMemo(() => (kieModel ? kieFileFields(kieModel) : []), [kieModel]);
  /** Плиточный док в новом дизайне — для любой KIE-модели, у которой есть слоты файлов. */
  const kieTilesActive = Boolean(kieActive && kieFileFieldList.length > 0);
  const omniRefFields = useMemo(
    () => kieFileFieldList.filter((f) => !KIE_FRAME_FIELDS.has(f.name)),
    [kieFileFieldList],
  );
  const frameRefFields = useMemo(
    () => kieFileFieldList.filter((f) => KIE_FRAME_FIELDS.has(f.name)),
    [kieFileFieldList],
  );

  const omniRefs = useMemo(
    () => refsFromKieFields(omniRefFields, kieValues, kieRefNames),
    [omniRefFields, kieValues, kieRefNames],
  );
  const frameRefs = useMemo(
    () => framesFromKieValues(frameRefFields, kieValues, kieRefNames),
    [frameRefFields, kieValues, kieRefNames],
  );
  const seedanceRefs = seedanceMode === "frames" ? frameRefs : omniRefs;

  /**
   * Меню «@» работает не только у Seedance: у Outsee-моделей берём стартовый/финишный
   * кадр и прикреплённые референсы — с фактическими именами файлов.
   */
  const mentionRefs = useMemo<GenRef[]>(() => {
    if (seedanceIsKie) return seedanceRefs;
    if (kieTilesActive) return [...omniRefs, ...frameRefs];
    const legacy: GenRef[] = [];
    if (firstFrameDataUrl) {
      legacy.push({
        id: "frame:first",
        field: "first_frame_url",
        url: firstFrameDataUrl,
        name: firstFrameName || "Первый кадр",
        kind: "image",
        categoryIndex: 1,
        categoryMax: 1,
      });
    }
    if (lastFrameDataUrl) {
      legacy.push({
        id: "frame:last",
        field: "last_frame_url",
        url: lastFrameDataUrl,
        name: lastFrameName || "Последний кадр",
        kind: "image",
        categoryIndex: 1,
        categoryMax: 1,
      });
    }
    referenceImages.forEach((r, i) => {
      legacy.push({
        id: `ref:${r.id}`,
        field: "reference_images",
        url: r.url,
        name: r.name || `Референс ${i + 1}`,
        kind: "image",
        categoryIndex: i + 1,
        categoryMax: referenceImages.length,
      });
    });
    return legacy;
  }, [
    seedanceIsKie,
    seedanceRefs,
    kieTilesActive,
    omniRefs,
    frameRefs,
    firstFrameDataUrl,
    firstFrameName,
    lastFrameDataUrl,
    lastFrameName,
    referenceImages,
  ]);

  const setRefItems = (field: string, urls: string[], names: string[]) => {
    setKieValues((prev) => ({ ...prev, [field]: urls }));
    setKieRefNames((prev) => ({ ...prev, [field]: names }));
  };

  const handleKieValueChange = (name: string, value: unknown) => {
    setKieValues((prev) => ({ ...prev, [name]: value }));
    if (name === "resolution") {
      // Пресет — зеркало разрешения: 480p = Fast, остальное = Quality.
      setSeedancePreset(String(value) === "480p" ? "fast" : "quality");
    }
  };

  const applySeedancePreset = (preset: "fast" | "quality") => {
    setSeedancePreset(preset);
    const resField = kieModel?.fields.find((f) => f.name === "resolution");
    if (!resField) return;
    const options = resField.options || [];
    const next = preset === "fast" ? "480p" : options.includes("720p") ? "720p" : options[0];
    if (next) handleKieValueChange("resolution", next);
  };

  /** Сброс параметров панели «Параметры» к дефолтам модели. */
  const resetSeedanceParams = () => {
    const defaults: [string, unknown][] = [];
    for (const name of ["aspect_ratio", "resolution", "duration", "generate_audio"]) {
      const f = kieModel?.fields.find((x) => x.name === name);
      if (f?.default !== undefined) defaults.push([name, f.default]);
    }
    if (defaults.length === 0) return;
    setKieValues((prev) => {
      const next = { ...prev };
      for (const [name, value] of defaults) next[name] = value;
      return next;
    });
    const resDefault = String(kieModel?.fields.find((x) => x.name === "resolution")?.default ?? "");
    setSeedancePreset(resDefault === "480p" ? "fast" : "quality");
  };

  /** Сброс панели «Параметры» озвучки ElevenLabs к дефолтам модели. */
  const resetElevenLabsParams = () => {
    const defaults: [string, unknown][] = [];
    for (const name of ELEVENLABS_DOCK_FIELDS) {
      const f = kieModel?.fields.find((x) => x.name === name);
      if (f?.default !== undefined) defaults.push([name, f.default]);
    }
    if (defaults.length === 0) return;
    setKieValues((prev) => {
      const next = { ...prev };
      for (const [name, value] of defaults) next[name] = value;
      return next;
    });
  };

  const switchSeedanceMode = (mode: "omni" | "frames") => {
    setSeedanceMode(mode);
    // Поля взаимоисключающие (валидатор KIE не даёт смешивать кадры и референсы),
    // поэтому неактивную группу чистим сразу, а не только скрываем.
    if (mode === "frames") {
      setRefItems("reference_image_urls", [], []);
      setRefItems("reference_video_urls", [], []);
      setRefItems("reference_audio_urls", [], []);
    } else {
      setRefItems("first_frame_url", [], []);
      setRefItems("last_frame_url", [], []);
    }
  };

  const removeRef = (ref: GenRef) => {
    const [field, idxRaw] = ref.id.split(":");
    const idx = Number(idxRaw);
    const urls = Array.isArray(kieValues[field]) ? [...(kieValues[field] as string[])] : [];
    const names = [...(kieRefNames[field] || [])];
    urls.splice(idx, 1);
    names.splice(idx, 1);
    setRefItems(field, urls, names);
  };

  const uploadRefFiles = async (field: KieField, files: File[]) => {
    const limit = field.max_items ?? 99;
    const urls = Array.isArray(kieValues[field.name]) ? [...(kieValues[field.name] as string[])] : [];
    const names = [...(kieRefNames[field.name] || [])];
    const room = Math.max(0, limit - urls.length);
    const batch = files.slice(0, room);
    if (batch.length === 0) {
      toast.error(`Лимит: ${field.label} — ${limit}`);
      return;
    }
    setRefBusyField(field.name);
    try {
      for (const f of batch) {
        const prepared = await shrinkImageForUpload(f);
        const uploaded = await api.kieUpload(prepared);
        urls.push(uploaded.url);
        names.push(f.name);
      }
      setRefItems(field.name, urls, names);
      toast.success(`${field.label}: добавлено ${batch.length}`);
    } catch (err) {
      toast.error(errorMessageFromUnknown(err));
    } finally {
      setRefBusyField(null);
    }
  };

  const pickRefFiles = (field: KieField) => {
    pendingRefFieldRef.current = field;
    const input = refFileInputRef.current;
    if (!input) return;
    input.accept =
      field.kind === "videos"
        ? "video/mp4,video/quicktime,video/webm"
        : field.kind === "audios"
          ? "audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
          : "image/png,image/jpeg,image/webp,image/gif";
    input.click();
  };

  // ---- меню «@» в поле промта ----
  const mentionCandidates = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    if (!q) return mentionRefs;
    return mentionRefs.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        refToken(r.name).toLowerCase().includes(q) ||
        REF_KIND_LABEL[r.kind].toLowerCase().includes(q),
    );
  }, [mentionRefs, mentionQuery]);

  const syncMention = (text: string, caret: number | null) => {
    const pos = caret ?? text.length;
    const before = text.slice(0, pos);
    const match = /(^|\s)@([\wа-яёА-ЯЁ-]*)$/.exec(before);
    if (!match || mentionRefs.length === 0) {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    setMentionQuery(match[2] || "");
    setMentionIndex(0);
    setMentionOpen(true);
  };

  const insertMention = (ref: GenRef) => {
    const textarea = promptTextareaRef.current;
    const pos = textarea?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, pos);
    const match = /(^|\s)@([\wа-яёА-ЯЁ-]*)$/.exec(before);
    const token = `@${refToken(ref.name)}`;
    let nextPrompt: string;
    let caret: number;
    if (match) {
      const tokenStart = pos - (match[2]?.length ?? 0) - 1;
      nextPrompt = `${prompt.slice(0, tokenStart)}${token} ${prompt.slice(pos)}`;
      caret = tokenStart + token.length + 1;
    } else {
      const spacer = prompt.length > 0 && !prompt.endsWith(" ") ? " " : "";
      nextPrompt = `${prompt}${spacer}${token} `;
      caret = nextPrompt.length;
    }
    setPrompt(nextPrompt);
    setMentionOpen(false);
    setMentionQuery("");
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    });
  };


  const videoCapabilities = useMemo(() => {
    if (mediaType !== "video") {
      return { supportsFirst: false, supportsLast: false, supportsRefs: false, maxRefs: 0 };
    }
    if (kieActive && kieModel) {
      const fieldNames = new Set(kieModel.fields.map((f) => f.name));
      const hasFirst = fieldNames.has("first_frame_url") || fieldNames.has("first_frame");
      const hasLast = fieldNames.has("last_frame_url") || fieldNames.has("last_frame");
      const multiImg = kieModel.fields.find(
        (f) =>
          f.kind === "images" ||
          ["image_urls", "imageUrls", "images", "image_input"].includes(f.name),
      );
      const multiMax = multiImg?.max_items || 1;

      const supportsFirst = hasFirst || Boolean(multiImg);
      const supportsLast = hasLast || (Boolean(multiImg) && multiMax >= 2);
      const refField = kieModel.fields.find(
        (f) =>
          f.name === "reference_image_urls" ||
          f.name === "reference_images" ||
          (f.name === "imageUrls" && f.max_items && f.max_items > 2),
      );
      const supportsRefs = Boolean(refField);
      const maxRefs = refField?.max_items || 0;
      return { supportsFirst, supportsLast, supportsRefs, maxRefs };
    }
    if (activeSlug === "seedance-2-0-mini" || activeSlug === "seedance_2_0_mini") {
      return { supportsFirst: true, supportsLast: true, supportsRefs: true, maxRefs: 9 };
    }
    // Outsee video (veo-3-1-lite): поддерживает только стартовый кадр
    return {
      supportsFirst: videoModel.chips.includes("image-input"),
      supportsLast: false,
      supportsRefs: false,
      maxRefs: 0,
    };
  }, [mediaType, activeSlug, kieActive, kieModel, videoModel]);

  const maxReferences = useMemo(() => {
    if (mediaType === "image") {
      if (kieActive && kieModel) {
        const refField = kieModel.fields.find(
          (f) =>
            f.kind === "images" ||
            ["image_urls", "image_input", "imageUrls", "images", "image_url", "imageUrl"].includes(f.name),
        );
        if (refField) return refField.max_items || (refField.kind === "images" ? 8 : 1);
        return 0;
      }
      return 8; // Outsee Image (GPT Image 2, Nano Banana 2)
    }
    if (mediaType === "video") {
      return videoCapabilities.maxRefs;
    }
    return 0;
  }, [mediaType, activeSlug, kieActive, kieModel, videoCapabilities.maxRefs]);

  /**
   * Outsee-модели (не KIE) тоже рисуем квадратными плитками в новом дизайне:
   * кадры + мульти-референсы берём из старых состояний и мапим в GenRef.
   */
  const legacyTileRefs = useMemo<GenRef[]>(() => {
    const out: GenRef[] = [];
    if (firstFrameDataUrl) {
      out.push({
        id: "legacy:first",
        field: "legacy_first",
        url: firstFrameDataUrl,
        name: firstFrameName || "Первый кадр",
        kind: "image",
        categoryIndex: 1,
        categoryMax: 1,
      });
    }
    if (lastFrameDataUrl) {
      out.push({
        id: "legacy:last",
        field: "legacy_last",
        url: lastFrameDataUrl,
        name: lastFrameName || "Последний кадр",
        kind: "image",
        categoryIndex: 1,
        categoryMax: 1,
      });
    }
    referenceImages.forEach((r, i) => {
      out.push({
        id: `legacy:${r.id}`,
        field: "legacy_images",
        url: r.url,
        name: r.name || `Референс ${i + 1}`,
        kind: "image",
        categoryIndex: i + 1,
        categoryMax: Math.max(1, maxReferences),
      });
    });
    return out;
  }, [firstFrameDataUrl, firstFrameName, lastFrameDataUrl, lastFrameName, referenceImages, maxReferences]);

  const legacyTilesActive =
    !kieTilesActive &&
    (maxReferences > 0 ||
      (mediaType === "video" && (videoCapabilities.supportsFirst || videoCapabilities.supportsLast)));
  const tilesActive = kieTilesActive || legacyTilesActive;

  /** Удаление референса Outsee-модели: кадры и мульти-рефы живут в разных стейтах. */
  const removeLegacyRef = (ref: GenRef) => {
    if (ref.field === "legacy_first") {
      setFirstFrameDataUrl(null);
      setFirstFrameName(null);
      return;
    }
    if (ref.field === "legacy_last") {
      setLastFrameDataUrl(null);
      setLastFrameName(null);
      return;
    }
    const id = ref.id.replace(/^legacy:/, "");
    setReferenceImages((prev) => {
      const victim = prev.find((r) => r.id === id);
      if (victim) revokeRefUrl(victim.url);
      return prev.filter((r) => r.id !== id);
    });
  };

  const isVideoConflict = useMemo(() => {
    if (mediaType !== "video") return false;
    const hasFrames = Boolean(firstFrameDataUrl || lastFrameDataUrl);
    const hasRefs = referenceImages.length > 0;
    return hasFrames && hasRefs;
  }, [mediaType, firstFrameDataUrl, lastFrameDataUrl, referenceImages.length]);

  const kiePrice = useMemo(() => {
    if (!kieModel || !kieCatalogQ.data) return null;
    const vals = { ...kieValues };
    if (kieTextField) vals[kieTextField] = prompt;
    return estimateKie(kieModel, vals, kieCatalogQ.data.credit_usd);
  }, [kieModel, kieValues, prompt, kieTextField, kieCatalogQ.data]);

  useEffect(() => {
    // Сохраняем совместимые поля при смене модели KIE
    setKieValues((prev) => {
      const next: Record<string, unknown> = {};
      if (prev.aspect_ratio) next.aspect_ratio = prev.aspect_ratio;
      if (prev.resolution) next.resolution = prev.resolution;
      if (prev.quality) next.quality = prev.quality;
      return next;
    });
  }, [activeSlug]);

  // Трим каталога Create: outsee — только GPT Image 2 / Nano Banana 2 /
  // Veo 3.1 Lite; аудио — только KIE (Suno/ElevenLabs не дублируются).
  useEffect(() => {
    if (!kieCatalogQ.data) return;
    const isKie = (s: string) => kieModels.some((m) => `kie:${m.id}` === s);
    if (
      mediaType === "image" &&
      !isKie(imageSlug) &&
      !["gpt-image-2", "nano-banana-2"].includes(imageSlug)
    ) {
      setImageSlug("gpt-image-2");
    }
    if (mediaType === "video" && !isKie(videoSlug) && videoSlug !== "veo-3-1-lite") {
      setVideoSlug("veo-3-1-lite");
    }
    if (mediaType === "audio" && !isKie(audioSlug)) {
      setAudioSlug(
        audioSlug === "suno-5-5"
          ? "kie:suno-music"
          : audioSlug === "elevenlabs-v4" || audioSlug === "elevenlabs-v3"
            ? "kie:elevenlabs-v4"
            : "kie:suno-music",
      );
    }
  }, [kieCatalogQ.data, kieModels, mediaType, imageSlug, videoSlug, audioSlug]);

  const currentName = kieActive
    ? (kieModel.label ?? kieModel.id)
    : mediaType === "image"
      ? imageModel.displayName
      : mediaType === "video"
        ? videoModel.displayName
        : audioModel.displayName;
  const currentWired = false;
  const outseeConfigured = Boolean(outseeStatusQ.data?.configured);
  const kieConfigured = Boolean(kieCatalogQ.data?.configured);
  const elevenlabsConfigured = Boolean(
    (kieCatalogQ.data as Record<string, unknown> | undefined)?.elevenlabs_configured ??
    (kieCatalogQ.data as Record<string, unknown> | undefined)?.wavespeed_configured,
  );
  const isElevenLabsActive =
    kieModel?.id === "elevenlabs-v4" ||
    activeSlug === "elevenlabs-v4" ||
    activeSlug === "kie:elevenlabs-v4";

  /** Дефолтный voice_id из каталога — показываем «Marina», даже если в состоянии пусто. */
  const elevenLabsVoiceId = useMemo(() => {
    const raw = String(kieValues["voice_id"] ?? "").trim();
    if (raw) return raw;
    const def = kieModel?.fields.find((f) => f.name === "voice_id")?.default;
    return def == null ? "" : String(def);
  }, [kieValues, kieModel]);

  /** Имя выбранного голоса для чипа дока и панели («Marina (Ж)»). */
  const voiceChipName = useMemo(() => {
    const ru = getVoiceById(elevenLabsVoiceId);
    if (ru) return `${ru.name} (${ru.gender === "female" ? "Ж" : "М"})`;
    return resolveVoiceName(elevenLabsVoiceId) || elevenLabsVoiceId || "Голос";
  }, [elevenLabsVoiceId]);

  const autoProvider: "outsee" | null = useMemo(() => {
    if (kieActive) return null;
    if (mediaType === "audio") return null;
    if (outseeConfigured) return "outsee";
    return null;
  }, [kieActive, mediaType, outseeConfigured]);

  const maxParallel =
    autoProvider === "outsee"
      ? (createQueueQ.data?.max_parallel_outsee ?? 5)
      : (createQueueQ.data?.max_parallel ?? 5);

  const canApiDirect = kieActive
    ? (isElevenLabsActive ? elevenlabsConfigured : kieConfigured)
    : autoProvider != null;
  const currentIcon = kieActive && kieModel
    ? modelIconForId(kieModel.id)
    : modelIconForId(
        activeSlug,
        mediaType === "image"
          ? imageModel.icon
          : mediaType === "video"
            ? videoModel.icon
            : audioModel.icon,
      );
  const currentCatalogPrice =
    mediaType === "image"
      ? imageModel.price
      : mediaType === "video"
        ? videoModel.price
        : audioModel.price;

  const basePriceLabel = kieActive
    ? kiePrice
      ? `$${kiePrice.usd.toFixed(3)} · ${kiePrice.credits} кр`
      : "—"
    : estimateCreatePrice({
        media: mediaType,
        model: activeSlug,
        resolution,
        duration: Number(duration) || 10,
        size: soraSize,
        catalogPrice: currentCatalogPrice,
      }).label;

  const priceLabel = useMemo(() => {
    if ((mediaType === "image" || mediaType === "video") && batchCount > 1) {
      if (kieActive && kiePrice) {
        return `$${(kiePrice.usd * batchCount).toFixed(3)} · ${kiePrice.credits * batchCount} кр`;
      }
      return `${basePriceLabel} (x${batchCount})`;
    }
    return basePriceLabel;
  }, [basePriceLabel, mediaType, batchCount, kieActive, kiePrice]);

  useEffect(() => {
    if (mediaType === "image") {
      const aspects = chipOptions(imageSlug, "aspect");
      const resolutions = chipOptions(imageSlug, "resolution");
      if (aspects.length) setAspect((a) => clampToOptions(a, aspects, "16:9"));
      if (resolutions.length) setResolution((r) => clampToOptions(r, resolutions, "2K"));
      return;
    }
    if (mediaType === "video") {
      const aspects = chipOptions(videoSlug, "aspect");
      const resolutions = chipOptions(videoSlug, "resolution");
      const durations = chipOptions(videoSlug, "duration");
      if (aspects.length) setAspect((a) => clampToOptions(a, aspects, "16:9"));
      if (resolutions.length) {
        setVideoResolution((r) => clampToOptions(r, resolutions, resolutions[0]));
      }
      if (durations.length) {
        setDuration((d) => clampToOptions(d, durations, durations[0]));
      }
    }
  }, [imageSlug, videoSlug, mediaType]);

  const applyFrameFromHistory = async (item: HistoryItem, slot: "first" | "last") => {
    // Предпочитаем публичный raw_url (Outsee CDN) — data:/local Outsee игнорит.
    const httpUrl = item.raw_url && item.raw_url.startsWith("http") ? item.raw_url : null;
    if (httpUrl) {
      if (slot === "first") {
        setFirstFrameDataUrl(httpUrl);
        setFirstFrameName(item.label || "история");
      } else {
        setLastFrameDataUrl(httpUrl);
        setLastFrameName(item.label || "история");
      }
      toast.success(slot === "first" ? "Стартовый кадр из истории" : "Конечный кадр из истории");
      return;
    }
    if (!item.preview_url) {
      toast.error("Нет URL картинки для кадра");
      return;
    }
    try {
      const res = await fetch(item.preview_url);
      const blob = await res.blob();
      if (!assertFrameBlob(res, blob)) return;
      const file = new File([blob], `${item.id}.png`, { type: blob.type || "image/png" });
      const dataUrl = await readFileAsDataUrl(file);
      if (slot === "first") {
        setFirstFrameDataUrl(dataUrl);
        setFirstFrameName(item.label || item.id);
      } else {
        setLastFrameDataUrl(dataUrl);
        setLastFrameName(item.label || item.id);
      }
      toast.success(slot === "first" ? "Стартовый кадр" : "Конечный кадр");
    } catch {
      toast.error("Не удалось взять кадр из истории");
    }
  };

  const appendReferences = (candidates: RefImage[]) => {
    const next = [...referenceImagesRef.current];
    let added = 0;
    for (const candidate of candidates) {
      const duplicate = next.some((ref) =>
        (candidate.sourceKey && ref.sourceKey === candidate.sourceKey) || ref.url === candidate.url,
      );
      if (duplicate || next.length >= maxReferences) {
        revokeRefUrl(candidate.url);
        continue;
      }
      next.push(candidate);
      added += 1;
    }
    // Reserve slots immediately: concurrent history downloads must see each other.
    referenceImagesRef.current = next;
    setReferenceImages(next);
    if (added) toast.success(`Добавлено ${added} референс(ов)`);
    else toast.info("Референс уже добавлен или достигнут лимит");
  };

  const addReferenceFromHistory = async (item: HistoryItem) => {
    if (maxReferences <= 0) return;
    if (referenceImages.length >= maxReferences) {
      toast.error(`Достигнут лимит референсов (${maxReferences})`);
      return;
    }
    const httpUrl = item.raw_url && item.raw_url.startsWith("http") ? item.raw_url : null;
    if (httpUrl) {
      appendReferences([{
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        url: httpUrl,
        name: item.label || "история",
        sourceKey: `history:${item.path || httpUrl || item.id}`,
      }]);
      return;
    }
    if (!item.preview_url) {
      toast.error("Нет URL картинки для референса");
      return;
    }
    try {
      const res = await fetch(item.preview_url);
      const blob = await res.blob();
      if (!assertFrameBlob(res, blob)) return;
      const file = new File([blob], `${item.id}.png`, { type: blob.type || "image/png" });
      appendReferences([{
        ...makeRefFromFile(file),
        sourceKey: `history:${item.path || item.preview_url || item.id}`,
      }]);
    } catch {
      toast.error("Не удалось взять референс из истории");
    }
  };

  const addReferenceFiles = (files: File[]) => {
    if (maxReferences <= 0) {
      toast.error("Эта модель не принимает референсы");
      return;
    }
    const remaining = maxReferences - referenceImages.length;
    if (remaining <= 0) {
      toast.error(`Достигнут лимит референсов (${maxReferences})`);
      return;
    }
    const newRefs = files.map((file) => ({
      ...makeRefFromFile(file),
      sourceKey: `file:${file.name}:${file.size}:${file.lastModified}:${file.type}`,
    }));
    if (!newRefs.length) return;
    appendReferences(newRefs);
  };

  const applyModelDefaults = (slug: string, kind: OutseeMediaType) => {
    if (kind === "image") {
      const m = getImageModel(slug);
      const d = m.defaults;
      const aspects = chipOptions(slug, "aspect");
      const resolutions = chipOptions(slug, "resolution");
      if (aspects.length) {
        setAspect((current) => clampToOptions(current, aspects, d.aspectRatio || "16:9"));
      }
      if (resolutions.length) {
        setResolution((current) => clampToOptions(current, resolutions, d.imageResolution || "2K"));
      }
      if (m.chips.includes("detail")) {
        setDetail((current) => current || d.detailLevel || "medium");
      }
      return;
    }
    if (kind === "audio") {
      return;
    }
    const m = getVideoModel(slug);
    const d = m.defaults;
    const aspects = chipOptions(slug, "aspect");
    const resolutions = chipOptions(slug, "resolution");
    const durations = chipOptions(slug, "duration");
    if (aspects.length) {
      setAspect((current) => clampToOptions(current, aspects, d.aspectRatio || "16:9"));
    }
    if (resolutions.length) {
      setVideoResolution((current) => clampToOptions(current, resolutions, d.resolution || resolutions[0]));
    }
    if (durations.length) {
      setDuration((current) => clampToOptions(current, durations, d.duration != null ? String(d.duration) : durations[0]));
    }
    if (m.chips.includes("quality")) {
      setMotionQuality((current) => current || d.motionQuality || "std");
    }
    // Сохраняем вложения и референсы пользователя при смене моделей!
  };

  const settingsPayload = (): Record<string, unknown> => ({
    media_type: mediaType,
    image_slug: imageSlug,
    video_slug: videoSlug,
    audio_slug: audioSlug,
    aspect,
    image_resolution: resolution,
    image_quality: detail,
    image_relax: false,
    video_resolution: videoResolution,
    video_relax: false,
    duration,
    generate_audio: generateAudio,
    orientation,
    motion_quality: motionQuality,
    instrumental,
    prompt,
    image_provider: "outsee",
    video_provider: "outsee",
    sora_size: soraSize,
  });

  const saveGlobal = useMutation({
    mutationFn: () => api.putOutseeCreateSettings(settingsPayload()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outsee-create-settings"] });
      toast.success("Глобальные настройки Create сохранены");
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const applyToProject = useMutation({
    mutationFn: async () => {
      if (projectId == null) throw new Error("Выберите проект слева");
      await api.putOutseeCreateSettings(settingsPayload());
      const body: Record<string, unknown> = {};
      const imgStudio = slugToStudioId(imageSlug, "image");
      const vidStudio = slugToStudioId(videoSlug, "video");
      if (imgStudio) {
        body.image_generator = imgStudio;
        body.aspect_ratio = aspect.replace(":", "_");
        body.image_resolution = resolution.toLowerCase();
        if (imageModel.chips.includes("detail")) body.image_quality = detail;
        body.image_relax = false;
      }
      if (vidStudio) {
        body.video_generator = vidStudio;
        const vr = videoResolution.toLowerCase();
        if (vr === "720p" || vr === "1080p") body.video_resolution = vr;
        body.video_relax = false;
      }
      return api.patchProject(projectId, body);
    },
    onSuccess: () => {
      if (projectId != null) qc.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success("Настройки применены к проекту");
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const deleteItem = useMutation({
    mutationFn: (item: HistoryItem) =>
      api.deleteOutseeCreateHistoryItem({
        path: item.path || undefined,
        itemId: item.id || undefined,
        jobId: item.job_id || undefined,
      }),
    onSuccess: (_, item) => {
      toast.success("Удалено из истории");
      if (selectedId === item.id || (item.job_id && selectedId === item.job_id)) {
        setSelectedId(null);
      }
      setTrackingJobs((prev) =>
        prev.filter((x) => x.jobId !== item.job_id && x.historyId !== item.id),
      );
      qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
      qc.invalidateQueries({ queryKey: ["create-queue"] });
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const cancelJobMut = useMutation({
    mutationFn: (jobId: string) => api.cancelCreateJob(jobId),
    onSuccess: () => {
      toast.success("Генерация остановлена");
      qc.invalidateQueries({ queryKey: ["create-queue"] });
      qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
    },
    onError: (e) => toast.error(errorMessageFromUnknown(e)),
  });

  const unknownCountRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!trackingJobs.length) return;
    let cancelled = false;
    const tick = async () => {
      for (const t of [...trackingJobs]) {
        try {
          const job = await api.createJob(t.jobId);
          if (cancelled) return;
          qc.invalidateQueries({ queryKey: ["create-queue"] });
          if (job.status === "done") {
            unknownCountRef.current.delete(t.jobId);
            const took =
              job.elapsed_label ||
              (job.elapsed_sec != null ? formatElapsedMinSec(job.elapsed_sec) : null);
            toast.success(
              took
                ? `Готово · ${job.model || "файл"} · ${took}`
                : `Готово · ${job.model || "файл"}`,
            );
            if (job.history_id) setSelectedId(job.history_id);
            setTrackingJobs((prev) => prev.filter((x) => x.jobId !== t.jobId));
            qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
          } else if (job.status === "failed") {
            unknownCountRef.current.delete(t.jobId);
            const took =
              job.elapsed_label ||
              (job.elapsed_sec != null ? formatElapsedMinSec(job.elapsed_sec) : null);
            const friendlyError = humanizeErrorMessage(job.error) || "Генерация не удалась";
            toast.error(
              took
                ? `${friendlyError} · ${took}`
                : friendlyError,
            );
            setTrackingJobs((prev) => prev.filter((x) => x.jobId !== t.jobId));
            qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
          } else if (job.status === "unknown") {
            // Задача не найдена в памяти сервера — проверяем историю на случай, если она уже завершена на диске
            const currentHistory = historyQ.data ?? [];
            const matched = currentHistory.find(
              (h) => h.id === t.historyId || h.job_id === t.jobId,
            );
            if (matched && matched.status === "done") {
              unknownCountRef.current.delete(t.jobId);
              toast.success(`Готово · ${matched.model || "файл"}`);
              if (t.historyId) setSelectedId(t.historyId);
              setTrackingJobs((prev) => prev.filter((x) => x.jobId !== t.jobId));
              qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
            } else if (matched && matched.status === "failed") {
              unknownCountRef.current.delete(t.jobId);
              toast.error(humanizeErrorMessage(matched.error) || "Генерация не удалась");
              setTrackingJobs((prev) => prev.filter((x) => x.jobId !== t.jobId));
              qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
            } else {
              const count = (unknownCountRef.current.get(t.jobId) || 0) + 1;
              unknownCountRef.current.set(t.jobId, count);
              if (count >= 6) {
                unknownCountRef.current.delete(t.jobId);
                setTrackingJobs((prev) => prev.filter((x) => x.jobId !== t.jobId));
                qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
              }
            }
          } else {
            // Задача в процессе или очереди — сбрасываем счетчик неизвестных
            unknownCountRef.current.delete(t.jobId);
          }
        } catch {
          /* job may not be ready yet */
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [trackingJobs, qc, historyQ.data]);

  const handleRandomPrompt = () => {
    const available = RANDOM_PROMPTS.filter((p) => p !== prompt);
    const chosen = available[Math.floor(Math.random() * available.length)];
    setPrompt(chosen);
    toast.success("Случайный промпт подставлен 🎲");
  };

  /**
   * Двойной клик по картинке в истории: применить её конфигурацию
   * (модель / формат / разрешение / детализация из sidecar-params + промпт)
   * к окну и открыть панель «Помощник» с этим промптом.
   */
  const applyHistoryConfig = (item: HistoryItem) => {
    if (item.kind !== "image") return;
    const p = (item.params ?? {}) as Record<string, unknown>;
    const rawModel = item.model ? String(item.model) : "";
    const candidates = [rawModel, slugToStudioId(rawModel, "image") ?? ""];
    const slug = candidates.find((c) => c && chipOptions(c, "aspect").length > 0);
    const effSlug = slug ?? imageSlug;
    if (slug && slug !== imageSlug) setImageSlug(slug);
    if (typeof p.aspect === "string" && p.aspect) {
      setAspect(clampToOptions(p.aspect, chipOptions(effSlug, "aspect"), aspect));
    }
    if (typeof p.resolution === "string" && p.resolution) {
      setResolution(clampToOptions(p.resolution, chipOptions(effSlug, "resolution"), resolution));
    }
    if (typeof p.detail_level === "string" && p.detail_level) {
      const dOpts = chipOptions(effSlug, "detail");
      if (dOpts.length) setDetail(clampToOptions(p.detail_level, dOpts, detail));
    }
    if (item.prompt) {
      setPrompt(item.prompt);
      setAppliedPrompt({ text: item.prompt, ts: Date.now() });
    }
    setAssistantOpen(true);
    toast.success("Конфигурация изображения применена к панели снизу");
  };

  const handleEnhancePrompt = async () => {
    const text = prompt.trim();
    if (!text) {
      toast.error("Сначала напишите краткую идею в поле ввода");
      return;
    }
    setIsEnhancingPrompt(true);
    try {
      const res = await api.enhanceOutseeCreatePrompt({
        prompt: text,
      });
      if (res?.enhanced_prompt) {
        setPrompt(res.enhanced_prompt);
        toast.success("Промпт улучшен ИИ ✨");
      }
    } catch {
      toast.error("Не удалось улучшить промпт");
    } finally {
      setIsEnhancingPrompt(false);
    }
  };

  const createGenerate = useMutation({
    mutationFn: async (
      arg?:
        | string
        | {
            prompt?: string;
            aspect?: string;
            negativePrompt?: string;
            forceSingle?: boolean;
            draftId?: string;
            retryItem?: HistoryItem;
          },
    ) => {
      // forceSingle — помощник промптов: ровно 1 картинка на каждый промпт агента,
      // без умножения на batchCount.
      const retry = typeof arg === "object" ? arg?.retryItem : undefined;
      const promptOverride = typeof arg === "string" ? arg : (arg?.prompt ?? retry?.prompt ?? undefined);
      const forceSingle = (typeof arg === "object" && arg?.forceSingle === true) || Boolean(retry);
      const draftId = typeof arg === "object" ? arg?.draftId : undefined;
      let text = (promptOverride ?? prompt).trim();
      if (!text) throw new Error("Введите промпт");
      if (text.toLowerCase().includes("not example objects from the style guide")) {
        throw new Error("Промпт не собран агентом — генерация не запущена");
      }
      const targetMediaType: OutseeMediaType = retry
        ? ((retry.kind as OutseeMediaType) || "image")
        : mediaType;
      if (
        targetMediaType === "video" &&
        (firstFrameDataUrl || lastFrameDataUrl) &&
        referenceImages.length > 0 &&
        !retry
      ) {
        toast.error(
          "В видео нельзя совмещать переход по кадрам (старт/финиш) и референсы. Выберите один режим выше.",
        );
        throw new Error(
          "Видеомодели не поддерживают одновременное совмещение перехода по кадрам (старт/финиш) и референсов. Выберите один режим.",
        );
      }
      const targetNegativePrompt =
        typeof arg === "object" && typeof arg?.negativePrompt === "string"
          ? arg.negativePrompt
          : negativePrompt;
      // Стиль из «Вдохновения» — как в старом доке: дописываем ядро стиля к промпту фото.
      const styleSuffix = retry ? "" : inspirationPromptSuffix(activeStyle);
      if (text && targetMediaType === "image" && styleSuffix) {
        text += styleSuffix;
      }
      if (text && targetMediaType === "image" && targetNegativePrompt.trim() && !retry) {
        text += `\nAvoid: ${targetNegativePrompt.trim()}`;
      }
      const refUrls = await resolveReferenceUrls(referenceImages);

      const executeSingle = async (index: number) => {
        const nonce = `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
        const retryParams = (retry?.params ?? {}) as Record<string, unknown>;
        const rawModel = retry?.model ? String(retry.model) : "";
        const paramModelId = typeof retryParams.model_id === "string" ? retryParams.model_id : "";

        const targetAspect =
          typeof retryParams.aspect_ratio === "string" && retryParams.aspect_ratio
            ? retryParams.aspect_ratio
            : typeof retryParams.aspect === "string" && retryParams.aspect
              ? retryParams.aspect
              : (typeof arg === "object" && arg?.aspect ? arg.aspect : aspect);
        const targetResolution =
          typeof retryParams.resolution === "string" && retryParams.resolution
            ? retryParams.resolution
            : targetMediaType === "video"
              ? videoResolution
              : resolution;

        let normalizedModel = rawModel;
        if (!normalizedModel) {
          normalizedModel =
            targetMediaType === "image"
              ? imageSlug
              : targetMediaType === "video"
                ? videoSlug
                : audioSlug;
        }
        if (normalizedModel === "suno-5-5") normalizedModel = "kie:suno-music";
        if (normalizedModel === "elevenlabs-v4" || normalizedModel === "elevenlabs-v3") normalizedModel = "kie:elevenlabs-v4";

        const matchedKie =
          kieModels.find(
            (m) =>
              m.id === paramModelId ||
              `kie:${m.id}` === normalizedModel ||
              m.id === normalizedModel ||
              m.label.toLowerCase() === normalizedModel.toLowerCase(),
          ) ||
          (retry?.provider === "kie" || retry?.project_slug === "kie"
            ? kieModels.find((m) => m.id === paramModelId)
            : null);

        // ---- KIE: динамическая модель из каталога kie.ai ----
        const isKie =
          targetMediaType === "audio" ||
          Boolean(matchedKie) ||
          normalizedModel.startsWith("kie:") ||
          Boolean(retryParams.model_id) ||
          retry?.provider === "kie" ||
          retry?.project_slug === "kie" ||
          (Boolean(kieActive && kieModel) && !retry);
        if (isKie) {
          const effectiveKieModel =
            matchedKie ??
            (normalizedModel.startsWith("kie:") ? kieModels.find((m) => m.id === normalizedModel.slice(4)) : null) ??
            kieModel ??
            (targetMediaType === "audio" ? kieModels.find((m) => m.id === "suno-music") : null);
          const modelId =
            effectiveKieModel?.id ||
            paramModelId ||
            (normalizedModel.startsWith("kie:") ? normalizedModel.slice(4) : null) ||
            kieModel?.id ||
            (targetMediaType === "audio" ? "suno-music" : null);
          if (!modelId) {
            throw new Error("Не удалось определить модель KIE");
          }

          const isElevenLabs =
            modelId === "elevenlabs-v4" ||
            normalizedModel === "kie:elevenlabs-v4" ||
            effectiveKieModel?.id === "elevenlabs-v4";
          if (isElevenLabs) {
            if (!elevenlabsConfigured) {
              throw new Error("ELEVENLABS_API_KEY не задан в Настройках или .env");
            }
          } else if (!kieConfigured) {
            throw new Error("KIE_API_KEY не задан в .env");
          }
          const storedVals = (retryParams.values && typeof retryParams.values === "object"
            ? retryParams.values
            : retryParams) as Record<string, unknown>;
          const vals: Record<string, unknown> = retry
            ? { ...storedVals, _nonce: nonce }
            : { ...kieValues, _nonce: nonce };
          delete vals.model_id;
          delete vals.values;

          const textField = effectiveKieModel ? kieMainTextField(effectiveKieModel) : kieTextField;
          if (textField) vals[textField] = text;
          else if (retry) {
            const pField = Object.keys(vals).find((k) => k.toLowerCase().includes("prompt")) || "prompt";
            vals[pField] = text;
          }
          if (targetNegativePrompt.trim() && !retry) {
            const negField = (effectiveKieModel || kieModel)?.fields.find((f) =>
              f.name.toLowerCase().includes("neg"),
            );
            if (negField) vals[negField.name] = targetNegativePrompt.trim();
          }

          // Синхронизация чипов (соотношение сторон, разрешение, качество) в поля модели KIE
          const kieFields = (effectiveKieModel || kieModel)?.fields || [];
          const aspectField = kieFields.find(
            (f) =>
              f.name === "aspect_ratio" ||
              f.name === "aspect" ||
              f.name.toLowerCase().includes("aspect"),
          );
          if (aspectField) {
            const aspectToSet = !retry ? targetAspect : (vals[aspectField.name] || targetAspect);
            if (aspectToSet) {
              const strVal = String(aspectToSet);
              if (!aspectField.options || aspectField.options.includes(strVal)) {
                vals[aspectField.name] = strVal;
              } else {
                const match = aspectField.options.find(
                  (o) =>
                    o.toLowerCase() === strVal.toLowerCase() ||
                    o.replace("_", ":") === strVal.replace("_", ":") ||
                    o.replace(":", "_") === strVal.replace(":", "_"),
                );
                vals[aspectField.name] = match || strVal;
              }
            }
          } else if (targetAspect) {
            vals["aspect_ratio"] = targetAspect.includes(":") ? targetAspect : targetAspect.replace("_", ":");
          }

          const qualityField = kieFields.find((f) => f.name === "quality");
          if (qualityField && qualityField.options) {
            if (!retry) {
              if (targetResolution === "2K" || targetResolution === "4K" || detail === "high") {
                if (qualityField.options.includes("high")) vals["quality"] = "high";
              } else if (targetResolution === "1K" || detail === "basic") {
                if (qualityField.options.includes("basic")) vals["quality"] = "basic";
              }
            }
          }
          const resField = kieFields.find(
            (f) => f.name === "resolution" || f.name === "target_resolution",
          );
          if (resField && resField.options) {
            const resToSet = !retry ? targetResolution : (vals[resField.name] || targetResolution);
            if (resToSet) {
              const strRes = String(resToSet);
              const match = resField.options.find(
                (o) => o.toLowerCase() === strRes.toLowerCase(),
              );
              if (match) vals[resField.name] = match;
            }
          }

          if (modelId === "suno-music") {
            const isInst = Boolean(vals.instrumental ?? instrumental);
            vals.instrumental = isInst;
            const isCustom = vals.customMode !== false;
            if (!vals.style || typeof vals.style !== "string" || !vals.style.trim()) {
              vals.style = text.slice(0, 500);
            }
            if (!vals.title || typeof vals.title !== "string" || !vals.title.trim()) {
              vals.title = text.slice(0, 80);
            }
            if (isInst) {
              vals.prompt = isCustom ? "" : text;
            } else if (!vals.prompt) {
              vals.prompt = text;
            }
          }

          // Автоматическая передача референсов, стартовых и конечных кадров в поля модели KIE
          const kieFirstFrame = retry?.first_frame_url || firstFrameDataUrl || null;
          const kieLastFrame =
            (typeof retryParams.last_frame_url === "string" ? retryParams.last_frame_url : undefined) ||
            lastFrameDataUrl ||
            null;
          const hasFrames = Boolean(kieFirstFrame || kieLastFrame);
          const kieRefs =
            hasFrames && targetMediaType === "video"
              ? []
              : retry?.reference_images && retry.reference_images.length > 0
                ? retry.reference_images
                : refUrls;

          if (effectiveKieModel) {
            const fields = effectiveKieModel.fields || [];
            const fieldNames = new Set(fields.map((f) => f.name));

            // 1. Модели с отдельными полями первого кадра, последнего кадра или референсов (напр. Seedance 2.0 / 2.5)
            const hasExplicitFirst = fieldNames.has("first_frame_url") || fieldNames.has("first_frame");
            const hasExplicitLast = fieldNames.has("last_frame_url") || fieldNames.has("last_frame");
            const hasExplicitRefs = fieldNames.has("reference_image_urls") || fieldNames.has("reference_images");

            if (hasExplicitFirst || hasExplicitLast || hasExplicitRefs) {
              if (kieFirstFrame && hasExplicitFirst) {
                const fName = fieldNames.has("first_frame_url") ? "first_frame_url" : "first_frame";
                const fSpec = fields.find((f) => f.name === fName);
                vals[fName] = fSpec?.kind === "images" ? [kieFirstFrame] : kieFirstFrame;
              }
              if (kieLastFrame && hasExplicitLast) {
                const fName = fieldNames.has("last_frame_url") ? "last_frame_url" : "last_frame";
                const fSpec = fields.find((f) => f.name === fName);
                vals[fName] = fSpec?.kind === "images" ? [kieLastFrame] : kieLastFrame;
              }
              if (kieRefs.length > 0 && hasExplicitRefs) {
                const fName = fieldNames.has("reference_image_urls") ? "reference_image_urls" : "reference_images";
                const fSpec = fields.find((f) => f.name === fName);
                const maxItems = fSpec?.max_items || 9;
                vals[fName] = kieRefs.slice(0, maxItems);
              }
            } else {
              // 2. Модели с общим массивом изображений (Kling 3.0, Seedance 1.5 Pro, Veo 3.1)
              const multiField = fields.find(
                (f) =>
                  f.kind === "images" ||
                  ["image_urls", "imageUrls", "images", "image_input"].includes(f.name),
              );
              if (multiField) {
                const maxItems = multiField.max_items || 8;
                if (maxItems >= 2 && (kieFirstFrame || kieLastFrame)) {
                  const frames: string[] = [];
                  if (kieFirstFrame) frames.push(kieFirstFrame);
                  if (kieLastFrame) frames.push(kieLastFrame);
                  if (frames.length < maxItems && kieRefs.length > 0) {
                    const remain = maxItems - frames.length;
                    frames.push(...kieRefs.filter((r) => !frames.includes(r)).slice(0, remain));
                  }
                  vals[multiField.name] = frames.slice(0, maxItems);
                } else if (maxItems === 1) {
                  const chosen = kieFirstFrame || (kieRefs.length > 0 ? kieRefs[0] : null) || kieLastFrame;
                  if (chosen) {
                    vals[multiField.name] = [chosen];
                  }
                } else {
                  const all = [kieFirstFrame, kieLastFrame, ...kieRefs].filter(Boolean) as string[];
                  if (all.length > 0) {
                    vals[multiField.name] = all.slice(0, maxItems);
                  }
                }
              } else {
                // 3. Одиночные поля изображений (I2V: image_url, imageUrl)
                const singleField = fields.find(
                  (f) =>
                    ["image_url", "imageUrl", "image"].includes(f.name) ||
                    (f.kind === "images" && f.max_items === 1),
                );
                if (singleField) {
                  const chosen = kieFirstFrame || (kieRefs.length > 0 ? kieRefs[0] : null) || kieLastFrame;
                  if (chosen) {
                    vals[singleField.name] = chosen;
                  }
                }
              }
            }
          }
          if (hasFrames && targetMediaType === "video") {
            delete vals.reference_image_urls;
            delete vals.reference_images;
          } else if (kieRefs.length > 0 && targetMediaType === "video") {
            delete vals.first_frame_url;
            delete vals.first_frame;
            delete vals.last_frame_url;
            delete vals.last_frame;
          }
          if (effectiveKieModel) {
            const isInst = Boolean(vals.instrumental ?? instrumental);
            const missing = effectiveKieModel.fields
              .filter((f) => f.required)
              .filter((f) => kieFieldVisible(f, vals))
              .filter((f) => {
                if (f.name === "prompt" && (isInst || modelId === "suno-music")) return false;
                const v = vals[f.name] ?? f.default;
                if (v === undefined || v === null) return true;
                if (typeof v === "string") return v.trim() === "";
                if (Array.isArray(v)) return v.length === 0;
                return false;
              });
            if (missing.length) {
              throw new Error(`Заполни: ${missing.map((f) => f.label).join(", ")}`);
            }
          }
          void api.putOutseeCreateSettings(settingsPayload()).catch(() => undefined);
          const res = await api.kieGenerate({ model_id: modelId, values: vals });
          return {
            job_id: res.job.job_id,
            history_id: res.job.history_id,
            status: res.job.status,
            queue_position: res.job.queue_position,
            provider: "kie" as const,
            draftId,
          };
        }
        if (!text) throw new Error("Введите промпт");
        if (!outseeConfigured) {
          throw new Error("OUTSEE_API_KEY не задан в .env");
        }
        // Settings не блокируют enqueue: параллельные клики иначе ломаются
        // на гонке записи outsee_create_settings.json.
        void api.putOutseeCreateSettings(settingsPayload()).catch(() => undefined);

        const targetDetail =
          typeof retryParams.detail_level === "string" && retryParams.detail_level
            ? retryParams.detail_level
            : imageModel.chips.includes("detail")
              ? detail
              : undefined;
        const targetDuration =
          typeof retryParams.duration === "number"
            ? retryParams.duration
            : Number(duration) || 5;
        const targetFirstFrame = retry?.first_frame_url || firstFrameDataUrl;
        const targetLastFrame =
          (typeof retryParams.last_frame_url === "string"
            ? retryParams.last_frame_url
            : undefined) || lastFrameDataUrl;
        const targetRefs =
          retry?.reference_images && retry.reference_images.length > 0
            ? retry.reference_images
            : refUrls.length > 0
              ? refUrls
              : undefined;
        const targetModel =
          rawModel || (targetMediaType === "video" ? videoSlug : imageSlug);
        const targetProjectId = retry ? (retry.project_id ?? projectId) : projectId;

        const enqueued =
          targetMediaType === "video"
            ? await api.outseeGenerate({
                prompt: text,
                media: "video",
                model: targetModel,
                aspect: targetAspect,
                resolution: targetResolution,
                duration: targetDuration,
                generate_audio: videoModel.chips.includes("audio") ? generateAudio : null,
                first_frame_url: targetFirstFrame,
                last_frame_url: targetLastFrame,
                project_id: targetProjectId,
                nonce,
                batch_index: index,
              })
            : await api.outseeGenerate({
                prompt: text,
                media: "image",
                model: targetModel,
                aspect: targetAspect,
                resolution: targetResolution,
                detail_level: targetDetail,
                first_frame_url: targetFirstFrame,
                reference_images: targetRefs,
                project_id: targetProjectId,
                nonce,
                batch_index: index,
              });
        return { ...enqueued, provider: "outsee" as const, draftId };
      };

      const count = forceSingle
        ? 1
        : targetMediaType === "image" || targetMediaType === "video"
          ? batchCount
          : 1;
      if (count > 1) {
        const results = await Promise.all(
          Array.from({ length: count }, (_, i) => executeSingle(i))
        );
        return { batch: true, count, results, draftId };
      }
      return executeSingle(0);
    },
    onSuccess: (res) => {
      const doneDraft =
        res && typeof res === "object" && "draftId" in res
          ? (res as { draftId?: string }).draftId
          : undefined;
      if (doneDraft) {
        setDraftJobs((prev) => prev.filter((d) => d.job_id !== doneDraft));
      }
      if (res && typeof res === "object" && "batch" in res && Array.isArray((res as any).results)) {
        const batchRes = (res as any).results as any[];
        const newTrackers: { provider: "outsee" | "kie"; jobId: string; historyId: string }[] = [];
        let firstHistId: string | null = null;
        for (const r of batchRes) {
          if (r && typeof r === "object" && "job_id" in r && r.job_id) {
            if (!firstHistId && r.history_id) firstHistId = r.history_id;
            newTrackers.push({ provider: r.provider, jobId: r.job_id, historyId: r.history_id });
          }
        }
        if (firstHistId) setSelectedId(firstHistId);
        setTrackingJobs((prev) => [
          ...prev.filter((x) => !newTrackers.some((n) => n.jobId === x.jobId)),
          ...newTrackers,
        ]);
        qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
        qc.invalidateQueries({ queryKey: ["create-queue"] });
        toast.success(`Запущено ${batchRes.length} генерации 🚀`);
        return;
      }
      if (res && typeof res === "object" && "job_id" in res && res.job_id) {
        const r = res as {
          job_id: string;
          history_id: string;
          queue?: number;
          waiting_count?: number;
          running_count?: number;
          status?: string;
          queue_position?: number | null;
          provider: "outsee" | "kie";
        };
        if (r.history_id) setSelectedId(r.history_id);
        setTrackingJobs((prev) => [
          ...prev.filter((x) => x.jobId !== r.job_id),
          { provider: r.provider, jobId: r.job_id, historyId: r.history_id },
        ]);
        qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
        qc.invalidateQueries({ queryKey: ["create-queue"] });
        const wait = r.waiting_count ?? 0;
        const run = r.running_count ?? 0;
        if (r.status === "queued" || (r.queue_position != null && r.queue_position > 0)) {
          toast.message(
            `Ожидание #${r.queue_position ?? wait} · в работе ${run}/${maxParallel}`,
          );
        } else {
          toast.message(`В работе · ${run}/${maxParallel}`);
        }
        return;
      }
      toast.success("Шаг запущен");
      qc.invalidateQueries({ queryKey: ["outsee-create-history"] });
    },
    onError: (e, arg) => {
      const draftId = typeof arg === "object" ? arg?.draftId : undefined;
      if (draftId) {
        setDraftJobs((prev) => prev.filter((d) => d.job_id !== draftId));
      }
      toast.error(errorMessageFromUnknown(e));
    },
  });

  const handleRetry = (item: HistoryItem) => {
    if (!item.prompt) {
      toast.error("У этой генерации нет текста промпта");
      return;
    }
    const p = (item.params ?? {}) as Record<string, unknown>;
    const rawModel = item.model ? String(item.model) : "";
    const paramModelId = typeof p.model_id === "string" ? p.model_id : "";

    const matchedKie =
      kieModels.find(
        (m) =>
          m.id === paramModelId ||
          `kie:${m.id}` === rawModel ||
          m.id === rawModel ||
          m.label.toLowerCase() === rawModel.toLowerCase(),
      ) ||
      (item.provider === "kie" || item.project_slug === "kie"
        ? kieModels.find((m) => m.id === paramModelId)
        : null);

    if (matchedKie) {
      const isKieVideo = matchedKie.result === "video" || matchedKie.media === "video" || item.kind === "video";
      const isKieAudio = matchedKie.result === "audio" || matchedKie.media === "audio" || item.kind === "audio";
      if (isKieVideo) {
        setMediaType("video");
        setVideoSlug(`kie:${matchedKie.id}`);
      } else if (isKieAudio) {
        setMediaType("audio");
        setAudioSlug(`kie:${matchedKie.id}`);
      } else {
        setMediaType("image");
        setImageSlug(`kie:${matchedKie.id}`);
      }
      const vals = (p.values && typeof p.values === "object" ? p.values : p) as Record<string, unknown>;
      setKieValues({ ...vals });
      if (typeof vals.aspect_ratio === "string") setAspect(vals.aspect_ratio);
      if (typeof vals.resolution === "string") setResolution(vals.resolution);
      if (typeof vals.quality === "string") setDetail(vals.quality);
      setPrompt(item.prompt);
    } else if (item.kind === "image") {
      setMediaType("image");
      const candidates = [rawModel, slugToStudioId(rawModel, "image") ?? ""];
      const slug = candidates.find((c) => c && chipOptions(c, "aspect").length > 0);
      const effSlug = slug ?? imageSlug;
      if (slug && slug !== imageSlug) setImageSlug(slug);
      if (typeof p.aspect === "string" && p.aspect) {
        setAspect(clampToOptions(p.aspect, chipOptions(effSlug, "aspect"), aspect));
      }
      if (typeof p.resolution === "string" && p.resolution) {
        setResolution(clampToOptions(p.resolution, chipOptions(effSlug, "resolution"), resolution));
      }
      if (typeof p.detail_level === "string" && p.detail_level) {
        const dOpts = chipOptions(effSlug, "detail");
        if (dOpts.length) setDetail(clampToOptions(p.detail_level, dOpts, detail));
      }
      setPrompt(item.prompt);
      setAppliedPrompt({ text: item.prompt, ts: Date.now() });
    } else if (item.kind === "audio") {
      setMediaType("audio");
      const targetSlug =
        rawModel === "suno-5-5"
          ? "kie:suno-music"
          : rawModel === "elevenlabs-v3"
            ? "kie:elevenlabs-tts-multilingual"
            : rawModel.startsWith("kie:")
              ? rawModel
              : `kie:${rawModel || "suno-music"}`;
      setAudioSlug(targetSlug);
      const vals = (p.values && typeof p.values === "object" ? p.values : p) as Record<string, unknown>;
      setKieValues({ ...vals });
      if (typeof vals.instrumental === "boolean") setInstrumental(vals.instrumental);
      else if (typeof p.instrumental === "boolean") setInstrumental(p.instrumental);
      setPrompt(item.prompt);
    }
    createGenerate.mutate({ retryItem: item, forceSingle: true });
  };

  const historyItems: HistoryItem[] = useMemo(() => {
    const real = (historyQ.data as HistoryItem[] | undefined) ?? [];
    const activeFromQueue: HistoryItem[] = [];
    const seenIds = new Set<string>();
    for (const r of real) {
      if (r.id) seenIds.add(r.id);
      if (r.job_id) seenIds.add(r.job_id);
    }

    const allActive = [...runningJobs, ...waitingJobs];
    for (const j of allActive) {
      const jId = j.history_id || j.job_id;
      if (!jId || seenIds.has(jId) || (j.job_id && seenIds.has(j.job_id))) continue;
      const jobMedia = j.media || (feedKind === "video" ? "video" : feedKind === "audio" ? "audio" : "image");
      if (feedKind !== "all" && feedKind !== jobMedia) continue;
      seenIds.add(jId);
      if (j.job_id) seenIds.add(j.job_id);
      activeFromQueue.push({
        id: jId,
        kind: jobMedia as "image" | "video" | "audio",
        preview_url: (j as any).preview_url || null,
        label: j.prompt_preview || "генерация",
        project_id: null,
        project_slug: null,
        prompt: j.prompt_preview || null,
        status: (j.status as any) || "processing",
        job_id: j.job_id,
        created_at: j.created_at,
        started_at: j.started_at,
        elapsed_sec: (j as any).elapsed_sec,
        elapsed_label: (j as any).elapsed_label,
      });
    }

    return [...activeFromQueue, ...real];
  }, [historyQ.data, runningJobs, waitingJobs, feedKind]);

  const selected = useMemo(() => {
    let item: HistoryItem | null = null;
    if (!historyItems.length && !runningJobs.length && !waitingJobs.length) return null;
    if (selectedId) {
      item = historyItems.find((h) => h.id === selectedId) ?? null;
      if (!item) {
        const activeJob =
          runningJobs.find((j) => j.history_id === selectedId || j.job_id === selectedId) ||
          waitingJobs.find((j) => j.history_id === selectedId || j.job_id === selectedId);
        if (activeJob) {
          const jobMedia = activeJob.media || mediaType || "image";
          item = {
            id: activeJob.history_id || activeJob.job_id,
            path: (activeJob as any).path || undefined,
            job_id: activeJob.job_id,
            kind: jobMedia as "image" | "video" | "audio",
            preview_url: (activeJob as any).preview_url || null,
            label: activeJob.prompt_preview || "генерация",
            project_id: null,
            project_slug: null,
            prompt: activeJob.prompt_preview || null,
            status: activeJob.status || "processing",
            created_at: activeJob.created_at,
            started_at: activeJob.started_at,
            elapsed_sec: (activeJob as any).elapsed_sec,
            elapsed_label: (activeJob as any).elapsed_label,
            error: (activeJob as any).error || null,
          };
        }
      }
      if (!item) {
        item = historyItems[0] ?? null;
      }
    } else {
      item = historyItems[0] ?? null;
    }
    if (!item) return null;
    const activeJob =
      runningJobs.find((j) => j.history_id === item?.id || (item?.job_id && j.job_id === item.job_id)) ||
      waitingJobs.find((j) => j.history_id === item?.id || (item?.job_id && j.job_id === item.job_id));
    if (activeJob) {
      return {
        ...item,
        status: activeJob.status || item.status,
        created_at: activeJob.created_at || item.created_at,
        started_at: activeJob.started_at || item.started_at,
        elapsed_sec: (activeJob as any).elapsed_sec ?? item.elapsed_sec,
        elapsed_label: (activeJob as any).elapsed_label ?? item.elapsed_label,
      };
    }
    return item;
  }, [historyItems, selectedId, runningJobs, waitingJobs, mediaType]);

  // Фоновый предзагрузчик соседних кадров: когда открыто модальное окно и выбран кадр,
  // подгружаем i-1, i+1, i+2 в кэш браузера для мгновенного переключения (0 мс)
  useEffect(() => {
    if (!open || !selectedId || !historyItems.length) return;
    const idx = historyItems.findIndex((h) => h.id === selectedId);
    if (idx === -1) return;
    const candidates = [
      historyItems[idx + 1]?.preview_url,
      historyItems[idx + 2]?.preview_url,
      historyItems[idx - 1]?.preview_url,
    ].filter(Boolean) as string[];

    candidates.forEach((url) => {
      if (globalLoadedImageUrls.has(url)) return;
      const preloadImg = new Image();
      preloadImg.src = url;
      preloadImg.onload = () => {
        globalLoadedImageUrls.add(url);
      };
    });
  }, [open, selectedId, historyItems]);

  if (!open) return null;

  const TypeIcon = ({ id }: { id: OutseeMediaType }) => {
    if (id === "video") return <Video className="h-4 w-4" strokeWidth={1.7} />;
    if (id === "audio") return <Music className="h-4 w-4" strokeWidth={1.7} />;
    return <ImageIcon className="h-4 w-4" strokeWidth={1.7} />;
  };

  return (
    <div className="fixed inset-y-0 right-0 left-16 z-[80] flex flex-col bg-[#0a0a0a] text-white">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-white/10 bg-[#0d0d11]/90 px-4 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-white/70 transition hover:bg-white/[0.08] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4" style={{ color: OUTSEE_ACCENT }} />
            <div className="leading-tight">
              <div className="text-sm font-bold tracking-tight text-white/95">Генерация</div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-white/40">
                outsee create · глобально
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {projectId != null && (
            <span className="rounded-full border border-[#2dd4bf]/30 bg-[#2dd4bf]/10 px-2.5 py-0.5 font-mono text-[10px] font-semibold text-[#2dd4bf]">
              проект #{projectId}
            </span>
          )}
          {mediaType === "image" && (
            <button
              type="button"
              onClick={() => setAssistantOpen((v) => !v)}
              title="Помощник промпта: стиль → запрос → собранный промпт"
              className={cn(
                "inline-flex items-center rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition",
                assistantOpen
                  ? "border-[#2dd4bf]/50 bg-[#2dd4bf]/15 text-[#2dd4bf]"
                  : "border-white/10 bg-white/[0.03] text-white/60 hover:border-[#2dd4bf]/40 hover:bg-[#2dd4bf]/10 hover:text-white",
              )}
            >
              Помощник
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* History + feed filter */}
        <aside className="flex w-[250px] shrink-0 flex-col border-r border-white/10 bg-[#0a0a0d]/95 backdrop-blur-xl lg:w-[290px]">
          <div className="flex items-center gap-2 border-b border-white/[0.08] px-3.5 py-2.5">
            <History className="h-3.5 w-3.5 text-white/50" />
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/50">
              История
            </span>
            {queueCount > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-black shadow-sm"
                style={{ backgroundColor: OUTSEE_ACCENT }}
                title={`В работе на сервере ${serverRunningCount}/${maxParallel}, ожидание ${serverWaitingCount}`}
              >
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                {serverRunningCount}·{serverWaitingCount}
              </span>
            )}
            <span className="ml-auto font-mono text-[10px] text-white/40 font-semibold">
              {historyItems.length}
            </span>
          </div>
          <div className="space-y-2 border-b border-white/[0.08] px-2.5 py-2.5">
            <div>
              <div className="mb-1.5 px-1 text-[9px] font-bold uppercase tracking-wider text-white/40">
                В работе · {runningJobs.length}/{maxParallel}
              </div>
              {runningJobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[9px] text-white/30">
                  нет активных
                </div>
              ) : (
                <div className="space-y-1.5">
                  {runningJobs.map((j) => (
                    <button
                      key={j.job_id}
                      type="button"
                      onClick={() => j.history_id && setSelectedId(j.history_id)}
                      className="flex w-full items-center gap-2 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-2.5 py-2 text-left shadow-[0_0_15px_rgba(45,212,191,0.15)] transition"
                    >
                      <Loader2
                        className="h-3.5 w-3.5 shrink-0 animate-spin text-[#2dd4bf]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <div className="truncate font-mono text-[10px] font-semibold text-white/90">
                            {j.model || j.media}
                          </div>
                          <span className="shrink-0 font-mono text-[9px] font-semibold text-[#2dd4bf]">
                            {getLiveElapsed(j)}
                          </span>
                        </div>
                        <div className="truncate text-[9px] text-white/50">
                          {j.prompt_preview || "генерация…"}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1.5 px-1 text-[9px] font-bold uppercase tracking-wider text-white/40">
                Ожидание · {waitingJobs.length}
              </div>
              {waitingJobs.length === 0 ? (
                <div className="rounded-lg border border-dashed border-white/10 px-2 py-2 text-[9px] text-white/30">
                  очередь пуста
                </div>
              ) : (
                <div className="space-y-1.5">
                  {waitingJobs.map((j) => (
                    <button
                      key={j.job_id}
                      type="button"
                      onClick={() => j.history_id && setSelectedId(j.history_id)}
                      className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left transition hover:border-white/20 hover:bg-white/[0.06]"
                    >
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/10 font-mono text-[9px] font-bold text-white/70">
                        #{j.queue_position ?? "—"}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <div className="truncate font-mono text-[10px] font-semibold text-white/80">
                            {j.model || j.media}
                          </div>
                          <span className="shrink-0 font-mono text-[9px] font-medium text-white/50">
                            {getLiveElapsed(j)}
                          </span>
                        </div>
                        <div className="truncate text-[9px] text-white/40">
                          {j.prompt_preview || "в очереди"}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1 border-b border-white/[0.08] p-2">
            {OUTSEE_FEED_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setFeedKind(t.id)}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-all duration-150",
                  feedKind === t.id
                    ? "bg-[#2dd4bf] text-black font-extrabold shadow-[0_0_15px_rgba(45,212,191,0.3)]"
                    : "bg-white/[0.04] text-white/50 hover:bg-white/[0.08] hover:text-white",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {historyQ.isLoading ? (
              <div className="flex items-center gap-2 px-2 py-6 text-[11px] text-white/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                загрузка…
              </div>
            ) : historyItems.length === 0 ? (
              <div className="px-2 py-8 text-center text-[11px] text-white/35">
                Пока нет файлов. Результаты сохраняются в{" "}
                <span className="font-mono text-white/50">data/generations/</span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {historyItems.map((item) => {
                  const active = selected?.id === item.id;
                  const isVideo = item.kind === "video";
                  const isAudio = item.kind === "audio";
                  const waitJob = waitingJobs.find(
                    (j) =>
                      (item.id && (j.history_id === item.id || j.job_id === item.id)) ||
                      (item.job_id && (j.job_id === item.job_id || j.history_id === item.job_id)),
                  );
                  const runJob = runningJobs.find(
                    (j) =>
                      (item.id && (j.history_id === item.id || j.job_id === item.id)) ||
                      (item.job_id && (j.job_id === item.job_id || j.history_id === item.job_id)),
                  );
                  const pending =
                    item.status === "queued" ||
                    item.status === "processing" ||
                    Boolean(waitJob || runJob);
                  const failed = item.status === "failed";
                  const pendingLabel = waitJob
                    ? `ожидание #${waitJob.queue_position ?? "—"}`
                    : runJob || item.status === "processing"
                      ? "в работе"
                      : item.status === "queued"
                        ? "в очереди"
                        : "генерация";
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(item.id)}
                      onDoubleClick={() => applyHistoryConfig(item)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedId(item.id);
                        }
                      }}
                      className={cn(
                        "group relative aspect-square cursor-pointer select-none overflow-hidden rounded-xl border bg-[#121216] transition-all duration-200 outline-none",
                        active
                          ? "border-[#2dd4bf] ring-2 ring-[#2dd4bf]/40 shadow-[0_0_20px_rgba(45,212,191,0.25)]"
                          : "border-white/[0.08] hover:border-white/25 hover:bg-[#18181f]",
                      )}
                      title={`${item.label}${item.project_slug ? ` · ${item.project_slug}` : ""} · клик — просмотр, двойной клик — применить конфигурацию`}
                    >
                      {item.preview_url && !pending ? (
                        isVideo ? (
                          <video
                            src={item.preview_url}
                            muted
                            playsInline
                            preload="metadata"
                            className="h-full w-full object-cover"
                          />
                        ) : isAudio ? (
                          <div className="flex h-full flex-col items-center justify-center gap-1 bg-white/[0.03]">
                            <Music className="h-6 w-6 text-white/40" />
                          </div>
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={thumbUrl(item.preview_url)}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        )
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 text-center">
                          {pending ? (
                            <Loader2
                              className="h-5 w-5 animate-spin text-[#2dd4bf]"
                            />
                          ) : failed ? (
                            <div className="flex flex-col items-center gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-red-400">
                                ошибка
                              </span>
                              {item.prompt && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRetry(item);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.stopPropagation();
                                      handleRetry(item);
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 rounded-full bg-red-500/15 border border-red-500/30 px-2 py-0.5 text-[9px] font-medium text-red-200 hover:bg-red-500/30 hover:border-red-400 hover:text-white transition-all cursor-pointer shadow-sm active:scale-95"
                                  title="Повторить"
                                >
                                  <RotateCw className={cn("h-2.5 w-2.5", createGenerate.isPending && "animate-spin")} />
                                  <span>Повтор</span>
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[9px] text-white/25">{item.kind}</span>
                          )}
                          {pending && (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-white/55">
                                {pendingLabel}
                              </span>
                              <span className="font-mono text-[9px] font-bold text-[#2dd4bf]">
                                {getLiveElapsed(item)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      {((item.reference_images && item.reference_images.length > 0) || item.first_frame_url) && !pending && (
                        <div className="absolute top-1.5 left-1.5 z-20 flex items-center gap-0.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[8px] font-bold text-[#2dd4bf] backdrop-blur">
                          <Paperclip className="h-2.5 w-2.5" />
                          <span>{item.reference_images?.length || 1}</span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 py-1.5">
                        <div className="truncate font-mono text-[9px] font-semibold text-white/80">{item.label}</div>
                        {item.project_slug && !["outsee", "local", "kie", "via"].includes(item.project_slug.toLowerCase()) && (
                          <div className="truncate text-[8px] text-white/45">{item.project_slug}</div>
                        )}
                      </div>
                      {pending && (item.job_id || item.id) && !String(item.job_id || item.id).startsWith("draft-") && (
                        <div className="absolute top-1.5 right-1.5 z-20 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const jid = item.job_id || (item.id.startsWith("gen-") ? item.id.slice(4) : item.id);
                              cancelJobMut.mutate(jid);
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded-md bg-red-950/80 text-red-300 backdrop-blur transition hover:bg-red-600 hover:text-white shadow-md ring-1 ring-red-500/40"
                            title="Остановить генерацию"
                          >
                            <XCircle className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                      {!pending && (
                        <div className="absolute top-1.5 right-1.5 z-20 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteItem.mutate(item);
                            }}
                            className="flex h-6 w-6 items-center justify-center rounded-md bg-black/75 text-white/70 backdrop-blur transition hover:bg-red-600 hover:text-white shadow-md"
                            title="Удалить из истории"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          {(item.preview_url || item.raw_url) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadMediaFile(
                                  item.preview_url || item.raw_url || "",
                                  item.label || "generation",
                                  item.kind === "video" ? "mp4" : item.kind === "audio" ? "mp3" : "png",
                                  item.path,
                                );
                              }}
                              className="flex h-6 w-6 items-center justify-center rounded-md bg-black/75 text-white/80 backdrop-blur transition hover:bg-[#2dd4bf] hover:text-black shadow-md"
                              title="Скачать файл"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* Result + dock */}
        <section className="relative flex min-w-0 flex-1 flex-col">
          {/* Ambient glow backlight */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center -z-0">
            <div className="h-80 w-80 rounded-full bg-[#2dd4bf]/10 blur-[110px]" />
            <div className="h-60 w-60 rounded-full bg-purple-500/10 blur-[90px]" />
          </div>

          {/* Header - float top-left so media starts at the very top */}
          <div className="pointer-events-none absolute top-3 left-4 z-20 flex flex-col gap-0.5 lg:left-6">
            <h2 className="text-sm font-bold text-white lg:text-base">
              Результат генерации
            </h2>
            {selected && (
              <div className="flex flex-col text-[11px] font-medium text-white/50">
                {selected.elapsed_label ||
                (selected.elapsed_sec != null && selected.elapsed_sec >= 0) ||
                selected.status === "queued" ||
                selected.status === "processing" ? (
                  <div>
                    Время генерации:{" "}
                    <span className="font-mono font-semibold text-[#2dd4bf]">
                      {getLiveElapsed(selected)}
                    </span>
                  </div>
                ) : null}
                {selected.model && (
                  <div className="text-white/45">
                    Модель:{" "}
                    <span className="font-mono font-semibold text-white/75">{selected.model}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div
            className={cn(
              "relative z-10 flex min-h-0 flex-1 flex-col items-center px-4 pb-[260px] lg:px-6 w-full",
              selected?.kind === "audio" || !selected?.preview_url || selected?.status === "failed" || selected?.status === "queued" || selected?.status === "processing"
                ? "justify-center my-auto"
                : "justify-start pt-2",
            )}
          >
            {selected?.preview_url &&
            selected.status !== "queued" &&
            selected.status !== "processing" &&
            selected.status !== "failed" ? (
              <div className="flex flex-col items-center w-full my-auto">
                <div className="group relative flex max-h-[calc(100vh-360px)] max-w-full items-center justify-center w-full">
                  {selected.kind === "video" ? (
                    <video
                      src={selected.preview_url}
                      controls
                      className="max-h-[calc(100vh-360px)] max-w-full rounded-2xl border border-white/15 bg-black/80 shadow-[0_20px_50px_rgba(0,0,0,0.8)]"
                    />
                  ) : selected.kind === "audio" ? (
                    <div className="flex w-full items-center justify-center py-4 my-auto">
                      <AudioStudioPlayer
                        item={selected}
                        onInspect={() => setLightboxOpen(true)}
                      />
                    </div>
                  ) : (
                    <CreateImageViewer
                      key={selected.id}
                      item={selected}
                      onInspect={() => setLightboxOpen(true)}
                    />
                  )}
                  {selected.kind !== "audio" && (
                    <button
                      type="button"
                      onClick={() => setLightboxOpen(true)}
                      className="absolute top-3 right-3 z-30 flex items-center gap-1.5 rounded-xl border border-white/20 bg-black/70 px-3 py-1.5 text-[11px] font-medium text-white/90 opacity-0 backdrop-blur-md transition hover:scale-105 hover:border-[#2dd4bf]/60 hover:bg-[#2dd4bf]/20 hover:text-white group-hover:opacity-100 shadow-2xl"
                      title="Инспектор промпта / Во весь экран"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      <span>Инспектор</span>
                    </button>
                  )}
                </div>

                {/* Отображение использованных референсов (если были) */}
                {((selected.reference_images && selected.reference_images.length > 0) || selected.first_frame_url) && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/50 px-3 py-1.5 backdrop-blur-md shadow-md">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/50">
                      Использованные референсы ({selected.reference_images?.length || 1}):
                    </span>
                    <div className="flex items-center gap-1.5">
                      {(selected.reference_images && selected.reference_images.length > 0
                        ? selected.reference_images
                        : [selected.first_frame_url!]
                      ).map((u, i) => (
                        <a
                          key={i}
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="group/ref relative block h-8 w-8 overflow-hidden rounded-lg border border-white/20 transition hover:scale-110 hover:border-[#2dd4bf]"
                          title="Открыть референс в новой вкладке"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt="" className="h-full w-full object-cover" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : selected &&
              (selected.status === "queued" || selected.status === "processing") ? (
              <div className="my-auto flex w-full max-w-sm flex-col items-center gap-3.5 rounded-3xl border border-white/15 bg-[#121216]/95 px-6 py-10 text-center backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.8)]">
                <Loader2
                  className="h-9 w-9 animate-spin text-[#2dd4bf]"
                />
                <div className="text-sm font-bold text-white/90">
                  {selected.status === "queued" ? "В очереди ожидания" : "Идёт генерация…"}
                </div>
                <div className="inline-flex items-center gap-1.5 rounded-full border border-[#2dd4bf]/30 bg-[#2dd4bf]/10 px-3 py-1 font-mono text-[12px] font-bold text-[#2dd4bf]">
                  <Clock className="h-3.5 w-3.5" />
                  <span>{getLiveElapsed(selected)}</span>
                </div>
                <div className="text-[12px] text-white/50">
                  {selected.model || selected.label}
                  {queueCount > 1 ? ` · очередь ${queueCount}` : ""}
                </div>
                {selected.prompt && (
                  <div className="line-clamp-3 max-w-full text-[11px] text-white/40">
                    {selected.prompt}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const jid = selected.job_id || (selected.id.startsWith("gen-") ? selected.id.slice(4) : selected.id);
                    cancelJobMut.mutate(jid);
                  }}
                  disabled={cancelJobMut.isPending}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/15 px-4 py-2 text-[12px] font-semibold text-red-300 backdrop-blur transition hover:border-red-500/60 hover:bg-red-500/30 hover:text-white disabled:opacity-50 shadow-lg"
                  title="Остановить выполнение генерации"
                >
                  <XCircle className="h-4 w-4" />
                  <span>{cancelJobMut.isPending ? "Останавливаем…" : "Остановить генерацию"}</span>
                </button>
              </div>
            ) : selected?.status === "failed" ? (
              <div className="my-auto flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-6 py-8 text-center backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.8)]">
                <div className="text-sm font-bold text-red-300">Ошибка генерации</div>
                <div className="text-[12px] text-white/60">
                  {humanizeErrorMessage(selected.error) || "Не удалось получить файл"}
                </div>
                <div className="text-[12px] font-medium text-white/55">
                  Результат ·{" "}
                  {selected.elapsed_label ||
                    formatElapsedMinSec(selected.elapsed_sec)}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  {selected.prompt && (
                    <button
                      type="button"
                      onClick={() => handleRetry(selected)}
                      disabled={createGenerate.isPending}
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#2dd4bf] to-[#14b8a6] px-4 py-2 text-[12px] font-bold text-black shadow-[0_0_20px_rgba(45,212,191,0.4)] transition hover:brightness-110 active:scale-95 disabled:opacity-50"
                      title="Повторить генерацию с этим промптом"
                    >
                      <RotateCw className={cn("h-4 w-4", createGenerate.isPending && "animate-spin")} />
                      <span>{createGenerate.isPending ? "Запуск…" : "Повторить"}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => deleteItem.mutate(selected)}
                    disabled={deleteItem.isPending}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/30 bg-red-500/20 px-3.5 py-2 text-[11px] font-semibold text-red-300 backdrop-blur transition hover:border-red-500/50 hover:bg-red-500/30 hover:text-white shadow-lg active:scale-95 disabled:opacity-50"
                    title="Удалить ошибочную запись из истории"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Удалить из истории</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-black/40 px-8 py-10 text-center backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.6)]">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_25px_rgba(45,212,191,0.2)]">
                  <Sparkles className="h-8 w-8 text-[#2dd4bf]" />
                </div>
                <div className="space-y-1.5">
                  <div className="text-base font-semibold text-white/90">
                    Студия создания медиа
                  </div>
                  <div className="text-[13px] leading-relaxed text-white/55">
                    Опишите задумку в строке внизу и нажмите «Генерировать», либо выберите готовую работу из истории слева.
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2 text-[11px] text-white/45">
                  <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1">
                    🎨 Каталог стилей во «Вдохновении»
                  </span>
                  <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1">
                    ⚡ Кнопка «Случайный» для идей
                  </span>
                  <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1">
                    🪄 «Улучшить» для детального промпта
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* prompt dock + vertical type toggle */}
          <div className="absolute bottom-0 left-0 right-0 z-10 px-3 pb-3 lg:px-5 lg:pb-4">
            <div className="flex items-end gap-2">
              {/* cs-typetoggle */}
              <div className="flex shrink-0 flex-col gap-2">
                {/* Вдохновение — каталог стилей, тот же, что в помощнике над промптом */}
                <InspirationMenu value={stylePreset} onChange={setStylePreset} />
                {OUTSEE_TYPE_TABS.map((t) => {
                  const active = mediaType === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setMediaType(t.id);
                        setFeedKind(t.id);
                        setModelOpen(false);
                      }}
                      aria-pressed={active}
                      data-media-type={t.id}
                      className={cn(
                        "flex min-w-[76px] flex-col items-center gap-1.5 rounded-xl border px-3 py-2.5 transition-all duration-200",
                        active
                          ? "border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#2dd4bf] shadow-[0_0_18px_rgba(45,212,191,0.25)]"
                          : "border-white/10 bg-[#16161b]/90 text-white/45 hover:border-white/20 hover:bg-[#1e1e24] hover:text-white",
                      )}
                    >
                      <TypeIcon id={t.id} />
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.08em]">
                        {t.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Помощник промпта: заменяет док генерации (те же размеры) */}
              {assistantOpen && mediaType === "image" && (
                <GenAssistantPanel
                  onClose={() => setAssistantOpen(false)}
                  appliedPrompt={appliedPrompt}
                  imageSlug={imageSlug}
                  modelName={currentName}
                  aspect={aspect}
                  resolution={resolution}
                  detail={detail}
                  generating={createGenerate.isPending}
                  onAspectChange={setAspect}
                  onResolutionChange={setResolution}
                  onDetailChange={setDetail}
                  onOpenModelPicker={() => {
                    setModelOpen(true);
                    setOpenChip(null);
                  }}
                  onApplyPrompt={(t) => setPrompt(t)}
                  onGenerate={(t) => {
                    if (isUnfilledAssistantPrompt(t)) {
                      toast.error("Промпт не собран агентом — генерация не запущена", {
                        duration: 12_000,
                        position: "top-center",
                      });
                      return;
                    }
                    createGenerate.mutate({ prompt: t, aspect, forceSingle: true });
                    setPrompt("");
                  }}
                  onPrepareGenerate={(preview, n) => {
                    setPrompt("");
                    const now = new Date().toISOString();
                    const ids: string[] = [];
                    const extra: DraftJob[] = [];
                    for (let i = 0; i < Math.max(1, n); i += 1) {
                      const id = `draft-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`;
                      ids.push(id);
                      extra.push({
                        job_id: id,
                        history_id: id,
                        status: "processing",
                        media: "image",
                        model: imageSlug,
                        prompt_preview: preview.slice(0, 80) || "собираю промпт…",
                        provider: "draft",
                        created_at: now,
                        started_at: now,
                      });
                    }
                    setDraftJobs((prev) => [...extra, ...prev]);
                    setSelectedId(ids[0] ?? null);
                    return ids;
                  }}
                  onFailGenerate={(ids) => {
                    if (!ids.length) return;
                    setDraftJobs((prev) => prev.filter((d) => !ids.includes(d.job_id)));
                  }}
                  onGenerateAll={(texts, draftIds, styleNegativePrompt) => {
                    const ready = texts
                      .map((x) => x.trim())
                      .filter((t) => !isUnfilledAssistantPrompt(t));
                    const unused = (draftIds || []).slice(ready.length);
                    if (unused.length) {
                      setDraftJobs((prev) => prev.filter((d) => !unused.includes(d.job_id)));
                    }
                    if (!ready.length) {
                      if (draftIds?.length) {
                        setDraftJobs((prev) => prev.filter((d) => !draftIds.includes(d.job_id)));
                      }
                      toast.error("Промпт не собран агентом — генерация не запущена", {
                        duration: 12_000,
                        position: "top-center",
                      });
                      return;
                    }
                    ready.forEach((t, i) => {
                      createGenerate.mutate({
                        prompt: t,
                        aspect,
                        negativePrompt: styleNegativePrompt || negativePrompt,
                        forceSingle: true,
                        draftId: draftIds?.[i],
                      });
                    });
                    setPrompt("");
                  }}
                  expanded={assistantExpanded}
                  onExpandedChange={setAssistantExpanded}
                  modelIcon={currentIcon}
                  references={referenceImages}
                  maxReferences={maxReferences}
                  onAddReferenceFiles={(files) => addReferenceFiles(files)}
                  onRemoveReference={(id) =>
                    setReferenceImages((prev) => {
                      const hit = prev.find((r) => r.id === id);
                      if (hit) revokeRefUrl(hit.url);
                      return prev.filter((r) => r.id !== id);
                    })
                  }
                />
              )}
              {/* выбор модели при открытом помощнике: док скрыт, поэтому отдельный якорь у правой панели */}
              {assistantOpen && mediaType === "image" && modelOpen && (
                <div
                  className="absolute bottom-full right-3 z-50 mb-2 w-[520px] lg:right-5"
                  ref={modelRef2}
                >
                  <ModelPickerPopover
                    mediaType={mediaType}
                    selectedSlug={activeSlug}
                    kieModels={kieModels}
                    creditUsd={kieCatalogQ.data?.credit_usd ?? 0.005}
                    onSelect={(slug) => {
                      if (mediaType === "image") setImageSlug(slug);
                      else if (mediaType === "video") setVideoSlug(slug);
                      else setAudioSlug(slug);
                      if (!slug.startsWith("kie:")) applyModelDefaults(slug, mediaType);
                      setModelOpen(false);
                    }}
                  />
                </div>
              )}
              <div
                className={cn(
                  "min-w-0 flex-1 rounded-2xl border border-white/15 bg-[#121216]/95 backdrop-blur-2xl shadow-[0_20px_60px_rgba(0,0,0,0.85)] ring-1 ring-white/10",
                  assistantOpen && mediaType === "image" && "hidden",
                )}
              >
                {/* KIE: вложения для аудио/видео (голос, донор движения, аудиофайл) */}
                {!kieTilesActive &&
                  kieActive &&
                  kieModel &&
                  kieFileFields(kieModel).filter((f) => f.kind !== "images").length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] px-3 py-2.5 lg:px-4">
                    {kieFileFields(kieModel)
                      .filter((f) => f.kind !== "images")
                      .map((f) => (
                        <KieAttachButton
                          key={f.name}
                          field={f}
                          values={kieValues}
                          onChange={(name, items) =>
                            setKieValues((prev) => ({ ...prev, [name]: items }))
                          }
                        />
                      ))}
                    <span className="text-[10px] text-white/35">
                      файл грузится в kie → публичный URL; или вставь свой URL в поле
                    </span>
                  </div>
                )}
                {/* Плитки референсов в новом дизайне — для KIE и для Outsee-моделей */}
                {tilesActive && (
                  <div className="flex flex-wrap items-start gap-2 border-b border-white/[0.08] px-3 py-2.5 lg:px-4">
                    {kieTilesActive && (
                      <input
                        ref={refFileInputRef}
                        type="file"
                        className="hidden"
                        onChange={(e) => {
                          const files = Array.from(e.target.files || []);
                          const field = pendingRefFieldRef.current;
                          e.target.value = "";
                          if (!field || files.length === 0) return;
                          void uploadRefFiles(field, files);
                        }}
                      />
                    )}
                    {legacyTilesActive ? (
                      <>
                        {/* Outsee: скрытые инпуты под плитки */}
                        <input
                          ref={firstFrameInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            void readFileAsDataUrl(f).then((dataUrl) => {
                              setFirstFrameDataUrl(dataUrl);
                              setFirstFrameName(f.name);
                              toast.success("Стартовый кадр добавлен");
                            });
                            e.target.value = "";
                          }}
                        />
                        <input
                          ref={lastFrameInputRef}
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            void readFileAsDataUrl(f).then((dataUrl) => {
                              setLastFrameDataUrl(dataUrl);
                              setLastFrameName(f.name);
                              toast.success("Финальный кадр добавлен");
                            });
                            e.target.value = "";
                          }}
                        />
                        <input
                          ref={multiRefInputRef}
                          type="file"
                          multiple
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            if (files.length) addReferenceFiles(files);
                            e.target.value = "";
                          }}
                        />
                        {mediaType === "video" && videoCapabilities.supportsFirst && (
                          <RefCategory
                            kind="image"
                            addLabel="Первый кадр"
                            showNumber={false}
                            showCount={false}
                            max={1}
                            items={legacyTileRefs.filter((r) => r.field === "legacy_first")}
                            onAddClick={() => firstFrameInputRef.current?.click()}
                            onRemove={removeLegacyRef}
                            onPreview={setRefPreview}
                          />
                        )}
                        {mediaType === "video" && videoCapabilities.supportsLast && (
                          <RefCategory
                            kind="image"
                            addLabel="Последний кадр"
                            showNumber={false}
                            showCount={false}
                            max={1}
                            items={legacyTileRefs.filter((r) => r.field === "legacy_last")}
                            onAddClick={() => lastFrameInputRef.current?.click()}
                            onRemove={removeLegacyRef}
                            onPreview={setRefPreview}
                          />
                        )}
                        {maxReferences > 0 && (
                          <RefCategory
                            kind="image"
                            max={maxReferences}
                            items={legacyTileRefs.filter((r) => r.field === "legacy_images")}
                            onAddClick={() => multiRefInputRef.current?.click()}
                            onAddFiles={addReferenceFiles}
                            onRemove={removeLegacyRef}
                            onPreview={setRefPreview}
                          />
                        )}
                      </>
                    ) : seedanceIsKie && seedanceMode === "frames" ? (
                      /* Первый+Последний: только два слота, без номеров */
                      <>
                        {frameRefFields.map((f) => {
                          const isLast = f.name.startsWith("last");
                          return (
                            <RefCategory
                              key={f.name}
                              kind="image"
                              addLabel={isLast ? "Последний кадр" : "Первый кадр"}
                              items={frameRefs.filter((r) => r.field === f.name)}
                              max={f.max_items ?? 1}
                              busy={refBusyField === f.name}
                              showNumber={false}
                              showCount={false}
                              onAddClick={() => pickRefFiles(f)}
                              onAddFiles={(files) => void uploadRefFiles(f, files)}
                              onRemove={removeRef}
                              onPreview={setRefPreview}
                            />
                          );
                        })}
                      </>
                    ) : (
                      <>
                        {omniRefFields.map((f) => {
                          const kind = refKindOfField(f);
                          return (
                            <RefCategory
                              key={f.name}
                              kind={kind}
                              items={omniRefs.filter((r) => r.field === f.name)}
                              max={f.max_items ?? 0}
                              showCount={kind !== "audio"}
                              busy={refBusyField === f.name}
                              onAddClick={() => pickRefFiles(f)}
                              onAddFiles={(files) => void uploadRefFiles(f, files)}
                              onRemove={removeRef}
                              onPreview={setRefPreview}
                            />
                          );
                        })}
                        {/* Кадры у не-Seedance моделей: отдельные подписанные слоты */}
                        {!seedanceIsKie &&
                          frameRefFields.map((f) => {
                            const isLast = f.name.startsWith("last");
                            return (
                              <RefCategory
                                key={f.name}
                                kind="image"
                                addLabel={isLast ? "Последний кадр" : "Первый кадр"}
                                items={frameRefs.filter((r) => r.field === f.name)}
                                max={f.max_items ?? 1}
                                busy={refBusyField === f.name}
                                showNumber={false}
                                showCount={false}
                                onAddClick={() => pickRefFiles(f)}
                                onAddFiles={(files) => void uploadRefFiles(f, files)}
                                onRemove={removeRef}
                                onPreview={setRefPreview}
                              />
                            );
                          })}
                        {omniRefFields.length === 0 && frameRefFields.length === 0 && (
                          <span className="text-[10px] text-white/40">
                            У этой модели нет слотов под референсы
                          </span>
                        )}
                      </>
                    )}
                     <span className="self-center text-[10px] text-white/35">
                      {legacyTilesActive
                        ? "фото с диска или из истории · в промте — @имя референса"
                        : seedanceIsKie && seedanceMode === "frames"
                          ? "только старт и финиш · референсы скрыты"
                          : "фото, видео и аудио · в промте — @имя референса"}
                    </span>
                  </div>
                )}
                {/* Старая зона вложений: остаётся выключенной, всё рисуют плитки выше */}
                {!tilesActive && ((mediaType === "video" &&
                  (videoCapabilities.supportsFirst ||
                    videoCapabilities.supportsLast ||
                    videoCapabilities.supportsRefs)) ||
                  (mediaType === "image" && maxReferences > 0)) && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.08] px-3 py-2.5 lg:px-4">
                    {/* Видео-кадры (Старт / Финиш) */}
                    {mediaType === "video" && (
                      <>
                        {videoCapabilities.supportsFirst && (
                          <>
                            <input
                              ref={firstFrameInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                void readFileAsDataUrl(f).then((dataUrl) => {
                                  setFirstFrameDataUrl(dataUrl);
                                  setFirstFrameName(f.name);
                                  toast.success("Стартовый кадр добавлен");
                                });
                                e.target.value = "";
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => firstFrameInputRef.current?.click()}
                              className={cn(
                                "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-[11px] font-bold uppercase tracking-wider transition",
                                firstFrameDataUrl
                                  ? "border-[#2dd4bf]/40 bg-[#2dd4bf]/10 text-[#2dd4bf]"
                                  : "border-dashed border-white/20 bg-white/[0.03] text-white/70 hover:border-white/40 hover:text-white",
                              )}
                            >
                              {firstFrameDataUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={firstFrameDataUrl}
                                  alt=""
                                  className="h-6 w-6 rounded-lg object-cover ring-1 ring-white/15"
                                />
                              ) : (
                                <Paperclip className="h-3.5 w-3.5" />
                              )}
                              <span>Стартовый кадр</span>
                              {firstFrameDataUrl && (
                                <span
                                  className="text-white/45 hover:text-white"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    setFirstFrameDataUrl(null);
                                    setFirstFrameName(null);
                                  }}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </span>
                              )}
                            </button>
                          </>
                        )}
                        {videoCapabilities.supportsLast && (
                          <>
                            <input
                              ref={lastFrameInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                void readFileAsDataUrl(f).then((dataUrl) => {
                                  setLastFrameDataUrl(dataUrl);
                                  setLastFrameName(f.name);
                                  toast.success("Конечный кадр добавлен");
                                });
                                e.target.value = "";
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => lastFrameInputRef.current?.click()}
                              className={cn(
                                "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-[11px] font-bold uppercase tracking-wider transition",
                                lastFrameDataUrl
                                  ? "border-[#2dd4bf]/40 bg-[#2dd4bf]/10 text-[#2dd4bf]"
                                  : "border-dashed border-white/20 bg-white/[0.03] text-white/70 hover:border-white/40 hover:text-white",
                              )}
                            >
                              {lastFrameDataUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={lastFrameDataUrl}
                                  alt=""
                                  className="h-6 w-6 rounded-lg object-cover ring-1 ring-white/15"
                                />
                              ) : (
                                <Paperclip className="h-3.5 w-3.5" />
                              )}
                              <span>Конечный кадр</span>
                              {lastFrameDataUrl && (
                                <span
                                  className="text-white/45 hover:text-white"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    setLastFrameDataUrl(null);
                                    setLastFrameName(null);
                                  }}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </span>
                              )}
                            </button>
                          </>
                        )}
                        {selected?.kind === "image" && selected.status === "done" && (
                          <>
                            {videoCapabilities.supportsFirst && (
                              <button
                                type="button"
                                onClick={() => void applyFrameFromHistory(selected, "first")}
                                className="inline-flex h-9 items-center gap-1 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-2.5 text-[11px] font-semibold text-[#2dd4bf] transition hover:bg-[#2dd4bf]/20"
                                title="Текущее фото → Стартовый кадр"
                              >
                                → В старт
                              </button>
                            )}
                            {videoCapabilities.supportsLast && (
                              <button
                                type="button"
                                onClick={() => void applyFrameFromHistory(selected, "last")}
                                className="inline-flex h-9 items-center gap-1 rounded-xl border border-white/20 bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/75 transition hover:border-white/30 hover:bg-white/[0.08]"
                                title="Текущее фото → Конечный кадр"
                              >
                                → В финиш
                              </button>
                            )}
                          </>
                        )}
                      </>
                    )}

                    {/* Мульти-референсы (Фото или Видео с поддержкой reference images) */}
                    {maxReferences > 0 && (
                      <>
                        <input
                          ref={multiRefInputRef}
                          type="file"
                          multiple
                          accept="image/png,image/jpeg,image/webp"
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            if (files.length) addReferenceFiles(files);
                            e.target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => multiRefInputRef.current?.click()}
                          disabled={referenceImages.length >= maxReferences}
                          className={cn(
                            "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-[11px] font-bold uppercase tracking-wider transition",
                            referenceImages.length > 0
                              ? "border-[#2dd4bf]/40 bg-[#2dd4bf]/10 text-[#2dd4bf]"
                              : "border-dashed border-white/20 bg-white/[0.03] text-white/70 hover:border-white/40 hover:text-white",
                          )}
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                          <span>+ Референс</span>
                          <span className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[10px]">
                            {referenceImages.length}/{maxReferences}
                          </span>
                        </button>
                        {referenceImages.map((ref, idx) => (
                          <div
                            key={ref.id}
                            className="group flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.05] py-1 pl-1 pr-2 text-[11px] text-white/90"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={ref.url}
                              alt=""
                              className="h-6 w-6 rounded-lg object-cover ring-1 ring-white/15"
                            />
                            <span className="max-w-[90px] truncate font-mono text-[10px] text-white/75">
                              {ref.name || `Реф #${idx + 1}`}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setReferenceImages((prev) => {
                                  revokeRefUrl(ref.url);
                                  return prev.filter((r) => r.id !== ref.id);
                                })
                              }
                              className="ml-0.5 text-white/40 transition hover:text-red-400"
                              title="Удалить"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                        {selected?.kind === "image" &&
                          selected.status === "done" &&
                          referenceImages.length < maxReferences && (
                            <button
                              type="button"
                              onClick={() => void addReferenceFromHistory(selected)}
                              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-3 text-[11px] font-semibold text-[#2dd4bf] transition hover:bg-[#2dd4bf]/20"
                              title="Добавить текущий результат в референсы"
                            >
                              + В референсы ({referenceImages.length}/{maxReferences})
                            </button>
                          )}
                      </>
                    )}

                    <span className="text-[10px] text-white/35">
                      файл с диска или выбор из истории слева
                    </span>
                  </div>
                )}
                {/* Просмотр референса крупно */}
                {refPreview && (
                  <div
                    className="fixed inset-0 z-[95] flex items-center justify-center bg-black/85 p-6"
                    onClick={() => setRefPreview(null)}
                  >
                    <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-white/15 bg-[#121216]">
                      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2">
                        <span className="truncate text-[12px] text-white/80">{refPreview.name}</span>
                        <button
                          type="button"
                          onClick={() => setRefPreview(null)}
                          className="text-white/60 hover:text-white"
                          aria-label="Закрыть"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="flex max-h-[75vh] items-center justify-center overflow-auto bg-black/40 p-3">
                        {refPreview.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={refPreview.url}
                            alt=""
                            className="max-h-[70vh] w-auto object-contain"
                          />
                        ) : refPreview.kind === "video" ? (
                          <video src={refPreview.url} controls className="max-h-[70vh] w-auto" />
                        ) : (
                          <audio src={refPreview.url} controls className="w-full" />
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {/* Предупреждение о взаимоисключающих режимах кадров и референсов в видео */}
                {isVideoConflict && (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 border-b border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-[12px] text-amber-200 lg:px-4">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0 text-amber-400" />
                      <span>
                        Видеомодели поддерживают <strong>только один режим</strong>: либо переход между кадрами (старт/финиш), либо референсы.
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                      <button
                        type="button"
                        onClick={() => {
                          referenceImages.forEach((r) => revokeRefUrl(r.url));
                          setReferenceImages([]);
                          toast.success("Оставлен режим кадров: референсы очищены");
                        }}
                        className="rounded-lg bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/30 transition"
                      >
                        Только кадры
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setFirstFrameDataUrl(null);
                          setFirstFrameName(null);
                          setLastFrameDataUrl(null);
                          setLastFrameName(null);
                          toast.success("Оставлен режим референсов: кадры очищены");
                        }}
                        className="rounded-lg bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/30 transition"
                      >
                        Только референсы
                      </button>
                    </div>
                  </div>
                )}
                {/* Actions and Negative Prompt for image mode */}
                {mediaType === "image" && (
                  <div className="flex flex-wrap items-center justify-end gap-1.5 border-b border-white/[0.06] bg-white/[0.015] px-3 py-1.5 lg:px-4">
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={handleRandomPrompt}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-white/70 transition hover:border-[#2dd4bf]/40 hover:bg-[#2dd4bf]/10 hover:text-white"
                        title="Подставить готовый красивый пример промпта"
                      >
                        <Dices className="h-3 w-3 text-[#2dd4bf]" />
                        <span>Случайный</span>
                      </button>
                      <button
                        type="button"
                        disabled={isEnhancingPrompt}
                        onClick={handleEnhancePrompt}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#2dd4bf]/30 bg-[#2dd4bf]/10 px-2 py-0.5 text-[11px] font-semibold text-[#2dd4bf] transition hover:bg-[#2dd4bf]/20 disabled:opacity-50"
                        title="Улучшить и детализировать текущий промпт с помощью ИИ"
                      >
                        {isEnhancingPrompt ? (
                          <Loader2 className="h-3 w-3 animate-spin text-[#2dd4bf]" />
                        ) : (
                          <FileText className="h-3 w-3 text-[#2dd4bf]" />
                        )}
                        <span>{isEnhancingPrompt ? "Улучшаем…" : "Улучшить"}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowNegativePrompt((v) => !v)}
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 font-mono text-[10px] transition",
                          showNegativePrompt || negativePrompt
                            ? "bg-purple-500/20 text-purple-300 ring-1 ring-purple-500/30"
                            : "bg-white/[0.04] text-white/45 hover:text-white",
                        )}
                      >
                        <span>⛔ Негативный</span>
                        {negativePrompt && <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />}
                      </button>
                    </div>
                  </div>
                )}

                {/* Expandable Negative Prompt input */}
                {mediaType === "image" && showNegativePrompt && (
                  <div className="border-b border-white/[0.06] bg-black/20 px-3 py-2 lg:px-4">
                    <input
                      type="text"
                      value={negativePrompt}
                      onChange={(e) => setNegativePrompt(e.target.value)}
                      placeholder="Отрицательный промпт: чего НЕ должно быть на картинке (напр. размытие, лишние пальцы, текст, мусор)..."
                      className="w-full rounded-lg border border-white/10 bg-[#16161b] px-3 py-1.5 text-[12px] text-white placeholder-white/30 focus:border-purple-400 focus:outline-none selection:bg-[#2dd4bf]/40 selection:text-white"
                    />
                  </div>
                )}
                {(!kieActive || kieTextField) && (
                  <div className="relative px-3 pt-3 lg:px-4">
                    <MentionMenu
                      open={mentionOpen}
                      items={mentionCandidates}
                      activeIndex={mentionIndex}
                      onHover={setMentionIndex}
                      onPick={insertMention}
                      emptyHint={
                        seedanceRefs.length === 0 && mentionRefs.length === 0
                          ? "Референсов пока нет. Прикрепи фото, видео или аудио плитками выше — их имена появятся здесь."
                          : "Ничего не нашлось по этому запросу."
                      }
                    />
                    <textarea
                      ref={promptTextareaRef}
                      value={prompt}
                      onChange={(e) => {
                        setPrompt(e.target.value);
                        syncMention(e.target.value, e.target.selectionStart);
                      }}
                      onKeyDown={(e) => {
                        if (!mentionOpen) return;
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setMentionIndex((i) =>
                            mentionCandidates.length ? (i + 1) % mentionCandidates.length : 0,
                          );
                        } else if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setMentionIndex((i) =>
                            mentionCandidates.length
                              ? (i - 1 + mentionCandidates.length) % mentionCandidates.length
                              : 0,
                          );
                        } else if (e.key === "Enter" || e.key === "Tab") {
                          const item = mentionCandidates[mentionIndex];
                          if (item) {
                            e.preventDefault();
                            insertMention(item);
                          }
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setMentionOpen(false);
                        }
                      }}
                      onBlur={() => window.setTimeout(() => setMentionOpen(false), 150)}
                      placeholder={
                        mediaType === "audio"
                          ? kieModel?.id === "elevenlabs-v4" || audioSlug.includes("elevenlabs-v4")
                            ? "Введите текст для озвучки (1–10 000 символов)... Используйте кнопки аудио-тегов выше для добавления эмоций, смеха, пауз и акцентов."
                            : "Текст / описание трека…"
                          : mediaType === "video"
                            ? mentionRefs.length > 0
                              ? "Опишите видео… Введите @, чтобы вставить референс по имени"
                              : "Опишите видео…"
                            : "Опишите изображение…"
                      }
                      rows={
                        mediaType === "audio" &&
                        (kieModel?.id === "elevenlabs-v4" || audioSlug.includes("elevenlabs-v4"))
                          ? 5
                          : 3
                      }
                      style={{ outline: "none" }}
                      className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-white/90 placeholder:text-white/30 border-0 outline-none ring-0 focus:border-0 focus:outline-none focus:ring-0 selection:bg-[#2dd4bf]/40 selection:text-white"
                    />
                    {/* Выбранный стиль «Вдохновения»: каталог из помощника */}
                    {mediaType === "image" && activeStyle && (
                      <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-[#2dd4bf]/25 bg-[#2dd4bf]/5 px-2.5 py-1 text-[11px] text-[#2dd4bf]/90">
                        <span className="shrink-0 font-semibold">Стиль «{activeStyle.name}»</span>
                        <span className="min-w-0 flex-1 truncate text-[10px] text-white/45">
                          {activeStyle.desc}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStylePreset("")}
                          className="shrink-0 rounded p-0.5 text-white/40 transition hover:bg-white/10 hover:text-white"
                          title="Убрать стиль"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {kieActive && kieModel && !kieTextField && (
                  <div className="px-3 pt-3 lg:px-4">
                    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-[12px] leading-relaxed text-white/60">
                      {kieModel.hint || kieModel.desc}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-end gap-2 border-t border-white/[0.08] px-3 py-2.5 lg:px-4">
                  <div className="relative" ref={modelRef} data-model-anchor="true">
                    <ChipButton
                      active={modelOpen}
                      onClick={() => {
                        setModelOpen((v) => !v);
                        setOpenChip(null);
                      }}
                    >
                      {currentIcon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={currentIcon}
                          alt=""
                          width={18}
                          height={18}
                          className="h-[18px] w-[18px] shrink-0 rounded-md object-cover ring-1 ring-white/10"
                        />
                      ) : (
                        <span className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-[#5eead4]/20 font-mono text-[10px] font-bold text-[#5eead4] ring-1 ring-white/10">
                          K
                        </span>
                      )}
                      <span className="font-medium">
                        {currentWired ? (
                          <span className="mr-1 font-mono text-[#2dd4bf]">+</span>
                        ) : null}
                        {currentName}
                      </span>
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </ChipButton>
                    {modelOpen && (
                      <ModelPickerPopover
                        mediaType={mediaType}
                        selectedSlug={activeSlug}
                        kieModels={kieModels}
                        creditUsd={kieCatalogQ.data?.credit_usd ?? 0.005}
                        onSelect={(slug) => {
                          if (mediaType === "image") setImageSlug(slug);
                          else if (mediaType === "video") setVideoSlug(slug);
                          else setAudioSlug(slug);
                          if (!slug.startsWith("kie:")) applyModelDefaults(slug, mediaType);
                          setModelOpen(false);
                        }}
                      />
                    )}
                  </div>

                  {!kieActive && mediaType === "video" && videoModel.chips.includes("orientation") && (
                    <div className="inline-flex gap-0.5 rounded-full border border-white/10 bg-[#16161b] p-0.5">
                      {(["video", "image"] as const).map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => setOrientation(o)}
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[11px] font-medium transition",
                            orientation === o
                              ? "bg-[#2dd4bf]/20 text-[#2dd4bf] font-semibold"
                              : "text-white/45 hover:text-white",
                          )}
                        >
                          {o === "video" ? "По видео" : "По картинке"}
                        </button>
                      ))}
                    </div>
                  )}

                  {!kieActive && mediaType === "video" && videoModel.chips.includes("quality") && (
                    <div className="inline-flex gap-0.5 rounded-full border border-white/10 bg-[#16161b] p-0.5">
                      {chipOptions(videoSlug, "quality").map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => setMotionQuality(q)}
                          className={cn(
                            "rounded-full px-2.5 py-1 font-mono text-[11px] uppercase transition",
                            motionQuality === q
                              ? "bg-[#2dd4bf]/20 text-[#2dd4bf] font-semibold"
                              : "text-white/45 hover:text-white",
                          )}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  )}

                  {!kieActive && dockChips.map((chip) => {
                    if (chip === "audio") {
                      return (
                        <button
                          key="audio"
                          type="button"
                          onClick={() => setGenerateAudio((v) => !v)}
                          className={cn(
                            "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[12px] font-medium transition",
                            generateAudio
                              ? "border-[#2dd4bf]/40 bg-[#2dd4bf]/15 text-[#2dd4bf]"
                              : "border-white/10 bg-[#16161b] text-white/70 hover:border-white/20 hover:text-white",
                          )}
                          title={generateAudio ? "Со звуком" : "Без звука"}
                        >
                          {OUTSEE_CHIP_LABELS.audio}
                          <span className="font-mono text-[10px] text-white/45">
                            {generateAudio ? "on" : "off"}
                          </span>
                        </button>
                      );
                    }
                    if (chip === "image-input") {
                      return null;
                    }
                    if (chip === "instrumental") {
                      return (
                        <button
                          key="instrumental"
                          type="button"
                          onClick={() => setInstrumental((v) => !v)}
                          className={cn(
                            "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[12px] font-medium transition",
                            !instrumental
                              ? "border-[#2dd4bf]/40 bg-[#2dd4bf]/15 text-[#2dd4bf]"
                              : "border-white/10 bg-[#16161b] text-white/70 hover:border-white/20 hover:text-white",
                          )}
                          title="Вокал on = не instrumental"
                        >
                          {OUTSEE_CHIP_LABELS.instrumental}
                          <span className="font-mono text-[10px] text-white/40">
                            {instrumental ? "off" : "on"}
                          </span>
                        </button>
                      );
                    }

                    const opts = chipOptions(activeSlug, chip);
                    if (!opts.length) return null;

                    let display = aspect;
                    let onSelect = setAspect;
                    let selectedVal = aspect;
                    if (chip === "resolution") {
                      display = mediaType === "image" ? resolution : videoResolution;
                      onSelect = mediaType === "image" ? setResolution : setVideoResolution;
                      selectedVal = display;
                    } else if (chip === "detail") {
                      display = `Детализация: ${detailLabel(detail)}`;
                      onSelect = setDetail;
                      selectedVal = detail;
                    } else if (chip === "duration") {
                      display = `${duration}с`;
                      onSelect = setDuration;
                      selectedVal = duration;
                    }

                    const options =
                      chip === "detail"
                        ? OUTSEE_DETAIL_LEVELS.map((d) => ({
                            id: d.id,
                            label: d.label,
                            hint: d.hint,
                          }))
                        : chip === "duration"
                          ? opts.map((d) => ({ id: d, label: `${d}с` }))
                          : opts.map((o) => ({ id: o, label: o }));

                    return (
                      <OptionDropdown
                        key={chip}
                        label={OUTSEE_CHIP_LABELS[chip] || chip}
                        value={display}
                        selectedValue={selectedVal}
                        open={openChip === chip}
                        onOpenChange={(v) => {
                          setOpenChip(v ? chip : null);
                          if (v) setModelOpen(false);
                        }}
                        options={options}
                        onSelect={onSelect}
                        mono={chip !== "detail"}
                      />
                    );
                  })}

                  {/* Seedance (KIE): Формат · Разрешение · Время · Звук + Omni/Fast */}
                  {seedanceIsKie && kieModel && (
                    <SeedanceDock
                      fields={kieModel.fields}
                      values={kieValues}
                      onChange={handleKieValueChange}
                      onReset={resetSeedanceParams}
                      mode={seedanceMode}
                      onMode={switchSeedanceMode}
                      preset={seedancePreset}
                      onPreset={applySeedancePreset}
                    />
                  )}

                  {/* ElevenLabs: док «Параметры» озвучки — голос, слайдеры, теги, клонирование */}
                  {kieActive && isElevenLabsActive && kieModel && (
                    <ElevenLabsDock
                      voiceName={voiceChipName}
                      voiceId={elevenLabsVoiceId}
                      values={kieValues}
                      onChange={handleKieValueChange}
                      onVoice={handleVoiceChange}
                      onClone={() => setCloneVoiceOpen(true)}
                      onInsertTag={handleInsertAudioTag}
                      onReset={resetElevenLabsParams}
                      priceLabel={priceLabel}
                    />
                  )}

                  {/* KIE: динамические настройки модели из каталога */}
                  {kieActive &&
                    kieModel &&
                    kieChipFields(kieModel)
                      .filter((f) => !(seedanceIsKie && SEEDANCE_DOCK_FIELDS.has(f.name)))
                      .filter((f) => !(isElevenLabsActive && ELEVENLABS_DOCK_FIELDS.has(f.name)))
                      .filter((f) => kieFieldVisible(f, kieValues))
                      .map((f) => (
                        <KieFieldChip
                          key={f.name}
                          field={f}
                          values={kieValues}
                          openChip={openChip}
                          setOpenChip={setOpenChip}
                          setModelOpen={setModelOpen}
                          onChange={handleKieValueChange}
                        />
                      ))}

                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {!kieActive && mediaType === "video" &&
                      (videoSlug === "sora-2" ||
                        videoSlug === "sora2-portrait" ||
                        videoSlug === "sora2-landscape") && (
                        <div className="inline-flex gap-0.5 rounded-xl border border-white/10 bg-[#16161b] p-0.5">
                          {(["small", "large"] as const).map((sz) => (
                            <button
                              key={sz}
                              type="button"
                              onClick={() => setSoraSize(sz)}
                              className={cn(
                                "rounded-lg px-2.5 py-1.5 font-mono text-[10px] uppercase transition",
                                soraSize === sz
                                  ? "bg-[#2dd4bf]/20 text-[#2dd4bf] font-semibold"
                                  : "text-white/40 hover:text-white",
                              )}
                            >
                              {sz}
                            </button>
                          ))}
                        </div>
                      )}
                    <button
                      type="button"
                      disabled={saveGlobal.isPending}
                      onClick={() => saveGlobal.mutate()}
                      className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-medium text-white/70 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
                    >
                      {saveGlobal.isPending ? "…" : "Сохранить"}
                    </button>
                    {!kieActive && (
                      <button
                        type="button"
                        disabled={applyToProject.isPending || projectId == null}
                        onClick={() => applyToProject.mutate()}
                        className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-medium text-white/70 transition hover:border-white/25 hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
                        title="Скопировать глобальные настройки в выбранный проект"
                      >
                        В проект
                      </button>
                    )}
                    {kieActive && kieCreditsQ.data?.credits != null && (
                      <div
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-[#16161b] px-2.5 font-mono text-[11px] text-white/60"
                        title="Баланс kie.ai"
                      >
                        {kieCreditsQ.data.credits.toFixed(0)} кр
                      </div>
                    )}
                    <div
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-[#16161b] px-2.5 font-mono text-[11px] text-white/80"
                      title={
                        kieActive
                          ? "kie.ai: 1 кр = $0.005. Цена за выбранные параметры."
                          : "1 токен = $0.10 (10¢). Цена за выбранные параметры."
                      }
                    >
                      <Coins className="h-3 w-3 text-[#2dd4bf]" strokeWidth={2.5} />
                      <span>{priceLabel}</span>
                    </div>
                    {(mediaType === "image" || mediaType === "video") && (
                      <div
                        className="inline-flex h-9 items-center gap-0.5 rounded-xl border border-white/10 bg-[#16161b] p-0.5"
                        title={`Пакетная генерация: ${mediaType === "image" ? "1, 2 или 4 фото" : "1 или 2 видео"}`}
                      >
                        {(mediaType === "image" ? ([1, 2, 4] as const) : ([1, 2] as const)).map(
                          (cnt) => (
                            <button
                              key={cnt}
                              type="button"
                              onClick={() => setBatchCount(cnt)}
                              className={cn(
                                "rounded-lg px-2 py-1 font-mono text-[11px] font-bold transition",
                                batchCount === cnt
                                  ? "bg-[#2dd4bf]/20 text-[#2dd4bf] ring-1 ring-[#2dd4bf]/40"
                                  : "text-white/45 hover:text-white",
                              )}
                            >
                              {cnt}x
                            </button>
                          ),
                        )}
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={
                        createGenerate.isPending ||
                        (kieActive
                          ? (kieTextField && !prompt.trim()) ||
                            (isElevenLabsActive ? !elevenlabsConfigured : !kieConfigured)
                          : !prompt.trim() || !canApiDirect)
                      }
                      onClick={() => {
                        if (createGenerate.isPending) return;
                        if (isVideoConflict) {
                          toast.error(
                            "В видео нельзя совмещать переход по кадрам (старт/финиш) и референсы. Выберите один режим выше.",
                          );
                          return;
                        }
                        createGenerate.mutate(undefined);
                      }}
                      className={cn(
                        "inline-flex min-w-[145px] items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#2dd4bf] to-[#0d9488] px-4 py-2 text-[12px] font-extrabold uppercase tracking-wider text-black shadow-[0_0_20px_rgba(45,212,191,0.3)] transition-all duration-200 hover:brightness-110 hover:shadow-[0_0_25px_rgba(45,212,191,0.45)] disabled:opacity-40 disabled:pointer-events-none",
                      )}
                      title={
                        createGenerate.isPending
                          ? "Уже ставится в очередь…"
                          : isVideoConflict
                            ? "Нельзя совмещать кадры (старт/финиш) и референсы — выберите один режим"
                            : isElevenLabsActive && !elevenlabsConfigured
                              ? "Нужен ELEVENLABS_API_KEY в Настройках или .env"
                              : !canApiDirect
                                ? "Нужен OUTSEE_API_KEY или KIE_API_KEY в .env"
                              : `Сгенерировать (${batchCount > 1 ? `${batchCount} шт` : "1 шт"}, лимит ${maxParallel}) · ${priceLabel}`
                      }
                    >
                      {createGenerate.isPending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Запуск…</span>
                        </>
                      ) : (
                        <>
                          <Play className="h-3.5 w-3.5 fill-current" />
                          <span>
                            Генерировать
                            {batchCount > 1 ? ` (${batchCount}x)` : ""}
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Lightbox full screen modal & Prompt Inspector */}
      {lightboxOpen && selected?.preview_url && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-3 md:p-6 backdrop-blur-2xl animate-in fade-in duration-200"
          onClick={() => setLightboxOpen(false)}
        >
          <div
            className="flex flex-col max-h-[96vh] max-w-[98vw] w-full gap-3 md:gap-3.5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Bar: Media Info & Action buttons (Download, Delete, Close) */}
            <div className="flex items-center justify-between gap-3 px-1 sm:px-2 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="truncate text-sm sm:text-base font-semibold text-white/90">
                  {selected.label || (selected.kind === "audio" ? "Аудиотрек" : selected.kind === "video" ? "Видео" : "Изображение")}
                </span>
                {selected.model && (
                  <span className="shrink-0 rounded-md border border-[#2dd4bf]/30 bg-[#2dd4bf]/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#2dd4bf]">
                    {selected.model}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div className="inline-flex items-center rounded-xl border border-white/20 bg-black/80 p-0.5 backdrop-blur-md shadow-2xl">
                  <button
                    type="button"
                    onClick={() =>
                      void downloadMediaFile(
                        selected.preview_url || selected.raw_url || "",
                        selected.label || "generation",
                        selected.kind === "video"
                          ? "mp4"
                          : selected.kind === "audio"
                            ? "mp3"
                            : downloadFormat,
                        selected.path,
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white/90 transition hover:bg-white/[0.12] hover:text-white"
                  >
                    <Download className="h-4 w-4 text-[#2dd4bf]" />
                    <span>Скачать</span>
                  </button>
                  {selected.kind === "image" && (
                    <div className="flex items-center border-l border-white/20 pl-1 pr-1 font-mono text-[11px]">
                      {(["png", "jpg", "webp"] as const).map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => setDownloadFormat(fmt)}
                          className={cn(
                            "rounded px-2 py-0.5 uppercase transition",
                            downloadFormat === fmt
                              ? "bg-[#2dd4bf]/25 font-bold text-[#2dd4bf]"
                              : "text-white/50 hover:text-white",
                          )}
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setLightboxOpen(false);
                    deleteItem.mutate(selected);
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-red-500/30 bg-black/80 px-3 text-[12px] font-medium text-red-400 backdrop-blur transition hover:border-red-500/50 hover:bg-red-500/20 hover:text-red-300 shadow-2xl"
                  title="Удалить из истории"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Удалить</span>
                </button>

                <button
                  type="button"
                  onClick={() => setLightboxOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/20 bg-black/80 text-white/80 backdrop-blur transition hover:bg-white/20 hover:text-white shadow-2xl"
                  title="Закрыть (Esc)"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Content Row: Media Area + Prompt Inspector Panel */}
            <div className="flex flex-1 flex-col md:flex-row items-center md:items-start justify-center gap-4 min-h-0 overflow-hidden">
              {/* Media Area */}
              <div className="flex flex-1 items-center justify-center max-h-[84vh] max-w-full min-w-0">
                {selected.kind === "video" ? (
                  <video
                    src={selected.preview_url}
                    controls
                    autoPlay
                    className="max-h-[84vh] max-w-full rounded-2xl border border-white/15 bg-black object-contain shadow-[0_0_80px_rgba(0,0,0,0.9)]"
                  />
                ) : selected.kind === "audio" ? (
                  <div className="w-full max-w-3xl lg:max-w-4xl py-4">
                    <AudioStudioPlayer item={selected} />
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={selected.preview_url}
                    alt=""
                    className="max-h-[84vh] max-w-full rounded-2xl border border-white/15 bg-black object-contain shadow-[0_0_80px_rgba(0,0,0,0.9)]"
                  />
                )}
              </div>

              {/* Prompt Inspector Panel */}
              <div className="flex w-full md:w-84 shrink-0 flex-col gap-3 rounded-2xl border border-white/15 bg-[#121216]/95 p-4 backdrop-blur-2xl shadow-[0_20px_60px_rgba(0,0,0,0.9)] max-h-[84vh] overflow-y-auto ring-1 ring-white/10">
                <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#2dd4bf]">
                    <FileText className="h-4 w-4" />
                    <span>Инспектор</span>
                  </div>
                  {selected.model && (
                    <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] text-white/70">
                      {selected.model}
                    </span>
                  )}
                </div>

                {/* Prompt Text Box */}
                <div>
                  <div className="mb-1 text-[11px] font-semibold text-white/50">Промпт:</div>
                  <div className="max-h-52 overflow-y-auto rounded-xl border border-white/10 bg-black/40 p-3 text-[12px] leading-relaxed text-white/90 select-text">
                    {selected.prompt || "Без текстового описания"}
                  </div>
                </div>

                {/* Quick Actions: Copy & Insert into Prompt Dock */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (selected.prompt) {
                        void navigator.clipboard.writeText(selected.prompt);
                        toast.success("Промпт скопирован в буфер 📋");
                      }
                    }}
                    disabled={!selected.prompt}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.05] px-3 text-[11px] font-semibold text-white/85 transition hover:border-white/30 hover:bg-white/[0.1] hover:text-white disabled:opacity-40"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>Скопировать</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (selected.prompt) {
                        setPrompt(selected.prompt);
                        setLightboxOpen(false);
                        toast.success("Промпт подставлен в поле ввода ✍️");
                      }
                    }}
                    disabled={!selected.prompt}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/15 px-3 text-[11px] font-bold text-[#2dd4bf] transition hover:bg-[#2dd4bf]/25 disabled:opacity-40"
                  >
                    <CornerDownLeft className="h-3.5 w-3.5" />
                    <span>Вставить в чат</span>
                  </button>
                </div>

                {selected.prompt && (
                  <button
                    type="button"
                    onClick={() => {
                      setLightboxOpen(false);
                      handleRetry(selected);
                    }}
                    disabled={createGenerate.isPending}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-[#2dd4bf] to-[#14b8a6] px-3 text-[11px] font-bold text-black shadow-[0_0_15px_rgba(45,212,191,0.3)] transition hover:brightness-110 active:scale-95 disabled:opacity-50"
                    title="Повторить генерацию с теми же параметрами"
                  >
                    <RotateCw className={cn("h-3.5 w-3.5", createGenerate.isPending && "animate-spin")} />
                    <span>{createGenerate.isPending ? "Запуск…" : "Сгенерировать заново"}</span>
                  </button>
                )}

                {/* References Strip (if any) */}
                {((selected.reference_images && selected.reference_images.length > 0) || selected.first_frame_url) && (
                  <div className="border-t border-white/10 pt-2.5">
                    <div className="mb-1.5 text-[11px] font-semibold text-white/50">
                      Использованные референсы ({selected.reference_images?.length || 1}):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(selected.reference_images && selected.reference_images.length > 0
                        ? selected.reference_images
                        : [selected.first_frame_url!]
                      ).map((u, i) => (
                        <a
                          key={i}
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="group/ref relative block h-12 w-12 overflow-hidden rounded-lg border border-white/20 transition hover:scale-105 hover:border-[#2dd4bf]"
                          title="Открыть референс в новой вкладке"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={u} alt="" className="h-full w-full object-cover" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {/* Meta details */}
                <div className="space-y-1 border-t border-white/10 pt-2.5 font-mono text-[10px] text-white/45">
                  {selected.elapsed_label || selected.elapsed_sec != null ? (
                    <div>
                      Время генерации:{" "}
                      <span className="font-semibold text-white/70">
                        {selected.elapsed_label || formatElapsedMinSec(selected.elapsed_sec)}
                      </span>
                    </div>
                  ) : null}
                  <div>
                    ID: <span className="text-white/60">{selected.id}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Визард клонирования голоса («Новый голос», 3 шага) — встаёт справа от панели «Параметры» */}
      <CloneVoiceDialog
        open={cloneVoiceOpen}
        onOpenChange={setCloneVoiceOpen}
        onCreated={(voice) => {
          const vid = voice.external_voice_id || voice.id;
          handleVoiceChange(vid, voice.name);
        }}
      />
    </div>
  );
}

function kieFieldVisible(f: KieField, values: Record<string, unknown>): boolean {
  if (!f.show_if) return true;
  return Object.entries(f.show_if).every(([k, want]) => {
    const got = values[k];
    if (typeof want === "boolean") {
      const truthy = got === true || String(got).toLowerCase() === "true";
      return truthy === want;
    }
    return String(got ?? "") === String(want);
  });
}

/** KIE: одна настройка модели в виде чипа (select/toggle/number/text). */
function KieFieldChip({
  field,
  values,
  openChip,
  setOpenChip,
  setModelOpen,
  onOpenVoiceModal,
  onChange,
}: {
  field: KieField;
  values: Record<string, unknown>;
  openChip?: string | null;
  setOpenChip?: (v: string | null) => void;
  setModelOpen?: (v: boolean) => void;
  onOpenVoiceModal?: () => void;
  onChange: (name: string, v: unknown) => void;
}) {
  const v = values[field.name] ?? field.default;

  if (field.name === "voice_id" || field.name === "voice") {
    const vStr = String(v || "");
    const voice = getVoiceById(vStr);
    const resolved = resolveVoiceName(vStr);
    const displayName = voice
      ? `${voice.name} (${voice.gender === "female" ? "Ж" : "М"})`
      : resolved || vStr || "Выбрать голос";
    return (
      <button
        type="button"
        onClick={onOpenVoiceModal}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-3 text-[12px] font-medium text-white transition hover:bg-[#2dd4bf]/20 hover:border-[#2dd4bf]/60"
        title="Открыть библиотеку русских голосов и клонов"
      >
        <Mic className="h-3.5 w-3.5 text-[#2dd4bf]" />
        <span className="text-white/60">Голос:</span>
        <span className="font-semibold text-[#2dd4bf]">{displayName}</span>
      </button>
    );
  }

  if (field.name === "stability" || field.name === "similarity") {
    const numVal =
      typeof v === "number"
        ? v
        : Number(v ?? field.default ?? (field.name === "stability" ? 0.5 : 0.75));
    return (
      <div
        className="inline-flex h-9 items-center gap-2 rounded-xl border border-white/10 bg-[#16161b] px-3"
        title={field.desc || field.label}
      >
        <span className="text-[11px] text-white/55">{field.label}:</span>
        <span className="font-mono text-[11px] font-semibold text-[#2dd4bf]">{numVal.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={numVal}
          onChange={(e) => onChange(field.name, parseFloat(e.target.value))}
          className="h-1.5 w-16 cursor-pointer appearance-none rounded-lg bg-white/20 accent-[#2dd4bf]"
        />
      </div>
    );
  }

  if (field.kind === "toggle") {
    const on = v === true || String(v).toLowerCase() === "true";
    return (
      <button
        type="button"
        onClick={() => onChange(field.name, !on)}
        title={field.desc || field.label}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[12px] font-medium transition",
          on
            ? "border-[#2dd4bf]/40 bg-[#2dd4bf]/15 text-[#2dd4bf]"
            : "border-white/10 bg-[#16161b] text-white/70 hover:border-white/20 hover:text-white",
        )}
      >
        {field.label}
        <span className="font-mono text-[10px] text-white/45">{on ? "on" : "off"}</span>
      </button>
    );
  }

  if (field.kind === "select") {
    const formatOption = (opt: string) => {
      const fn = field.name.toLowerCase();
      const o = opt.toLowerCase();
      if (fn === "quality") {
        if (o === "basic") return { label: "1K", hint: "Базовое" };
        if (o === "high") return { label: "2K", hint: "Высокое" };
        if (o === "std" || o === "standard") return { label: "Standard", hint: "720p" };
        if (o === "pro") return { label: "Pro", hint: "1080p" };
      }
      if (fn === "vocalgender") {
        if (o === "m") return { label: "Мужской вокал", hint: "Мужской тембр" };
        if (o === "f") return { label: "Женский вокал", hint: "Женский тембр" };
        return { label: "Вокал: Любой", hint: "Без предпочтений" };
      }
      if (fn === "output_format" || fn === "format") {
        return { label: opt.toUpperCase() };
      }
      return { label: opt || "—" };
    };

    const options = (field.options || []).map((o) => {
      const meta = formatOption(o);
      return { id: o, label: meta.label, hint: meta.hint };
    });
    const currentVal = String(v ?? field.options?.[0] ?? "—");
    const selectedOpt = options.find((o) => o.id === currentVal);
    const displayVal = selectedOpt ? selectedOpt.label : currentVal;

    return (
      <OptionDropdown
        label={field.label}
        value={displayVal}
        selectedValue={currentVal}
        open={openChip === field.name}
        onOpenChange={(isOpen) => {
          if (setOpenChip) setOpenChip(isOpen ? field.name : null);
          if (isOpen && setModelOpen) setModelOpen(false);
        }}
        options={options}
        onSelect={(optId) => onChange(field.name, optId)}
        mono
      />
    );
  }

  if (field.kind === "number") {
    return (
      <div
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-[#16161b] px-2.5"
        title={field.desc || field.label}
      >
        <span className="text-[11px] text-white/55">{field.label}</span>
        <input
          type="number"
          value={v === undefined || v === null ? "" : String(v)}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(e) =>
            onChange(field.name, e.target.value === "" ? undefined : Number(e.target.value))
          }
          className="w-16 bg-transparent font-mono text-[12px] text-white/90 outline-none"
        />
      </div>
    );
  }

  // text
  return (
    <div
      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-[#16161b] px-2.5"
      title={field.desc || field.label}
    >
      <span className="text-[11px] text-white/55">{field.label}</span>
      <input
        value={String(v ?? "")}
        onChange={(e) => onChange(field.name, e.target.value)}
        placeholder="—"
        className="w-28 bg-transparent text-[12px] text-white/90 outline-none placeholder:text-white/25"
      />
    </div>
  );
}

const KIE_FILE_ACCEPT: Record<string, string> = {
  images: "image/png,image/jpeg,image/webp,image/bmp,image/gif",
  videos: "video/mp4,video/quicktime,video/webm",
  audios: "audio/mpeg,audio/wav,audio/mp4,audio/x-m4a",
};

/** KIE: кнопка вложения в стиле «Стартовый кадр» — загрузка в kie или URL. */
function KieAttachButton({
  field,
  values,
  onChange,
}: {
  field: KieField;
  values: Record<string, unknown>;
  onChange: (name: string, items: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [urlMode, setUrlMode] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const items: string[] = Array.isArray(values[field.name])
    ? (values[field.name] as string[])
    : [];
  const max = field.max_items ?? 99;
  const canAdd = items.length < max;

  const addUrl = () => {
    const u = urlDraft.trim();
    if (!u) return;
    if (!/^https?:\/\//.test(u)) {
      toast.error("Нужен http(s) URL");
      return;
    }
    onChange(field.name, [...items, u]);
    setUrlDraft("");
    setUrlMode(false);
  };

  return (
    <>
      {items.map((u, i) => (
        <span
          key={`${u}-${i}`}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#2dd4bf]/40 bg-[#2dd4bf]/10 px-3 text-[12px] font-medium text-[#2dd4bf]"
        >
          {field.kind === "images" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={u} alt="" className="h-7 w-7 rounded-md object-cover ring-1 ring-white/15" />
          ) : (
            <Paperclip className="h-4 w-4" />
          )}
          <span className="max-w-[120px] truncate font-mono text-[10px] text-white/70">
            {u.split("/").pop()}
          </span>
          <span
            className="cursor-pointer text-white/45 hover:text-white"
            onClick={() => onChange(field.name, items.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </span>
        </span>
      ))}
      {canAdd && (
        <span className="inline-flex items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            accept={KIE_FILE_ACCEPT[field.kind] || "*/*"}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size === 0) {
                toast.error("Выбран пустой файл (0 байт)");
                e.target.value = "";
                return;
              }
              if (field.kind === "audios" && f.size < 1000) {
                toast.error("Файл слишком мал или не содержит аудиоданных (минимум 1 КБ)");
                e.target.value = "";
                return;
              }
              if (field.kind === "videos" && f.size < 2000) {
                toast.error("Файл слишком мал или не содержит видеоданных");
                e.target.value = "";
                return;
              }
              setBusy(true);
              api
                .kieUpload(f)
                .then((r) => {
                  onChange(field.name, [...items, r.url]);
                  toast.success(`${field.label}: файл загружен`);
                })
                .catch((err) => toast.error(errorMessageFromUnknown(err)))
                .finally(() => setBusy(false));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            title={field.desc || field.label}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-dashed border-white/25 bg-white/[0.03] px-3 text-[12px] font-medium text-white/70 transition hover:border-white/40 hover:text-white disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-[#2dd4bf]" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
            {field.label}
            {field.required ? <span className="text-red-400">*</span> : null}
          </button>
          <button
            type="button"
            onClick={() => setUrlMode((v) => !v)}
            title="Вставить URL вместо загрузки"
            className="inline-flex h-10 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-white/50 transition hover:border-white/25 hover:text-white"
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
          {urlMode && (
            <span className="inline-flex items-center gap-1">
              <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addUrl();
                  }
                }}
                placeholder="https://…"
                className="h-10 w-48 rounded-xl border border-white/10 bg-black/40 px-2.5 text-[11px] text-white/80 outline-none placeholder:text-white/25 focus:border-[#2dd4bf]/50"
              />
              <button
                type="button"
                onClick={addUrl}
                className="h-10 rounded-xl border border-white/10 px-2.5 text-[11px] text-white/60 transition hover:border-white/25 hover:text-white"
              >
                +
              </button>
            </span>
          )}
        </span>
      )}
    </>
  );
}

function ChipButton({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-[12px] font-medium transition-all duration-200",
        active
          ? "border-[#2dd4bf] bg-[#2dd4bf]/15 text-[#2dd4bf] shadow-[0_0_15px_rgba(45,212,191,0.2)]"
          : "border-white/10 bg-[#16161b] text-white/80 hover:border-white/20 hover:bg-[#1f1f26] hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

function OptionDropdown({
  label,
  value,
  selectedValue,
  open,
  onOpenChange,
  options,
  onSelect,
  mono,
}: {
  label: string;
  value: string;
  selectedValue?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  options: { id: string; label: string; hint?: string }[];
  onSelect: (id: string) => void;
  mono?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const currentVal = selectedValue ?? value;

  return (
    <div className="relative" ref={ref}>
      <ChipButton active={open} onClick={() => onOpenChange(!open)} title={label}>
        <span className={cn(mono && "font-mono tabular-nums")}>{value}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </ChipButton>
      {open && (
        <div
          className="absolute bottom-full left-0 z-[1000] mb-2 max-h-60 overflow-y-auto rounded-xl border border-white/15 bg-[#121216]/95 backdrop-blur-2xl p-1.5 shadow-[0_15px_40px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
          style={{ minWidth: 140 }}
        >
          {options.map((opt) => {
            const active = opt.id === currentVal || opt.label === currentVal || opt.id === value || opt.label === value;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onSelect(opt.id);
                  onOpenChange(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[12px] transition",
                  active
                    ? "bg-[#2dd4bf]/15 text-[#2dd4bf] font-semibold"
                    : "text-white/80 hover:bg-white/[0.08] hover:text-white",
                )}
              >
                <span className={cn(mono && "font-mono")}>{opt.label}</span>
                {opt.hint && <span className="text-[10px] text-white/40">{opt.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
function ModelCardIcon({
  icon,
  label,
  letter,
  isTopCard,
}: {
  icon?: string | null;
  label: string;
  letter?: string | null;
  isTopCard?: boolean;
}) {
  const [error, setError] = useState(false);
  const effectiveIcon = !error && icon ? icon : modelIconForId(label);

  if (error && effectiveIcon === icon) {
    return (
      <span
        className={cn(
          "inline-flex h-10 w-10 items-center justify-center rounded-lg font-mono text-[14px] font-bold ring-1 transition",
          isTopCard
            ? "bg-[#2dd4bf]/15 text-[#2dd4bf] ring-[#2dd4bf]/30 group-hover:ring-[#2dd4bf]/60"
            : "bg-[#5eead4]/15 text-[#5eead4] ring-white/10 group-hover:ring-[#5eead4]/40",
        )}
      >
        {letter || label.slice(0, 1)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={effectiveIcon}
      alt={label}
      onError={() => setError(true)}
      className="h-10 w-10 rounded-lg object-cover ring-1 ring-white/10 transition group-hover:ring-[#2dd4bf]/40"
    />
  );
}

interface AudioActionSpec {
  id: string;
  slug: string;
  name: string;
  desc: string;
  iconType: "music" | "cover" | "vocal" | "split" | "sfx" | "sounds" | "extend" | "lyrics" | "speech" | "turbo" | "dialogue" | "isolate";
}

/** Движок в левой колонке аудио-пикера (Suno / ElevenLabs). */
interface AudioEngineSpec {
  id: string;
  name: string;
  tagline: string;
  accent: "orange" | "indigo";
  icon: React.ReactNode;
  items: AudioActionSpec[];
}

const SUNO_AUDIO_ACTIONS: AudioActionSpec[] = [
  {
    id: "suno-music",
    slug: "kie:suno-music",
    name: "Создание трека",
    desc: "Полная песня или инструментал по стилю / тексту (V5.5 / V5)",
    iconType: "music",
  },
  {
    id: "suno-upload-cover",
    slug: "kie:suno-upload-cover",
    name: "Кавер на своё аудио",
    desc: "Загрузи аудио → Suno создаст трек в новом стиле",
    iconType: "cover",
  },
  {
    id: "suno-add-vocals",
    slug: "kie:suno-add-vocals",
    name: "Добавить вокал",
    desc: "Инструментал + текст песни → готовый трек с вокалом",
    iconType: "vocal",
  },
  {
    id: "suno-separate-vocals",
    slug: "kie:suno-separate-vocals",
    name: "Разделить вокал / минус",
    desc: "Стем-сплиттер: разделение трека на вокал и музыку",
    iconType: "split",
  },
  {
    id: "elevenlabs-sfx",
    slug: "kie:elevenlabs-sfx",
    name: "Звуковые эффекты (SFX)",
    desc: "Foley-эффекты: шаги, взрывы, удары, окружение (без музыки)",
    iconType: "sfx",
  },
  {
    id: "suno-sounds",
    slug: "kie:suno-sounds",
    name: "Саундскейп и петли (Loops)",
    desc: "Короткие атмосферные фоны, петли и гармонии",
    iconType: "sounds",
  },
  {
    id: "suno-extend",
    slug: "kie:suno-extend",
    name: "Продлить трек",
    desc: "Продление уже созданного трека Suno по audioId",
    iconType: "extend",
  },
  {
    id: "suno-lyrics",
    slug: "kie:suno-lyrics",
    name: "Текст песни",
    desc: "Генерация текста и структуры куплетов/припевов по теме",
    iconType: "lyrics",
  },
];

const ELEVENLABS_AUDIO_ACTIONS: AudioActionSpec[] = [
  {
    id: "elevenlabs-v4",
    slug: "kie:elevenlabs-v4",
    name: "Озвучка ElevenLabs",
    desc: "Официальный ElevenLabs API: 200 русских премиум-голосов, клонирование и аудио-теги",
    iconType: "speech",
  },
];

function AudioActionIcon({ type }: { type: AudioActionSpec["iconType"] }) {
  switch (type) {
    case "music":
      return <Music className="h-4 w-4 text-[#2dd4bf]" />;
    case "cover":
      return <RotateCw className="h-4 w-4 text-amber-400" />;
    case "vocal":
      return <Mic className="h-4 w-4 text-rose-400" />;
    case "split":
      return <Scissors className="h-4 w-4 text-purple-400" />;
    case "sfx":
      return <Volume2 className="h-4 w-4 text-emerald-400" />;
    case "sounds":
      return <Radio className="h-4 w-4 text-teal-400" />;
    case "extend":
      return <Clock className="h-4 w-4 text-blue-400" />;
    case "lyrics":
      return <FileText className="h-4 w-4 text-pink-400" />;
    case "speech":
      return <Mic className="h-4 w-4 text-[#2dd4bf]" />;
    case "turbo":
      return <Sparkles className="h-4 w-4 text-amber-400" />;
    case "dialogue":
      return <Layers className="h-4 w-4 text-violet-400" />;
    case "isolate":
      return <Volume2 className="h-4 w-4 text-cyan-400" />;
    default:
      return <Music className="h-4 w-4 text-white/60" />;
  }
}

/** Бренды моделей для группировки в пикере: id, отображаемое имя, шаблон по slug/названию. */
const BRAND_RULES: { id: string; name: string; match: RegExp }[] = [
  { id: "seedance", name: "Seedance", match: /seedance|bytedance|doubao/i },
  { id: "google", name: "Google", match: /veo|nano-?banana|imagen|gemini/i },
  { id: "kling", name: "Kling", match: /kling/i },
  { id: "minimax", name: "MiniMax", match: /hailuo|minimax|video-01/i },
  { id: "wan", name: "Wan", match: /\bwan\b|alibaba|qwen/i },
  { id: "openai", name: "OpenAI", match: /sora|gpt-image|dall/i },
  { id: "runway", name: "Runway", match: /runway/i },
  { id: "luma", name: "Luma", match: /luma|\bray/i },
  { id: "bfl", name: "Black Forest Labs", match: /flux/i },
  { id: "midjourney", name: "Midjourney", match: /midjourney/i },
  { id: "ideogram", name: "Ideogram", match: /ideogram/i },
  { id: "recraft", name: "Recraft", match: /recraft/i },
  { id: "pika", name: "Pika", match: /pika/i },
  { id: "heygen", name: "HeyGen", match: /heygen/i },
  { id: "topaz", name: "Topaz", match: /topaz/i },
];

/** «1 модель / 2 модели / 5 моделей» — подпись счётчика в списке брендов. */
function countModelsLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "модель";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "модели";
  return "моделей";
}
function ModelPickerPopover({
  mediaType,
  selectedSlug,
  kieModels = [],
  creditUsd = 0.005,
  onSelect,
}: {
  mediaType: OutseeMediaType;
  selectedSlug: string;
  kieModels?: KieModelSpec[];
  creditUsd?: number;
  onSelect: (slug: string) => void;
}) {
  const [search, setSearch] = useState("");
  /** Модель, на которую наведён курсор: правая панель показывает именно её. */
  const [hoverSlug, setHoverSlug] = useState<string | null>(null);
  const isAudio = mediaType === "audio";
  /** Движок, к которому относится текущая выбранная модель. */
  const selectedEngineId = useMemo(
    () =>
      SUNO_AUDIO_ACTIONS.some(
        (a) => selectedSlug === a.slug || selectedSlug.replace(/^kie:/, "") === a.id,
      )
        ? "suno"
        : "elevenlabs",
    [selectedSlug],
  );
  const [hoverEngineId, setHoverEngineId] = useState<string | null>(null);
  const [openEngineId, setOpenEngineId] = useState<string | null>(null);

  const title =
    mediaType === "image"
      ? "Модели изображений"
      : mediaType === "video"
        ? "Модели видео"
        : "Аудио движки и режимы";
  const models = pickerModelsForType(mediaType);
  const kieForType = kieModels.filter((m) => {
    const id = m.id.toLowerCase();
    // GPT Image 2, Nano Banana 2, Veo 3.1 Lite — строго через Outsee!
    if (id.includes("veo") || id.includes("gpt-image") || id.includes("banana")) {
      return false;
    }
    const media =
      m.media || (m.category === "video" ? "video" : m.category === "image" ? "image" : "audio");
    return media === mediaType;
  });

  const q = search.trim().toLowerCase();

  const filteredSunoActions = useMemo(() => {
    if (!q) return SUNO_AUDIO_ACTIONS;
    return SUNO_AUDIO_ACTIONS.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.desc.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        "suno".includes(q),
    );
  }, [q]);

  const filteredElevenLabsActions = useMemo(() => {
    if (!q) return ELEVENLABS_AUDIO_ACTIONS;
    return ELEVENLABS_AUDIO_ACTIONS.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.desc.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        "elevenlabs".includes(q),
    );
  }, [q]);

  /** Движки аудио: слева движок, справа его действия (как бренды в видео/Kling). */
  const audioEngineList: AudioEngineSpec[] = [
    {
      id: "suno",
      name: "Suno AI",
      tagline: "Музыка & Звуки",
      accent: "orange",
      icon: <Music className="h-4 w-4" />,
      items: filteredSunoActions,
    },
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      tagline: "Голос & Речь",
      accent: "indigo",
      icon: <Mic className="h-4 w-4" />,
      items: filteredElevenLabsActions,
    },
  ];
  const audioEngines = audioEngineList.filter((engine) => engine.items.length > 0);
  const activeEngine =
    audioEngines.find(
      (engine) => engine.id === (hoverEngineId ?? openEngineId ?? selectedEngineId),
    ) ??
    audioEngines[0] ??
    null;

  const filteredModels = useMemo(() => {
    if (!q) return models;
    return models.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.slug.toLowerCase().includes(q),
    );
  }, [models, q]);

  const filteredKie = useMemo(() => {
    if (!q) return kieForType;
    return kieForType.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        (m.desc || "").toLowerCase().includes(q) ||
        (m.hint || "").toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q),
    );
  }, [kieForType, q]);

  const unifiedItems = useMemo(() => {
    // Collect icons from base models for quick lookup
    const iconBySlug = new Map<string, string>();
    for (const m of filteredModels) {
      if (m.icon) {
        iconBySlug.set(m.slug.toLowerCase(), m.icon);
        iconBySlug.set(m.slug.toLowerCase().replace(/[-_]/g, ""), m.icon);
      }
    }

    // Build authoritative KIE items first
    const kieModelIds = new Set<string>();
    const kieItems = filteredKie.map((m) => {
      const rawId = m.id.toLowerCase();
      const cleanId = rawId.replace(/[-_]/g, "");
      kieModelIds.add(rawId);
      kieModelIds.add(cleanId);
      const est = estimateKie(m, {}, creditUsd);

      const icon = modelIconForId(rawId, iconBySlug.get(rawId) || iconBySlug.get(cleanId));

      return {
        slug: `kie:${m.id}`,
        label: m.label,
        desc: m.hint || m.desc,
        icon,
        letter: m.label.slice(0, 1),
        isKie: true,
        isTop: Boolean(m.is_top || m.isTop),
        priceLabel: null as string | null,
        priceUsd: est.usd > 0 ? est.usd : null,
      };
    });

    // Only include remaining base models that are NOT present in KIE
    const remainingBaseItems = filteredModels
      .filter((m) => {
        const s = m.slug.toLowerCase();
        const c = s.replace(/[-_]/g, "");
        return !kieModelIds.has(s) && !kieModelIds.has(c);
      })
      .map((m) => ({
        slug: m.slug,
        label: m.displayName,
        desc: m.description,
        icon: modelIconForId(m.slug, m.icon),
        letter: null as string | null,
        isKie: false,
        isTop: Boolean(m.isTop || m.slug === "veo-3-1-lite"),
        priceLabel: m.price ? m.price : null,
        priceUsd: null as number | null,
      }));

    return [...kieItems, ...remainingBaseItems];
  }, [filteredModels, filteredKie, creditUsd]);

  const topItems = useMemo(() => unifiedItems.filter((i) => i.isTop), [unifiedItems]);
  const otherItems = useMemo(() => unifiedItems.filter((i) => !i.isTop), [unifiedItems]);


  // ---- модели, сгруппированные по брендам (как в эталоне) ----
  const brandOf = (item: (typeof unifiedItems)[number]): { id: string; name: string } => {
    const hay = `${item.slug} ${item.label}`.toLowerCase();
    const rule = BRAND_RULES.find((r) => r.match.test(hay));
    return rule ? { id: rule.id, name: rule.name } : { id: "other", name: "Другие" };
  };

  const brandGroups = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; items: (typeof unifiedItems)[number][]; tops: number }
    >();
    for (const item of unifiedItems) {
      const brand = brandOf(item);
      const group = map.get(brand.id) ?? { ...brand, items: [], tops: 0 };
      group.items.push(item);
      if (item.isTop) group.tops += 1;
      map.set(brand.id, group);
    }
    return [...map.values()].sort((a, b) => b.tops - a.tops || b.items.length - a.items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unifiedItems]);

  const selectedBrandId = useMemo(() => {
    const sel = unifiedItems.find((i) => i.slug === selectedSlug);
    return sel ? brandOf(sel).id : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unifiedItems, selectedSlug]);

  const [hoverBrandId, setHoverBrandId] = useState<string | null>(null);
  const [openBrandId, setOpenBrandId] = useState<string | null>(null);
  const activeBrand =
    brandGroups.find((b) => b.id === (hoverBrandId ?? openBrandId ?? selectedBrandId)) ?? brandGroups[0] ?? null;

  const renderModelRow = (item: (typeof unifiedItems)[number]) => {
    const active = item.slug === selectedSlug;
    const priceText =
      item.priceUsd !== null && item.priceUsd !== undefined
        ? `от $${item.priceUsd.toFixed(2)}`
        : item.priceLabel
          ? (/^от\s/i.test(item.priceLabel) ? item.priceLabel : `от ${item.priceLabel}`)
          : null;
    return (
      <button
        key={item.slug}
        type="button"
        onClick={() => onSelect(item.slug)}
        className={cn(
          "group flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition",
          active
            ? "border-[#2dd4bf] bg-[#2dd4bf]/12 shadow-[0_0_18px_rgba(45,212,191,0.18)]"
            : "border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]",
        )}
      >
        <ModelCardIcon
          icon={item.icon}
          label={item.label}
          letter={item.letter}
          isTopCard={item.isTop}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-[12px] font-semibold",
                active ? "text-[#2dd4bf]" : "text-white/90 group-hover:text-white",
              )}
            >
              {item.label}
            </span>
            {item.isTop && (
              <span className="shrink-0 rounded bg-[#2dd4bf]/15 px-1 py-0.5 font-mono text-[8px] font-bold uppercase text-[#2dd4bf]">
                топ
              </span>
            )}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-white/45 group-hover:text-white/60">
            {item.desc}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {priceText && <span className="font-mono text-[10px] text-[#5eead4]">{priceText}</span>}
          {active && <Check className="h-3.5 w-3.5 text-[#2dd4bf]" />}
        </span>
      </button>
    );
  };

  const renderAudioActionCard = (action: AudioActionSpec) => {
    const active = selectedSlug === action.slug || selectedSlug.replace(/^kie:/, "") === action.id;
    const kieM = kieForType.find((m) => m.id === action.id);
    const est = kieM ? estimateKie(kieM, {}, creditUsd) : null;
    const priceNote = kieM?.pricing?.note;

    return (
      <button
        key={action.slug}
        type="button"
        onClick={() => onSelect(action.slug)}
        className={cn(
          "group relative flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left transition-all duration-200",
          active
            ? "border-[#2dd4bf] bg-[#2dd4bf]/15 text-white shadow-[0_0_18px_rgba(45,212,191,0.2)] ring-1 ring-[#2dd4bf]/50"
            : "border-white/[0.08] bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.06]",
        )}
      >
        <div className="flex shrink-0 flex-col items-center pt-0.5">
          <div
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg ring-1 transition",
              active
                ? "bg-[#2dd4bf]/20 text-[#2dd4bf] ring-[#2dd4bf]/40"
                : "bg-white/[0.05] text-white/75 ring-white/10 group-hover:text-white",
            )}
          >
            <AudioActionIcon type={action.iconType} />
          </div>
        </div>
        <div className="min-w-0 flex-1 pr-2">
          <p
            className={cn(
              "truncate text-[12px] font-semibold",
              active ? "text-[#2dd4bf]" : "text-white/90 group-hover:text-white",
            )}
          >
            {action.name}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-white/45 group-hover:text-white/70">
            {action.desc}
          </p>
          <div className="mt-1 flex items-center gap-2">
            {priceNote ? (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-white/55">
                <Coins className="h-2.5 w-2.5 text-[#5eead4]" />
                {priceNote}
              </span>
            ) : est?.usd ? (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-white/55">
                <Coins className="h-2.5 w-2.5 text-[#5eead4]" />
                {`$${est.usd.toFixed(3)}`}
              </span>
            ) : null}
          </div>
        </div>
        {active && (
          <span className="absolute bottom-2.5 right-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#2dd4bf]/20 text-[#2dd4bf]">
            <Check className="h-3 w-3" />
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-3 flex max-h-[76vh] flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#121216]/95 backdrop-blur-2xl shadow-[0_25px_70px_rgba(0,0,0,0.85)] ring-1 ring-white/10"
      style={{
        width: mediaType === "video" ? 760 : mediaType === "audio" ? 560 : 700,
        // Окно фиксированной высоты: длинные списки моделей прокручиваются внутри,
        // а не растягивают меню выбора модели.
        height: "min(480px, 72vh)",
      }}
      role="dialog"
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Sticky Header with Search */}
      <div className="shrink-0 border-b border-white/[0.08] bg-[#16161b]/95 p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold tracking-tight text-white/90">{title}</span>
          </div>
        </div>
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-white/40" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              isAudio
                ? "Поиск действия (трек, кавер, озвучка, диалог, SFX)..."
                : "Быстрый поиск модели (Kling, Nano, Flux, Veo, Sora...)"
            }
            className="h-8 w-full rounded-xl border border-white/10 bg-black/40 pl-8 pr-7 text-[11px] text-white/90 placeholder:text-white/30 transition focus:border-[#2dd4bf]/60 focus:outline-none focus:ring-1 focus:ring-[#2dd4bf]/30"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 text-white/40 hover:text-white"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {isAudio ? (
        /* Аудио: слева движки Suno / ElevenLabs, справа прокручиваемый список действий */
        <div className="flex min-h-0 flex-1">
          <div
            className="w-[188px] shrink-0 overflow-y-auto border-r border-white/[0.08] p-2"
            role="tablist"
            aria-label="Движки"
          >
            <p className="mb-1.5 px-1 text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">
              Движок
            </p>
            {audioEngines.map((engine) => {
              const isActive = activeEngine?.id === engine.id;
              const hasSelected = engine.items.some(
                (a) => selectedSlug === a.slug || selectedSlug.replace(/^kie:/, "") === a.id,
              );
              return (
                <button
                  key={engine.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-engine={engine.id}
                  onMouseEnter={() => setHoverEngineId(engine.id)}
                  onFocus={() => setHoverEngineId(engine.id)}
                  onClick={() => {
                    setOpenEngineId(engine.id);
                    setHoverEngineId(engine.id);
                  }}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-xl border px-2 py-2 text-left transition",
                    isActive
                      ? "border-[#2dd4bf]/45 bg-[#2dd4bf]/10"
                      : "border-transparent hover:border-white/10 hover:bg-white/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1",
                      engine.accent === "orange"
                        ? isActive
                          ? "bg-orange-500/20 text-orange-300 ring-orange-500/40"
                          : "bg-white/[0.05] text-white/60 ring-white/10"
                        : isActive
                          ? "bg-indigo-500/20 text-indigo-300 ring-indigo-500/40"
                          : "bg-white/[0.05] text-white/60 ring-white/10",
                    )}
                  >
                    {engine.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[12px] font-semibold",
                        isActive ? "text-white" : "text-white/85",
                      )}
                    >
                      {engine.name}
                    </span>
                    <span className="block font-mono text-[9px] text-white/35">
                      {engine.items.length} {countModelsLabel(engine.items.length)}
                    </span>
                  </span>
                  {hasSelected && <Check className="h-3 w-3 shrink-0 text-[#2dd4bf]" />}
                </button>
              );
            })}
            {audioEngines.length === 0 && (
              <div className="px-2 py-8 text-center text-[11px] leading-relaxed text-white/40">
                По запросу «<span className="text-white/70">{search}</span>» движков нет
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-3" data-audio-list="true">
            {activeEngine ? (
              <>
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white/45">
                    {activeEngine.name}
                    <span
                      className={cn(
                        "rounded px-1 py-0.5 font-mono text-[8px] font-bold normal-case tracking-normal",
                        activeEngine.accent === "orange"
                          ? "bg-orange-500/15 text-orange-300"
                          : "bg-indigo-500/15 text-indigo-300",
                      )}
                    >
                      {activeEngine.tagline}
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-white/30">
                    {activeEngine.items.length} {countModelsLabel(activeEngine.items.length)}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {activeEngine.items.map((action) => renderAudioActionCard(action))}
                </div>
              </>
            ) : (
              <div className="py-12 text-center text-[12px] text-white/40">
                Действия по запросу «<span className="text-white/70">{search}</span>» не найдены
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Видео/Фото: слева бренды, справа модели выбранного бренда */
        <div className="flex min-h-0 flex-1">
          <div
            className="w-[214px] shrink-0 overflow-y-auto border-r border-white/[0.08] p-2"
            role="tablist"
            aria-label="Бренды"
          >
            <p className="mb-1.5 px-1 text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">
              Бренд
            </p>
            {brandGroups.map((brand) => {
              const isActive = activeBrand?.id === brand.id;
              const hasSelected = brand.items.some((i) => i.slug === selectedSlug);
              return (
                <button
                  key={brand.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-brand={brand.id}
                  onMouseEnter={() => setHoverBrandId(brand.id)}
                  onFocus={() => setHoverBrandId(brand.id)}
                  onClick={() => {
                    setOpenBrandId(brand.id);
                    setHoverBrandId(brand.id);
                  }}
                  className={cn(
                    "mb-1 flex w-full items-center gap-2 rounded-xl border px-2 py-2 text-left transition",
                    isActive
                      ? "border-[#2dd4bf]/45 bg-[#2dd4bf]/10"
                      : "border-transparent hover:border-white/10 hover:bg-white/[0.04]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-[11px] font-bold ring-1",
                      isActive
                        ? "bg-[#2dd4bf]/20 text-[#2dd4bf] ring-[#2dd4bf]/40"
                        : "bg-white/[0.05] text-white/60 ring-white/10",
                    )}
                  >
                    {brand.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[12px] font-semibold",
                        isActive ? "text-white" : "text-white/85",
                      )}
                    >
                      {brand.name}
                    </span>
                    <span className="block font-mono text-[9px] text-white/35">
                      {brand.items.length} {countModelsLabel(brand.items.length)}
                    </span>
                  </span>
                  {hasSelected && <Check className="h-3 w-3 shrink-0 text-[#2dd4bf]" />}
                  {!hasSelected && brand.tops > 0 && brandGroups[0]?.id === brand.id && (
                    <span className="shrink-0 rounded bg-[#2dd4bf]/15 px-1 py-0.5 font-mono text-[8px] font-bold uppercase text-[#2dd4bf]">
                      топ
                    </span>
                  )}
                </button>
              );
            })}
            {brandGroups.length === 0 && (
              <div className="px-2 py-8 text-center text-[11px] leading-relaxed text-white/40">
                По запросу «<span className="text-white/70">{search}</span>» брендов нет
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {activeBrand ? (
              <>
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/45">
                    {activeBrand.name}
                  </span>
                  <span className="font-mono text-[10px] text-white/30">
                    {activeBrand.items.length} {countModelsLabel(activeBrand.items.length)}
                  </span>
                </div>
                <div className="space-y-1.5">{activeBrand.items.map((item) => renderModelRow(item))}</div>
              </>
            ) : (
              <div className="py-12 text-center text-[12px] text-white/40">
                Модели по запросу «<span className="text-white/70">{search}</span>» не найдены
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
