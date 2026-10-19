import { describe, it, expect, beforeEach, vi } from "vitest";
import { DiffView } from "./diffView";
import { MapView } from "./mapView";
import { ReviewQueueView } from "./reviewQueueView";
import { setMugsContext, __resetMugsContextForTests } from "./dataSources";

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
    diff: { getDiff: async () => ({ diffText: "", authorsByFile: {} }) },
    conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
  });

/** Diff view with one mapping but no baseline yet — exercises renderPicker + showDiff. */
const diffNoBaselineContext = () =>
  setMugsContext({
  map: { getRows: async () => [{ mapping: { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" }, status: "ok" }] },
    diff: { getDiff: async () => ({ diffText: "", authorsByFile: {} }) },
    conflicts: { getConflicts: async () => [], resolveConflict: async () => ({ remaining: 0 }) },
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

  it("Diff view: empty mappings shows the setup hint", async () => {
    emptyContext();
    const v = new DiffView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    expect(collectText(v.contentEl)).toContain("No folder mappings yet");
  });

  it("Diff view: single mapping with no baseline shows the sync-first hint", async () => {
    diffNoBaselineContext();
    const v = new DiffView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    expect(collectText(v.contentEl)).toContain("No comparison available");
  });

  it("Map view: empty mappings shows the setup hint (and renders the legend)", async () => {
    emptyContext();
    const v = new MapView({} as any);
    await expect(v.onOpen()).resolves.toBeUndefined();
    const text = collectText(v.contentEl);
    expect(text).toContain("No folder mappings yet");
    expect(text).toContain("Status:"); // legend rendered before the empty-state branch
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
