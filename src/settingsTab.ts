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
import { buildProvider, PROVIDER_OPTIONS, providerOption, prefillBaseUrl } from "./providers/factory";
import { DEFAULT_OAUTH_REDIRECT_URI, buildGitLabCreateTokenUrl, encodeOAuthSecret } from "./providers/gitlabOAuth";
import { validateBaseUrl, validateCredentialForm, normalizeLocalBaseUrl, type FieldProblem } from "./providers/validate";
import type { CredentialStatus } from "./store";
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

/** Debounce for auto-applying settings after the last edit (ms). */
const AUTO_APPLY_MS = 700;

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
    // Re-snapshot from the live store on every open UNLESS the user has
    // in-progress (dirty) edits, which must be preserved. A clean or absent
    // draft is stale after any external change to the store (e.g. a mapping's
    // direction flipped by another surface), so rebuild it to keep the UI in
    // sync with the backend. A dirty draft is left alone: the user is mid-edit,
    // and yanking the base out from under them would lose their work — the
    // existing Apply/Cancel flow owns that case.
    if (this.draft && !this.draft.dirty()) this.draft = null;
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

  /** Banner text node showing the pending-change count. */
  private unsavedNoteEl: HTMLElement | null = null;

  /** Banner container listing validation problems (each clickable to jump to it). */
  private unsavedProblemsEl: HTMLElement | null = null;

  /** Pending debounced auto-apply timer (settings save without an explicit click). */
  private autoApplyTimer?: ReturnType<typeof setTimeout>;

  /** Section cards by title, so the guided checklist can jump to one. */
  private sectionEls = new Map<string, HTMLElement>();

  /** The settings snapshot edits render from and mutate: the DRAFT (never the live store). */
  private view(): MugsSettings {
    if (!this.draft) this.draft = new SettingsDraft(this.plugin.store.getSettings());
    return this.draft.view();
  }

  /** Apply an edit to the draft, flag the banner, and schedule a debounced
   *  auto-apply so settings save without the user pressing Apply. */
  private edit(mutate: (d: SettingsDraft) => void): void {
    if (!this.draft) this.draft = new SettingsDraft(this.plugin.store.getSettings());
    mutate(this.draft);
    this.markUnsaved();
    this.scheduleAutoApply();
  }

  /** Debounced auto-apply: commit + persist shortly after the last edit. The
   *  banner still surfaces any problem and stays until it is fixed or cancelled. */
  private scheduleAutoApply(): void {
    if (this.autoApplyTimer !== undefined) clearTimeout(this.autoApplyTimer);
    this.autoApplyTimer = setTimeout(() => {
      this.autoApplyTimer = undefined;
      void this.applySettings();
    }, AUTO_APPLY_MS);
  }

  /** Create the single unsaved-changes banner if it does not yet exist. */
  private ensureUnsavedBanner(): void {
    if (this.unsavedBannerEl) return;
    const el = this.containerEl.createDiv({ cls: "mugs-unsaved-banner" });
    el.style.display = "none"; // hidden until there are unsaved changes
    const text = el.createDiv({ cls: "mugs-unsaved-text" });
    this.unsavedNoteEl = text.createEl("span", { cls: "mugs-unsaved-note", text: "Unsaved settings" });
    this.unsavedProblemsEl = el.createDiv({ cls: "mugs-banner-problems" });
    const actions = el.createDiv({ cls: "mugs-unsaved-actions" });
    const applyBtn = actions.createEl("button", { cls: "mugs-unsaved-apply", text: "Apply settings" });
    applyBtn.addEventListener("click", () => void this.applySettings({ explicit: true }));
    const cancelBtn = actions.createEl("button", { cls: "mugs-unsaved-cancel", text: "Cancel" });
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
    this.refreshBanner();
  }

  /** Update the banner's pending-change count and problem list in place (no
   *  form rebuild), so the count is honest and problems are one click away. */
  private refreshBanner(): void {
    if (!this.unsavedChanges) return;
    const count = this.draft?.changeCount() ?? 0;
    if (this.unsavedNoteEl) {
      this.unsavedNoteEl.textContent = count === 1 ? "1 unsaved change" : `${count} unsaved changes`;
    }
    const problemsEl = this.unsavedProblemsEl;
    if (!problemsEl) return;
    problemsEl.empty();
    const problems = this.draft?.validateDetailed() ?? [];
    if (problems.length === 0) return;
    problemsEl.createEl("div", {
      cls: "mugs-banner-problems-head",
      text: problems.length === 1 ? "1 thing to fix before applying:" : `${problems.length} things to fix before applying:`,
    });
    for (const p of problems.slice(0, 5)) {
      const link = problemsEl.createEl("button", { cls: "mugs-problem-link", text: p.message });
      link.setAttribute("type", "button");
      link.addEventListener("click", () => this.jumpToProblem(p.ref));
    }
    if (problems.length > 5) {
      problemsEl.createEl("div", { cls: "mugs-banner-problems-more", text: `…and ${problems.length - 5} more` });
    }
  }

  /** Expand the section holding a draft item and scroll it into view. */
  private jumpToProblem(ref?: { kind: "credential" | "mapping"; id: string }): void {
    if (!ref) return;
    const target = this.containerEl.querySelector(`[data-mugs-ref="${ref.kind}:${ref.id}"]`) as HTMLElement | null;
    if (!target) return;
    this.expandSection(target);
    (target as unknown as { scrollIntoView?: (opts?: unknown) => void }).scrollIntoView?.({ block: "center" });
  }

  /** Walk up to the enclosing collapsible section and open it. */
  private expandSection(el: HTMLElement): void {
    let cur = el as unknown as {
      classList?: { contains(cls: string): boolean; remove(cls: string): void };
      querySelector?: (sel: string) => HTMLElement | null;
      parentElement?: unknown;
      parent?: unknown;
    } | null;
    while (cur) {
      if (cur.classList?.contains("mugs-section")) {
        if (cur.classList.contains("is-collapsed")) {
          cur.classList.remove("is-collapsed");
          const chevron = cur.querySelector?.(".mugs-section-chevron");
          if (chevron) chevron.textContent = "▾";
          cur.querySelector?.(".mugs-section-header")?.setAttribute("aria-expanded", "true");
        }
        return;
      }
      cur = (cur.parentElement ?? cur.parent) as typeof cur;
    }
  }

  /** Validate the COMPLETE draft, then commit + persist ONCE. Runs both from the
   *  debounced auto-apply (silent) and the explicit Apply button (Notices +
   *  re-render). Validation problems leave the draft untouched and the banner
   *  lists them; a refused save rolls the store back and keeps the draft. */
  private async applySettings(opts: { explicit?: boolean } = {}): Promise<void> {
    if (this.autoApplyTimer !== undefined) { clearTimeout(this.autoApplyTimer); this.autoApplyTimer = undefined; }
    const draft = this.draft;
    if (!draft) return;
    // Resume/apply the scheduler immediately when sync-relevant state changed:
    // the sync policy, the mappings (a newly connected folder), or the
    // credentials (a repaired token) must start syncing NOW, not on the next
    // 15s/30s poll.
    const view = draft.view();
    const syncChanged = JSON.stringify(draft.base.sync) !== JSON.stringify(view.sync);
    const mappingsChanged = JSON.stringify(draft.base.mappings) !== JSON.stringify(view.mappings);
    const credentialsChanged = JSON.stringify(draft.base.credentials) !== JSON.stringify(view.credentials);
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
    const outcome = await draft.commit(target);
    if (outcome.kind === "invalid") {
      // Auto-apply stays quiet (the banner lists the problems); an explicit Apply
      // also raises a Notice and jumps to the first problem.
      if (opts.explicit) {
        new Notice(`MUGS: settings not applied — fix these first:\n· ${outcome.problems.slice(0, 5).join("\n· ")}${outcome.problems.length > 5 ? `\n… and ${outcome.problems.length - 5} more` : ""}`, 10000);
        this.jumpToProblem(draft.validateDetailed()[0]?.ref);
      }
      this.refreshBanner();
      return;
    }
    if (outcome.kind === "save-failed") {
      // Active settings were rolled back — say so; the banner stays for a retry.
      new Notice(`MUGS: could not save settings (${outcome.result.reason}) — your edits are kept in this pane but the previous settings remain active. Try Apply again or Cancel.`, 10000);
      return;
    }
    this.draft = null;
    this.unsavedChanges = false;
    if (this.unsavedBannerEl) { this.unsavedBannerEl.remove(); this.unsavedBannerEl = null; this.unsavedNoteEl = null; this.unsavedProblemsEl = null; }
    if (syncChanged || mappingsChanged || credentialsChanged) this.plugin.automaticSyncSettingsChanged();
    if (opts.explicit) {
      new Notice("MUGS: settings saved and now active.");
      this._renderAll();
    }
  }

  /** Immediate commit for explicit action buttons (Add account, Save token,
   *  Connect, Delete): apply right away — no misleading "Apply settings to
   *  save" limbo — then re-render. The success notice only fires when the
   *  commit actually landed (a failed validation keeps the draft + banner). */
  private async commitNow(successNotice?: string): Promise<void> {
    await this.applySettings({ explicit: false });
    if (successNotice && !this.draft) new Notice(successNotice);
    this._renderAll();
  }

  /** Flush the live store after a direct security transaction (passphrase set /
   *  disable-encryption) and drop any draft still holding the PRE-transaction
   *  security block — applying that stale draft would wipe the fresh kdf state
   *  (and re-commit plaintext credentials) via applySnapshot. */
  private async commitSecurityTransaction(): Promise<void> {
    const saved = await this.plugin.store.save();
    if (saved && !saved.ok) {
      new Notice("MUGS: the security change is active but could not be saved to disk yet — it is kept for the next successful save.", 8000);
    }
    this.draft = null;
    this.unsavedChanges = false;
    if (this.unsavedBannerEl) { this.unsavedBannerEl.remove(); this.unsavedBannerEl = null; this.unsavedNoteEl = null; this.unsavedProblemsEl = null; }
    this._renderAll();
  }

  /** Discard the draft entirely — active settings never changed. */
  private cancelSettings(): void {
    if (this.autoApplyTimer !== undefined) { clearTimeout(this.autoApplyTimer); this.autoApplyTimer = undefined; }
    this.draft = null;
    this.unsavedChanges = false;
    if (this.unsavedBannerEl) { this.unsavedBannerEl.remove(); this.unsavedBannerEl = null; this.unsavedNoteEl = null; this.unsavedProblemsEl = null; }
    new Notice("MUGS: changes discarded — active settings unchanged.");
    this._renderAll();
  }

  hide(): void {
    // Auto-apply saves shortly after each edit; only a draft that failed
    // validation (or a save) is still pending when the tab closes.
    if (this.unsavedChanges) {
      new Notice("MUGS: some settings still need attention — reopen MUGS settings to fix the listed problems.", 6000);
    }
  }

  private _renderAll(): void {
    const { containerEl } = this;
    // Reuse a single unsaved-changes banner across renders so toggling it never
    // rebuilds text inputs (which would steal focus). Insert at the top after empty().
    containerEl.empty();
    containerEl.classList.add("mugs-settings");
    this.sectionEls.clear();
    if (this.unsavedBannerEl) containerEl.appendChild(this.unsavedBannerEl);

    // --- Getting Started (startup documentation) ----------------------------
    this.gettingStarted(containerEl);

    // --- Credentials / providers -------------------------------------------
    this.section(containerEl, "Accounts", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Connect your Git account. The API endpoint is filled in for you. Tokens stay in this vault and can be encrypted.",
      });

      // Draft view: tokens are masked HERE at render time only (the draft carries
      // the real values so Apply can commit them; nothing raw is ever shown).
      const creds = this.view().credentials;
      if (creds.length === 0) {
        card.createEl("p", { cls: "mugs-muted", text: "No accounts connected." });
      } else {
        for (const c of creds) {
          // Tag the row so a banner problem can jump to it (data-mugs-ref).
          const row = card.createDiv({ cls: "mugs-credential" });
          row.setAttribute("data-mugs-ref", `credential:${c.id}`);
          const status = this.credentialStatus(c);
          const needsRepair = status === "missing-keychain" || status === "missing" || status === "oauth-expired";
          if (needsRepair) row.classList.add("mugs-cred-warning");
          const descParts = [this.credentialStatusText(c, status)];
          if (c.username) descParts.push(`user: ${c.username}`);
          if (c.baseUrl) descParts.push(`url: ${c.baseUrl}`);
          const settingRow = new Setting(row)
            .setName(`${c.label} (${c.authMode === "oauth" ? `${c.kind} OAuth` : c.kind})`)
            .setDesc(descParts.join(" · "));
          if (c.authMode === "oauth") {
            settingRow.addButton((b) => {
              b.setButtonText(needsRepair ? "Reconnect with GitLab" : "Reconnect");
              if (needsRepair) b.setCta();
              b.onClick(() => void this.reconnectOAuthInPlace(c.id));
            });
          }
          settingRow.addButton((b) =>
            b.setButtonText("Delete").onClick(() => {
              this.edit((d) => d.removeCredential(c.id));
              void this.commitNow();
            }),
          );

          // In-place token repair (hosted token accounts): paste a new token onto
          // the EXISTING credential (id preserved) so every mapping stays linked.
          // Auto-expanded when the token is known-missing; behind a small
          // "Update token" toggle otherwise.
          if (c.kind !== "local" && c.authMode !== "oauth") {
            let toggleBtn: HTMLElement | null = null;
            if (!needsRepair) {
              toggleBtn = row.createEl("button", { cls: "mugs-link-btn", text: "Update token" });
              toggleBtn.setAttribute("type", "button");
            }
            const panel = row.createDiv({ cls: needsRepair ? "mugs-inline-repair" : "mugs-inline-repair is-collapsed" });
            const input = document.createElement("input");
            input.type = "password";
            input.placeholder = needsRepair ? "Paste token to reconnect" : "New token";
            input.setAttribute("aria-label", `Token for ${c.label}`);
            const testSaveBtn = document.createElement("button");
            testSaveBtn.type = "button";
            testSaveBtn.className = "mod-cta";
            testSaveBtn.textContent = "Test & Save";
            testSaveBtn.addEventListener("click", () => void this.testAndSaveTokenInPlace(c.id, input));
            const saveBtn = document.createElement("button");
            saveBtn.type = "button";
            saveBtn.textContent = "Save token";
            saveBtn.addEventListener("click", () => void this.saveTokenInPlace(c.id, input));
            panel.appendChild(input);
            panel.appendChild(testSaveBtn);
            panel.appendChild(saveBtn);
            if (c.kind === "gitlab") {
              const createLink = document.createElement("a");
              createLink.className = "mugs-token-helper-link";
              createLink.href = buildGitLabCreateTokenUrl(c.baseUrl);
              createLink.target = "_blank";
              createLink.rel = "noopener noreferrer";
              createLink.textContent = "Create token in GitLab ↗";
              panel.appendChild(createLink);
            }
            if (toggleBtn) {
              toggleBtn.setAttribute("aria-expanded", "false");
              toggleBtn.addEventListener("click", () => {
                const collapsed = panel.classList.toggle("is-collapsed");
                toggleBtn!.setAttribute("aria-expanded", String(!collapsed));
              });
            }
          }
        }
      }

      const add = card.createEl("details", { cls: "mugs-settings-add" });
      add.open = creds.length === 0;
      add.createEl("summary", { text: "Add another account" });
      this.addCredentialForm(add.createDiv({ cls: "mugs-settings-form" }));
    });

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
                  // The store transaction already flipped encryptCredentials off;
                  // flush to disk + drop any draft still holding the pre-
                  // transaction security block (applying it would clobber kdf).
                  await this.commitSecurityTransaction();
                  return;
                }
              }
              this.edit((d) => d.setSecurity({ encryptCredentials: v }));
              new Notice(`MUGS credentials will be ${v ? "encrypted" : "stored as-is"} — saved automatically.`);
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
                // setEncryptionPassphrase mutated the LIVE store directly; flush
                // + drop the stale draft (it holds the pre-passphrase security
                // block and plaintext credentials — applying it would wipe kdf).
                await this.commitSecurityTransaction();
                new Notice(
                  "MUGS: tokens re-encrypted and saved. The passphrase is not stored and cannot be recovered.",
                  8000,
                );
              } catch (e) {
                new Notice(`MUGS: could not set the passphrase — ${errorMessage(e)}`, 8000);
              }
            }),
          );
      }
    }, { defaultCollapsed: !this.plugin.store.isLocked() });

    // --- Automatic conflict resolution (Area 3/4) -------------------------
    this.section(containerEl, "Conflicts", (card) => {
      card.createEl("p", {
        cls: "mugs-desc",
        text: "Separate edits combine automatically. If the same lines change in both places, MUGS keeps the more recent edit when it can tell which is newer; otherwise you choose what to keep.",
      });

      const sync = this.view().sync;
      new Setting(card)
        .setName("Combine non-conflicting edits")
        .setDesc("Combine edits to different lines automatically. Conflicting edits are auto-resolved when a newer edit is clear, otherwise they need your review.")
        .addToggle((t) => {
          t.setValue(sync.autoMerge).onChange(async (v) => {
            this.edit((d) => d.setSync({ autoMerge: v }));
          });
        });

      new Setting(card)
        .setName("Preferred conflict choice")
        .setDesc("A preference only, used when MUGS can't tell which edit is newer. MUGS won't choose for you in that case.")
        .addDropdown((d) => {
          for (const [value, text] of [["both", "Both versions"], ["theirs", "Repository"], ["ours", "This device"]]) {
            d.addOption(value, text);
          }
          d.setValue(sync.defaultResolution).onChange(async (v) => {
            this.edit((d) => d.setSync({ defaultResolution: v as "both" | "theirs" | "ours" }));
          });
        });

      new Setting(card)
        .setName("Prefer newer edits")
        .setDesc("When on, a conflicting edit is auto-resolved to the more recent side when the two saves clearly differ in time. Near-equal or missing timestamps still need your review.")
        .addToggle((t) => {
          t.setValue(sync.recencyWins).onChange(async (v) => {
            this.edit((d) => d.setSync({ recencyWins: v }));
          });
    });
    }, { defaultCollapsed: true });

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
          for (const [value, text] of INTERVAL_PRESETS.map((p) => [p.id, p.label]) as Array<[string, string]>) {
            d.addOption(value, text);
          }
          d.setValue(presetIdForSeconds(sync.intervalSeconds)).onChange(async (v) => {
            this.edit((d2) => d2.setSync({ intervalSeconds: resolveIntervalSeconds(v) }));
          });
        });

      new Setting(card)
        .setName("Pause automatic sync")
        .setDesc("Stop scheduled sync and file-change triggers. Sync now remains available; resuming checks immediately.")
        .addToggle((t) => {
          t.setValue(sync.paused).onChange(async (v) => {
            this.edit((d2) => d2.setSync({ paused: v }));
            new Notice(`MUGS sync will be ${v ? "paused" : "resumed"} shortly — saved automatically.`);
          });
    });

      new Setting(card)
        .setName("Start new connections with")
        .setDesc(
          "Download starts with repository files. Upload starts with this device's files. Back up both copies before the first sync.",
        )
        .addDropdown((d) => {
          d.addOption("pull", "Download from repository (default)");
          d.addOption("push", "Upload from this device");
          d.setValue(sync.firstSyncDirection).onChange(async (v) => {
            this.edit((d2) => d2.setSync({ firstSyncDirection: v as "pull" | "push" }));
          });
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
    const obsEnabled = this.view().sync.obsidianConfig.enabled;
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
            new Notice(`MUGS .obsidian/ sync ${v ? "enabled" : "disabled"} — saved automatically.`);
            this._renderAll();
          });
        });

      // Obsidian-Sync-style grouped toggles: each top-level .obsidian/ child gets a
      // personal/vault-wide scope so you can share all settings or only certain components.
      this.renderObsidianEntries(card, obs);
    }, { defaultCollapsed: !obsEnabled });

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

  /** A short, live onboarding checklist at the top of the pane. Each step ticks
   *  itself from the current settings so a new user sees exactly what is left. */
  private gettingStarted(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "mugs-getting-started" });
    card.createEl("h3", { text: "Getting Started" });

    const view = this.view();
    const lastSync = this.plugin.store.getSettings().lastSync;
    const hasAccount = view.credentials.length > 0;
    const hasFolder = view.mappings.length > 0;
    const hasSynced = Object.values(lastSync).some(
      (s) => s.status === "ok" || s.status === "up-to-date" || !!s.correspondenceSha,
    );

    // Fully-configured vaults get a one-line summary instead of the checklist,
    // keeping the top of Settings clean for configured users.
    if (hasAccount && hasFolder && hasSynced) {
      card.createEl("p", {
        cls: "mugs-gs-intro",
        text: "All set — account connected, folders linked, and sync has run. Manage everything below.",
      });
      return;
    }

    card.createEl("p", {
      cls: "mugs-gs-intro",
      text: "Sync your folders with GitLab, GitHub, Bitbucket, Gitea/Forgejo, or a local repository.",
    });
    const steps: Array<{ done: boolean; text: string; section?: string; action?: string }> = [
      { done: hasAccount, text: "Add your account under Accounts — the API endpoint and label are filled in for you.", section: "Accounts", action: "Add account" },
      { done: hasFolder, text: "Connect folders and choose Both ways, Upload only, or Download only.", section: "Connected folders", action: "Connect a folder" },
      { done: hasSynced, text: "Sync runs automatically; check the status bar or open Overview to watch progress." },
    ];
    const list = card.createEl("ol", { cls: "mugs-gs-steps" });
    for (const step of steps) {
      const li = list.createEl("li", { cls: step.done ? "mugs-gs-step mugs-gs-done" : "mugs-gs-step" });
      li.createEl("span", { cls: "mugs-gs-mark", text: step.done ? "✓" : "○" });
      li.createEl("span", { text: step.text });
      // Jump to the section that completes an unfinished step (resolved at click
      // time, after the sections have rendered).
      if (!step.done && step.section && step.action) {
        const btn = li.createEl("button", { cls: "mugs-gs-action", text: step.action });
        btn.setAttribute("type", "button");
        btn.addEventListener("click", () => {
          const target = this.sectionEls.get(step.section!);
          if (!target) return;
          this.expandSection(target);
          (target as unknown as { scrollIntoView?: (o?: unknown) => void }).scrollIntoView?.({ block: "start" });
        });
      }
    }

    card.createDiv({
      cls: "mugs-note",
      text: "Back up your vault and plugin settings before first sync. Sync starts automatically once a folder is connected; pause it any time under Sync.",
    });
  }

  /** Wrap children in a single grouped settings card with a collapsible header.
   *  The title is rendered as the clickable header (with a chevron); body() receives
   *  the content area element. Toggling only flips an `is-collapsed` class, so live-
   *  preview re-renders never rebuild text inputs and steal focus. */
  private section(containerEl: HTMLElement, title: string, body: (card: HTMLElement) => void, opts: { defaultCollapsed?: boolean } = {}): void {
    // Build the card with Obsidian's native createDiv so it is guaranteed to expose
    // createEl/createDiv/etc. In Obsidian 1.14.x a raw document.createElement("div")
    // element does not reliably inherit those helpers, which left every section blank.
    const card = containerEl.createDiv({ cls: "mugs-section" });
    this.sectionEls.set(title, card);
    const header = card.createEl("div", { cls: "mugs-section-header" });
    const chevron = header.createEl("span", { cls: "mugs-section-chevron", text: "▾" });
    header.createEl("h3", { text: title });
    const content = card.createDiv({ cls: "mugs-section-body" });
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", "true");
    // Progressive disclosure: secondary sections start collapsed until relevant
    // (the caller decides — e.g. Security auto-expands while the vault is locked).
    if (opts.defaultCollapsed) {
      card.classList.add("is-collapsed");
      chevron.textContent = "▸";
      header.setAttribute("aria-expanded", "false");
    }
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

  /** Live credential status, preferring the store's own getCredentialStatus and
   *  falling back to inference from the runtime token + stored credential shape
   *  (structural cast: the store may not ship the method yet). */
  private credentialStatus(c: Credential): CredentialStatus {
    const store = this.plugin.store as unknown as { getCredentialStatus?: (id: string) => CredentialStatus };
    if (typeof store.getCredentialStatus === "function") return store.getCredentialStatus(c.id);
    if (c.kind === "local") return "ready";
    if (this.plugin.store.getToken(c.id)) return "ready";
    if (this.plugin.store.isLocked() && (c.secretId || c.token)) return "locked";
    if (c.secretId && !c.token) return "missing-keychain";
    return "missing";
  }

  /** Honest per-status token description for an account row (never a bare
   *  "keychain" claim when the keychain actually holds nothing). */
  private credentialStatusText(c: Credential, status: CredentialStatus): string {
    if (c.kind === "local") return `path: ${c.baseUrl ?? "not set"}`;
    if (c.authMode === "oauth") {
      switch (status) {
        case "ready": return "GitLab OAuth · auto-refresh";
        case "oauth-expired": return "session expired — sign in again";
        case "missing-keychain": return "not signed in on this device — sign in again";
        case "locked": return "locked — unlock under Security";
        case "missing": return "not signed in — sign in with GitLab";
      }
    }
    switch (status) {
      case "ready": return c.secretId ? "token: saved in keychain" : `token: ${maskToken(c.token)}`;
      case "missing-keychain": return "token missing on this device — paste token below";
      case "oauth-expired": return "session expired — sign in again";
      case "locked": return "locked — unlock under Security";
      case "missing": return "token not set — paste token below";
    }
  }

  /** Test a pasted token live against the provider before saving it in place. */
  private async testAndSaveTokenInPlace(id: string, input: { value: string }): Promise<void> {
    const value = input.value.trim();
    if (!value) { new Notice("MUGS: paste a token first."); return; }
    const current = this.view().credentials.find((x) => x.id === id);
    if (!current) { new Notice("MUGS: this account no longer exists."); return; }
    try {
      const provider = buildProvider(
        { kind: current.kind, baseUrl: current.baseUrl, token: value, allowedRepos: current.repos },
        { actingUsername: current.username },
      );
      const list = await provider.listRepos();
      await this.saveTokenInPlace(id, input);
      new Notice(`MUGS: verified and saved token for "${current.label}" (${list.length} repositor${list.length === 1 ? "y" : "ies"} visible).`);
    } catch (e) {
      new Notice(`MUGS: token check failed — ${errorMessage(e)}. Nothing was changed.`, 10000);
    }
  }

  /** Re-run GitLab OAuth PKCE for an existing OAuth credential (preserving `id` and all mappings). */
  private async reconnectOAuthInPlace(id: string): Promise<void> {
    const current = this.view().credentials.find((x) => x.id === id);
    if (!current || !current.oauth?.clientId) {
      new Notice("MUGS: this account has no OAuth Application ID configured.");
      return;
    }
    const start = (this.plugin as unknown as {
      startGitLabOAuth?: (opts: { baseUrl?: string; clientId: string; redirectUri?: string }) => Promise<{
        bundle: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
        username?: string;
        redirectUri: string;
      }>;
    }).startGitLabOAuth;
    if (typeof start !== "function") {
      new Notice("MUGS: GitLab OAuth is not available in this host.");
      return;
    }
    new Notice("MUGS: opening browser to reconnect with GitLab…");
    try {
      const res = await start.call(this.plugin, {
        baseUrl: current.baseUrl,
        clientId: current.oauth.clientId,
        redirectUri: current.oauth.redirectUri,
      });
      this.edit((d) => d.upsertCredential({
        ...current,
        authMode: "oauth",
        username: res.username ?? current.username,
        token: encodeOAuthSecret(res.bundle),
        oauth: {
          clientId: current.oauth!.clientId,
          redirectUri: res.redirectUri,
          expiresAt: res.bundle.expiresAt,
          scope: res.bundle.scope,
        },
      }));
      await this.commitNow(`MUGS: reconnected "${current.label}" with GitLab.`);
    } catch (e) {
      new Notice(`MUGS: could not reconnect with GitLab — ${errorMessage(e)}`, 10000);
    }
  }

  /** Paste a new token onto an EXISTING credential in place (id preserved so
   *  all mappings stay linked), commit immediately, and re-render. */
  private async saveTokenInPlace(id: string, input: { value: string }): Promise<void> {
    const value = input.value.trim();
    if (!value) { new Notice("MUGS: paste a token first."); return; }
    const current = this.view().credentials.find((x) => x.id === id);
    if (!current) { new Notice("MUGS: this account no longer exists."); return; }
    this.edit((d) => d.upsertCredential({ ...current, token: value }));
    await this.applySettings({ explicit: false });
    if (!this.draft) new Notice(`MUGS: token updated for "${current.label}".`);
    this._renderAll();
  }

  /** Render each stored mapping as a card with native Setting rows, collapsible
   *  include/exclude managers. The whole-vault .trash/ toggle lives in the
   *  Sync Frequency & Maintenance section instead. */
  private renderMappings(card: HTMLElement, mappings: FolderMapping[]): void {
    const activeLastSync = this.plugin.store.getSettings().lastSync; // status dots read ACTIVE state, not the draft
    const creds = this.view().credentials;
    for (const m of mappings) {
      const block = card.createDiv({ cls: "mugs-mapping" });
      // Tag the card so a banner problem can jump to it (data-mugs-ref).
      block.setAttribute("data-mugs-ref", `mapping:${m.id}`);

      // Recovery: a mapping whose account was deleted (or copied here from
      // another device) must never be stuck on "credential missing" — surface
      // it and let the user re-bind to an existing account right on the card.
      const credMissing = !creds.some((c) => c.id === m.providerId);
      if (credMissing) block.classList.add("mugs-mapping-missing-cred");

      // Header row: status dot + label + delete button. Rendered manually so the
      // sync-status dot sits beside the name (native Setting has no leading icon slot).
      const header = block.createDiv({ cls: "mugs-mapping-header" });
      // The dot element renders via createEl's side effect; no reference is needed.
      header.createEl("span", { cls: `mugs-dot ${this.statusDotClass(activeLastSync[m.id]?.status)}` });
      header.createEl("span", { cls: "mugs-mapping-name", text: m.label });
      new Setting(header).addButton((b) =>
        b.setButtonText("Delete").onClick(() => {
          this.edit((d) => d.removeMapping(m.id));
          void this.commitNow();
        }),
      );

      block.createEl("p", {
        cls: "mugs-mapping-route",
        text: `${m.localFolder === "." ? "Vault root" : m.localFolder} → ${m.remotePath || "Repository root"}${m.branch ? ` · ${m.branch}` : ""}`,
      });

      if (credMissing) {
        block.createEl("p", { cls: "mugs-cred-warning", text: "Account missing — select an account to reconnect." });
        // Exactly one account exists? One click rebinds and commits.
        if (creds.length === 1) {
          const rebind = block.createDiv({ cls: "mugs-rebind-row" });
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = `Use ${creds[0].label}`;
          btn.addEventListener("click", () => void this.rebindMappingNow(m.id, creds[0].id));
          rebind.appendChild(btn);
        }
      }
      // With several accounts (or a missing one), expose the re-bind dropdown.
      if (credMissing || creds.length > 1) {
        new Setting(block)
          .setName("Account")
          .setDesc(credMissing ? "Choose the account to reconnect this folder." : "Move this connection to another account.")
          .addDropdown((d) => {
            for (const c of creds) d.addOption(c.id, c.label);
            if (!credMissing) d.setValue(m.providerId);
            d.onChange((v) => {
              this.edit((d2) => d2.upsertMapping({ ...m, providerId: v }));
            });
          });
      }

      // Editable direction for every card (scoped links and whole-repo alike).
      new Setting(block)
        .setName("Direction")
        .setDesc("Upload, download, or sync both ways.")
        .addDropdown((d) => {
          for (const value of ["push-pull", "pull-only", "push-only"] as const) {
            d.addOption(value, directionLabel(value));
          }
          d.setValue(m.direction).onChange(async (v) => {
            const direction = v as SyncDirection;
            this.edit((d2) => d2.upsertMapping({ ...m, direction }));
          });
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

  /** Re-point a mapping at an existing credential and commit immediately. */
  private async rebindMappingNow(id: string, providerId: string): Promise<void> {
    const current = this.view().mappings.find((x) => x.id === id);
    if (!current) return;
    this.edit((d) => d.upsertMapping({ ...current, providerId }));
    await this.applySettings({ explicit: false });
    if (!this.draft) new Notice("MUGS: connection re-pointed to the selected account.");
    this._renderAll();
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

  /** Add-account form using native Obsidian Setting rows. Hosted providers
   *  lead with just Provider + Token; Base URL / Label / Username / repo filter
   *  fold into an "Advanced options" disclosure (auto-opened for self-hosted-
   *  only providers or when an advanced field has a problem). Local repositories
   *  show a bare-absolute-path field (normalized to file:// on save) + Label.
   *  Values are checked inline as they are typed, "Test connection" probes the
   *  account live, and "Add account" commits immediately. */
  private addCredentialForm(card: HTMLElement): void {
    let kind: Credential["kind"] = PROVIDER_OPTIONS[0]?.kind ?? "gitlab";
    let authMode: "token" | "oauth" = "token";
    let oauthClientId = "";
    let oauthController: AbortController | null = null;
    let label = providerOption(kind)?.label ?? kind; // auto-filled; editable
    let labelTouched = false;
    let username = "";
    let token = "";
    let baseUrl = prefillBaseUrl(kind);
    let repos: string[] = [];
    /** True once the user pressed "Add account" — required-field errors show only then. */
    let attempted = false;

    // Inline problem list + test-connection status, updated in place so typing
    // never rebuilds the form inputs (which would steal focus/caret).
    const messagesEl = card.createDiv({ cls: "mugs-form-messages" });
    const testStatusEl = card.createDiv({ cls: "mugs-test-status" });

    /** Form rows + action buttons, rebuilt when provider kind or authMode flips. */
    let rowsEl: HTMLElement | null = null;
    let actionsEl: HTMLElement | null = null;
    let advancedEl: HTMLDetailsElement | null = null;

    const currentProblems = (): FieldProblem[] =>
      authMode === "oauth" && kind === "gitlab"
        ? validateCredentialForm({ kind, label, token: "oauth-pending", baseUrl, repos })
        : validateCredentialForm({ kind, label, token, baseUrl, repos });

    const refreshValidation = (): void => {
      messagesEl.empty();
      for (const p of currentProblems()) {
        if (p.kind === "required" && !attempted) continue; // don't nag before submit
        messagesEl.createEl("div", {
          cls: p.level === "error" ? "mugs-field-error" : "mugs-field-warn",
          text: p.message,
        });
      }
      // Auto-open the advanced disclosure when one of its fields has a problem.
      if (advancedEl) {
        const advancedProblem = currentProblems().some((p) => p.field === "baseUrl" || p.field === "label" || p.field === "repos");
        if (advancedProblem) advancedEl.open = true;
      }
    };

    const startOAuthSignIn = async (): Promise<void> => {
      const clientId = oauthClientId.trim();
      if (!clientId) {
        testStatusEl.empty();
        testStatusEl.createEl("div", { cls: "mugs-field-error", text: "Enter your GitLab OAuth Application ID first." });
        return;
      }
      const start = (this.plugin as unknown as {
        startGitLabOAuth?: (opts: { baseUrl?: string; clientId: string; redirectUri?: string; signal?: AbortSignal }) => Promise<{
          bundle: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
          username?: string;
          redirectUri: string;
        }>;
      }).startGitLabOAuth;
      if (typeof start !== "function") {
        testStatusEl.empty();
        testStatusEl.createEl("div", { cls: "mugs-field-error", text: "GitLab OAuth is not available in this host." });
        return;
      }
      oauthController?.abort();
      oauthController = new AbortController();
      testStatusEl.empty();
      const waitRow = testStatusEl.createDiv({ cls: "mugs-field-hint" });
      waitRow.createEl("span", { text: "Waiting for GitLab sign-in in your browser… " });
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "mugs-link-btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => oauthController?.abort());
      waitRow.appendChild(cancelBtn);
      try {
        const res = await start.call(this.plugin, {
          baseUrl: baseUrl || undefined,
          clientId,
          redirectUri: DEFAULT_OAUTH_REDIRECT_URI,
          signal: oauthController.signal,
        });
        const finalLabel = labelTouched && label ? label : (res.username ? `GitLab (${res.username})` : label);
        this.edit((d) => d.upsertCredential({
          id: newId(),
          label: finalLabel,
          kind: "gitlab",
          authMode: "oauth",
          username: res.username || username || undefined,
          token: encodeOAuthSecret(res.bundle),
          baseUrl: baseUrl || undefined,
          repos: repos.length ? repos : undefined,
          oauth: {
            clientId,
            redirectUri: res.redirectUri,
            expiresAt: res.bundle.expiresAt,
            scope: res.bundle.scope,
          },
        }));
        testStatusEl.empty();
        await this.commitNow(`MUGS: signed in to GitLab as ${res.username ?? finalLabel}.`);
      } catch (e) {
        testStatusEl.empty();
        testStatusEl.createEl("div", { cls: "mugs-field-error", text: `Sign-in failed — ${errorMessage(e)}` });
      } finally {
        oauthController = null;
      }
    };

    /** (Re)build the kind-specific rows: hosted shows Token (or GitLab OAuth) + advanced options;
     *  local shows a Repository path (bare /abs path or file:// URL) + Label. */
    const buildRows = (): void => {
      if (rowsEl) rowsEl.remove();
      if (actionsEl) actionsEl.remove();
      rowsEl = card.createDiv({ cls: "mugs-cred-form-rows" });
      advancedEl = null;
      if (kind === "local") {
        new Setting(rowsEl)
          .setName("Repository path")
          .setDesc("Absolute path to the existing clone — /home/user/repo and file:///home/user/repo both work.")
          .addText((t) => {
            t.setPlaceholder("/absolute/path/to/repo");
            t.setValue(baseUrl);
            t.onChange((v) => { baseUrl = v.trim(); refreshValidation(); });
          });
        new Setting(rowsEl)
          .setName("Label")
          .setDesc("A name for this account — filled in for you; edit if you like.")
          .addText((t) => {
            t.setValue(label);
            t.setPlaceholder("Label").onChange((v) => { labelTouched = true; label = v.trim(); refreshValidation(); });
          });
        buildActions();
        return;
      }

      if (kind === "gitlab") {
        const modeWrap = rowsEl.createDiv({ cls: "mugs-mode-choice mugs-auth-mode" });
        const mkAuthOpt = (val: "token" | "oauth", text: string): void => {
          const opt = modeWrap.createEl("label", { cls: "mugs-mode-option" });
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "mugs-gitlab-auth-mode";
          radio.checked = authMode === val;
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            authMode = val;
            testStatusEl.empty();
            buildRows();
            refreshValidation();
          });
          opt.appendChild(radio);
          opt.createEl("span", { text });
        };
        mkAuthOpt("token", "Access token (PAT / Project token)");
        mkAuthOpt("oauth", "Sign in with GitLab (OAuth)");
      }

      if (kind === "gitlab" && authMode === "oauth") {
        new Setting(rowsEl)
          .setName("Application ID (Client ID)")
          .setDesc("Create a non-confidential GitLab OAuth application with scopes: read_api, write_repository, read_user.")
          .addText((t) => {
            t.setPlaceholder("GitLab OAuth Application ID");
            t.setValue(oauthClientId);
            t.onChange((v) => { oauthClientId = v.trim(); });
          });
        const hint = rowsEl.createDiv({ cls: "mugs-oauth-hint" });
        hint.createEl("span", { text: `Redirect URI: ${DEFAULT_OAUTH_REDIRECT_URI} ` });
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "mugs-link-btn";
        copyBtn.textContent = "Copy URI";
        copyBtn.addEventListener("click", () => {
          void navigator.clipboard?.writeText(DEFAULT_OAUTH_REDIRECT_URI);
          new Notice("MUGS: copied OAuth redirect URI.");
        });
        hint.appendChild(copyBtn);
      } else {
        new Setting(rowsEl)
          .setName("Token")
          .setDesc("API token for this account — stored in this vault and never displayed.")
          .addText((t) => {
            t.setPlaceholder("Token").inputEl.type = "password";
            t.onChange((v) => { token = v; refreshValidation(); });
          });
        if (kind === "gitlab") {
          const linkRow = rowsEl.createDiv({ cls: "mugs-oauth-hint" });
          const a = document.createElement("a");
          a.className = "mugs-token-helper-link";
          a.href = buildGitLabCreateTokenUrl(baseUrl);
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "Create token in GitLab ↗";
          linkRow.appendChild(a);
          linkRow.createEl("span", {
            cls: "mugs-muted",
            text: " · For single-repo access, use a fine-grained or project token with read_api + write_repository and set Allowed repositories below.",
          });
        }
      }

      const advanced = rowsEl.createEl("details", { cls: "mugs-advanced-details" });
      advancedEl = advanced;
      advanced.open = kind === "forgejo"; // self-hosted only: the URL is required
      advanced.createEl("summary", { text: "Advanced options (self-hosted URL, label, repo filter)" });
      const advBody = advanced.createDiv({ cls: "mugs-advanced-body" });
      new Setting(advBody)
        .setName("Base URL")
        .setDesc("API endpoint, filled in for the provider. Change it only for a self-hosted instance.")
        .addText((t) => {
          t.setPlaceholder(providerOption(kind)?.endpointHint ?? "");
          t.setValue(baseUrl);
          t.onChange((v) => { baseUrl = v.trim(); refreshValidation(); });
        });
      new Setting(advBody)
        .setName("Label")
        .setDesc("A name for this account — filled in for you; edit if you like.")
        .addText((t) => {
          t.setValue(label);
          t.setPlaceholder("Label").onChange((v) => { labelTouched = true; label = v.trim(); refreshValidation(); });
        });
      if (!(kind === "gitlab" && authMode === "oauth")) {
        new Setting(advBody)
          .setName("Username")
          .setDesc("Optional username (GitLab shows the acting user).")
          .addText((t) => t.setPlaceholder("Username (optional)").onChange((v) => { username = v.trim(); }));
      }
      new Setting(advBody)
        .setName("Allowed repositories")
        .setDesc("Optional owner/repo per line to restrict which repos this account may access (works with OAuth too).")
        .addTextArea((ta) => ta.setPlaceholder("owner/repo\nowner/other-repo").onChange((v) => { repos = parseGlobList(v); refreshValidation(); }));
      buildActions();
    };

    const buildActions = (): void => {
      if (actionsEl) actionsEl.remove();
      if (kind === "gitlab" && authMode === "oauth") {
        actionsEl = this.actions([
          { text: "Sign in with GitLab", cta: true, onClick: () => void startOAuthSignIn() },
        ]);
      } else {
        actionsEl = this.actions([
          { text: "Test connection", onClick: () => void testConnection() },
          {
            text: "Add account",
            cta: true,
            onClick: () => {
              attempted = true;
              refreshValidation();
              const errors = currentProblems().filter((p) => p.level === "error");
              if (errors.length > 0) {
                new Notice(`MUGS: fix these before adding the account:\n· ${errors.slice(0, 4).map((p) => p.message).join("\n· ")}`, 10000);
                return;
              }
              try {
                // Local paths are normalized to file:// here so data.json always
                // stores a valid URL (schema requires z.string().url()).
                const storedBaseUrl = kind === "local" ? normalizeLocalBaseUrl(baseUrl) : baseUrl || undefined;
                this.edit((d) => d.upsertCredential({
                  id: newId(),
                  label,
                  kind,
                  username: kind === "local" ? undefined : (username || undefined),
                  token: kind === "local" ? "" : token,
                  baseUrl: storedBaseUrl || undefined,
                  repos: repos.length ? repos : undefined,
                }));
                // Commit immediately — no "Apply settings to save" limbo. Re-render
                // also refreshes the Connect-folders form so repos load right away.
                void this.commitNow(`MUGS: account "${label}" added.`);
              } catch (e) {
                new Notice(`MUGS: could not save credential — ${errorMessage(e)}`);
              }
            },
          },
        ]);
      }
      card.appendChild(actionsEl);
    };

    new Setting(card)
      .setName("Provider")
      .setDesc("Where your repositories are hosted. The API endpoint is filled in for you.")
      .addDropdown((d) => {
        for (const option of PROVIDER_OPTIONS) d.addOption(option.kind, option.label);
        d.setValue(kind).onChange((v) => {
          kind = v as Credential["kind"];
          if (kind !== "gitlab") authMode = "token";
          baseUrl = prefillBaseUrl(kind);
          token = "";
          if (!labelTouched) label = providerOption(kind)?.label ?? kind;
          testStatusEl.empty();
          buildRows(); // hosted ↔ local show different fields
          // No markUnsaved: nothing is stored yet — showing the "Unsaved
          // changes" banner on an unfilled form would be noise.
          refreshValidation();
        });
      });

    /** Explicit, opt-in live probe: build the provider from the in-form values and
     *  list repos, so the user finds out now whether the account works. */
    const testConnection = async (): Promise<void> => {
      testStatusEl.empty();
      if (kind === "local") {
        const p = validateBaseUrl("local", baseUrl);
        testStatusEl.createEl("div", {
          cls: p ? "mugs-field-error" : "mugs-test-ok",
          text: p ? p.message : "Local path looks valid — MUGS will use this existing clone.",
        });
        return;
      }
      if (!baseUrl) {
        testStatusEl.createEl("div", { cls: "mugs-field-error", text: "Enter your instance's API endpoint first." });
        return;
      }
      if (!token) {
        testStatusEl.createEl("div", { cls: "mugs-field-error", text: "Enter a token to test the connection." });
        return;
      }
      testStatusEl.createEl("div", { cls: "mugs-field-hint", text: "Testing…" });
      try {
        const provider = buildProvider(
          { kind, baseUrl, token, allowedRepos: repos.length ? repos : undefined },
          { actingUsername: username || undefined },
        );
        const list = await provider.listRepos();
        testStatusEl.empty();
        if (list.length === 0) {
          testStatusEl.createEl("div", {
            cls: "mugs-field-warn",
            text: "Connected, but this token sees no repositories. Check its scope or the Allowed repositories list.",
          });
        } else {
          testStatusEl.createEl("div", {
            cls: "mugs-test-ok",
            text: `Connected — ${list.length} repositor${list.length === 1 ? "y" : "ies"} visible.`,
          });
        }
      } catch (e) {
        testStatusEl.empty();
        testStatusEl.createEl("div", { cls: "mugs-field-error", text: `Could not connect — ${errorMessage(e)}` });
      }
    };

    buildRows();
    refreshValidation();
  }
  /** Connect assistant: pick an account → pick a repo → choose whole-repo root
   *  sync or specific folders (with a custom-pair escape hatch) → connect.
   *  Whole-repo mappings get a fresh unique id plus repoRef/repoPath so they
   *  resolve across token scopes; local repositories default to root sync so
   *  connecting an existing clone works out of the box. Connecting commits
   *  immediately and kicks the scheduler so the first sync starts at once. */
  private async addMappingForm(card: HTMLElement): Promise<void> {
    // Always read FRESH credentials from the draft view: an account added a
    // moment ago (immediate commit + re-render) must be selectable here.
    const creds = this.view().credentials;
    if (creds.length === 0) {
      card.createEl("p", { cls: "mugs-muted", text: "Add an account above first to connect a repository." });
      return;
    }
    let providerId = creds[0]?.id ?? "";
    let direction: SyncDirection = "push-pull";
    let branch = "";
    let includesText = "";
    let excludesText = "";
    // REST repo selection: repoRef (repo.id) + repoPath (owner/repo) are stored on
    // mappings so the driver + clone manager resolve them against one shared clone
    // across token scopes.
    let repoRef = "";
    let repoKey = "";
    let reposCache: RepoSummary[] = [];
    let syncTrash = false; // whole-repo sub-option: include the repo's .trash folder (consistent default: off)
    let mode: "folders" | "root" = creds[0]?.kind === "local" ? "root" : "folders";
    let selectedFolders = new Set<string>(); // matched remote paths the user checked to link
    let matches: FolderMatch[] = [];       // exact name matches (top-level only)
    let fuzzyMatches: Array<{ remotePath: string; localFolder: string; label: string; score: number }> = [];
    let customVault = "";                  // custom folder-pair escape hatch (folder mode)
    let customRepo = "";

    // Local folders already claimed by an existing mapping (draft view — a mapping
    // added earlier in THIS draft session already claims its folder). Matched folders
    // whose localFolder is in this set are shown as disabled rows with a "Mapped" badge
    // so users see what's taken and why, rather than silently losing the choice.
    const usedLocalFolders = new Set(
      this.view().mappings.map((x) => x.localFolder),
    );
    const isRest = (): boolean => {
      const cred = this.view().credentials.find((c) => c.id === providerId);
      return !!cred && cred.kind !== "local";
    };

    // --- Account selector (only when there is a real choice to make) ---------
    if (creds.length > 1) {
      new Setting(card)
        .setName("Account")
        .setDesc("Choose the account for these folders.")
        .addDropdown((d) => {
          for (const c of creds) d.addOption(c.id, c.label);
          d.setValue(providerId).onChange(async (v) => {
            providerId = v; // CRITICAL: never list repos for — or save mappings against —
            // anything but the account the user actually picked.
            mode = this.view().credentials.find((c) => c.id === v)?.kind === "local" ? "root" : "folders";
            selectedFolders.clear();
            await refreshRepos();
          });
        });
    }

    // --- Repository selector + refresh ---------------------------------------
    const repoSelWrap = card.createDiv({ cls: "mugs-repo-select-wrap" });
    const loadingEl = repoSelWrap.createDiv({ cls: "mugs-loading-row", text: "" });
    const spinner = loadingEl.createEl("span", { cls: "mugs-loading" });
    loadingEl.createEl("span", { text: "Loading repositories…" });
    loadingEl.style.display = "none";
    const repoRow = card.createDiv({ cls: "mugs-repo-row" });
    const repoSel = repoRow.createEl("select", { cls: "mugs-repo-select" });
    repoSel.setAttribute("aria-label", "Repository");
    const refreshBtn = repoRow.createEl("button", { cls: "mugs-link-btn mugs-repo-refresh", text: "Refresh" });
    refreshBtn.setAttribute("type", "button");
    refreshBtn.setAttribute("aria-label", "Refresh repositories");
    refreshBtn.addEventListener("click", () => void refreshRepos());

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
        const cred = this.view().credentials.find((c) => c.id === providerId);
        if (!cred) { repoSel.disabled = true; return; }
        // Runtime/OAuth-refreshed token first; fall back to the DRAFT credential.
        const resolve = (this.plugin as unknown as { resolveToken?: (id: string) => Promise<string | undefined> }).resolveToken;
        const token = (typeof resolve === "function" ? await resolve.call(this.plugin, providerId) : undefined)
          ?? this.plugin.store.getToken(providerId)
          ?? this.view().credentials.find((c) => c.id === providerId)?.token
          ?? "";
        if (!token) { new Notice("MUGS: enter a token or reconnect this account first."); repoSel.disabled = true; return; }
        const provider = buildProvider({ kind: cred.kind, baseUrl: cred.baseUrl, token, authMode: cred.authMode, allowedRepos: cred.repos }, { actingUsername: cred.username });
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
      selectedFolders.clear();
      fuzzyMatches = [];
      if (!isRest() || !repoKey) { matches = []; renderMatches(); return; }
      const cred = this.view().credentials.find((c) => c.id === providerId);
      if (!cred) { matches = []; renderMatches(); return; }
      try {
        const detectedDirs = await this.listDirectoriesFor(cred, repoKey, "");
        const vaultTop = await this.listVaultFolders();
        // Filter out dotfolders (.obsidian/.trash): .obsidian linking is deprecated (handled by the
        // Obsidian Config Sync section), and .trash is a whole-repo sub-option.
        const remoteDirs = detectedDirs.filter((d) => d !== ".obsidian" && d !== ".trash");
        matches = matchFolderPairs(remoteDirs, vaultTop);
        // Minimum engagement: pre-select the single exact match when there is
        // exactly one unambiguous, unclaimed folder pair — one fewer click, and
        // the user still confirms with "Connect selected folders".
        const freeExact = matches.filter((m) => !usedLocalFolders.has(m.localFolder));
        if (freeExact.length === 1) selectedFolders.add(freeExact[0].remotePath);
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
      selectedFolders.clear();
      repoRef = chosen.id;
      repoKey = chosen.pathWithNamespace;
      void refreshMatches();
    });

    // --- Mode choice: specific folders vs whole-repo root sync ----------------
    const modeEl = card.createDiv({ cls: "mugs-mode-choice" });
    const buildModeChoice = (): void => {
      modeEl.empty();
      const mk = (value: "folders" | "root", text: string): void => {
        const opt = modeEl.createEl("label", { cls: "mugs-mode-option" });
        const input = document.createElement("input");
        input.type = "radio";
        input.name = "mugs-connect-mode";
        input.checked = mode === value;
        input.addEventListener("change", () => {
          if (!input.checked) return;
          mode = value;
          renderMatches();
        });
        opt.appendChild(input);
        opt.createEl("span", { text });
      };
      mk("folders", "Sync specific folders");
      mk("root", "Sync entire repository to vault root");
    };

    // --- Matched-folder panel (content depends on the chosen mode) -----------
    const matchesEl = card.createDiv({ cls: "mugs-matches" });
    const renderMatches = (): void => {
      // Clear before re-rendering: every previous re-render APPENDED, stacking
      // duplicate rows and stale rows from the prior repo.
      matchesEl.empty();
      if (mode === "root") {
        // Whole-repo root sync: folder checkboxes would only confuse (and
        // overlap). Warn when anything else is already connected, since '.'
        // overlaps every folder mapping.
        if (this.view().mappings.length > 0) {
          matchesEl.createEl("p", {
            cls: "mugs-cred-warning",
            text: "Heads up: existing connections already map this vault — syncing the entire repository to the vault root overlaps them.",
          });
        }
        // .trash sub-option (hosted repos only; local mappings get the toggle
        // on their card in the Sync section once connected).
        if (isRest() && repoKey) {
          const trashRow = matchesEl.createEl("label", { cls: "mugs-match-trash" });
          const trashInput = document.createElement("input");
          trashInput.type = "checkbox";
          trashInput.checked = syncTrash;
          trashInput.addEventListener("change", (e: Event) => { syncTrash = (e.target as HTMLInputElement).checked; });
          trashRow.appendChild(trashInput);
          trashRow.createEl("span", { text: "Include the repository's .trash/ folder" });
        }
      } else {
        // --- Exact matches (checkboxes) -----------------------------------------
        if (matches.length > 0) {
          const head = matchesEl.createEl("div", { cls: "mugs-matches-head" });
          head.textContent = "Choose folders to connect";
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
        } else if (!fuzzyMatches.length) {
          matchesEl.createEl("p", { cls: "mugs-muted", text: "No folders matched between this repo and your vault yet." });
        }

        // --- Fuzzy suggestions (one-click auto-match chips) ---------------------
        if (fuzzyMatches.length > 0) {
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

        // --- Custom folder pair escape hatch ------------------------------------
        const pair = matchesEl.createEl("details", { cls: "mugs-advanced-details mugs-custom-pair" });
        pair.createEl("summary", { text: "Map a custom folder pair" });
        const pairBody = pair.createDiv({ cls: "mugs-custom-pair-body" });
        new Setting(pairBody)
          .setName("Vault folder")
          .setDesc("Vault folder to fill, e.g. Notes.")
          .addText((t) => t.setPlaceholder("Vault folder (e.g. Notes)").onChange((v) => { customVault = v.trim(); }));
        new Setting(pairBody)
          .setName("Repository folder")
          .setDesc("Repository folder to sync from; leave empty for the repository root.")
          .addText((t) => t.setPlaceholder("Repository folder (empty = root)").onChange((v) => { customRepo = v.trim().replace(/^\/+|\/+$/g, ""); }));
      }

      // Dynamic CTA: the label tracks the chosen mode.
      connectBtn.textContent = mode === "root" ? "Connect vault root" : "Connect selected folders";
    };

    // --- Direction + advanced (branch, file filters) --------------------------
    new Setting(card)
      .setName("Direction")
      .setDesc("Upload, download, or sync both ways.")
      .addDropdown((d) => {
        for (const value of ["push-pull", "pull-only", "push-only"] as const) {
          d.addOption(value, directionLabel(value));
        }
        d.setValue(direction).onChange((v) => { direction = v as SyncDirection; });
      });

    const advanced = card.createEl("details", { cls: "mugs-advanced-details" });
    advanced.createEl("summary", { text: "Advanced (branch, file filters)" });
    const advBody = advanced.createDiv({ cls: "mugs-advanced-body" });
    new Setting(advBody)
      .setName("Branch")
      .setDesc("Optional branch to sync. Leave empty for the default branch.")
      .addText((t) => t.setPlaceholder("Branch (optional)").onChange((v) => { branch = v.trim(); }));
    advBody.appendChild(this.managePanel("Only sync matching files", includesText, (v) => { includesText = v; }, "Optional patterns, one per line (e.g. *.md). Leave empty for all files."));
    advBody.appendChild(this.managePanel("Skip matching files", excludesText, (v) => { excludesText = v; }, "Patterns to skip, one per line (e.g. drafts/**). Uses .gitignore syntax."));

    // --- Connect (commits immediately) ----------------------------------------
    const actionsWrap = card.createDiv({ cls: "mugs-actions" });
    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.className = "mod-cta";
    connectBtn.addEventListener("click", () => void connect());
    actionsWrap.appendChild(connectBtn);
    card.appendChild(actionsWrap);

    const connect = async (): Promise<void> => {
      try {
        const cred = this.view().credentials.find((c) => c.id === providerId);
        if (!providerId || !cred) { new Notice("MUGS: choose an account first."); return; }
        if (cred.kind !== "local" && !repoRef) { new Notice("MUGS: choose a repository."); return; }
        const scope = { includes: parseGlobList(includesText), excludes: parseGlobList(excludesText) };
        let count = 0;
        if (mode === "root") {
          // Whole-repo root sync: a FRESH unique id (never the repo id — that
          // breaks resolveRepo across token scopes) + repoRef/repoPath so the
          // mapping resolves no matter which token lists the repo.
          this.edit((d) => d.upsertMapping({
            id: newId(),
            label: repoKey || cred.label || "Vault root",
            remotePath: "",
            localFolder: ".",
            providerId,
            repoRef: repoRef || undefined,
            // Structural cast: FolderMapping may not carry repoPath yet in this
            // worktree (the root-sync branch adds it); harmless either way.
            ...(repoKey ? { repoPath: repoKey } : {}),
            branch: branch || undefined,
            direction,
            ...scope,
            syncTrashFolder: syncTrash ? undefined : false,
          } as FolderMapping));
          count = 1;
        } else {
          // Each checked folder becomes its own scoped card sharing the repo's
          // clone via repoRef. Lookups check EXACT matches AND fuzzy
          // suggestions — a fuzzy pick must not be silently dropped.
          for (const remotePath of selectedFolders) {
            const match = matches.find((m) => m.remotePath === remotePath)
              ?? fuzzyMatches.find((m) => m.remotePath === remotePath);
            if (!match) continue;
            this.edit((d) => d.upsertMapping({
              id: newId(), label: match.label, remotePath, localFolder: match.localFolder,
              providerId, branch: branch || undefined, direction, repoRef,
              ...(repoKey ? { repoPath: repoKey } : {}), ...scope,
            } as FolderMapping));
            count += 1;
          }
          // Custom pair escape hatch: connect folders even when their names
          // don't already exist on both sides.
          if (customVault) {
            this.edit((d) => d.upsertMapping({
              id: newId(), label: customVault, remotePath: customRepo, localFolder: customVault,
              providerId, branch: branch || undefined, direction, repoRef,
              ...(repoKey ? { repoPath: repoKey } : {}), ...scope,
            } as FolderMapping));
            count += 1;
          }
          if (count === 0) { new Notice("MUGS: check at least one folder to link, or map a custom folder pair."); return; }
        }
        // Surface direction/first-sync consequences as the pass kicks off.
        const consequence = direction === "pull-only"
          ? "Download only: repository files update this vault; your edits aren't uploaded."
          : direction === "push-only"
            ? "Upload only: your files update the repository; repository changes aren't downloaded."
            : "Both ways: upload and download changes. Conflicts need your review.";
        const first = this.view().sync.firstSyncDirection === "push"
          ? "first sync starts by UPLOADING this device's eligible text files; unknown repository files stay for Review."
          : "first sync starts by DOWNLOADING eligible repository text files; conflicts or unknown deletions need review.";
        // Commit immediately — the scheduler is kicked inside applySettings, so
        // the first sync starts right away instead of on the next poll.
        await this.commitNow(mode === "root"
          ? `MUGS: "${repoKey || cred.label}" connected to the vault root.`
          : `MUGS: ${count} folder${count === 1 ? "" : "s"} connected.`);
        new Notice(`MUGS — what happens next:\n· ${consequence}\n· ${first}`, 12000);
      } catch (e) {
        new Notice(`MUGS: could not save mapping — ${errorMessage(e)}`);
      }
    };

    buildModeChoice();
    renderMatches();
    void refreshRepos();
  }
  /** List child directories of `repoKey` at `path` for a credential's provider. */
  private async listDirectoriesFor(cred: Credential, repoKey: string, path: string): Promise<string[]> {
    const resolve = (this.plugin as unknown as { resolveToken?: (id: string) => Promise<string | undefined> }).resolveToken;
    const token = (typeof resolve === "function" ? await resolve.call(this.plugin, cred.id) : undefined)
      ?? this.plugin.store.getToken(cred.id)
      ?? cred.token
      ?? "";
    if (!token) return [];
    try {
      const provider = buildProvider({ kind: cred.kind, baseUrl: cred.baseUrl, token, authMode: cred.authMode }, { actingUsername: cred.username });
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
