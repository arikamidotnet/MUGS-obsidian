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
    root.createEl("h3", { text: "Bulk review" });
    root.createEl("p", { text: "Analyze saved vault text to group exact-content candidates, filename-only matches and files without a match. No files are changed by analysis. Matching bytes do not prove a move; names never prove identity.", cls: "mugs-muted" });
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
        status.textContent = `${analysis.scanned} vault files scanned; ${analysis.skipped} skipped/unreadable. Results describe saved bytes at scan time.`;
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
    for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
      const card = summary.createDiv({ cls: "mugs-bulk-category" });
      card.createSpan({ text: String(analysis.entries.filter(entry => entry.category === category).length), cls: "mugs-bulk-count" });
      card.createSpan({ text: label, cls: "mugs-muted" });
    }
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
    for (const [id, label] of Object.entries(CATEGORY_LABELS)) category.createEl("option", { text: label, attr: { value: id } });
    category.value = "exact";
    const action = labelSelect("Action ");
    action.createEl("option", { text: "Add to vault (including Upload only)", attr: { value: "recover" } });
    action.createEl("option", { text: "Delete from repository (backup first)", attr: { value: "delete" } });
    action.value = "recover";
    const preview = controls.createEl("button", { text: "Preview batch", type: "button" });
    const pane = root.createDiv();
    const invalidate = () => { if (!this.busy) pane.empty(); };
    for (const select of [mapping, category, action]) select.addEventListener("change", invalidate);
    preview.addEventListener("click", () => {
      if (this.closed || this.busy || this.deps.blocked()) return;
      const generation = ++this.generation;
      this.compareGeneration++;
      pane.empty();
      const entries = analysis.entries.filter(entry => entry.row.mappingId === mapping.value && entry.category === category.value as ReviewCategory);
      const chosenAction = action.value === "delete" ? "delete" : "recover";
      if (!entries.length || entries.length > BULK_LIMIT) {
        pane.createEl("p", { text: `Select a group containing 1–${BULK_LIMIT} files. No decisions recorded.` });
        return;
      }
      if (chosenAction === "delete" && entries.some(entry => entry.row.direction === "pull-only")) {
        pane.createEl("p", { text: "Download only: deleting repository files isn't allowed." });
        return;
      }
      const rows = entries.map(entry => Object.freeze({ ...entry.row }));
      pane.createEl("h4", { text: `${chosenAction === "delete" ? "Delete from repository" : "Add to vault"}: ${rows.length} files`, cls: "mugs-bulk-title" });
      pane.createEl("p", { text: "One folder, one sync pass. The pass also processes this folder's other normal sync changes. Each file is rechecked; changed/held/open files remain pending or return to review. Analysis does not authorize deletion." });
      const list = pane.createDiv({ cls: "mugs-bulk-preview", attr: { role: "list", "aria-label": "Files in this batch" } });
      const comparison = pane.createDiv({ cls: "mugs-bulk-comparison mugs-diff-view" });
      for (const entry of entries) {
        const file = list.createDiv({ cls: "mugs-bulk-file", attr: { role: "listitem" } });
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
      const confirmation = label.createEl("input", { type: "checkbox" });
      confirmation.required = true;
      label.createSpan({ text: chosenAction === "delete"
        ? `I approve deleting these ${rows.length} repository paths. Recovery backups are required first. This affects other users; matching names or bytes alone do not establish that these files are unwanted.`
        : `I approve adding these ${rows.length} files to the vault, even in Upload only.` });
      const apply = pane.createEl("button", { text: "Apply confirmed batch", type: "button" });
      apply.disabled = true;
      confirmation.addEventListener("change", () => { apply.disabled = !confirmation.checked || this.busy; });
      const cancel = pane.createEl("button", { text: "Cancel batch", type: "button" });
      let valid = true;
      cancel.addEventListener("click", () => { if (!this.busy) { valid = false; pane.empty(); } });
      // Changes to selectors invalidate even references to detached old buttons.
      for (const select of [mapping, category, action]) select.addEventListener("change", () => { valid = false; });
      const status = pane.createEl("p", { attr: { role: "status" } });
      apply.addEventListener("click", () => {
        if (this.closed || !valid || generation !== this.generation || this.busy || this.deps.blocked() || !confirmation.checked) return;
        valid = false;
        this.busy = true;
        for (const control of [mapping, category, action, preview, apply, cancel, confirmation]) control.disabled = true;
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
