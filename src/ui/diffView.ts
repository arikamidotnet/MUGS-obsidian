/**
 * MUGS — Diff view (`mugs-diff`).
 *
 * Obsidian glue only: it offers a mapping + ref picker, asks the injected
 * {@link DiffDataSource} for a diff and per-file authors, then renders an
 * attributed inline diff. Parsing/attribution live in diffModel.ts (unit-tested);
 * this file never runs under vitest because it imports the Obsidian DOM API.
 */
import { ItemView, Notice } from "obsidian";
import { parseUnifiedDiff, attributeHunks } from "./diffModel";
import { renderConflicts, renderDiff } from "./diffRender";
import { getMugsContext } from "./dataSources";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

export class DiffView extends ItemView {
  /** Mapping currently shown (kept so a resolution can re-render the same view). */
  private selectedMappingId = "";
  /** Recent refs remembered per mapping for quick switching. */
  private recentRefs: Record<string, string[]> = {};

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
        const empty = this.contentEl.createDiv({ cls: "mugs-empty-state" });
        empty.createEl("h3", { text: "No folder mappings yet" });
        empty.createEl("p", {
          text: "Add a credential and create your first folder mapping in the MUGS settings to compare changes here.",
          cls: "mugs-muted",
        });
        return;
      }
      await this.renderPicker(rows);
    } catch (err) {
      this.contentEl.empty();
      new Notice(`MUGS: could not load diff — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Render the mapping + ref picker, then immediately show the first diff. */
  private async renderPicker(rows: { mapping: { id: string; label: string }; status?: string }[]): Promise<void> {
    const controls = this.contentEl.createDiv({ cls: "mugs-diff-controls" });
    const output = this.contentEl.createDiv({ cls: "mugs-diff-output" });

    // Mapping selector — always shown for clarity, disabled when only one mapping.
    const header = controls.createDiv({ cls: "mugs-diff-range" });
    header.createSpan({ text: "Compare", cls: "mugs-diff-range-label" });

    if (rows.length > 1) {
      const select = header.createEl("select", { cls: "mugs-diff-mapping-select" });
      for (const r of rows) {
        const opt = select.createEl("option");
        opt.value = r.mapping.id;
        opt.textContent = `${r.mapping.label || r.mapping.id}${r.status ? ` · ${r.status}` : ""}`;
      }
      select.value = rows[0].mapping.id;
      this.selectedMappingId = rows[0].mapping.id;
      select.addEventListener("change", (e) => {
        this.selectedMappingId = (e.target as HTMLSelectElement).value;
        void this.applyRef(refInput, output);
      });
    } else {
      header.createSpan({ text: rows[0].mapping.label || rows[0].mapping.id, cls: "mugs-diff-mapping-name" });
      this.selectedMappingId = rows[0].mapping.id;
    }

    // Ref input with recent-refs dropdown.
    const refContainer = header.createDiv({ cls: "mugs-diff-ref-container" });
    const refInput = refContainer.createEl("input", { type: "text", cls: "mugs-diff-ref-input", placeholder: "Ref (e.g. HEAD, main)" });
    refInput.value = "HEAD";

    // Recent refs dropdown — only shown when there are remembered refs for this mapping.
    const updateRecentDropdown = (): void => {
      const recent = this.recentRefs[this.selectedMappingId] ?? [];
      if (recent.length === 0) return;
      refContainer.classList.add("has-recent");
      let dropdown = refContainer.querySelector(".mugs-diff-ref-dropdown") as HTMLSelectElement | null;
      if (!dropdown) {
        dropdown = document.createElement("select") as unknown as HTMLSelectElement;
        dropdown.className = "mugs-diff-ref-dropdown";
        const placeholderOpt = document.createElement("option");
        placeholderOpt.value = "";
        placeholderOpt.textContent = "recent…";
        dropdown.appendChild(placeholderOpt);
        refContainer.insertBefore(dropdown, refInput.nextSibling);
      } else {
        while (dropdown.children.length > 1) dropdown.removeChild(dropdown.lastChild!);
      }
      for (const r of recent) {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r;
        dropdown.appendChild(opt);
      }
    };

    refInput.addEventListener("change", () => void this.applyRef(refInput, output));
    updateRecentDropdown();

    header.createSpan({ text: "against last-synced baseline", cls: "mugs-diff-range-hint" });

    // Load the default mapping immediately.
    await this.showDiff(this.selectedMappingId, output);
  }

  /** Apply the ref input and remember it for quick access later. */
  private async applyRef(refInput: HTMLInputElement, output: HTMLElement): Promise<void> {
    const ref = refInput.value.trim() || "HEAD";
    // Remember this ref (dedupe, keep most recent at front).
    const arr = this.recentRefs[this.selectedMappingId] ?? [];
    const idx = arr.indexOf(ref);
    if (idx >= 0) arr.splice(idx, 1);
    arr.unshift(ref);
    this.recentRefs[this.selectedMappingId] = arr.slice(0, 5);

    // Rebuild the dropdown.
    const container = refInput.parentElement!;
    let dropdown = container.querySelector(".mugs-diff-ref-dropdown") as HTMLSelectElement | null;
    if (!dropdown) {
      dropdown = document.createElement("select") as unknown as HTMLSelectElement;
      dropdown.className = "mugs-diff-ref-dropdown";
      const placeholderOpt = document.createElement("option");
      placeholderOpt.value = "";
      placeholderOpt.textContent = "recent…";
      dropdown.appendChild(placeholderOpt);
      container.insertBefore(dropdown, refInput.nextSibling);
    } else {
      while (dropdown.children.length > 1) dropdown.removeChild(dropdown.lastChild!);
    }
    for (const r of this.recentRefs[this.selectedMappingId] ?? []) {
      const opt = document.createElement("option");
      opt.value = r;
      opt.textContent = r;
      dropdown.appendChild(opt);
    }

    await this.showDiff(this.selectedMappingId, output, ref);
  }

  private async showDiff(mappingId: string, output: HTMLElement, ref = "HEAD"): Promise<void> {
    output.empty();
    // Surface any unresolved conflicts above the diff so they are never missed.
    const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId });
    renderConflicts(conflicts, output, (c, choice) => void this.resolveFile(c, choice));

    const { diffText, authorsByFile } = await getMugsContext().diff.getDiff({ mappingId, ref });
    if (!diffText.trim()) {
      output.createEl("p", {
        text: "No comparison available for this mapping yet — sync it first so a baseline exists.",
        cls: "mugs-muted",
      });
      return;
    }
    const parsed = attributeHunks(parseUnifiedDiff(diffText), authorsByFile);
    renderDiff(parsed, output);
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
