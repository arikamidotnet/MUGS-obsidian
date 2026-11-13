import { describe, it, expect, beforeEach, vi } from "vitest";
import { DiffView } from "./diffView";
import { MapView } from "./mapView";
import { MugsConflictsPanel } from "./diffPanel";
import { ReviewQueueView } from "./reviewQueueView";
import { setMugsContext, __resetMugsContextForTests } from "./dataSources";
import type { FileConflict } from "../sync/conflict";

/**
 * The Map/Diff/Review views are thin Obsidian glue over already-tested models
 * (mapModel, diffModel). These guards drive each view's onOpen() against a DOM
 * shim + the injected data-source seam so we still catch regressions in the render
 * layer itself (missing contentEl methods, unhandled empty states) without spinning
 * up real git or network. They assert no-throw plus the expected empty/populated text.
 */

// --- Minimal DOM shim -------------------------------------------------------
const { document } = vi.hoisted(() => {
  class El {
    tagName: string;
    children: El[] = [];
    handlers: Record<string, ((e: any) => void)[]> = {};
    attrs: Record<string, string> = {};
    private _classes = new Set<string>();
    options: El[] = [];
    textContent = "";
    value = "";
    placeholder = "";
    rows = 0;
    type = "";
    checked = false;
    disabled = false;
    innerHTML = "";
    style: Record<string, string> = {};

    constructor(tag: string) {
      this.tagName = tag.toLowerCase();
    }

    get className() {
      return [...this._classes].join(" ");
    }
    set className(v: string) {
      this._classes = new Set(v.split(/\s+/).filter(Boolean));
    }

    addClass(cls: string) {
      if (cls) this._classes.add(cls);
    }
    removeClass(cls: string) {
      this._classes.delete(cls);
    }
    setAttribute(k: string, v: string | number) {
      this.attrs[k] = String(v);
    }
    setAttr(k: string, v: string | number) {
      this.attrs[k] = String(v);
    }

    createEl(tag: string, opts?: { text?: string; cls?: string; type?: string; attr?: Record<string, string | number> }) {
      const e = new El(tag);
      if (opts?.text != null) e.textContent = opts.text;
      if (opts?.cls) e.className = opts.cls;
      if (opts?.type) e.type = opts.type;
      for (const [k, v] of Object.entries(opts?.attr ?? {})) e.setAttribute(k, v);
      this.children.push(e);
      return e;
    }
    createDiv(opts?: { cls?: string }) {
      return this.createEl("div", opts);
    }
    createSpan(opts?: { text?: string; cls?: string; attr?: Record<string, string | number> }) {
      return this.createEl("span", opts);
    }
    createSvg(tag: string) {
      return new El(tag);
    }
    insertRow() { return this.createEl("tr"); }
    insertCell() { return this.createEl("td"); }
    appendChild(child: El) {
      this.children.push(child);
      if (child.tagName === "option" && Array.isArray(this.options)) this.options.push(child);
      return child;
    }
    remove() {}
    empty() {
      this.children = [];
    }
    addEventListener(type: string, cb: (e: any) => void) {
      (this.handlers[type] ??= []).push(cb);
    }
    get classList() {
      const set = this._classes;
      return {
        toggle: (c: string) => (set.has(c) ? set.delete(c) : set.add(c)),
        contains: (c: string) => set.has(c),
        add: (c: string) => set.add(c),
        remove: (c: string) => set.delete(c),
      };
    }
    // Class-selector query support (".foo") — what the views use for relabeling
    // the auto-refresh button and finding the row a failed resolve belongs to.
    querySelectorAll(selector: string): El[] {
      const cls = selector.startsWith(".") ? selector.slice(1) : null;
      const out: El[] = [];
      const walkEls = (el: El) => {
        for (const c of el.children) {
          if (cls && c._classes.has(cls)) out.push(c);
          walkEls(c);
        }
      };
      walkEls(this);
      return out;
    }
    querySelector(selector: string): El | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const document = {
    createElement: (tag: string) => new El(tag),
    createElementNS: (_ns: string, tag: string) => new El(tag),
  };
  return { document };
});
(globalThis as any).document = document;

const collectText = (el: any): string => {
  let out = el.textContent ?? "";
  for (const c of el.children ?? []) out += collectText(c);
  return out;
};

// --- Fakes ------------------------------------------------------------------
/** Data source with empty rows — drives each view's "nothing to show" path. */
const emptyContext = () =>
  setMugsContext({
    map: { getRows: async () => [] },
    diff: { getDiff: async () => ({ diffText: "", authorsByFile: {}, baseRef: undefined, outcome: "no-baseline" as const }) },
    conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
  });

/** Diff view with one mapping but no baseline yet — exercises renderPicker + showDiff. */
const diffNoBaselineContext = () =>
  setMugsContext({
  map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" }, status: "ok" }] },
    diff: { getDiff: async () => ({ diffText: "", authorsByFile: {}, baseRef: undefined, outcome: "no-baseline" as const }) },
    conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
  });

/** Diff view whose mapping is fully synced (baseline == HEAD, empty diff). */
const diffIdenticalContext = () =>
  setMugsContext({
    map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" }, status: "ok" }] },
    diff: { getDiff: async () => ({ diffText: "", authorsByFile: {}, baseRef: "abc123def4abc123def4abc123def4abc123def4", outcome: "identical" as const }) },
    conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
  });

// --- Shared DOM-walking helpers over the shim ------------------------------

type ShimEl = { tagName: string; children: ShimEl[]; attrs: Record<string, string>; value?: string; textContent: string; handlers: Record<string, ((e: any) => void)[]> };

const walk = (el: any, out: ShimEl[] = []): ShimEl[] => {
  out.push(el);
  for (const c of el.children ?? []) walk(c, out);
  return out;
};
const findAll = (root: any, pred: (el: ShimEl) => boolean): ShimEl[] =>
  walk(root).filter((el) => pred(el));
const findButtons = (root: any): ShimEl[] => findAll(root, (el) => el.tagName === "button");
const findInputs = (root: any): ShimEl[] => findAll(root, (el) => el.tagName === "input");
const findSelects = (root: any): ShimEl[] => findAll(root, (el) => el.tagName === "select");
const fire = (el: ShimEl, type: string, event: any = {}): void => {
  for (const cb of el.handlers[type] ?? []) cb(event);
};
const allTitles = (root: any): string[] => walk(root).flatMap((el) => Object.values(el.attrs ?? {}));

/** Flush the microtask/macrotask queue so fire-and-forget async renders settle. */
const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const FULL_SHA = "abc123def4abc123def4abc123def4abc123def4";
const IDENTICAL = () => ({ diffText: "", authorsByFile: {}, baseRef: FULL_SHA, outcome: "identical" as const });

/** One unresolved conflict shaped like a real editor-open-guard failure target. */
const sampleConflict = (over: Partial<FileConflict> = {}): FileConflict => ({
  path: "notes/a.md",
  ours: "OURS",
  theirs: "THEIRS",
  ...over,
});

function reviewPlugin(mappings: any[], staging: Record<string, any[]>) {
  const settings = {
    version: 1,
    credentials: [],
    mappings,
    lastSync: {},
    conflicts: {},
    staging,
    sync: { autoMerge: true, defaultResolution: "both", sameChangeAccept: true, recencyWins: true, paused: false, intervalSeconds: 300, obsidianConfig: { enabled: false, entries: [] } },
    agents: [],
    security: { encryptCredentials: false },
  };
  return {
    store: { getSettings: () => settings, setStaging: (id: string, arr: any[]) => { settings.staging[id] = arr; }, save: async () => {} },
    manifest: { version: "0.3.5" },
  } as any;
}

describe("MUGS views — onOpen() renders without throwing", () => {
  beforeEach(() => __resetMugsContextForTests());

  const diffRows = ["m1", "m2"].map((id) => ({
    mapping: { id, label: id, remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" as const },
    status: "ok" as const,
  }));
  const patch = ["a.md", "b.md"].map((name) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old-${name}\n+new-${name}\n`).join("");

  it("browses one file at a time without reloading git and keeps conflicts visible", async () => {
    const getDiff = vi.fn(async () => ({ diffText: patch, authorsByFile: { "a.md": [{ name: "Ada" }, { name: "Grace" }] }, outcome: "changed" as const, fromLabel: "HEAD~1", toLabel: "HEAD" }));
    setMugsContext({ map: { getRows: async () => diffRows }, diff: { getDiff },
      conflicts: { getConflicts: async () => [sampleConflict()], resolveConflict: async () => ({ remaining: 0 }) } });
    const v = new DiffView({} as any);
    await v.onOpen();
    const focused = () => v.contentEl.querySelector(".mugs-diff-focused")!;
    expect(collectText(focused())).toContain("new-a.md");
    expect(collectText(focused())).not.toContain("new-b.md");
    expect(collectText(focused())).toContain("Authors: Ada, Grace");
    expect(allTitles(focused()).join(" ")).toContain("not line-by-line attribution");
    expect(collectText(v.contentEl.querySelector(".mugs-diff-file-list"))).toContain("a.md+1-1");
    expect(collectText(focused())).toContain("+1");
    expect(collectText(focused())).toContain("-1");
    expect(v.contentEl.querySelector(".mugs-diff-row-added")).not.toBeNull();
    expect(v.contentEl.querySelector(".mugs-diff-row-removed")).not.toBeNull();
    expect(v.contentEl.querySelector(".mugs-diff-lineno-old")).not.toBeNull();
    expect(v.contentEl.querySelectorAll(".mugs-diff-gutter").length).toBe(4);
    expect(v.contentEl.querySelectorAll(".mugs-diff-sign-cell").length).toBe(2);
    expect(v.contentEl.querySelectorAll(".mugs-diff-code-scroll").length).toBe(1);
    expect(collectText(v.contentEl.querySelector(".mugs-diff-hunk-header"))).toContain("Line 1");
    expect(collectText(v.contentEl.querySelector(".mugs-diff-hunk-header"))).not.toContain("@@");
    const header = v.contentEl.querySelector(".mugs-diff-file-header") as any;
    fire(header, "click", { stopPropagation() {} });
    expect((v.contentEl.querySelector(".mugs-diff-file-body") as any).style.display).toBe("none");
    expect(header.attrs["aria-expanded"]).toBe("false");
    expect(header.attrs.tabindex).toBe("0");
    fire(header, "keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    expect(header.attrs["aria-expanded"]).toBe("true");
    expect((v.contentEl.querySelector(".mugs-diff-file-body") as any).style.display).toBe("");
    const hunkHeader = v.contentEl.querySelector(".mugs-diff-hunk-header") as any;
    fire(hunkHeader, "keydown", { key: " ", preventDefault() {}, stopPropagation() {} });
    expect(hunkHeader.attrs["aria-expanded"]).toBe("false");
    expect((v.contentEl.querySelector(".mugs-diff-hunk-body") as any).style.display).toBe("none");
    fire(v.contentEl.querySelectorAll(".mugs-diff-file-choice")[1] as any, "click");
    expect(collectText(focused())).toContain("new-b.md");
    expect(collectText(focused())).not.toContain("new-a.md");
    expect(collectText(focused())).not.toContain("Author unavailable");
    expect(v.contentEl.querySelector(".mugs-conflicts")).not.toBeNull();
    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(collectText(v.contentEl)).toContain("Unsynced edits aren't shown");
    expect(walk(v.contentEl).some((el) => el.textContent === "vs")).toBe(false);
  });

  it("Overview offers clear navigation, review and settings with a single-flight sync action", async () => {
    let finish!: () => void;
    const actions = {
      openView: vi.fn(), openReview: vi.fn(), openSettings: vi.fn(),
      syncNow: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })),
      getState: () => ({ paused: true, syncing: false, reviewCount: 2 }),
    };
    let loads = 0;
    setMugsContext({
      map: { getRows: async () => { loads++; return diffRows; } },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
      actions,
    });
    const v = new MapView({} as any);
    await v.onOpen();
    expect(v.getDisplayText()).toBe("MUGS Overview");
    expect(collectText(v.contentEl)).toContain("Automatic sync is paused");
    expect(findButtons(v.contentEl).find((b) => b.textContent === "Overview")?.attrs["aria-current"]).toBe("page");
    fire(findButtons(v.contentEl).find((b) => b.textContent === "Changes")!, "click");
    expect(actions.openView).toHaveBeenCalledWith("mugs-diff");
    fire(findButtons(v.contentEl).find((b) => b.textContent === "Review files (2)")!, "click");
    expect(actions.openReview).toHaveBeenCalledTimes(1);
    fire(findButtons(v.contentEl).find((b) => b.textContent === "Settings")!, "click");
    expect(actions.openSettings).toHaveBeenCalledTimes(1);
    const sync = findButtons(v.contentEl).find((b) => b.textContent === "Sync now")!;
    fire(sync, "click");
    fire(sync, "click");
    expect(actions.syncNow).toHaveBeenCalledTimes(1);
    expect((sync as any).disabled).toBe(true);
    finish();
    await flush();
    expect(loads).toBe(2);
    expect(findButtons(v.contentEl).some((b) => b.textContent === "Sync now")).toBe(true);
    await v.onClose();
  });

  it("Overview subscribes to sync events, refreshes on change and unsubscribes on close", async () => {
    let registered: (() => void) | undefined;
    const subscribe = vi.fn((listener: () => void) => {
      registered = listener;
      return () => { registered = undefined; };
    });
    let loads = 0;
    setMugsContext({
      map: { getRows: async () => { loads++; return diffRows; } },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
      actions: { openView: vi.fn(), openReview: vi.fn(), openSettings: vi.fn(), syncNow: vi.fn(),
        getState: () => ({ paused: false, syncing: false, reviewCount: 0 }), subscribe },
    });
    const v = new MapView({} as any);
    await v.onOpen();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(loads).toBe(1);
    registered!(); // a sync finished elsewhere — pushed event, no polling
    await flush();
    expect(loads).toBe(2);
    await v.onClose();
    expect(registered).toBeUndefined(); // unsubscribed
    expect(loads).toBe(2); // and no further refresh can be triggered
  });

  it("Overview discards stale loads and never redraws after close", async () => {
    let release!: (rows: any[]) => void;
    let calls = 0;
    setMugsContext({
      map: { getRows: () => ++calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve([]) },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
    });
    const v = new MapView({} as any);
    const opening = v.onOpen();
    await (v as any).refresh();
    release(diffRows);
    await opening;
    expect(collectText(v.contentEl)).toContain("No folders connected");
    expect(v.contentEl.querySelector(".mugs-sync-list")).toBeNull();
    calls = 0;
    const pending = (v as any).refresh();
    await v.onClose();
    release(diffRows);
    await pending;
    expect(collectText(v.contentEl)).toBe("");
  });

  it("Overview keeps navigation available when loading folder status fails", async () => {
    setMugsContext({
      map: { getRows: async () => { throw new Error("unavailable"); } },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
      actions: { openView: vi.fn(), openReview: vi.fn(), openSettings: vi.fn(), syncNow: vi.fn(),
        getState: () => ({ paused: false, syncing: true, reviewCount: 0 }) },
    });
    const v = new MapView({} as any);
    await v.onOpen();
    expect(v.contentEl.querySelector(".mugs-navigation")).not.toBeNull();
    expect(collectText(v.contentEl)).toContain("Couldn't load folder status");
    const sync = findButtons(v.contentEl).find((b) => b.textContent === "Syncing…")!;
    expect((sync as any).disabled).toBe(true);
  });

  it("discards earlier mapping responses and responses arriving after close", async () => {
    let release!: (value: any) => void;
    setMugsContext({ map: { getRows: async () => diffRows },
      diff: { getDiff: async (q) => q.mappingId === "m1" ? new Promise((resolve) => { release = resolve; }) : IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) } });
    const v = new DiffView({} as any);
    const opening = v.onOpen();
    await flush();
    const mapping = v.contentEl.querySelector(".mugs-diff-mapping-select") as any;
    mapping.value = "m2";
    fire(mapping, "change", { target: mapping });
    await flush();
    release({ diffText: "", authorsByFile: {}, outcome: "git-error", detail: "STALE" });
    await opening;
    expect(collectText(v.contentEl)).not.toContain("STALE");
    mapping.value = "m1";
    fire(mapping, "change", { target: mapping });
    await flush();
    await v.onClose();
    release(IDENTICAL());
    await flush();
    expect(collectText(v.contentEl)).toBe("");
  });

  it("invalid custom input invalidates an in-flight valid comparison", async () => {
    let release!: (value: any) => void;
    setMugsContext({ map: { getRows: async () => diffRows },
      diff: { getDiff: async (q) => q.mode === "custom" ? new Promise((resolve) => { release = resolve; }) : IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) } });
    const v = new DiffView({} as any);
    await v.onOpen();
    const mode = v.contentEl.querySelector(".mugs-diff-mode") as any;
    mode.value = "custom";
    fire(mode, "change");
    await flush();
    const input = findInputs(v.contentEl)[0];
    input.value = "main..dev";
    fire(input, "change");
    release(IDENTICAL());
    await flush();
    expect(collectText(v.contentEl)).toContain("one ref at a time");
    expect(collectText(v.contentEl)).not.toContain("No changes");
  });

  it("resolves the original mapping even when mapping changes during conflict reload", async () => {
    let release!: (value: FileConflict[]) => void;
    let count = 0;
    const resolveConflict = vi.fn(async () => ({ remaining: 0 }));
    setMugsContext({ map: { getRows: async () => diffRows }, diff: { getDiff: async () => IDENTICAL() },
      conflicts: {
        getConflicts: async (q) => q.mappingId === "m1" && ++count === 2
          ? new Promise((resolve) => { release = resolve; }) : [sampleConflict()],
        resolveConflict,
      } });
    const v = new DiffView({} as any);
    await v.onOpen();
    fire(findButtons(v.contentEl)[0], "click");
    await flush();
    const mapping = v.contentEl.querySelector(".mugs-diff-mapping-select") as any;
    mapping.value = "m2";
    fire(mapping, "change", { target: mapping });
    await flush();
    release([sampleConflict()]);
    await flush();
    expect(resolveConflict).toHaveBeenCalledWith({ mappingId: "m1", path: "notes/a.md", choice: "ours" });
    expect(mapping.value).toBe("m2");
  });

  it("does not render rows arriving after refresh or close", async () => {
    let release!: (value: any) => void;
    let first = true;
    setMugsContext({ map: { getRows: async () => first ? (first = false, new Promise((resolve) => { release = resolve; })) : [] },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) } });
    const v = new DiffView({} as any);
    const opening = v.onOpen();
    await (v as any).render();
    release(diffRows);
    await opening;
    expect(collectText(v.contentEl)).toContain("No folders connected");
    expect(v.contentEl.querySelector(".mugs-diff-mode")).toBeNull();
  });

  it("Diff view: empty mappings shows the setup hint", async () => {
    emptyContext();
    const v = new DiffView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    expect(collectText(v.contentEl)).toContain("No folders connected");
  });

  it("Diff view: single mapping with no baseline shows the sync-first hint", async () => {
    diffNoBaselineContext();
    const v = new DiffView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    // U04: distinct truthful state for no-baseline (not lumped into generic "no comparison").
    expect(collectText(v.contentEl)).toContain("No completed sync yet");
  });

  it("Diff view: identical trees show the no-changes message with a truncated baseline", async () => {
    diffIdenticalContext();
    const v = new DiffView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    const text = collectText(v.contentEl);
    // Truthful labels per contract: identical uses from/to labels, not legacy copy.
    expect(text).toContain("No changes");
    expect(text).toContain("abc123de");
    expect(text).toContain("the latest commit");
    expect(text).not.toContain("abc123def4abc123def4");
  });

  it("Diff view: a git error surfaces the error instead of claiming a clean tree", async () => {
    setMugsContext({
      map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" }, status: "ok" }] },
      diff: { getDiff: async () => ({ diffText: "", authorsByFile: {}, baseRef: "abc123", outcome: "git-error" as const, detail: "fatal: bad object" }) },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
    });
    const v = new DiffView({} as any);
    await v.onOpen();
    const text = collectText(v.contentEl);
    // Distinct error surface (never silent no-changes) with classified kind.
    expect(text).toContain("Comparison failed");
    expect(text).toContain("fatal: bad object");
  });

  it("Diff view: a whitespace-only ref shows an inline message and never reaches git", async () => {
    const calls: any[] = [];
    setMugsContext({
      map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" }, status: "ok" }] },
      diff: { getDiff: async (q: any) => { calls.push(q); return IDENTICAL(); } },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
    });
    const v = new DiffView({} as any);
    await v.onOpen();
    expect(calls).toEqual([{ mappingId: "m1", mode: "since-sync", olderRef: "HEAD~1" }]);
    const mode = v.contentEl.querySelector(".mugs-diff-mode") as any;
    mode.value = "custom";
    fire(mode, "change");
    await flush();

    const input = findInputs(v.contentEl)[0];
    input.value = "   ";
    fire(input, "change");
    await flush();

    expect(collectText(v.contentEl)).toContain("Enter a branch, tag, or commit");
    expect(calls).toHaveLength(2); // the invalid ref was NOT sent to getDiff
  });

  it("Diff view: an obviously malformed ref (range) is rejected inline, not as a git error", async () => {
    const calls: any[] = [];
    setMugsContext({
      map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" }, status: "ok" }] },
      diff: { getDiff: async (q: any) => { calls.push(q); return IDENTICAL(); } },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
    });
    const v = new DiffView({} as any);
    await v.onOpen();

    const mode = v.contentEl.querySelector(".mugs-diff-mode") as any;
    mode.value = "custom";
    fire(mode, "change");
    await flush();
    const input = findInputs(v.contentEl)[0];
    input.value = "main..dev";
    fire(input, "change");
    await flush();

    expect(collectText(v.contentEl)).toContain("one ref at a time");
    expect(calls).toHaveLength(2);
  });

  it("Diff view: a resolution re-render preserves the selected mapping and ref", async () => {
    const diffCalls: any[] = [];
    const resolves: any[] = [];
    const row = (id: string, label: string) => ({
      mapping: { id, label, remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" as const },
      status: "ok" as const,
    });
    setMugsContext({
      map: { getRows: async () => [row("m1", "Alpha"), row("m2", "Beta")] },
      diff: { getDiff: async (q: any) => { diffCalls.push(q); return IDENTICAL(); } },
      conflicts: {
        getConflicts: async (q: any) => (q.mappingId === "m2" ? [sampleConflict()] : []),
        resolveConflict: async (q: any) => { resolves.push(q); return { remaining: 0 }; },
      },
    });
    const v = new DiffView({} as any);
    await v.onOpen();

    // Pick the second mapping…
    const select = findSelects(v.contentEl).find((s) => s.value !== undefined)!;
    select.value = "m2";
    fire(select, "change", { target: select });
    await flush();

    // …and apply a non-default ref on it.
    const mode = v.contentEl.querySelector(".mugs-diff-mode") as any;
    mode.value = "custom";
    fire(mode, "change");
    await flush();
    const input = findInputs(v.contentEl)[0];
    input.value = "v2.1";
    fire(input, "change");
    await flush();
    expect(diffCalls.at(-1)).toEqual({ mappingId: "m2", mode: "custom", olderRef: "v2.1" });

    // Resolve the one conflict the view surfaced for m2 → triggers a re-render.
    fire(findButtons(v.contentEl)[0], "click");
    await flush();
    expect(resolves).toEqual([{ mappingId: "m2", path: "notes/a.md", choice: "ours" }]);

    // The picker still shows mapping m2 and its ref — the old code snapped back
    // to the first mapping + HEAD.
    const selectAfter = findSelects(v.contentEl).find((s) => s.children.length > 1)!;
    const inputAfter = findInputs(v.contentEl)[0];
    expect(selectAfter.value).toBe("m2");
    expect(inputAfter.value).toBe("v2.1");
    expect(diffCalls.at(-1)).toEqual({ mappingId: "m2", mode: "custom", olderRef: "v2.1" });
  });

  it("Map view: empty mappings shows the setup hint (and renders the legend)", async () => {
    emptyContext();
    const v = new MapView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    const text = collectText(v.contentEl);
    expect(text).toContain("No folders connected");
    expect(text).toContain("Your sync"); // legend rendered before the empty-state branch
  });

  it("Map view: renders honest per-mapping statuses — no downloads, needs review, skipped with hover reasons", async () => {
    const base = { remotePath: "", localFolder: "notes", providerId: "c1" };
    setMugsContext({
      map: {
        getRows: async () => [
          { mapping: { ...base, id: "m1", label: "Docs", direction: "push-only" }, status: "ok", lastPushAt: Date.now() - 1000 },
          { mapping: { ...base, id: "m2", label: "Journal", direction: "push-pull" }, status: "conflict", conflictCount: 2 },
          { mapping: { ...base, id: "m3", label: "Recipes", direction: "pull-only" }, status: "pending", skipReason: "no credential selected" },
        ],
      },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
    });
    const v = new MapView({} as any);
    await v.onOpen();
    const text = collectText(v.contentEl);

    // Status-bar vocabulary on the cards.
    expect(text).toContain("no downloads"); // push-only chip
    expect(text).toContain("needs review"); // conflict card — not the raw word "conflict"
    expect(text).toContain("skipped"); // skip reason beats the quiet "pending"
    expect(text).toContain("1/3 in sync"); // skipped/conflicted rows never count as synced
    expect(text).toContain("not downloaded yet"); // pull-only with no pull time — direction-honest footer

    // Hover reasons carry the details.
    const titles = allTitles(v.contentEl).join("\n");
    expect(titles).toContain("no credential selected");
    expect(titles).toContain("2 files need your review");
    expect(titles).toContain("never downloaded"); // push-only direction hint
  });

  it("Review queue view: empty staging shows the auto-sync hint", async () => {
    const v = new ReviewQueueView(reviewPlugin([], {}), {} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    expect(collectText(v.contentEl)).toContain("No curated changes");
  });

  it("Review queue view: populated staging lists each change with its actions", async () => {
    const v = new ReviewQueueView(
      reviewPlugin([{ id: "m1", label: "Notes" }], { m1: [{ mappingId: "m1", path: "Notes/diary.md", state: "unstaged" }] }),
      {} as any,
    );
    await expect(v.onOpen()).resolves.toBeUndefined();
    const text = collectText(v.contentEl);
    expect(text).toContain("Review Queue");
    expect(text).toContain("Notes"); // mapping group label
    expect(text).toContain("Notes/diary.md"); // change path
    expect(text).toContain("Pending"); // STATE_LABEL for unstaged
    expect(text).toContain("Stage");
    expect(text).toContain("Hold");
    expect(text).toContain("Clear");
  });
});

// --- Conflicts sidebar panel -------------------------------------------------

describe("MugsConflictsPanel — resolution errors render inline + groups refresh", () => {
  beforeEach(() => {
    __resetMugsContextForTests();
    // The panel drives its auto-refresh through window.setInterval — absent in node.
    (globalThis as any).window = { setInterval: vi.fn(() => 1), clearInterval: vi.fn() };
  });

  /** A panel with containerEl patched in (the obsidian stub only provides contentEl). */
  const makePanel = (): MugsConflictsPanel => {
    const p = new MugsConflictsPanel({} as any);
    (p as any).containerEl = document.createElement("div");
    return p;
  };

  it("renders a failed resolution inline on the affected row (editor-open guard) and refreshes groups", async () => {
    const guardMessage = "notes/a.md is open with unsaved changes — close it and resolve again";
    let rowsCalls = 0;
    setMugsContext({
      map: { getRows: async () => { rowsCalls++; return [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: "notes", providerId: "c1", direction: "push-pull" }, status: "conflict" }]; } },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: {
        getConflicts: async () => [sampleConflict()],
        resolveConflict: async () => { throw new Error(guardMessage); },
      },
    });

    const p = makePanel();
    await p.onOpen();
    const container = (p as any).containerEl;
    expect(collectText(container)).toContain("notes/a.md");
    expect(rowsCalls).toBe(1); // initial load

    // Keep this device → the guard throws. (Header buttons come first, so target by label.)
    fire(findButtons(container).find((b) => b.textContent === "Keep this device")!, "click");
    await flush();

    const text = collectText(container);
    // Inline on the row, in addition to the (stubbed) Notice.
    expect(text).toContain("Could not resolve notes/a.md");
    expect(text).toContain("open with unsaved changes");
    // The row is still there and groups were refreshed after the failure.
    expect(text).toContain("Keep this device");
    expect(rowsCalls).toBeGreaterThanOrEqual(2);
  });

  it("a successful resolution removes the row and refreshes the counts", async () => {
    let conflicts: FileConflict[] = [sampleConflict()];
    setMugsContext({
      map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: "notes", providerId: "c1", direction: "push-pull" }, status: "conflict" }] },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: {
        getConflicts: async () => conflicts,
        resolveConflict: async () => { conflicts = []; return { remaining: 0 }; },
      },
    });

    const p = makePanel();
    await p.onOpen();
    const container = (p as any).containerEl;
    expect(collectText(container)).toContain("1 file needs"); // singular verb in the summary

    fire(findButtons(container).find((b) => b.textContent === "Keep this device")!, "click");
    await flush();

    const text = collectText(container);
    expect(text).not.toContain("Keep this device"); // row gone
    expect(text).toContain("All conflicts resolved");
  });

  it("auto-refresh never stacks intervals: rapid double-toggle starts exactly one, error states stop it", async () => {
    const starts: number[] = [];
    const clears: number[] = [];
    (globalThis as any).window = {
      setInterval: vi.fn(() => { starts.push(starts.length + 1); return starts.length; }),
      clearInterval: vi.fn((id: number) => clears.push(id)),
    };

    // Load fails — the error state must stop auto-refresh.
    setMugsContext({
      map: { getRows: async () => { throw new Error("store exploded"); } },
      diff: { getDiff: async () => IDENTICAL() },
      conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
    });

    const p = makePanel();
    await p.onOpen();
    const container = (p as any).containerEl;
    expect(collectText(container)).toContain("Could not load conflicts");

    // Auto button is the first refresh-class button; turn auto-refresh ON.
    const autoBtn = findButtons(container)[0];
    fire(autoBtn, "click");
    expect(starts).toHaveLength(1); // one interval live
    expect(autoBtn.textContent).toContain("Auto-refresh on");

    // Manual Refresh while auto is on → render hits the error state → timer stops.
    fire(findButtons(container).find((b) => b.textContent === "Refresh")!, "click");
    await flush();
    expect(starts).toHaveLength(1); // no second interval started
    expect(clears).toHaveLength(1); // the error state cleared the running one
    expect(findButtons(container)[0].textContent).toContain("Auto-refresh off"); // relabeled
    expect(collectText(container)).toContain("Could not load conflicts");

    // Rapid double-toggle: on → off in quick succession. startAutoRefresh always
    // stops before starting, so exactly one new interval appears and it is
    // cleared — never two live at once.
    fire(findButtons(container)[0], "click"); // on
    fire(findButtons(container)[0], "click"); // off
    await flush();
    expect(starts).toHaveLength(2); // error-state start + double-toggle start
    expect(clears).toHaveLength(2); // error-state clear + double-toggle clear
    // Leaf close stops whatever remains (nothing live — idempotent no-op).
    await p.onClose();
    expect(clears).toHaveLength(2);
  });
});
