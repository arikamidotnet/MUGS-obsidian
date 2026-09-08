/**
 * MUGS — Multi-User Git Sync
 * Settings tab shell. Phase 0 renders the structure only; real controls for
 * each provider/mapping land in later phases. Kept thin so it never runs in
 * unit tests (it imports the Obsidian DOM API).
 */
import { PluginSettingTab, Setting, Notice } from "obsidian";
import type MugsPlugin from "./main";

export class MugsSettingTab extends PluginSettingTab {
  constructor(private plugin: MugsPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Credentials / providers -------------------------------------------
    containerEl.createEl("h2", { text: "Credentials & Providers" });
    containerEl.createEl("p", {
      text: "Store per-user tokens inside this vault. Tokens are never shown in full and can be encrypted at rest.",
    });

    const creds = this.plugin.store.getDisplaySettings().credentials;
    for (const c of creds) {
      new Setting(containerEl)
        .setName(`${c.label} (${c.kind})`)
        .setDesc(`token: ${c.token}`)
        .addButton((b) =>
          b.setButtonText("Delete").onClick(() => {
            this.plugin.store.removeCredential(c.id);
            void this.plugin.store.save();
            this.display();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Add credential")
      .setDesc("Phase 1: provider picker (GitLab/GitHub/Bitbucket/Local) + token field.")
      .addButton((b) =>
        b.setButtonText("Coming soon").setDisabled(true),
      );

    // --- Folder mappings ----------------------------------------------------
    containerEl.createEl("h2", { text: "Folder Mappings" });
    containerEl.createEl("p", {
      text: "Map remote paths to vault folders for fine-grained, per-user sync.",
    });

    const mappings = this.plugin.store.getDisplaySettings().mappings;
    if (mappings.length === 0) {
      containerEl.createEl("p", {
        text: "No mappings yet. Add one in Phase 1.",
        cls: "mugs-muted",
      });
    } else {
      for (const m of mappings) {
        new Setting(containerEl)
          .setName(m.label)
          .setDesc(`${m.remotePath || "(repo root)"} → ${m.localFolder} · ${m.direction}`);
      }
    }

    // --- Security -----------------------------------------------------------
    containerEl.createEl("h2", { text: "Security & Credentials" });
    new Setting(containerEl)
      .setName("Encrypt credentials at rest")
      .setDesc(
        "When on, stored tokens are encrypted in data.json instead of saved as-is.",
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.store.getSettings().security.encryptCredentials)
          .onChange(async (v) => {
            this.plugin.store.setSecurity({ encryptCredentials: v });
            await this.plugin.store.save();
            new Notice(`MUGS credentials ${v ? "encrypted" : "unencrypted"} at rest.`);
          }),
      );

    new Setting(containerEl)
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
  }
}
