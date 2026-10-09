/**
 * MUGS — Multi-User Git Sync
 * Plugin entry point. Wires the store to Obsidian's loadData/saveData, registers
 * the settings tab, ribbon entries and palette commands (Phase 0/1), plus the
 * Map/Diff/Review views and their data sources (Phase 4/8). Phase 8 adds an
 * automatic scheduler: a gated poll interval that pauses while hidden / paused and
 * debounces file-change events into syncs. The scheduling *policy* is pure
 * (`sync/schedule.ts`); everything here is thin Obsidian glue.
 */
import { Plugin, Notice, type EventRef } from "obsidian";
import { MugsStore, MemoryIO } from "./store";
import { MugsSettingTab } from "./settingsTab";
import { MapView } from "./ui/mapView";
import { DiffView } from "./ui/diffView";
import { MugsConflictsPanel } from "./ui/diffPanel";
import { ReviewQueueView } from "./ui/reviewQueueView";
import { setMugsContext } from "./ui/dataSources";
import {
  StoreMapDataSource,
  StoreDiffDataSource,
  StoreConflictDataSource,
  DEFAULT_CLONE_DIRNAME,
} from "./ui/defaultDataSources";
import type { MugsSettings, FolderMapping } from "./types";
import { buildProvider } from "./providers/factory";
import { ChildProcessRunner } from "./git/runner";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./sync/driver";
import { decideRun, type RunDecision } from "./sync/schedule";
import { resolveMappingForPath, normalizePath } from "./sync/exclusion";
import type { WorkingTreeWriter } from "./sync/cloneManager";

// Injected at build time by esbuild (define) from styles.css so the plugin's
// Map/Diff/settings UI is self-contained in main.js — no separate file to copy.
declare const __MUGS_CSS__: string;

// The shipped obsidian typings don't declare addStyleTag, but it's a real Plugin
// runtime method that injects a <style> tag into the document head. Augment the
// module so this.addStyleTag(...) typechecks against the base Plugin class.
declare module "obsidian" {
  interface Plugin {
    addStyleTag(css: string): void;
  }
}

/** How often the gated poll ticks (decideRun enforces the real interval). */
const POLL_TICK_MS = 15_000;
/** File-change events coalesce into a single sync this long after the last one. */
const EVENT_DEBOUNCE_MS = 20_000;

export default class MugsPlugin extends Plugin {
  store: MugsStore = new MugsStore();

  /** Status-bar element (created in onload). */
  private statusEl?: HTMLElement;
  /** True while the app/window is hidden — suppresses automatic syncs. */
  private hidden = false;
  /** Wall-clock time of the last automatic/manual run, for interval gating. */
  private lastRunAt?: number;
  /** Interval handle for the gated poll (auto-cleared by registerInterval). */
  private pollTimer?: number;
  /** Pending debounced-sync timer handle. */
  private eventDebounceTimer?: number;

  async onload(): Promise<void> {
    // In Obsidian, IO is backed by loadData/saveData; MemoryIO covers tests.
    this.store = new MugsStore({
      read: () => this.loadData(),
      write: (data) => this.saveData(data as unknown),
    });

    await this.store.load();
    console.log("MUGS — Multi-User Git Sync loaded");

    // Inject the plugin stylesheet (Map/Diff/settings UI). Prefer
    // Plugin.addStyleTag when present; otherwise create a <style> tag manually so
    // initialization can't fail if addStyleTag is absent on this build.
    const __css = __MUGS_CSS__;
    const withStyleTag = this as unknown as { addStyleTag?: (css: string) => void };
    if (typeof withStyleTag.addStyleTag === "function") {
      withStyleTag.addStyleTag(__css);
    } else if (typeof document !== "undefined") {
      const __styleEl = document.createElement("style");
      __styleEl.type = "text/css";
      __styleEl.textContent = __css;
      (document.head || document.documentElement).appendChild(__styleEl);
    }

    // --- Phase 4: view data sources + registered views ---------------------
    // Clones live under <vault>/.mugs-clones; the data sources resolve each
    // mapping's clone dir from its providerId/id (see sync/cloneManager).
    // getBasePath lives on the desktop adapter; cast so this typechecks against
    // the abstract DataAdapter shape declared in obsidian.d.ts. Resolve it
    // defensively — a missing adapter method must not abort plugin load.
    let cloneRoot = "";
    try {
      const basePath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
      cloneRoot = `${basePath}/${DEFAULT_CLONE_DIRNAME}`;
    } catch (err) {
      console.warn("MUGS: could not resolve vault base path — using empty clone root.", err);
    }
    setMugsContext({
      map: new StoreMapDataSource(this.store, cloneRoot),
      diff: new StoreDiffDataSource(this.store, cloneRoot),
      conflicts: new StoreConflictDataSource(this.store, cloneRoot, this.workingTreeWriter()),
    });
    this.registerView("mugs-map", (leaf) => new MapView(leaf));
    this.registerView("mugs-diff", (leaf) => new DiffView(leaf));
    this.registerView("mugs-review", (leaf) => new ReviewQueueView(this, leaf));

    // --- Phase 8: status bar + automatic scheduler -------------------------
    this.statusEl = this.addStatusBarItem();
    this.updateStatusBar("idle");
    this.startScheduler();
    this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());
    // Workspace emits create/modify/delete with a path arg; the shipped typings only
    // type a few event names, so route through a loose signature.
    const ws = this.app.workspace as unknown as { on(name: string, callback: (path: string) => void): EventRef };
    this.registerEvent(ws.on("modify", (p) => this.onVaultChange(p)));
    this.registerEvent(ws.on("create", (p) => this.onVaultChange(p)));
    this.registerEvent(ws.on("delete", (p) => this.onVaultChange(p)));

    this.addSettingTab(new MugsSettingTab(this));

    this.addRibbonIcon("git-branch", "MUGS: Sync now", async () => void this.runSync());
    this.addRibbonIcon("map", "Open MUGS Map", async () => void this.openView("mugs-map"));
    this.addRibbonIcon("git-commit", "Open MUGS Diff", async () => void this.openView("mugs-diff"));
    this.addRibbonIcon("pane-right", "Open MUGS Conflicts", () => void this.app.workspace.createPanelTab(this, MugsConflictsPanel));
    this.addRibbonIcon("clipboard-list", "Open MUGS Review Queue", async () => void this.openView("mugs-review"));

    this.addCommand({
      id: "show-settings",
      name: "Open MUGS settings",
      callback: () => {
        // Obsidian exposes the settings registry internally (not in the shipped
        // typings). Guard it so "Open MUGS settings" never throws on any build.
        const app = this.app as unknown as { setting?: { openToTab: (id: string) => void } };
        try {
          if (app.setting?.openToTab) {
            app.setting.openToTab(this.manifest.id);
            return;
          }
        } catch {
          // fall through to the Notice below
        }
        new Notice("MUGS: open settings via the gear icon next to MUGS in Community plugins.");
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Run sync (push + pull) for all mappings",
      callback: () => void this.runSync(),
    });

    this.addCommand({
      id: "show-map",
      name: "Show MUGS Map (folder→repo graph)",
      callback: () => void this.openView("mugs-map"),
    });

    this.addCommand({
      id: "show-diff",
      name: "Show MUGS Diff (per-author changes)",
      callback: () => void this.openView("mugs-diff"),
    });

    this.addCommand({
      id: "show-conflicts",
      name: "Show MUGS Conflicts (right sidebar, with action labels)",
      callback: () => void this.app.workspace.createPanelTab(this, MugsConflictsPanel),
    });

    this.addCommand({
      id: "show-review",
      name: "Show MUGS Review Queue (curated changes)",
      callback: () => void this.openView("mugs-review"),
    });
  }

  /** Run one sync pass over every mapping (push + pull), reporting each outcome as a Notice. */
  async runSync(quiet = false): Promise<void> {
    const basePath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
    const cloneRoot = `${basePath}/${DEFAULT_CLONE_DIRNAME}`;
    const settings = this.store.getSettings();

    const outcomes = await syncAllMappings({
      mappings: settings.mappings,
      credentials: settings.credentials,
      getToken: (id) => this.store.getToken(id),
      buildProvider,
      cloneRoot,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(this.store),
      workingTree: this.workingTreeWriter(),
      conflicts: storeConflictAccessor(this.store),
      // Opt-in `.obsidian/` config sync scope (Area 9): when enabled, personal vs
      // vault-wide classification gates which .obsidian/ files are pulled/pushed.
      obsidianConfig: settings.sync.obsidianConfig,
    });
    await this.store.save();

    if (quiet) return;

    for (const o of outcomes.filter((o) => o.status === "conflict")) {
      const n = o.conflicts?.length ?? 0;
      new Notice(`MUGS — ${o.label} needs a manual merge (${n} file${n === 1 ? "" : "s"} diverged). Open the Diff view to resolve.`);
    }
    for (const o of outcomes.filter((o) => o.status === "ok")) {
      const dir = o.push ? "push + pull" : "pull";
      new Notice(`MUGS ✓ ${o.label}: ${dir}`);
    }
    for (const o of outcomes.filter((o) => o.status === "skipped")) {
      new Notice(`MUGS ⏭ ${o.label}: ${o.reason ?? "skipped"}`);
    }
  }

  /** Writes merged file content into a clone's working tree via the vault adapter. */
  private workingTreeWriter(): WorkingTreeWriter {
    const adapter = this.app.vault.adapter as unknown as { writeFile(p: string, data: string | ArrayBuffer): Promise<void> };
    return { writeFile: (absPath, content) => adapter.writeFile(absPath, content) };
  }

  /** Open (or activate) a registered custom view in its own leaf. */
  private async openView(type: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type, active: true });
  }

  // --- Phase 8: scheduler + pause gate ------------------------------------

  /** Start the gated poll (decideRun enforces interval/pause/hidden) and run once. */
  private startScheduler(): void {
    // registerInterval takes a setInterval id so Obsidian cancels it on unload.
    this.pollTimer = this.registerInterval(window.setInterval(() => void this.tickSync(), POLL_TICK_MS));
    // An initial pass shortly after load picks up remote changes on startup.
    void this.tickSync();
  }

  /** One gated poll tick: run only when the pause gate allows it. */
  private async tickSync(): Promise<void> {
    const settings = this.store.getSettings();
    const decision = decideRun({
      now: Date.now(),
      intervalMs: Math.max(1_000, settings.sync.intervalSeconds * 1000),
      lastRunAt: this.lastRunAt,
      pausedByUser: settings.sync.paused,
      hidden: this.hidden,
    });
    if (!decision.allow) {
      this.updateStatusBar(decision.reason);
      return;
    }
    await this.runSync(true); // quiet: automatic runs don't spam Notices
    this.lastRunAt = Date.now();
    this.updateStatusBar("ok");
  }

  /** A vault file changed under a mapped path — debounce it into one sync. */
  private onVaultChange(path: string): void {
    const settings = this.store.getSettings();
    if (settings.sync.paused || this.hidden) return; // pause gate
    if (!this.relevantMapping(path)) return;          // only files that belong to a mapping

    if (this.eventDebounceTimer) clearTimeout(this.eventDebounceTimer);
    this.eventDebounceTimer = window.setTimeout(() => {
      this.eventDebounceTimer = undefined;
      void this.tickSync();
    }, EVENT_DEBOUNCE_MS);
  }

  /** The mapping a changed path belongs to — by remote scope or local folder. */
  private relevantMapping(path: string): FolderMapping | undefined {
    const settings = this.store.getSettings();
    const byRemote = resolveMappingForPath(settings.mappings, path);
    if (byRemote) return byRemote;
    const norm = normalizePath(path);
    return settings.mappings.find((m) => {
      const lf = normalizePath(m.localFolder);
      return norm === lf || norm.startsWith(`${lf}/`);
    });
  }

  /** The app became visible/hidden — update the gate and status bar. */
  private onVisibilityChange(): void {
    this.hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
    if (!this.hidden && this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
      this.eventDebounceTimer = undefined;
    }
    this.updateStatusBar(this.hidden ? "hidden" : "ok");
  }

  /** Render the status-bar label for a scheduler state. */
  private updateStatusBar(state: RunDecision["reason"] | "ok" | "idle" = "idle"): void {
    if (!this.statusEl) return;
    const paused = this.store.getSettings().sync.paused;
    let text = "MUGS ● idle";
    if (paused) text = "MUGS ⏸ paused";
    else if (state === "hidden") text = "MUGS 👁 hidden";
    else if (state === "ok") text = "MUGS ✓ synced";
    else if (state === "paused-user") text = "MUGS ⏸ paused";
    this.statusEl.empty();
    this.statusEl.setText(text);
  }

  onunload(): void {
    if (this.eventDebounceTimer) clearTimeout(this.eventDebounceTimer);
    console.log("MUGS unloaded");
  }
}

// Re-exported so settingsTab can `import type MugsPlugin from "./main"`.
export type { MugsSettings };
