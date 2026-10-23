import { describe, it, expect, vi } from "vitest";
import { MugsSettingTab } from "./settingsTab";
vi.mock("./providers/factory", () => ({
  buildProvider: vi.fn(() => ({
    listRepos: async () => [{ id: "r1", pathWithNamespace: "team/repo" }],
    listDirectories: async (_repoKey: string, _path: string) => ["Notes"],
  })),
}));
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
  const attrRe = new RegExp('^\\[(\\w+)="([^"]*)"\\]$');
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
    querySelectorAll(selector: string): El[] {
      const matches = (el: El) => {
        if (selector.startsWith(".")) return el._classes.has(selector.slice(1));
        const attrMatch = selector.match(attrRe);
        if (attrMatch) {
          const [, name, value] = attrMatch;
          if (name === "type") return el.type === value;
          if (name === "class") return el._classes.has(value);
          return false;
        }
        return false;
      };
      const out: El[] = [];
      const walk = (el: unknown) => {
        for (const c of (el as El).children ?? []) {
          if (matches(c as El)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector: string): El | null {
      const [first] = this.querySelectorAll(selector);
      return first ?? null;
    }
    click(): void { this.handlers.click?.forEach((cb) => cb({ type: "click" })); if (this.tagName === "input" && this.type === "checkbox") this.handlers.change?.forEach((cb) => cb({ type: "change" })); }
  }
    // Real Obsidian 1.14.x: document.createElement returns a raw element WITHOUT
    // the createEl/createDiv/classList helpers that container.createDiv() provides.
    // Reproduce that so a section rebuilt with raw createElement throws when body()
    // calls card.createEl(...) — exactly what blanked the UI in v0.3.5/v0.3.7.
    class RawEl {
      tagName: string;
      children: El[] = [];
      handlers: Record<string, ((e: unknown) => void)[]> = {};
      _classes = new Set<string>();
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
      constructor(tag: string) { this.tagName = tag.toLowerCase(); }
      set className(v: string) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
      get classList() {
        const set = this._classes;
        return { toggle: (c: string) => (set.has(c) ? set.delete(c) : set.add(c)), contains: (c: string) => set.has(c), add: (c: string) => set.add(c), remove: (c: string) => set.delete(c) };
      }
      remove() {}
      empty() { this.children = []; }
      appendChild(child: El) { this.children.push(child); if (child.tagName === "option" && Array.isArray(this.options)) this.options.push(child); return child; }
      addEventListener(type: string, cb: (e: unknown) => void) { (this.handlers[type] ??= []).push(cb); }
    }
    const document = { createElement: (tag: string) => new RawEl(tag) };
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
    manifest: { version: "0.3.8" },
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
describe("deferred persistence", () => {
  it("does not persist a setting change until Apply is clicked", async () => {
    const plugin = makePlugin();
    let saveCalls = 0;
    plugin.store.save = vi.fn(async () => { saveCalls += 1; });

    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    // Toggle autoMerge off. Deferred persistence: the in-memory setter runs, but
    // markUnsaved() must NOT persist to disk yet — only show the banner.
    const toggle = tab.containerEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle).toBeTruthy();
    toggle.click();

    expect(saveCalls).toBe(0);
    expect(tab.containerEl.querySelector(".mugs-unsaved-banner")).toBeTruthy();

    // Click Apply → now it persists and the banner disappears.
    tab.containerEl.querySelector<HTMLButtonElement>(".mugs-unsaved-apply")!.click();
    await flush();

    expect(saveCalls).toBe(1);
    expect(tab.containerEl.querySelector(".mugs-unsaved-banner")).toBeFalsy();
  });

  it("hides the banner after Apply and clears unsaved state", async () => {
    const plugin = makePlugin();
    plugin.store.save = vi.fn(async () => {});

    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    // No changes yet → no banner.
    expect(tab.containerEl.querySelector(".mugs-unsaved-banner")).toBeFalsy();

    // Make a change then apply it.
    tab.containerEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    expect(tab.containerEl.querySelector(".mugs-unsaved-banner")).toBeTruthy();

    tab.containerEl.querySelector<HTMLButtonElement>(".mugs-unsaved-apply")!.click();
    await flush();
    expect(tab.containerEl.querySelector(".mugs-unsaved-banner")).toBeFalsy();
  });
});

describe("add-mapping assistant", () => {
  it("disables matched folders whose localFolder is already mapped, with a Mapped badge", async () => {
    const plugin = makePlugin();
    // REST provider so refreshMatches runs the name-match path.
    const baseGet = plugin.store.getSettings;
    plugin.store.getSettings = () => ({
      ...baseGet(),
      credentials: [{ id: "c1", label: "Test", kind: "gitlab", token: "t" }],
      mappings: [{ id: "m1", label: "Existing", remotePath: "", localFolder: "Notes", direction: "push-pull" as const }],
    });

    // Match a top-level remote dir named "Notes" against the vault folder "Notes".
    vi.spyOn(plugin.store, "getToken").mockReturnValue("t");

    const tab = new MugsSettingTab(plugin);
    // Vault must expose a top-level "Notes" folder so the remote dir matches it.
    plugin.app.vault.adapter.list = async () => ({ folders: ["Notes"] });

    tab.display();
    await flush();

    // The matched row for "Notes" must be disabled with a Mapped badge.
    const takenRow = tab.containerEl.querySelector(".mugs-match-taken");
    expect(takenRow).toBeTruthy();
    expect(collectText(takenRow!)).toContain("Mapped");
  });

  it("renders the add-mapping form above existing mapping cards", async () => {
    const plugin = makePlugin();
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    // The Folder Mappings section contains the add form first, then mapping cards.
    const section = Array.from(tab.containerEl.querySelectorAll(".mugs-section"))
      .find((s) => collectText(s).includes("Folder Mappings")) as HTMLElement;
    expect(section).toBeTruthy();
    const all = Array.from(section.querySelectorAll("*"));
    const addFormIdx = all.findIndex((c) => c.classList.contains("mugs-matches"));
    const mappingCardIdx = all.findIndex((c) => c.classList.contains("mugs-mapping"));

    expect(addFormIdx).toBeGreaterThanOrEqual(0);
    expect(mappingCardIdx).toBeGreaterThanOrEqual(0);
    expect(addFormIdx).toBeLessThan(mappingCardIdx);
  });
});
