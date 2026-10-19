import { describe, it, expect, vi } from "vitest";
import { MugsSettingTab } from "./settingsTab";

/**
 * The Obsidian 1.14.x blank-UI bug (v0.3.5) left every settings section as an
 * empty <div> because cards were built with document.createElement instead of the
 * Obsidian createDiv helper. This is a regression guard: it drives MugsSettingTab
 * .display() against a tiny DOM shim + the obsidian stub and asserts (a) nothing
 * throws and (b) every section header actually renders into the container — so a
 * future refactor that drops a section or rebuilds cards with raw createElement is
 * caught immediately.
 */

// --- Minimal DOM shim -------------------------------------------------------
const { document } = vi.hoisted(() => {
  class El {
    tagName: string;
    children: El[] = [];
    handlers: Record<string, ((e: any) => void)[]> = {};
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

    // Mirror Obsidian: createDiv/createEl auto-attach the new node to `this`.
    createDiv(opts?: { cls?: string }) {
      const e = this.createEl("div");
      if (opts?.cls) e.className = opts.cls;
      return e;
    }
    createEl(tag: string, opts?: { text?: string; cls?: string; type?: string }) {
      const e = new El(tag);
      if (opts?.text != null) e.textContent = opts.text;
      if (opts?.cls) e.className = opts.cls;
      if (opts?.type) e.type = opts.type;
      this.children.push(e);
      return e;
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

  const document = { createElement: (tag: string) => new El(tag) };
  return { document };
});
(globalThis as any).document = document;

// --- Fakes ------------------------------------------------------------------
function collectText(el: any): string {
  let out = el.textContent ?? "";
  for (const c of el.children ?? []) out += collectText(c);
  return out;
}

/** A store seeded with one local credential + one whole-vault mapping. Local is
 *  deliberate: a REST provider would make addMappingForm hit real HTTP. */
function makePlugin() {
  const settings = {
    version: 1,
    credentials: [{ id: "c1", label: "Work", kind: "local", token: "secrettoken123" }],
    mappings: [
      { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" as const },
    ],
    lastSync: {},
    conflicts: {},
    staging: {},
    sync: {
      autoMerge: true,
      defaultResolution: "both",
      sameChangeAccept: true,
      recencyWins: true,
      paused: false,
      intervalSeconds: 300,
      obsidianConfig: { enabled: false, entries: [] },
    },
    agents: [],
    security: { encryptCredentials: false },
  };
  const store = {
    getSettings: () => settings,
    getDisplaySettings: () => settings,
    getToken: (id: string) => "tok-" + id,
    save: async () => {},
    removeCredential: (id: string) => {
      settings.credentials = settings.credentials.filter((c) => c.id !== id);
    },
    upsertCredential: (c: any) => {
      const i = settings.credentials.findIndex((x) => x.id === c.id);
      if (i >= 0) settings.credentials[i] = c;
      else settings.credentials.push(c);
    },
    removeMapping: (id: string) => {
      settings.mappings = settings.mappings.filter((m) => m.id !== id);
    },
    upsertMapping: (m: any) => {
      const i = settings.mappings.findIndex((x) => x.id === m.id);
      if (i >= 0) settings.mappings[i] = m;
      else settings.mappings.push(m);
    },
    setSecurity: (s: any) => {
      settings.security = { ...settings.security, ...s };
    },
    setSync: (s: any) => {
      settings.sync = { ...settings.sync, ...s };
    },
    setObsidianConfigEnabled: (v: boolean) => {
      settings.sync.obsidianConfig.enabled = v;
    },
    setObsidianConfig: (o: any) => {
      settings.sync.obsidianConfig = o;
    },
  };
  return {
    store,
    app: { vault: { adapter: { list: async () => ({ folders: [] }) } } },
    manifest: { version: "0.3.5" },
  } as any;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MugsSettingTab — display() renders every section (blank-UI regression guard)", () => {
  const sections = [
    "Getting Started",
    "Credentials & Providers",
    "Folder Mappings",
    "Security & Credentials",
    "Automatic Conflict Resolution",
    "Sync Frequency & Maintenance",
    "Obsidian Config Sync",
    "About",
  ];

  it("renders without throwing and populates every section header", async () => {
    const tab = new MugsSettingTab(makePlugin());
    expect(() => tab.display()).not.toThrow();
    await flush();

    const text = collectText(tab.containerEl);
    for (const h of sections) expect(text, `missing section: ${h}`).toContain(h);
  });

  it("renders the credential + whole-vault mapping rows", async () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    await flush();
    const text = collectText(tab.containerEl);
    expect(text).toContain("Work (local)"); // masked credential row
    expect(text).toContain("Notes"); // mapping label
    expect(text).toContain("Push + pull"); // directionText for push-pull
    expect(text).toContain(".trash/"); // whole-vault trash toggle appears
  });

  it("renders grouped .obsidian/ entries when config sync is enabled", async () => {
    const plugin = makePlugin();
    plugin.store.setObsidianConfigEnabled(true);
    plugin.store.setObsidianConfig({
      enabled: true,
      entries: [
        { path: "settings.json", scope: "personal" },
        { path: "global.css", scope: "vault-wide" },
      ],
    });
    const tab = new MugsSettingTab(plugin);
    expect(() => tab.display()).not.toThrow();
    await flush();

    const text = collectText(tab.containerEl);
    expect(text).toContain("settings.json");
    expect(text).toContain("global.css");
  });
});

/**
 * Reproduce + guard the Obsidian 1.13+ blank-settings bug. The framework calls
 * getSettingDefinitions(); when it returns a non-empty array the tab is rendered
 * declaratively and display() is skipped. MUGS stores settings in plugin.store, so
 * without an override the base getSettingDefinitions() yields a scaffold → display()
 * never runs → blank pane ("no UI except hint"). The fix overrides it to return [].
 */
function obsidianOpenTab(tab: MugsSettingTab): { path: string; text: string } {
  const defs = tab.getSettingDefinitions();
  if (defs.length > 0) {
    // Obsidian renders declaratively and does NOT call display().
    return { path: "declarative", text: collectText(tab.containerEl) };
  }
  tab.display();
  return { path: "display", text: collectText(tab.containerEl) };
}

describe("MugsSettingTab — Obsidian 1.13+ declarative API (blank-settings guard)", () => {
  const sections = [
    "Getting Started",
    "Credentials & Providers",
    "Folder Mappings",
    "Security & Credentials",
    "Automatic Conflict Resolution",
    "Sync Frequency & Maintenance",
    "Obsidian Config Sync",
    "About",
  ];

  it("returns empty definitions so Obsidian falls back to display()", () => {
    const tab = new MugsSettingTab(makePlugin());
    expect(tab.getSettingDefinitions()).toEqual([]);
  });

  it("renders the full pane via display() even with no plugin.settings (1.13 base behavior)", async () => {
    // makePlugin has no .settings — the real base getSettingDefinitions() would yield a
    // non-empty scaffold and skip display(); our override forces [] so display() runs.
    const tab = new MugsSettingTab(makePlugin());
    const { path, text } = obsidianOpenTab(tab);
    await flush();
    expect(path, "display() must be the render path").toBe("display");
    for (const h of sections) expect(text, `missing section: ${h}`).toContain(h);
  });

  it("would have been blank under the pre-fix base behavior", () => {
    // Sanity check on the harness: a tab whose getSettingDefinitions() returns a
    // non-empty array is treated as declarative and display() is skipped (blank).
    const tab = new MugsSettingTab(makePlugin());
    (tab as any).getSettingDefinitions = () => [{ name: "x" }];
    const { path, text } = obsidianOpenTab(tab);
    expect(path).toBe("declarative");
    expect(text).not.toContain("Getting Started");
  });
});
