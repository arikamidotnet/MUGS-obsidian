import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type MugsPlugin from "../main";
import { renderNavigation } from "./navigation";

export const MUGS_PREFLIGHT_VIEW_TYPE = "mugs-preflight";

/** Preflight & rollout: saved local evidence, staged-mode control, and the
 *  guarded one-shot canary that is the ONLY way a mapping joins the automatic
 *  set. Every rollout decision is persisted before it can take effect. */
export class PreflightView extends ItemView {
  private busy = false;
  private unsubscribe?: () => void;
  constructor(private readonly plugin: MugsPlugin, leaf: WorkspaceLeaf) { super(leaf); }
  getViewType(): string { return MUGS_PREFLIGHT_VIEW_TYPE; }
  getDisplayText(): string { return "MUGS Preflight & Rollout"; }
  getIcon(): string { return "shield-check"; }

  async onOpen(): Promise<void> {
    // Stay current with sync/save outcomes without polling: sync passes,
    // rollout decisions and store writes all notify UI listeners.
    this.unsubscribe = this.plugin.onUiUpdate(() => { if (!this.busy) this.render(); });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    renderNavigation(root, MUGS_PREFLIGHT_VIEW_TYPE);
    root.createEl("h2", { text: "Preflight & rollout" });
    root.createEl("p", { text: "This page reads saved local evidence only — it does not fetch, test credentials, prove clone cleanliness or verify your backup by itself. The canary pass is the live check: it reaches the remote, revalidates the clone and syncs this one folder.", cls: "mugs-muted" });
    const settings = this.plugin.store.getSettings();
    const rollout = settings.sync.rollout;
    root.createEl("p", { text: settings.sync.paused ? "Automatic sync is globally paused." : "Automatic sync is globally active.", attr: { role: "status" } });
    if (this.plugin.store.loadError) root.createEl("p", { text: "Settings could not be loaded; rollout controls are unavailable." });
    if (this.plugin.store.isLocked()) root.createEl("p", { text: "Credentials are locked; unlock in Settings before any sync." });
    if (rollout?.mode !== "staged") {
      root.createEl("p", { text: "Legacy scheduling applies to all mappings when globally unpaused. Switching to staged mode starts with no automatically enabled mappings." });
      const confirm = root.createEl("label");
      const approval = confirm.createEl("input", { type: "checkbox" });
      confirm.createSpan({ text: "I understand all mappings will stop automatic syncing until individually enabled." });
      const start = root.createEl("button", { text: "Start staged rollout (all disabled)", type: "button" });
      start.disabled = true;
      approval.addEventListener("change", () => { start.disabled = !approval.checked || this.busy; });
      start.addEventListener("click", () => void this.act(() => this.plugin.startStagedRollout()));
    } else {
      root.createEl("p", { text: `${rollout.enabledMappingIds.length} of ${settings.mappings.length} mappings enabled for automatic sync. Global pause still takes precedence.` });
    }
    if (rollout?.mode === "staged") {
      root.createEl("h3", { text: "Enable a folder" });
      root.createEl("p", { text: "A canary runs one guarded sync pass for that folder. It becomes automatic only when the pass is verifiably clean (no conflicts, skipped files, deferred changes, pending work or review backlog) and the result is saved. Any failure leaves the folder disabled with the reason recorded below.", cls: "mugs-muted" });
      const backup = root.createEl("label");
      const acknowledged = backup.createEl("input", { type: "checkbox" });
      backup.createSpan({ text: "I have a current backup of this vault (or accept the consequences) before enabling automatic sync." });
      const arm = (button: HTMLButtonElement) => {
        button.disabled = !acknowledged.checked || this.busy;
        acknowledged.addEventListener("change", () => { button.disabled = !acknowledged.checked || this.busy; });
      };
      this.renderMappings(root, rollout, arm);
    } else {
      this.renderMappings(root, undefined, undefined);
    }
  }

  private renderMappings(
    root: HTMLElement,
    rollout: { enabledMappingIds: string[]; lastResult: Record<string, { status: "ok" | "blocked"; at: number; reason?: string }> } | undefined,
    arm: ((button: HTMLButtonElement) => void) | undefined,
  ): void {
    root.createEl("h3", { text: "Mapping evidence" });
    for (const evidence of this.plugin.preflightMappings()) {
      const card = root.createEl("section", { cls: "mugs-bulk-category" });
      card.createEl("h4", { text: evidence.label });
      const enabled = !!rollout?.enabledMappingIds.includes(evidence.id);
      card.createEl("p", { text: enabled ? "Automatic: enabled" : "Automatic: not enabled" });
      card.createEl("p", { text: `${evidence.reviewCount} review · ${evidence.conflictCount} conflict · ${evidence.pendingCount} pending` });
      card.createEl("p", { text: evidence.lastObservedAt ? `Last saved sync evidence: ${new Date(evidence.lastObservedAt).toLocaleString()}` : "No saved sync timestamp" });
      if (evidence.blockers.length) {
        const list = card.createEl("ul");
        for (const blocker of evidence.blockers) list.createEl("li", { text: blocker });
      } else {
        card.createEl("p", { text: "No blockers in saved state. The canary pass provides the live remote, clone and merge evidence.", cls: "mugs-muted" });
      }
      const result = rollout?.lastResult[evidence.id];
      if (result) card.createEl("p", { text: `Last rollout result: ${result.status} at ${new Date(result.at).toLocaleString()}${result.reason ? ` — ${result.reason}` : ""}` });
      if (enabled) {
        const disable = card.createEl("button", { text: "Disable this mapping", type: "button" });
        disable.addEventListener("click", () => void this.act(() => this.plugin.disableStagedMapping(evidence.id)));
      } else if (rollout && !evidence.blockers.length && arm) {
        const canary = card.createEl("button", { text: "Run canary and enable automatic sync", type: "button" });
        arm(canary);
        canary.addEventListener("click", () => void this.act(async () => {
          const result = await this.plugin.runMappingCanary(evidence.id);
          if (!result.enabled) new Notice(`MUGS canary — ${evidence.label} stays disabled: ${result.reason ?? "unverified"}`, 10_000);
          else new Notice(`MUGS canary — ${evidence.label} passed and is now syncing automatically.`, 8000);
        }));
      }
    }
    root.createEl("p", { text: "Use Review for retained repository files; do not infer deletion from a missing vault path. Disabling is always available; nothing is enabled without an explicit clean canary.", cls: "mugs-muted" });
  }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await action(); }
    catch (error) { new Notice(`MUGS rollout: ${error instanceof Error ? error.message : String(error)}`, 8000); }
    finally { this.busy = false; this.render(); }
  }
}
