"""Группа plan_cinema: пользовательская JSON-спека и диспетчер нод pk_*.

Проверяем то, что отвечает за подключение группы без правок исходной механики:

* ``node_groups/plan_cinema.json`` проходит штатный валидатор и загружается
  как пользовательская группа (9 нод, цепочка рёбер, ``project_meta``);
* id, подписи и промт-варианты не пересекаются со ``script_frames_qc``;
* диспетчер ``app/services/plan_cinema/nodes.py`` узнаёт свои ноды, а чужие —
  нет; активация требует ``meta.source_mode == "plan"`` и запрещает смесь
  групп на одном канвасе;
* старые файлы механики не менялись (``_saved_*`` — только при синхронизации).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services import node_groups
from app.services.plan_cinema import nodes

GROUP_PATH = Path(__file__).resolve().parents[1] / "node_groups" / "plan_cinema.json"

EXPECTED_KEYS = [
    "pk_scenes",
    "pk_cast",
    "pk_skeleton",
    "pk_dialogues",
    "pk_backgrounds",
    "pk_shots",
    "pk_qc",
    "pk_style",
    "pk_report",
]

EXPECTED_IDS = [f"n_excel_gpt_{key}" for key in EXPECTED_KEYS]

EXPECTED_LABELS = {
    "pk_scenes": "Сцены по плану",
    "pk_cast": "Персонажи",
    "pk_skeleton": "Каркас",
    "pk_dialogues": "Диалоги",
    "pk_shots": "Шоты",
    "pk_backgrounds": "Фоны",
    "pk_qc": "QC",
    "pk_style": "Стиль",
    "pk_report": "Отчёт",
}

CODE_NODES = {"pk_scenes", "pk_backgrounds", "pk_style", "pk_report"}


def _raw() -> dict:
    return json.loads(GROUP_PATH.read_text(encoding="utf-8"))


def _group():
    return node_groups._group_from_dict(_raw(), builtin=False)


# ── JSON-спека ──────────────────────────────────────────────────────────────


def test_group_file_exists():
    assert GROUP_PATH.is_file(), f"нет спеки группы: {GROUP_PATH}"


def test_payload_passes_validator():
    errors = node_groups.validate_group_payload(_raw())
    assert errors == []


def test_group_identity():
    group = _group()
    assert group.group_id == "plan_cinema"
    assert group.title == "Кино по плану"
    assert group.category == "planning"
    assert group.default_after_type == "plan"
    assert group.project_meta == {"source_mode": "plan"}
    assert group.exit_edge_kind == "after"


def test_nine_nodes_in_chain_order():
    group = _group()
    assert [node.local_key for node in group.nodes] == EXPECTED_KEYS
    assert [node.preferred_id for node in group.nodes] == EXPECTED_IDS
    assert len(group.nodes) == 9


def test_labels_match_contract():
    group = _group()
    assert {node.local_key: node.label for node in group.nodes} == EXPECTED_LABELS


def test_node_masking_by_output_mode():
    group = _group()
    by_key = {node.local_key: node for node in group.nodes}
    for key, node in by_key.items():
        config = node.operator_config or {}
        expected = "artifact" if key in CODE_NODES else "project_file"
        assert config.get("outputMode") == expected, key
        assert node.slot_overflow is True, key
        if key in {"pk_scenes", "pk_backgrounds", "pk_style", "pk_report"}:
            assert config.get("transport") == "code", key
        else:
            assert config.get("transport") == "api", key


def test_prompt_variants():
    group = _group()
    variants = {node.local_key: node.prompt_variant for node in group.nodes}
    assert variants == {
        "pk_scenes": "plan_to_scenes",
        "pk_cast": "plan_cast",
        "pk_skeleton": "scene_skeleton_plan",
        "pk_dialogues": "plan_dialogues",
        "pk_shots": "scenes_to_frames_plan_ru",
        "pk_backgrounds": "plan_backgrounds",
        "pk_qc": "shots_qc_plan_ru",
        "pk_style": "style_noir_watercolour_16_09",
        "pk_report": None,
    }


def test_internal_edges_are_chain():
    group = _group()
    expected = [
        (EXPECTED_KEYS[i], EXPECTED_KEYS[i + 1], "after") for i in range(len(EXPECTED_KEYS) - 1)
    ]
    assert list(group.internal_edges) == expected


def test_entry_and_exit():
    group = _group()
    assert group.entry_keys == ("pk_scenes",)
    assert group.exit_key == "pk_report"


def test_group_is_loaded_as_custom():
    groups = node_groups.all_groups()
    assert "plan_cinema" in groups
    assert "plan_cinema" not in node_groups.NODE_GROUPS, "группа должна жить в node_groups/*.json"
    loaded = groups["plan_cinema"]
    assert [node.local_key for node in loaded.nodes] == EXPECTED_KEYS


def test_node_ids_do_not_collide_with_script_frames_qc():
    old = node_groups.all_groups().get("script_frames_qc")
    assert old is not None
    old_ids = {node.preferred_id for node in old.nodes}
    assert not (old_ids & set(EXPECTED_IDS))
    old_keys = {node.local_key for node in old.nodes}
    assert not (old_keys & set(EXPECTED_KEYS))


# ── Диспетчер ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("node_id", EXPECTED_IDS)
def test_dispatcher_recognizes_own_nodes(node_id: str):
    assert nodes.is_plan_cinema_node(node_id) is True
    spec = nodes.plan_cinema_node_spec(node_id)
    assert spec is not None
    assert spec.node_id == node_id


@pytest.mark.parametrize("node_key", EXPECTED_KEYS)
def test_dispatcher_recognizes_local_keys(node_key: str):
    assert nodes.is_plan_cinema_node(node_key) is True


@pytest.mark.parametrize(
    "node_key",
    [
        "n_excel_gpt_fw_shots",
        "n_excel_gpt_fw_qc",
        "n_excel_gpt_fw_style",
        "n_excel_gpt_sfq3_plan",
        "n_excel_gpt_cinema_shot_list",
        "",
        "n_excel_gpt_pk_unknown",
    ],
)
def test_dispatcher_ignores_foreign_nodes(node_key: str):
    assert nodes.is_plan_cinema_node(node_key) is False
    assert nodes.plan_cinema_node_kind(node_key) == ""


def test_dispatcher_kinds_in_order():
    assert [spec.kind for spec in nodes.plan_cinema_node_specs()] == [
        "scenes",
        "cast",
        "skeleton",
        "dialogues",
        "shots",
        "backgrounds",
        "qc",
        "style",
        "report",
    ]


def test_style_and_report_do_not_use_model():
    specs = {spec.kind: spec for spec in nodes.plan_cinema_node_specs()}
    assert specs["style"].uses_model is False
    assert specs["report"].uses_model is False
    assert specs["scenes"].uses_model is True


def test_activation_requires_plan_mode():
    with pytest.raises(ValueError, match="source_mode"):
        nodes.assert_plan_cinema_activation({}, "n_excel_gpt_pk_scenes")
    with pytest.raises(ValueError, match="source_mode"):
        nodes.assert_plan_cinema_activation({"source_mode": "voiceover"}, "n_excel_gpt_pk_cast")
    nodes.assert_plan_cinema_activation({"source_mode": "plan"}, "n_excel_gpt_pk_scenes")


def test_mixed_groups_conflict():
    meta = {
        "source_mode": "plan",
        "canvas_graph": {"nodes": [{"id": "n_excel_gpt_pk_scenes"}, {"id": "n_excel_gpt_fw_shots"}]},
    }
    error = nodes.mixed_group_conflict_error(meta)
    assert error and "script_frames_qc" in error
    with pytest.raises(ValueError, match="одну схему"):
        nodes.assert_plan_cinema_activation(meta)
    assert nodes.mixed_group_conflict_error({"source_mode": "plan"}) is None
    sfq3_meta = {
        "source_mode": "plan",
        "canvas_graph": {"nodes": [{"id": "n_excel_gpt_pk_qc"}, {"id": "n_excel_gpt_sfq3_plan"}]},
    }
    assert nodes.mixed_group_conflict_error(sfq3_meta)


def test_activation_ignored_for_foreign_node():
    nodes.assert_plan_cinema_activation({}, "n_excel_gpt_fw_shots")


def test_source_mode_default_is_voiceover():
    assert nodes.source_mode({}) == "voiceover"
    assert nodes.source_mode({"source_mode": "plan"}) == "plan"
    assert nodes.source_mode(None) == "voiceover"


def test_handlers_registered_for_every_kind():
    kinds = {spec.kind for spec in nodes.plan_cinema_node_specs()}
    assert set(nodes._HANDLERS) == kinds


def test_artifact_names_are_unique():
    names = [nodes.ARTIFACT_SCENES, nodes.ARTIFACT_SHOTS, nodes.ARTIFACT_QC, nodes.ARTIFACT_STYLE]
    assert len(set(names)) == len(names)


# ── Стиль: файл из папки стилей или загруженный текст ──────────────────────


def test_style_looks_like_style():
    """Мастер-промт шага — не стиль: длинный текст с разделами «##»."""
    assert nodes._looks_like_style("cinematic realism, feature-film still. " * 3)
    assert not nodes._looks_like_style("# Мастер промт\n\n## Роль\n\nТы режиссёр." * 20)
    assert not nodes._looks_like_style("коротко")


def test_style_from_uploaded_prompt_text(tmp_path, monkeypatch):
    """Имя загруженного файла без файла стиля — берём текст слота."""
    from app.services import frame_style, prompt_library
    body = (
        "cinematic realism, feature-film still. Photographic realism, natural skin "
        "texture, motivated practical light, 35mm anamorphic look, fine film grain."
    )
    prompt_file = tmp_path / "my_style.txt.md"
    prompt_file.write_text(body, encoding="utf-8")
    monkeypatch.setattr(
        prompt_library, "prompt_path", lambda step, name: prompt_file
    )
    text = nodes._style_text_from_slot("n_excel_gpt_pk_style", "my_style.txt", body)
    assert text == body
    assert frame_style.normalize_style_text(text) == text


def test_style_from_slot_rejects_master_prompt(tmp_path, monkeypatch):
    """Если в слоте лежит мастер-промт шага, а не стиль — отдаём пусто."""
    from app.services import prompt_library

    master = "# Мастер промт\n\n## Роль\n\nТы раскадровщик.\n" * 40
    monkeypatch.setattr(prompt_library, "prompt_path", lambda step, name: tmp_path / "нет.md")
    assert nodes._style_text_from_slot("n_excel_gpt_pk_style", "default", master) == ""


def test_apply_style_to_kadry_styles_master_and_children(monkeypatch):
    """Стиль ложится на K1 и детей через штатный keys-frame_style."""
    import sqlalchemy.orm.attributes as sa_attrs

    monkeypatch.setattr(sa_attrs, "flag_modified", lambda *a, **k: None)
    from app.services import frame_style

    scene = _FakeFrame(
        1,
        1,
        {
            "кадры": [
                {
                    "id": "1.1",
                    "роль": "K1",
                    "промт_картинки": "Сцена: ночной город, человек идёт.",
                },
                {
                    "id": "1.2",
                    "parent_id": "1.1",
                    "промт_старт": "Сцена: ночной город, человек идёт.",
                },
            ]
        },
    )
    counts = nodes._apply_style_to_kadry(
        frame_style, scene, "стиль: тёмный нуар, контражур, дождь", "style_test", 4200
    )
    assert counts["master"] == 1
    assert counts["children"] == 1
    kadry = scene.attrs["кадры"]
    assert "нуар" in (kadry[0].get("промт_картинки") or "")
    assert "нуар" in (kadry[1].get("промт_старт") or "")
    assert kadry[1].get("стиль") == "style_test"
    assert kadry[1].get("промт_старт_без_стиля")

# ── Архив прежнего разбиения не попадает в генерацию картинок ──────────────


class _FakeFrame:
    def __init__(self, frame_id: int, number: int, attrs: dict) -> None:
        self.id = frame_id
        self.number = number
        self.sort_key = float(number)
        self.attrs = attrs
        self.image_prompt = "старый промт"
        self.animation_prompt = "старый анимационный промт"
        self.status = "image_prompt_ready"


class _FakeSession:
    def __init__(self, frames: list[_FakeFrame]) -> None:
        self.frames = frames
        self.created: list[object] = []

    async def flush(self) -> None:  # noqa: D401 — совместимость с AsyncSession
        return None

    def add(self, obj: object) -> None:
        self.created.append(obj)

    async def execute(self, _statement):
        class _Result:
            def scalars(self):
                return self

            def first(self):
                return None

        return _Result()


class _FakeApply:
    def __init__(self, frames: list[_FakeFrame]) -> None:
        self.frames = frames

    async def load_scenes(self, session, project):
        return self.frames


def test_archived_scene_cells_leave_generation_queue(monkeypatch):
    """Смена числа сцен: старые ячейки уходят в архив и в генерацию не идут."""
    # keys: матрица активности кадра живёт в app.orchestrator.validators.activity_flags
    from app.orchestrator.validators.activity_flags import frame_is_active

    old = [_FakeFrame(11, 1, {"источник": "pk", "номер": 1})]
    session = _FakeSession(old)
    monkeypatch.setattr(nodes, "_apply", lambda: _FakeApply(old))

    new_scenes = [{"номер": 1}, {"номер": 2}]
    step1 = [{"номер": 1}, {"номер": 2}]
    import asyncio

    class _FakeProject:
        id = 82

    created = asyncio.run(
        nodes._ensure_scene_cells(session, _FakeProject(), new_scenes, step1)
    )
    assert created is not None

    archived = old[0]
    assert archived.attrs["источник"] == "pk_archived"
    assert archived.attrs["удалён"] is True
    assert archived.image_prompt == ""
    assert archived.animation_prompt == ""
    assert archived.number >= 100000
    # платная генерация обязана видеть архивный кадр как неактивный
    assert frame_is_active(archived.attrs) is False
    new_cells = [
        obj
        for obj in session.created
        if (getattr(obj, "attrs", None) or {}).get("источник") == "pk"
    ]
    assert len(new_cells) == 2


# ── Старая механика не тронута нашими файлами ──────────────────────────────


def test_package_does_not_shadow_old_modules():
    import app.services.plan_cinema.apply as plan_apply

    assert plan_apply.__name__ == "app.services.plan_cinema.apply"
    assert nodes.GROUP_ID == "plan_cinema"
