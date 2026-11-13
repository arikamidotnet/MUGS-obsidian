/**
 * MUGS — Diff view (`mugs-diff`).
 *
 * Obsidian glue only: it offers a mapping + ref picker, asks the injected
 * {@link DiffDataSource} for a diff and per-file authors, then renders an
 * attributed inline diff. Parsing/attribution live in diffModel.ts (unit-tested);
 * DOM behavior is regression-tested through the Obsidian test shim.
 */
import { ItemView, Notice } from "obsidian";
import { parseUnifiedDiff, attributeHunks, validateRef } from "./diffModel";
import { renderConflicts, renderFileBrowser } from "./diffRender";
import { getMugsContext } from "./dataSources";
import type { FileConflict, ResolveChoice } from "../sync/conflict";
import { resolutionLabel } from "./labels";
import { renderNavigation } from "./navigation";

export class DiffView extends ItemView {
  /** Mapping currently shown (kept so a resolution can re-render the same view). */
  private selectedMappingId = "";
  /** Ref applied per mapping (kept so a re-render restores the picker exactly). */
  private selectedRefs: Record<string, string> = {};
  /** Recent refs remembered per mapping for quick switching. */
  private recentRefs: Record<string, string[]> = {};
  private generation = 0;
  private closed = false;
  private modes: Record<string, "since-sync" | "previous" | "custom"> = {};

  getViewType(): string {
    return "mugs-diff";
  }

  getDisplayText(): string {
    return "MUGS Changes";
  }

  getIcon(): string {
    return "git-commit";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    renderNavigation(this.contentEl, "mugs-diff");
    this.contentEl.addClass("mugs-diff-view");
    this.addAction("refresh", "Refresh changes", () => void this.render());
    await this.render();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    // Clear before rebuilding: a resolution re-render used to APPEND a second
    // picker + output under the stale one, so the view grew on every resolve.
    // The shared navigation lives in this root too, so it is re-created first
    // (same pattern as MapView's renderHeader).
    this.contentEl.empty();
    renderNavigation(this.contentEl, "mugs-diff");
    try {
      const rows = await getMugsContext().map.getRows();
      if (this.closed || generation !== this.generation) return;
      if (rows.length === 0) {
        const empty = this.contentEl.createDiv({ cls: "mugs-empty-state" });
        empty.createEl("h3", { text: "No folders connected" });
        empty.createEl("p", {
          text: "Connect a folder in MUGS settings to view its changes.",
          cls: "mugs-muted",
        });
        return;
      }
      await this.renderPicker(rows);
    } catch (err) {
      if (this.closed || generation !== this.generation) return;
      new Notice(`MUGS: could not load diff — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Render the mapping + ref picker, then show its diff. */
  private async renderPicker(rows: { mapping: { id: string; label: string }; status?: string }[]): Promise<void> {
    const controls = this.contentEl.createDiv({ cls: "mugs-diff-controls" });
    const output = this.contentEl.createDiv({ cls: "mugs-diff-output" });

    // Mapping selector — always shown for clarity, disabled when only one mapping.
    const header = controls.createDiv({ cls: "mugs-diff-range" });
    header.createSpan({ text: "Folder", cls: "mugs-diff-range-label" });

    // Keep the picker on the mapping the user chose — a resolution re-render used
    // to snap back to the first mapping (and HEAD) and lose the user's place.
    const ids = new Set(rows.map((r) => r.mapping.id));
    if (!ids.has(this.selectedMappingId)) this.selectedMappingId = rows[0].mapping.id;

    if (rows.length > 1) {
      const select = header.createEl("select", { cls: "mugs-diff-mapping-select" });
      select.setAttribute("aria-label", "Connected folder");
      for (const r of rows) {
        const opt = select.createEl("option");
        opt.value = r.mapping.id;
        opt.textContent = r.mapping.label || r.mapping.id;
      }
      select.value = this.selectedMappingId;
      select.addEventListener("change", (e) => {
        this.selectedMappingId = (e.target as HTMLSelectElement).value;
        // Switching mappings restores that mapping's mode and older endpoint.
        refInput.value = this.selectedRefs[this.selectedMappingId] ?? "HEAD~1";
        mode.value = this.modes[this.selectedMappingId] ?? "since-sync";
        refContainer.style.display = mode.value === "custom" ? "" : "none";
        this.rebuildRecentOptions(recentDropdown);
        void this.applyRef(refInput, recentDropdown, output);
      });
    } else {
      header.createSpan({ text: rows[0].mapping.label || rows[0].mapping.id, cls: "mugs-diff-mapping-name" });
    }

    const mode = header.createEl("select", { cls: "mugs-diff-mode" });
    mode.setAttribute("aria-label", "Comparison mode");
    for (const [value, text] of [
      ["since-sync", "Since last completed sync"],
      ["previous", "Last commit"],
      ["custom", "Choose older commit…"],
    ]) {
      const option = mode.createEl("option", { text });
      option.value = value;
    }
    mode.value = this.modes[this.selectedMappingId] ?? "since-sync";
    mode.addEventListener("change", () => {
      this.modes[this.selectedMappingId] = mode.value as "since-sync" | "previous" | "custom";
      refContainer.style.display = mode.value === "custom" ? "" : "none";
      void this.applyRef(refInput, recentDropdown, output);
    });
    controls.createEl("p", { text: "Saved Git history only · Unsynced edits aren't shown.", cls: "mugs-diff-history-note" });
    const refContainer = header.createDiv({ cls: "mugs-diff-ref-container" });
    refContainer.style.display = mode.value === "custom" ? "" : "none";
    const refInput = refContainer.createEl("input", { type: "text", cls: "mugs-diff-ref-input", placeholder: "Commit, tag or branch" });
    refInput.setAttribute("aria-label", "Older commit, tag or branch");
    refInput.value = this.selectedRefs[this.selectedMappingId] ?? "HEAD~1";
    const recentDropdown = refContainer.createEl("select", { cls: "mugs-diff-ref-dropdown" });
    this.rebuildRecentOptions(recentDropdown);

    refInput.addEventListener("change", () => void this.applyRef(refInput, recentDropdown, output));
    recentDropdown.addEventListener("change", () => {
      const picked = recentDropdown.value;
      if (!picked) return; // the "recent…" placeholder
      refInput.value = picked;
      void this.applyRef(refInput, recentDropdown, output);
    });

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

    add("", "Recent commits…");
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
    const problem = (this.modes[this.selectedMappingId] ?? "since-sync") === "custom" ? validateRef(ref) : undefined;
    if (problem) {
      this.generation++;
      const comparison = (output.querySelector(".mugs-diff-comparison") as HTMLElement | null) ?? output;
      comparison.empty();
      comparison.createEl("p", { text: problem, cls: "mugs-diff-ref-error" });
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

  private async showDiff(mappingId: string, output: HTMLElement, ref = "HEAD"): Promise<void> {
    // Record the applied ref so a re-render (e.g. after a resolution) restores it.
    this.selectedRefs[mappingId] = ref;
    const gen = ++this.generation;
    const current = () => !this.closed && gen === this.generation && mappingId === this.selectedMappingId;

    output.empty();
    const conflictHost = output.createDiv();
    const comparison = output.createDiv({ cls: "mugs-diff-comparison" });
    try {
      // Surface any unresolved conflicts above the diff so they are never missed.
      const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId });
      if (!current()) return;
      renderConflicts(conflicts, conflictHost, (c, choice) => void this.resolveFile(c, choice), this.resolving);
      // Keep conflict actions separate from ref validation and comparison errors.
      output = comparison;

      const res = await getMugsContext().diff.getDiff({ mappingId, mode: this.modes[mappingId] ?? "since-sync", olderRef: ref });
      // U03: discard stale responses
      if (!current()) return;

      const { diffText, authorsByFile, baseRef, outcome, detail, fromLabel, toLabel, errorKind } = res;
      if (fromLabel && toLabel) output.createEl("p", {
        text: `${comparisonLabel(fromLabel)} → ${comparisonLabel(toLabel)}`,
        cls: "mugs-diff-endpoints",
      });

      if (outcome === "git-error") {
        // Distinct messages per ReadErrorKind (auth vs timeout vs missing vs other)
        const kindMsg =
          errorKind === "auth" ? "Check your account token and repository access"
          : errorKind === "timeout" ? "The connection timed out. Try again"
          : errorKind === "missing-ref" ? "This commit isn't available on this device"
          : "Git couldn't load these changes";
        const card = output.createDiv({ cls: "mugs-empty-state" });
        card.createEl("h3", { text: "Comparison failed" });
        card.createEl("p", {
          text: `${kindMsg}${detail ? ` — ${detail}` : ""}.`,
          cls: "mugs-muted",
        });
        return;
      }

      if (outcome === "identical") {
        const card = output.createDiv({ cls: "mugs-empty-state" });
        const baseLabel = fromLabel ? comparisonLabel(fromLabel) : (baseRef ? shortSha(baseRef) : "the saved sync point");
        card.createEl("h3", { text: "No changes" });
        card.createEl("p", {
          text: `No changes between ${baseLabel} and ${toLabel ? comparisonLabel(toLabel) : "the latest commit"}. Choose Last commit or an older commit to see earlier changes.`,
          cls: "mugs-muted",
        });
        return;
      }

      if (outcome === "no-baseline") {
        const card = output.createDiv({ cls: "mugs-empty-state" });
        card.createEl("h3", { text: "No completed sync yet" });
        card.createEl("p", { text: "Complete a sync first, or choose Last commit to browse saved changes.", cls: "mugs-muted" });
        return;
      }

      if (outcome !== "changed") {
        const why =
          outcome === "no-clone" ? "run a sync to download the repository first"
          : "this folder is no longer connected";
        const card = output.createDiv({ cls: "mugs-empty-state" });
        card.createEl("h3", { text: "No comparison available" });
        card.createEl("p", { text: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`, cls: "mugs-muted" });
        return;
      }

      const parsed = attributeHunks(parseUnifiedDiff(diffText), authorsByFile);
      renderFileBrowser(parsed, output, authorsByFile);
    } catch (err) {
      if (!current()) return;
      comparison.empty();
      comparison.createEl("p", { text: `Could not load comparison: ${err instanceof Error ? err.message : String(err)}`, cls: "mugs-diff-ref-error" });
    }
  }

  /** Resolve one file's conflict, persist it (working-tree write + store), then re-render. */
  /** Paths currently resolving for this view (U03: whole group disabled until promise settles). */
  private resolvingByMapping: Record<string, Set<string>> = {};
  private get resolving(): Set<string> {
    return this.resolvingByMapping[this.selectedMappingId] ??= new Set();
  }

  private async resolveFile(c: FileConflict, choice: ResolveChoice): Promise<void> {
    const mappingId = this.selectedMappingId;
    const busy = this.resolving;
    const key = c.path;
    if (busy.has(key)) return;
    const generation = ++this.generation;
    const current = () => !this.closed && generation === this.generation && mappingId === this.selectedMappingId;
    // Key errors by mapping + path (conflict version approximated by re-render cycle).
    busy.add(key);
    // Re-render to disable the whole action group for this conflict.
    // We re-fetch conflicts and pass busy set through renderConflicts.
    const output = this.contentEl.querySelector(".mugs-diff-output") as HTMLElement | null;
    try {
      if (output) {
        output.empty();
        const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId }).catch(() => [c]);
        if (current()) renderConflicts(conflicts, output, (cc, ch) => void this.resolveFile(cc, ch), this.resolving);
      }
      const res = await getMugsContext().conflicts.resolveConflict({ mappingId, path: key, choice });
      busy.delete(key);
      const left = res.remaining;
      new Notice(
        `MUGS — ${key}: kept ${resolutionLabel(choice)}.${
          left > 0 ? ` ${left} file${left === 1 ? "" : "s"} still unresolved.` : " No conflicts remain."
        }`,
      );
      if (current()) void this.render();
    } catch (err) {
      busy.delete(key);
      const msg = err instanceof Error ? err.message : String(err);
      // Retryable keeps the conflict visible with inline actionable error (keyed).
      const retryable = /retry|temporary|timeout|network/i.test(msg);
      if (output && current()) {
        // Re-render rows so they are not stuck disabled, then attach error under the path.
        output.empty();
        const conflicts = await getMugsContext().conflicts.getConflicts({ mappingId }).catch(() => [c]);
        if (!current()) return;
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

/** Display-only labels: raw refs and comparison direction remain unchanged. */
function comparisonLabel(label: string): string {
  const ref = label.replace(/ \(committed snapshot\)$/, "");
  if (ref === "HEAD") return "Latest commit";
  if (ref === "HEAD~1") return "Previous commit";
  if (ref === "last completed sync") return "Last completed sync";
  if (ref === "fetched remote tip (not last sync)") return "Downloaded repository version (not last sync)";
  return shortSha(ref);
}

/** Short display form of a baseline ref/SHA (full SHAs truncated to 8 chars). */
function shortSha(ref: string | undefined): string {
  if (!ref) return "unknown";
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}
