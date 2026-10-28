/**
 * MUGS — review queue view (`mugs-review`).
 *
 * Obsidian glue only (like mapView/settingsTab): lists each curated change in the
 * persisted `staging` queue and lets the user move it between states — unstaged
 * (pending review), staged (selected for push), or held (deferred). State lives in
 * the store; this view is a thin render + action layer. It takes the plugin so it
 * can read/write staging, following settingsTab's plugin-DI pattern.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type MugsPlugin from "../main";
import type { ChangeState, StagedChange } from "../types";

const STATE_LABEL: Record<ChangeState, string> = { unstaged: "Pending", staged: "Staged", held: "Held" };

/** What each queue action does — shown as a hover tooltip. */
const STATE_TOOLTIP: Record<ChangeState, string> = {
  staged: "Stage this file — it will be pushed on the next sync.",
  held: "Hold this file — skip it on the next sync (deferred).",
  unstaged: "Clear from queue — let it sync automatically again.",
};

export class ReviewQueueView extends ItemView {
  /** Which state filter is currently active. */
  private activeFilter: ChangeState | "all" = "all";

  constructor(private plugin: MugsPlugin, leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return "mugs-review";
  }

  getDisplayText(): string {
    return "MUGS Review Queue";
  }

  getIcon(): string {
    return "clipboard-list";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("mugs-review-view");
    this.addAction("refresh", "Refresh queue", () => void this.render());
    await this.render();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  private render(): void {
    const settings = this.plugin.store.getSettings();
    const byLabel = new Map<string, FolderLike>();

    for (const mapping of settings.mappings) {
      const changes = settings.staging[mapping.id] ?? [];
      if (changes.length === 0) continue;
      const key = mapping.label || mapping.id;
      if (!byLabel.has(key)) byLabel.set(key, { label: key, id: mapping.id, changes: [] });
      byLabel.get(key)!.changes.push(...changes);
    }

    // Count totals for filter badges.
    let totalPending = 0;
    let totalStaged = 0;
    let totalHeld = 0;
    for (const group of byLabel.values()) {
      for (const c of group.changes) {
        if (c.state === "staged") totalStaged++;
        else if (c.state === "held") totalHeld++;
        else totalPending++;
      }
    }

    // Empty state.
    const total = totalPending + totalStaged + totalHeld;
    if (total === 0) {
      const empty = this.contentEl.createDiv({ cls: "mugs-empty-state" });
      empty.createEl("h3", { text: "No curated changes" });
      empty.createEl("p", {
        text: "Edits are synced automatically; use the queue to hold or stage specific files.",
        cls: "mugs-muted",
      });
      return;
    }

    // Title + filter tabs.
    this.contentEl.createEl("h2", { text: "Review Queue", cls: "mugs-conflicts-panel-title" });

    const filters = this.contentEl.createDiv({ cls: "mugs-review-filters" });
    this.renderFilterTab(filters, "all", "All", total, true);
    this.renderFilterTab(filters, "staged", `Staged (${totalStaged})`, totalStaged, false);
    this.renderFilterTab(filters, "held", `Held (${totalHeld})`, totalHeld, false);
    this.renderFilterTab(filters, "unstaged", `Pending (${totalPending})`, totalPending, false);

    const legend = this.contentEl.createDiv({ cls: "mugs-review-legend" });
    legend.createSpan({ text: "Stage = include in next push · Hold = skip next sync · Clear = let it auto-sync", cls: "mugs-review-legend-text" });

    for (const group of byLabel.values()) {
      this.renderGroup(group);
    }
  }

  /** Render a filter tab button. */
  private renderFilterTab(host: HTMLElement, state: string, label: string, count: number, active: boolean): void {
    const tab = host.createEl("button", { type: "button", text: label, cls: `mugs-filter-tab${active ? " mugs-filter-tab-active" : ""}` });
    if (!count && state !== "all") tab.disabled = true;
    tab.addEventListener("click", () => {
      this.activeFilter = (state === "all" ? "all" : state) as ChangeState | "all";
      void this.render();
    });
  }

  private renderGroup(group: FolderLike): void {
    // Filter changes by active filter.
    const visible = group.changes.filter((c) => this.activeFilter === "all" || c.state === this.activeFilter);
    if (visible.length === 0) return;

    const section = this.contentEl.createDiv({ cls: "mugs-conflicts-panel-group" });
    section.createEl("h3", { text: group.label, cls: "mugs-conflicts-panel-group-title" });

    for (const change of visible) {
      this.renderChangeRow(section, group.id, change);
    }
  }

  private renderChangeRow(host: HTMLElement, mappingId: string, change: StagedChange): void {
    const row = host.createDiv({ cls: "mugs-review-row" });

    // Path.
    row.createSpan({ text: change.path, cls: "mugs-review-path" });

    // State badge.
    const stateLabel = STATE_LABEL[change.state];
    const stateClass = `mugs-state-${change.state}`;
    row.createSpan({ text: stateLabel, cls: `mugs-state-badge ${stateClass}` });

    // Action buttons — only show the ones that change TO a different state.
    const actions = row.createDiv({ cls: "mugs-review-actions" });
    if (change.state !== "staged") this.renderActionButton(actions, "Stage", mappingId, change.path, "staged");
    if (change.state !== "held") this.renderActionButton(actions, "Hold", mappingId, change.path, "held");
    if (change.state !== "unstaged") this.renderActionButton(actions, "Clear", mappingId, change.path, "unstaged");
  }

  private renderActionButton(host: HTMLElement, text: string, mappingId: string, path: string, state: ChangeState): void {
    const el = host.createEl("button", { type: "button", text });
    el.setAttribute("title", STATE_TOOLTIP[state]);
    el.setAttr("aria-tooltip", STATE_TOOLTIP[state]);
    el.addEventListener("click", () => void this.setChangeState(mappingId, path, state));
  }

  private async setChangeState(mappingId: string, path: string, state: ChangeState): Promise<void> {
    const settings = this.plugin.store.getSettings();
    const current = settings.staging[mappingId] ?? [];
    const next = current.map((c) => (c.path === path ? { ...c, state } : c));
    // Drop the entry if it returns to unstaged (no longer curated).
    const active = next.filter((c) => c.state !== "unstaged");
    this.plugin.store.setStaging(mappingId, active);
    await this.plugin.store.save();
    void this.render();
  }
}

/** Structural shape of a mapping needed to group the queue by label. */
interface FolderLike {
  label: string;
  id: string;
  changes: StagedChange[];
}
