/**
 * Разметка слотов в результатах узлов (перенос из webtest2): по какому номеру
 * персонажа/предмета раскладывать картинку из результата. Вынесено из
 * `components/canvas/node-result-views.tsx` без изменения поведения, чтобы
 * правило чтения «cN.png» и `frameNumber` покрывалось юнит-тестами.
 */

/** Минимум полей результата, нужных для определения номера слота. */
export type SlotIndexCandidate = {
  filePath?: string | null;
  label?: string | null;
  previewUrl?: string | null;
  frameNumber?: number | null;
};

/**
 * Номер слота с нуля: сначала ищем `cN` в пути/подписи/превью (файлы вида
 * `c1.png`, `c12.jpg`), затем берём `frameNumber`, иначе — позиция в списке.
 */
export function slotIndexFromItem(item: SlotIndexCandidate, fallback: number): number {
  const raw = `${item.filePath ?? ""} ${item.label ?? ""} ${item.previewUrl ?? ""}`;
  const m = raw.match(/c(\d{1,3})\.(?:png|jpe?g|webp)/i);
  if (m) return Math.max(0, parseInt(m[1], 10) - 1);
  if (typeof item.frameNumber === "number" && item.frameNumber > 0) {
    return item.frameNumber - 1;
  }
  return fallback;
}
