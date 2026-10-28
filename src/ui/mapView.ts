/**
 * MUGS — Map view (`mugs-map`).
 *
 * Obsidian glue only: it asks the injected {@link MapDataSource} for rows and renders
 * them as a card-based mapping overview. All logic lives in mapModel.ts (unit-tested);
 * this file never runs under vitest because it imports the Obsidian DOM API.
 */
import { ItemView, Notice } from "obsidian";
import { buildMapGraph, type MapContext, type MapEdge, type MapNode, type MapGraph } from "./mapModel";
import { getMugsContext } from "./dataSources";

/** Status icon glyph shown on each mapping card. */
const STATUS_ICON: Record<string, string> = {
  ok: "✓",
  "up-to-date": "✓",
  pending: "⋯",
  conflict: "!",
  error: "×",
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

  private render(graph: MapGraph, rows: Array<{ status: string; lastPushAt?: number; lastPullAt?: number; mapping: { id: string } }>): void {
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
    // Build a lookup from edge → row for status/last-sync info.
    const rowByMappingId = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const m = graph.edges.find((e) => e.mappingId === r.mapping.id);
      if (m) rowByMappingId.set(m.mappingId, r);
    }

    // Render one card per mapping edge. Each card shows the folder→repo relationship.
    for (const edge of graph.edges) {
      const folder = graph.nodes.find((n) => n.id === edge.from)!;
      const repo = graph.nodes.find((n) => n.id === edge.to)!;
      this.renderCard(grid, edge, folder, repo, rowByMappingId.get(edge.mappingId));
    }
  }

  /** Compact summary bar: mapping count, in-sync count, last sync time. */
  private renderSummary(rows: Array<{ status: string; lastPushAt?: number; lastPullAt?: number }>): void {
    const inSync = rows.filter((r) => r.status === "ok" || r.status === "up-to-date").length;
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

  private renderCard(
    grid: HTMLElement,
    edge: MapEdge,
    folder: MapNode,
    repo: MapNode,
    row?: { status: string; lastPushAt?: number; lastPullAt?: number },
  ): void {
    const card = grid.createDiv({ cls: "mugs-map-card" });

    // Status accent bar + icon.
    const header = card.createDiv({ cls: "mugs-map-card-header" });
    const statusIcon = header.createSpan({
      cls: `mugs-status-icon mugs-status-${row?.status ?? "pending"}`,
      text: STATUS_ICON[row?.status ?? "pending"] ?? "⋯",
    });

    // Folder name (left side).
    const folderCol = header.createDiv({ cls: "mugs-map-card-folder" });
    folderCol.createEl("span", { cls: "mugs-map-card-title", text: truncate(folder.label, 30) });
    if (folder.owner) {
      folderCol.createEl("span", { cls: "mugs-map-card-owner", text: `owned by ${folder.owner}` });
    }

    // Direction glyph (center).
    header.createSpan({ cls: "mugs-map-card-direction", text: DIRECTION_LABEL[edge.direction] ?? edge.direction });

    // Repo name (right side) with branch.
    const repoCol = header.createDiv({ cls: "mugs-map-card-repo" });
    repoCol.createEl("span", { cls: "mugs-map-card-title", text: truncate(repo.label, 30) });
    if (edge.branch) {
      repoCol.createEl("span", { cls: "mugs-map-card-branch", text: `branch: ${edge.branch}` });
    } else {
      repoCol.createEl("span", { cls: "mugs-map-card-detail", text: edge.remotePath || "whole repository" });
    }

    // Footer with last sync times.
    if (row) {
      const footer = card.createDiv({ cls: "mugs-map-card-footer" });
      const parts: string[] = [];
      if (row.lastPushAt) parts.push(`pushed ${relativeTime(Date.now() - row.lastPushAt)}`);
      if (row.lastPullAt) parts.push(`pulled ${relativeTime(Date.now() - row.lastPullAt)}`);
      footer.createEl("span", { cls: "mugs-map-card-sync-times", text: parts.length ? parts.join(" · ") : "never synced" });

      const statusLabel = (row.status ?? "pending").replace(/-/g, " ");
      footer.createSpan({ cls: `mugs-chip mugs-chip-${statusChipClass(row.status)}`, text: statusLabel });
    }
  }

  private renderLegend(): void {
    const legend = this.contentEl.createDiv({ cls: "mugs-map-legend" });
    legend.createEl("span", { text: "Status:", cls: "mugs-map-legend-label" });
    for (const [status, label] of [
      ["ok", "In sync"],
      ["pending", "Pending"],
      ["conflict", "Conflict"],
      ["error", "Error"],
    ] as const) {
      const chip = legend.createDiv({ cls: "mugs-map-legend-item" });
      chip.createSpan({ cls: "mugs-map-legend-swatch", attr: { style: `background:${statusColor(status)}` } });
      chip.createSpan({ text: label });
    }
  }
}

function statusChipClass(status?: string): string {
  switch (status) {
    case "ok":
    case "up-to-date":
      return "success";
    case "conflict":
    case "pending":
      return "warning";
    case "error":
      return "error";
    default:
      return "muted";
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

function statusColor(status: string): string {
  switch (status) {
    case "conflict":
      return "#e45b3d";
    case "error":
      return "#f85149";
    case "pending":
      return "#d29922";
    default:
      return "#3fb950";
  }
}
