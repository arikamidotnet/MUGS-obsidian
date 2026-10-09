/**
 * MUGS — Diff view (`mugs-diff`).
 *
 * Obsidian glue only: it offers a mapping + ref picker, asks the injected
 * {@link DiffDataSource} for a diff and per-file authors, then renders an
 * attributed inline diff. Parsing/attribution live in diffModel.ts (unit-tested);
 * this file never runs under vitest because it imports the Obsidian DOM API.
 */
import { ItemView, Notice, Setting } from "obsidian";
import { parseUnifiedDiff, attributeHunks, type ParsedDiff } from "./diffModel";
import { renderConflicts, renderDiff } from "./diffRender";
import { getMugsContext } from "./dataSources";
import type { FileConflict } from "../sync/conflict";
import type { ResolveChoice } from "../sync/conflict";

export class DiffView extends ItemView {
  /** Mapping currently shown (kept so a resolution can re-render the same view). */
  private selectedMappingId = "";

  getViewType(): string {
    return "mugs-diff";
  }

  getDisplayText(): string {
    return "MUGS Diff";
  }

  getIcon(): string {
    return "git-commit";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("mugs-diff-view");
    this.addAction("refresh", "Reload diff", () => void this.render());
    await this.render();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async render(): Promise<void> {
    try {
      const rows = await getMugsContext().map.getRows();
      if (rows.length === 0) {
        this.contentEl.createEl("p", { text: "No folder mappings yet. Add one in the MUGS settings." });
        return;
      }
      this.renderPicker(rows);
    } catch (err) {
      this.contentEl.empty();
      new Notice(`MUGS: could not load diff — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private renderPicker(rows: { mapping: { id: string; label: string } }[]): void {
    const controls = this.contentEl.createDiv({ cls: "mugs-diff-controls" });
    const output = this.contentEl.createDiv({ cls: "mugs-diff-output" });

    new Setting(controls)
      .setName("Mapping")
      .addDropdown((d) =>
        d.addOptions(
          Object.fromEntries(rows.map((r) => [r.mapping.id, r.mapping.label || r.mapping.id])),
        )
        .setValue(rows[0].mapping.id)
        .onChange(async (mappingId) => {
          this.selectedMappingId = mappingId;
          await this.showDiff(mappingId, output);
        }),
      );

    let selectedMappingId = rows[0].mapping.id;

    new Setting(controls)
      .setName("Mapping")
      .addDropdown((d) =>
        d.addOptions(
          Object.fromEntries(rows.map((r) => [r.mapping.id, r.mapping.label || r.mapping.id])),
        )
        .setValue(selectedMappingId)
        .onChange(async (mappingId) => {
          selectedMappingId = mappingId;
          await this.showDiff(mappingId, output);
        }),
      );

    const refSetting = new Setting(controls)
      .setName("Ref (to)")
      .addText((t) =>
        t.setPlaceholder("HEAD")
          .setValue("HEAD")
          .onChange(async (ref) => void this.showDiff(selectedMappingId, output, ref)),
      );

    new Setting(controls).addButton((b) =>
      b.setButtonText("Show diff").onClick(async () => {
        const ref = (refSetting.descEl.querySelector('input[type="text"]') as HTMLInputElement | null)?.value || "HEAD";
        await this.showDiff(selectedMappingId, output, ref);
      }),
    );

    // Load the default mapping immediately.
    void this.showDiff(selectedMappingId, output);
  }

  private async showDiff(
    mappingId: string,
    output: HTMLElement,
    ref = "HEAD",
  ): Promise<void> {
    output.empty();
    this.selectedMappingId = mappingId;
    try {
      // Surface any unresolved conflicts above the diff so they are never missed.
      const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId });
      renderConflicts(conflicts, output, (c, choice) => void this.resolveFile(c, choice));
      const { diffText, authorsByFile } = await getMugsContext().diff.getDiff({ mappingId, ref });
      if (!diffText.trim()) {
        output.createEl("p", {
          text: "No comparison available for this mapping yet — sync it first so a baseline exists.",
          cls: "mags-muted",
        });
        return;
      }
      const parsed = attributeHunks(parseUnifiedDiff(diffText), authorsByFile);
      renderDiff(parsed, output);
    } catch (err) {
      output.createEl("p", {
        text: `Could not load diff — ${err instanceof Error ? err.message : String(err)}`,
        cls: "mugs-muted",
      });
    }
  }

  /** Resolve one file's conflict, persist it (working-tree write + store), then re-render. */
  private async resolveFile(c: FileConflict, choice: ResolveChoice): Promise<void> {
    try {
      const res = await getMugsContext().conflicts.resolveConflict({ mappingId: this.selectedMappingId, path: c.path, choice });
      const left = res.remaining;
      new Notice(
        `MUGS — resolved ${c.path} (${choice}).${
          left > 0 ? ` ${left} file${left === 1 ? "" : "s"} still unresolved.` : " No conflicts remain."
        }`,
      );
      void this.render();
    } catch (err) {
      new Notice(`MUGS — could not resolve ${c.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

}
