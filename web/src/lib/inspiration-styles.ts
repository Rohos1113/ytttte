/**
 * Пресеты стилей дока генерации (фото): те, что были в живой студии и пропали
 * в этой копии при переносе дока из webtest2 (STYLE_PRESETS старого дока).
 * Суффикс дописывается к промпту при генерации изображения.
 */

export type InspirationStyle = {
  id: string;
  /** Подпись в меню. */
  label: string;
  /** Эмодзи-иконка плитки. */
  icon: string;
  /** Русская подсказка, что даёт стиль. */
  hint: string;
  /** Хвост, который дописывается к промпту (пусто — стиля нет). */
  suffix: string;
};

export const INSPIRATION_STYLES: InspirationStyle[] = [
  {
    id: "none",
    label: "Без стиля",
    icon: "∅",
    hint: "как есть, только твой промпт",
    suffix: "",
  },
  {
    id: "photo",
    label: "Фото",
    icon: "📸",
    hint: "реалистичный кадр, 8k",
    suffix:
      ", professional 8k photography, hyperrealistic, sharp focus, natural lighting, highly detailed",
  },
  {
    id: "cinematic",
    label: "Кино",
    icon: "🎬",
    hint: "кадр из фильма, 35 мм",
    suffix:
      ", cinematic still, 35mm film, atmospheric lighting, dramatic depth of field, blockbuster movie aesthetic",
  },
  {
    id: "3d",
    label: "3D",
    icon: "🎨",
    hint: "рендер, Unreal Engine",
    suffix:
      ", 3d render, unreal engine 5, octane render, smooth lighting, volumetric raytracing, 8k",
  },
  {
    id: "anime",
    label: "Аниме",
    icon: "🍙",
    hint: "аниме-арт, яркие цвета",
    suffix: ", anime art style, vibrant colors, detailed line art, aesthetic masterpiece",
  },
  {
    id: "oil",
    label: "Живопись",
    icon: "🖌️",
    hint: "масло, классическая живопись",
    suffix:
      ", oil painting, masterwork, rich brushstrokes, expressive texture, classical fine art",
  },
  {
    id: "cyberpunk",
    label: "Киберпанк",
    icon: "🌆",
    hint: "неон, футуристичный город",
    suffix:
      ", cyberpunk aesthetic, neon glow, futuristic city, reflections, high-tech dark atmosphere",
  },
  {
    id: "fantasy",
    label: "Фэнтези",
    icon: "🌌",
    hint: "магия, эпический арт",
    suffix: ", epic fantasy digital art, magical glowing atmosphere, ethereal lighting, mythical",
  },
];

export function inspirationStyle(id: string): InspirationStyle | null {
  return INSPIRATION_STYLES.find((s) => s.id === id) ?? null;
}
