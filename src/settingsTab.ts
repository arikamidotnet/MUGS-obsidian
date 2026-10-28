/**
 * MUGS — Multi-User Git Sync
 * Settings tab (v0.3.1 overhaul). Renders credentials, folder mappings and security
 * options with working add/delete controls backed by the store. Rendering uses
 * Obsidian's native Setting rows + toggles to match modern Obsidian settings UX; all
 * reusable logic lives in pure modules (sync/folderMatch.ts, sync/obsidianCategories.ts)
 * so this file stays thin and never runs in unit tests (it imports the Obsidian DOM API).
 */
import { PluginSettingTab, Setting, Notice, type SettingDefinitionItem } from "obsidian";
import type MugsPlugin from "./main";
import type { Credential, SyncDirection, ObsidianScope, ObsidianEntryPolicy, FolderMapping, SyncStatus } from "./types";
import type { RepoSummary } from "./providers/types";
import { buildProvider, defaultBaseUrl } from "./providers/factory";
import { INTERVAL_PRESETS, resolveIntervalSeconds, presetIdForSeconds } from "./sync/cadence";
import { effectiveObsidianEntries } from "./sync/obsidianScope";
import { categorizeObsidianEntries } from "./sync/obsidianCategories";
import { matchFolderPairs, matchFolderPairsFuzzy, type FolderMatch } from "./sync/folderMatch";

// The shipped obsidian typings (pinned "latest" at an older snapshot) omit
// addSelect/addField from Setting even though both are real runtime APIs.
// Augment the module so our native select builder typechecks (same pattern as
// Plugin.addStyleTag in main.ts).
declare module "obsidian" {
  interface Setting {
    addField(label: string, input: HTMLElement): this;
  }
}

/** Generate a stable id for new credentials/mappings. */
function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

/** Split a newline-separated textarea into trimmed, non-empty gitignore glob lines. */
function parseGlobList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Extract a readable message from a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mask a token so only its last few characters are visible. */
function maskToken(token: string): string {
  if (!token) return "not set";
  return `••••${token.slice(-4)}`;
}

export class MugsSettingTab extends PluginSettingTab {
  constructor(private plugin: MugsPlugin) {
    super(plugin.app, plugin);
  }

  /**
   * Force Obsidian's legacy display() path on the declarative settings API added in
   * 1.13.0. The base PluginSettingTab.getSettingDefinitions() reads this.plugin.settings
   * and, when it returns a non-empty array, makes Obsidian render the tab declaratively
   * and SKIP display() — blanking our custom UI (MUGS stores settings in plugin.store,
   * not plugin.settings). Returning an empty array makes every supported Obsidian build
   * fall back to display(), which renders this pane. Builds older than 1.13 never call
   * getSettingDefinitions(), so this override is a no-op there.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  display(): void {
    this._renderAll();
  }

  /** True when settings changed in-memory but not yet persisted to disk via Apply.
   *  Live preview works regardless: store setters mutate the in-memory store
   *  immediately, so the scheduler/sync runner already see edits; only the on-disk
   *  write is deferred until the user applies them (see applySettings). */
  private unsavedChanges = false;

  /** Reused single instance of the top-of-pane unsaved-changes banner. Kept as a
   *  persistent element rather than rebuilt each render so toggling it never
   *  rebuilds text inputs and steals focus/caret position. */
  private unsavedBannerEl: HTMLElement | null = null;

  /** Create the single unsaved-changes banner if it does not yet exist. */
  private ensureUnsavedBanner(): void {
    if (this.unsavedBannerEl) return;
    const el = this.containerEl.createDiv({ cls: "mugs-unsaved-banner" });
    el.style.display = "none"; // hidden until there are unsaved changes
    el.createEl("span", { cls: "mugs-unsaved-note", text: "Unsaved changes — not yet applied." });
    const applyBtn = el.createEl("button", { cls: "mugs-unsaved-apply", text: "Apply settings" });
    applyBtn.addEventListener("click", () => void this.applySettings());
    this.unsavedBannerEl = el;
  }

  /** Flag that a setting changed so it is not persisted until the user applies.
   *  Toggles only the banner's visibility (no full re-render) so text inputs keep
   *  focus and caret position. */
  private markUnsaved(): void {
    this.unsavedChanges = true;
    if (!this.unsavedBannerEl) this.ensureUnsavedBanner();
    if (this.unsavedBannerEl) this.unsavedBannerEl.style.display = "";
  }

  /** Persist the current in-memory settings to disk and clear the unsaved flag. */
  private async applySettings(): Promise<void> {
    if (this.unsavedBannerEl) this.unsavedBannerEl.remove();
    this.unsavedBannerEl = null;
    this.unsavedChanges = false;
    await this.plugin.store.save();
    new Notice("MUGS: settings saved.");
  }

  private _renderAll(): void {
    const { containerEl } = this;
    // Reuse a single unsaved-changes banner across renders so toggling it never
    // rebuilds text inputs (which would steal focus). Insert at the top after empty().
    containerEl.empty();
    if (this.unsavedBannerEl) containerEl.appendChild(this.unsavedBannerEl);

    // --- Getting Started (startup documentation) ----------------------------
    this.gettingStarted(containerEl);

    // --- Credentials / providers -------------------------------------------
    this.section(containerEl, "Credentials & Providers", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Store per-user tokens inside this vault. Tokens are never shown in full and can be encrypted at rest.",
      });

      const creds = this.plugin.store.getDisplaySettings().credentials;
      if (creds.length === 0) {
        card.createEl("p", { cls: "mugs-muted", text: "No credentials yet." });
      } else {
        for (const c of creds) {
          const descParts = [`token: ${maskToken(c.token)}`];
          if (c.username) descParts.push(`user: ${c.username}`);
          if (c.baseUrl) descParts.push(`url: ${c.baseUrl}`);
          new Setting(card)
            .setName(`${c.label} (${c.kind})`)
            .setDesc(descParts.join(" · "))
            .addButton((b) =>
              b.setButtonText("Delete").onClick(() => {
                this.plugin.store.removeCredential(c.id);
                this.markUnsaved();
                this._renderAll();
              }),
            );
        }
      }

      card.createEl("div", { cls: "mugs-divider" });
      this.addCredentialForm(card);
    });

    // --- Folder mappings ----------------------------------------------------
    // Reordered so the add-mapping form ("Available to map") sits above the existing
    // mapping cards ("Mapped folders"): users see what they can link first.
    this.section(containerEl, "Folder Mappings", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Map remote paths to vault folders for fine-grained, per-user sync.",
      });

      // Available to map — the add-mapping assistant.
      this.addMappingForm(card);

      card.createEl("div", { cls: "mugs-divider" });

      // Mapped folders — existing mapping cards with status dots + controls.
      const mappings = this.plugin.store.getDisplaySettings().mappings;
      if (mappings.length === 0) {
        card.createEl("p", { cls: "mugs-muted", text: "No mappings yet." });
      } else {
        this.renderMappings(card, mappings);
      }
    });

    // --- Security -----------------------------------------------------------
    this.section(containerEl, "Security & Credentials", (card) => {
      new Setting(card)
        .setName("Encrypt credentials at rest")
        .setDesc("When on, stored tokens are encrypted in data.json instead of saved as-is.")
        .addToggle((t) =>
          t
            .setValue(this.plugin.store.getSettings().security.encryptCredentials)
            .onChange(async (v) => {
              this.plugin.store.setSecurity({ encryptCredentials: v });
              await this.markUnsaved();
              new Notice(`MUGS credentials ${v ? "encrypted" : "unencrypted"} at rest.`);
            }),
        );

      new Setting(card)
        .setName("Encryption key hint")
        .setDesc("Placeholder for a future KDF-derived key (Phase 2).")
        .addText((txt) =>
          txt
            .setValue(this.plugin.store.getSettings().security.encryptionKeyHint ?? "")
            .onChange(async (v) => {
              this.plugin.store.setSecurity({ encryptionKeyHint: v });
              await this.markUnsaved();
            }),
        );
    });

    // --- Automatic conflict resolution (Area 3/4) -------------------------
    this.section(containerEl, "Automatic Conflict Resolution", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "When both sides edited the same lines, decide how MUGS merges them automatically.",
      });

      const sync = this.plugin.store.getSettings().sync;
      new Setting(card)
        .setName("Auto-merge when no conflict")
        .setDesc("Combine edits from both sides into one file whenever they don't touch the same lines.")
        .addToggle((t) => {
          t.setValue(sync.autoMerge).onChange(async (v) => {
            this.plugin.store.setSync({ autoMerge: v });
            await this.markUnsaved();
          });
        });

      new Setting(card)
        .setName("Tie-break for unresolved hunks")
        .setDesc('When both sides edited the same lines, combine ("both") or pick a side ("ours"/"theirs").')
        .addDropdown((d) => {
          d.setValue(sync.defaultResolution).onChange(async (v) => {
            this.plugin.store.setSync({ defaultResolution: v as "both" | "theirs" | "ours" });
            await this.markUnsaved();
          });
          for (const [value, text] of [["both", "Both"], ["theirs", "Theirs"], ["ours", "Ours"]]) {
            d.addOption(value, text);
          }
        });

      new Setting(card)
        .setName("Resolve by recency")
        .setDesc("When a file is edited on both sides at different times, keep the most recent version.")
        .addToggle((t) => {
          t.setValue(sync.recencyWins).onChange(async (v) => {
            this.plugin.store.setSync({ recencyWins: v });
            await this.markUnsaved();
          });
    });
    });

    // --- Sync frequency + maintenance (Area 5/8) --------------------------
    this.section(containerEl, "Sync Frequency & Maintenance", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "How often MUGS polls for remote changes while idle, and a global pause for bulk edits.",
      });

      const sync = this.plugin.store.getSettings().sync;
      new Setting(card)
        .setName("Polling interval")
        .addDropdown((d) => {
          d.setValue(presetIdForSeconds(sync.intervalSeconds)).onChange(async (v) => {
            this.plugin.store.setSync({ intervalSeconds: resolveIntervalSeconds(v) });
            await this.markUnsaved();
          });
          for (const [value, text] of INTERVAL_PRESETS.map((p) => [p.id, p.label]) as Array<[string, string]>) {
            d.addOption(value, text);
          }
        });

      new Setting(card)
        .setName("Pause vault sync")
        .setDesc("While paused, MUGS stops all automatic push/pull and event triggers. Use it to make bulk edits safely; resuming runs one catch-up pass.")
        .addToggle((t) => {
          t.setValue(sync.paused).onChange(async (v) => {
            this.plugin.store.setSync({ paused: v });
            await this.markUnsaved();
            new Notice(`MUGS sync ${v ? "paused" : "resumed"}.`);
          });
    });

      // Whole-vault mappings expose a per-mapping .trash/ toggle.
      const mappings = this.plugin.store.getSettings().mappings;
      for (const m of mappings) {
        if (m.remotePath === "" && m.localFolder === ".") {
          new Setting(card)
            .setName("Sync the repository's .trash/ folder")
            .setDesc("Shared across all users via the single git path, like Obsidian's trash. Turn off to keep deletions local to this device.")
            .addToggle((t) =>
              t.setValue(m.syncTrashFolder !== false).onChange(async (v) => {
                this.plugin.store.upsertMapping({ ...m, syncTrashFolder: v ? undefined : false });
                await this.markUnsaved();
              }),
            );
        }
      }
    });

    // --- Obsidian config sync (Area 9) ------------------------------------
    this.section(containerEl, "Obsidian Config Sync", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Share selected Obsidian settings files with your team through the same sync system.",
      });

      const obs = this.plugin.store.getSettings().sync.obsidianConfig;
      new Setting(card)
        .setName("Enable Obsidian config sync")
        .setDesc("When on, selected .obsidian/ files are synced alongside your vault folders.")
        .addToggle((t) => {
          t.setValue(obs.enabled).onChange(async (v) => {
            this.plugin.store.setObsidianConfigEnabled(v);
            await this.markUnsaved();
            new Notice(`MUGS .obsidian/ sync ${v ? "enabled" : "disabled"}.`);
            this._renderAll();
          });
        });

      // Obsidian-Sync-style grouped toggles: each top-level .obsidian/ child gets a
      // personal/vault-wide scope so you can share all settings or only certain components.
      this.renderObsidianEntries(card, obs);
    });

    // --- About ------------------------------------------------------------
    containerEl.createEl("h2", { text: "About" });
    containerEl.createEl("p", {
      text: `MUGS — Multi-User Git Sync · v${this.plugin.manifest.version}`,
      cls: "mugs-muted",
    });
    containerEl.createEl("p", {
      text: "Add a credential, then map a remote path to a vault folder. Use the ribbon icons or the 'MUGS' commands to sync and view changes.",
    });
  }

  /** The Getting Started guide shown at the top of every settings open. This is
   *  the plugin's startup documentation — it walks a fresh install through adding a
   *  credential, creating a mapping, and syncing via the views/commands. */
  private gettingStarted(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "mugs-getting-started" });
    card.createEl("h3", { text: "Getting Started" });
    card.createEl("p", {
      cls: "mugs-gs-intro",
      text: "MUGS syncs Obsidian folders with git remotes (GitLab, GitHub, Bitbucket, Gitea/Forgejo or a local repo) using an automatic-first, fully git-reversible model. Set it up in three steps:",
    });

    const steps = card.createEl("ol", { cls: "mugs-gs-steps" });
    steps.createEl("li", { text: "Add a credential — under Credentials & Providers, add your provider and token. For GitLab paste the base URL (include /api/v4 if self-hosted)." });
    steps.createEl("li", { text: "Create a folder mapping — under Folder Mappings, map a remote path (or the repo root) to a vault folder such as Notes, then pick push+pull, pull-only, or push-only and an optional branch." });
    steps.createEl("li", { text: "Sync — open the MUGS Map view to see each mapping's status. Edits sync automatically; use the Review Queue to stage/hold specific files and Diff to compare against the last-synced baseline." });

    card.createDiv({
      cls: "mugs-note",
      text: "Local provider tip: a local mapping clones its repo into .mugs-clones/ inside the vault and treats that clone as the synced copy (your vault's own folders are not written to). Every sync is reversible via git history and the .mugs-trash. Open these settings via the gear icon next to MUGS in Community plugins.",
    });
  }

  /** Wrap children in a single grouped settings card with a collapsible header.
   *  The title is rendered as the clickable header (with a chevron); body() receives
   *  the content area element. Toggling only flips an `is-collapsed` class, so live-
   *  preview re-renders never rebuild text inputs and steal focus. */
  private section(containerEl: HTMLElement, title: string, body: (card: HTMLElement) => void): void {
    // Build the card with Obsidian's native createDiv so it is guaranteed to expose
    // createEl/createDiv/etc. In Obsidian 1.14.x a raw document.createElement("div")
    // element does not reliably inherit those helpers, which left every section blank.
    const card = containerEl.createDiv({ cls: "mugs-section" });
    const header = card.createEl("div", { cls: "mugs-section-header" });
    const chevron = header.createEl("span", { cls: "mugs-section-chevron", text: "▸" });
    header.createEl("h3", { text: title });
    const content = card.createDiv({ cls: "mugs-section-body" });
    header.addEventListener("click", () => {
      const collapsed = card.classList.toggle("is-collapsed");
      chevron.textContent = collapsed ? "▸" : "▾";
    });
    body(content);
    return;
  }

  /** Human-readable direction label for a mapping. */
  private directionText(d: SyncDirection): string {
    return d === "push-pull" ? "Push + pull" : d === "pull-only" ? "Pull only" : "Push only";
  }

  /** CSS class name for a sync-status dot, or "" when no status is recorded.
   *  Colors are theme variables so they adapt to light/dark/custom themes:
   *  error = red, conflict/pending = yellow, ok/up-to-date = green, none = gray. */
  private statusDotClass(status?: SyncStatus): string {
    switch (status) {
      case "error": return "mugs-status-error";
      case "conflict":
      case "pending": return "mugs-status-warning";
      case "ok":
      case "up-to-date": return "mugs-status-ok";
      default: return "mugs-status-none";
    }
  }

  /** Render each stored mapping as a card with native Setting rows, collapsible
   *  include/exclude managers. The whole-vault .trash/ toggle lives in the
   *  Sync Frequency & Maintenance section instead. */
  private renderMappings(card: HTMLElement, mappings: FolderMapping[]): void {
    for (const m of mappings) {
      const block = card.createDiv({ cls: "mugs-mapping" });

      // Header row: status dot + label + delete button. Rendered manually so the
      // sync-status dot sits beside the name (native Setting has no leading icon slot).
      const header = block.createDiv({ cls: "mugs-mapping-header" });
      const dot = header.createEl("span", { cls: `mugs-dot ${this.statusDotClass(this.plugin.store.getSettings().lastSync[m.id]?.status)}` });
      header.createEl("span", { cls: "mugs-mapping-name", text: m.label });
      new Setting(header).addButton((b) =>
        b.setButtonText("Delete").onClick(() => {
          this.plugin.store.removeMapping(m.id);
          this.markUnsaved();
          this._renderAll();
        }),
      );

      // Editable direction for every card (scoped links and whole-repo alike).
      new Setting(block)
        .setName("Direction")
        .setDesc("Which way changes flow between the remote and your vault.")
        .addDropdown((d) => {
          d.setValue(m.direction).onChange(async (v) => {
            const direction = v as SyncDirection;
            this.plugin.store.upsertMapping({ ...m, direction });
            await this.markUnsaved();
          });
          for (const [value, text] of [["push-pull", "Push + pull"], ["pull-only", "Pull only"], ["push-only", "Push only"]]) {
            d.addOption(value, text);
          }
        });

      block.appendChild(this.managePanel(
        "Includes",
        (m.includes ?? []).join("\n"),
        (v) => this.saveMappingScope(m.id, { includes: parseGlobList(v) }),
        "Only these globs sync within the scope (optional). Leave empty for everything.",
      ));
      block.appendChild(this.managePanel(
        "Excludes",
        (m.excludes ?? []).join("\n"),
        (v) => this.saveMappingScope(m.id, { excludes: parseGlobList(v) }),
        "These globs never sync (gitignore-style; '!' re-includes).",
      ));

    }
  }
  /** A collapsible labelled panel with a "Manage" button that reveals a textarea.
   *  Mirrors Obsidian Sync's "Excluded folders · Manage" progressive disclosure. */
  private managePanel(title: string, initialText: string, onChange: (v: string) => void, placeholder: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "mugs-manage";

    const head = document.createElement("div");
    head.className = "mugs-manage-head";
    const lbl = document.createElement("span");
    lbl.className = "mugs-manage-title";
    lbl.textContent = title;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mugs-manage-btn";
    btn.textContent = "Manage";

    const panel = document.createElement("div");
    panel.className = "mugs-manage-panel is-collapsed";
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.style.width = "100%";
    ta.className = "mugs-textarea";
    ta.placeholder = placeholder;
    ta.value = initialText;
    ta.addEventListener("change", (e: Event) => onChange((e.target as HTMLTextAreaElement).value));

    btn.addEventListener("click", () => {
      panel.classList.toggle("is-collapsed");
      // Persist the current value whenever the panel is opened so edits are not lost.
      if (!panel.classList.contains("is-collapsed")) onChange(ta.value);
    });

    head.appendChild(lbl);
    head.appendChild(btn);
    panel.appendChild(ta);
    wrap.appendChild(head);
    wrap.appendChild(panel);
    return wrap;
  }

  /** Persist an editable include/exclude scope change on an existing mapping. */
  private saveMappingScope(
    id: string,
    patch: { includes?: string[]; excludes?: string[] },
  ): void {
    const current = this.plugin.store.getSettings().mappings.find((x) => x.id === id);
    if (!current) return;
    this.plugin.store.upsertMapping({ ...current, ...patch });
    this.markUnsaved();
  }

  /**
   * Obsidian-Sync-style grouped toggles for top-level .obsidian/ children (Area 9).
   * Entries are bucketed into named categories ("Main settings", "Themes & snippets",
   * …) each with a personal/vault-wide toggle. Re-renders persist on change.
   */
  private renderObsidianEntries(card: HTMLElement, obs: { enabled: boolean; entries: ObsidianEntryPolicy[] }): void {
    if (!obs.enabled) return;

    const effective = Array.from(effectiveObsidianEntries(obs).values()).map((e) => structuredClone(e));
    const persist = (entries: ObsidianEntryPolicy[]): void => {
      this.plugin.store.setObsidianConfig({ enabled: obs.enabled, entries });
      this.markUnsaved();
    };

    for (const group of categorizeObsidianEntries(effective)) {
      card.createEl("div", { cls: "mugs-obsidian-group-head", text: group.title });

      for (const path of group.paths) {
        const entry = effective.find((e) => e.path === path)!;
        new Setting(card)
          .setName(path)
          .setDesc(group.description)
          .addToggle((t) =>
            t.setValue(entry.scope === "vault-wide").onChange(async (v) => {
              const scope: ObsidianScope = v ? "vault-wide" : "personal";
              persist(effective.map((x) => (x.path === path ? { ...x, scope } : x)));
              new Notice(`.obsidian/${path} ${v ? "shared vault-wide" : "kept personal"}.`);
            }),
          )
          .addButton((b) =>
b.setButtonText("Remove").setClass("mugs-link-btn").onClick(() => {
              persist(effective.filter((x) => x.path !== path));
            }),
          );
      }
    }

    // Add-entry field.
    const addWrap = card.createDiv({ cls: "mugs-obsidian-add" });
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Add an .obsidian/ path (e.g. my-settings.json)";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "mugs-link-btn";
    addBtn.textContent = "Add entry";
    const add = (): void => {
      const p = input.value.trim();
      if (!p) return;
      persist([...effective, { path: p, scope: "personal" }]);
    };
    addBtn.addEventListener("click", add);
    input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") add(); });
    addWrap.appendChild(input);
    addWrap.appendChild(addBtn);
  }

  /** Add-credential form using native Obsidian Setting rows (dropdown/text/password/textarea). */
  private addCredentialForm(card: HTMLElement): void {
    let kind: Credential["kind"] = "gitlab";
    let label = "";
    let username = "";
    let token = "";
    let baseUrl = "";
    let repos: string[] = [];
    let baseUrlInputEl: HTMLInputElement | null = null;

    const setBaseUrlField = (value: string): void => {
      baseUrl = value;
      if (baseUrlInputEl) baseUrlInputEl.value = value;
    };
    const prefilledBaseUrl = (k: Credential["kind"]): string =>
      k === "local" ? "" : defaultBaseUrl(k);

    new Setting(card)
      .setName("Provider")
      .setDesc("The backend this token authenticates against.")
      .addDropdown((d) => {
        d.setValue(kind).onChange(async (v) => {
          kind = v as Credential["kind"];
          setBaseUrlField(prefilledBaseUrl(kind));
          await this.markUnsaved();
        });
        for (const [value, text] of [
          ["gitlab", "GitLab"],
          ["github", "GitHub"],
          ["bitbucket", "Bitbucket"],
          ["gitea", "Gitea / Forgejo"],
          ["local", "Local (existing clone)"],
        ] as const) {
          d.addOption(value, text);
        }
      });

    new Setting(card)
      .setName("Label")
      .setDesc("A friendly name for this credential.")
      .addText((t) => t.setPlaceholder("Label").onChange((v) => { label = v.trim(); }));

    new Setting(card)
      .setName("Username")
      .setDesc("Optional username (GitLab shows the acting user).")
      .addText((t) => t.setPlaceholder("Username (optional)").onChange((v) => { username = v.trim(); }));

    new Setting(card)
      .setName("Token")
      .setDesc("Your API token. Never shown in full; optionally encrypted at rest.")
      .addText((t) => {
        t.setPlaceholder("Token").inputEl.type = "password";
        t.onChange((v) => { token = v; });
      });

    new Setting(card)
      .setName("Base URL")
      .setDesc("Self-hosted instance base URL (include /api/v4 if needed).")
      .addText((t) => {
        baseUrlInputEl = t.inputEl;
        t.setPlaceholder("Base URL (optional, incl. /api/v4)").onChange((v) => { baseUrl = v.trim(); });
      });

    new Setting(card)
      .setName("Allowed repositories")
      .setDesc("Optional owner/repo per line to restrict which repos this credential may access.")
      .addTextArea((ta) => ta.setPlaceholder("owner/repo\nowner/other-repo").onChange((v) => { repos = parseGlobList(v); }));

    card.appendChild(this.actions([
      {
        text: "Add credential",
        cta: true,
        onClick: async () => {
          if (!label) { new Notice("MUGS: enter a label for the credential."); return; }
          if (!token && kind !== "local") { new Notice("MUGS: enter a token."); return; }
          try {
            this.plugin.store.upsertCredential({
              id: newId(),
              label,
              kind,
              username: username || undefined,
              token,
              baseUrl: baseUrl || undefined,
              repos: repos.length ? repos : undefined,
            });
            await this.markUnsaved();
            new Notice(`MUGS: credential "${label}" saved.`);
            this._renderAll();
          } catch (e) {
            new Notice(`MUGS: could not save credential — ${errorMessage(e)}`);
          }
        },
      },
    ]));
  }
  /** Staged assistant for adding mappings: pick a credential → pick (or sync) a repo →
   *  check the matched top-level folders to link. Each checked folder becomes its own
   *  individually-editable mapping card scoped to that repo via `repoRef` (they share one
   *  clone); the whole-repo toggle adds a legacy whole-repo mapping whose id is the repo id.
   */
  private async addMappingForm(card: HTMLElement): Promise<void> {
    const creds = this.plugin.store.getSettings().credentials;
    let providerId = creds[0]?.id ?? "";
    let direction: SyncDirection = "push-pull";
    let branch = "";
    let includesText = "";
    let excludesText = "";
    // REST repo selection: repoRef (repo.id) is stored on scoped links so the driver +
    // clone manager resolve them against one shared clone; whole-repo mappings keep id === repo.id.
    let repoRef = "";
    let repoKey = "";
    let reposCache: RepoSummary[] = [];
    let syncTrash = false; // whole-repo sub-option: include the repo's .trash folder in the sync
    let wholeRepo = false;
    let selectedFolders = new Set<string>(); // matched remote paths the user checked to link
    let matches: FolderMatch[] = [];       // exact name matches (top-level only)
    let fuzzyMatches: Array<{ remotePath: string; localFolder: string; label: string; score: number }> = [];

    // Local folders already claimed by an existing mapping. Matched folders whose
    // localFolder is in this set are shown as disabled rows with a "Mapped" badge so
    // users see what's taken and why, rather than silently losing the choice.
    const usedLocalFolders = new Set(
      this.plugin.store.getSettings().mappings.map((x) => x.localFolder),
    );
    const isRest = (): boolean => {
      const cred = creds.find((c) => c.id === providerId);
      return !!cred && cred.kind !== "local";
    };

    // --- Credential selector -------------------------------------------------
    new Setting(card)
      .setName("Provider")
      .setDesc("The backend this mapping authenticates against.")
      .addDropdown((d) => {
        d.setValue(providerId).onChange(async (v) => {
          wholeRepo = false;
          syncTrash = false;
          selectedFolders.clear();
          await refreshRepos();
        });
        for (const [value, text] of creds.map((c) => [c.id, c.label] as [string, string])) {
          d.addOption(value, text);
        }
      });

    // --- Repository selector -------------------------------------------------
    const repoSelWrap = card.createDiv({ cls: "mugs-repo-select-wrap" });
    const loadingEl = repoSelWrap.createDiv({ cls: "mugs-loading-row", text: "" });
    const spinner = loadingEl.createEl("span", { cls: "mugs-loading" });
    loadingEl.createEl("span", { text: "Loading repositories…" });
    loadingEl.style.display = "none";
    const repoSel = card.createEl("select", { cls: "mugs-repo-select" });

    const refreshRepos = async (): Promise<void> => {
      loadingEl.style.display = "";
      spinner.style.display = "inline-block";
      selectedFolders.clear();
      reposCache = [];
      repoRef = "";
      repoKey = "";
      try {
        if (!isRest()) {
          // Local provider has no REST adapter: it syncs one existing clone as a whole-repo mapping.
          repoSel.innerHTML = '<option value="">Local clone (single repo)</option>';
          await refreshMatches();
          return;
        }
        const cred = creds.find((c) => c.id === providerId);
        if (!cred) { repoSel.disabled = true; return; }
        const token = this.plugin.store.getToken(providerId) ?? "";
        if (!token) { new Notice("MUGS: enter a token for this credential."); repoSel.disabled = true; return; }
        const provider = buildProvider({ kind: cred.kind, baseUrl: cred.baseUrl, token, allowedRepos: cred.repos }, { actingUsername: cred.username });
        reposCache = await provider.listRepos();
        if (reposCache.length === 0) {
          new Notice("MUGS: no accessible repositories for this credential.");
          repoSel.disabled = true;
          return;
        }
        reposCache.sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace));
        repoSel.innerHTML = "";
        for (const r of reposCache) {
          const name = r.name && r.name !== r.pathWithNamespace ? `  ·  ${r.name}` : "";
          const opt = document.createElement("option");
          opt.value = r.id;
          opt.textContent = `${r.pathWithNamespace}${name}`;
          repoSel.appendChild(opt);
        }
        // Auto-select the first repo so matched-folder suggestions appear immediately.
        const first = reposCache[0];
        repoRef = first.id;
        repoKey = first.pathWithNamespace;
        repoSel.value = first.id;
        await refreshMatches();
      } catch (e) {
        new Notice(`MUGS: could not list repositories — ${errorMessage(e)}`);
        repoSel.disabled = true;
      } finally {
        loadingEl.style.display = "none";
        spinner.style.display = "none";
      }
    };

    // Detect name matches between the chosen repo's remote dirs and vault folders, surfaced as
    // checkboxes below. Dotfolders (.obsidian/.trash) are filtered out here: .obsidian linking is
    // deprecated (handled by the Obsidian Config Sync section), and .trash is a whole-repo sub-option.
    const refreshMatches = async (): Promise<void> => {
      wholeRepo = false;
      syncTrash = true;
      selectedFolders.clear();
      fuzzyMatches = [];
      if (!isRest() || !repoKey) { matches = []; renderMatches(); return; }
      const cred = creds.find((c) => c.id === providerId);
      if (!cred) { matches = []; renderMatches(); return; }
      try {
        const detectedDirs = await this.listDirectoriesFor(cred, repoKey, "");
        const vaultTop = await this.listVaultFolders();
        // Filter out dotfolders (.obsidian/.trash): .obsidian linking is deprecated (handled by the
        // Obsidian Config Sync section), and .trash is a whole-repo sub-option.
        const remoteDirs = detectedDirs.filter((d) => d !== ".obsidian" && d !== ".trash");
        matches = matchFolderPairs(remoteDirs, vaultTop);
        // Also compute fuzzy suggestions for near-misses (e.g., "Notes" → "My Notes").
        const fuzzy = matchFolderPairsFuzzy(remoteDirs, vaultTop).filter((m) => m.score < 1 && m.remotePath !== ".obsidian" && m.remotePath !== ".trash");
        fuzzyMatches = fuzzy.map((m) => ({ remotePath: m.remotePath, localFolder: m.localFolder, label: m.label, score: m.score }));
      } catch (e) {
        matches = [];
        fuzzyMatches = [];
      }
      renderMatches();
    };

    repoSel.addEventListener("change", () => {
      const chosen = reposCache.find((r) => r.id === repoSel.value);
      if (!chosen) return;
      wholeRepo = false;
      syncTrash = false;
      selectedFolders.clear();
      repoRef = chosen.id;
      repoKey = chosen.pathWithNamespace;
      void refreshMatches();
    });

    // --- Matched-folder checkboxes + whole-repo toggle -----------------------
    const matchesEl = card.createDiv({ cls: "mugs-matches" });
    const renderMatches = (): void => {
      if (isRest() && repoKey) {
        // Whole-repo toggle: map the entire repository root to the vault root ('.').
        const wholeRow = matchesEl.createDiv({ cls: "mugs-match-whole" });
        const wholeInput = document.createElement("input");
        wholeInput.type = "checkbox";
        wholeInput.checked = wholeRepo;
        wholeInput.addEventListener("change", (e: Event) => { wholeRepo = (e.target as HTMLInputElement).checked; renderMatches(); });
        wholeRow.createEl("span", { text: "Sync the entire repository to the vault root" });
        const trashRow = matchesEl.createDiv({ cls: "mugs-match-trash" });
        trashRow.style.marginLeft = "24px";
        const trashInput = document.createElement("input");
        trashInput.type = "checkbox";
        trashInput.checked = syncTrash;
        trashInput.addEventListener("change", (e: Event) => { syncTrash = (e.target as HTMLInputElement).checked; });
        trashRow.appendChild(trashInput);
        trashRow.createEl("span", { text: "Include the repository's .trash/ folder" });
      }
      // --- Exact matches (checkboxes) -------------------------------------------
      if (matches.length > 0) {
        const head = matchesEl.createEl("div", { cls: "mugs-matches-head" });
        head.textContent = wholeRepo ? "Or link individual folders:" : "Matched folders — check to link each as its own mapping";
        for (const m of matches) {
          const row = matchesEl.createDiv({ cls: "mugs-match-row" });
          const taken = usedLocalFolders.has(m.localFolder);
          if (taken) row.classList.add("mugs-match-taken");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !taken && selectedFolders.has(m.remotePath);
          cb.disabled = taken;
          cb.addEventListener("change", (e: Event) => {
            if ((e.target as HTMLInputElement).checked) selectedFolders.add(m.remotePath);
            else selectedFolders.delete(m.remotePath);
          });
          row.appendChild(cb);
          const label = row.createEl("span", { cls: "mugs-match-label" });
          label.textContent = m.remotePath;
          label.title = taken ? `${m.localFolder} is already mapped` : `${m.remotePath} → ${m.localFolder}`;
          if (taken) label.createEl("span", { cls: "mugs-match-badge", text: "Mapped" });
          row.createEl("span", { cls: "mugs-match-arrow", text: "→" });
          row.createEl("span", { cls: "mugs-match-local", text: m.localFolder });
          matchesEl.appendChild(row);
        }
      } else if (!wholeRepo && !fuzzyMatches.length) {
        matchesEl.createEl("p", { cls: "mugs-muted", text: wholeRepo ? "" : "No folders matched between this repo and your vault yet." });
      }

      // --- Fuzzy suggestions (one-click auto-match chips) -----------------------
      if (!wholeRepo && fuzzyMatches.length > 0) {
        const head = matchesEl.createEl("div", { cls: "mugs-suggestions-head" });
        head.textContent = "Did you mean?";
        for (const fm of fuzzyMatches) {
          // Only show suggestions where the vault folder isn't already mapped.
          if (usedLocalFolders.has(fm.localFolder)) continue;
          const chip = matchesEl.createEl("button", { type: "button", cls: "mugs-match-chip" });
          chip.setAttribute("title", `Link "${fm.remotePath}" → "${fm.localFolder}" (${Math.round(fm.score * 100)}% match)`);
          chip.textContent = `${fm.remotePath} → ${fm.localFolder}`;
          chip.addEventListener("click", (e: MouseEvent) => {
            e.preventDefault();
            // Add the remote path to selectedFolders so it gets created as a mapping.
            selectedFolders.add(fm.remotePath);
            // Re-render to show it checked in the exact matches list below.
            renderMatches();
          });
        }
      }
    };

    // --- Direction + branch + include/exclude --------------------------------
    new Setting(card)
      .setName("Direction")
      .setDesc("Which way changes flow between the remote and your vault.")
      .addDropdown((d) => {
        d.setValue(direction).onChange((v) => { direction = v as SyncDirection; });
        for (const [value, text] of [["push-pull", "Push + pull"], ["pull-only", "Pull only"], ["push-only", "Push only"]]) {
          d.addOption(value, text);
        }
      });

    new Setting(card)
      .setName("Branch")
      .setDesc("Optional branch to sync. Leave empty for the default branch.")
      .addText((t) => t.setPlaceholder("Branch (optional)").onChange((v) => { branch = v.trim(); }));

    card.appendChild(this.managePanel("Includes", includesText, (v) => { includesText = v; }, "Only these globs sync within the scope (optional). Leave empty for everything."));
    card.appendChild(this.managePanel("Excludes", excludesText, (v) => { excludesText = v; }, "These globs never sync (gitignore-style; '!' re-includes)."));

    // --- Save ----------------------------------------------------------------
    card.appendChild(this.actions([
      {
        text: wholeRepo ? "Add whole-repo mapping" : "Add selected mappings",
        cta: true,
        disabled: creds.length === 0 || (!isRest() && false),
        onClick: async () => {
          const cred = creds.find((c) => c.id === providerId);
          if (!providerId) { new Notice("MUGS: choose a credential/provider."); return; }
          if (cred && cred.kind !== "local" && !repoRef) { new Notice("MUGS: choose a repository."); return; }
          try {
            const scope = { includes: parseGlobList(includesText), excludes: parseGlobList(excludesText) };
            // Whole-repo mapping: id === repo.id so the driver matches it (legacy behaviour).
            if (wholeRepo) {
              this.plugin.store.upsertMapping({
                id: repoRef, label: repoKey, remotePath: "", localFolder: ".", providerId,
                branch: branch || undefined, direction, ...scope,
                syncTrashFolder: syncTrash ? undefined : false,
              });
              new Notice(`MUGS: whole-repo mapping for "${repoKey}" saved.`);
            } else if (selectedFolders.size === 0) {
              new Notice("MUGS: check at least one folder to link."); return;
            } else {
              // Each checked folder becomes its own scoped card sharing the repo's clone via repoRef.
              let count = 0;
              for (const remotePath of selectedFolders) {
                const match = matches.find((m) => m.remotePath === remotePath);
                if (!match) continue;
                this.plugin.store.upsertMapping({
                  id: newId(), label: match.label, remotePath, localFolder: match.localFolder,
                  providerId, branch: branch || undefined, direction, repoRef, ...scope,
                });
                count += 1;
              }
              new Notice(`MUGS: ${count} mapping${count === 1 ? "" : "s"} saved.`);
            }
            await this.markUnsaved();
            this._renderAll();
          } catch (e) {
            new Notice(`MUGS: could not save mapping — ${errorMessage(e)}`);
          }
        },
      },
    ]));

    void refreshRepos();
  }
  /** List child directories of `repoKey` at `path` for a credential's provider. */
  private async listDirectoriesFor(cred: Credential, repoKey: string, path: string): Promise<string[]> {
    const token = this.plugin.store.getToken(cred.id) ?? cred.token ?? "";
    if (!token) return [];
    try {
      const provider = buildProvider({ kind: cred.kind, baseUrl: cred.baseUrl, token }, { actingUsername: cred.username });
      return await provider.listDirectories(repoKey, path);
    } catch {
      return [];
    }
  }

  /** Top-level vault folders via the DataAdapter (defensive cast, like getBasePath).
   *  Tries the empty-string root first, falling back to "/", since adapter root
   *  handling varies across Obsidian builds. Dotfolders are included on purpose so
   *  users can map hidden targets like `.trash` or `.obsidian/`; the .obsidian/
   *  mapping is still gated by `assertMappingAllowed` (requires config-sync enabled). */
  private async listVaultFolders(): Promise<string[]> {
    const adapter = this.app.vault.adapter as unknown as {
      list(path: string, options?: { recursive?: boolean }): Promise<{ files?: string[]; folders?: string[] }>;
    };
    for (const root of ["", "/"]) {
      try {
        const res = await adapter.list(root, {});
        const folders = (res?.folders ?? []).filter((f) => f.length > 0);
        if (folders.length > 0) return folders.sort();
      } catch {
        // fall through to the next root attempt
      }
    }
    return [];
  }

  /** Create a full-width action row containing one or more buttons. */
  private actions(buttons: Array<{ text: string; cta?: boolean; disabled?: boolean; onClick: () => void }>): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "mugs-actions";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = b.cta ? "mod-cta" : "";
      if (b.disabled) btn.disabled = true;
      btn.textContent = b.text;
      btn.addEventListener("click", b.onClick);
      wrap.appendChild(btn);
    }
    return wrap;
  }
}
