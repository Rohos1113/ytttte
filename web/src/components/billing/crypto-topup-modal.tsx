"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createPortal } from "react-dom";
import { StatusPill, ACCENT, card } from "./crypto-ui";

/**
 * Оплата криптой: счёт Bitcart через прокси студии.
 * Контракт ответов — docs/CRYPTO-TOPUP-CONTRACT.md §8.
 * Суммы и кредиты приходят строками, во float их не переводим: числа нужны только
 * для проверки ввода и сортировки, не для арифметики.
 */

export type CryptoMethod = {
  asset: string;
  network: string;
  label: string;
  amount: string;
  address: string;
  uri: string;
  required_confirmations?: number;
  sender_address_required?: boolean;
};

export type CryptoInvoice = {
  id: string;
  status: string;
  amount_usd: string;
  credits: string;
  expires_at?: string | null;
  methods?: CryptoMethod[];
  warning?: string;
  credited_credits?: string | null;
  settled_at?: string | null;
  stale?: boolean;
  updated_at?: string | null;
};

const PRESETS = ["5", "10", "25", "50", "100"];
const POLL_MS = 4000;
/** Статусы, после которых опрашивать нечего. */
const TERMINAL = new Set(["credited", "partial", "expired", "invalid", "error", "refunded"]);
const FAILED = new Set(["partial", "expired", "invalid", "error", "refunded"]);

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Сумма для отправки: строка с точкой, 1–2 знака после. Пустая — ввод не принят. */
function normalizeAmount(raw: string): string {
  const s = raw.trim().replace(/\s+/g, "").replace(",", ".").replace(/^\$/, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return "";
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "";
  return s;
}

/** Время без зоны считаем UTC (как весь бэкенд), иначе браузер поймёт его как локальное. */
function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const raw = String(iso).trim();
  if (!raw) return null;
  const normalized = !raw.endsWith("Z") && !/[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw}Z` : raw;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clockMsk(d: Date): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}

function leftLabel(sec: number): string {
  if (sec <= 0) return "00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

function statusInfo(inv: CryptoInvoice): { text: string; pill: "успешно" | "ожидает" | "ошибка" } {
  const st = norm(inv.status);
  if (st === "credited") return { text: `Зачислено, ${inv.credited_credits || inv.credits} кредитов`, pill: "успешно" };
  if (st === "paid" || st === "confirmed" || st === "unconfirmed")
    return { text: "Оплата пришла — ждём подтверждение сети", pill: "ожидает" };
  if (st === "partial") return { text: "Пришло меньше суммы, разберём вручную", pill: "ошибка" };
  if (st === "expired") return { text: "Время оплаты вышло, счёт закрыт", pill: "ошибка" };
  if (st === "invalid") return { text: "Счёт недействителен, оплата не принята", pill: "ошибка" };
  if (st === "refunded") return { text: "Средства вернули, кредиты не начислены", pill: "ошибка" };
  if (st === "error") return { text: "Шлюз не смог провести счёт", pill: "ошибка" };
  return { text: "Ждём оплату", pill: "ожидает" };
}

/** Человеческий текст под статусом: что делать дальше. */
function statusHint(inv: CryptoInvoice, gone: boolean): string {
  const st = norm(inv.status);
  if (st === "credited") return "Кредиты уже на балансе, счёт закрыт.";
  if (st === "partial") return "Пришла только часть суммы. Кредиты пока не начислены — напиши в поддержку и приложи хеш перевода.";
  if (st === "expired") return "Никто не заплатил вовремя. Если ты уже отправил — напиши в поддержку с хешем перевода, деньги не потеряются.";
  if (st === "invalid") return "Шлюз отклонил счёт. Начни заново и отправь точную сумму в указанной сети.";
  if (st === "refunded") return "Перевод ушёл обратно отправителю. Начни заново, если хочешь пополнить.";
  if (st === "error") return "Ошибка на стороне шлюза. Начни заново — новый счёт обычно создаётся нормально.";
  if (gone) return "Счёт больше недоступен: возможно, истёк или закрыт. Начни заново.";
  if (st === "paid" || st === "confirmed" || st === "unconfirmed")
    return "Обычно это секунды или минуты. Кредиты запишутся сами, страницу закрывать не обязательно.";
  return "Отправь ровно указанную сумму в указанной сети. Кредиты придут сами после подтверждения.";
}

const btnBase = "h-10 rounded-[10px] px-3.5 text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const label = "mb-1.5 text-[12px] uppercase tracking-[0.1em] text-zinc-500";
const mono = "font-mono text-[13px] leading-relaxed text-zinc-200 break-all";

export function CryptoTopupModal({ onClose, onCredited }: { onClose: () => void; onCredited?: () => void }) {
  const [amount, setAmount] = useState("10");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [invoice, setInvoice] = useState<CryptoInvoice | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pollDead, setPollDead] = useState(false);

  const [copiedKey, setCopiedKey] = useState("");
  const [copyFailed, setCopyFailed] = useState(false);

  const [expiresMs, setExpiresMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(0);

  const notifiedRef = useRef(false);
  // Защита от двойного клика: состояние обновляется не мгновенно, поэтому гасим рефом.
  const creatingRef = useRef(false);

  const statusKey = norm(invoice?.status);
  const terminal = invoice ? TERMINAL.has(statusKey) : true;
  const failed = invoice ? FAILED.has(statusKey) : false;
  const methods = useMemo(() => invoice?.methods ?? [], [invoice]);
  // Список методов может поменяться после опроса сервера — держим индекс в границах.
  const selIndex = methods.length === 0 ? -1 : Math.min(Math.max(selectedIdx, 0), methods.length - 1);
  const selected = selIndex >= 0 ? methods[selIndex] : null;
  const invoiceId = invoice?.id ?? null;

  // Колбэк только на первый переход в credited: баланс обновляем один раз.
  useEffect(() => {
    if (statusKey !== "credited" || notifiedRef.current) return;
    notifiedRef.current = true;
    onCredited?.();
  }, [statusKey, onCredited]);

  // Счёт живёт в expires_at: показываем обратный отсчёт до времени из ответа.
  useEffect(() => {
    const at = toDate(invoice?.expires_at);
    setExpiresMs(at ? at.getTime() : null);
  }, [invoice?.expires_at]);

  useEffect(() => {
    if (expiresMs == null) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresMs]);

  // Поллинг статуса: каждые 4 с, пока не терминальный статус и не закрыта модалка.
  useEffect(() => {
    if (!invoiceId || terminal || pollDead) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await fetch(`/api/billing/topup/crypto/${encodeURIComponent(invoiceId)}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!alive) return;
        if (r.ok) {
          const data = (await r.json()) as { invoice?: CryptoInvoice | null };
          if (alive && data?.invoice) setInvoice(data.invoice);
        } else if (r.status === 404) {
          // Счёт удалён или чужой — дальше опрашивать бессмысленно.
          setPollDead(true);
          return;
        }
      } catch {
        /* сеть моргнула — попробуем ещё через 4 с */
      }
      if (alive) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [invoiceId, terminal, pollDead]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!copiedKey) return;
    const t = setTimeout(() => setCopiedKey(""), 2000);
    return () => clearTimeout(t);
  }, [copiedKey]);

  const copyValue = useCallback(async (key: string, text: string) => {
    if (!text) return;
    setCopyFailed(false);
    if (!navigator.clipboard) {
      setCopyFailed(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
    } catch {
      setCopyFailed(true);
    }
  }, []);

  async function readDetail(r: Response): Promise<string> {
    try {
      const data = (await r.json()) as { detail?: unknown };
      const d = data?.detail;
      if (typeof d === "string" && d.trim()) return d.trim();
      if (Array.isArray(d) && d.length > 0) return "Сервер не принял данные — проверь сумму.";
    } catch {
      /* ответ не JSON */
    }
    if (r.status === 400) return "Сервер не принял сумму. Проверь лимиты и попробуй снова.";
    if (r.status === 429) return "Слишком много открытых счетов — дождись оплаты или истечения старых.";
    if (r.status === 503) return "Пополнение криптовалютой сейчас недоступно. Попробуйте позже.";
    if (r.status === 502) return "Шлюз оплаты не отвечает. Попробуй ещё раз через минуту.";
    return `Не получилось создать счёт (код ${r.status}). Попробуй ещё раз.`;
  }

  async function createInvoice() {
    if (creatingRef.current) return;
    const clean = normalizeAmount(amount);
    if (!clean) {
      setFormError("Введи сумму в долларах — целые или с копейками, например 10 или 12.50");
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setFormError(null);
    try {
      const r = await fetch("/api/billing/topup/crypto", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_usd: clean }),
      });
      if (!r.ok) {
        setFormError(await readDetail(r));
        return;
      }
      const data = (await r.json()) as { invoice?: CryptoInvoice | null };
      if (!data?.invoice) {
        setFormError("Сервер не вернул счёт. Попробуй ещё раз.");
        return;
      }
      notifiedRef.current = false;
      setPollDead(false);
      setSelectedIdx(0);
      setInvoice(data.invoice);
    } catch {
      setFormError("Сеть не ответила — проверь соединение и попробуй снова.");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  function restart() {
    notifiedRef.current = false;
    setInvoice(null);
    setPollDead(false);
    setSelectedIdx(0);
    setFormError(null);
    setCopiedKey("");
    setCopyFailed(false);
  }

  const expiresAt = toDate(invoice?.expires_at);
  const leftSec = expiresMs != null && nowMs > 0 ? Math.max(0, Math.round((expiresMs - nowMs) / 1000)) : null;
  const expiredLocally = leftSec === 0;
  const info = invoice ? statusInfo(invoice) : null;

  const warning =
    invoice?.warning?.trim() ||
    (selected
      ? `Отправляй только ${selected.label || selected.asset} в сети ${selected.network || "как указано"}. Другая монета или сеть — деньги потеряются.`
      : "Отправляй только ту монету и в той сети, что указаны в счёте. Иначе деньги потеряются.");

  // Портал: панель «Оплата» живёт с CSS-трансформом, и fixed-модалка внутри неё
  // позиционировалась бы по панели, а не по окну.
  const modal = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Пополнение криптовалютой"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[calc(100vh-32px)] w-full max-w-[440px] flex-col overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#141417] shadow-2xl"
        style={{ fontFamily: "Rubik, sans-serif" }}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-[17px] font-medium text-white">Пополнить криптовалютой</span>
            {invoice && info ? <StatusPill s={info.pill} /> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[18px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {!invoice ? (
            <>
              <div>
                <div className={label}>Сумма пополнения</div>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((v) => {
                    const on = normalizeAmount(amount) === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        disabled={creating}
                        onClick={() => {
                          setAmount(v);
                          setFormError(null);
                        }}
                        className="h-9 rounded-[10px] px-3 text-[14px] transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                        style={
                          on
                            ? { background: "rgba(45,212,191,0.16)", color: ACCENT }
                            : { background: "rgba(255,255,255,0.05)", color: "#d4d4d8" }
                        }
                      >
                        ${v}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className={label} htmlFor="crypto-amount">
                  Своя сумма, $
                </label>
                <input
                  id="crypto-amount"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setFormError(null);
                  }}
                  inputMode="decimal"
                  placeholder="например 15"
                  disabled={creating}
                  className="h-10 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-3 text-[15px] text-white outline-none placeholder:text-zinc-600 focus:border-teal-400/40 disabled:opacity-60"
                />
                <div className="mt-1.5 text-[12px] text-zinc-600">Курс и минимальную сумму проверит сервер.</div>
              </div>

              {formError ? (
                <div className="rounded-[10px] border border-red-400/25 bg-red-400/[0.08] px-3 py-2 text-[13px] text-red-200">
                  {formError}
                </div>
              ) : null}

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={createInvoice}
                  disabled={creating || !normalizeAmount(amount)}
                  className={btnBase + " font-medium"}
                  style={{ background: "rgba(45,212,191,0.16)", color: ACCENT }}
                >
                  {creating ? "Создаю счёт…" : "Продолжить"}
                </button>
                <button type="button" onClick={onClose} className={btnBase + " text-zinc-300 hover:bg-white/[0.06]"}>
                  Отмена
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={card + " p-3"}>
                <div className="text-sm text-zinc-500">Счёт на ${invoice.amount_usd}</div>
                <div className="mt-1 text-[15px] text-zinc-200">{info?.text}</div>
                <div className="mt-1.5 text-[12.5px] leading-relaxed text-zinc-500">{statusHint(invoice, pollDead)}</div>
                {invoice.stale ? (
                  <div className="mt-1.5 text-[12px] text-amber-200/70">
                    Данные могли устареть: сервер не смог обновить статус, показываю последнее известное.
                  </div>
                ) : null}
              </div>

              {statusKey === "credited" ? (
                <div className="rounded-[10px] border border-teal-400/25 bg-teal-400/[0.08] px-3 py-2 text-[13px] text-teal-100">
                  Зачислено {invoice.credited_credits || invoice.credits} кредитов. Баланс в панели уже обновлён.
                </div>
              ) : failed ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={restart}
                    className={btnBase + " font-medium"}
                    style={{ background: "rgba(45,212,191,0.16)", color: ACCENT }}
                  >
                    Начать заново
                  </button>
                  <button type="button" onClick={onClose} className={btnBase + " text-zinc-300 hover:bg-white/[0.06]"}>
                    Закрыть
                  </button>
                </div>
              ) : null}

              {!terminal && methods.length === 0 ? (
                <div className="rounded-[10px] border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2 text-[13px] text-amber-100">
                  Шлюз не вернул ни одного способа оплаты. Обнови статус или начни заново.
                </div>
              ) : null}

              {!terminal || statusKey === "credited" ? (
                <>
                  {!terminal ? (
                    <>
                      {methods.length > 0 ? (
                        <div>
                          <div className={label}>Чем платить</div>
                          <div className="space-y-1.5" role="radiogroup" aria-label="Способ оплаты">
                            {methods.map((m, i) => {
                              const on = i === selIndex;
                              return (
                                <button
                                  key={`${m.asset}:${m.network}:${m.address}:${i}`}
                                  type="button"
                                  role="radio"
                                  aria-checked={on}
                                  onClick={() => setSelectedIdx(i)}
                                  className={
                                    card +
                                    " flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
                                  }
                                  style={on ? { borderColor: "rgba(45,212,191,0.5)" } : undefined}
                                >
                                  <span
                                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border"
                                    style={{ borderColor: on ? ACCENT : "#52525b" }}
                                  >
                                    {on ? <span className="h-2 w-2 rounded-full" style={{ background: ACCENT }} /> : null}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[14px] text-zinc-200">
                                      {m.label || `${m.asset} (${m.network})`}
                                    </span>
                                    <span className="block truncate text-[11px] text-zinc-500">
                                      {m.network || "сеть не указана"}
                                    </span>
                                  </span>
                                  <span className="shrink-0 text-right text-[13px] text-zinc-200">
                                    {m.amount} {m.asset?.toUpperCase()}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {selected ? (
                        <>
                          <div className="rounded-[10px] border border-amber-400/25 bg-amber-400/[0.07] px-3 py-2.5 text-[14px] font-medium leading-relaxed text-amber-100">
                            {warning}
                          </div>

                          <div>
                            <div className={label}>Адрес получателя</div>
                            <div className={card + " px-3 py-2.5"}>
                              <div className={mono}>{selected.address}</div>
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => copyValue("address", selected.address)}
                                  className="h-8 rounded-[8px] px-2.5 text-[13px] transition-colors"
                                  style={{ background: "rgba(45,212,191,0.16)", color: ACCENT }}
                                >
                                  {copiedKey === "address" ? "Скопировано" : "Скопировать адрес"}
                                </button>
                                <span className="text-[12px] text-zinc-500">
                                  Сумма: {selected.amount} {selected.asset?.toUpperCase()}
                                </span>
                              </div>
                            </div>
                          </div>

                          {selected.uri ? (
                            <div>
                              <div className={label}>Ссылка для кошелька</div>
                              <div className={card + " px-3 py-2.5"}>
                                <div className={mono}>{selected.uri}</div>
                                <div className="mt-2">
                                  <button
                                    type="button"
                                    onClick={() => copyValue("uri", selected.uri)}
                                    className="h-8 rounded-[8px] px-2.5 text-[13px] transition-colors"
                                    style={{ background: "rgba(45,212,191,0.16)", color: ACCENT }}
                                  >
                                    {copiedKey === "uri" ? "Скопировано" : "Скопировать ссылку"}
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : null}

                          <div className="rounded-[10px] border border-dashed border-white/[0.12] bg-white/[0.02] px-3 py-3 text-center">
                            <div className="text-[12px] uppercase tracking-[0.1em] text-zinc-500">QR</div>
                            <div className="mt-2 flex justify-center rounded-[8px] bg-white p-2">
                              <QRCodeSVG
                                value={selected.uri || selected.address}
                                size={168}
                                level="M"
                                bgColor="#ffffff"
                                fgColor="#000000"
                              />
                            </div>
                            <div className="mt-1.5 text-[12px] text-zinc-500">
                              Наведи камеру кошелька или скопируй адрес.
                            </div>
                          </div>
                        </>
                      ) : null}

                      {copyFailed ? (
                        <div className="text-[12px] text-amber-200/80">
                          Не вышло скопировать автоматически — выдели текст и скопируй вручную.
                        </div>
                      ) : null}

                      {expiresAt ? (
                        <div className="flex items-center justify-between gap-2 rounded-[10px] px-1 text-[13px]">
                          <span className="text-zinc-500">Оплатить до {clockMsk(expiresAt)} (МСК)</span>
                          <span className="font-mono text-[15px]" style={{ color: expiredLocally ? "#f87171" : "#e4e4e7" }}>
                            {leftSec != null ? leftLabel(leftSec) : "—"}
                          </span>
                        </div>
                      ) : null}

                      {expiredLocally && !terminal ? (
                        <div className="text-[12px] text-amber-200/80">
                          Время вышло. Если ты уже отправил — ждём подтверждение сети, счёт закроется сам.
                        </div>
                      ) : null}

                      <div className="flex flex-wrap gap-2 pt-1">
                        <button type="button" onClick={restart} className={btnBase + " text-zinc-300 hover:bg-white/[0.06]"}>
                          Начать заново
                        </button>
                        <button type="button" onClick={onClose} className={btnBase + " text-zinc-300 hover:bg-white/[0.06]"}>
                          Закрыть
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={restart}
                        className={btnBase + " font-medium"}
                        style={{ background: "rgba(45,212,191,0.16)", color: ACCENT }}
                      >
                        Начать заново
                      </button>
                      <button type="button" onClick={onClose} className={btnBase + " text-zinc-300 hover:bg-white/[0.06]"}>
                        Готово
                      </button>
                    </div>
                  )}
                </>
              ) : null}

              <div className="text-[11px] text-zinc-600">
                Счёт {invoice.id.slice(0, 8)}
                {methods.length > 0 ? ` · способов оплаты: ${methods.length}` : ""}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
