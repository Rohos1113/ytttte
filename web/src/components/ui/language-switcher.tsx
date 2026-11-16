"use client";

import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
  variant?: "segmented" | "compact";
}

export function LanguageSwitcher({ className, variant = "segmented" }: Props) {
  const { locale, setLocale } = useTranslation();

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={() => setLocale(locale === "ru" ? "en" : "ru")}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-[11px] font-semibold text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.08] hover:text-white",
          className,
        )}
        title={locale === "ru" ? "Switch to English" : "Переключить на русский"}
        aria-label="Переключение языка"
      >
        {locale.toUpperCase()}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border border-white/10 bg-black/40 p-0.5 text-xs select-none",
        className,
      )}
      role="group"
      aria-label="Language"
    >
      <button
        type="button"
        onClick={() => setLocale("ru")}
        className={cn(
          "rounded-md px-2.5 py-1 text-[11px] font-medium transition-all",
          locale === "ru"
            ? "bg-white/15 text-white shadow-sm"
            : "text-zinc-400 hover:text-zinc-200",
        )}
      >
        RU
      </button>
      <button
        type="button"
        onClick={() => setLocale("en")}
        className={cn(
          "rounded-md px-2.5 py-1 text-[11px] font-medium transition-all",
          locale === "en"
            ? "bg-white/15 text-white shadow-sm"
            : "text-zinc-400 hover:text-zinc-200",
        )}
      >
        EN
      </button>
    </div>
  );
}
