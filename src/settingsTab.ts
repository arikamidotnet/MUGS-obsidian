/**
 * MUGS — Multi-User Git Sync
 * Settings tab. Renders credentials, folder mappings and security options, with
 * working add/delete controls backed by the store (Phase 1/4). Kept thin so it
 * never runs in unit tests (it imports the Obsidian DOM API).
 */
import { PluginSettingTab, Setting, Notice } from "obsidian";
import type MugsPlugin from "./main";
import type { Credential, SyncDirection } from "./types";
import { INTERVAL_PRESETS, resolveIntervalSeconds, presetIdForSeconds } from "./sync/cadence";

// The shipped obsidian typings declare addToggle/addText/addButton on Setting but
// not addSelect, even though it is a real API. Augment the module so our native
// select builder typechecks (same pattern as Plugin.addStyleTag in main.ts).
declare module "obsidian" {
  interface Setting {
    addSelect(callback: (component: MugsSelectComponent) => void): this;
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
        card.createEl("p", { cls: "mags-muted", text: "No mappings yet." });
      } else {
        for (const m of mappings) {
          new Setting(card)
            .setName(m.label)
            .setDesc(`${m.remotePath || "(repo root)"} → ${m.localFolder} · ${m.direction}`)
            .addButton((b) =>
              b.setButtonText("Delete").onClick(() => {
                this.plugin.store.removeMapping(m.id);
                void this.plugin.store.save();
                this.display();
              }),
            );
          // Editable include/exclude scope for this mapping (Area 1). Preserves all
          // other fields via upsertMapping; changes persist on blur/change.
          card.appendChild(this.scopeField(m, "includes"));
          card.appendChild(this.scopeField(m, "excludes"));
        }
      }

      card.createEl("div", { cls: "mugs-divider" });
      this.addMappingForm(card);
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
        .addSelect((d) => {
          for (const v of ["both", "theirs", "ours"]) d.addOption(v, v);
          d
            .setValue(sync.defaultResolution)
            .onChange(async (v) => {
              this.plugin.store.setSync({ defaultResolution: v as "both" | "theirs" | "ours" });
              await this.plugin.store.save();
            });
        });

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
        .addSelect((d) => {
          for (const p of INTERVAL_PRESETS) d.addOption(p.id, p.label);
          d
            .setValue(presetIdForSeconds(sync.intervalSeconds))
            .onChange(async (v) => {
              this.plugin.store.setSync({ intervalSeconds: resolveIntervalSeconds(v) });
              await this.plugin.store.save();
            });
        });

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
            }),
        );

      const summary = card.createEl("p", { cls: "mags-muted" });
      summary.textContent =
        "Shared by default: themes, snippets, templates, global.css, plugins/manifest.json. " +
        "Local by default: settings.json, core.json, workspace.json, recent-files.json, keymaps.json, and each plugin's data.json.";
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
    const card = document.createElement("div");
    card.className = "mugs-section";
    body(card);
    containerEl.appendChild(card);
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

  /** An editable include/exclude textarea bound to one mapping's scope. */
  private scopeField(mapping: { id: string }, kind: "includes" | "excludes"): HTMLElement {
    const current = this.plugin.store.getSettings().mappings.find((x) => x.id === mapping.id);
    const value = (current?.[kind] ?? []).join("\n");
    const hint =
      kind === "includes"
        ? "Only these globs sync within the scope (optional). Leave empty for everything."
        : "These globs never sync (gitignore-style; '!' re-includes).";
    const wrap = document.createElement("div");
    wrap.className = "mugs-field";
    const lbl = document.createElement("label");
    lbl.textContent = kind === "includes" ? "Includes" : "Excludes";
    wrap.appendChild(lbl);
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.rows = 2;
    ta.style.width = "100%";
    ta.className = "mugs-textarea";
    ta.placeholder = hint;
    ta.addEventListener("change", (e: Event) => {
      const lines = parseGlobList((e.target as HTMLTextAreaElement).value);
      this.saveMappingScope(mapping.id, { [kind]: lines });
    });
    wrap.appendChild(ta);
    return wrap;
  }

  /** Add-credential form: provider picker + label/username/token/base-url fields. */
  private addCredentialForm(card: HTMLElement): void {
    let kind: Credential["kind"] = "gitlab";
    let label = "";
    let username = "";
    let token = "";
    let baseUrl = "";

    const grid = document.createElement("div");
    grid.className = "mugs-form-grid";

    const addField = (name: string, input: HTMLInputElement | HTMLSelectElement): void => {
      grid.appendChild(this.field(name, input));
    };

    addField("Provider", this.selectOption((v) => { kind = v as Credential["kind"]; }, [
      ["gitlab", "GitLab"],
      ["github", "GitHub"],
      ["bitbucket", "Bitbucket"],
      ["gitea", "Gitea / Forgejo"],
      ["local", "Local (existing clone)"],
    ]));
    addField("Label", this.text((v) => { label = v.trim(); }, "Label"));
    addField("Username", this.text((v) => { username = v.trim(); }, "Username (optional)"));
    addField("Token", this.password((v) => { token = v; }, "Token"));
    addField("Base URL", this.text((v) => { baseUrl = v.trim(); }, "Base URL (optional, incl. /api/v4)"));

    grid.appendChild(this.actions([
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

    card.appendChild(grid);
  }

  /** Add-mapping form: provider picker + label/remote-path/local-folder/direction. */
  private addMappingForm(card: HTMLElement): void {
    const creds = this.plugin.store.getSettings().credentials;
    let label = "";
    let remotePath = "";
    let localFolder = "";
    let providerId = creds[0]?.id ?? "";
    let branch = "";
    let direction: SyncDirection = "push-pull";
    let includesText = "";
    let excludesText = "";

    const grid = document.createElement("div");
    grid.className = "mugs-form-grid";

    const addField = (name: string, input: HTMLInputElement | HTMLSelectElement): void => {
      grid.appendChild(this.field(name, input));
    };

    addField("Provider", this.selectOption((v) => { providerId = v; }, creds.map((c) => [c.id, c.label] as [string, string]), creds.length === 0));
    addField("Label", this.text((v) => { label = v.trim(); }, "Label"));
    addField("Remote path", this.text((v) => { remotePath = v.trim(); }, "Remote path (optional)"));
    addField("Vault folder", this.text((v) => { localFolder = v.trim(); }, "Vault folder, e.g. Notes"));
    addField("Direction", this.selectOption((v) => { direction = v as SyncDirection; }, [
      ["push-pull", "Push + pull"],
      ["pull-only", "Pull only"],
      ["push-only", "Push only"],
    ]));
    addField("Branch", this.text((v) => { branch = v.trim(); }, "Branch (optional)"));
    // Scope scoping for this mapping (Area 1): include/exclude gitignore globs.
    grid.appendChild(this.scopeTextareaField("Includes (optional)", (v) => { includesText = v; }));
    grid.appendChild(this.scopeTextareaField("Excludes (optional)", (v) => { excludesText = v; }));

    grid.appendChild(this.actions([
      {
        text: "Add mapping",
        cta: true,
        disabled: creds.length === 0,
        onClick: async () => {
          if (!label || !localFolder) { new Notice("MUGS: enter a label and vault folder."); return; }
          if (!providerId) { new Notice("MUGS: choose a credential/provider."); return; }
          try {
            this.plugin.store.upsertMapping({
              id: newId(),
              label,
              remotePath,
              localFolder,
              providerId,
              branch: branch || undefined,
              direction,
              includes: parseGlobList(includesText),
              excludes: parseGlobList(excludesText),
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

    card.appendChild(grid);
  }

  /** Create a labeled form-field wrapper (label + native input styled by Obsidian). */
  private field(label: string, input: HTMLInputElement | HTMLSelectElement): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "mugs-field";
    if (label) {
      const lbl = document.createElement("label");
      lbl.textContent = label;
      wrap.appendChild(lbl);
    }
    wrap.appendChild(input);
    return wrap;
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
