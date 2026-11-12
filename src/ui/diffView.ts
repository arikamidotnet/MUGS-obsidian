/**
 * MUGS — Diff view (`mugs-diff`).
 *
 * Obsidian glue only: it offers a mapping + ref picker, asks the injected
 * {@link DiffDataSource} for a diff and per-file authors, then renders an
 * attributed inline diff. Parsing/attribution live in diffModel.ts (unit-tested);
 * this file never runs under vitest because it imports the Obsidian DOM API.
 */
import { ItemView, Notice } from "obsidian";
import { parseUnifiedDiff, attributeHunks, validateRef } from "./diffModel";
import { renderConflicts, renderDiff } from "./diffRender";
import { getMugsContext } from "./dataSources";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

export class DiffView extends ItemView {
  /** Mapping currently shown (kept so a resolution can re-render the same view). */
  private selectedMappingId = "";
  /** Ref applied per mapping (kept so a re-render restores the picker exactly). */
  private selectedRefs: Record<string, string> = {};
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
    // Clear before rebuilding: a resolution re-render used to APPEND a second
    // picker + output under the stale one, so the view grew on every resolve.
    this.contentEl.empty();
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

  /** Render the mapping + ref picker, then show its diff. */
  private async renderPicker(rows: { mapping: { id: string; label: string }; status?: string }[]): Promise<void> {
    const controls = this.contentEl.createDiv({ cls: "mugs-diff-controls" });
    const output = this.contentEl.createDiv({ cls: "mugs-diff-output" });

    // Mapping selector — always shown for clarity, disabled when only one mapping.
    const header = controls.createDiv({ cls: "mugs-diff-range" });
    header.createSpan({ text: "Compare", cls: "mugs-diff-range-label" });

    // Keep the picker on the mapping the user chose — a resolution re-render used
    // to snap back to the first mapping (and HEAD) and lose the user's place.
    const ids = new Set(rows.map((r) => r.mapping.id));
    if (!ids.has(this.selectedMappingId)) this.selectedMappingId = rows[0].mapping.id;

    if (rows.length > 1) {
      const select = header.createEl("select", { cls: "mugs-diff-mapping-select" });
      for (const r of rows) {
        const opt = select.createEl("option");
        opt.value = r.mapping.id;
        opt.textContent = `${r.mapping.label || r.mapping.id}${r.status ? ` · ${r.status}` : ""}`;
      }
      select.value = this.selectedMappingId;
      select.addEventListener("change", (e) => {
        this.selectedMappingId = (e.target as HTMLSelectElement).value;
        // Switching mappings restores THAT mapping's own ref (or HEAD).
        refInput.value = this.selectedRefs[this.selectedMappingId] ?? "HEAD";
        this.rebuildRecentOptions(recentDropdown);
        void this.applyRef(refInput, recentDropdown, output);
      });
    } else {
      header.createSpan({ text: rows[0].mapping.label || rows[0].mapping.id, cls: "mugs-diff-mapping-name" });
    }

    // Ref input with recent-refs dropdown.
    const refContainer = header.createDiv({ cls: "mugs-diff-ref-container" });
    const refInput = refContainer.createEl("input", { type: "text", cls: "mugs-diff-ref-input", placeholder: "Ref (e.g. HEAD, main)" });
    refInput.value = this.selectedRefs[this.selectedMappingId] ?? "HEAD";
    const recentDropdown = refContainer.createEl("select", { cls: "mugs-diff-ref-dropdown" });
    this.rebuildRecentOptions(recentDropdown);

    refInput.addEventListener("change", () => void this.applyRef(refInput, recentDropdown, output));
    recentDropdown.addEventListener("change", () => {
      const picked = recentDropdown.value;
      if (!picked) return; // the "recent…" placeholder
      refInput.value = picked;
      void this.applyRef(refInput, recentDropdown, output);
    });

    // Hint is neutral; truthful labels come from the diff result (fromLabel/toLabel).
    header.createSpan({ text: "vs", cls: "mugs-diff-range-hint" });

    // Show this mapping's diff immediately (with its restored ref).
    await this.showDiff(this.selectedMappingId, output, refInput.value.trim() || "HEAD");
  }

  /** Rebuild the recent-refs dropdown for the current mapping; hidden when empty.
   *  The options created last time are tracked on the element and removed via
   *  ChildNode.remove() — the one removal API the Obsidian-style DOM helpers,
   *  the test shim and real browsers all share. */
  private rebuildRecentOptions(dropdown: HTMLSelectElement): void {
    const dd = dropdown as unknown as HTMLElement & { _mugsRecentOpts?: HTMLElement[] };
    for (const opt of dd._mugsRecentOpts ?? []) opt.remove();
    dd._mugsRecentOpts = [];

    const add = (value: string, label: string): void => {
      const opt = document.createElement("option") as unknown as HTMLElement & { value: string };
      opt.value = value;
      opt.textContent = label;
      dropdown.appendChild(opt);
      dd._mugsRecentOpts!.push(opt);
    };

    add("", "recent…");
    for (const r of this.recentRefs[this.selectedMappingId] ?? []) add(r, r);
    dropdown.style.display = (this.recentRefs[this.selectedMappingId]?.length ?? 0) > 0 ? "" : "none";
  }

  /**
   * Apply the ref input after validating it. Invalid refs show an inline message
   * here — they never round-trip to git and come back as a confusing "git-error"
   * diff — and are not remembered in the recent list.
   */
  private async applyRef(refInput: HTMLInputElement, recentDropdown: HTMLSelectElement, output: HTMLElement): Promise<void> {
    const ref = refInput.value.trim();
    const problem = validateRef(ref);
    if (problem) {
      output.empty();
      output.createEl("p", { text: problem, cls: "mugs-diff-ref-error" });
      return;
    }

    // Remember this ref (dedupe, keep most recent at front).
    const arr = this.recentRefs[this.selectedMappingId] ?? [];
    const idx = arr.indexOf(ref);
    if (idx >= 0) arr.splice(idx, 1);
    arr.unshift(ref);
    this.recentRefs[this.selectedMappingId] = arr.slice(0, 5);
    this.rebuildRecentOptions(recentDropdown);

    await this.showDiff(this.selectedMappingId, output, ref);
  }

  /** Monotonic generation per mapping to discard stale async results (U03). */
  private diffGeneration: Record<string, number> = {};

  private async showDiff(mappingId: string, output: HTMLElement, ref = "HEAD"): Promise<void> {
    // Record the applied ref so a re-render (e.g. after a resolution) restores it.
    this.selectedRefs[mappingId] = ref;
    const gen = (this.diffGeneration[mappingId] ?? 0) + 1;
    this.diffGeneration[mappingId] = gen;

    output.empty();
    // Surface any unresolved conflicts above the diff so they are never missed.
    const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId });
    renderConflicts(conflicts, output, (c, choice) => void this.resolveFile(c, choice));

    const res = await getMugsContext().diff.getDiff({ mappingId, ref });
    // U03: discard stale responses
    if ((this.diffGeneration[mappingId] ?? 0) !== gen) return;

    const { diffText, authorsByFile, baseRef, outcome, detail, fromLabel, toLabel, note, errorKind } = res;

    if (outcome === "git-error") {
      // Distinct messages per ReadErrorKind (auth vs timeout vs missing vs other)
      const kindMsg =
        errorKind === "auth" ? "authentication or permission failure (check credential)"
        : errorKind === "timeout" ? "network timeout while fetching comparison data"
        : errorKind === "missing-ref" ? "required commit or object is missing from the local clone"
        : "git error";
      const card = output.createDiv({ cls: "mugs-empty-state" });
      card.createEl("h3", { text: "Comparison failed" });
      card.createEl("p", {
        text: `${kindMsg}${detail ? ` — ${detail}` : ""}${fromLabel ? ` (from ${fromLabel})` : ""}.`,
        cls: "mugs-muted",
      });
      return;
    }

    if (outcome === "identical") {
      const card = output.createDiv({ cls: "mugs-empty-state" });
      const baseLabel = fromLabel ?? (baseRef ? shortSha(baseRef) : "baseline");
      card.createEl("h3", { text: "Identical snapshots" });
      card.createEl("p", {
        text: `No differences between ${baseLabel} and ${toLabel ?? "HEAD (committed snapshot)"}.${note ? ` ${note}.` : ""} To see history, pick an older ref (e.g. ${shortSha(baseRef)}~1).`,
        cls: "mugs-muted",
      });
      return;
    }

    if (outcome === "no-baseline") {
      const card = output.createDiv({ cls: "mugs-empty-state" });
      card.createEl("h3", { text: "No baseline yet" });
      card.createEl("p", { text: "Run a sync first to establish a comparison point (correspondence or fetched remote tip).", cls: "mugs-muted" });
      return;
    }

    if (outcome !== "changed") {
      const why =
        outcome === "no-clone" ? "the repository has not been cloned yet — run a sync first"
        : "this mapping no longer exists";
      const card = output.createDiv({ cls: "mugs-empty-state" });
      card.createEl("h3", { text: "No comparison available" });
      card.createEl("p", { text: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`, cls: "mugs-muted" });
      return;
    }

    // Pending local edits note (committed snapshot only)
    if (note) {
      const banner = output.createDiv({ cls: "mugs-note" });
      banner.createEl("span", { text: note });
    }

    const parsed = attributeHunks(parseUnifiedDiff(diffText), authorsByFile);
    renderDiff(parsed, output);
  }

/** Resolve one file's conflict, persist it (working-tree write + store), then re-render. */
  /** Paths currently resolving for this view (U03: whole group disabled until promise settles). */
  private resolving: Set<string> = new Set();

  private async resolveFile(c: FileConflict, choice: ResolveChoice): Promise<void> {
    const key = c.path;
    // Key errors by mapping + path (conflict version approximated by re-render cycle).
    this.resolving.add(key);
    // Re-render to disable the whole action group for this conflict.
    // We re-fetch conflicts and pass busy set through renderConflicts.
    const output = this.contentEl.querySelector(".mugs-diff-output") as HTMLElement | null;
    if (output) {
      output.empty();
      const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId: this.selectedMappingId });
      renderConflicts(conflicts, output, (cc, ch) => void this.resolveFile(cc, ch), this.resolving);
    }
    try {
      const res = await getMugsContext().conflicts.resolveConflict({ mappingId: this.selectedMappingId, path: key, choice });
      this.resolving.delete(key);
      const left = res.remaining;
      new Notice(
        `MUGS — resolved ${key} (${choice}).${
          left > 0 ? ` ${left} file${left === 1 ? "" : "s"} still unresolved.` : " No conflicts remain."
        }`,
      );
      void this.render();
    } catch (err) {
      this.resolving.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      // Retryable keeps the conflict visible with inline actionable error (keyed).
      const retryable = /retry|temporary|timeout|network/i.test(msg);
      if (output) {
        // Re-render rows so they are not stuck disabled, then attach error under the path.
        output.empty();
        const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId: this.selectedMappingId });
        renderConflicts(conflicts, output, (cc, ch) => void this.resolveFile(cc, ch), this.resolving);
        // Find the row for this path and attach error (best-effort).
        const rows = Array.from(output.querySelectorAll(".mugs-conflict-row"));
        for (const r of rows) {
          if ((r as any).textContent?.includes(key)) {
            // inline error (best effort in shim)
            try { (r as any).createEl?.("p", { text: msg, cls: "mugs-conflict-row-error" }); } catch {}
            break;
          }
        }
      }
      if (!retryable) {
        new Notice(`MUGS — could not resolve ${key}: ${msg}`);
      }
    }
  }
}

/** Short display form of a baseline ref/SHA (full SHAs truncated to 8 chars). */
function shortSha(ref: string | undefined): string {
  if (!ref) return "unknown";
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}
