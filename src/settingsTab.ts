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
    addSelect(callback: (component: MugsSelectComponent) => void): this;
    addField(label: string, input: HTMLElement): this;
  }
}

/** Minimal chainable select-builder shape matching Obsidian's SelectComponent. */
interface MugsSelectComponent {
  addOption(value: string, displayText?: string): MugsSelectComponent;
  setValue(value: unknown): MugsSelectComponent;
  onChange(cb: (value: string) => void | Promise<void>): MugsSelectComponent;
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
                this.display();
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

    // --- Automatic conflict resolution (Area 2) ---------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Automatic Conflict Resolution" });
      card.createEl("p", {
        cls: "mugs-desc",
        text: "How MUGS resolves divergent files automatically. Every choice is reversible via git history and the .mugs-trash.",
      });

      const sync = this.plugin.store.getSettings().sync;
      new Setting(card)
        .setName("Auto-merge clean divergences")
        .setDesc("3-way merge every divergence and apply results without prompting.")
        .addToggle((t) =>
          t.setValue(sync.autoMerge).onChange(async (v) => {
            this.plugin.store.setSync({ autoMerge: v });
            await this.plugin.store.save();
          }),
        );

      new Setting(card)
        .setName("Tie-break for unresolved hunks")
        .setDesc('When both sides edited the same lines, combine ("both") or pick a side ("ours"/"theirs").')
        .addField(
          "",
          this.selectOption(
            (v) => {
              this.plugin.store.setSync({ defaultResolution: v as "both" | "theirs" | "ours" });
              void this.plugin.store.save();
            },
            [["both", "Both"], ["theirs", "Theirs"], ["ours", "Ours"]],
          ),
        );

      new Setting(card)
        .setName("Auto-accept identical changes")
        .setDesc("When both sides made the same change, resolve automatically (jj same-change rule).")
        .addToggle((t) =>
          t.setValue(sync.sameChangeAccept).onChange(async (v) => {
            this.plugin.store.setSync({ sameChangeAccept: v });
            await this.plugin.store.save();
          }),
        );

      new Setting(card)
        .setName("Resolve by most recent save")
        .setDesc("For a genuine conflict where both sides carry timestamps, keep the more-recently-saved side; otherwise fall back to the tie-break above.")
        .addToggle((t) =>
          t.setValue(sync.recencyWins).onChange(async (v) => {
            this.plugin.store.setSync({ recencyWins: v });
            await this.plugin.store.save();
          }),
        );
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
        .setDesc("How often to check the remote when the vault is idle. Local edits still propagate immediately via event triggers.")
        .addField(
          "",
          this.selectOption(
            (v) => {
              this.plugin.store.setSync({ intervalSeconds: resolveIntervalSeconds(v) });
              void this.plugin.store.save();
            },
            INTERVAL_PRESETS.map((p) => [p.id, p.label]) as Array<[string, string]>,
          ),
        );

      new Setting(card)
        .setName("Pause vault sync")
        .setDesc("While paused, MUGS stops all automatic push/pull and event triggers. Use it to make bulk edits safely; resuming runs one catch-up pass.")
        .addToggle((t) =>
          t
            .setValue(sync.paused)
            .onChange(async (v) => {
              this.plugin.store.setSync({ paused: v });
              await this.plugin.store.save();
              new Notice(`MUGS sync ${v ? "paused" : "resumed"}.`);
            }),
        );
    });

    // --- Obsidian config sync (Area 9) ------------------------------------
    this.section(containerEl, (card) => {
      card.createEl("h3", { text: "Obsidian Config Sync" });
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Share vault-wide .obsidian/ config (themes, snippets, templates) across your team while keeping user-specific state local.",
      });

      const obs = this.plugin.store.getSettings().sync.obsidianConfig;
      new Setting(card)
        .setName("Sync .obsidian/ configuration")
        .setDesc("When on, vault-wide entries are shared and personal entries stay local (excluded from push/pull). Off means .obsidian/ is never synced.")
        .addToggle((t) =>
          t
            .setValue(obs.enabled)
            .onChange(async (v) => {
              this.plugin.store.setObsidianConfigEnabled(v);
              await this.plugin.store.save();
              new Notice(`MUGS .obsidian/ sync ${v ? "enabled" : "disabled"}.`);
              this.display();
            }),
        );

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
            this.display();
          }),
        );

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
              this.display();
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

  /** Add-credential form as native Setting rows. */
  private addCredentialForm(card: HTMLElement): void {
    let kind: Credential["kind"] = "gitlab";
    let label = "";
    let username = "";
    let token = "";
    let baseUrl = "";
    let repos: string[] = [];
    let baseUrlInput: HTMLInputElement | null = null;

    const setBaseUrlField = (value: string): void => {
      baseUrl = value;
      if (baseUrlInput) (baseUrlInput as HTMLInputElement).value = value;
    };
    const prefilledBaseUrl = (k: Credential["kind"]): string =>
      k === "local" ? "" : defaultBaseUrl(k);

    new Setting(card).setName("Provider").setDesc("The backend this token authenticates against.").addField(
      "",
      this.selectOption((v) => {
        kind = v as Credential["kind"];
        setBaseUrlField(prefilledBaseUrl(kind));
      }, [
        ["gitlab", "GitLab"],
        ["github", "GitHub"],
        ["bitbucket", "Bitbucket"],
        ["gitea", "Gitea / Forgejo"],
        ["local", "Local (existing clone)"],
      ]),
    );
    new Setting(card).setName("Label").setDesc("A friendly name for this credential.").addField("", this.text((v) => { label = v.trim(); }, "Label"));
    new Setting(card).setName("Username").setDesc("Optional username (GitLab shows the acting user.").addField("", this.text((v) => { username = v.trim(); }, "Username (optional)"));
    new Setting(card).setName("Token").setDesc("Your API token. Never shown in full; optionally encrypted at rest.").addField("", this.password((v) => { token = v; }, "Token"));
    const baseUrlInputEl = this.text((v) => { baseUrl = v.trim(); }, "Base URL (optional, incl. /api/v4)");
    baseUrlInput = baseUrlInputEl;
    new Setting(card).setName("Base URL").setDesc("Self-hosted instance base URL (include /api/v4 if needed.").addField("", baseUrlInputEl);

    card.appendChild(this.scopeTextareaField(
      "Allowed repositories (optional, owner/repo per line)",
      (v) => { repos = parseGlobList(v); },
    ));

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
            this.display();
          } catch (e) {
            new Notice(`MUGS: could not save credential — ${errorMessage(e)}`);
          }
        },
      },
    ]));
  }

  /**
   * Add-mapping form as native Setting rows. REST providers enumerate repos and each
   * repo's directory tree, so "Repository", "Remote path" and "Vault folder" are
   * dropdowns (autofill). Selecting a repository stores its id as the mapping id —
   * that is how the driver matches the mapping to a repo at sync time. After a repo
   * is selected, exact-name matches between remote and vault folders surface as
   * one-click chips, and whole-vault mode reveals .trash/.obsidian dotfolder options.
   */
  private async addMappingForm(card: HTMLElement): Promise<void> {
    const creds = this.plugin.store.getSettings().credentials;
    let label = "";
    let remotePath = "";
    let localFolder = "";
    let providerId = creds[0]?.id ?? "";
    let branch = "";
    let direction: SyncDirection = "push-pull";
    let includesText = "";
    let excludesText = "";
    // REST repo selection: repoSaveId (repo.id) is stored as the mapping id so the
    // driver can match it; repoKey (pathWithNamespace) is what lists directories.
    let repoSaveId = "";
    let repoKey = "";
    let reposCache: RepoSummary[] = [];
    let wholeVault = false;
    let trashSync = true;
    let detectedDirs: string[] = [];
    let matches: FolderMatch[] = [];

    // Progressive-disclosure area: .trash toggle + auto-match chips.
    const suggestionsEl = card.createDiv({ cls: "mugs-suggestions" });

    // --- Native Setting rows -------------------------------------------------
    const providerSel = this.selectOption((v) => {
      providerId = v;
      void refreshMappingDropdowns();
    }, creds.map((c) => [c.id, c.label] as [string, string]), creds.length === 0);
    new Setting(card).setName("Provider").setDesc("The backend this mapping syncs against.").addField("", providerSel);

    const repoSel = document.createElement("select");
    repoSel.className = "mugs-dir-select";
    const addRepoOption = (value: string, text: string): void => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      repoSel.appendChild(opt);
    };
    new Setting(card).setName("Repository").setDesc("The repository to sync from.").addField("", repoSel);

    const remotePathSel = this.directorySelect(async (v) => {
      remotePath = v;
      await refreshRemoteDirs();
    });
    new Setting(card).setName("Remote path").setDesc("A folder inside the repository ('' for the whole repo.).").addField("", remotePathSel);

    const vaultFolderSel = this.directorySelect((v) => { localFolder = v; });
    new Setting(card).setName("Vault folder").setDesc("The vault folder to sync into.").addField("", vaultFolderSel);

    new Setting(card).setName("Direction").setDesc("Which way changes flow.").addField(
      "",
      this.selectOption((v) => { direction = v as SyncDirection; }, [
        ["push-pull", "Push + pull"],
        ["pull-only", "Pull only"],
        ["push-only", "Push only"],
      ]),
    );
    new Setting(card).setName("Branch").setDesc("Optional branch to sync (defaults to the remote default branch.).").addField("", this.text((v) => { branch = v.trim(); }, "Branch (optional)"));

    new Setting(card).setName("Sync entire repository").setDesc("Map the whole repo root to the vault root ('.'). Dotfolder options (.trash/.obsidian) appear below.").addToggle((t) =>
      t.setValue(wholeVault).onChange(async (v) => {
        wholeVault = v;
        repoSel.disabled = v;
        remotePathSel.disabled = v;
        vaultFolderSel.disabled = v;
        if (v) localFolder = ".";
        await refreshSuggestions();
      }),
    );

    // Append the suggestions area after the core fields.
    card.appendChild(suggestionsEl);

    // Includes / Excludes — collapsible manage panels.
    card.appendChild(this.managePanel("Includes", includesText, (v) => { includesText = v; }, "Only these globs sync within the scope (optional). Leave empty for everything."));
    card.appendChild(this.managePanel("Excludes", excludesText, (v) => { excludesText = v; }, "These globs never sync (gitignore-style; '!' re-includes)."));

    // --- Dropdown population + suggestion refresh ---------------------------
    const isRest = (): boolean => {
      const cred = creds.find((c) => c.id === providerId);
      return !!cred && cred.kind !== "local";
    };
    const refreshMappingDropdowns = async (): Promise<void> => {
      reposCache = [];
      repoSaveId = "";
      repoKey = "";
      remotePath = "";
      if (!isRest()) {
        // Local: single implicit clone, no REST tree API.
        repoSel.disabled = true;
        remotePathSel.disabled = true;
        repoSel.innerHTML = '<option value="">Local clone (single repo)</option>';
        remotePathSel.innerHTML = '<option value="">(whole clone)</option>';
        await this.populateVaultFolders(vaultFolderSel, localFolder);
        void refreshSuggestions();
        return;
      }
      const cred = creds.find((c) => c.id === providerId);
      if (!cred) { repoSel.disabled = true; remotePathSel.disabled = true; return; }
      // Populate vault folders up front so they show even if the repo fetch fails.
      await this.populateVaultFolders(vaultFolderSel, localFolder);
      try {
        const token = this.plugin.store.getToken(providerId) ?? "";
        if (!token) { new Notice("MUGS: enter a token for this credential."); repoSel.disabled = true; remotePathSel.disabled = true; return; }
        const provider = buildProvider({ kind: cred.kind, baseUrl: cred.baseUrl, token, allowedRepos: cred.repos }, { actingUsername: cred.username });
        reposCache = await provider.listRepos();
        if (reposCache.length === 0) {
          new Notice("MUGS: no accessible repositories for this credential.");
          repoSel.disabled = true;
          remotePathSel.disabled = true;
          return;
        }
        repoSel.disabled = false;
        remotePathSel.disabled = false;
        reposCache.sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace));
        repoSel.innerHTML = "";
        for (const r of reposCache) {
          const name = r.name && r.name !== r.pathWithNamespace ? `  ·  ${r.name}` : "";
          addRepoOption(r.id, `${r.pathWithNamespace}${name}`);
        }
        // Auto-select the first repo so directory autofill is ready immediately.
        const first = reposCache[0];
        repoSaveId = first.id;
        repoKey = first.pathWithNamespace;
        repoSel.value = first.id;
        await refreshRemoteDirs();
        void refreshSuggestions();
      } catch (e) {
        new Notice(`MUGS: could not list repositories — ${errorMessage(e)}`);
        repoSel.disabled = true;
        remotePathSel.disabled = true;
      }
    };
    const refreshRemoteDirs = async (): Promise<void> => {
      if (!repoKey) return;
      const cred = creds.find((c) => c.id === providerId);
      if (!cred) return;
      const dirs = await this.listDirectoriesFor(cred, repoKey, remotePath);
      const opts: Array<[string, string]> = [];
      if (remotePath) opts.push([remotePath, `● ${remotePath.split("/").pop()}`]);
      for (const d of dirs) opts.push([`${remotePath ? `${remotePath}/` : ""}${d}`, d]);
      this.fillDirectorySelect(remotePathSel, remotePath, opts, remotePath ? "← repository root" : "(repository root)");
    };
    // Detect top-level dotfolders (.trash/.obsidian) and compute name matches in the
    // chosen repo to surface in-context toggles/chips (progressive disclosure).
    const refreshSuggestions = async (): Promise<void> => {
      if (!isRest() || !repoKey) { detectedDirs = []; matches = []; renderSuggestions(); return; }
      const cred = creds.find((c) => c.id === providerId);
      if (!cred) { detectedDirs = []; matches = []; renderSuggestions(); return; }
      detectedDirs = await this.listDirectoriesFor(cred, repoKey, "");
      const vaultTop = await this.listVaultFolders();
      matches = matchFolderPairs(detectedDirs, vaultTop);
      renderSuggestions();
    };
    const renderSuggestions = (): void => {
      suggestionsEl.innerHTML = "";
      // .trash toggle (whole-vault + REST repo) — mirrors Obsidian Sync dotfolder UX.
      if (wholeVault && isRest() && repoKey) {
        const trashPresent = detectedDirs.includes(".trash");
        const obsidianPresent = detectedDirs.includes(".obsidian");
        const box = suggestionsEl.createDiv({ cls: "mugs-dotfolders" });
        if (trashPresent) {
          const row = document.createElement("label");
          row.className = "mugs-dotfolder-toggle";
          const tInput = document.createElement("input");
          tInput.type = "checkbox";
          tInput.checked = trashSync;
          tInput.addEventListener("change", (e: Event) => { trashSync = (e.target as HTMLInputElement).checked; });
          row.appendChild(tInput);
          row.appendChild(document.createTextNode(" Sync the repository's .trash/ folder"));
          box.appendChild(row);
        }
        const p = box.createEl("p", { cls: "mags-muted" });
        if (obsidianPresent) p.textContent = "This repo has an .obsidian/ folder — configure which settings to share in the 'Obsidian Config Sync' section below.";
        else if (!trashPresent) p.textContent = "No .trash/ or .obsidian/ folder found in this repo.";
      }
      // Auto-match chips.
      if (matches.length > 0) {
        const head = suggestionsEl.createEl("div", { cls: "mugs-suggestions-head" });
        head.textContent = "Matched folders — click to map";
        for (const m of matches) {
          const chip = suggestionsEl.createEl("button", { cls: "mugs-match-chip", type: "button" });
          chip.textContent = `${m.remotePath} → ${m.localFolder}`;
          chip.addEventListener("click", () => {
            label = m.label;
            remotePath = m.remotePath;
            localFolder = m.localFolder;
            direction = "push-pull";
            vaultFolderSel.value = m.localFolder;
            if (wholeVault) {
              remotePathSel.value = "";
            } else {
for (const opt of Array.from(remotePathSel.options)) {
                if (opt.value === m.remotePath) { remotePathSel.value = m.remotePath; break; }
              }
            }
          });
        }
      }
    };

    repoSel.addEventListener("change", (e: Event) => {
      const chosen = reposCache.find((r) => r.id === (e.target as HTMLSelectElement).value);
      if (!chosen) return;
      repoSaveId = chosen.id;
      repoKey = chosen.pathWithNamespace;
      remotePath = "";
      void refreshRemoteDirs();
      void refreshSuggestions();
    });

    card.appendChild(this.actions([
      {
        text: "Add mapping",
        cta: true,
        disabled: creds.length === 0,
        onClick: async () => {
          if (!label) { new Notice("MUGS: enter a label."); return; }
          if (!wholeVault && !localFolder) { new Notice("MUGS: enter a vault folder."); return; }
          if (!providerId) { new Notice("MUGS: choose a credential/provider."); return; }
          const cred = creds.find((c) => c.id === providerId);
          if (cred && cred.kind !== "local" && !repoSaveId) { new Notice("MUGS: choose a repository."); return; }
          try {
            this.plugin.store.upsertMapping({
              id: repoSaveId || newId(),
              label,
              remotePath: wholeVault ? "" : remotePath,
              localFolder: wholeVault ? "." : localFolder,
              providerId,
              branch: branch || undefined,
              direction,
              includes: parseGlobList(includesText),
              excludes: parseGlobList(excludesText),
              syncTrashFolder: wholeVault && !trashSync ? false : undefined,
            });
            await this.plugin.store.save();
            new Notice(`MUGS: mapping "${label}" saved.`);
            this.display();
          } catch (e) {
            // upsertMapping throws for folders under .obsidian/.
            new Notice(`MUGS: could not save mapping — ${errorMessage(e)}`);
          }
        },
      },
    ]));

    void refreshMappingDropdowns();
  }

  /** Create a native <select> wired to an onChange callback. */
  private selectOption(
    set: (v: string) => void,
    options: Array<[string, string]>,
    disabled = false,
  ): HTMLSelectElement {
    const sel = document.createElement("select");
    if (disabled) sel.disabled = true;
    for (const [value, label] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", (e: Event) => set((e.target as HTMLSelectElement).value));
    return sel;
  }

  /** An empty directory <select> wired to an optional async onChange. */
  private directorySelect(onChange?: (v: string) => void | Promise<void>): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.className = "mugs-dir-select";
    if (onChange) {
      sel.addEventListener("change", (e: Event) => { void onChange((e.target as HTMLSelectElement).value); });
    }
    return sel;
  }

  /** Populate a directory <select> with a root option plus child options, keeping
   *  the current selection when it is still among the children. */
  private fillDirectorySelect(sel: HTMLSelectElement, current: string, options: Array<[string, string]>, rootLabel?: string): void {
    const prev = sel.value;
    sel.innerHTML = "";
    const root = document.createElement("option");
    root.value = "";
    root.textContent = rootLabel ?? (current ? "← repository root" : "(repository root)");
    sel.appendChild(root);
    for (const [value, label] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    if (options.some((o) => o[0] === prev)) sel.value = prev;
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

  /** Fill a vault-folder dropdown from existing top-level vault folders. */
  private async populateVaultFolders(sel: HTMLSelectElement, current: string): Promise<void> {
    const folders = await this.listVaultFolders();
    this.fillDirectorySelect(sel, current, folders.map((f) => [f, f]), folders.length ? "(a vault folder)" : "(create a folder in Obsidian first)");
  }

  /** Create a native text <input> wired to an onChange callback. */
  private text(onChange: (v: string) => void, placeholder = ""): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.addEventListener("change", (e: Event) => onChange((e.target as HTMLInputElement).value));
    return input;
  }

  /** Create a native password <input> wired to an onChange callback. */
  private password(onChange: (v: string) => void, placeholder = ""): HTMLInputElement {
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = placeholder;
    input.addEventListener("change", (e: Event) => onChange((e.target as HTMLInputElement).value));
    return input;
  }

  /** A full-width labeled textarea for multi-line gitignore glob lists. */
  private scopeTextareaField(label: string, onChange: (v: string) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "mugs-field";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    wrap.appendChild(lbl);
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.style.width = "100%";
    ta.className = "mugs-textarea";
    ta.addEventListener("change", (e: Event) => onChange((e.target as HTMLTextAreaElement).value));
    wrap.appendChild(ta);
    return wrap;
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
