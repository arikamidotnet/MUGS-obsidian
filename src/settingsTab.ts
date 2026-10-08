/**
 * MUGS — Multi-User Git Sync
 * Settings tab. Renders credentials, folder mappings and security options, with
 * working add/delete controls backed by the store (Phase 1/4). Kept thin so it
 * never runs in unit tests (it imports the Obsidian DOM API).
 */
import { PluginSettingTab, Setting, Notice } from "obsidian";
import type MugsPlugin from "./main";
import type { Credential, SyncDirection } from "./types";

/** Generate a stable id for new credentials/mappings. */
function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
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

  /** Wrap children in a single grouped settings card. */
  private section(containerEl: HTMLElement, body: (card: HTMLElement) => void): void {
    const card = document.createElement("div");
    card.className = "mugs-section";
    body(card);
    containerEl.appendChild(card);
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
