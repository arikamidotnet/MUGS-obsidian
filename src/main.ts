/**
 * MUGS — Multi-User Git Sync
 * Plugin entry point. Wires the store to Obsidian's loadData/saveData, registers
 * the settings tab, ribbon entries and palette commands (Phase 0/1), plus the
 * Map/Diff views and their data sources (Phase 4).
 */
import { Plugin, Notice } from "obsidian";
import { MugsStore, MemoryIO } from "./store";
import { MugsSettingTab } from "./settingsTab";
import { MapView } from "./ui/mapView";
import { DiffView } from "./ui/diffView";
import { setMugsContext } from "./ui/dataSources";
import { StoreMapDataSource, StoreDiffDataSource, DEFAULT_CLONE_DIRNAME } from "./ui/defaultDataSources";
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

    // --- Phase 4: view data sources + registered views ---------------------
    // Clones live under <vault>/.mugs-clones; the data sources resolve each
    // mapping's clone dir from its providerId/id (see sync/cloneManager).
    // getBasePath lives on the desktop adapter; cast so this typechecks against
    // the abstract DataAdapter shape declared in obsidian.d.ts.
    const basePath = (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
    const cloneRoot = `${basePath}/${DEFAULT_CLONE_DIRNAME}`;
    setMugsContext({
      map: new StoreMapDataSource(this.store, cloneRoot),
      diff: new StoreDiffDataSource(this.store, cloneRoot),
    });
    this.registerView("mugs-map", (leaf) => new MapView(leaf));
    this.registerView("mugs-diff", (leaf) => new DiffView(leaf));

    this.addSettingTab(new MugsSettingTab(this));

    this.addRibbonIcon("git-branch", "MUGS: Sync now", async () => {
      new Notice("MUGS sync runner not implemented yet (Phase 1).");
    });
    this.addRibbonIcon("map", "Open MUGS Map", async () => void this.openView("mugs-map"));
    this.addRibbonIcon("git-commit", "Open MUGS Diff", async () => void this.openView("mugs-diff"));

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

    this.addCommand({
      id: "show-map",
      name: "Show MUGS Map (folder→repo graph)",
      callback: () => void this.openView("mugs-map"),
    });

    this.addCommand({
      id: "show-diff",
      name: "Show MUGS Diff (per-author changes)",
      callback: () => void this.openView("mugs-diff"),
    });
  }

  /** Open (or activate) a registered custom view in its own leaf. */
  private async openView(type: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type, active: true });
  }

  onunload(): void {
    console.log("MUGS unloaded");
  }
}

// Re-exported so settingsTab can `import type MugsPlugin from "./main"`.
export type { MugsSettings };
