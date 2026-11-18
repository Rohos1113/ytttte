"use client";

/**
 * Меню «Шаги на доске» — показать/скрыть любую строку монтажа у места клика.
 *
 * Открывается правым кликом по доске (в точке курсора) или кнопкой «⋯» в липкой
 * первой колонке строки (рядом с кнопкой). Список — все строки доски: пять
 * спец-строк (Кадры, Закадр кадра / Закадровый текст, Действие кадра, Видео 1,
 * Таймкоды) и обобщённые строки остальных шагов графа (`node:<node_key>`).
 * Скрытые строки остаются в списке с пометкой «скрыта» — иначе их не вернуть.
 *
 * Никакого модального затемнения: доска остаётся видна и живая, меню — просто
 * карточка у курсора, закрывается по Esc и клику вне.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";

/** Одна строка в меню: ключ в `meta.montage_rows_visible`, подпись, состояние. */
export interface MontageRowsMenuItem {
  key: string;
  label: string;
  visible: boolean;
  /** Кто из шагов питает строку — чтобы спец-строка была узнаваема. */
  hint?: string;
}

const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 420;
const VIEWPORT_MARGIN = 10;

export function MontageRowsMenu({
  items,
  x,
  y,
  onToggle,
  onClose,
}: {
  items: MontageRowsMenuItem[];
  /** Точка открытия меню (координаты курсора или кнопки «⋯»). */
  x: number;
  y: number;
  onToggle: (rowKey: string, visible: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: Math.max(VIEWPORT_MARGIN, x),
    top: Math.max(VIEWPORT_MARGIN, y),
  });

  // Держим карточку в окне: если у курсора справа/внизу нет места — сдвигаем.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const height = Math.min(el.scrollHeight, MENU_MAX_HEIGHT);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, x),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, y),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
    );
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Доска монтажа тоже слушает Esc: гасим только меню на capture.
      event.stopImmediatePropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Шаги на доске"
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH, maxHeight: MENU_MAX_HEIGHT }}
      className="fixed z-[10076] flex flex-col overflow-hidden rounded-lg border border-white/15 bg-[#101013] shadow-2xl"
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2.5 py-2">
        <p className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-white/55">
          Шаги на доске
        </p>
        <span className="shrink-0 text-[10px] text-white/30">клик — показать/скрыть</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitemcheckbox"
            aria-checked={item.visible}
            aria-pressed={item.visible}
            title={item.visible ? "скрыть строку" : "показать строку"}
            onClick={() => onToggle(item.key, !item.visible)}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition",
              "hover:bg-white/[0.06]",
            )}
          >
            {item.visible ? (
              <Eye className="h-3.5 w-3.5 shrink-0 text-[rgba(209,254,23,0.85)]" />
            ) : (
              <EyeOff className="h-3.5 w-3.5 shrink-0 text-white/30" />
            )}
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-xs",
                  item.visible ? "text-white/85" : "text-white/45",
                )}
              >
                {item.label}
              </span>
              {item.hint ? (
                <span className="block truncate text-[10px] text-white/25">{item.hint}</span>
              ) : null}
            </span>
            {item.visible ? null : (
              <span className="shrink-0 rounded border border-white/10 px-1 text-[10px] text-white/35">
                скрыта
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
