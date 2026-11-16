/**
 * MUGS — realistic runtime scheduling + feedback guard tests (E05).
 *
 * Uses fake timers + minimal realistic adapter/editor stubs (NOT the sync harness).
 * Exercises:
 * - short-delay coalesce (EVENT_COALESCE_MS) instead of long debounce gating
 * - rename registration
 * - manual sync updates lastRunAt (no double-interval wait)
 * - plugin-caused writes do not re-trigger (internalWritePaths feedback guard)
 * - unload aborts controller and clears timers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We will import the module under test after shimming the globals it touches.
let MugsPlugin: any;

const hoisted = vi.hoisted(() => {
  const timers: any = { intervals: new Set<number>(), timeouts: new Set<number>() };
  return { timers };
});

vi.mock("obsidian", () => {
  class FakeNotice {
    constructor(public message: string, public timeout?: number) {}
  }
  class FakePlugin {
    app: any;
    manifest: any;
    constructor() {
      this.app = {
        vault: {
          adapter: {
            getBasePath: () => "/vault",
            read: async () => "",
            write: async () => {},
            remove: async () => {},
            mkdir: async () => {},
            stat: async () => ({ mtime: Date.now(), size: 10 }),
            list: async () => ({ files: [], folders: [] }),
          },
          on: (ev: string, cb: any) => ({ unsubscribe: () => {} }),
          getFiles: () => [],
        },
        workspace: {
          on: (ev: string, cb: any) => ({ unsubscribe: () => {} }),
          iterateAllLeaves: (_fn: any) => {},
          getLeavesOfType: () => [],
          getLeaf: () => ({ setViewState: async () => {} }),
          getRightLeaf: () => null,
        },
      };
      this.manifest = { id: "mugs", version: "test" };
    }
    addStatusBarItem() {
      return {
        addClass: () => {},
        addEventListener: () => {},
        empty: () => {},
        setText: () => {},
        setAttribute: () => {},
      };
    }
    registerInterval(id: number) { hoisted.timers.intervals.add(id); return id; }
    registerDomEvent(_target: any, _ev: string, _cb: any) {}
    registerEvent(_ref: any) {}
    addSettingTab() {}
    addRibbonIcon() {}
    addCommand() {}
    registerView() {}
    registerMcpServer?() {}
    loadData() { return {}; }
    saveData(_d: any) {}
  }
  class FakePluginSettingTab {}
  return {
    Plugin: FakePlugin,
    Notice: FakeNotice,
    // main.ts imports the reconciliation modal, which extends Modal. The modal is
    // never opened in these scheduling tests, but the mock must export it.
    Modal: class {
      contentEl: any = { empty() {} };
      constructor(_app?: any) {}
      onOpen(): void {}
      onClose(): void {}
      open(): void { this.onOpen(); }
      close(): void { this.onClose(); }
    },
    EventRef: class {},
    PluginSettingTab: FakePluginSettingTab,
    Setting: class { setName(){return this;} setDesc(){return this;} addToggle(){return this;} addDropdown(){return this;} addText(){return this;} addTextArea(){return this;} addButton(){return this;} addField(){return this;} },
    ItemView: class { constructor(_leaf?: any){} onload(){} onunload(){} getViewType(){return ""; } },
    MarkdownView: class {},
    TFile: class { path=""; basename=""; extension=""; },
    TFolder: class {},
    WorkspaceLeaf: class {},
    View: class {},
    TAbstractFile: class {},
  };
});

// Provide a minimal document shim for visibilitychange etc.
const doc: any = {
  visibilityState: "visible",
  addEventListener: (_t: string, _cb: any) => {},
  removeEventListener: () => {},
};
(globalThis as any).document = doc;

// Delegate to vitest fake timers so that code using window.setTimeout actually
// gets scheduled and fires on vi.advanceTimersByTime (needed for realistic E05 coalesce test).
function installVitestTimerDelegation() {
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.setTimeout = (fn: any, ms?: number) => setTimeout(fn as any, ms ?? 0);
  (globalThis as any).window.clearTimeout = (id: any) => clearTimeout(id as any);
  (globalThis as any).window.setInterval = (fn: any, ms?: number) => setInterval(fn as any, ms ?? 0);
  (globalThis as any).window.clearInterval = (id: any) => clearInterval(id as any);
}
installVitestTimerDelegation();

describe("MugsPlugin runtime (E05) — realistic stubs + fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.timers.intervals.clear();
    hoisted.timers.timeouts.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a coalesced edit syncs inside the poll interval but still honors pause and visibility", async () => {
    const PluginCls = await loadPlugin();
    const p = new PluginCls();
    const sync = { paused: false, intervalSeconds: 300 };
    p.store = { getSettings: () => ({ sync, mappings: [{ id: "m", label: "m", localFolder: "Notes", remotePath: "Notes", providerId: "c", direction: "push-pull" }], lastSync: {} }) };
    p.hidden = false;
    p.lastRunAt = Date.now();
    p.runSync = vi.fn(async () => {});

    await p.tickSync();
    expect(p.runSync).not.toHaveBeenCalled();
    await p.tickSync(true);
    expect(p.runSync).toHaveBeenCalledTimes(1);
    expect(p.runSync).toHaveBeenCalledWith(true);

    p.runSync.mockClear();
    sync.paused = true;
    await p.tickSync(true);
    expect(p.runSync).not.toHaveBeenCalled();
    sync.paused = false;
    p.hidden = true;
    await p.tickSync(true);
    expect(p.runSync).not.toHaveBeenCalled();
  });

  async function loadPlugin() {
    // Dynamic import after mocks
    const mod = await import("./main");
    // The default export is the class
    return mod.default as any;
  }

  it("short-delay coalesce fires within EVENT_COALESCE window (not gated on full debounce/poll)", async () => {
    const PluginCls = await loadPlugin();
    const p = new PluginCls();
    // Seed minimal state so onVaultChange proceeds
    (p as any).store = {
      getSettings: () => ({
        sync: { paused: false },
        mappings: [{ id: "m1", localFolder: ".", remotePath: "", providerId: "c1", direction: "push-pull" }],
        lastSync: {},
      }),
    };
    (p as any).hidden = false;
    (p as any).relevantMapping = () => true;
    (p as any).internalWritePaths = new Set<string>();
    (p as any).eventTimestamps = [];
    (p as any).tickSync = vi.fn(async () => {});

    // Fire a vault change
    (p as any).onVaultChange("Notes/a.md", "modify");

    // Advance just past the short coalesce (EVENT_COALESCE_MS = 1500)
    vi.advanceTimersByTime(1600);

    expect((p as any).tickSync).toHaveBeenCalledTimes(1);
    expect((p as any).tickSync).toHaveBeenCalledWith(true);
  });

  it("plugin internal writes are suppressed and do not trigger tickSync (feedback guard)", async () => {
    const PluginCls = await loadPlugin();
    const p = new PluginCls();
    (p as any).store = {
      getSettings: () => ({
        sync: { paused: false },
        mappings: [{ id: "m1", localFolder: ".", remotePath: "", providerId: "c1", direction: "push-pull" }],
        lastSync: {},
      }),
    };
    (p as any).hidden = false;
    (p as any).relevantMapping = () => true;
    (p as any).internalWritePaths = new Set<string>(["Notes/b.md"]);
    (p as any).eventTimestamps = [];
    (p as any).tickSync = vi.fn(async () => {});

    (p as any).onVaultChange("Notes/b.md", "modify");

    // No tick should be scheduled because we suppressed
    vi.advanceTimersByTime(2000);
    expect((p as any).tickSync).not.toHaveBeenCalled();
    // internal path should have been cleared
    expect((p as any).internalWritePaths.has("Notes/b.md")).toBe(false);
  });

  it("manual run stamps lastRunAt so scheduler does not double-wait full interval", async () => {
    const PluginCls = await loadPlugin();
    const p = new PluginCls();
    (p as any).store = {
      getSettings: () => ({
        sync: { paused: false, intervalSeconds: 300 },
        mappings: [],
        lastSync: {},
      }),
    };
    (p as any).lastRunAt = undefined;
    (p as any).markManualSyncRun();
    expect(typeof (p as any).lastRunAt).toBe("number");
    const before = (p as any).lastRunAt;
    // A second manual should update it forward
    (p as any).markManualSyncRun();
    expect((p as any).lastRunAt as number).toBeGreaterThanOrEqual(before as number);
  });

  it("unload aborts current controller and clears timers", async () => {
    const PluginCls = await loadPlugin();
    const p = new PluginCls();
    const ctrl = new AbortController();
    (p as any).currentRunController = ctrl;
    (p as any).eventDebounceTimer = 123 as any;
    (p as any).pollTimer = 456 as any;
    (p as any).onunload();
    expect(ctrl.signal.aborted).toBe(true);
  });

  function schedulerStore() {
    return { getSettings: () => ({
      sync: { paused: false, intervalSeconds: 300 },
      mappings: [{ id: "m", localFolder: ".", remotePath: "", providerId: "c", direction: "push-pull" }],
      lastSync: {},
    }) };
  }

  it("continuous events cannot starve a pass beyond the maximum wait", async () => {
    const p = new (await loadPlugin())();
    p.store = schedulerStore();
    p.tickSync = vi.fn(async () => { p.dirtySince = undefined; });
    for (let i = 0; i < 100; i++) {
      p.onVaultChange("a.md");
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(p.tickSync.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(p.eventTimestamps).toBeUndefined();
  });

  it("events during a pass produce exactly one follow-up; busy calls never stamp cadence", async () => {
    const p = new (await loadPlugin())();
    p.store = schedulerStore();
    let finish!: () => void;
    p.performSync = vi.fn(() => new Promise<boolean>(resolve => { finish = () => resolve(true); }));
    const first = p.runSync();
    const started = p.lastRunAt;
    await vi.advanceTimersByTimeAsync(1000);
    for (let i = 0; i < 20; i++) p.onVaultChange("a.md");
    await p.tickSync(true);
    expect(p.lastRunAt).toBe(started);
    expect(p.performSync).toHaveBeenCalledTimes(1);
    finish();
    await first;
    p.performSync.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.performSync).toHaveBeenCalledTimes(2);
  });

  it("editor changes update the same guard retained by an in-flight pass", async () => {
    const p = new (await loadPlugin())();
    const guard = p.editorOpen;
    p.app.workspace.iterateAllLeaves = (fn: any) => fn({ view: { file: { path: "a.md" } } });
    p.recomputeOpenEditors();
    expect(p.editorOpen).toBe(guard);
    expect(guard.isWriteSafe("a.md")).toBe(false);
    p.app.workspace.iterateAllLeaves = () => {};
    p.recomputeOpenEditors();
    expect(guard.isWriteSafe("a.md")).toBe(true);
  });

  it("sync refuses entry while conflict resolution owns the mutation boundary", async () => {
    const p = new (await loadPlugin())();
    p.store = schedulerStore();
    p.resolutionInFlight = true;
    p.performSync = vi.fn();
    await p.runSync();
    expect(p.performSync).not.toHaveBeenCalled();
    expect(p.lastRunAt).toBeUndefined();
  });

  it("visibility restoration and resume immediately request safe catch-up", async () => {
    const p = new (await loadPlugin())();
    p.store = schedulerStore();
    p.tickSync = vi.fn(async () => {});
    p.hidden = true;
    doc.visibilityState = "visible";
    p.onVisibilityChange();
    p.automaticSyncSettingsChanged();
    expect(p.tickSync).toHaveBeenCalledTimes(2);
    expect(p.tickSync).toHaveBeenCalledWith(true);
  });

  it("a rename OUT of a mapped folder still schedules a pass via the old path", async () => {
    const p = new (await loadPlugin())();
    p.store = { getSettings: () => ({
      sync: { paused: false, intervalSeconds: 300 },
      mappings: [{ id: "m1", localFolder: "Notes", remotePath: "Notes", providerId: "c1", direction: "push-pull" }],
      lastSync: {},
    }) };
    p.hidden = false;
    p.tickSync = vi.fn(async () => {});

    // New path outside every mapping, old path inside: the deletion at the old
    // location must trigger the event-driven pass, not wait for the next poll.
    p.onVaultRename("Outside/b.md", "Notes/a.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.tickSync).toHaveBeenCalledWith(true);

    // Neither path mapped: nothing is scheduled.
    p.tickSync.mockClear();
    p.dirtySince = undefined;
    p.onVaultRename("Outside/b.md", "Elsewhere/c.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.tickSync).not.toHaveBeenCalled();
  });
});
