import { describe, it, expect, vi } from "vitest";
import { MugsSettingTab } from "./settingsTab";
// Keep the real provider metadata (PROVIDER_OPTIONS / defaultBaseUrl / validate
// wiring) and stub only the network-facing factory, so the settings tab renders
// its dropdown + endpoint autofill exactly as it does in Obsidian.
vi.mock("./providers/factory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/factory")>();
  return {
    ...actual,
    buildProvider: vi.fn(() => ({
      listRepos: async () => [{ id: "r1", pathWithNamespace: "team/repo" }],
      listDirectories: async (_repoKey: string, _path: string) => ["Notes"],
    })),
  };
});
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
    attrs: Record<string, string> = {};
    setAttribute(key: string, value: string): void { this.attrs[key] = value; }

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
        toggle: (c: string) => { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; },
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
      attrs: Record<string, string> = {};
      setAttribute(key: string, value: string): void { this.attrs[key] = value; }
      constructor(tag: string) { this.tagName = tag.toLowerCase(); }
      set className(v: string) { this._classes = new Set(v.split(/\s+/).filter(Boolean)); }
      get classList() {
        const set = this._classes;
        return { toggle: (c: string) => { if (set.has(c)) { set.delete(c); return false; } set.add(c); return true; }, contains: (c: string) => set.has(c), add: (c: string) => set.add(c), remove: (c: string) => set.delete(c) };
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
    credentials: [{ id: "c1", label: "Work", kind: "local", baseUrl: "file:///tmp/mugs-settings-test.git", token: "secrettoken123" }],
    mappings: [
      { id: "m1", label: "Notes", remotePath: "", localFolder: ".", providerId: "c1", direction: "push-pull" as const },
    ],
    lastSync: {},
    conflicts: {},
    staging: {},
    sync: {
      autoMerge: true,
      defaultResolution: "both",
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
    isLocked: () => false,
    unlock: async (_passphrase: string) => true,
    setEncryptionPassphrase: async (_passphrase: string) => {},
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
    automaticSyncSettingsChanged: vi.fn(),
    app: { vault: { adapter: { list: async () => ({ folders: [] }) } } },
    manifest: { version: "0.3.8" },
  } as any;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Depth-first find the first <button> whose text matches `label`. */
function findButton(root: any, label: string): any {
  if (root.tagName === "button" && root.textContent === label) return root;
  for (const child of root.children ?? []) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return undefined;
}

describe("MugsSettingTab — display() renders every section (blank-UI regression guard)", () => {
  const sections = [
    "Getting Started",
    "Accounts",
    "Connected folders",
    "Security",
    "Conflicts",
    "Sync",
    "Obsidian settings",
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
    expect(text).toContain("Both ways"); // directionLabel for push-pull
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
    "Accounts",
    "Connected folders",
    "Security",
    "Conflicts",
    "Sync",
    "Obsidian settings",
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
  it("sections support keyboard collapse and opening file filters does not dirty settings", () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    const header = tab.containerEl.querySelector(".mugs-section-header") as any;
    expect(header.attrs["aria-expanded"]).toBe("true");
    expect(header.attrs.role).toBe("button");
    expect(header.attrs.tabindex).toBe("0");
    header._handlers.keydown[0]({ key: "Enter", preventDefault() {} });
    expect(header.attrs["aria-expanded"]).toBe("false");
    header._handlers.keydown[0]({ key: " ", preventDefault() {} });
    expect(header.attrs["aria-expanded"]).toBe("true");
    const manage = tab.containerEl.querySelector(".mugs-manage-btn") as any;
    manage.handlers.click[0]();
    expect(manage.attrs["aria-expanded"]).toBe("true");
    expect(tab.containerEl.querySelector(".mugs-unsaved-banner")).toBeFalsy();
  });
  it("commits a setting change on the debounce (and immediately on Apply)", async () => {
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

  it("auto-applies a setting change shortly after the last edit", async () => {
    const plugin = makePlugin();
    let saveCalls = 0;
    plugin.store.save = vi.fn(async () => { saveCalls += 1; });

    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    // A change is debounced, not saved instantly...
    tab.containerEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    expect(saveCalls).toBe(0);

    // ...but commits on its own without an Apply click.
    await new Promise((r) => setTimeout(r, 900));
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

describe("security section — passphrase controls", () => {
  /** Setting rows render their name/desc into the card, but the obsidian stub's
   *  addButton builds detached buttons, so only names + copy are assertable here.
   *  The unlock/set behavior itself is covered by store.test.ts. */
  const sectionText = async (over: (plugin: any) => void = () => {}): Promise<string> => {
    const plugin = makePlugin();
    over(plugin);
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    const sections = Array.from(tab.containerEl.querySelectorAll(".mugs-section") as unknown as any[]).filter((el) =>
      collectText(el).includes("Security"),
    );
    return collectText(sections[0]);
  };

  it("replaces the hint placeholder with set-passphrase controls and honest copy", async () => {
    const text = await sectionText((plugin) => plugin.store.setSecurity({ encryptCredentials: true }));
    expect(text).toContain("Encryption passphrase");
    expect(text).toContain("never saves your passphrase");
    expect(text).toContain("enter your account tokens again");
    expect(text).not.toContain("Encryption key hint");
  });

  it("renders change-passphrase controls once a kdf block exists", async () => {
    const text = await sectionText((plugin) =>
      plugin.store.setSecurity({
        encryptCredentials: true,
        kdf: { algorithm: "PBKDF2-SHA-256", salt: "abc", iterations: 310000 },
      }),
    );
    expect(text).toContain("Change encryption passphrase");
  });

  it("renders the locked state and unlock row while tokens are unreadable", async () => {
    const text = await sectionText((plugin) => {
      plugin.store.setSecurity({
        encryptCredentials: true,
        kdf: { algorithm: "PBKDF2-SHA-256", salt: "abc", iterations: 310000 },
      });
      plugin.store.isLocked = () => true;
    });
    expect(text).toContain("Tokens locked");
    expect(text).toContain("enable sync for this session");
  });
});

describe("add-mapping assistant", () => {
  it("does not pause existing connections when another folder is linked", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().credentials[0].kind = "gitlab";
    plugin.store.getSettings().mappings[0].localFolder = "Archive";
    plugin.store.getSettings().mappings[0].remotePath = "Archive";
    plugin.app.vault.adapter.list = async () => ({ folders: ["Notes"] });
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    await flush();

    const row = tab.containerEl.querySelector(".mugs-match-row") as any;
    expect(row).toBeTruthy();
    const checkbox = row.children[0];
    checkbox.checked = true;
    checkbox.handlers.change[0]({ target: checkbox });
    const connect = (function find(el: any): any {
      if (el.tagName === "button" && el.textContent === "Connect selected folders") return el;
      for (const child of el.children ?? []) {
        const found = find(child);
        if (found) return found;
      }
    })(tab.containerEl);
    expect(connect).toBeTruthy();
    connect.handlers.click[0]();
    expect((tab as any).view().sync.paused).toBe(false);
    // Connect commits immediately (no "Apply settings to save" limbo) and kicks
    // the scheduler so the new folder starts syncing right away.
    await flush();
    expect(plugin.store.getSettings().sync.paused).toBe(false);
    expect(plugin.store.getSettings().mappings).toHaveLength(2);
    expect(plugin.automaticSyncSettingsChanged).toHaveBeenCalled();
  });

  it("starts a first connection syncing immediately (no forced pause)", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().mappings.splice(0);
    plugin.store.getSettings().credentials[0].kind = "gitlab";
    plugin.app.vault.adapter.list = async () => ({ folders: ["Notes"] });
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    await flush();

    const row = tab.containerEl.querySelector(".mugs-match-row") as any;
    expect(row).toBeTruthy();
    const checkbox = row.children[0];
    checkbox.checked = true;
    checkbox.handlers.change[0]({ target: checkbox });
    const findButton = (root: any, label: string): any => {
      if (root.tagName === "button" && root.textContent === label) return root;
      for (const child of root.children ?? []) {
        const found = findButton(child, label);
        if (found) return found;
      }
      return undefined;
    };
    findButton(tab.containerEl, "Connect selected folders").handlers.click[0]();
    // Minimum engagement: the first connection is NOT force-paused, so it can sync
    // as soon as the settings commit (immediately — no Apply click needed).
    expect((tab as any).view().sync.paused).toBe(false);
    await flush();
    expect(plugin.store.getSettings().sync.paused).toBe(false);
    expect(plugin.store.getSettings().mappings).toHaveLength(1);
    expect(plugin.automaticSyncSettingsChanged).toHaveBeenCalled();
  });

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
    expect(collectText(takenRow!)).toContain("Connected");
  });

  it("renders existing mapping cards before the add-mapping form", async () => {
    const plugin = makePlugin();
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    // Existing connections take priority over adding another connection.
    const section = Array.from(tab.containerEl.querySelectorAll(".mugs-section"))
      .find((s) => collectText(s).includes("Connected folders")) as HTMLElement;
    expect(section).toBeTruthy();
    const all = Array.from(section.querySelectorAll("*"));
    const addFormIdx = all.findIndex((c) => c.classList.contains("mugs-matches"));
    const mappingCardIdx = all.findIndex((c) => c.classList.contains("mugs-mapping"));

    expect(addFormIdx).toBeGreaterThanOrEqual(0);
    expect(mappingCardIdx).toBeGreaterThanOrEqual(0);
    expect(mappingCardIdx).toBeLessThan(addFormIdx);
  });
});

describe("settings onboarding — endpoint autofill and inline validation", () => {
  it("prefills the Base URL field with the provider's API endpoint", async () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    await flush();
    const inputs = tab.containerEl.querySelectorAll('input[type="text"]') as unknown as Array<{ value: string }>;
    const values = inputs.map((i) => i.value);
    expect(values).toContain("https://gitlab.com/api/v4");
  });

  it("renders a Test connection control in the add-account form", async () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    await flush();
    expect(findButton(tab.containerEl, "Test connection")).toBeTruthy();
  });

  it("auto-fills the account label and only requires a token on an empty submit", async () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    await flush();
    // The label defaults to the provider name, so the user only supplies a token.
    const inputs = tab.containerEl.querySelectorAll('input[type="text"]') as unknown as Array<{ value: string }>;
    expect(inputs.map((i) => i.value)).toContain("GitLab");
    const add = findButton(tab.containerEl, "Add account");
    expect(add).toBeTruthy();
    add.handlers.click[0]();
    const text = collectText(tab.containerEl);
    expect(text).not.toContain("A label is required.");
    expect(text).toContain("A token is required for a hosted account.");
  });

  it("shows a pending-change count in the unsaved banner", async () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    await flush();
    const toggle = tab.containerEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    toggle.click();
    const banner = tab.containerEl.querySelector(".mugs-unsaved-banner")!;
    expect(banner).toBeTruthy();
    expect(collectText(banner)).toContain("unsaved change");
  });

  it("shows a muted hint instead of a broken form when no account exists", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().credentials.splice(0);
    plugin.store.getSettings().mappings.splice(0);
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    expect(collectText(tab.containerEl)).toContain("Add an account above first to connect a repository.");
    expect(findButton(tab.containerEl, "Connect selected folders")).toBeFalsy();
  });

});

describe("connect form — whole-repo root sync", () => {
  it("connects a local credential as whole-repo root sync immediately", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().mappings.splice(0);
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    await flush();

    // Local credentials default to root sync: the connect button works out of
    // the box (the old flow dead-ended with "check at least one folder to link").
    const connect = findButton(tab.containerEl, "Connect vault root");
    expect(connect).toBeTruthy();
    connect.handlers.click[0]();
    await flush();

    const mappings = plugin.store.getSettings().mappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0].localFolder).toBe(".");
    expect(mappings[0].remotePath).toBe("");
    expect(mappings[0].providerId).toBe("c1");
    expect(plugin.automaticSyncSettingsChanged).toHaveBeenCalled();
  });

  it("connects a hosted repo as whole-repo root sync with repoRef + repoPath and kicks the scheduler", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().mappings.splice(0);
    plugin.store.getSettings().credentials[0].kind = "gitlab";
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    await flush();

    // Flip the mode choice to whole-repo root sync (second radio).
    const radios = tab.containerEl.querySelectorAll('input[type="radio"]') as unknown as any[];
    expect(radios.length).toBe(2);
    const rootRadio = radios[1];
    rootRadio.checked = true;
    rootRadio.handlers.change[0]({ target: rootRadio });

    const connect = findButton(tab.containerEl, "Connect vault root");
    expect(connect).toBeTruthy();
    connect.handlers.click[0]();
    await flush();

    const mappings = plugin.store.getSettings().mappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0].localFolder).toBe(".");
    expect(mappings[0].remotePath).toBe("");
    expect(mappings[0].repoRef).toBe("r1");
    expect(mappings[0].repoPath).toBe("team/repo");
    expect(mappings[0].providerId).toBe("c1");
    expect(mappings[0].label).toBe("team/repo");
    expect(plugin.automaticSyncSettingsChanged).toHaveBeenCalled();
  });
});

describe("accounts — honest status + in-place token repair", () => {
  it("flags a credential whose keychain entry is missing and repairs it in place", async () => {
    const plugin = makePlugin();
    const cred = plugin.store.getSettings().credentials[0];
    cred.kind = "gitlab";
    cred.secretId = "mugs-c1";
    cred.token = "";
    (plugin.store as any).getCredentialStatus = (id: string) => (id === "c1" ? "missing-keychain" : "ready");
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    expect(collectText(tab.containerEl)).toContain("token missing on this device — paste token below");

    // The repair input is auto-expanded: the first password field on the page.
    const input = tab.containerEl.querySelector('input[type="password"]') as any;
    expect(input).toBeTruthy();
    input.value = "glpat-repaired";
    const save = findButton(tab.containerEl, "Save token");
    expect(save).toBeTruthy();
    save.handlers.click[0]();
    await flush();

    const stored = plugin.store.getSettings().credentials[0];
    expect(stored.token).toBe("glpat-repaired");
    expect(stored.id).toBe("c1"); // repaired in place — id preserved, mappings stay linked
    expect(stored.secretId).toBe("mugs-c1");
    expect(plugin.automaticSyncSettingsChanged).toHaveBeenCalled();
  });

  it("describes a keychain-backed ready credential as saved in the keychain", async () => {
    const plugin = makePlugin();
    const cred = plugin.store.getSettings().credentials[0];
    cred.kind = "gitlab";
    cred.secretId = "mugs-c1";
    (plugin.store as any).getCredentialStatus = () => "ready";
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    expect(collectText(tab.containerEl)).toContain("token: saved in keychain");
  });

  it("infers missing-keychain without the store helper (secretId set, token unreadable)", async () => {
    const plugin = makePlugin();
    const cred = plugin.store.getSettings().credentials[0];
    cred.kind = "gitlab";
    cred.secretId = "mugs-c1";
    cred.token = "";
    plugin.store.getToken = () => undefined;
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    expect(collectText(tab.containerEl)).toContain("token missing on this device — paste token below");
  });
});

describe("mapping cards — account recovery", () => {
  it("highlights a mapping whose account is missing and rebinds in one click", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().mappings[0].providerId = "ghost";
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();

    expect(collectText(tab.containerEl)).toContain("Account missing — select an account to reconnect");
    const use = findButton(tab.containerEl, "Use Work");
    expect(use).toBeTruthy();
    use.handlers.click[0]();
    await flush();

    expect(plugin.store.getSettings().mappings[0].providerId).toBe("c1");
    expect(plugin.automaticSyncSettingsChanged).toHaveBeenCalled();
  });
});

describe("secondary sections — progressive disclosure", () => {
  const sectionTitles = (tab: MugsSettingTab): string[] =>
    (tab.containerEl.querySelectorAll(".mugs-section") as unknown as any[]).map((s) =>
      collectText(s.querySelector(".mugs-section-header")).replace(/[▾▸]/g, "").trim(),
    );
  const collapsedTitles = (tab: MugsSettingTab): string[] =>
    (tab.containerEl.querySelectorAll(".mugs-section") as unknown as any[])
      .filter((s) => s.className.includes("is-collapsed"))
      .map((s) => collectText(s.querySelector(".mugs-section-header")).replace(/[▾▸]/g, "").trim());

  it("default-collapses Conflicts, Security, and Obsidian settings (unlocked, sync off)", async () => {
    const tab = new MugsSettingTab(makePlugin());
    tab.display();
    await flush();

    const collapsed = collapsedTitles(tab);
    expect(collapsed).toContain("Conflicts");
    expect(collapsed).toContain("Security");
    expect(collapsed).toContain("Obsidian settings");
    // Primary sections stay expanded.
    expect(collapsed).not.toContain("Getting Started");
    expect(collapsed).not.toContain("Accounts");
    expect(collapsed).not.toContain("Connected folders");
    expect(sectionTitles(tab)).toHaveLength(6); // + Sync + About
  });

  it("auto-expands Security while the vault is locked", async () => {
    const plugin = makePlugin();
    plugin.store.isLocked = () => true;
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    expect(collapsedTitles(tab)).not.toContain("Security");
    expect(collapsedTitles(tab)).toContain("Conflicts");
  });

  it("keeps Getting Started compact once every step is done", async () => {
    const plugin = makePlugin();
    plugin.store.getSettings().lastSync.m1 = { mappingId: "m1", status: "ok" } as any;
    const tab = new MugsSettingTab(plugin);
    tab.display();
    await flush();
    expect(collectText(tab.containerEl)).toContain("All set — account connected, folders linked, and sync has run.");
    expect((tab.containerEl.querySelectorAll(".mugs-gs-step") as unknown as any[])).toHaveLength(0);
  });
});
