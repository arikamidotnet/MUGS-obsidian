/**
 * MUGS — conflicts sidebar view (`mugs-conflicts`).
 *
 * A right-sidebar view listing every unresolved conflict across all mappings, each
 * labeled with what "ours" and "theirs" did (see describeConflictActions) and offering
 * Take ours / theirs / Merge both. It shares the per-conflict row renderer with the
 * full-tab Diff view so both surfaces look identical. Registered as a REAL ItemView —
 * the previous implementation called workspace.createPanelTab, a method that does
 * not exist in Obsidian (the module augmentation below was fiction), so the panel
 * could never open from any entry point.
 */
import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import { getMugsContext } from "./dataSources";
import { renderConflictRow, renderRowError } from "./diffRender";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

export const MUGS_CONFLICTS_VIEW_TYPE = "mugs-conflicts";

interface ConflictGroup {
  mappingId: string;
  label: string;
  conflicts: FileConflict[];
}

export class MugsConflictsPanel extends ItemView {
  /** Auto-refresh interval handle, if enabled. */
  private autoRefreshTimer?: number;
  /** Whether auto-refresh is currently on. */
  private autoRefresh = false;
  /** True while a load/resolve pass is running — re-entrant renders would race
   *  two DOM rebuilds and can drop a resolve callback mid-flight. */
  private renderInFlight = false;
  /** Per-path error messages from failed resolutions (e.g. the editor-open
   *  guard) — repainted under the matching row on every render until the file
   *  is resolved or disappears, so the inline note survives group refreshes. */
  private resolveErrors: Record<string, string> = {};

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return MUGS_CONFLICTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "MUGS Conflicts";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.stopAutoRefresh();
    this.containerEl.empty();
    return Promise.resolve();
  }

  /** Stop the auto-refresh timer if one is running (idempotent). Also resets
   *  the on-flag — the error state and the empty state both stop the timer, and
   *  a stale true flag would leave the button reading "on" (and the next toggle
   *  a no-op) while nothing is actually refreshing. */
  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer !== undefined) {
      window.clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    this.autoRefresh = false;
  }

  /** Start the auto-refresh timer exactly once (idempotent). Toggling quickly,
   *  twice, never stacks two intervals. */
  private startAutoRefresh(): void {
    this.stopAutoRefresh();
    this.autoRefresh = true;
    this.autoRefreshTimer = window.setInterval(() => void this.render(), 10_000);
  }

  private setAutoButtonLabel(btn: HTMLElement): void {
    // Plain text only — UI copy carries no emoji glyphs.
    btn.textContent = this.autoRefresh ? "Auto-refresh on" : "Auto-refresh off";
  }

  private async render(): Promise<void> {
    // Never re-enter: a resolve's refresh, a manual click and the auto timer can
    // overlap — two concurrent render()s rebuild the DOM twice and the slower
    // one can attach its callbacks onto elements the faster one already emptied.
    if (this.renderInFlight) return;
    this.renderInFlight = true;
    try {
      await this.renderOnce();
    } finally {
      this.renderInFlight = false;
    }
  }

  private async renderOnce(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("mugs-conflicts-panel");

    const header = this.containerEl.createDiv({ cls: "mugs-conflicts-panel-header" });
    header.createEl("h2", { text: "MUGS Conflicts", cls: "mugs-conflicts-panel-title" });

    // Auto-refresh toggle.
    const autoBtn = header.createEl("button", { type: "button", text: "", cls: "mugs-conflicts-panel-refresh" });
    this.setAutoButtonLabel(autoBtn);
    autoBtn.addEventListener("click", () => {
      if (this.autoRefresh) {
        this.stopAutoRefresh();
      } else {
        this.startAutoRefresh();
      }
      this.setAutoButtonLabel(autoBtn);
    });

    const refreshBtn = header.createEl("button", { type: "button", text: "Refresh", cls: "mugs-conflicts-panel-refresh" });
    refreshBtn.addEventListener("click", () => void this.render());

    try {
      const groups = await this.loadGroups();
      this.renderBody(groups);
    } catch (err) {
      // Error state — auto-refresh STOPS (re-rendering on a persistent error
      // would loop with a Notice per cycle); the inline message says how to retry.
      this.stopAutoRefresh();
      this.setAutoButtonLabel(autoBtn);
      this.containerEl.createEl("p", {
        cls: "mugs-muted",
        text: `Could not load conflicts — ${err instanceof Error ? err.message : String(err)}. Click Refresh to retry.`,
      });
    }
  }

  /** Collect each mapping's unresolved conflicts, skipping mappings with none. */
  private async loadGroups(): Promise<ConflictGroup[]> {
    const rows = await getMugsContext().map.getRows();
    const groups: ConflictGroup[] = [];
    for (const r of rows) {
      const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId: r.mapping.id });
      if (conflicts.length > 0) {
        groups.push({ mappingId: r.mapping.id, label: r.mapping.label || r.mapping.id, conflicts });
      }
    }
    return groups;
  }

  private renderBody(groups: ConflictGroup[]): void {
    const total = groups.reduce((n, g) => n + g.conflicts.length, 0);

    if (total === 0) {
      // All clear: nothing to refresh on a timer — stop it so the panel never
      // wakes every 10s for an empty state.
      this.stopAutoRefresh();
      const btn = this.containerEl.querySelector(".mugs-conflicts-panel-refresh") as HTMLElement | null;
      if (btn) this.setAutoButtonLabel(btn);

      this.containerEl.createEl("p", { text: "All conflicts resolved.", cls: "mugs-muted" });
      return;
    }

    // Summary line with conflict count badge.
    const summary = this.containerEl.createDiv({ cls: "mugs-conflicts-summary" });
    summary.createEl("p", {
      text: `${total} file${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} manual resolution across ${groups.length} mapping${groups.length === 1 ? "" : "s"}.`,
      cls: "mugs-muted",
    });

    const seen = new Set<string>();
    for (const g of groups) {
      const section = this.containerEl.createDiv({ cls: "mugs-conflicts-panel-group" });
      // Group header with conflict count badge.
      const groupHeader = section.createDiv({ cls: "mugs-conflicts-panel-group-header" });
      groupHeader.createEl("h3", { text: g.label, cls: "mugs-conflicts-panel-group-title" });
      groupHeader.createSpan({ text: String(g.conflicts.length), cls: "mugs-chip mugs-chip-error" });

      for (const c of g.conflicts) {
        const row = renderConflictRow(section, c, (conflict, choice) => void this.resolve(g.mappingId, conflict, choice));
        seen.add(c.path);
        // Repaint any recorded resolution failure under its row — the editor-open
        // guard names the exact file and remedy; the Notice alone vanishes.
        const error = this.resolveErrors[c.path];
        if (error) renderRowError(row, error);
      }
    }
    // Drop notes for paths no longer in conflict (resolved elsewhere or gone).
    for (const path of Object.keys(this.resolveErrors)) {
      if (!seen.has(path)) delete this.resolveErrors[path];
    }
  }

  /** Resolve one file's conflict for its mapping, persist it, then refresh groups.
   *  A failure (e.g. the file is open with unsaved changes) is recorded per path
   *  and rendered inline under the affected row on the refresh — in addition to
   *  the Notice — until the file is resolved or disappears. */
  private async resolve(mappingId: string, c: FileConflict, choice: ResolveChoice): Promise<void> {
    try {
      await getMugsContext().conflicts.resolveConflict({ mappingId, path: c.path, choice });
      delete this.resolveErrors[c.path];
      new Notice(`MUGS — resolved ${c.path} (${choice}).`);
    } catch (err) {
      const message = `Could not resolve ${c.path}: ${err instanceof Error ? err.message : String(err)}`;
      this.resolveErrors[c.path] = message;
      new Notice(`MUGS — ${message}`);
    }
    // Always refresh groups afterwards: a success must remove the row (and update
    // the remaining counts), a failure must re-sync any state a concurrent sync changed.
    void this.render();
  }
}
