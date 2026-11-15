import { BULK_LIMIT, CATEGORY_LABELS, type ReviewAnalysis, type BulkResult, type ReviewCategory } from "../runtime/reconciliationBulk";
import type { ReconciliationReviewRow } from "./reconciliationReview";
import { renderTextComparison } from "./diffRender";

interface BulkDeps {
  analyze: (signal: AbortSignal) => Promise<ReviewAnalysis>;
  compare?: (row: ReconciliationReviewRow, vaultPath: string) => Promise<{ local: string; remote: string }>;
  decide: (rows: ReconciliationReviewRow[], action: "delete" | "recover") => Promise<BulkResult>;
  blocked: () => boolean;
}

/** Preview is an immutable choice, not a live filtered collection. */
export class BulkReview {
  private closed = false;
  private busy = false;
  private controller?: AbortController;
  private generation = 0;
  private compareGeneration = 0;
  constructor(private readonly deps: BulkDeps) {}
  isBusy(): boolean { return this.busy; }
  detach(): void { this.closed = true; this.controller?.abort(); this.compareGeneration++; }

  render(root: HTMLElement): void {
    root.createEl("p", { text: "1. Scan saved vault files for possible matches. 2. Choose one folder and group. 3. Inspect the batch and confirm one action. Scanning makes no changes; a match does not authorize deletion.", cls: "mugs-muted" });
    const analyze = root.createEl("button", { text: "Analyze review items", type: "button" });
    const cancel = root.createEl("button", { text: "Cancel analysis", type: "button" });
    cancel.hidden = true;
    const status = root.createEl("p", { attr: { role: "status" } });
    const body = root.createDiv();
    cancel.addEventListener("click", () => this.controller?.abort());
    analyze.addEventListener("click", () => {
      if (this.closed || this.busy || this.deps.blocked()) return;
      this.busy = true;
      this.generation++;
      this.compareGeneration++;
      analyze.disabled = true;
      cancel.hidden = false;
      body.empty();
      status.textContent = "Reading current vault text…";
      const controller = this.controller = new AbortController();
      void this.deps.analyze(controller.signal).then(analysis => {
        if (this.closed || controller.signal.aborted) return;
        status.textContent = `${analysis.entries.length} repository files to review. ${analysis.scanned} vault files attempted; ${analysis.skipped} skipped or unreadable${analysis.totalFiles === undefined ? "" : ` of ${analysis.totalFiles} visible files`}. ${analysis.limitsReached ? "Scan budget reached: no-match conclusions are inconclusive. " : ""}Results describe saved bytes at scan time.`;
        this.showAnalysis(body, analysis);
      }).catch(error => {
        if (!this.closed) status.textContent = controller.signal.aborted ? "Analysis cancelled. No decisions recorded." : `Analysis failed: ${String(error)}`;
      }).finally(() => {
        this.busy = false;
        if (!this.closed) { analyze.disabled = false; cancel.hidden = true; }
      });
    });
  }

  private showAnalysis(root: HTMLElement, analysis: ReviewAnalysis): void {
    const summary = root.createDiv({ cls: "mugs-bulk-categories" });
    summary.createEl("p", { text: "All folders · repository files, not vault files", cls: "mugs-muted mugs-bulk-scope" });
    for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
      const card = summary.createDiv({ cls: "mugs-bulk-category" });
      card.createSpan({ text: String(analysis.entries.filter(entry => entry.category === category).length), cls: "mugs-bulk-count" });
      card.createSpan({ text: label, cls: "mugs-muted" });
    }
    root.createEl("p", {
      text: "Exact content: same saved bytes, not proof of a move. Filename only: name matches, contents may differ. No match: no saved vault file matched in a complete scan. Inconclusive: no match found, but skipped/unreadable vault files mean a match cannot be ruled out.",
      cls: "mugs-muted",
    });
    const controls = root.createDiv({ cls: "mugs-bulk-controls" });
    const labelSelect = (text: string) => {
      const label = controls.createEl("label");
      label.createSpan({ text });
      return label.createEl("select");
    };
    const mapping = labelSelect("Folder ");
    const mappings = new Map(analysis.entries.map(entry => [entry.row.mappingId, entry.row.mappingLabel]));
    for (const [id, label] of mappings) mapping.createEl("option", { text: label || id, attr: { value: id } });
    mapping.value = mappings.keys().next().value ?? "";
    const category = labelSelect("Category ");
    const categories = Object.entries(CATEGORY_LABELS) as [ReviewCategory, string][];
    const groupCount = (id: string, kind: ReviewCategory) =>
      analysis.entries.filter(entry => entry.row.mappingId === id && entry.category === kind).length;
    const refreshCategories = () => {
      const previous = category.value;
      category.empty();
      for (const [id, label] of categories) {
        category.createEl("option", { text: `${label} (${groupCount(mapping.value, id)})`, attr: { value: id } });
      }
      category.value = categories.some(([id]) => id === previous && groupCount(mapping.value, id)) ? previous
        : categories.find(([id]) => groupCount(mapping.value, id))?.[0] ?? "exact";
    };
    refreshCategories();
    const action = labelSelect("Action ");
    action.createEl("option", { text: "Copy repository files into my vault", attr: { value: "recover" } });
    action.createEl("option", { text: "Delete repository files for everyone (backup first)", attr: { value: "delete" } });
    action.value = "recover";
    const actionHelp = root.createEl("p", { cls: "mugs-muted", attr: { role: "status" } });
    const groupHelp = root.createEl("p", { cls: "mugs-muted", attr: { role: "status" } });
    const preview = controls.createEl("button", { text: "Preview batch", type: "button" });
    const pane = root.createDiv();
    const updateSelection = () => {
      const count = groupCount(mapping.value, category.value as ReviewCategory);
      groupHelp.textContent = `${count} repository file${count === 1 ? "" : "s"} in this folder and category${count > BULK_LIMIT ? `; select up to ${BULK_LIMIT} at once` : ""}.`;
      actionHelp.textContent = action.value === "delete"
        ? "Deletes these paths from the shared repository after a recovery backup. Other users are affected; a matching name or content is not consent."
        : "Copies repository content to its mapped path in this vault, including Upload only. Existing possible matches at other paths are left untouched.";
      preview.disabled = !count || this.busy;
    };
    const invalidate = () => { if (!this.busy) { pane.empty(); updateSelection(); } };
    mapping.addEventListener("change", () => { refreshCategories(); invalidate(); });
    for (const select of [category, action]) select.addEventListener("change", invalidate);
    updateSelection();
    preview.addEventListener("click", () => {
      if (this.closed || this.busy || this.deps.blocked()) return;
      const generation = ++this.generation;
      this.compareGeneration++;
      pane.empty();
      const entries = analysis.entries.filter(entry => entry.row.mappingId === mapping.value && entry.category === category.value as ReviewCategory);
      const chosenAction = action.value === "delete" ? "delete" : "recover";
      if (!entries.length) {
        pane.createEl("p", { text: "Select a nonempty group. No decisions recorded." });
        return;
      }
      if (chosenAction === "delete" && entries.some(entry => entry.row.direction === "pull-only")) {
        pane.createEl("p", { text: "Download only: deleting repository files isn't allowed." });
        return;
      }
      const selected = new Set(entries.slice(0, BULK_LIMIT));
      pane.createEl("h4", { text: `${chosenAction === "delete" ? "Delete from shared repository" : "Copy into my vault"}: choose files`, cls: "mugs-bulk-title" });
      pane.createEl("p", { text: "One folder, one sync pass. The pass also processes this folder's other normal sync changes. Each file is rechecked; changed/held/open files remain pending or return to review. Analysis does not authorize deletion." });
      if (entries.length > BULK_LIMIT) pane.createEl("p", { text: `First ${BULK_LIMIT} files selected. Deselect files to narrow the batch; remaining files can be handled in a later batch.`, cls: "mugs-muted" });
      const list = pane.createDiv({ cls: "mugs-bulk-preview", attr: { role: "list", "aria-label": "Files in this batch" } });
      const comparison = pane.createDiv({ cls: "mugs-bulk-comparison mugs-diff-view" });
      const selectionStatus = pane.createEl("p", { attr: { role: "status" } });
      let confirmation: HTMLInputElement | undefined;
      let apply: HTMLButtonElement | undefined;
      const updateCount = () => {
        selectionStatus.textContent = `${selected.size} of ${entries.length} repository files selected (maximum ${BULK_LIMIT}).`;
        if (confirmation) confirmation.checked = false;
        if (apply) apply.disabled = true;
      };
      for (const entry of entries.slice(0, BULK_LIMIT)) {
        const file = list.createDiv({ cls: "mugs-bulk-file", attr: { role: "listitem" } });
        const pick = file.createEl("input", { type: "checkbox", attr: { "aria-label": `Select ${entry.row.path}` } });
        pick.checked = true;
        pick.addEventListener("change", () => {
          if (pick.checked) selected.add(entry);
          else selected.delete(entry);
          updateCount();
        });
        file.createEl("strong", { text: entry.row.path, cls: "mugs-bulk-file-path" });
        file.createEl("small", { text: `Repository commit ${entry.row.ref} · blob ${entry.row.blob}`, cls: "mugs-muted mugs-bulk-identity" });
        if (!entry.matches.length) file.createEl("span", { text: "No verified vault match", cls: "mugs-muted" });
        for (const match of entry.matches) {
          const compare = file.createEl("button", { text: `Compare with ${match}`, type: "button", cls: "mugs-bulk-compare" });
          compare.addEventListener("click", () => {
            if (this.closed || this.busy || this.deps.blocked() || !this.deps.compare) return;
            const current = ++this.compareGeneration;
            comparison.empty();
            const message = comparison.createEl("p", { text: "Loading comparison…", attr: { role: "status" } });
            void this.deps.compare(entry.row, match).then(({ local, remote }) => {
              if (this.closed || this.busy || current !== this.compareGeneration) return;
              comparison.empty();
              comparison.createEl("h4", { text: `${match} → ${entry.row.path}`, cls: "mugs-bulk-title" });
              if (local === remote) comparison.createEl("p", { text: "Saved vault bytes and reviewed repository bytes are identical. This does not prove deletion is wanted.", cls: "mugs-note" });
              else renderTextComparison(comparison, {
                path: entry.row.path, local, remote,
                description: `Saved vault file ${match} → reviewed repository file ${entry.row.path}. Red lines are vault-only; green lines are repository-only.`,
              });
            }).catch(error => {
              if (!this.closed && current === this.compareGeneration) message.textContent = `Comparison unavailable: ${String(error)}. Refresh review before deciding.`;
            });
          });
        }
        if (entry.matchCount > entry.matches.length) file.createEl("span", { text: `${entry.matchCount - entry.matches.length} more matches not displayed`, cls: "mugs-muted" });
      }
      const label = pane.createEl("label");
      const confirmationInput = confirmation = label.createEl("input", { type: "checkbox" });
      confirmation.required = true;
      label.createSpan({ text: chosenAction === "delete"
        ? "I approve deleting the selected repository paths. Recovery backups are required first. This affects other users; matching names or bytes alone do not establish that these files are unwanted."
        : "I approve copying the selected repository files into my vault, even in Upload only. Possible matches at other paths will remain." });
      const applyButton = apply = pane.createEl("button", { text: "Apply confirmed batch", type: "button" });
      updateCount();
      applyButton.disabled = true;
      confirmationInput.addEventListener("change", () => { applyButton.disabled = !confirmationInput.checked || !selected.size || this.busy; });
      const cancel = pane.createEl("button", { text: "Cancel batch", type: "button" });
      let valid = true;
      cancel.addEventListener("click", () => { if (!this.busy) { valid = false; pane.empty(); } });
      // Changes to selectors invalidate even references to detached old buttons.
      for (const select of [mapping, category, action]) select.addEventListener("change", () => { valid = false; });
      const status = pane.createEl("p", { attr: { role: "status" } });
      applyButton.addEventListener("click", () => {
        if (this.closed || !valid || generation !== this.generation || this.busy || this.deps.blocked() || !confirmationInput.checked || !selected.size) return;
        const rows = [...selected].map(entry => Object.freeze({ ...entry.row }));
        valid = false;
        this.busy = true;
        for (const control of [mapping, category, action, preview, applyButton, cancel, confirmationInput]) control.disabled = true;
        status.textContent = "Recording decisions and running guarded sync… Do not close Obsidian.";
        void this.deps.decide(rows, chosenAction).then(result => {
          if (this.closed) return;
          const count = (state: string) => result.rows.filter(row => row.status === state).length;
          status.textContent = result.persisted
            ? `${count("applied")} applied; ${count("requeued")} re-queued; ${count("pending")} pending. Refresh review or analyze again before another batch.`
            : "Sync state could not be persisted. Effects may be partial; decisions were saved before sync. Refresh review and complete sync before another batch.";
          const outcomes = pane.createEl("ul", { cls: "mugs-bulk-preview" });
          for (const item of result.rows) outcomes.createEl("li", { text: `${item.row.path}: ${item.status}` });
        }).catch(error => {
          if (!this.closed) status.textContent = `Batch not completed: ${String(error)}. Refresh review before retrying.`;
        }).finally(() => { this.busy = false; });
      });
    });
  }
}
