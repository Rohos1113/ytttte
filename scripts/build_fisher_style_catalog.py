"""Собирает каталог 406 стилей «Рыбак» для окна «Генерация» → «Каталог стилей».

Источники:
  * стили-по-номерам.txt            — названия и номера
  * стили-с-описаниями.txt          — описания и «Стилевая формулировка»
  * стили-по-категориям.xlsx        — категория/подкатегория каждого номера
  * scripts/fisher-cores-part1.json — английские ядра промптов для стилей 1–90
    (у этих стилей в исходнике нет «Стилевой формулировки», только описание на русском)

Результат:
  web/src/lib/gen-assistant-fisher-styles.ts   — категории и стили
  web/public/gen-styles/fisher/<id>.webp       — обложки (делает второй скрипт)

Запуск:
  python scripts/build_fisher_style_catalog.py
"""
from __future__ import annotations

import json
import os
import re
import sys

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = r"C:\Users\Admin\Desktop\fisher-images-additional"
DESC = os.path.join(SRC_DIR, "стили-с-описаниями.txt")
NAMES = os.path.join(SRC_DIR, "стили-по-номерам.txt")
XLSX = os.path.join(SRC_DIR, "стили-по-категориям.xlsx")
CORES_PART1 = os.path.join(ROOT, "scripts", "fisher-cores-part1.json")
OUT_TS = os.path.join(ROOT, "web", "src", "lib", "gen-assistant-fisher-styles.ts")
OUT_JSON = os.path.join(ROOT, "_fisher_work", "fisher-styles.json")

CAT_IDS = {
    "Фото и реализм": "fisher-photo",
    "Кино и цветокор": "fisher-cinema",
    "Антиутопия и тёмное": "fisher-dystopia",
    "Аниме и манга": "fisher-anime",
    "Графика и иллюстрация": "fisher-graphics",
    "Живопись и арт-история": "fisher-painting",
    "Этника и традиционные техники": "fisher-ethnic",
    "Крафт и материалы": "fisher-craft",
    "Печать и старые фотопроцессы": "fisher-print",
    "Игры, 3D и пиксель": "fisher-games",
    "Дизайн, реклама, обложки": "fisher-design",
    "Детская книга, уют, kawaii": "fisher-kids",
    "Темы, сцены, настроение": "fisher-themes",
    "Модификаторы: свет, палитра, пресеты": "fisher-modifiers",
}

# арт-SVG для плитки (пока обложка не загрузилась) и цвет
CAT_LOOK = {
    "fisher-photo": ("photo", "blue"),
    "fisher-cinema": ("noir", "gray"),
    "fisher-dystopia": ("concept", "purple"),
    "fisher-anime": ("anime", "pink"),
    "fisher-graphics": ("polka", "cyan"),
    "fisher-painting": ("concept", "orange"),
    "fisher-ethnic": ("knit", "yellow"),
    "fisher-craft": ("clay", "green"),
    "fisher-print": ("noir", "gray"),
    "fisher-games": ("pixel", "purple"),
    "fisher-design": ("diagram", "blue"),
    "fisher-kids": ("tutor", "pink"),
    "fisher-themes": ("nature", "green"),
    "fisher-modifiers": ("infographic", "cyan"),
}

# Кино-модули: в исходнике лежит целый скилл-документ, для каталога берём одну строку-объектив.
MODULE_CORES = {
    94: (
        "Denis Villeneuve atmospheric scale: monumental concrete-and-fog geometry, tiny human "
        "figure inside vast architecture, one dominant muted hue per scene, soft bounced backlight "
        "5:1–8:1, visible fog or sand depth gradient, still symmetrical frame, slow dread."
    ),
    95: (
        "Wong Kar-wai melancholy mood: cramped Hong Kong interiors, saturated neon and tungsten "
        "mixed light, step-printed slow motion blur, reflections in wet glass, warm amber against "
        "teal shadows, lonely fragmented framing, 1960s romantic longing."
    ),
    177: (
        "Steven Spielberg commercial wonder: clear readable staging, warm practical light with "
        "blue moonlight fill, ordinary people facing overwhelming spectacle, upward-looking "
        "silhouettes, lens flare and dust in the beam, emotional face close-ups."
    ),
}

COVER_COMPOSITION_CORE = (
    "Book cover composition preset «scene»: an atmospheric full-bleed scene as the main cover "
    "visual, generous calm title area, one clear focal point, editorial book-cover layout."
)

MODULE_DESCS = {
    94: 'Кино-модуль Villeneuve: масштаб, геометрия, туман, тишина, метафизический sci-fi',
    95: 'Кино-модуль Wong Kar-wai: городское одиночество, неон, медленное время, меланхолия',
    177: 'Кино-модуль Spielberg: ясная постановка, тёплый свет, чудо рядом с обычным человеком',
}


def slugify(text: str) -> str:
    table = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
        'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
        'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts',
        'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu',
        'я': 'ya',
    }
    out = []
    for ch in text.lower():
        out.append(table.get(ch, ch))
    s = ''.join(out)
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')
    return s or 'style'


def parse_names(path: str) -> dict[int, tuple[str, str]]:
    res = {}
    with open(path, encoding='utf-8') as f:
        for ln in f:
            m = re.match(r'^(\d+)\.\s+(.*)$', ln.strip())
            if not m:
                continue
            raw = m.group(2).strip()
            note = ''
            mm = re.match(r'^(.*?)\s{2,}\[(?:исходник:\s*)?(.*?)\]\s*$', raw)
            if mm:
                raw, note = mm.group(1).strip(), mm.group(2).strip()
            res[int(m.group(1))] = (raw, note)
    return res


def parse_desc(path: str) -> dict[int, dict]:
    with open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')
    blocks, cur = {}, None
    for ln in lines:
        m = re.match(r'^(\d+)\.\s+(.*)$', ln)
        if m:
            cur = int(m.group(1))
            blocks[cur] = {'name': m.group(2).strip(), 'body': []}
        elif cur is not None:
            blocks[cur]['body'].append(ln)
    return blocks


def read_categories(path: str) -> dict[int, tuple[str, str, str]]:
    wb = openpyxl.load_workbook(path)
    ws = wb['Распределение']
    res = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        num, _name, cat, sub, typ = row[0], row[1], row[2], row[3], row[4]
        if not num:
            continue
        res[int(num)] = (str(cat), str(sub), str(typ))
    return res


FIELD_RE = re.compile(r'^\s*(Вид|Описание|Исходная запись каталога|Линия и цвет|Главное ограничение|Стилевая формулировка):\s*(.*)$')


def field(body: list[str], key: str) -> str:
    """Собрать значение поля (для многострочной «Стилевой формулировки» — весь хвост)."""
    for i, ln in enumerate(body):
        m = FIELD_RE.match(ln)
        if m and m.group(1) == key:
            if key == 'Стилевая формулировка':
                rest = [m.group(2)] + body[i + 1:]
                return '\n'.join(rest).strip()
            return m.group(2).strip()
    return ''


def short_desc(body: list[str], note: str, limit: int = 140) -> str:
    text = note or field(body, 'Исходная запись каталога') or field(body, 'Вид') or field(body, 'Описание')
    if not text:
        return ''
    text = re.sub(r'\s+', ' ', text).strip().rstrip('.')
    # первая фраза, чтобы влезало в подпись карточки
    cut = re.split(r'(?<=[.!?])\s+', text)[0]
    if len(cut) > limit:
        cut = cut[: limit - 1].rstrip(' ,;:') + '…'
    return cut


def clean_formulation(text: str, limit: int = 700) -> str:
    t = text.replace('{prompt}', ' ')
    # артефакты весов из исходных стилевых строк: "(:1.2)", "(:2)"
    t = re.sub(r'\(\s*:?\s*[\d.]+\s*\)', ' ', t)
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(r'\s+([,.;:])', r'\1', t)
    t = re.sub(r'(,\s*){2,}', ', ', t)
    t = t.strip(' ,.;:-—\n\t')
    if len(t) > limit:
        t = t[:limit].rsplit(' ', 1)[0].rstrip(' ,;:') + '…'
    if t and t[0].islower():
        t = t[0].upper() + t[1:]
    return t


def parse_cover_table(blocks: dict[int, dict]) -> dict[str, tuple[str, str]]:
    """Стиль обложки → (палитра, рендеринг) из таблицы пресетов (блок 178)."""
    text = '\n'.join(blocks[178]['body'])
    out = {}
    for m in re.finditer(r'\|\s*`([a-z0-9-]+)`\s*\|\s*`([a-z0-9-]+)`\s*\|\s*`([a-z0-9-]+)`\s*\|', text):
        out[m.group(1)] = (m.group(2), m.group(3))
    return out


def parse_embedding_table(blocks: dict[int, dict]) -> dict[str, str]:
    """Триггер MiniMax → описание эффекта из таблицы (блок 329)."""
    text = '\n'.join(blocks[329]['body'])
    out = {}
    for m in re.finditer(r'\|\s*`minimaxh3_([a-z0-9_]+)`\s*\|\s*([^|]+?)\s*\|', text):
        out[m.group(1)] = m.group(2).strip()
    return out


def theme_core(text: str) -> str:
    """Тема оформления: имя, описание и палитра из markdown-документа."""
    title = ''
    m = re.search(r'^\s*#\s*(.+)$', text, re.M)
    if m:
        title = m.group(1).strip()
    desc_line = ''
    for ln in text.split('\n'):
        s = ln.strip()
        if s and not s.startswith(('#', '-', '|', '*', '>')):
            desc_line = s
            break
    colors = re.findall(r'#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})', text)
    uniq = []
    for c in colors:
        if c.lower() not in [u.lower() for u in uniq]:
            uniq.append(c)
    head = f'«{title}» color theme: {", ".join(uniq[:4])}' if uniq else f'«{title}» color theme'
    tail = re.sub(r'\s+', ' ', desc_line).strip().rstrip('.')
    return f'{head}; {tail}. Palette-driven look, consistent two-font editorial layout.' if tail else head


def build() -> None:
    names = parse_names(NAMES)
    blocks = parse_desc(DESC)
    cats = read_categories(XLSX)
    cores1 = json.load(open(CORES_PART1, encoding='utf-8')) if os.path.isfile(CORES_PART1) else {}

    cover_map = parse_cover_table(blocks)
    embedding_map = parse_embedding_table(blocks)

    styles = []
    problems = []
    used_ids = set()
    for num in range(1, 407):
        if num not in names or num not in blocks:
            problems.append(f'нет данных для {num}')
            continue
        name, note = names[num]
        body = blocks[num]['body']
        cat, sub, typ = cats[num]
        cat_id = CAT_IDS[cat]
        art, color = CAT_LOOK[cat_id]
        sid = f'fisher-{num:03d}-{slugify(name)}'
        if sid in used_ids:
            sid = f'{sid}-{num}'
        used_ids.add(sid)

        # --- ядро промпта
        key = ''
        detail = ''
        if num <= 90:
            core = str(cores1.get(str(num)) or '').strip()
            if not core:
                problems.append(f'нет ядра для {num} ({name})')
        elif num in MODULE_CORES:
            core = MODULE_CORES[num]
            detail = MODULE_DESCS[num]
        elif 178 <= num <= 203:
            key = name[len('Cover '):].strip() if name.startswith('Cover ') else name
            palette, rendering = cover_map.get(key, ('', ''))
            core = (
                f'Book cover art preset «{key}»: {palette} palette, {rendering} rendering, '
                f'editorial cover layout with a calm title area and one strong visual idea.'
            )
            detail = f'Пресет обложки «{key}»: палитра {palette}, рендеринг {rendering}'
        elif num == 204:
            core = COVER_COMPOSITION_CORE
            detail = 'Композиция обложки «scene»: атмосферная сцена на весь кадр, место под заголовок'
        elif 329 <= num <= 335:
            key = name.split('—')[-1].strip() if '—' in name else name
            effect = embedding_map.get(key, '')
            core = f'MiniMax H3 style embedding «{key}»: {effect}.' if effect else f'MiniMax H3 style embedding «{key}».'
            detail = f'Эффект MiniMax H3 «{key}»: {effect.lower()}' if effect else f'Эффект MiniMax H3 «{key}»'
        elif 336 <= num <= 345:
            core = theme_core(field(body, 'Стилевая формулировка'))
        else:
            core = clean_formulation(field(body, 'Стилевая формулировка'))
            if not core:
                problems.append(f'пустая формулировка для {num} ({name})')
        if core and core[0].islower():
            core = core[0].upper() + core[1:]

        styles.append({
            'id': sid,
            'num': num,
            'name': name,
            'category': cat,
            'categoryId': cat_id,
            'subcategory': sub,
            'type': typ,
            'art': art,
            'color': color,
            'desc': detail or short_desc(body, note),
            'tags': [sub.lower(), cat.lower()],
            'cover': f'/gen-styles/fisher/{sid}.webp',
            'file': f'visual_style/fisher/{sid}.md',
            'promptCore': core,
        })

    if problems:
        print('ПРОБЛЕМЫ:')
        for p in problems:
            print('  ', p)
        raise SystemExit(f'не собралось: {len(problems)} проблем')

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(styles, f, ensure_ascii=False, indent=1)
    write_ts(styles)
    print(f'стилей: {len(styles)}')
    print(f'категорий: {len({s["categoryId"] for s in styles})}')
    lens = [len(s['promptCore']) for s in styles]
    print(f'ядро: min {min(lens)}, max {max(lens)}, среднее {sum(lens)//len(lens)}')
    print(f'ядро > 800 символов: {sum(1 for x in lens if x > 800)}')
    print('готово:', OUT_TS)


def ts_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def write_ts(styles: list[dict]) -> None:
    order_cats = list(CAT_IDS.items())
    by_cat: dict[str, list[dict]] = {}
    for s in styles:
        by_cat.setdefault(s['categoryId'], []).append(s)

    lines = [
        '/**',
        ' * Каталог «406 стилей» (набор «Рыбак») для окна «Генерация» → «Каталог стилей».',
        ' *',
        ' * Файл собран скриптом scripts/build_fisher_style_catalog.py — правки руками не переживут',
        ' * пересборку. Источники: стили-по-номерам.txt, стили-с-описаниями.txt,',
        ' * стили-по-категориям.xlsx (папка fisher-images-additional на рабочем столе).',
        ' * Категории — из «инструкции по категориям», типы: Стиль / Мод-пресет / Сет-пресет.',
        ' */',
        '',
        'import type { GenCategoryDef } from "./gen-assistant-styles";',
        '',
        'export const FISHER_STYLE_CATEGORIES: GenCategoryDef[] = [',
    ]
    for cat_name, cat_id in order_cats:
        items = by_cat.get(cat_id, [])
        if not items:
            continue
        art, color = CAT_LOOK[cat_id]
        lines.append('  {')
        lines.append(f'    id: "{cat_id}",')
        lines.append(f'    art: "{art}",')
        lines.append(f'    name: {ts_str(cat_name)},')
        lines.append('    styles: [')
        for s in items:
            lines.append('      {')
            lines.append(f'        id: {ts_str(s["id"])},')
            lines.append(f'        art: "{s["art"]}",')
            lines.append(f'        cover: {ts_str(s["cover"])},')
            lines.append(f'        name: {ts_str(s["name"])},')
            lines.append(f'        file: {ts_str(s["file"])},')
            lines.append(f'        desc: {ts_str(s["desc"])},')
            lines.append(f'        color: "{s["color"]}",')
            lines.append(f'        tags: [{", ".join(ts_str(t) for t in s["tags"])}],')
            lines.append(f'        promptCore: {ts_str(s["promptCore"])},')
            lines.append('      },')
        lines.append('    ],')
        lines.append('  },')
    lines.append('];')
    lines.append('')
    with open(OUT_TS, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    build()
