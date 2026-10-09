/**
 * MUGS — conflicts sidebar panel (`mugs-conflicts`).
 *
 * A right-sidebar panel (Manyana-style) listing every unresolved conflict across
 * all mappings, each labeled with what "ours" and "theirs" did (see
 * describeConflictActions) and offering Take ours / theirs / Merge both. It shares
 * the per-conflict row renderer with the full-tab Diff view so both surfaces look
 * identical. Uses Workspace.createPanelTab, which the shipped obsidian typings do
 * not declare — augmented below.
 */
import { Notice, type Plugin, type WorkspaceLeaf } from "obsidian";
import { getMugsContext } from "./dataSources";
import { renderConflictRow } from "./diffRender";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

// Obsidian's real API: `workspace.createPanelTab(plugin, viewClass)` returns a
// PanelTabView with containerEl + onOpen/onClose. The shipped typings omit it, so
// augment the module (same pattern as Plugin.addStyleTag in main.ts).
declare module "obsidian" {
  interface Workspace {
    createPanelTab(
      plugin: Plugin,
      viewClass: new (leaf: WorkspaceLeaf) => MugsPanelTab,
    ): MugsPanelTab;
  }
}

/** The minimal PanelTabView shape MUGS relies on. */
interface MugsPanelTab {
  containerEl: HTMLElement;
  onOpen(): Promise<void> | void;
  onClose(): Promise<void> | void;
}

interface ConflictGroup {
  mappingId: string;
  label: string;
  conflicts: FileConflict[];
}

export class MugsConflictsPanel implements MugsPanelTab {
  constructor(private leaf: WorkspaceLeaf) {}

  get containerEl(): HTMLElement {
    // WorkspaceLeaf exposes containerEl at runtime, but the shipped obsidian typings
    // only declare it on View; cast (same defensive style as main.ts).
    return (this.leaf as unknown as { containerEl: HTMLElement }).containerEl;
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  onClose(): Promise<void> {
    this.containerEl.empty();
    return Promise.resolve();
  }

  private async render(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("mugs-conflicts-panel");

    const header = this.containerEl.createDiv({ cls: "mugs-conflicts-panel-header" });
    header.createEl("h2", { text: "MUGS Conflicts", cls: "mugs-conflicts-panel-title" });
    const refresh = header.createEl("button", { type: "button", text: "Refresh", cls: "mugs-conflicts-panel-refresh" });
    refresh.addEventListener("click", () => void this.render());

    try {
      const groups = await this.loadGroups();
      this.renderBody(groups);
    } catch (err) {
      this.containerEl.empty();
      new Notice(`MUGS: could not load conflicts — ${err instanceof Error ? err.message : String(err)}`);
      void this.render();
    }
  }

  /** Collect each mapping's unresolved conflicts, skipping mappings with none. */
  private async loadGroups(): Promise<ConflictGroup[]> {
    const rows = await getMugsContext().map.getRows();
    const groups: ConflictGroup[] = [];
    for (const r of rows) {
      const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId: r.mapping.id });
      if (conflicts.length > 0) {
        groups.push({ mappingId: r.mapping.id, label: r.mapping.label || r.mapping.id, conflicts });
      }
    }
    return groups;
  }

  private renderBody(groups: ConflictGroup[]): void {
    const total = groups.reduce((n, g) => n + g.conflicts.length, 0);
    if (total === 0) {
      this.containerEl.createEl("p", { text: "No unresolved conflicts. 🎉", cls: "mags-muted" });
      return;
    }

    this.containerEl.createEl("p", {
      text: `${total} file${total === 1 ? "" : "s"} need manual resolution across ${groups.length} mapping${groups.length === 1 ? "" : "s"}.`,
      cls: "mags-muted",
    });

    for (const g of groups) {
      const section = this.containerEl.createDiv({ cls: "mugs-conflicts-panel-group" });
      section.createEl("h3", { text: g.label, cls: "mugs-conflicts-panel-group-title" });
      for (const c of g.conflicts) {
        renderConflictRow(section, c, (conflict, choice) => void this.resolve(g.mappingId, conflict, choice));
      }
    }
  }

  /** Resolve one file's conflict for its mapping, persist it, then re-render. */
  private async resolve(mappingId: string, c: FileConflict, choice: ResolveChoice): Promise<void> {
    try {
      const res = await getMugsContext().conflicts.resolveConflict({ mappingId, path: c.path, choice });
      new Notice(
        `MUGS — resolved ${c.path} (${choice}).${
          res.remaining > 0 ? ` ${res.remaining} file${res.remaining === 1 ? "" : "s"} still unresolved.` : " No conflicts remain."
        }`,
      );
      void this.render();
    } catch (err) {
      new Notice(`MUGS — could not resolve ${c.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
