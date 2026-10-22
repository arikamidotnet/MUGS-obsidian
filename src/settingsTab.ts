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
import type { Credential, SyncDirection, ObsidianScope, ObsidianEntryPolicy, FolderMapping } from "./types";
import type { RepoSummary } from "./providers/types";
import { buildProvider, defaultBaseUrl } from "./providers/factory";
import { INTERVAL_PRESETS, resolveIntervalSeconds, presetIdForSeconds } from "./sync/cadence";
import { effectiveObsidianEntries } from "./sync/obsidianScope";
import { categorizeObsidianEntries } from "./sync/obsidianCategories";
import { matchFolderPairs, type FolderMatch } from "./sync/folderMatch";

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

  private _renderAll(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Getting Started (startup documentation) ----------------------------
    this.gettingStarted(containerEl);

    // --- Credentials / providers -------------------------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Credentials & Providers" });
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Store per-user tokens inside this vault. Tokens are never shown in full and can be encrypted at rest.",
      });

      const creds = this.plugin.store.getDisplaySettings().credentials;
      if (creds.length === 0) {
        card.createEl("p", { cls: "mags-muted", text: "No credentials yet." });
      } else {
        for (const c of creds) {
          new Setting(card)
            .setName(`${c.label} (${c.kind})`)
            .setDesc(`token: ${maskToken(c.token)}`)
            .addButton((b) =>
              b.setButtonText("Delete").onClick(() => {
                this.plugin.store.removeCredential(c.id);
                void this.plugin.store.save();
                this._renderAll();
              }),
            );
        }
      }

      card.createEl("div", { cls: "mugs-divider" });
      this.addCredentialForm(card);
    });

    // --- Folder mappings ----------------------------------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Folder Mappings" });
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Map remote paths to vault folders for fine-grained, per-user sync.",
      });

      const mappings = this.plugin.store.getDisplaySettings().mappings;
      if (mappings.length === 0) {
        card.createEl("p", { cls: "mags-muted", text: "No mappings yet. Add one below." });
      } else {
        this.renderMappings(card, mappings);
      }

      card.createEl("div", { cls: "mugs-divider" });
      void this.addMappingForm(card);
    });

    // --- Security -----------------------------------------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Security & Credentials" });
      new Setting(card)
        .setName("Encrypt credentials at rest")
        .setDesc("When on, stored tokens are encrypted in data.json instead of saved as-is.")
        .addToggle((t) =>
          t
            .setValue(this.plugin.store.getSettings().security.encryptCredentials)
            .onChange(async (v) => {
              this.plugin.store.setSecurity({ encryptCredentials: v });
              await this.plugin.store.save();
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
              await this.plugin.store.save();
            }),
        );
    });

    // --- Automatic conflict resolution (Area 3/4) -------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Automatic Conflict Resolution" });
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
            await this.plugin.store.save();
          });
        });

      new Setting(card)
        .setName("Tie-break for unresolved hunks")
        .setDesc('When both sides edited the same lines, combine ("both") or pick a side ("ours"/"theirs").')
        .addDropdown((d) => {
          d.setValue(sync.defaultResolution).onChange(async (v) => {
            this.plugin.store.setSync({ defaultResolution: v as "both" | "theirs" | "ours" });
            await this.plugin.store.save();
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
            await this.plugin.store.save();
          });
    });
    });

    // --- Sync frequency + maintenance (Area 5/8) --------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Sync Frequency & Maintenance" });
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
            await this.plugin.store.save();
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
            await this.plugin.store.save();
            new Notice(`MUGS sync ${v ? "paused" : "resumed"}.`);
          });
        });
    });

    // --- Obsidian config sync (Area 9) ------------------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Obsidian Config Sync" });
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
            await this.plugin.store.save();
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
      cls: "mags-muted",
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

  /** Wrap children in a single grouped settings card. */
  private section(containerEl: HTMLElement, body: (card: HTMLElement) => void): void {
    // Build the card with Obsidian's native createDiv so it is guaranteed to expose
    // createEl/createDiv/etc. In Obsidian 1.14.x a raw document.createElement("div")
    // element does not reliably inherit those helpers, which left every section blank.
    const card = containerEl.createDiv({ cls: "mugs-section" });
    body(card);
    return;
  }

  /** Human-readable direction label for a mapping. */
  private directionText(d: SyncDirection): string {
    return d === "push-pull" ? "Push + pull" : d === "pull-only" ? "Pull only" : "Push only";
  }

  /** Render each stored mapping as a card with native Setting rows, collapsible
   *  include/exclude managers and (for whole-vault mappings) a .trash/ toggle. */
  private renderMappings(card: HTMLElement, mappings: FolderMapping[]): void {
    for (const m of mappings) {
      const block = card.createDiv({ cls: "mugs-mapping" });
      new Setting(block)
        .setName(m.label)
        .setDesc(`${m.remotePath || "(repo root)"} → ${m.localFolder} · ${this.directionText(m.direction)}`)
        .addButton((b) =>
          b.setButtonText("Delete").onClick(() => {
            this.plugin.store.removeMapping(m.id);
            void this.plugin.store.save();
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
            await this.plugin.store.save();
            this._renderAll();
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

      // Whole-vault mappings expose a per-mapping .trash/ toggle.
      if (m.remotePath === "" && m.localFolder === ".") {
        new Setting(block)
          .setName("Sync the repository's .trash/ folder")
          .setDesc("Shared across all users via the single git path, like Obsidian's trash. Turn off to keep deletions local to this device.")
          .addToggle((t) =>
            t.setValue(m.syncTrashFolder !== false).onChange(async (v) => {
              this.plugin.store.upsertMapping({ ...m, syncTrashFolder: v ? undefined : false });
              await this.plugin.store.save();
              this._renderAll();
            }),
          );
      }
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
    void this.plugin.store.save();
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
      void this.plugin.store.save();
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
          await this.plugin.store.save();
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
            await this.plugin.store.save();
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
    let wholeRepo = false;
    let selectedFolders = new Set<string>(); // matched remote paths the user checked to link
    let matches: FolderMatch[] = [];

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
          providerId = v;
          wholeRepo = false;
          selectedFolders.clear();
          await refreshRepos();
        });
        for (const [value, text] of creds.map((c) => [c.id, c.label] as [string, string])) {
          d.addOption(value, text);
        }
        if (creds.length === 0) d.setDisabled(true);
      });

    // --- Repository selector -------------------------------------------------
    const repoSel = card.createEl("select", { cls: "mugs-repo-select" });
    const refreshRepos = async (): Promise<void> => {
      wholeRepo = false;
      selectedFolders.clear();
      reposCache = [];
      repoRef = "";
      repoKey = "";
      if (!isRest()) {
        // Local provider has no REST adapter: it syncs one existing clone as a whole-repo mapping.
        repoSel.innerHTML = '<option value="">Local clone (single repo)</option>';
        await refreshMatches();
        return;
      }
      const cred = creds.find((c) => c.id === providerId);
      if (!cred) { repoSel.disabled = true; return; }
      try {
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
      }
    };

    // Detect top-level dotfolders (.trash/.obsidian) and compute name matches between the
    // chosen repo's remote dirs and vault folders, surfaced as checkboxes below.
    const refreshMatches = async (): Promise<void> => {
      wholeRepo = false;
      selectedFolders.clear();
      if (!isRest() || !repoKey) { matches = []; renderMatches(); return; }
      const cred = creds.find((c) => c.id === providerId);
      if (!cred) { matches = []; renderMatches(); return; }
      try {
        const detectedDirs = await this.listDirectoriesFor(cred, repoKey, "");
        const vaultTop = await this.listVaultFolders();
        matches = matchFolderPairs(detectedDirs, vaultTop);
      } catch (e) {
        matches = [];
      }
      renderMatches();
    };

    repoSel.addEventListener("change", () => {
      const chosen = reposCache.find((r) => r.id === repoSel.value);
      if (!chosen) return;
      wholeRepo = false;
      selectedFolders.clear();
      repoRef = chosen.id;
      repoKey = chosen.pathWithNamespace;
      void refreshMatches();
    });

    // --- Matched-folder checkboxes + whole-repo toggle -----------------------
    const matchesEl = card.createDiv({ cls: "mugs-matches" });
    const renderMatches = (): void => {
      matchesEl.innerHTML = "";

      if (isRest() && repoKey) {
        // Whole-repo toggle: map the entire repository root to the vault root ('.').
        const wholeRow = matchesEl.createDiv({ cls: "mugs-match-whole" });
        const wholeInput = document.createElement("input");
        wholeInput.type = "checkbox";
        wholeInput.checked = wholeRepo;
        wholeInput.addEventListener("change", (e: Event) => { wholeRepo = (e.target as HTMLInputElement).checked; renderMatches(); });
        wholeRow.appendChild(wholeInput);
        wholeRow.appendChild(document.createTextNode(" Sync the entire repository to the vault root"));
      }

      if (matches.length > 0) {
        const head = matchesEl.createEl("div", { cls: "mugs-matches-head" });
        head.textContent = wholeRepo ? "Or link individual folders:" : "Matched folders — check to link each as its own mapping";
        for (const m of matches) {
          const row = matchesEl.createDiv({ cls: "mugs-match-row" });
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = selectedFolders.has(m.remotePath);
          cb.addEventListener("change", (e: Event) => {
            if ((e.target as HTMLInputElement).checked) selectedFolders.add(m.remotePath);
            else selectedFolders.delete(m.remotePath);
          });
          row.appendChild(cb);
          row.appendChild(document.createTextNode(`  ${m.remotePath} → ${m.localFolder}`));
          matchesEl.appendChild(row);
        }
      } else if (!wholeRepo) {
        matchesEl.createEl("p", { cls: "mags-muted", text: wholeRepo ? "" : "No folders matched between this repo and your vault yet." });
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
            await this.plugin.store.save();
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
