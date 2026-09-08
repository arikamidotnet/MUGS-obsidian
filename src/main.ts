/**
 * MUGS — Multi-User Git Sync
 * Plugin entry point. Wires the store to Obsidian's loadData/saveData, registers
 * the settings tab, a ribbon menu item and a palette command (Phase 0 stubs).
 */
import { Plugin, Notice } from "obsidian";
import { MugsStore, MemoryIO } from "./store";
import { MugsSettingTab } from "./settingsTab";
import type { MugsSettings } from "./types";

export default class MugsPlugin extends Plugin {
  store: MugsStore = new MugsStore();

  async onload(): Promise<void> {
    // In Obsidian, IO is backed by loadData/saveData; MemoryIO covers tests.
    this.store = new MugsStore({
      read: () => this.loadData(),
      write: (data) => this.saveData(data as unknown),
    });

    await this.store.load();
    console.log("MUGS — Multi-User Git Sync loaded");

    this.addSettingTab(new MugsSettingTab(this));

    this.addRibbonIcon("git-branch", "MUGS: Sync now", async () => {
      new Notice("MUGS sync runner not implemented yet (Phase 1).");
    });

    this.addCommand({
      id: "show-settings",
      name: "Open MUGS settings",
      callback: () =>
        (this.app as unknown as { setting: { openToTab: (id: string) => void } })
          .setting
          .openToTab("mugs-obsidian"),
    });

    this.addCommand({
      id: "sync-now",
      name: "Run sync (push + pull) for all mappings",
      callback: () => {
        new Notice("MUGS sync runner not implemented yet (Phase 1).");
      },
    });
  }

  onunload(): void {
    console.log("MUGS unloaded");
  }
}

// Re-exported so settingsTab can `import type MugsPlugin from "./main"`.
export type { MugsSettings };
