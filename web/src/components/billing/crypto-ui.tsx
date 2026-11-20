"use client";

/**
 * Мелкие элементы оформления, которые нужны крипто-модалке.
 *
 * В новой линии панель оплаты переехала в шапку (`shell/balance-badge.tsx`),
 * и прежнего общего набора `panels/left-bottom/ui` больше нет. Держим здесь
 * только то, что реально используется: акцентный цвет и статус-пилюлю.
 */

export const ACCENT = "#2dd4bf";

export const card = "rounded-[12px] border border-white/[0.06] bg-white/[0.03]";

const PILL: Record<string, string> = {
  успешно: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  ожидает: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  ошибка: "border-rose-400/30 bg-rose-400/10 text-rose-300",
};

export function StatusPill({ s }: { s: "успешно" | "ожидает" | "ошибка" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${PILL[s] ?? ""}`}
    >
      {s}
    </span>
  );
}
