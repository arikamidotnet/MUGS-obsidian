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

/** Status icon glyph per display status (status-bar vocabulary). */
const STATUS_ICON: Record<MapRowDisplay["label"], string> = {
  "in sync": "✓",
  pending: "⋯",
  "needs merge": "!",
  skipped: "⊘",
  failed: "×",
};

/** Map a display tone onto the existing status-icon CSS classes. */
const TONE_ICON_CLASS: Record<MapRowDisplay["tone"], string> = {
  success: "ok",
  warning: "pending",
  error: "conflict",
};

/** Direction label + icon for a mapping card. */
const DIRECTION_LABEL: Record<string, string> = {
  "push-pull": "⇄ Push + pull",
  "pull-only": "↓ Pull only",
  "push-only": "↑ Push only",
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export class MapView extends ItemView {
  getViewType(): string {
    return "mugs-map";
  }

  getDisplayText(): string {
    return "MUGS Map";
  }

  getIcon(): string {
    return "map";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("mugs-maps-view");
    this.addAction("refresh", "Refresh map", () => void this.refresh());
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await getMugsContext().map.getRows();
      const context: Record<string, MapContext> = {};
      for (const r of rows) context[r.mapping.id] = { owner: r.owner, status: r.status };
      const graph = buildMapGraph(rows.map((r) => r.mapping), context);
      this.render(graph, rows);
    } catch (err) {
      this.contentEl.empty();
      new Notice(`MUGS: could not load map — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private render(graph: MapGraph, rows: MapRow[]): void {
    this.contentEl.empty();
    this.renderLegend();

    if (rows.length === 0) {
      const empty = this.contentEl.createDiv({ cls: "mugs-empty-state" });
      empty.createEl("h3", { text: "No folder mappings yet" });
      empty.createEl("p", {
        text: "Add a credential and create your first folder mapping in the MUGS settings to see it here.",
        cls: "mugs-muted",
      });
      return;
    }

    this.renderSummary(rows);

    const grid = this.contentEl.createDiv({ cls: "mugs-map-grid" });
    // Build a lookup from mapping id → row for status/last-sync info.
    const rowByMappingId = new Map<string, MapRow>(rows.map((r) => [r.mapping.id, r]));

    // Render one card per mapping edge. Each card shows the folder→repo relationship.
    for (const edge of graph.edges) {
      const folder = graph.nodes.find((n) => n.id === edge.from)!;
      const repo = graph.nodes.find((n) => n.id === edge.to)!;
      this.renderCard(grid, edge, folder, repo, rowByMappingId.get(edge.mappingId));
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
    const totalChip = summary.createSpan({ cls: "mugs-chip mugs-chip-muted", text: `${rows.length} mapping${rows.length === 1 ? "" : "s"}` });
    const syncChip = summary.createSpan({
      cls: `mugs-chip ${inSync === rows.length ? "mugs-chip-success" : "mugs-chip-warning"}`,
      text: `${inSync}/${rows.length} in sync`,
    });
    if (latest) {
      summary.createSpan({ text: `last sync ${relativeTime(Date.now() - latest)}`, cls: "mugs-chip mugs-chip-muted" });
    }
  }

  private renderCard(grid: HTMLElement, edge: MapEdge, folder: MapNode, repo: MapNode, row?: MapRow): void {
    const card = grid.createDiv({ cls: "mugs-map-card" });

    // Honest display status — same vocabulary as the status bar ("needs merge",
    // "skipped", …) with the reason available on hover.
    const display = describeMapRow({
      status: row?.status ?? "pending",
      direction: edge.direction,
      skipReason: row?.skipReason,
      conflictCount: row?.conflictCount,
    });

    // Status accent bar + icon.
    const header = card.createDiv({ cls: "mugs-map-card-header" });
    header.createSpan({
      cls: `mugs-status-icon mugs-status-${TONE_ICON_CLASS[display.tone]}`,
      text: STATUS_ICON[display.label] ?? "⋯",
      ...(display.reason ? { attr: { title: display.reason } } : {}),
    });

    // Folder name (left side).
    const folderCol = header.createDiv({ cls: "mugs-map-card-folder" });
    folderCol.createEl("span", { cls: "mugs-map-card-title", text: truncate(folder.label, 30) });
    if (folder.owner) {
      folderCol.createEl("span", { cls: "mugs-map-card-owner", text: `owned by ${folder.owner}` });
    }

    // Direction glyph (center) — hover says what the arrow does NOT do.
    header.createSpan({
      cls: "mugs-map-card-direction",
      text: DIRECTION_LABEL[edge.direction] ?? edge.direction,
      attr: { title: directionHint(edge.direction) },
    });
    // Push-only mappings never pull — a distinct muted chip stops the "in sync"
    // card from implying content ever flows back from the remote.
    if (edge.direction === "push-only") {
      header.createSpan({
        cls: "mugs-chip mugs-chip-muted mugs-map-card-never",
        text: "never pulls",
        attr: { title: directionHint(edge.direction) },
      });
    }

    // Repo name (right side) with branch.
    const repoCol = header.createDiv({ cls: "mugs-map-card-repo" });
    repoCol.createEl("span", { cls: "mugs-map-card-title", text: truncate(repo.label, 30) });
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
      if (edge.direction !== "pull-only" && row.lastPushAt) parts.push(`pushed ${relativeTime(Date.now() - row.lastPushAt)}`);
      if (edge.direction !== "push-only" && row.lastPullAt) parts.push(`pulled ${relativeTime(Date.now() - row.lastPullAt)}`);
      const never =
        edge.direction === "push-only" ? "never pushed" : edge.direction === "pull-only" ? "never pulled" : "never synced";
      footer.createEl("span", { cls: "mugs-map-card-sync-times", text: parts.length ? parts.join(" · ") : never });

      footer.createSpan({
        cls: `mugs-chip mugs-chip-${display.tone}`,
        text: display.label,
        ...(display.reason ? { attr: { title: display.reason } } : {}),
      });
    }
  }

  private renderLegend(): void {
    const legend = this.contentEl.createDiv({ cls: "mugs-map-legend" });
    legend.createEl("span", { text: "Status:", cls: "mugs-map-legend-label" });
    // Same vocabulary as the cards and the status bar.
    for (const [label, tone] of [
      ["in sync", "success"],
      ["pending", "warning"],
      ["needs merge", "error"],
      ["skipped", "warning"],
      ["failed", "error"],
    ] as const) {
      const chip = legend.createDiv({ cls: "mugs-map-legend-item" });
      chip.createSpan({ cls: "mugs-map-legend-swatch", attr: { style: `background:${statusColor(tone)}` } });
      chip.createSpan({ text: label });
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

function statusColor(tone: MapRowDisplay["tone"]): string {
  switch (tone) {
    case "error":
      return "#e45b3d";
    case "warning":
      return "#d29922";
    default:
      return "#3fb950";
  }
}
