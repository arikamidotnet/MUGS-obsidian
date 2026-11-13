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
import type { Credential, SyncDirection, ObsidianScope, ObsidianEntryPolicy, FolderMapping, SyncStatus, MugsSettings } from "./types";
import type { KdfParams } from "./schema";
import type { RepoSummary } from "./providers/types";
import { buildProvider, defaultBaseUrl } from "./providers/factory";
import { INTERVAL_PRESETS, resolveIntervalSeconds, presetIdForSeconds } from "./sync/cadence";
import { effectiveObsidianEntries } from "./sync/obsidianScope";
import { categorizeObsidianEntries } from "./sync/obsidianCategories";
import { matchFolderPairs, matchFolderPairsFuzzy, type FolderMatch } from "./sync/folderMatch";
import { SettingsDraft, type SettingsDraftTarget } from "./runtime/settingsDraft";
import { directionLabel } from "./ui/labels";

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

  /** U04 draft/Apply model: edits accumulate in a DRAFT — the live store (and
   *  therefore the scheduler/sync engine) sees NOTHING until Apply succeeds.
   *  Created lazily on first render; Cancel discards; Apply validates the whole
   *  draft, commits through the store's setter API and persists ONCE. */
  private draft: SettingsDraft | null = null;

  /** True when the draft holds changes not yet applied (drives the banner). */
  private unsavedChanges = false;

  /** Reused single instance of the top-of-pane unsaved-changes banner. Kept as a
   *  persistent element rather than rebuilt each render so toggling it never
   *  rebuilds text inputs and steals focus/caret position. */
  private unsavedBannerEl: HTMLElement | null = null;

  /** The settings snapshot edits render from and mutate: the DRAFT (never the live store). */
  private view(): MugsSettings {
    if (!this.draft) this.draft = new SettingsDraft(this.plugin.store.getSettings());
    return this.draft.view();
  }

  /** Apply an edit to the draft and flag the unsaved banner. */
  private edit(mutate: (d: SettingsDraft) => void): void {
    if (!this.draft) this.draft = new SettingsDraft(this.plugin.store.getSettings());
    mutate(this.draft);
    this.markUnsaved();
  }

  /** Create the single unsaved-changes banner if it does not yet exist. */
  private ensureUnsavedBanner(): void {
    if (this.unsavedBannerEl) return;
    const el = this.containerEl.createDiv({ cls: "mugs-unsaved-banner" });
    el.style.display = "none"; // hidden until there are unsaved changes
    el.createEl("span", { cls: "mugs-unsaved-note", text: "Unsaved settings" });
    const applyBtn = el.createEl("button", { cls: "mugs-unsaved-apply", text: "Apply settings" });
    applyBtn.addEventListener("click", () => void this.applySettings());
    const cancelBtn = el.createEl("button", { cls: "mugs-unsaved-cancel", text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.cancelSettings());
    this.unsavedBannerEl = el;
  }

  /** Flag that a draft edit exists so it is not activated until the user applies.
   *  Toggles only the banner's visibility (no full re-render) so text inputs keep
   *  focus and caret position. */
  private markUnsaved(): void {
    this.unsavedChanges = true;
    if (!this.unsavedBannerEl) this.ensureUnsavedBanner();
    if (this.unsavedBannerEl) this.unsavedBannerEl.style.display = "";
  }

  /** U04 Apply: validate the COMPLETE draft, then commit + persist ONCE.
   *  Validation problems are listed and NOTHING is activated. A refused/failed
   *  save rolls the store back to the pre-apply state (active settings intact)
   *  and the banner stays so the user can retry or cancel. */
  private async applySettings(): Promise<void> {
    if (!this.draft) return;
    const target: SettingsDraftTarget = {
      getSettings: () => this.plugin.store.getSettings(),
      upsertCredential: (c) => this.plugin.store.upsertCredential(c),
      removeCredential: (id) => this.plugin.store.removeCredential(id),
      upsertMapping: (m) => this.plugin.store.upsertMapping(m),
      removeMapping: (id) => this.plugin.store.removeMapping(id),
      setSecurity: (p) => this.plugin.store.setSecurity(p),
      setSync: (p) => this.plugin.store.setSync(p),
      setObsidianConfig: (c) => this.plugin.store.setObsidianConfig(c),
      save: async () => (await this.plugin.store.save()) ?? { ok: true },
    };
    const outcome = await this.draft.commit(target);
    if (outcome.kind === "invalid") {
      new Notice(`MUGS: settings not applied — fix these first:\n· ${outcome.problems.slice(0, 5).join("\n· ")}${outcome.problems.length > 5 ? `\n… and ${outcome.problems.length - 5} more` : ""}`, 10000);
      return;
    }
    if (outcome.kind === "save-failed") {
      // Active settings were rolled back — say so; the banner stays for a retry.
      new Notice(`MUGS: could not save settings (${outcome.result.reason}) — your edits are kept in this pane but the previous settings remain active. Try Apply again or Cancel.`, 10000);
      return;
    }
    this.draft = null;
    this.unsavedChanges = false;
    if (this.unsavedBannerEl) { this.unsavedBannerEl.remove(); this.unsavedBannerEl = null; }
    new Notice("MUGS: settings saved and now active.");
    this._renderAll();
  }

  /** U04 Cancel: discard the draft entirely — active settings never changed. */
  private cancelSettings(): void {
    this.draft = null;
    this.unsavedChanges = false;
    if (this.unsavedBannerEl) { this.unsavedBannerEl.remove(); this.unsavedBannerEl = null; }
    new Notice("MUGS: changes discarded — active settings unchanged.");
    this._renderAll();
  }

  hide(): void {
    // Draft model: leaving the tab with an unapplied draft is the moment a
    // teammate loses work — say so instead of letting the changes silently expire.
    if (this.unsavedChanges) {
      new Notice("MUGS: settings changed but not applied — reopen MUGS settings and click Apply (or Cancel) to finish.", 6000);
    }
  }

  private _renderAll(): void {
    const { containerEl } = this;
    // Reuse a single unsaved-changes banner across renders so toggling it never
    // rebuilds text inputs (which would steal focus). Insert at the top after empty().
    containerEl.empty();
    containerEl.classList.add("mugs-settings");
    if (this.unsavedBannerEl) containerEl.appendChild(this.unsavedBannerEl);

    // --- Getting Started (startup documentation) ----------------------------
    this.gettingStarted(containerEl);

    this.section(containerEl, "Connected folders", (card) => {
      card.createEl("p", { cls: "mugs-desc", text: "Manage the folders connected to this vault." });
      const mappings = this.view().mappings;
      if (mappings.length) this.renderMappings(card, mappings);
      else card.createEl("p", { cls: "mugs-muted", text: "No folders connected." });
      const add = card.createEl("details", { cls: "mugs-settings-add" });
      add.open = mappings.length === 0;
      add.createEl("summary", { text: "Connect another folder" });
      void this.addMappingForm(add.createDiv({ cls: "mugs-settings-form" }));
    });

    // --- Credentials / providers -------------------------------------------
    this.section(containerEl, "Accounts", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Connect your Git account. Tokens stay in this vault and can be encrypted.",
      });

      // Draft view: tokens are masked HERE at render time only (the draft carries
      // the real values so Apply can commit them; nothing raw is ever shown).
      const creds = this.view().credentials;
      if (creds.length === 0) {
        card.createEl("p", { cls: "mugs-muted", text: "No accounts connected." });
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
                this.edit((d) => d.removeCredential(c.id));
                this._renderAll();
              }),
            );
        }
      }

      const add = card.createEl("details", { cls: "mugs-settings-add" });
      add.open = creds.length === 0;
      add.createEl("summary", { text: "Add another account" });
      this.addCredentialForm(add.createDiv({ cls: "mugs-settings-form" }));
    });

    // --- Security -----------------------------------------------------------
    this.section(containerEl, "Security", (card) => {
      // The hand-written MugsSettings.security in types.ts does not carry `kdf` yet
      // (schema.ts is the source of truth) — widen here for the render path.
      const sec = this.view().security as MugsSettings["security"] & { kdf?: KdfParams };

      new Setting(card)
        .setName("Encrypt saved tokens")
        .setDesc("Protect tokens in data.json with a passphrase. Set a passphrase below before enabling.")
        .addToggle((t) =>
          t
            .setValue(sec.encryptCredentials)
            .onChange(async (v) => {
              if (!v && sec.encryptCredentials) {
                // Disabling encryption is a STORE transaction (decrypt-all): run it
                // now and surface per-credential failures — never save a half-
                // disabled state (contract §10). If it fails, encryption stays on.
                const disable = (this.plugin.store as unknown as { disableEncryption?: () => Promise<{ ok: boolean; failures: string[] }> }).disableEncryption;
                if (typeof disable === "function") {
                  const res = await disable.call(this.plugin.store);
                  if (!res.ok) {
                    const labels = res.failures.map((id) => this.view().credentials.find((c) => c.id === id)?.label ?? id);
                    new Notice(`MUGS: could not disable encryption — these credentials could not be decrypted this session: ${labels.join(", ")}. Unlock first, then try again; nothing was changed.`, 10000);
                    this._renderAll();
                    return;
                  }
                }
              }
              this.edit((d) => d.setSecurity({ encryptCredentials: v }));
              // The claim must not fire before the save: data.json still holds the
              // previous state until Apply.
              new Notice(`MUGS credentials will be ${v ? "encrypted" : "stored as-is"} once you Apply settings.`);
            }),
        );

      card.createEl("p", {
        cls: "mugs-desc",
        text:
          "MUGS never saves your passphrase. Unlock once per session. If you forget it, you'll need to enter your account tokens again.",
      });

      if (this.plugin.store.isLocked()) {
        // Locked: passphrase-encrypted tokens are unreadable until unlocked.
        let passphrase = "";
        new Setting(card)
          .setName("Tokens locked")
          .setDesc(
            "Enter your passphrase to enable sync for this session. An incorrect passphrase won't change your saved tokens.",
          )
          .addText((txt) => {
            txt.setPlaceholder("Passphrase");
            txt.inputEl.type = "password";
            txt.onChange((v) => { passphrase = v; });
          })
          .addButton((b) =>
            b.setButtonText("Unlock").setCta().onClick(async () => {
              if (!passphrase) { new Notice("MUGS: enter your passphrase to unlock."); return; }
              const ok = await this.plugin.store.unlock(passphrase);
              passphrase = "";
              new Notice(
                ok
                  ? "MUGS: credentials unlocked for this session."
                  : "MUGS: that passphrase did not match — tokens stay locked, nothing was changed.",
                6000,
              );
              this._renderAll();
            }),
          );
      } else {
        const hasKdf = !!sec.kdf;
        let passphrase = "";
        new Setting(card)
          .setName(hasKdf ? "Change encryption passphrase" : "Encryption passphrase")
          .setDesc(
            hasKdf
              ? "Re-encrypts every stored token under a new passphrase. The passphrase is not stored and cannot be recovered."
              : "Sets the passphrase that encrypts your tokens in data.json. The passphrase is not stored and cannot be recovered — if you forget it, encrypted tokens cannot be decrypted.",
          )
          .addText((txt) => {
            txt.setPlaceholder(hasKdf ? "New passphrase" : "Passphrase");
            txt.inputEl.type = "password";
            txt.onChange((v) => { passphrase = v; });
          })
          .addButton((b) =>
            b.setButtonText(hasKdf ? "Change passphrase" : "Set passphrase").setCta().onClick(async () => {
              if (!passphrase) { new Notice("MUGS: enter a passphrase first."); return; }
              try {
                await this.plugin.store.setEncryptionPassphrase(passphrase);
                passphrase = "";
                await this.markUnsaved();
                new Notice(
                  "MUGS: tokens re-encrypted — Apply settings to persist. The passphrase is not stored and cannot be recovered.",
                  8000,
                );
                this._renderAll();
              } catch (e) {
                new Notice(`MUGS: could not set the passphrase — ${errorMessage(e)}`, 8000);
              }
            }),
          );
      }
    });

    // --- Automatic conflict resolution (Area 3/4) -------------------------
    this.section(containerEl, "Conflicts", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Separate edits can combine automatically. If the same lines change in both places, you choose what to keep.",
      });

      const sync = this.view().sync;
      new Setting(card)
        .setName("Combine non-conflicting edits")
        .setDesc("Combine edits to different lines. Conflicting edits always need your review.")
        .addToggle((t) => {
          t.setValue(sync.autoMerge).onChange(async (v) => {
            this.edit((d) => d.setSync({ autoMerge: v }));
          });
        });

      new Setting(card)
        .setName("Preferred conflict choice")
        .setDesc("A preference only. MUGS won't choose for you.")
        .addDropdown((d) => {
          d.setValue(sync.defaultResolution).onChange(async (v) => {
            this.edit((d) => d.setSync({ defaultResolution: v as "both" | "theirs" | "ours" }));
          });
          for (const [value, text] of [["both", "Both versions"], ["theirs", "Repository"], ["ours", "This device"]]) {
            d.addOption(value, text);
          }
        });

      new Setting(card)
        .setName("Prefer newer edits")
        .setDesc("A preference only. Conflicting edits still need your review.")
        .addToggle((t) => {
          t.setValue(sync.recencyWins).onChange(async (v) => {
            this.edit((d) => d.setSync({ recencyWins: v }));
          });
    });
    });

    // --- Sync frequency + maintenance (Area 5/8) --------------------------
    this.section(containerEl, "Sync", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Choose when to check for changes, or pause automatic sync.",
      });

      const sync = this.view().sync;
      new Setting(card)
        .setName("Check for changes")
        .addDropdown((d) => {
          d.setValue(presetIdForSeconds(sync.intervalSeconds)).onChange(async (v) => {
            this.edit((d2) => d2.setSync({ intervalSeconds: resolveIntervalSeconds(v) }));
          });
          for (const [value, text] of INTERVAL_PRESETS.map((p) => [p.id, p.label]) as Array<[string, string]>) {
            d.addOption(value, text);
          }
        });

      new Setting(card)
        .setName("Pause automatic sync")
        .setDesc("Stop scheduled sync and file-change triggers. Apply to activate. Sync now remains available; resuming checks on the next timer tick.")
        .addToggle((t) => {
          t.setValue(sync.paused).onChange(async (v) => {
            this.edit((d2) => d2.setSync({ paused: v }));
            new Notice(`MUGS sync will be ${v ? "paused" : "resumed"} once you Apply settings.`);
          });
    });

      new Setting(card)
        .setName("Start new connections with")
        .setDesc(
          "Download starts with repository files. Upload starts with this device's files. Back up both copies before the first sync.",
        )
        .addDropdown((d) => {
          d.setValue(sync.firstSyncDirection).onChange(async (v) => {
            this.edit((d2) => d2.setSync({ firstSyncDirection: v as "pull" | "push" }));
          });
          d.addOption("pull", "Download from repository (default)");
          d.addOption("push", "Upload from this device");
        });

      // Whole-vault mappings expose a per-mapping .trash/ toggle (draft view).
      const mappings = this.view().mappings;
      for (const m of mappings) {
        if (m.remotePath === "" && m.localFolder === ".") {
          new Setting(card)
            .setName("Sync the repository's .trash/ folder")
            .setDesc("Share files in .trash with other users. Turning this off excludes that folder; it does not disable deletion sync elsewhere.")
            .addToggle((t) =>
              t.setValue(m.syncTrashFolder !== false).onChange(async (v) => {
                this.edit((d2) => d2.upsertMapping({ ...m, syncTrashFolder: v ? undefined : false }));
              }),
            );
        }
      }
    });

    // --- Obsidian config sync (Area 9) ------------------------------------
    this.section(containerEl, "Obsidian settings", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Share selected Obsidian settings files with your team through the same sync system.",
      });

      const obs = this.view().sync.obsidianConfig;
      new Setting(card)
        .setName("Sync selected settings")
        .setDesc("When on, selected .obsidian/ files are synced alongside your vault folders.")
        .addToggle((t) => {
          t.setValue(obs.enabled).onChange(async (v) => {
            this.edit((d) => d.setObsidianConfigEnabled(v));
            new Notice(`MUGS .obsidian/ sync ${v ? "enabled" : "disabled"} once you Apply settings.`);
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
      text: "Connect an account and choose folders. Use MUGS commands to sync, view changes, and review files.",
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
      text: "Sync your folders with GitLab, GitHub, Bitbucket, Gitea/Forgejo, or a local repository.",
    });

    const steps = card.createEl("ol", { cls: "mugs-gs-steps" });
    steps.createEl("li", { text: "Add your account and access token under Accounts." });
    steps.createEl("li", { text: "Connect folders and choose Both ways, Upload only, or Download only." });
    steps.createEl("li", { text: "Open MUGS Overview and run Sync now. Check folder status, view Changes, or Review files that need a decision." });

    card.createDiv({
      cls: "mugs-note",
      text: "Back up your vault and plugin settings before first sync. Git history and MUGS recovery backups help recover changes, but don't replace a backup.",
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
    const chevron = header.createEl("span", { cls: "mugs-section-chevron", text: "▾" });
    header.createEl("h3", { text: title });
    const content = card.createDiv({ cls: "mugs-section-body" });
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", "true");
    const toggle = () => {
      const collapsed = card.classList.toggle("is-collapsed");
      chevron.textContent = collapsed ? "▸" : "▾";
      header.setAttribute("aria-expanded", String(!collapsed));
    };
    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    body(content);
    return;
  }

  /** Human-readable direction label for a mapping. */
  private directionText(d: SyncDirection): string {
    return directionLabel(d);
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
    const activeLastSync = this.plugin.store.getSettings().lastSync; // status dots read ACTIVE state, not the draft
    for (const m of mappings) {
      const block = card.createDiv({ cls: "mugs-mapping" });

      // Header row: status dot + label + delete button. Rendered manually so the
      // sync-status dot sits beside the name (native Setting has no leading icon slot).
      const header = block.createDiv({ cls: "mugs-mapping-header" });
      const dot = header.createEl("span", { cls: `mugs-dot ${this.statusDotClass(activeLastSync[m.id]?.status)}` });
      header.createEl("span", { cls: "mugs-mapping-name", text: m.label });
      new Setting(header).addButton((b) =>
        b.setButtonText("Delete").onClick(() => {
          this.edit((d) => d.removeMapping(m.id));
          this._renderAll();
        }),
      );

      block.createEl("p", {
        cls: "mugs-mapping-route",
        text: `${m.localFolder === "." ? "Vault root" : m.localFolder} → ${m.remotePath || "Repository root"}${m.branch ? ` · ${m.branch}` : ""}`,
      });

      // Editable direction for every card (scoped links and whole-repo alike).
      new Setting(block)
        .setName("Direction")
        .setDesc("Upload, download, or sync both ways.")
        .addDropdown((d) => {
          d.setValue(m.direction).onChange(async (v) => {
            const direction = v as SyncDirection;
            this.edit((d2) => d2.upsertMapping({ ...m, direction }));
          });
          for (const value of ["push-pull", "pull-only", "push-only"] as const) {
            d.addOption(value, directionLabel(value));
          }
        });

      block.appendChild(this.managePanel(
        "Only sync matching files",
        (m.includes ?? []).join("\n"),
        (v) => this.saveMappingScope(m.id, { includes: parseGlobList(v) }),
        "Optional patterns, one per line (e.g. *.md). Leave empty for all files.",
      ));
      block.appendChild(this.managePanel(
        "Skip matching files",
        (m.excludes ?? []).join("\n"),
        (v) => this.saveMappingScope(m.id, { excludes: parseGlobList(v) }),
        "Patterns to skip, one per line (e.g. drafts/**). Uses .gitignore syntax.",
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
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", `Manage ${title.toLowerCase()}`);

    const panel = document.createElement("div");
    panel.className = "mugs-manage-panel is-collapsed";
    const ta = document.createElement("textarea");
    ta.rows = 3;
    ta.style.width = "100%";
    ta.className = "mugs-textarea";
    ta.placeholder = placeholder;
    ta.setAttribute("aria-label", title);
    ta.value = initialText;
    ta.addEventListener("change", (e: Event) => onChange((e.target as HTMLTextAreaElement).value));

    btn.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("is-collapsed");
      btn.setAttribute("aria-expanded", String(!collapsed));
    });

    head.appendChild(lbl);
    head.appendChild(btn);
    panel.appendChild(ta);
    wrap.appendChild(head);
    wrap.appendChild(panel);
    return wrap;
  }

  /** Persist an editable include/exclude scope change on an existing mapping (draft). */
  private saveMappingScope(
    id: string,
    patch: { includes?: string[]; excludes?: string[] },
  ): void {
    const current = this.view().mappings.find((x) => x.id === id);
    if (!current) return;
    this.edit((d) => d.upsertMapping({ ...current, ...patch }));
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
      this.edit((d) => d.setObsidianConfig({ enabled: obs.enabled, entries }));
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
      .setDesc("Where your repositories are hosted.")
      .addDropdown((d) => {
        d.setValue(kind).onChange((v) => {
          kind = v as Credential["kind"];
          setBaseUrlField(prefilledBaseUrl(kind));
          // No markUnsaved: nothing is stored yet — the old call showed the
          // "Unsaved changes" banner on a form the user had not filled in.
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
      .setDesc("A name for this account.")
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
        text: "Add account",
        cta: true,
        onClick: async () => {
          if (!label) { new Notice("MUGS: enter a label for the credential."); return; }
          if (!token && kind !== "local") { new Notice("MUGS: enter a token."); return; }
          try {
            this.edit((d) => d.upsertCredential({
              id: newId(),
              label,
              kind,
              username: username || undefined,
              token,
              baseUrl: baseUrl || undefined,
              repos: repos.length ? repos : undefined,
            }));
            new Notice(`MUGS: account "${label}" added. Apply settings to save.`);
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
    // Draft creds: a credential just added (not yet applied) is selectable here —
    // the whole point of the draft model is composing a first setup, then Apply once.
    const creds = this.view().credentials;
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

    // Local folders already claimed by an existing mapping (draft view — a mapping
    // added earlier in THIS draft session already claims its folder). Matched folders
    // whose localFolder is in this set are shown as disabled rows with a "Mapped" badge
    // so users see what's taken and why, rather than silently losing the choice.
    const usedLocalFolders = new Set(
      this.view().mappings.map((x) => x.localFolder),
    );
    const isRest = (): boolean => {
      const cred = creds.find((c) => c.id === providerId);
      return !!cred && cred.kind !== "local";
    };

    // --- Credential selector -------------------------------------------------
    new Setting(card)
      .setName("Provider")
      .setDesc("Choose the account for these folders.")
      .addDropdown((d) => {
        d.setValue(providerId).onChange(async (v) => {
          providerId = v; // CRITICAL: the assistant used to keep listing repos for —
          // and saving mappings against — the FIRST credential, whatever was picked.
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
    repoSel.setAttribute("aria-label", "Repository");

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
        // Runtime token first; fall back to the DRAFT credential (just-added, not yet applied).
        const token = this.plugin.store.getToken(providerId)
          ?? this.view().credentials.find((c) => c.id === providerId)?.token
          ?? "";
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
      // Clear before re-rendering: every previous re-render APPENDED, stacking
      // duplicate whole-repo/.trash rows and stale rows from the prior repo.
      matchesEl.empty();
      if (isRest() && repoKey) {
        // Whole-repo toggle: map the entire repository root to the vault root ('.').
        const wholeRow = matchesEl.createEl("label", { cls: "mugs-match-whole" });
        const wholeInput = document.createElement("input");
        wholeInput.type = "checkbox";
        wholeInput.checked = wholeRepo;
        wholeInput.addEventListener("change", (e: Event) => { wholeRepo = (e.target as HTMLInputElement).checked; renderMatches(); });
        // FIX: the checkbox was created but never appended — it rendered as an
        // invisible ghost row you could not check. Insert it before the label.
        wholeRow.appendChild(wholeInput);
        wholeRow.createEl("span", { text: "Sync the entire repository to the vault root" });
        const trashRow = matchesEl.createEl("label", { cls: "mugs-match-trash" });
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
        head.textContent = wholeRepo ? "Or connect individual folders:" : "Choose folders to connect";
        for (const m of matches) {
          const row = matchesEl.createDiv({ cls: "mugs-match-row" });
          const taken = usedLocalFolders.has(m.localFolder);
          if (taken) row.classList.add("mugs-match-taken");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = taken || selectedFolders.has(m.remotePath);
          cb.disabled = taken;
          cb.setAttribute("aria-label", `${m.remotePath} → ${m.localFolder}${taken ? " (already connected)" : ""}`);
          cb.addEventListener("change", (e: Event) => {
            if ((e.target as HTMLInputElement).checked) selectedFolders.add(m.remotePath);
            else selectedFolders.delete(m.remotePath);
          });
          row.appendChild(cb);
          const label = row.createEl("span", { cls: "mugs-match-label" });
          label.textContent = m.remotePath;
          label.title = taken ? `${m.localFolder} is already mapped` : `${m.remotePath} → ${m.localFolder}`;
          if (taken) row.createEl("span", { cls: "mugs-match-badge", text: "Connected" });
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
      .setDesc("Upload, download, or sync both ways.")
      .addDropdown((d) => {
        d.setValue(direction).onChange((v) => { direction = v as SyncDirection; });
        for (const value of ["push-pull", "pull-only", "push-only"] as const) {
          d.addOption(value, directionLabel(value));
        }
      });

    new Setting(card)
      .setName("Branch")
      .setDesc("Optional branch to sync. Leave empty for the default branch.")
      .addText((t) => t.setPlaceholder("Branch (optional)").onChange((v) => { branch = v.trim(); }));

    card.appendChild(this.managePanel("Only sync matching files", includesText, (v) => { includesText = v; }, "Optional patterns, one per line (e.g. *.md). Leave empty for all files."));
    card.appendChild(this.managePanel("Skip matching files", excludesText, (v) => { excludesText = v; }, "Patterns to skip, one per line (e.g. drafts/**). Uses .gitignore syntax."));

    // --- Save ----------------------------------------------------------------
    card.appendChild(this.actions([
      {
        text: "Connect selected folders",
        cta: true,
        disabled: creds.length === 0,
        onClick: async () => {
          const cred = creds.find((c) => c.id === providerId);
          if (!providerId) { new Notice("MUGS: choose a credential/provider."); return; }
          if (cred && cred.kind !== "local" && !repoRef) { new Notice("MUGS: choose a repository."); return; }
          try {
            const scope = { includes: parseGlobList(includesText), excludes: parseGlobList(excludesText) };
            // Whole-repo mapping: id === repo.id so the driver matches it (legacy behaviour).
            if (wholeRepo) {
              this.edit((d) => d.upsertMapping({
                id: repoRef, label: repoKey, remotePath: "", localFolder: ".", providerId,
                branch: branch || undefined, direction, ...scope,
                syncTrashFolder: syncTrash ? undefined : false,
              }));
              new Notice(`MUGS: "${repoKey}" connected. Apply settings to save.`);
            } else if (selectedFolders.size === 0) {
              new Notice("MUGS: check at least one folder to link."); return;
            } else {
              // Each checked folder becomes its own scoped card sharing the repo's
              // clone via repoRef. FIX: lookups check EXACT matches AND fuzzy
              // suggestions — a fuzzy pick used to be added to selectedFolders and
              // then silently dropped here because it was only found in `matches`.
              let count = 0;
              for (const remotePath of selectedFolders) {
                const match = matches.find((m) => m.remotePath === remotePath)
                  ?? fuzzyMatches.find((m) => m.remotePath === remotePath);
                if (!match) continue;
                this.edit((d) => d.upsertMapping({
                  id: newId(), label: match.label, remotePath, localFolder: match.localFolder,
                  providerId, branch: branch || undefined, direction, repoRef, ...scope,
                }));
                count += 1;
              }
              new Notice(`MUGS: ${count} folder${count === 1 ? "" : "s"} connected. Apply settings to save.`);
            }
            // U04: surface the direction/first-sync consequences BEFORE activation
            // (the next successful Apply will make them real).
            const consequence = direction === "pull-only"
              ? "Download only: repository files update this vault; your edits aren't uploaded."
              : direction === "push-only"
                ? "Upload only: your files update the repository; repository changes aren't downloaded."
                : "Both ways: upload and download changes. Conflicts need your review.";
            const first = this.view().sync.firstSyncDirection === "push"
              ? "first sync will UPLOAD your vault folder to the remote (overwrites the remote path's content)."
              : "first sync will DOWNLOAD the remote path into your vault folder (vault files there are replaced).";
            new Notice(`MUGS — what happens after Apply:\n· ${consequence}\n· On a mapping's first sync, ${first}`, 12000);
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
