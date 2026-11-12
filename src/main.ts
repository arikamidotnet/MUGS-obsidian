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
import { rmSync } from "node:fs";
import { MugsStore, MemoryIO, type SaveResult } from "./store";
import { MugsSettingTab } from "./settingsTab";
import { MapView } from "./ui/mapView";
import { DiffView } from "./ui/diffView";
import { MugsConflictsPanel, MUGS_CONFLICTS_VIEW_TYPE } from "./ui/diffPanel";
import { ReviewQueueView } from "./ui/reviewQueueView";
import { setMugsContext } from "./ui/dataSources";
import {
  StoreMapDataSource,
  StoreDiffDataSource,
  StoreConflictDataSource,
  DEFAULT_CLONE_DIRNAME,
} from "./ui/defaultDataSources";
import type { MugsSettings, FolderMapping, Agent } from "./types";
import { buildProvider } from "./providers/factory";
import { ChildProcessRunner } from "./git/runner";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor, storeHeldAccessor, type SyncOutcome } from "./sync/driver";
import { resolveMappingForPath, normalizePath } from "./sync/exclusion";
import { decideRun, debounceFireTimes } from "./sync/schedule";
import type { VaultMirror, WorkingTreeWriter } from "./sync/cloneManager";
import { cloneDir } from "./sync/cloneManager";
import { repoToVaultPath } from "./sync/mirror";
import { normalizeVaultPath } from "./schema";
import { EditorOpenGuard } from "./sync/editorOpen";
import { FileSystemTrashStore } from "./sync/trash";
import { toAdapterPath } from "./sync/adapterPath";
import { createConflictResolver } from "./runtime/conflictResolver";
import type { PendingOperation, FileConflict } from "./types";
import type { ConflictDataSource, ConflictQuery, ConflictResolutionQuery, ConflictResolutionResult } from "./ui/dataSources";
import { MCP_SERVER_NAME } from "./mcp/server";

// Injected at build time by esbuild (define) from styles.css so the plugin's
// Map/Diff/settings UI is self-contained in main.js — no separate file to copy.
declare const __MUGS_CSS__: string;

// The shipped obsidian typings don't declare addStyleTag, but it's a real Plugin
// runtime method that injects a <style> tag into the document head. Augment the
// module so this.addStyleTag(...) typechecks against the base Plugin class.
declare module "obsidian" {
  interface Plugin {
    addStyleTag(css: string): void;
    /** Obsidian's MCP host hook (newer builds). Augmented here because the shipped typings
     * predate MCP support; guarded by `typeof` at the call site so older builds are fine. */
    registerMcpServer?(definition: { name: string; version: string; tools?: unknown[] }): EventRef;
  }
}

/** How often the gated poll ticks (decideRun enforces the real interval). */
const POLL_TICK_MS = 15_000;
/** File-change events coalesce into a single sync this long after the last one. */
const EVENT_DEBOUNCE_MS = 20_000;
/** Short coalesce window so bursts coalesce but a sync triggers within a short delay,
 *  not gated behind the full long debounce or the poll interval (per contract E05). */
const EVENT_COALESCE_MS = 1500;

/** Extensions the vault mirror skips — the sync layer moves text, not binaries. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svgz", "pdf", "zip", "gz", "7z", "tar",
  "rar", "mp3", "mp4", "mov", "avi", "mkv", "wav", "ogg", "flac", "ttf", "otf", "woff", "woff2",
  "docx", "xlsx", "pptx", "bin", "exe", "sqlite", "db", "onnx", "pt", "Drawing",
]);

/** Status-bar states the plugin cycles through. */
type BarState = "idle" | "syncing" | "synced" | "conflict" | "skipped" | "error" | "paused" | "hidden";

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
  /** Timestamps of pending file-change events, coalesced via debounceFireTimes before a sync. */
  private eventTimestamps: number[] = [];
  /** Tracks vault paths currently open with unsaved changes so sync writes never clobber an edit (Area 5). */
  private editorOpen = new EditorOpenGuard();
  /** True while a sync pass is running — the guard that keeps scheduler ticks, file
   *  events and manual Sync clicks from stacking parallel passes (and parallel
   *  clones) on top of each other. */
  private syncInFlight = false;
  /** Paths we (the plugin) just wrote via adapters. Used to suppress the resulting
   *  vault "modify"/"create" events so plugin-caused writes do not re-trigger sync
   *  (feedback loop guard, E05). Cleared on first observation. */
  private internalWritePaths = new Set<string>();
  /** Per-run AbortController. Unload aborts in-flight work. The signal is threaded
   *  into GitRunOpts when the driver surface accepts it (contract seam; currently
   *  prepared here, wired at integration when sync-core lands the cancellation param). */
  private currentRunController?: AbortController;
  /** Epoch ms of the newest successful sync — renders the "✓ synced HH:MM" state. */
  private lastSyncedAt?: number;
  /** Last terminal status-bar state (synced/conflict/skipped/error/paused/idle) —
   *  what the bar restores to when the window becomes visible again. */
  private lastTerminalBarState?: BarState;

  async onload(): Promise<void> {
    // In Obsidian, IO is backed by loadData/saveData; MemoryIO covers tests.
    this.store = new MugsStore({
      read: () => this.loadData(),
      write: (data) => this.saveData(data as unknown),
    });

    await this.store.load();
    if (this.store.loadError) {
      // Corrupt/unreadable data.json: the store refuses to save (it will not be
      // overwritten with fresh defaults). Sync is disabled until the file is fixed
      // or restored and the plugin reloaded — a sticky Notice says exactly that.
      new Notice(
        `MUGS: settings could not be read (${this.store.loadError}) — starting with defaults and NOT saving over data.json. ` +
        "Fix or restore the file, then reload the plugin. Sync is disabled until then.",
        0,
      );
    }
    // A passphrase-encrypted vault starts locked every session: until the user
    // unlocks (Settings → MUGS → Security), every credential resolves to the visible
    // "missing token" state and syncs would skip. Say so up front, once, sticky.
    if (this.store.isLocked() && this.store.getSettings().credentials.some((c) => c.token)) {
      new Notice(
        "MUGS: credentials are locked — open Settings → MUGS → Security and unlock with your passphrase to enable syncing.",
        0,
      );
    }
    // Seed the status bar from the persisted sync bookkeeping so a reload shows the
    // real last-synced time instead of a blank "idle".
    const lastSync = this.store.getSettings().lastSync;
    const newest = Math.max(0, ...Object.values(lastSync).map((s) => Math.max(s.lastPullAt ?? 0, s.lastPushAt ?? 0)));
    this.lastSyncedAt = newest > 0 ? newest : undefined;
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
    let vaultBase = "";
    try {
      const basePath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
      vaultBase = basePath;
      cloneRoot = `${basePath}/${DEFAULT_CLONE_DIRNAME}`;
    } catch (err) {
      console.warn("MUGS: could not resolve vault base path — using empty clone root.", err);
    }
    // S07 (contract §5): the manual-resolution TRANSACTION is owned by app-runtime.
    // The checkpoint StoreConflictDataSource is wrapped so every resolution routes
    // through the contract transaction (identity check → op lock → originals-first →
    // clone → vault → state clear → save). Seam to flag: diff-ui will consume the
    // resolver directly at integration; until then the panel keeps calling the
    // context's resolveConflict and sees failures as thrown errors (which it renders).
    const checkpointConflicts = new StoreConflictDataSource(this.store, cloneRoot, this.workingTreeWriter(), {
      // Manual resolutions must land in the VAULT too, or the next sync reads the
      // stale vault copy as "ours" and the conflict resurfaces every pass.
      vault: this.workingTreeWriter(),
      vaultRoot: vaultBase,
      // EditorOpenGuard keys on vault-root-relative paths; translate before checking.
      writeSafe: (abs) =>
        this.editorOpen.isWriteSafe(vaultBase !== "" && abs.startsWith(`${vaultBase}/`) ? abs.slice(vaultBase.length + 1) : abs),
    });
    const resolverFactory = this.conflictResolverFactory();
    const conflictsSource: ConflictDataSource = {
      getConflicts: (q: ConflictQuery) => checkpointConflicts.getConflicts(q),
      resolveConflict: async (q: ConflictResolutionQuery): Promise<ConflictResolutionResult> => {
        const stored = this.store.getConflicts(q.mappingId).find((c) => c.path === q.path);
        if (!stored) return { remaining: 0 };
        const outcome = await resolverFactory.forMapping(q.mappingId)(stored, q.choice);
        if (!outcome.ok) throw new Error(outcome.error); // panel renders per-path + Notice
        const remaining = this.store.getConflicts(q.mappingId).filter((c) => !c.resolved).length;
        return { remaining };
      },
    };
    setMugsContext({
      map: new StoreMapDataSource(this.store, cloneRoot),
      diff: new StoreDiffDataSource(this.store, cloneRoot),
      conflicts: conflictsSource,
    });
    this.registerView("mugs-map", (leaf) => new MapView(leaf));
    this.registerView("mugs-diff", (leaf) => new DiffView(leaf));
    this.registerView(MUGS_CONFLICTS_VIEW_TYPE, (leaf) => new MugsConflictsPanel(leaf));
    this.registerView("mugs-review", (leaf) => new ReviewQueueView(this, leaf));

    // --- Phase 8: status bar + automatic scheduler -------------------------
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    // Clicking the status routes to the surface that needs attention: the
    // Conflicts panel when something needs a manual merge, otherwise the Diff
    // view showing what the last sync did.
    this.statusEl.addEventListener("click", () => this.onStatusBarClick());
    this.updateStatusBar(this.lastSyncedAt ? "synced" : "idle");
    this.startScheduler();
    this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());
    // Vault file events live on the VAULT (registering "modify"/"create"/"delete" on
    // workspace — the old wiring — was silently dead, so the 20s debounced
    // event-driven sync never fired and passes ran poll-only).
    // E05: register rename events; pass kind for feedback guard.
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file.path, "modify")));
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file.path, "create")));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file.path, "delete")));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      // Treat rename as a modification of the new path (oldPath may be relevant too).
      this.onVaultChange(file.path, "rename");
    }));
    // Rebuild the editor-open set from REAL events so the write-back guard can
    // actually hold paths. The old wiring used a nonexistent "open-changed" event
    // plus equally fictional getOpenLeaves()/TFile.isDirty — the guard was
    // permanently empty and every sync write could clobber an open editor.
    this.registerEvent(this.app.workspace.on("layout-change", () => this.recomputeOpenEditors()));
    this.registerEvent(this.app.workspace.on("editor-change", () => this.recomputeOpenEditors()));
    this.recomputeOpenEditors(); // seed immediately
    // Register the MUGS agents MCP server when this Obsidian build hosts MCP (Area 10).
    this.registerMcpServerIfSupported();

    this.addSettingTab(new MugsSettingTab(this));

    this.addRibbonIcon("git-branch", "MUGS: Sync now", async () => { this.markManualSyncRun(); void this.runSync(); });
    this.addRibbonIcon("map", "Open MUGS Map", async () => void this.openView("mugs-map"));
    this.addRibbonIcon("git-commit", "Open MUGS Diff", async () => void this.openView("mugs-diff"));
    this.addRibbonIcon("pane-right", "Open MUGS Conflicts", () => this.openConflictsPanel());
    // NOTE: the Review Queue has no producer yet (nothing ever creates staging
    // entries), so its ribbon/command entry points are hidden until it is wired —
    // an always-empty queue advertised in the UI erodes trust.

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
      callback: () => { this.markManualSyncRun(); void this.runSync(); },
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
      callback: () => this.openConflictsPanel(),
    });

  }

  /** Run one sync pass over every mapping (push + pull), reporting each outcome as a Notice.
   *  Guarded: while a pass is in flight, further calls (scheduler ticks, file events,
   *  repeated Sync clicks) return immediately — passes can never stack.
   *
   *  Contract (E04): ONE operation owns discovery → execution → persistence → reporting.
   *  syncInFlight is released ONLY after store.save() resolves AND Notices are issued.
   *  SaveResult {ok:false} → error Notice + terminal error state; status bar must
   *  NEVER show "synced" after a refused/failed save.
   */
  async runSync(quiet = false): Promise<void> {
    if (this.store.loadError) {
      // Unreadable data.json: never sync (nothing would be persistable) — the
      // corrupt-file Notice from onload explains why.
      this.updateStatusBar("error");
      return;
    }
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.updateStatusBar("syncing", "syncing…");

    const runController = new AbortController();
    this.currentRunController = runController;

    const cloneRoot = this.cloneRoot();
    const settings = this.store.getSettings();
    // Mappings with no baseline yet — used to report first-sync completion.
    const firstTimers = new Set(settings.mappings.filter((m) => !settings.lastSync[m.id]).map((m) => m.id));

    let outcomes: SyncOutcome[] = [];
    let syncThrown: unknown = null;

    try {
      // Cancellation seam (contract §7): pass signal when SyncDriverDeps / SyncOpts
      // accepts it. For now we allocate the controller so unload can abort and so
      // we are ready for the driver change from sync-core. GitRunOpts already
      // declares signal; the threading lands in cloneManager/runner at integration.
      // (Flagged seam: no `signal` or `cancellation` field on current deps.)
      outcomes = await syncAllMappings({
        mappings: settings.mappings,
        credentials: settings.credentials,
        getToken: (id) => this.store.getToken(id),
        buildProvider,
        cloneRoot,
        runner: new ChildProcessRunner(),
        lastSync: storeWritableAccessor(this.store),
        workingTree: this.workingTreeWriter(),
        conflicts: storeConflictAccessor(this.store),
        // The Automatic Conflict Resolution settings finally reach the sync engine:
        // without this, auto-merge/tie-break/recency were display-only and every
        // genuine conflict (e.g. a first-sync add/add) surfaced for manual resolve.
        policy: settings.sync,
        obsidianConfig: settings.sync.obsidianConfig,
        editorOpen: this.editorOpen,
        trash: this.trashStore(),
        heldPaths: storeHeldAccessor(this.store).heldPaths,
        pickAgent: this.pickAgent,
        vaultMirror: this.vaultMirror(),
        rmDir: (dir) => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch (err) {
            console.warn("MUGS: could not clear partial clone dir", dir, err);
          }
        },
        firstSyncDirection: settings.sync.firstSyncDirection,
        onStatus: (message) => this.updateStatusBar("syncing", message),
        onRepoResolved: (mappingId, repoRef) => this.backfillRepoRef(mappingId, repoRef),
        // Optional future seam for cancellation (no-op adapter today):
        // signal: runController.signal,
      });
    } catch (err) {
      syncThrown = err;
    }

    // Persist under ownership. Contract: syncInFlight releases only after save resolves.
    // Consume SaveResult: {ok:false} is failure — do not let status become "synced".
    let saveResult: SaveResult = { ok: true };
    try {
      const r = await this.store.save();
      saveResult = r;
      if (!r.ok) {
        new Notice(`MUGS: could not persist sync state — ${r.reason}`, 8000);
      }
    } catch (err) {
      saveResult = { ok: false, reason: "load-error" };
      new Notice(`MUGS: could not persist sync state — ${err instanceof Error ? err.message : String(err)}`, 8000);
    }

    // Reporting + terminal state. All under the in-flight guard.
    if (syncThrown) {
      const msg = syncThrown instanceof Error ? syncThrown.message : String(syncThrown);
      new Notice(`MUGS sync failed:\n${msg}`, 8000);
      if (!quiet) console.error("MUGS: runSync threw", syncThrown);
      this.updateStatusBar("error");
    } else {
      // Report outcomes as Notices. Manual runs get per-mapping detail; quiet
      // (automatic) runs announce only an aggregate — a per-mapping Notice every
      // 5 minutes would stack forever, and a 0-duration Notice in Obsidian NEVER
      // auto-dismisses (each quiet skip used to pin a permanent notice on screen).
      // The status bar carries the state either way and is clickable.
      if (!quiet) {
        for (const o of outcomes.filter((o) => o.status === "conflict")) {
          const n = o.conflicts?.length ?? 0;
          new Notice(`MUGS — ${o.label} needs a manual merge (${n} file${n === 1 ? "" : "s"} diverged). Open the MUGS Conflicts panel to resolve.`, 8000);
        }
        for (const o of outcomes.filter((o) => o.status === "skipped")) {
          const reason = o.reason ? ` — ${o.reason}` : "";
          new Notice(`MUGS — ${o.label} skipped${reason}`, 8000);
        }
      } else {
        const skipped = outcomes.filter((o) => o.status === "skipped");
        if (skipped.length > 0) {
          const first = skipped[0];
          const reason = first.reason ? ` (e.g. ${first.label} — ${first.reason})` : "";
          new Notice(`MUGS: ${skipped.length} mapping${skipped.length === 1 ? "" : "s"} skipped last pass${reason}. Click the MUGS status bar, or run Sync now, for details.`, 10_000);
        }
      }
      for (const o of outcomes.filter((o) => o.status === "ok")) {
        if (!quiet) new Notice(`MUGS — ${o.label}: synced`, 3000);
        if (firstTimers.has(o.mappingId)) {
          const direction = settings.sync.firstSyncDirection === "push" ? "vault uploaded to remote" : "vault populated from remote";
          new Notice(`MUGS — ${o.label}: first sync complete — ${direction}.`, quiet ? 4000 : 7000);
        }
      }

      // Terminal status-bar state from the outcome aggregate.
      // IMPORTANT (E04): never claim "synced" if the save refused or failed.
      const conflicts = outcomes.filter((o) => o.status === "conflict").length;
      const skips = outcomes.filter((o) => o.status === "skipped").length;
      const oks = outcomes.filter((o) => o.status === "ok").length;
      if (conflicts > 0) this.updateStatusBar("conflict");
      else if (skips > 0) this.updateStatusBar("skipped");
      else if (oks > 0 && saveResult.ok) {
        this.lastSyncedAt = Date.now();
        this.updateStatusBar("synced");
      } else if (oks > 0 && !saveResult.ok) {
        this.updateStatusBar("error");
      } else {
        this.updateStatusBar("idle");
        if (!quiet) new Notice("MUGS: no mappings configured — add one in Settings to start syncing.", 5000);
      }
    }

    this.syncInFlight = false;
    this.currentRunController = undefined;
  }

  /** Writes merged file content into a clone's working tree via the vault adapter.
   *  CRITICAL: the adapter speaks VAULT-RELATIVE paths — handed an absolute path it
   *  strips the leading slash and joins it onto the vault base, silently writing to
   *  <vault>/home/arikami/… instead of the clone. That was the silent push-skip bug:
   *  the clone never received its files, `git add` failed on pathspecs matching
   *  nothing, and every first-sync push skipped while junk directories grew inside
   *  the vault. Clones live inside the vault under .mugs-clones/, so absolute clone
   *  paths convert cleanly to the relative form the adapter expects.
   *
   *  E05/S01: mark internal writes for feedback suppression; propagate real I/O
   *  errors on delete instead of swallowing as "absent". Editor guard is enforced
   *  by the driver for requiresEditorCheck actions (writes+ deletes).
   */
  private workingTreeWriter(): WorkingTreeWriter {
    const adapter = this.app.vault.adapter as unknown as {
      read(p: string): Promise<string>;
      write(p: string, data: string | ArrayBuffer): Promise<void>;
      remove(p: string): Promise<void>;
      mkdir(p: string): Promise<void>;
      getBasePath(): string;
    };
    let basePath = "";
    try {
      basePath = adapter.getBasePath();
    } catch {
      // no base path resolvable (tests) — paths pass through unchanged
    }
    const markInternal = (rel: string) => {
      // Clone writes don't typically emit vault events, but keep for symmetry.
      if (rel) this.internalWritePaths.add(rel);
    };
    return {
      writeFile: async (absPath, content) => {
        const rel = toAdapterPath(basePath, absPath);
        const parent = rel.slice(0, rel.lastIndexOf("/"));
        if (parent) {
          try {
            await adapter.mkdir(parent);
          } catch {
            // already exists
          }
        }
        markInternal(rel);
        await adapter.write(rel, content);
      },
      readFile: async (absPath) => {
        try {
          return await adapter.read(toAdapterPath(basePath, absPath));
        } catch {
          return undefined;
        }
      },
      deleteFile: async (absPath) => {
        const rel = toAdapterPath(basePath, absPath);
        try {
          await adapter.remove(rel);
        } catch (e) {
          const s = String(e).toLowerCase();
          if (s.includes("enoent") || s.includes("not found") || s.includes("missing")) {
            // legitimately absent — delete is a no-op
            return;
          }
          // Propagate real I/O errors (S01)
          throw e;
        }
      },
    };
  }

  /** Filesystem view of mapping vault folders backed by the Obsidian vault: listing
   *  uses vault.getFiles() (dot-folders like .obsidian/ and .mugs-clones/ are
   *  excluded automatically) minus known binary extensions — the mirror moves text.
   *
   *  S01: checks open editors for BOTH writes and deletes (deletion guard);
   *  internal writes are stamped for feedback suppression (E05);
   *  adapter I/O errors on delete are propagated instead of swallowed as absent.
   */
  private vaultMirror(): VaultMirror {
    const adapter = this.app.vault.adapter as unknown as {
      read(p: string): Promise<string>;
      write(p: string, data: string | ArrayBuffer): Promise<void>;
      remove(p: string): Promise<void>;
      mkdir(p: string): Promise<void>;
      stat(p: string): Promise<{ mtime: number; size: number } | null>;
    };
    const rootOf = (folder: string): string => (folder === "." ? "" : normalizeVaultPath(folder));
    const vaultPath = (folder: string, rel: string): string => {
      const root = rootOf(folder);
      return root ? `${root}/${rel}` : rel;
    };
    const markInternal = (p: string) => { if (p) this.internalWritePaths.add(p); };
    const isDeleteSafe = (p: string): boolean => {
      // S01: deletion guard — treat open editors as unsafe for delete too.
      // The EditorOpenGuard is the source of truth; isWriteSafe is conservative for both.
      try {
        return this.editorOpen ? this.editorOpen.isWriteSafe(p) : true;
      } catch {
        return true; // defensive: missing guard method must not block deletes
      }
    };
    return {
      list: async (folder) => {
        const root = rootOf(folder);
        const files = this.app.vault.getFiles();
        return files
          .filter((f) => !BINARY_EXTENSIONS.has(f.extension.toLowerCase()))
          .filter((f) => (root === "" ? true : f.path.startsWith(`${root}/`)))
          .map((f) => (root === "" ? f.path : f.path.slice(root.length + 1)));
      },
      read: async (folder, rel) => adapter.read(vaultPath(folder, rel)),
      write: async (folder, rel, content) => {
        const p = vaultPath(folder, rel);
        const parent = p.slice(0, p.lastIndexOf("/"));
        if (parent) {
          try {
            await adapter.mkdir(parent);
          } catch {
            // already exists
          }
        }
        markInternal(p);
        await adapter.write(p, content);
      },
      remove: async (folder, rel) => {
        const p = vaultPath(folder, rel);
        if (!isDeleteSafe(p)) {
          // Defer: do not delete an open editor's file. The sync layer will
          // observe the file still present and record as deferred/pendingOp.
          // We intentionally do not throw here (the driver decides outcome);
          // but we avoid the mutation.
          return;
        }
        markInternal(p);
        try {
          await adapter.remove(p);
        } catch (e) {
          const s = String(e).toLowerCase();
          if (s.includes("enoent") || s.includes("not found") || s.includes("missing")) {
            return; // absent is fine for delete
          }
          // Propagate real errors (S01)
          throw e;
        }
      },
      mtime: async (folder, rel) => {
        try {
          const st = await adapter.stat(vaultPath(folder, rel));
          return st?.mtime;
        } catch {
          return undefined; // unreadable/absent -> recency falls back to defaultResolution
        }
      },
      stat: async (folder, rel) => {
        try {
          const st = await adapter.stat(vaultPath(folder, rel));
          return st ? { mtime: st.mtime, size: st.size } : undefined;
        } catch {
          return undefined; // unreadable/absent -> the steady-state shortcut never skips
        }
      },
      // Must agree with list(): getFiles() skips dot-folders and list() drops
      // BINARY_EXTENSIONS — a path failing this predicate could never appear in
      // a vault listing, so the sync engine must never treat its remote twin as
      // a vault-side deletion (the binary-corruption guard).
      listable: (p) => {
        const segs = p.split("/");
        if (segs.some((s) => s.startsWith("."))) return false;
        const last = segs[segs.length - 1];
        const ext = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).toLowerCase() : "";
        return !BINARY_EXTENSIONS.has(ext);
      },
    };
  }

  /** Pin a legacy mapping (no repoRef) to its resolved repo so the shared per-repo
   *  clone dir — and the UI's clone-dir resolution — stick across sessions. */
  private backfillRepoRef(mappingId: string, repoRef: string): void {
    const m = this.store.getSettings().mappings.find((x) => x.id === mappingId);
    if (!m || m.repoRef) return;
    try {
      this.store.upsertMapping({ ...m, repoRef });
    } catch (err) {
      console.warn("MUGS: could not backfill repoRef for", mappingId, err);
    }
  }

  /** The on-disk clones directory, resolved defensively like getBasePath. */
  private cloneRoot(): string {
    try {
      const basePath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
      return `${basePath}/${DEFAULT_CLONE_DIRNAME}`;
    } catch {
      return `./${DEFAULT_CLONE_DIRNAME}`;
    }
  }

  /** Filesystem-backed recoverable-deletion log rooted at `<cloneRoot>/.mugs-trash`.
   *  Records each both-sides-deleted file's prior content before it is removed (Area 3). */
  private trashStore(): FileSystemTrashStore {
    return new FileSystemTrashStore(`${this.cloneRoot()}/.mugs-trash`);
  }

  /** Vault-side WorkingTreeWriter speaking ABSOLUTE paths (resolver transaction input).
   *  Distinct from workingTreeWriter() (clone-side): routes through the same adapter
   *  but marks writes as plugin-internal for the E05 feedback guard. */
  private vaultWriter(): WorkingTreeWriter {
    const adapter = this.app.vault.adapter as unknown as {
      read(p: string): Promise<string>;
      write(p: string, data: string | ArrayBuffer): Promise<void>;
      remove(p: string): Promise<void>;
      mkdir(p: string): Promise<void>;
      getBasePath(): string;
    };
    let basePath = "";
    try { basePath = adapter.getBasePath(); } catch { /* tests: pass-through */ }
    const rel = (abs: string): string => toAdapterPath(basePath, abs);
    return {
      writeFile: async (absPath, content) => {
        const p = rel(absPath);
        const parent = p.slice(0, p.lastIndexOf("/"));
        if (parent) { try { await adapter.mkdir(parent); } catch { /* exists */ } }
        this.internalWritePaths.add(p);
        await adapter.write(p, content);
      },
      readFile: async (absPath) => {
        try { return await adapter.read(rel(absPath)); } catch { return undefined; }
      },
      deleteFile: async (absPath) => {
        const p = rel(absPath);
        if (!this.editorOpen.isWriteSafe(p)) {
          throw new Error(`${p} is open with unsaved changes — close it and resolve again`);
        }
        try {
          this.internalWritePaths.add(p);
          await adapter.remove(p);
        } catch (e) {
          const s = String(e).toLowerCase();
          if (s.includes("enoent") || s.includes("not found") || s.includes("missing")) return;
          throw e;
        }
      },
    };
  }

  /** Durable retry record (contract §1): failed operations land in the mapping's
   *  lastSync.pendingOps so they surface in counts and block correspondence advance
   *  (the sync engine honors pendingOps once sync-core's planner lands — flagged seam). */
  private recordPendingOp(mappingId: string, op: PendingOperation): void {
    try {
      const cur = this.store.getSettings().lastSync[mappingId] ?? { mappingId };
      const ops = [...(cur.pendingOps ?? []).filter((o) => o.opId !== op.opId), op];
      this.store.setLastSync({ ...cur, mappingId, pendingOps: ops });
      void this.store.save().then((r) => {
        if (!r.ok) new Notice(`MUGS: could not persist the retry record for ${mappingId} — ${r.reason}`, 8000);
      });
    } catch (err) {
      console.warn("MUGS: could not record pending operation", mappingId, err);
    }
  }

  /** The S07 resolution transaction factory, bound to the real store/writers/trash.
   *  Single-flight and ordering live inside runtime/conflictResolver.ts. */
  private conflictResolverFactory() {
    return createConflictResolver({
      getConflicts: (id) => this.store.getConflicts(id),
      getMapping: (id) => this.store.getSettings().mappings.find((m) => m.id === id),
      cloneDirFor: (id) => {
        const m = this.store.getSettings().mappings.find((x) => x.id === id);
        return cloneDir({ root: this.cloneRoot() }, m?.providerId ?? "", m?.repoRef ?? id);
      },
      cloneTree: this.workingTreeWriter(),
      vaultTree: this.vaultWriter(),
      vaultAbsPath: (id, relPath) => {
        const m = this.store.getSettings().mappings.find((x) => x.id === id);
        if (!m) return undefined;
        const vrel = repoToVaultPath(m, relPath);
        if (vrel === null) return undefined;
        let base = "";
        try { base = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath(); } catch { /* tests */ }
        const folder = m.localFolder === "." ? "" : normalizeVaultPath(m.localFolder);
        return [base, folder, vrel].filter((s) => s.length > 0).join("/");
      },
      trash: this.trashStore(),
      save: () => this.store.save(),
      setConflicts: (id, list: FileConflict[]) => this.store.setConflicts(id, list),
      recordRetry: (mappingId, op) => this.recordPendingOp(mappingId, op),
    });
  }

  /** Resolve the agent sub-user acting on a mapping's push (Area 10) via its pinned agentId. */
  private pickAgent = (mapping: FolderMapping): Agent | undefined => {
    return mapping.agentId ? this.store.getAgents().find((a) => a.id === mapping.agentId) : undefined;
  }

  /** Open (or activate) a registered custom view — reusing an existing leaf of
   *  that type when one is open, otherwise splitting a new one. The old
   *  getLeaf(false) REPLACED whatever the user was editing on every click. */
  private async openView(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type);
    const leaf = existing.length > 0 ? existing[0] : this.app.workspace.getLeaf(true);
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

  /** Mark that a manual sync occurred (updates scheduling timestamp coherently). */
  private markManualSyncRun(): void {
    this.lastRunAt = Date.now();
  }

  /** One gated poll tick: run only when the pause gate allows it.
   *  Manual runSync callers should call markManualSyncRun() so scheduling
   *  timestamps are coherent (no double-interval waits after a manual click).
   */
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
      // Only persistent gate states change the bar; "interval"/"too-soon" are
      // transient and must not overwrite the last terminal state (the old bug
      // that kept the bar stuck on "idle").
      if (decision.reason === "paused-user") this.updateStatusBar("paused");
      else if (decision.reason === "hidden") this.updateStatusBar("hidden");
      return;
    }
    await this.runSync(true); // quiet: automatic runs don't spam Notices
    this.lastRunAt = Date.now();
  }

  /** A vault file changed under a mapped path — debounce it into one sync.
   *  E05: coalesces bursts but triggers within a SHORT delay (EVENT_COALESCE_MS),
   *  not gated behind the long EVENT_DEBOUNCE_MS or the full poll interval.
   *  Renames are registered ("rename" event). Manual syncs update lastRunAt.
   *  Plugin-caused writes (internalWritePaths) are suppressed (feedback guard).
   */
  private onVaultChange(path: string, kind: "modify" | "create" | "delete" | "rename" = "modify"): void {
    const settings = this.store.getSettings();
    if (settings.sync.paused || this.hidden) return; // pause gate
    if (!this.relevantMapping(path)) return;          // only files that belong to a mapping

    // Feedback guard: suppress our own adapter writes.
    if ((kind === "modify" || kind === "create") && this.internalWritePaths.has(path)) {
      this.internalWritePaths.delete(path);
      return;
    }

    // Buffer the event timestamp and coalesce a burst into one sync within a short window.
    this.eventTimestamps.push(Date.now());
    if (this.eventDebounceTimer) clearTimeout(this.eventDebounceTimer);
    this.eventDebounceTimer = window.setTimeout(() => {
      const fires = debounceFireTimes(this.eventTimestamps, Math.max(1, EVENT_COALESCE_MS));
      this.eventTimestamps = [];
      this.eventDebounceTimer = undefined;
      if (fires.length > 0) void this.tickSync();
    }, EVENT_COALESCE_MS);
  }

  /** Rebuild the editor-open set from every file currently open in a view.
   *  Conservative rule: ANY open file is treated as write-unsafe (mirrorPull skips
   *  it; the next pass catches up once closed) — real dirtiness detection does not
   *  exist on TFile, and over-blocking is the safe failure mode. */
  private recomputeOpenEditors(): void {
    const open = new Set<string>();
    try {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const view = (leaf as unknown as { view?: { file?: { path?: string } } }).view;
        if (view?.file?.path) open.add(view.file.path);
      });
    } catch {
      // Defensive: a missing workspace method must not abort event handling.
    }
    this.editorOpen = new EditorOpenGuard(open);
  }

  /** Register the MUGS agents MCP server when this Obsidian build hosts MCP (Area 10). */
  private registerMcpServerIfSupported(): void {
    const reg = (this as unknown as { registerMcpServer?: (def: { name: string; version: string; tools?: unknown[] }) => unknown }).registerMcpServer;
    if (typeof reg !== "function") return; // build predates MCP support — degrade gracefully
    try {
      // Register the server name/version only: the tool surface is advertised
      // once a dispatch transport exists (listAgentTools describes the intended
      // tools, but no handler routes calls yet — advertising them would be dead).
      reg.call(this, { name: MCP_SERVER_NAME, version: this.manifest.version });
    } catch (e) {
      console.warn("MUGS: could not register MCP server", e);
    }
  }

  /** The mapping a changed path belongs to — by remote scope or local folder. */
  private relevantMapping(path: string): FolderMapping | undefined {
    const settings = this.store.getSettings();
    const byRemote = resolveMappingForPath(settings.mappings, path);
    if (byRemote) return byRemote;
    const norm = normalizePath(path);
    return settings.mappings.find((m) => {
      const lf = normalizePath(m.localFolder);
      if (lf === ".") return true; // whole-vault mapping — every path is relevant
      return norm === lf || norm.startsWith(`${lf}/`);
    });
  }

  /** The app became visible/hidden — update the gate and status bar. Becoming
   *  visible again restores the last TERMINAL state (synced/conflict/skipped/error)
   *  instead of snapping to "synced" and masking pending conflicts. */
  private onVisibilityChange(): void {
    this.hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
    if (!this.hidden && this.eventDebounceTimer) {
      clearTimeout(this.eventDebounceTimer);
      this.eventDebounceTimer = undefined;
    }
    if (this.hidden) {
      this.updateStatusBar("hidden");
    } else {
      // Re-render the persistent state (a pass in flight keeps its phase text).
      this.updateStatusBar(this.syncInFlight ? "syncing" : this.lastTerminalBarState ?? (this.lastSyncedAt ? "synced" : "idle"));
    }
  }

  /** Clicking the status item routes to the surface that needs attention: the
   *  Conflicts panel when any mapping has unresolved conflicts, else the Diff view
   *  (per-mapping last-sync state and what changed). */
  private onStatusBarClick(): void {
    const s = this.store.getSettings();
    const hasConflicts = Object.values(s.conflicts).some((list) => list.some((c) => !c.resolved));
    if (hasConflicts) {
      this.openConflictsPanel();
      return;
    }
    void this.openView("mugs-diff");
  }

  /** Open the conflicts view in the right sidebar, reusing an open panel. The
   *  previous createPanelTab call targeted a workspace method that does not
   *  exist in Obsidian and always threw. */
  private openConflictsPanel(): void {
    const existing = this.app.workspace.getLeavesOfType(MUGS_CONFLICTS_VIEW_TYPE);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("MUGS: could not open the Conflicts panel.", 8000);
      return;
    }
    void leaf.setViewState({ type: MUGS_CONFLICTS_VIEW_TYPE, active: true });
  }

  /** Render the status-bar label for a plugin state, with optional live detail
   *  (sync phase text). A user pause always wins over everything else. */
  private updateStatusBar(state: BarState, detail?: string): void {
    if (!this.statusEl) return;
    if (state !== "syncing") this.lastTerminalBarState = state; // remembered for visibility restore
    const paused = this.store.getSettings().sync.paused && state !== "paused";
    let text: string;
    if (paused) text = "MUGS ⏸ paused";
    else
      switch (state) {
        case "syncing":
          text = `MUGS ⟳ ${detail ?? "syncing…"}`;
          break;
        case "synced":
          text = `MUGS ✓ synced ${this.lastSyncedAt ? formatClock(this.lastSyncedAt) : ""}`.trimEnd();
          break;
        case "conflict":
          text = "MUGS ⚠ needs merge";
          break;
        case "skipped":
          text = "MUGS ✗ sync issues";
          break;
        case "error":
          text = "MUGS ✗ failed";
          break;
        case "paused":
          text = "MUGS ⏸ paused";
          break;
        case "hidden":
          text = "MUGS 👁 hidden";
          break;
        default:
          text = "MUGS ● idle";
      }
    // Tooltip mirrors the click target so hover explains what clicking does.
    const tooltip =
      state === "conflict" ? "MUGS — conflicts need a manual merge. Click to open the Conflicts panel."
      : state === "skipped" ? "MUGS — some mappings were skipped last pass. Click for details."
      : state === "error" ? "MUGS — last sync failed. Click for details."
      : state === "syncing" ? `MUGS — syncing now: ${detail ?? "working…"}`
      : "MUGS sync status — click to view the Diff (last-sync) report.";
    this.statusEl.empty();
    this.statusEl.setText(text);
    this.statusEl.setAttribute("aria-label", tooltip);
  }

  onunload(): void {
    if (this.eventDebounceTimer) clearTimeout(this.eventDebounceTimer);
    if (this.pollTimer) {
      try { window.clearInterval(this.pollTimer); } catch {}
    }
    // Abort in-flight work on unload (E05). The driver seam for signal will pick this up at integration.
    if (this.currentRunController) {
      try { this.currentRunController.abort(); } catch {}
    }
    console.log("MUGS unloaded");
  }
}

/** Format an epoch-ms timestamp as a local HH:MM clock string. */
function formatClock(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

// Re-exported so settingsTab can `import type MugsPlugin from "./main"`.
export type { MugsSettings };
