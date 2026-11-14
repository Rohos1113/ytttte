"""Обложки каталога «406 стилей»: PNG 1536×1024 → webp 448×299 в web/public/gen-styles/fisher.

Источник PNG: папка fisher-images-additional на рабочем столе (имя файла начинается с номера стиля).
Список стилей берётся из _fisher_work/fisher-styles.json (его пишет build_fisher_style_catalog.py).

Запуск:
  python scripts/make_fisher_style_covers.py [--force]
"""
from __future__ import annotations

import json
import os
import re
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = r"C:\Users\Admin\Desktop\fisher-images-additional"
STYLES_JSON = os.path.join(ROOT, "_fisher_work", "fisher-styles.json")
OUT_DIR = os.path.join(ROOT, "web", "public", "gen-styles", "fisher")
WIDTH = 448
QUALITY = 70


def png_by_num() -> dict[int, str]:
    out: dict[int, str] = {}
    for name in os.listdir(SRC_DIR):
        if not name.lower().endswith('.png'):
            continue
        m = re.match(r'^(\d+)-', name)
        if not m:
            continue
        out.setdefault(int(m.group(1)), os.path.join(SRC_DIR, name))
    return out


def main() -> None:
    force = '--force' in sys.argv
    styles = json.load(open(STYLES_JSON, encoding='utf-8'))
    pngs = png_by_num()
    os.makedirs(OUT_DIR, exist_ok=True)
    made = skipped = missing = 0
    total = 0.0
    for s in styles:
        num = int(s['num'])
        dst = os.path.join(OUT_DIR, f"{s['id']}.webp")
        if os.path.isfile(dst) and not force:
            skipped += 1
            total += os.path.getsize(dst)
            continue
        src = pngs.get(num)
        if not src:
            print(f'нет PNG для стиля {num} ({s["name"]})')
            missing += 1
            continue
        with Image.open(src) as im:
            im = im.convert('RGB')
            w, h = im.size
            im = im.resize((WIDTH, max(1, round(h * WIDTH / w))), Image.LANCZOS)
            im.save(dst, 'WEBP', quality=QUALITY, method=6)
        made += 1
        total += os.path.getsize(dst)
        if made % 50 == 0:
            print(f'  ... {made} готово', flush=True)
    print(f'обложки: сделано {made}, пропущено {skipped}, без PNG {missing}, всего {total/1e6:.1f} MB')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
