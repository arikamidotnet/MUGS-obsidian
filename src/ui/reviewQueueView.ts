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

export class ReviewQueueView extends ItemView {
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
      if (!byLabel.has(key)) byLabel.set(key, { label: key, changes: [] });
      byLabel.get(key)!.changes.push(...changes);
    }

    if (byLabel.size === 0) {
      this.contentEl.createEl("p", { text: "No curated changes. Edits are synced automatically; use the queue to hold or stage specific files.", cls: "mags-muted" });
      return;
    }

    this.contentEl.createEl("h2", { text: "Review Queue", cls: "mugs-conflicts-panel-title" });
    for (const group of byLabel.values()) this.renderGroup(group);
  }

  private renderGroup(group: { label: string; changes: StagedChange[] }): void {
    const section = this.contentEl.createDiv({ cls: "mugs-conflicts-panel-group" });
    section.createEl("h3", { text: group.label, cls: "mugs-conflicts-panel-group-title" });

    for (const change of group.changes) {
      const row = section.createDiv({ cls: "mugs-conflict-row" });
      row.createSpan({ text: change.path, cls: "mugs-conflict-path" });
      const chip = row.createSpan({ text: STATE_LABEL[change.state], cls: "mugs-conflict-action mugs-conflict-action-theirs" });
      this.button(row, "Stage", change.mappingId, change.path, "staged");
      this.button(row, "Hold", change.mappingId, change.path, "held");
      this.button(row, "Clear", change.mappingId, change.path, "unstaged");
    }
  }

  private button(host: HTMLElement, text: string, mappingId: string, path: string, state: ChangeState): void {
    const el = host.createEl("button", {
      type: "button",
      text,
      cls: `mugs-conflict-btn mugs-conflict-btn-${state}`,
    });
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
  changes: StagedChange[];
}
