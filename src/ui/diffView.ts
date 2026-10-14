/**
 * MUGS — Diff view (`mugs-diff`).
 *
 * Obsidian glue only: it offers a mapping + ref picker, asks the injected
 * {@link DiffDataSource} for a diff and per-file authors, then renders an
 * attributed inline diff. Parsing/attribution live in diffModel.ts (unit-tested);
 * this file never runs under vitest because it imports the Obsidian DOM API.
 */
import { ItemView, Notice } from "obsidian";
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

    // Compact comparison header — no big selectors. Mapping selection lives in the
    // MUGS settings tab; here we only show *where* to compare (mapping → ref).
    const header = controls.createDiv({ cls: "mugs-diff-range" });
    header.createSpan({ text: "Compare", cls: "mugs-diff-range-label" });

    if (rows.length > 1) {
      // Only surface a selector when there is genuinely more than one mapping.
      const select = header.createEl("select", { cls: "mugs-diff-mapping-select" });
      for (const r of rows) {
        const opt = select.createEl("option");
        opt.value = r.mapping.id;
        opt.textContent = r.mapping.label || r.mapping.id;
      }
      select.value = rows[0].mapping.id;
      this.selectedMappingId = rows[0].mapping.id;
      select.addEventListener("change", (e) => {
        this.selectedMappingId = (e.target as HTMLSelectElement).value;
        void this.showDiff(this.selectedMappingId, output);
      });
    } else {
      header.createSpan({ text: rows[0].mapping.label || rows[0].mapping.id, cls: "mugs-diff-mapping-name" });
      this.selectedMappingId = rows[0].mapping.id;
    }

    const refInput = header.createEl("input", { type: "text", cls: "mugs-diff-ref-input" });
    refInput.value = "HEAD";
    refInput.addEventListener("change", () =>
      void this.showDiff(this.selectedMappingId, output, refInput.value.trim() || "HEAD"),
    );
    header.createSpan({ text: "against last-synced baseline", cls: "mugs-diff-range-hint" });

    // Load the default mapping immediately.
    void this.showDiff(this.selectedMappingId, output);
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
