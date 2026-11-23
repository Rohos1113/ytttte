"""meta merge не должен затирать результаты нод stale UI PATCH."""

from __future__ import annotations

from app.models import Project, ProjectStatus
from app.services.project_meta import apply_project_meta_patch, merge_project_meta


def test_merge_refuses_null_wipe_of_gpt_operator_results() -> None:
    existing = {
        "canvas_graph": {
            "nodes": [{"id": f"n{i}"} for i in range(10)],
            "edges": [],
        },
        "gpt_operator_results": {
            "n_excel_gpt_6": {
                "gateStatus": "pass",
                "outputPaths": ["check_report.txt"],
                "replyPreview": "ok",
            }
        },
        "storage_nodes": {"n_storage_1": {"autoSync": True}},
    }
    # UI canvas autosave со старым кэшем: results = null / пусто
    patched = merge_project_meta(
        existing,
        {
            "canvas_graph": {"nodes": [{"id": f"n{i}"} for i in range(10)], "edges": []},
            "gpt_operator_results": {"n_excel_gpt_6": None},
            "storage_nodes": {},
        },
        source="test",
    )
    assert len(patched["canvas_graph"]["nodes"]) == 10
    assert patched["gpt_operator_results"]["n_excel_gpt_6"]["gateStatus"] == "pass"
    assert patched["storage_nodes"]["n_storage_1"]["autoSync"] is True


def test_merge_accepts_empty_canvas_graph_removal() -> None:
    """Удаление всех нод человеком должно сохраняться, а не откатываться."""
    existing = {
        "canvas_graph": {
            "nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}],
            "edges": [{"id": "e1"}],
        }
    }
    patched = merge_project_meta(
        existing,
        {"canvas_graph": {"nodes": [], "edges": [], "saved_at": "2026-01-01T00:00:00Z"}},
        source="test",
    )
    assert patched["canvas_graph"]["nodes"] == []
    assert patched["canvas_graph"]["edges"] == []


def test_merge_accepts_partial_node_removal() -> None:
    existing = {
        "canvas_graph": {
            "nodes": [{"id": f"n{i}"} for i in range(10)],
            "edges": [],
        }
    }
    patched = merge_project_meta(
        existing,
        {"canvas_graph": {"nodes": [{"id": "n0"}, {"id": "n3"}], "edges": []}},
        source="test",
    )
    assert [n["id"] for n in patched["canvas_graph"]["nodes"]] == ["n0", "n3"]


def test_merge_accepts_graph_where_nodes_came_and_went() -> None:
    """Удалил старые, добавил новую: канвас — источник истины, патч применяем."""
    existing = {"canvas_graph": {"nodes": [{"id": "a"}, {"id": "b"}, {"id": "c"}], "edges": []}}
    patched = merge_project_meta(
        existing,
        {"canvas_graph": {"nodes": [{"id": "n_new"}], "edges": []}},
        source="test",
    )
    assert [n["id"] for n in patched["canvas_graph"]["nodes"]] == ["n_new"]


def test_merge_keeps_bucket_when_patch_omits_null_entry() -> None:
    existing = {
        "excel_gpt_nodes": {
            "n_excel_gpt_1": {"checkMode": True, "emitKinds": ["reply_txt"]},
        }
    }
    patched = merge_project_meta(
        existing,
        {"excel_gpt_nodes": {"n_excel_gpt_1": None, "n_excel_gpt_2": {"role": "review"}}},
        source="test",
    )
    assert patched["excel_gpt_nodes"]["n_excel_gpt_1"]["checkMode"] is True
    assert patched["excel_gpt_nodes"]["n_excel_gpt_2"]["role"] == "review"


def test_apply_patch_on_project() -> None:
    p = Project(slug="m", topic="t", status=ProjectStatus.new, hero_mode="no_hero")
    p.meta = {
        "gpt_operator_results": {"n1": {"gateStatus": "fail"}},
        "canvas_graph": {"nodes": [{"id": "old"}], "edges": []},
    }
    apply_project_meta_patch(
        p,
        {
            "canvas_graph": {"nodes": [{"id": "x"}, {"id": "y"}], "edges": []},
            "gpt_operator_results": None,
        },
        source="test",
    )
    assert p.meta["gpt_operator_results"]["n1"]["gateStatus"] == "fail"
    assert [n["id"] for n in p.meta["canvas_graph"]["nodes"]] == ["x", "y"]
