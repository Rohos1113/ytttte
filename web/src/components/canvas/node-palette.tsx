"use client";

/**
 * «Библиотека» — менеджер нод и групп нод (кнопка «+ Добавить» на тулбаре).
 * Ноды: категории слева, карточки в центре, детали ноды справа (клик по
 * карточке — просмотр, двойной клик — сразу на канвас). Группы: список слева,
 * справа просмотр дизайна группы (мини-канвас нод и связей), состав, промты
 * и управление: вставка, переименование/описание/категория, удаление,
 * создание из выделения канваса.
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Check,
  Loader2,
  PackagePlus,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import type { NodeGroupDetail, NodeGroupSummary } from "@/lib/types";
import {
  getNodeSpec,
  NODE_CATALOG,
  getNodeCategoryLabel,
  NODE_CATEGORY_ORDER,
  type NodeCategory,
} from "@/lib/node-catalog";
import { groupHue } from "@/lib/group-color";
import { errorMessageFromUnknown } from "@/lib/error-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { GroupPreview } from "./group-preview";
import { LibraryBrowser, LibrarySwitch, RUBIK, type LibrarySource } from "./library-nodes-tab";

// sd_agent/sd_assemble — legacy-типы старых канвасов; scene-агенты теперь
// создаются группой «Сцены: веер агентов» как ноды «Работа с GPT».
const HIDDEN_NODE_TYPES = new Set(["excel_feed", "sd_agent", "sd_assemble"]);

const GROUP_CATEGORY_OPTIONS = NODE_CATEGORY_ORDER.filter((c) => c !== "hitl");

export function NodePalette({
  projectId,
  onAddNode,
  getSelectedNodeIds,
  onPersistCanvas,
}: {
  projectId: number | null;
  onAddNode: (type: string) => void;
  getSelectedNodeIds: () => string[];
  onPersistCanvas?: () => Promise<void> | void;
}) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<LibrarySource>("builtin");
  const [search, setSearch] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const nodeGroups = useQuery({
    queryKey: ["node-groups"],
    queryFn: api.listNodeGroups,
    staleTime: 60_000,
  });

  const addable = useMemo(
    () =>
      Object.keys(NODE_CATALOG).filter(
        (t) => (!t.startsWith("hitl_") || t === "hitl_style") && !HIDDEN_NODE_TYPES.has(t),
      ),
    [],
  );

  const query = search.trim().toLowerCase();
  const matchNode = (t: string) => {
    if (!query) return true;
    const spec = getNodeSpec(t);
    return (
      spec.label.toLowerCase().includes(query) ||
      spec.description.toLowerCase().includes(query) ||
      t.toLowerCase().includes(query)
    );
  };
  const matchGroup = (g: NodeGroupSummary) => {
    if (!query) return true;
    return (
      g.title.toLowerCase().includes(query) ||
      g.description.toLowerCase().includes(query) ||
      g.nodes.some((n) => n.label.toLowerCase().includes(query))
    );
  };

  const addNode = (type: string) => {
    onAddNode(type);
    setOpen(false);
  };

  const insertGroup = async (groupId: string) => {
    if (!projectId) {
      toast.error(t("canvas.palette.selectProjectFirst"));
      return;
    }
    try {
      const res = await api.insertNodeGroup(projectId, groupId);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      await qc.invalidateQueries({ queryKey: ["project-run", projectId] });
      toast.success(
        t("canvas.palette.groupInserted", {
          count: res.nodes.length,
          after: res.after,
        }),
      );
      setOpen(false);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    }
  };

  const groups = (nodeGroups.data ?? []).filter(matchGroup);
  const effectiveGroupId =
    selectedGroupId && groups.some((g) => g.id === selectedGroupId)
      ? selectedGroupId
      : (groups[0]?.id ?? null);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setSearch("");
        }
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-[34px] items-center justify-center rounded-lg border border-transparent bg-transparent text-muted-foreground transition-all duration-150 hover:border-white/8 hover:bg-white/5 hover:text-foreground [&_svg]:size-4"
          title={t("canvas.palette.add")}
          aria-label={t("canvas.palette.add")}
        >
          <Plus className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="flex h-[640px] max-h-[88vh] w-[960px] max-w-[94vw] flex-col gap-0 overflow-hidden rounded-[14px] border-white/[0.08] bg-[rgba(24,24,28,0.96)] p-0 text-white" style={{ fontFamily: RUBIK }}>
        <div className="flex shrink-0 items-center gap-4 border-b border-white/10 px-4 py-3 pr-12">
          <DialogTitle className="text-[15px] font-medium">{t("canvas.palette.title")}</DialogTitle>
          <LibrarySwitch value={tab} onChange={setTab} />
          <div className="relative ml-auto w-[240px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/45" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("canvas.palette.searchPlaceholder")}
              className="h-9 rounded-none border-white/10 bg-black/30 pl-8 text-[13px]"
            />
          </div>
        </div>

        {tab !== "groups" ? (
          <LibraryBrowser
            key={tab}
            source={tab}
            query={query}
            addable={addable}
            matchNode={matchNode}
            myGroups={(nodeGroups.data ?? []).filter((g) => !g.builtin)}
            matchGroup={matchGroup}
            onOpenGroup={(id) => {
              setSelectedGroupId(id);
              setTab("groups");
            }}
            onAddNode={addNode}
          />
        ) : (
          <GroupsTab
            groups={groups}
            loading={nodeGroups.isLoading}
            projectId={projectId}
            selectedGroupId={effectiveGroupId}
            onSelectGroup={setSelectedGroupId}
            getSelectedNodeIds={getSelectedNodeIds}
            onPersistCanvas={onPersistCanvas}
            onInsert={insertGroup}
            onChanged={() => {
              void qc.invalidateQueries({ queryKey: ["node-groups"] });
              void qc.invalidateQueries({ queryKey: ["node-group"] });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ── Группы ───────────────────────────────────────────────────────────── */

function GroupsTab({
  groups,
  loading,
  projectId,
  selectedGroupId,
  onSelectGroup,
  getSelectedNodeIds,
  onPersistCanvas,
  onInsert,
  onChanged,
}: {
  groups: NodeGroupSummary[];
  loading: boolean;
  projectId: number | null;
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  getSelectedNodeIds: () => string[];
  onPersistCanvas?: () => Promise<void> | void;
  onInsert: (groupId: string) => Promise<void>;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [creating, setCreating] = useState(false);

  const customGroups = groups.filter((g) => !g.builtin);
  const builtinGroups = groups.filter((g) => g.builtin);

  const renderGroupCard = (g: NodeGroupSummary) => {
    const hue = groupHue(g.id);
    const active = g.id === selectedGroupId;
    return (
      <button
        key={g.id}
        type="button"
        className={cn(
          "rounded-xl border px-2.5 py-2 text-left transition-colors",
          active
            ? "border-teal-400/50 bg-teal-400/10 shadow-[0_0_12px_rgba(43,184,160,0.15)]"
            : "border-white/10 bg-white/[0.02] hover:border-white/25",
        )}
        style={{ borderLeftWidth: 3, borderLeftColor: `hsl(${hue} 70% 55% / 0.8)` }}
        onClick={() => onSelectGroup(g.id)}
      >
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold">{g.title}</span>
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium",
              g.builtin
                ? "border-sky-400/30 bg-sky-500/10 text-sky-300"
                : "border-teal-400/30 bg-teal-500/10 text-teal-300",
            )}
          >
            {g.builtin ? t("canvas.palette.builtin") : t("canvas.palette.custom")}
          </span>
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {getNodeCategoryLabel(g.category as NodeCategory, locale)} ·{" "}
          {t("canvas.palette.nodesCount", { count: g.node_count })}
        </div>
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-white/10">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {creating ? (
            <CreateGroupForm
              projectId={projectId}
              getSelectedNodeIds={getSelectedNodeIds}
              onPersistCanvas={onPersistCanvas}
              onDone={(created, createdGroup) => {
                setCreating(false);
                if (created && createdGroup) {
                  onSelectGroup(createdGroup.id);
                  onChanged();
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl border border-dashed border-teal-400/40 bg-teal-400/5 px-2.5 py-2 text-left text-xs text-teal-300 transition-colors hover:bg-teal-400/10"
              onClick={() => setCreating(true)}
            >
              <PackagePlus className="h-4 w-4 shrink-0" />
              <span>
                <span className="block font-medium">
                  {t("canvas.palette.saveSelectionAsGroup")}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {t("canvas.palette.selectionHint")}
                </span>
              </span>
            </button>
          )}

          {loading && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {!loading && groups.length === 0 && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("canvas.palette.noGroups")}
            </div>
          )}

          {customGroups.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-teal-300/80">
                {t("canvas.palette.myGroups", { count: customGroups.length })}
              </div>
              {customGroups.map(renderGroupCard)}
            </div>
          )}

          {builtinGroups.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("canvas.palette.builtinTemplates", { count: builtinGroups.length })}
              </div>
              {builtinGroups.map(renderGroupCard)}
            </div>
          )}
        </div>
      </ScrollArea>
      </div>

      <div className="min-h-0 flex-1">
        {selectedGroupId ? (
          <GroupDetailPane
            key={selectedGroupId}
            groupId={selectedGroupId}
            onInsert={onInsert}
            onChanged={onChanged}
            onDeleted={() => onSelectGroup(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-center text-[11px] text-muted-foreground">
            Кликни по группе слева,
            <br />
            чтобы посмотреть её дизайн
          </div>
        )}
      </div>
    </div>
  );
}

function GroupDetailPane({
  groupId,
  onInsert,
  onChanged,
  onDeleted,
}: {
  groupId: string;
  onInsert: (groupId: string) => Promise<void>;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t, locale } = useTranslation();
  const detail = useQuery({
    queryKey: ["node-group", groupId],
    queryFn: () => api.getNodeGroup(groupId),
    staleTime: 30_000,
  });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (detail.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  const g = detail.data;
  if (!g) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-destructive">
        {t("canvas.palette.failedToLoadGroup")}
      </div>
    );
  }
  const hue = groupHue(g.id);

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.deleteNodeGroup(g.id);
      toast.success(t("canvas.palette.groupDeleted", { title: g.title }));
      onChanged();
      onDeleted();
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: `hsl(${hue} 80% 62%)` }}
              />
              <span className="truncate text-sm font-semibold">{g.title}</span>
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[9px] font-medium",
                  g.builtin
                    ? "border-sky-400/30 bg-sky-500/10 text-sky-300"
                    : "border-teal-400/30 bg-teal-500/10 text-teal-300",
                )}
              >
                {g.builtin ? t("canvas.palette.builtin") : t("canvas.palette.custom")}
              </span>
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {getNodeCategoryLabel(g.category as NodeCategory, locale)} ·{" "}
              {t("canvas.palette.insertsAfter", {
                count: g.nodes.length,
                after: g.default_after_type || t("canvas.palette.tailOfChain"),
              })}
              {g.updated_at
                ? t("canvas.palette.updatedAt", {
                    date: new Date(g.updated_at).toLocaleString(
                      locale === "en" ? "en-US" : "ru-RU",
                    ),
                  })
                : ""}
            </div>
          </div>
          {!g.builtin && !editing && (
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3 w-3" />
                {t("canvas.palette.editGroup")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 text-xs text-destructive hover:bg-destructive/10"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {editing ? (
          <EditGroupForm
            group={g}
            busy={busy}
            setBusy={setBusy}
            onDone={(saved) => {
              setEditing(false);
              if (saved) onChanged();
            }}
          />
        ) : (
          <>
            {g.description && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {g.description}
              </p>
            )}

            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("canvas.palette.groupDesign")}
              </div>
              <GroupPreview detail={g} />
              <div className="mt-1 text-[9px] text-muted-foreground">
                <span className="text-teal-400">{t("canvas.palette.groupLegendIn")}</span> — {t("canvas.palette.groupLegendInDesc")} ·{" "}
                <span className="text-sky-400">{t("canvas.palette.groupLegendOut")}</span> — {t("canvas.palette.groupLegendOutDesc")} ·{" "}
                <span className="text-teal-400">{t("canvas.palette.groupLegendOk")}</span>/
                <span className="text-red-400">{t("canvas.palette.groupLegendNotOk")}</span> — {t("canvas.palette.groupLegendBranches")}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t("canvas.palette.composition", { count: g.nodes.length })}
              </div>
              <div className="flex flex-wrap gap-1">
                {g.nodes.map((n) => (
                  <span
                    key={n.key}
                    title={n.description || n.label}
                    className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {n.label}
                    {n.prompt_variant ? (
                      <span className="ml-1 text-violet-300">
                        · {n.prompt_variant}
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>

            {confirmDelete ? (
              <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3">
                <div className="text-xs text-destructive">
                  {t("canvas.palette.deleteGroupConfirm", { title: g.title })}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 flex-1 gap-1 text-xs"
                    disabled={busy}
                    onClick={() => void doDelete()}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    {t("canvas.palette.deleteGroupBtn")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    {t("canvas.palette.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              !editing && (
                <Button
                  size="sm"
                  className="h-9 w-full gap-1.5 text-xs"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void onInsert(g.id).finally(() => setBusy(false));
                  }}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Boxes className="h-3.5 w-3.5" />
                  )}
                  {t("canvas.palette.insertGroupCanvas")}
                </Button>
              )
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}

/* ── Формы ────────────────────────────────────────────────────────────── */

function EditGroupForm({
  group,
  busy,
  setBusy,
  onDone,
}: {
  group: NodeGroupDetail;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onDone: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(group.title);
  const [description, setDescription] = useState(group.description);
  const [category, setCategory] = useState(group.category);

  const save = async () => {
    if (!title.trim()) {
      toast.error(t("canvas.palette.titleRequired"));
      return;
    }
    setBusy(true);
    try {
      await api.updateNodeGroup(group.id, {
        title: title.trim(),
        description: description.trim(),
        category,
      });
      toast.success(t("canvas.palette.groupUpdated"));
      onDone(true);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-teal-400/30 bg-teal-400/5 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-teal-300">
        {t("canvas.palette.editGroupTitle")}
      </div>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("canvas.palette.groupTitlePlaceholder")}
        className="h-8 text-xs"
        autoFocus
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("canvas.palette.groupDescPlaceholder")}
        className="min-h-[64px] text-xs"
      />
      <CategoryPicker value={category} onChange={setCategory} />
      <div className="mt-1 flex gap-1.5">
        <Button
          size="sm"
          className="h-8 flex-1 gap-1 text-xs"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t("canvas.palette.save")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          disabled={busy}
          onClick={() => onDone(false)}
        >
          {t("canvas.palette.cancel")}
        </Button>
      </div>
    </div>
  );
}

function CreateGroupForm({
  projectId,
  getSelectedNodeIds,
  onPersistCanvas,
  onDone,
}: {
  projectId: number | null;
  getSelectedNodeIds: () => string[];
  onPersistCanvas?: () => Promise<void> | void;
  onDone: (created: boolean, createdGroup?: NodeGroupSummary) => void;
}) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("planning");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!projectId) {
      toast.error(t("canvas.palette.selectProjectFirst"));
      return;
    }
    const nodeIds = getSelectedNodeIds();
    if (nodeIds.length === 0) {
      toast.error(t("canvas.palette.nothingSelected"));
      return;
    }
    if (!title.trim()) {
      toast.error(t("canvas.palette.enterGroupName"));
      return;
    }
    setBusy(true);
    try {
      if (onPersistCanvas) {
        await onPersistCanvas();
      }
      const g = await api.createNodeGroupFromSelection(projectId, {
        node_ids: nodeIds,
        title: title.trim(),
        description: description.trim(),
        category,
      });
      qc.setQueryData<NodeGroupSummary[]>(["node-groups"], (prev) => [
        g,
        ...(prev ?? []).filter((x) => x.id !== g.id),
      ]);
      toast.success(
        t("canvas.palette.groupSaved", {
          title: g.title,
          count: g.node_count,
        }),
      );
      onDone(true, g);
    } catch (e) {
      toast.error(errorMessageFromUnknown(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-teal-400/30 bg-teal-400/5 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-teal-300">
        {t("canvas.palette.newGroupFromSelection")}
      </div>
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("canvas.palette.newGroupPlaceholder")}
        className="h-7 text-xs"
        autoFocus
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("canvas.palette.newGroupDescPlaceholder")}
        className="min-h-[48px] text-xs"
      />
      <CategoryPicker value={category} onChange={setCategory} />
      <div className="mt-0.5 flex gap-1.5">
        <Button
          size="sm"
          className="h-7 flex-1 gap-1 text-xs"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t("canvas.palette.createGroupBtn")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={busy}
          onClick={() => onDone(false)}
        >
          {t("canvas.palette.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Выбор категории без нативного <select>: системный дропдаун открывается
 * поверх диалога и съедает клики. Здесь — inline-список в потоке формы.
 */
function CategoryPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (cat: string) => void;
}) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const label =
    getNodeCategoryLabel(value as NodeCategory, locale) ||
    value ||
    t("canvas.palette.categoryLabel");
  return (
    <div className="rounded-md border border-white/10 bg-black/30">
      <button
        type="button"
        className="flex h-7 w-full items-center justify-between px-2 text-xs"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-muted-foreground">{t("canvas.palette.categoryLabel")}</span>
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-0.5 border-t border-white/10 p-1">
          {GROUP_CATEGORY_OPTIONS.map((c) => (
            <button
              key={c}
              type="button"
              className={cn(
                "rounded px-1.5 py-1 text-left text-[10px] transition-colors",
                c === value
                  ? "bg-teal-400/15 text-teal-300"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            >
              {getNodeCategoryLabel(c as NodeCategory, locale)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
