/**
 * MUGS — Map view (`mugs-map`).
 *
 * Obsidian glue only: it asks the injected {@link MapDataSource} for rows and renders
 * them as a card-based mapping overview. All logic lives in mapModel.ts (unit-tested);
 * this file never runs under vitest because it imports the Obsidian DOM API.
 */
import { ItemView, Notice } from "obsidian";
import { buildMapGraph, describeMapRow, directionHint, type MapContext, type MapEdge, type MapNode, type MapGraph, type MapRowDisplay } from "./mapModel";
import { getMugsContext, type MapRow } from "./dataSources";
import { directionLabel } from "./labels";
import { renderNavigation } from "./navigation";

/** Status icon glyph per display status (status-bar vocabulary). */
const STATUS_ICON: Record<MapRowDisplay["label"], string> = {
  "in sync": "✓",
  pending: "⋯",
  "needs review": "!",
  skipped: "⊘",
  failed: "×",
};

/** Direction label + icon for a mapping card. */
const DIRECTION_LABEL: Record<string, string> = {
  "push-pull": `⇄ ${directionLabel("push-pull")}`,
  "pull-only": `↓ ${directionLabel("pull-only")}`,
  "push-only": `↑ ${directionLabel("push-only")}`,
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export class MapView extends ItemView {
  private generation = 0;
  private closed = false;
  private unsubscribe?: () => void;
  getViewType(): string {
    return "mugs-map";
  }

  private renderHeader(): void {
    renderNavigation(this.contentEl, "mugs-map");
    const header = this.contentEl.createDiv({ cls: "mugs-overview-header" });
    header.createEl("h2", { text: "Your sync" });
    const actions = getMugsContext().actions;
    header.createEl("p", { text: "Check your folders, sync changes, or review files that need attention.", cls: "mugs-muted" });
    if (!actions) return;
    const state = actions.getState();
    if (state.syncing || state.paused) {
      header.createEl("p", {
        text: state.syncing ? "Syncing now…" : "Automatic sync is paused. You can still use Sync now.",
        cls: "mugs-note",
        attr: { role: "status" },
      });
    }
    const controls = header.createDiv({ cls: "mugs-overview-actions" });
    const sync = controls.createEl("button", { type: "button", text: state.syncing ? "Syncing…" : "Sync now", cls: "mod-cta" });
    sync.disabled = state.syncing;
    sync.addEventListener("click", async () => {
      if (sync.disabled) return;
      sync.disabled = true;
      sync.textContent = "Syncing…";
      try {
        await actions.syncNow();
      } catch (err) {
        new Notice(`MUGS: sync failed — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (!this.closed && !actions.subscribe) await this.refresh();
      }
    });
    const review = controls.createEl("button", {
      type: "button",
      text: state.reviewCount ? `Review files (${state.reviewCount})` : "Review files",
      attr: { title: "Review repository files kept for safety" },
    });
    review.addEventListener("click", () => actions.openReview());
    const settings = controls.createEl("button", { type: "button", text: "Settings" });
    settings.addEventListener("click", () => actions.openSettings());
  }

  getDisplayText(): string {
    return "MUGS Overview";
  }

  getIcon(): string {
    return "map";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.unsubscribe?.();
    this.unsubscribe = getMugsContext().actions?.subscribe?.(() => { void this.refresh(); });
    this.contentEl.empty();
    this.contentEl.addClass("mugs-maps-view");
    this.addAction("refresh", "Refresh overview", () => void this.refresh());
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const rows = await getMugsContext().map.getRows();
      if (this.closed || generation !== this.generation) return;
      const context: Record<string, MapContext> = {};
      for (const r of rows) context[r.mapping.id] = { owner: r.owner, status: r.status };
      const graph = buildMapGraph(rows.map((r) => r.mapping), context);
      this.render(graph, rows);
    } catch (err) {
      if (this.closed || generation !== this.generation) return;
      this.contentEl.empty();
      this.renderHeader();
      this.contentEl.createEl("p", { text: "Couldn't load folder status. Use Refresh to try again.", cls: "mugs-muted" });
      new Notice(`MUGS: could not load overview — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private render(graph: MapGraph, rows: MapRow[]): void {
    this.contentEl.empty();
    this.renderHeader();

    if (rows.length === 0) {
      const empty = this.contentEl.createDiv({ cls: "mugs-empty-state" });
      empty.createEl("h3", { text: "No folders connected" });
      empty.createEl("p", {
        text: "Connect a folder in MUGS settings to see it here.",
        cls: "mugs-muted",
      });
      return;
    }

    this.renderSummary(rows);

    const list = this.contentEl.createDiv({ cls: "mugs-sync-list", attr: { role: "list", "aria-label": "Connected folders" } });
    // Build a lookup from mapping id → row for status/last-sync info.
    const rowByMappingId = new Map<string, MapRow>(rows.map((r) => [r.mapping.id, r]));

    // Render one aligned row per mapping edge: folder → direction → repository → times → status.
    for (const edge of graph.edges) {
      const folder = graph.nodes.find((n) => n.id === edge.from)!;
      const repo = graph.nodes.find((n) => n.id === edge.to)!;
      this.renderRow(list, edge, folder, repo, rowByMappingId.get(edge.mappingId));
    }
  }

  /** Compact summary bar: mapping count, in-sync count, last sync time. */
  private renderSummary(rows: MapRow[]): void {
    // "In sync" uses the same honest status model as the cards — a skipped or
    // conflicted mapping never counts as synced.
    const inSync = rows.filter(
      (r) => describeMapRow({ status: r.status, direction: r.mapping.direction, skipReason: r.skipReason }).label === "in sync",
    ).length;
    let latest = 0;
    for (const r of rows) {
      if (r.lastPushAt && r.lastPushAt > latest) latest = r.lastPushAt;
      if (r.lastPullAt && r.lastPullAt > latest) latest = r.lastPullAt;
    }

    const summary = this.contentEl.createDiv({ cls: "mugs-map-summary" });
    summary.createSpan({ text: `${rows.length} folder${rows.length === 1 ? "" : "s"}` });
    summary.createSpan({
      cls: inSync === rows.length ? "mugs-text-success" : "mugs-text-warning",
      text: `${inSync}/${rows.length} in sync`,
    });
    if (latest) {
      summary.createSpan({ text: `last sync ${relativeTime(Date.now() - latest)}` });
    }
  }

  private renderRow(list: HTMLElement, edge: MapEdge, folder: MapNode, repo: MapNode, row?: MapRow): void {
    const card = list.createDiv({ cls: "mugs-sync-row", attr: { role: "listitem" } });

    // Honest display status — same vocabulary as the status bar ("needs merge",
    // "skipped", …) with the reason available on hover.
    const display = describeMapRow({
      status: row?.status ?? "pending",
      direction: edge.direction,
      skipReason: row?.skipReason,
      conflictCount: row?.conflictCount,
    });

    // Folder name (left side).
    const folderCol = card.createDiv({ cls: "mugs-map-card-folder" });
    folderCol.createEl("span", { cls: "mugs-map-card-title", text: truncate(folder.label, 30), attr: { title: folder.label } });
    if (folder.owner) {
      folderCol.createEl("span", { cls: "mugs-map-card-owner", text: folder.owner, attr: { title: `Recent author: ${folder.owner}` } });
    }

    // Direction (center column) — hover says what the arrow does NOT do.
    const direction = card.createDiv({ cls: "mugs-sync-direction" });
    direction.createSpan({
      cls: "mugs-map-card-direction",
      text: DIRECTION_LABEL[edge.direction] ?? edge.direction,
      attr: { title: directionHint(edge.direction) },
    });
    // Push-only mappings never pull — the quiet note stops an "in sync" row
    // from implying content ever flows back from the repository.
    if (edge.direction === "push-only") {
      direction.createSpan({
        cls: "mugs-map-card-detail",
        text: "no downloads",
        attr: { title: directionHint(edge.direction) },
      });
    }

    // Repo name (right side) with branch.
    const repoCol = card.createDiv({ cls: "mugs-map-card-repo" });
    repoCol.createEl("span", { cls: "mugs-map-card-title", text: truncate(repo.label, 30), attr: { title: repo.label } });
    if (edge.branch) {
      repoCol.createEl("span", { cls: "mugs-map-card-branch", text: `branch: ${edge.branch}` });
    } else {
      repoCol.createEl("span", { cls: "mugs-map-card-detail", text: edge.remotePath || "whole repository" });
    }

    // Footer with last sync times — only the times this direction can actually
    // produce (a push-only mapping never shows "pulled", a pull-only never "pushed").
    if (row) {
      const footer = card.createDiv({ cls: "mugs-map-card-footer" });
      const parts: string[] = [];
      if (edge.direction !== "pull-only" && row.lastPushAt) parts.push(`uploaded ${relativeTime(Date.now() - row.lastPushAt)}`);
      if (edge.direction !== "push-only" && row.lastPullAt) parts.push(`downloaded ${relativeTime(Date.now() - row.lastPullAt)}`);
      const never =
        edge.direction === "push-only" ? "not uploaded yet" : edge.direction === "pull-only" ? "not downloaded yet" : "not synced yet";
      footer.createEl("span", { cls: "mugs-map-card-sync-times", text: parts.length ? parts.join(" · ") : never });

      footer.createSpan({
        cls: `mugs-sync-status mugs-text-${display.tone}`,
        text: `${STATUS_ICON[display.label]} ${display.label}`,
        ...(display.reason ? { attr: { title: display.reason } } : {}),
      });
    }
  }

}

/** Human-friendly relative time, e.g. "2 min ago", "3 hours ago". */
function relativeTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
