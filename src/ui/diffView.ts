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
import { getMugsContext } from "./dataSources";

export class DiffView extends ItemView {
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
        .onChange(async (mappingId) => void this.showDiff(mappingId, output)),
      );

    new Setting(controls)
      .setName("Ref (to)")
      .addText((t) =>
        t.setPlaceholder("HEAD")
          .setValue("HEAD")
          .onChange(async (ref) => void this.showDiff(rows[0].mapping.id, output, ref)),
      );

    new Setting(controls).addButton((b) =>
      b.setButtonText("Show diff").onClick(async () => {
        const mappingId = controls.querySelector("select")?.value ?? rows[0].mapping.id;
        const ref = (controls.querySelector('input[type="text"]') as HTMLInputElement | null)?.value || "HEAD";
        await this.showDiff(mappingId, output, ref);
      }),
    );

    // Load the default mapping immediately.
    void this.showDiff(rows[0].mapping.id, output);
  }

  private async showDiff(
    mappingId: string,
    output: HTMLElement,
    ref = "HEAD",
  ): Promise<void> {
    output.empty();
    try {
      const { diffText, authorsByFile } = await getMugsContext().diff.getDiff({ mappingId, ref });
      if (!diffText.trim()) {
        output.createEl("p", {
          text: "No comparison available for this mapping yet — sync it first so a baseline exists.",
          cls: "mugs-muted",
        });
        return;
      }
      const parsed = attributeHunks(parseUnifiedDiff(diffText), authorsByFile);
      this.renderDiff(parsed, output);
    } catch (err) {
      output.createEl("p", {
        text: `Could not load diff — ${err instanceof Error ? err.message : String(err)}`,
        cls: "mugs-muted",
      });
    }
  }

  private renderDiff(parsed: ParsedDiff, host: HTMLElement): void {
    if (parsed.files.length === 0) {
      host.createEl("p", { text: "Nothing changed in this range.", cls: "mugs-muted" });
      return;
    }

    for (const file of parsed.files) {
      const block = host.createDiv({ cls: "mugs-diff-file" });
      block.createEl("h4", { text: file.name, cls: "mugs-diff-filename" });

      for (const hunk of file.hunks) {
        if (hunk.author) {
          block.createDiv({ cls: "mugs-diff-author" }).createSpan({
            text: `by ${hunk.author}${hunk.email ? ` <${hunk.email}>` : ""}`,
            cls: "mugs-diff-author-badge",
          });
        }
        const table = block.createEl("table", { cls: "mugs-diff-hunk" });
        for (const line of hunk.lines) {
          const row = table.insertRow();
          const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
          row.insertCell().createSpan({ text: sign, cls: `mugs-diff-sign mugs-diff-${line.type}` });
          row.insertCell().createSpan({ text: line.content || " ", cls: "mugs-diff-content" });
        }
      }
    }
  }
}
