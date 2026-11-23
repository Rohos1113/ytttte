"""Служебные абзацы плана не становятся пунктами ``P*``.

Реальный сценарий проекта 2 (slug ``pavypvya``, «Кино по плану»): 33 абзаца,
из них 9 — служебные (авторская ремарка, титр «Картинка для привлечения
внимания», название произведения, «Пролог» и «Глава I»…«Глава V»). Раньше
``num_plan_points`` нумеровал всё подряд, гейт R-PLAN-COVER требовал «покрыть»
и заголовки, и модель сочиняла сцены, которых в сценарии нет.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.plan_scenes import (
    check_plan_coverage,
    format_plan_points,
    is_service_paragraph,
    num_plan_points,
    parse_scenes_reply,
    split_plan_items,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "plan_pavypvya.txt"
PROMPT = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "node_groups"
    / "plan_cinema"
    / "plan_to_scenes.md"
)

# Служебные абзацы реального сценария — в порядке текста.
SERVICE_PARAGRAPHS = [
    "Это мой первый рассказ так, что не судите, пожалуйста, строго.",
    "Картинка для привлечения внимания",
    '"Cыны Империума"',
    "Пролог",
    "Глава I",
    "Глава II",
    "Глава III",
    "Глава IV",
    "Глава V",
]

# Опорные биты сценария — должны остаться пунктами в том же порядке.
# Строки уникальны в тексте (проверка ниже), порядок = порядок сценария.
REAL_BEATS = [
    "Моё имя-Аделфус",
    "мальчиком на побегушках",
    "повестка из планетарного отделения",
    "Придя в призывной пункт",
    "русый парень",
    "Проверку я прошел успешно",
    "стоял грузовик с новобранцами",
    "Грузовик прибыл в космопорт",
    "Его звали Маркес Джодокус",
    "теребил меня за плечо",
    "Мы вошли в центральный отсек",
    "Я дождался Геннэдиуса",
    "поступил приказ пройти на нижние палубы",
    "Его звали Джейсон Нерм",
    "-Из какой ты роты",
    "взял потрёпанный временем лазган",
]


def _plan() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def _raw_paragraphs(plan: str) -> list[str]:
    return [block.strip() for block in re.split(r"\n\s*\n", plan) if block.strip()]


# --- реальный сценарий -----------------------------------------------------


def test_fixture_is_the_real_scenario():
    plan = _plan()
    assert len(plan) > 10_000
    assert len(_raw_paragraphs(plan)) == 33
    assert "обороне планеты Фригус" in plan


def test_service_paragraphs_are_filtered():
    service, content = split_plan_items(_plan())
    assert service == SERVICE_PARAGRAPHS
    assert len(service) == 9
    assert len(content) == 24
    assert not set(service) & set(content)


def test_points_are_contiguous_and_start_from_one():
    points = num_plan_points(_plan())
    assert [code for code, _ in points] == [f"P{i}" for i in range(1, 25)]


def test_no_heading_became_a_point():
    points = num_plan_points(_plan())
    texts = [text for _, text in points]
    for service_text in SERVICE_PARAGRAPHS:
        assert service_text not in texts
    # заголовки не приклеены к соседним пунктам
    for text in texts:
        assert not text.startswith(("Глава ", "Пролог", "Картинка для привлечения"))
        assert "Картинка для привлечения внимания" not in text


def test_real_beats_survive_in_script_order():
    points = num_plan_points(_plan())
    plan = _plan()
    order: list[int] = []
    for beat in REAL_BEATS:
        assert plan.count(beat) == 1, f"опорная строка не уникальна: {beat!r}"
        hits = [pos for pos, (_, text) in enumerate(points) if beat in text]
        assert len(hits) == 1, f"бит потерян или размножен: {beat!r} -> {hits}"
        order.append(hits[0])
    # биты идут по сценарию: индекс пункта не убывает (соседние биты одного
    # абзаца могут делить один пункт) и порядок текста не переставлен
    assert order == sorted(order), f"порядок битов сценария нарушен: {order}"
    assert len(set(order)) >= 14, f"биты сбились в кучу — часть пунктов потеряна: {order}"
    assert order[-1] >= len(points) - 3, f"финал сценария уехал в начало: {order}"


def test_split_is_deterministic():
    plan = _plan()
    assert num_plan_points(plan) == num_plan_points(plan)
    assert split_plan_items(plan) == split_plan_items(plan)


def test_numbered_plan_from_real_scripts_format():
    points = num_plan_points(_plan())
    numbered = format_plan_points(points)
    lines = numbered.splitlines()
    assert len(lines) == 24
    assert lines[0].startswith("P1: ")
    assert lines[-1].startswith("P24: ")


def test_gate_accepts_one_scene_per_point():
    """После фильтрации 1:1 раскладка проходит R-PLAN-COVER без «вводных» сцен."""

    points = num_plan_points(_plan())
    scenes = [
        {"номер": pos, "id_плана": [code], "место": "место", "событие": "событие"}
        for pos, (code, _) in enumerate(points, 1)
    ]
    verdict = check_plan_coverage(points, scenes)
    assert verdict["passed"] is True
    assert verdict["uncovered"] == []


def test_model_reply_referencing_filtered_heading_fails_gate():
    """Ссылка на отфильтрованный заголовок — «несуществующий пункт», не тишина."""

    points = num_plan_points(_plan())
    scenes = [
        {"номер": 1, "id_плана": ["P1", "P2"], "место": "место", "событие": "событие"},
        {"номер": 2, "id_плана": ["P30"], "место": "место", "событие": "событие"},
    ]
    verdict = check_plan_coverage(points, scenes)
    assert verdict["passed"] is False
    assert "P30" in verdict["unknown"]


def test_parse_reply_for_real_points_roundtrip():
    points = num_plan_points(_plan())
    raw = (
        '{"сцены": [{"номер": 1, "id_плана": ["' + points[0][0] + '"], '
        '"место": "призывной пункт, день", '
        '"событие": "Аделфус отдаёт повестку и встаёт в очередь", '
        '"примечание": ""}]}'
    )
    verdict = check_plan_coverage(points, parse_scenes_reply(raw))
    assert verdict["passed"] is False  # покрыт один пункт из двадцати четырёх
    assert len(verdict["uncovered"]) == 23


# --- правила опознания служебных абзацев -----------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Глава I",
        "Глава XII",
        "Глава 3. Маледиктус",
        "ГЛАВА V",
        "Часть вторая",
        "Пролог",
        "Эпилог.",
        "Предисловие автора",
        "Картинка для привлечения внимания",
        "Картинка для привлечения внимания: гвардеец на фоне огня",
        "Автор: Иван Петров",
        "Тема: оборона Фригуса",
        "© 2026 Иван Петров",
        "— Иван Петров",
    ],
)
def test_service_paragraphs_recognised(text):
    assert is_service_paragraph(text) is True


@pytest.mark.parametrize("text", ['«Сыны Империума»', '"Cыны Империума"'])
def test_title_recognised_only_in_preface(text):
    """Название стоит в шапке текста; в середине кавычки — реплика или приказ."""

    assert is_service_paragraph(text, in_preface=True) is True
    assert is_service_paragraph(text) is False


@pytest.mark.parametrize(
    "text",
    [
        "Глава семьи вышел во двор и закрыл калитку.",
        "Пролог был скучным и затянутым, но я его дочитал.",
        "Часть роты осталась в окопе.",
        "— Иван, бегом сюда!",
        "— Да.",
        "«Я не вернусь» — сказал он и вышел.",
        '"Я не вернусь."',
        "«Разойтись до поступления приказов»",
        "Не судите его строго, он был молод и глуп.",
        "Автор повести вышел к читателям.",
        "",
    ],
)
def test_real_paragraphs_not_filtered(text):
    assert is_service_paragraph(text) is False


def test_author_note_only_in_preface():
    note = "Это мой первый рассказ так, что не судите, пожалуйста, строго."
    assert is_service_paragraph(note) is False
    assert is_service_paragraph(note, in_preface=True) is True
    # в середине текста такая фраза — обычный абзац
    plan = (
        "Отряд вышел к переправе на рассвете.\n\n"
        "Штабной писарь подал мне мой первый рассказ и велел переписать.\n\n"
        "К вечеру переправа была занята."
    )
    points = num_plan_points(plan)
    assert len(points) == 3


def test_heading_inside_paragraph_not_split():
    plan = "Глава II\n\nБой начался на рассвете и длился до темноты."
    points = num_plan_points(plan)
    assert [text for _, text in points] == ["Бой начался на рассвете и длился до темноты."]


def test_all_service_plan_has_no_points():
    plan = "Пролог\n\nГлава I\n\nГлава II\n\nЭпилог"
    assert num_plan_points(plan) == []


# --- разговор: несколько пунктов-реплик в одной сцене ----------------------


def test_dialogue_run_survives_as_points():
    """Реплики остаются отдельными пунктами — сводит их в одну сцену промт."""

    points = num_plan_points(_plan())
    dialogue = [code for code, text in points if text.startswith("-")]
    assert dialogue == ["P18", "P19", "P20", "P21", "P22", "P23"]
    place = [code for code, text in points if "На самой площадке" in text]
    assert place == ["P17"], "место разговора задаёт пункт перед первой репликой"


def test_gate_accepts_one_scene_for_whole_dialogue():
    """Механика гейта не мешает правилу «разговор = одна сцена на все пункты»."""

    points = num_plan_points(_plan())
    codes = [code for code, _ in points]
    dialogue = [code for code, text in points if text.startswith("-")]
    before = codes[: codes.index(dialogue[0])]
    after = codes[codes.index(dialogue[-1]) + 1:]
    scenes = [
        {"номер": 1, "id_плана": before, "место": "место", "событие": "событие"},
        {"номер": 2, "id_плана": dialogue, "место": "то же место", "событие": "разговор"},
        {"номер": 3, "id_плана": after, "место": "место", "событие": "событие"},
    ]
    verdict = check_plan_coverage(points, scenes)
    assert verdict["passed"] is True
    assert verdict["scenes"] == 3


# --- правила промта: сторож против возврата старой поломки ------------------


def test_prompt_takes_raw_plan_and_keeps_no_invention_rules():
    text = PROMPT.read_text(encoding="utf-8")
    assert text.count("{{ПЛАН}}") == 1
    assert "{{ПЛАН_С_НОМЕРАМИ}}" not in text, "вход — сырой сценарий, без разметки кодом"
    assert "читаешь его целиком и записываешь сцены подряд" in text
    assert "Новых людей, мест, поворотов и развязок не добавляй" in text
    assert "90–140 слов" in text


def test_prompt_keeps_dialogue_rule_and_place_rule():
    text = PROMPT.read_text(encoding="utf-8")
    # Диалог — исключение из динамики: только разговор, реплики разложит «Диалоги».
    assert "Пока идёт разговор, посторонние действия в кадре прекращаются" in text
    assert "Реплики пишет следующий шаг «Диалоги»" in text
    # 22.11 владелец сузил границу сцены до смены локации.
    assert "Новая сцена начинается при смене локации." in text
    assert "Действия динамичные" in text


def test_prompt_forbids_points_for_service_paragraphs():
    """Пункты — опорные точки ноды, служебные абзацы сцен не дают."""

    text = PROMPT.read_text(encoding="utf-8")
    assert "Пункт-метаданные" not in text
    assert "вводной сценой" not in text
    assert "Заголовки глав, «Пролог», название произведения, подпись и авторские ремарки не дают сцен" in text
