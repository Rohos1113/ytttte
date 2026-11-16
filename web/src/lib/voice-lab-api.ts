/**
 * Клиент ручек `/api/voice-lab` — реестр клонированных голосов ElevenLabs.
 *
 * Один файл-источник правды для типов и запросов: модалка «Голоса» и мастер
 * клонирования берут контракт отсюда. Бэкенд — `app/web/routers/voice_lab.py`.
 *
 * Ручек нет у участника: middleware отдаёт ему 404 на весь префикс. Для UI это
 * не ошибка, а признак «клонирование недоступно» — поэтому 404/401/403
 * разбираются отдельно (`isVoiceLabUnavailable`), а интерфейс просто прячет
 * кнопку клонирования. Остальная библиотека голосов работает как раньше.
 */

import { authHeaders } from "@/lib/identity-api";

/** Статус клона в реестре студии. `pending_provider` — сэмплы есть, ключа нет. */
export type VoiceLabStatus = "ready" | "pending_provider" | "error" | string;

export interface VoiceLabVoice {
  id: string;
  name: string;
  description: string;
  language: string;
  status: VoiceLabStatus;
  source: string;
  /** Путь к загруженному образцу; null — образца нет. */
  sample_url: string | null;
  external_voice_id: string | null;
  created_at: string | null;
  samples_count?: number;
  duration_sec?: number;
}

export interface VoiceLabList {
  /** Задан ли ключ ElevenLabs в студии. */
  configured: boolean;
  daily_used: number;
  daily_limit: number;
  voices: VoiceLabVoice[];
}

export interface VoiceLabCreateResult {
  voice: VoiceLabVoice;
  /** Текст ошибки провайдера: голос остался `pending_provider`, сэмплы целы. */
  provider_error: string | null;
}

export interface NewVoiceClone {
  name: string;
  description?: string;
  language?: string;
  /** Тип клонирования: `instant` — мгновенное (IVC). */
  kind?: string;
  samples: File[];
}

/** Лимит суммарного размера сэмплов на одно создание (совпадает с бэкендом). */
export const CLONE_SAMPLE_MAX_BYTES = 25 * 1024 * 1024;
/** Расширения, которые принимает бэкенд. */
export const CLONE_SAMPLE_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "flac"];

/** Ошибка voice-lab с HTTP-статусом: по нему UI отличает «нет прав» от прочих сбоев. */
export class VoiceLabHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VoiceLabHttpError";
    this.status = status;
  }
}

/** 404/401/403 — ручек нет или нет прав (участник студии): клонирование не показываем. */
export function isVoiceLabUnavailable(error: unknown): boolean {
  return (
    error instanceof VoiceLabHttpError &&
    (error.status === 404 || error.status === 401 || error.status === 403)
  );
}

/** Текст `detail` из ответа FastAPI: строка или список ошибок валидации. */
function detailText(data: unknown, status: number): string {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === "string") return item;
        const msg = (item as { msg?: unknown } | null)?.msg;
        return typeof msg === "string" ? msg : "";
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  return `HTTP ${status}`;
}

async function voiceLabRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`/api/voice-lab${path}`, {
    ...init,
    headers,
    // Сессия студии живёт в cookie — при same-origin шлём её всегда.
    credentials: "same-origin",
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ (DELETE) — это норма */
  }
  if (!res.ok) {
    throw new VoiceLabHttpError(detailText(data, res.status), res.status);
  }
  return data as T;
}

/** Реестр клонов: `{configured, daily_used, daily_limit, voices}`. */
export function listVoiceLabVoices(): Promise<VoiceLabList> {
  return voiceLabRequest<VoiceLabList>("/voices");
}

/** Создание клона: multipart с файлами в поле `samples`. */
export function createVoiceClone(input: NewVoiceClone): Promise<VoiceLabCreateResult> {
  const form = new FormData();
  form.append("name", input.name.trim());
  form.append("description", (input.description ?? "").trim());
  form.append("language", input.language ?? "ru");
  form.append("kind", input.kind ?? "instant");
  for (const file of input.samples) {
    form.append("samples", file, file.name);
  }
  return voiceLabRequest<VoiceLabCreateResult>("/clones", {
    method: "POST",
    body: form,
  });
}

/** Переименование / правка описания. */
export function updateVoiceClone(
  id: string,
  patch: { name?: string; description?: string },
): Promise<{ voice: VoiceLabVoice }> {
  return voiceLabRequest<{ voice: VoiceLabVoice }>(`/clones/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** Удаление клона. Бэкенд может ответить 409, если голос занят в проектах. */
export function deleteVoiceClone(id: string): Promise<{ deleted: boolean }> {
  return voiceLabRequest<{ deleted: boolean }>(`/clones/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Ссылка на образец клона, если бэкенд не прислал `sample_url`. */
export function voiceLabSampleUrl(id: string, index = 0): string {
  return `/api/voice-lab/clones/${encodeURIComponent(id)}/sample?index=${index}`;
}

/** Подпись статуса клона для бейджа. */
export function voiceLabStatusLabel(status: VoiceLabStatus): string {
  switch (status) {
    case "ready":
      return "Готов";
    case "pending_provider":
      return "Ждёт ключа ElevenLabs";
    case "error":
    case "failed":
      return "Ошибка";
    case "training":
      return "Обучается";
    case "deleted":
      return "Удалён";
    default:
      return status || "Неизвестно";
  }
}

/** Клон, готовый к озвучке: только его имеет смысл подставлять в проект. */
export function isVoiceCloneReady(voice: VoiceLabVoice): boolean {
  return voice.status === "ready";
}

/** «12,4 МБ» — размер файла сэмпла в человеческом виде. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

/** Расширение файла в нижнем регистре без точки. */
export function sampleExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}
