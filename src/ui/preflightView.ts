import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";
import type MugsPlugin from "../main";
import { renderNavigation } from "./navigation";
import type { MappingPreflight } from "../runtime/preflight";

export const MUGS_PREFLIGHT_VIEW_TYPE = "mugs-preflight";

/** Rollout bookkeeping the detail pane reads (kept structurally identical to
 *  the persisted SyncPolicy["rollout"] shape it is fed from). */
interface RolloutState {
  mode: "legacy" | "staged";
  enabledMappingIds: string[];
  blocked: Record<string, { reason: string; at: number }>;
  lastResult: Record<string, { status: "ok" | "blocked"; at: number; reason?: string }>;
}

/** Human wording for a mapping's last recorded sync status. */
const statusLabel = (status?: MappingPreflight["status"]): string =>
  status === "ok" ? "Synced"
    : status === "up-to-date" ? "Up to date"
      : status === "conflict" ? "Conflict needs review"
        : status === "error" ? "Sync failed"
          : status === "pending" ? "Sync pending"
            : "No saved sync status";

/** Sync-status dot class — the same scale the settings/overview rows use. */
const statusDot = (status?: MappingPreflight["status"]): string =>
  status === "ok" || status === "up-to-date" ? "mugs-status-ok"
    : status === "error" ? "mugs-status-error"
      : status === "conflict" || status === "pending" ? "mugs-status-warning"
        : "mugs-status-none";

/** Preflight & rollout: saved local evidence, staged-mode control, and the
 *  guarded one-shot canary that is the ONLY way a mapping joins the automatic
 *  set. Every rollout decision is persisted before it can take effect.
 *
 *  Layout mirrors the Review page (folder list beside a detail pane with a
 *  search filter and live per-folder status dots) so both decision surfaces
 *  read the same way. */
export class PreflightView extends ItemView {
  private busy = false;
  private unsubscribe?: () => void;
  private query = "";
  private selectedId?: string;
  constructor(private readonly plugin: MugsPlugin, leaf: WorkspaceLeaf) { super(leaf); }

  getViewType(): string { return MUGS_PREFLIGHT_VIEW_TYPE; }
  getDisplayText(): string { return "MUGS Preflight & Rollout"; }
  getIcon(): string { return "shield-check"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("mugs-preflight");
    // Stay current with sync/save outcomes without polling: sync passes,
    // rollout decisions and store writes all notify UI listeners.
    this.unsubscribe = this.plugin.onUiUpdate(() => { if (!this.busy) this.render(); });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    renderNavigation(root, MUGS_PREFLIGHT_VIEW_TYPE);
    // The page body reuses the Review page's text rhythm (p/label/button
    // scaling) by scoping it to a host div — never the view root, so the
    // shared navigation keeps its own styling.
    const page = root.createDiv({ cls: "mugs-reconciliation" });
    page.createEl("h2", { text: "Preflight & rollout", cls: "mugs-page-title" });
    page.createEl("p", {
      text: "This page reads saved local evidence only — it does not fetch, test credentials, prove clone cleanliness or verify your backup by itself. The canary pass is the live check: it reaches the remote, revalidates the clone and syncs this one folder.",
      cls: "mugs-page-description",
    });

    const settings = this.plugin.store.getSettings();
    const rollout = settings.sync.rollout as RolloutState | undefined;

    // Global status banner: pause state and staged-mode coverage at a glance.
    const banner = page.createEl("p", { cls: "mugs-preflight-banner", attr: { role: "status" } });
    banner.createSpan({ text: settings.sync.paused ? "⏸ Automatic sync is globally paused." : "▶ Automatic sync is globally active." });
    if (rollout?.mode === "staged") {
      banner.createSpan({
        text: `Staged rollout: ${rollout.enabledMappingIds.length} of ${settings.mappings.length} folders enabled.`,
      });
    }
    if (this.plugin.store.loadError) page.createEl("p", { text: "Settings could not be loaded; rollout controls are unavailable." });
    if (this.plugin.store.isLocked()) page.createEl("p", { text: "Credentials are locked; unlock in Settings before any sync." });

    if (rollout?.mode !== "staged") {
      page.createEl("p", {
        text: "Legacy scheduling applies to all mappings when globally unpaused. Switching to staged mode starts with no automatically enabled mappings.",
        cls: "mugs-muted",
      });
      const confirm = page.createEl("label");
      const approval = confirm.createEl("input", { type: "checkbox" });
      confirm.createSpan({ text: "I understand all mappings will stop automatic syncing until individually enabled." });
      const start = page.createEl("button", { text: "Start staged rollout (all disabled)", type: "button" });
      start.disabled = true;
      approval.addEventListener("change", () => { start.disabled = !approval.checked || this.busy; });
      start.addEventListener("click", () => void this.act(() => this.plugin.startStagedRollout()));
    }

    // Staged mode: one backup acknowledgment arms every canary control.
    let arm: ((button: HTMLButtonElement) => void) | undefined;
    if (rollout?.mode === "staged") {
      page.createEl("h3", { text: "Enable a folder" });
      page.createEl("p", {
        text: "A canary runs one guarded sync pass for that folder. It becomes automatic only when the pass is verifiably clean (no conflicts, skipped files, deferred changes, pending work or review backlog) and the result is saved. Any failure leaves the folder disabled with the reason recorded in its details.",
        cls: "mugs-muted",
      });
      const backup = page.createEl("label");
      const acknowledged = backup.createEl("input", { type: "checkbox" });
      backup.createSpan({ text: "I have a current backup of this vault (or accept the consequences) before enabling automatic sync." });
      arm = (button: HTMLButtonElement) => {
        button.disabled = !acknowledged.checked || this.busy;
        acknowledged.addEventListener("change", () => { button.disabled = !acknowledged.checked || this.busy; });
      };
    }

    this.renderMappings(page, rollout, arm);
  }

  /** Folder list + detail pane, mirroring the Review tab's layout. Saved
   *  evidence only; selection and the search query survive re-renders. */
  private renderMappings(
    root: HTMLElement,
    rollout: RolloutState | undefined,
    arm: ((button: HTMLButtonElement) => void) | undefined,
  ): void {
    root.createEl("h3", { text: "Folder status" });
    const evidence = this.plugin.preflightMappings();
    if (!evidence.length) {
      root.createEl("p", { text: "No folders connected yet. Add one in Settings to begin.", cls: "mugs-muted" });
      return;
    }
    // Keep the selection stable across pushed re-renders (sync finished etc.).
    if (this.selectedId && !evidence.some(item => item.id === this.selectedId)) this.selectedId = undefined;
    const selectedId = this.selectedId ?? evidence[0].id;

    const layout = root.createDiv({ cls: "mugs-recon-layout" });
    const sidebar = layout.createDiv({ cls: "mugs-recon-sidebar" });
    const tools = sidebar.createDiv({ cls: "mugs-recon-tools" });
    const count = tools.createEl("span", { cls: "mugs-file-count", text: `${evidence.length} folder${evidence.length === 1 ? "" : "s"}` });
    const search = tools.createEl("input", {
      type: "search",
      cls: "mugs-recon-search",
      attr: { placeholder: "Filter folders…", "aria-label": "Filter folders by name or status" },
    });
    search.value = this.query;
    const list = sidebar.createEl("nav", { cls: "mugs-recon-files", attr: { "aria-label": "Folders with rollout evidence" } });
    const detail = layout.createDiv({ cls: "mugs-recon-detail" });

    const staged = rollout?.mode === "staged";
    const renderList = (): void => {
      list.empty();
      const query = this.query.trim().toLocaleLowerCase();
      let visible = 0;
      for (const item of evidence) {
        const enabled = !!rollout?.enabledMappingIds.includes(item.id);
        const state = !staged ? "legacy"
          : enabled ? "automatic on"
            : item.blockers.length ? `${item.blockers.length} blocker${item.blockers.length === 1 ? "" : "s"}`
              : "not enabled";
        if (query && !`${item.label} ${item.id} ${statusLabel(item.status)} ${state}`.toLocaleLowerCase().includes(query)) continue;
        visible++;
        const selected = item.id === selectedId;
        const row = list.createEl("button", {
          type: "button",
          cls: "mugs-recon-file",
          attr: { title: item.label, "aria-label": item.label, ...(selected ? { "aria-current": "true" } : {}) },
        });
        const name = row.createSpan({ cls: "mugs-recon-file-name" });
        const dot = name.createSpan({ cls: "mugs-dot" });
        dot.addClass(statusDot(item.status));
        name.createSpan({ text: item.label });
        row.createSpan({ cls: "mugs-recon-file-location", text: `${statusLabel(item.status)} · ${state}` });
        row.addEventListener("click", () => {
          if (this.busy || selected) return;
          this.selectedId = item.id;
          this.render();
        });
      }
      count.textContent = query
        ? `${visible} of ${evidence.length} folders`
        : `${evidence.length} folder${evidence.length === 1 ? "" : "s"}`;
      if (!visible) list.createEl("p", { cls: "mugs-muted", text: "No matching folders." });
    };
    search.addEventListener("input", () => { if (!this.busy) { this.query = search.value; renderList(); } });
    renderList();

    const item = evidence.find(candidate => candidate.id === selectedId)!;
    const enabled = !!rollout?.enabledMappingIds.includes(item.id);

    // --- Detail pane: heading with live status, evidence, blockers, actions.
    const heading = detail.createDiv({ cls: "mugs-recon-heading" });
    heading.createEl("h4", { text: item.label, cls: "mugs-recon-title" });
    const statusLine = heading.createEl("p", { cls: "mugs-recon-status" });
    const dot = statusLine.createSpan({ cls: "mugs-dot" });
    dot.addClass(statusDot(item.status));
    statusLine.createSpan({ text: statusLabel(item.status) + (item.skipReason ? ` — ${item.skipReason}` : "") });
    heading.createEl("p", {
      cls: "mugs-recon-context",
      text: `Automatic: ${!staged ? "legacy scheduling (all folders when unpaused)" : enabled ? "enabled" : "not enabled"} · ${item.reviewCount} review · ${item.conflictCount} conflict · ${item.pendingCount} pending`,
    });
    heading.createEl("p", {
      cls: "mugs-recon-context",
      text: item.lastObservedAt ? `Last saved sync evidence: ${new Date(item.lastObservedAt).toLocaleString()}` : "No saved sync timestamp",
    });
    const evidenceDetails = heading.createEl("details", { cls: "mugs-recon-version" });
    evidenceDetails.createEl("summary", { text: "Saved evidence" });
    evidenceDetails.createEl("p", { text: `Connection: ${item.id}` });
    if (item.cloneDir) evidenceDetails.createEl("p", { text: `Recorded clone: ${item.cloneDir}` });
    const result = rollout?.lastResult[item.id];
    if (result) {
      evidenceDetails.createEl("p", {
        text: `Last rollout result: ${result.status} at ${new Date(result.at).toLocaleString()}${result.reason ? ` — ${result.reason}` : ""}`,
      });
    }

    if (item.blockers.length) {
      detail.createEl("p", { text: "Blockers that must be resolved before this folder can join automatic sync:", cls: "mugs-muted" });
      const blockers = detail.createEl("ul");
      for (const blocker of item.blockers) blockers.createEl("li", { text: blocker });
    } else {
      detail.createEl("p", { text: "No blockers in saved state. The canary pass provides the live remote, clone and merge evidence.", cls: "mugs-muted" });
    }

    const actions = detail.createDiv({ cls: "mugs-recon-primary" });
    if (enabled) {
      const disable = actions.createEl("button", { text: "Disable this mapping", type: "button" });
      disable.addEventListener("click", () => void this.act(() => this.plugin.disableStagedMapping(item.id)));
      actions.createEl("p", { text: "Disabling is always available and never requires a canary.", cls: "mugs-muted" });
    } else if (rollout && !item.blockers.length && arm) {
      const canary = actions.createEl("button", { text: "Run canary and enable automatic sync", type: "button", cls: "mod-cta" });
      arm(canary);
      canary.addEventListener("click", () => void this.act(async () => {
        const result = await this.plugin.runMappingCanary(item.id);
        if (!result.enabled) new Notice(`MUGS canary — ${item.label} stays disabled: ${result.reason ?? "unverified"}`, 10_000);
        else new Notice(`MUGS canary — ${item.label} passed and is now syncing automatically.`, 8000);
      }));
      actions.createEl("p", { text: "One guarded pass for this folder only; it becomes automatic only when verifiably clean and the result is saved.", cls: "mugs-muted" });
    }

    detail.createEl("p", {
      text: "Use Review for retained repository files; do not infer deletion from a missing vault path. Disabling is always available; nothing is enabled without an explicit clean canary.",
      cls: "mugs-muted",
    });
  }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await action(); }
    catch (error) { new Notice(`MUGS rollout: ${error instanceof Error ? error.message : String(error)}`, 8000); }
    finally { this.busy = false; this.render(); }
  }
}
