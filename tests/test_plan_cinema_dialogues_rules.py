"""Нода «Диалоги»: речь обязательна там, где в плане есть диалог, а закадр в
реплики не попадает (``plan_dialogues.md``, ``gates.R-DLG-PLAN``/``R-DLG-VO``).

Владелец: «где в плане диалог — речь должна быть настоящей, не `нет`» и «никакого
закадрового текста внутри диалогов: либо VO, либо реплика, без наложения».
Проверяем два слоя:

* промт ``plan_dialogues.md`` — признаки реплики в плане, запрет `нет` и запрет
  закадра; его JSON-примеры обязаны проходить собственные гейты;
* чистые гейты ``plan_dialogue_evidence`` / ``dialog_vo_problems`` /
  ``dialog_problems`` — на фейках, без сети и БД.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from app.services.plan_cinema import gates

PROMPT_PATH = (
    Path(__file__).resolve().parents[1]
    / "templates"
    / "node_groups"
    / "plan_cinema"
    / "plan_dialogues.md"
)


def _dialog() -> dict:
    return {
        "тип": "диалог",
        "реплики": [
            {"кто": "c01", "текст": "Ворота закрывай.", "эмоция": "резко"},
            {"кто": "c02", "текст": "Не моя смена.", "эмоция": "спокойно"},
        ],
    }


def _no_speech() -> dict:
    return {"тип": "нет", "реплики": []}


# --- R-DLG-PLAN: признаки диалога в плане --------------------------------


def test_plan_dash_lines_are_dialogue() -> None:
    plan = "P8: — Ворота закрывай.\nP9: — Не моя смена."
    evidence = gates.plan_dialogue_evidence(plan)
    assert any("тире" in item for item in evidence)
    assert "Не моя смена" in " ".join(evidence)


def test_plan_quote_with_speech_verb_is_dialogue() -> None:
    evidence = gates.plan_dialogue_evidence('P3: Иван спрашивает: «Где коробки?»')
    assert any("цитата" in item for item in evidence)
    assert any("спрашивает" in item for item in evidence)


def test_plan_speech_verb_introducing_content_is_dialogue() -> None:
    evidence = gates.plan_dialogue_evidence("P5: Комиссар приказывает: «Ворота закрыть».")
    assert any("глагол речи" in item for item in evidence)


def test_plan_speech_verb_alone_is_narration() -> None:
    # Пересказ чужих слов без цитаты — не диалог: реплики в плане нет.
    assert gates.plan_dialogue_evidence("P5: Он сказал, что я ни на что не годен.") == []


def test_plan_verb_with_proper_name_quote_is_narration() -> None:
    # Пересказ приказа: кавычки — название корабля в конце предложения, а не
    # реплика. Иначе модель обязана дописать слова, которых в плане нет
    # (живой случай: сцена 11, R-DLG-PLAN «глагол речи «приказал»»).
    assert (
        gates.plan_dialogue_evidence(
            "P18: Джодокус приказал нам построиться в колонны и идти к космолёту «Фаст»."
        )
        == []
    )


def test_plan_two_bare_quotes_are_exchange() -> None:
    # Ни атрибуции, ни конца предложения — но две цитаты в одном пункте уже
    # обмен репликами, а не упоминание названия.
    evidence = gates.plan_dialogue_evidence("«Где коробки» «У ворот»")
    assert sum("цитата" in item for item in evidence) == 2


def test_plan_without_speech_has_no_evidence() -> None:
    assert gates.plan_dialogue_evidence("P3: Иван несёт коробку и ставит у ворот.") == []
    assert gates.plan_dialogue_evidence("") == []


def test_plan_book_title_is_not_dialogue() -> None:
    # Заголовок в кавычках без конца предложения — не реплика.
    assert gates.plan_dialogue_evidence("P3: На полке лежит «Война и мир».") == []


# --- R-DLG-PLAN: гейт не пропускает «нет» при диалоге в плане --------------


def test_net_on_plan_dialogue_is_flagged() -> None:
    problems = gates.dialog_problems(
        _no_speech(),
        ["c01", "c02"],
        ["c01", "c02"],
        plan_text="P8: — Ворота закрывай.\nP9: — Не моя смена.",
    )
    assert any("R-DLG-PLAN" in problem for problem in problems)
    assert any("«нет»" in problem for problem in problems)


def test_net_on_plan_quote_is_flagged() -> None:
    problems = gates.dialog_problems(
        _no_speech(),
        ["c01"],
        ["c01"],
        plan_text='P3: Иван спрашивает: «Где коробки?»',
    )
    assert any("R-DLG-PLAN" in problem for problem in problems)


def test_net_on_silent_plan_is_legal() -> None:
    assert (
        gates.dialog_problems(
            _no_speech(),
            ["c01"],
            ["c01"],
            plan_text="P3: Иван несёт коробку и ставит у ворот.",
        )
        == []
    )


def test_net_without_any_speakers_is_legal() -> None:
    # Реестр и сцена пусты: говорящего взять негде, «нет» — не вина модели.
    assert (
        gates.dialog_problems(
            _no_speech(),
            [],
            [],
            plan_text="P8: — Ворота закрывай.",
        )
        == []
    )


def test_monologue_on_plan_dialogue_is_allowed() -> None:
    # В сцене один участник — обмен сокращён до монолога, но речь есть.
    speech = {
        "тип": "монолог",
        "реплики": [{"кто": "c01", "текст": "Ворота закрывай.", "эмоция": "резко"}],
    }
    assert (
        gates.dialog_problems(
            speech,
            ["c01"],
            ["c01"],
            plan_text="P8: — Ворота закрывай.",
        )
        == []
    )


def test_clean_dialog_on_plan_dialogue_passes() -> None:
    assert (
        gates.dialog_problems(
            _dialog(),
            ["c01", "c02"],
            ["c01", "c02"],
            plan_text="P8: — Ворота закрывай.\nP9: — Не моя смена.",
        )
        == []
    )


# --- R-DLG-VO: закадровый текст внутри диалога ----------------------------


def test_vo_field_in_speech_is_flagged() -> None:
    speech = {"тип": "диалог", "реплики": [], "закадр": "Тем временем в магазине…"}
    problems = gates.dialog_vo_problems(speech)
    assert any("R-DLG-VO" in problem and "закадровое поле" in problem for problem in problems)


def test_vo_field_in_replica_is_flagged() -> None:
    speech = _dialog()
    speech["реплики"][0]["voiceover_text"] = "Голос за кадром"
    problems = gates.dialog_vo_problems(speech)
    assert any("реплика #1" in problem and "voiceover_text" in problem for problem in problems)


def test_narrator_marker_in_replica_text_is_flagged() -> None:
    speech = _dialog()
    speech["реплики"][0]["текст"] = "Голос за кадром: тем временем в магазине…"
    problems = gates.dialog_problems(speech, ["c01", "c02"], ["c01", "c02"])
    assert any("R-DLG-VO" in problem and "за кадром" in problem for problem in problems)


def test_stage_direction_in_replica_text_is_flagged() -> None:
    speech = _dialog()
    speech["реплики"][1]["текст"] = "(пауза) Не моя смена."
    assert gates.dialog_vo_problems(speech)


def test_dash_markup_in_replica_text_is_flagged() -> None:
    speech = _dialog()
    speech["реплики"][1]["текст"] = "— Не моя смена."
    assert gates.dialog_vo_problems(speech)


def test_fully_quoted_replica_is_flagged() -> None:
    speech = _dialog()
    speech["реплики"][0]["текст"] = "«Ворота закрывай»"
    assert gates.dialog_vo_problems(speech)


def test_replica_repeating_voiceover_text_is_flagged() -> None:
    speech = _dialog()
    speech["реплики"][0]["текст"] = "тем временем в магазине отец закрывает ставни"
    problems = gates.dialog_vo_problems(
        speech, voiceover_text="А тем временем в магазине отец закрывает ставни."
    )
    assert any("дословно повторяет" in problem for problem in problems)


def test_clean_dialog_has_no_vo_problems() -> None:
    assert gates.dialog_vo_problems(_dialog()) == []
    assert gates.dialog_problems(_dialog(), ["c01", "c02"], ["c01", "c02"]) == []


# --- R-DLG-SPEAKER: имена в «персонажах» сцены не бракуют реплики -----------


def test_scene_names_do_not_block_code_speaker() -> None:
    # «Сцены по плану» пишут персонажей именами: кодов на том шаге ещё нет.
    # Имя в списке — не код сравнения; гейт не должен браковать верный диалог
    # (было: «речь: «кто» c01 нет в персонажах сцены ['Аделфус']»).
    assert (
        gates.dialog_problems(_dialog(), ["Аделфус", "хозяин магазина"], ["c01", "c02"])
        == []
    )


def test_scene_codes_still_checked_when_mixed_with_names() -> None:
    # Коды в сцене остались — проверка говорящего по ним не ослабляется.
    problems = gates.dialog_problems(_dialog(), ["c02", "Аделфус"], ["c01", "c02"])
    assert any("персонажах сцены" in problem for problem in problems)


# --- промт plan_dialogues.md ----------------------------------------------


def _prompt_text() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def test_prompt_forbids_net_when_plan_has_dialogue() -> None:
    text = _prompt_text()
    assert "R-DLG-PLAN" in text
    assert "строки с тире" in text or "строка с тире" in text
    assert "`нет`" in text
    # признаки реплики в плане перечислены и в правилах, и в самопроверке
    assert "цитата в кавычках" in text
    assert "самопроверк" in text.lower() or "проверь" in text.lower()


def test_prompt_forbids_voiceover_inside_dialogues() -> None:
    text = _prompt_text()
    assert "R-DLG-VO" in text
    assert "Закадровое — не реплика" in text
    assert "voiceover" in text


def test_prompt_keeps_placeholders() -> None:
    text = _prompt_text()
    for placeholder in ("{{СЦЕНА}}", "{{ПЛАН}}", "{{РЕЕСТР}}"):
        assert placeholder in text


def _json_examples(text: str) -> list[dict]:
    blocks = re.findall(r"```json\s*(.*?)```", text, flags=re.DOTALL)
    payloads = []
    for block in blocks:
        payload = json.loads(block)
        assert isinstance(payload, dict)
        payloads.append(payload)
    return payloads


def test_prompt_json_examples_are_valid_speech() -> None:
    examples = _json_examples(_prompt_text())
    assert examples
    for speech in examples:
        speakers = [
            replica.get("кто")
            for replica in speech.get("реплики") or []
            if isinstance(replica, dict)
        ]
        assert gates.dialog_problems(speech, speakers, speakers) == []
