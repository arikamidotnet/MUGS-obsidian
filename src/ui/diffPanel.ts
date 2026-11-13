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
import { renderConflictRow, renderRowError, renderConflictComparison } from "./diffRender";
import type { FileConflict, ResolveChoice } from "../sync/conflict";
import { resolutionLabel } from "./labels";
import { renderNavigation } from "./navigation";

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
  private selectedKey?: string;
  private closed = false;

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
    this.closed = false;
    await this.render();
  }

  async onClose(): Promise<void> {
    this.closed = true;
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
    if (this.closed || this.renderInFlight) return;
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
    this.containerEl.addClass("mugs-diff-view");
    renderNavigation(this.containerEl, "mugs-conflicts");

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
      if (this.closed) return;
      this.renderBody(groups);
    } catch (err) {
      if (this.closed) return;
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
      this.containerEl.createEl("p", { text: "Separate edits combine automatically during sync. Files only appear here when overlapping edits still need a decision.", cls: "mugs-page-description" });
      return;
    }

    // Summary line with conflict count badge.
    const summary = this.containerEl.createDiv({ cls: "mugs-conflicts-summary" });
    summary.createEl("p", {
      text: `${total} file${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} your review in ${groups.length} folder${groups.length === 1 ? "" : "s"}.`,
      cls: "mugs-muted",
    });

    const browser = this.containerEl.createDiv({ cls: "mugs-diff-browser" });
    const list = browser.createDiv({ cls: "mugs-diff-file-list" });
    list.setAttribute("aria-label", "Conflicting files");
    const focused = browser.createDiv({ cls: "mugs-diff-focused" });
    const entries = groups.flatMap((group) => group.conflicts.map((conflict) => ({
      group, conflict, key: JSON.stringify([group.mappingId, conflict.path]),
    })));
    if (!entries.some((entry) => entry.key === this.selectedKey)) this.selectedKey = entries[0].key;
    const buttons: HTMLButtonElement[] = [];
    const select = (index: number) => {
      const { group, conflict, key } = entries[index];
      this.selectedKey = key;
      buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
      focused.empty();
      focused.createEl("h3", { text: group.label, cls: "mugs-conflicts-panel-group-title" });
      renderConflictComparison(focused, conflict);
      const row = renderConflictRow(focused, conflict, (c, choice) => {
        if (!this.closed && !this.resolving.has(c.path)) void this.resolve(group.mappingId, c, choice);
      }, this.resolving);
      if (this.resolveErrors[key]) renderRowError(row, this.resolveErrors[key]);
      focused.createEl("p", { cls: "mugs-page-description", text: "Choices apply to the whole file. Combine both keeps both versions when their edits overlap; it may need cleanup. Sync publishes the recorded choice." });
    };
    entries.forEach(({ group, conflict }, index) => {
      const button = list.createEl("button", { type: "button", cls: "mugs-diff-file-choice", attr: { title: conflict.path } });
      const slash = conflict.path.lastIndexOf("/");
      button.createSpan({ text: conflict.path.slice(slash + 1), cls: "mugs-diff-file-path" });
      button.createSpan({ text: [group.label, conflict.path.slice(0, Math.max(0, slash))].filter(Boolean).join(" · "), cls: "mugs-muted" });
      button.addEventListener("click", () => { if (!this.closed) select(index); });
      buttons.push(button);
    });
    select(entries.findIndex((entry) => entry.key === this.selectedKey));
    const seen = new Set(entries.map((entry) => entry.key));
    // Drop notes for paths no longer in conflict (resolved elsewhere or gone).
    for (const path of Object.keys(this.resolveErrors)) {
      if (!seen.has(path)) delete this.resolveErrors[path];
    }
  }

  /** Paths whose resolution is in flight (disable whole group for that conflict until settles). */
  private resolving: Set<string> = new Set();

  /** Resolve one file's conflict for its mapping, persist it, then refresh groups.
   *  U03: whole action group disabled until promise; errors keyed; retryable keeps visible.
   */
  private async resolve(mappingId: string, c: FileConflict, choice: ResolveChoice): Promise<void> {
    const key = c.path;
    if (this.closed || this.resolving.has(key)) return;
    const errorKey = JSON.stringify([mappingId, key]);
    this.resolving.add(key);
    // Immediate re-render to reflect disabled group.
    await this.render();
    try {
      await getMugsContext().conflicts.resolveConflict({ mappingId, path: key, choice });
      this.resolving.delete(key);
      delete this.resolveErrors[errorKey];
      new Notice(`MUGS — ${key}: kept ${resolutionLabel(choice)}.`);
    } catch (err) {
      this.resolving.delete(key);
      const message = `Could not resolve ${key}: ${err instanceof Error ? err.message : String(err)}`;
      this.resolveErrors[errorKey] = message;
      new Notice(`MUGS — ${message}`);
    }
    void this.render();
  }
}
