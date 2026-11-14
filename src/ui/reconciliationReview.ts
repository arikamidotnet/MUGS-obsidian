import { directionLabel } from "./labels";
import { BulkReview } from "./reconciliationBulk";
import type { ReviewAnalysis, BulkResult } from "../runtime/reconciliationBulk";

export interface ReconciliationReviewRow {
  mappingId: string;
  mappingLabel: string;
  path: string;
  ref: string;
  blob: string;
  fingerprint: string;
  direction: "push-only" | "pull-only" | "push-pull";
  reason?: string;
}

export interface ReconciliationReviewDeps {
  rows: ReconciliationReviewRow[];
  preview: (row: ReconciliationReviewRow) => Promise<string>;
  decide: (row: ReconciliationReviewRow, action: "delete" | "recover") => Promise<void>;
  analyze?: (signal: AbortSignal) => Promise<ReviewAnalysis>;
  compare?: (row: ReconciliationReviewRow, vaultPath: string) => Promise<{ local: string; remote: string }>;
  decideBatch?: (rows: ReconciliationReviewRow[], action: "delete" | "recover") => Promise<BulkResult>;
}

const PREVIEW_LIMIT = 32 * 1024;

/** Explicit repository-file review, separate from the staging/review queue.
 *  Renders into any container (the Review tab). The injected backend must
 *  validate identity/revision and serialize decisions with sync, including
 *  saving recoverable originals before deletion. Rows are frozen at render
 *  time; stale async responses are discarded via a generation counter. */
export class ReconciliationReview {
  private readonly rows: ReconciliationReviewRow[];
  private root?: HTMLElement;
  private generation = 0;
  private closed = true;
  private deciding = false;
  private selected = 0;
  private query = "";
  private fileButtons: HTMLButtonElement[] = [];
  private bulk?: BulkReview;

  constructor(private readonly deps: ReconciliationReviewDeps) {
    // Keep exactly the reviewed identity even if the caller refreshes its rows.
    this.rows = deps.rows.map((row) => Object.freeze({ ...row }));
  }

  /** True while a decision is executing — callers use this to skip refreshes. */
  isBusy(): boolean {
    return this.deciding || (this.bulk?.isBusy() ?? false);
  }

  /** Stop accepting async results; the host is closing or replacing us. */
  detach(): void {
    this.closed = true;
    this.generation++;
    this.bulk?.detach();
  }

  render(root: HTMLElement): void {
    this.root = root;
    this.bulk?.detach();
    this.closed = false;
    root.empty();
    root.style.maxWidth = "100%";
    root.style.overflowWrap = "anywhere";
    // addClass (not setAttribute) so a host container keeps its own classes.
    root.addClass("mugs-reconciliation");
    root.createEl("h2", { text: "Review repository files", cls: "mugs-page-title" });
    root.createEl("p", {
      text: "These files were kept in the repository because MUGS couldn't confirm they were safe to delete. Preview a file, then choose what to keep.",
      cls: "mugs-page-description",
    });
    if (!this.rows.length) {
      root.createEl("p", { text: "No files to review. Run sync to check for files kept in the repository." });
      return;
    }
    this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
    if (this.deps.analyze && this.deps.decideBatch) {
      this.bulk = new BulkReview({
        analyze: this.deps.analyze,
        compare: this.deps.compare,
        decide: this.deps.decideBatch,
        blocked: () => this.deciding,
      });
      this.bulk.render(root.createDiv({ cls: "mugs-bulk-review" }));
    }

    const layout = root.createDiv({ cls: "mugs-recon-layout" });
    const sidebar = layout.createDiv({ cls: "mugs-recon-sidebar" });
    const tools = sidebar.createDiv({ cls: "mugs-recon-tools" });
    const count = tools.createEl("span", { cls: "mugs-file-count", text: `${this.rows.length} files` });
    const search = tools.createEl("input", {
      type: "search",
      cls: "mugs-recon-search",
      attr: { placeholder: "Filter files…", "aria-label": "Filter files by name, path or folder" },
    });
    search.value = this.query;
    const list = sidebar.createEl("nav", { cls: "mugs-recon-files", attr: { "aria-label": "Files to review" } });
    const detail = layout.createDiv({ cls: "mugs-recon-detail" });
    const renderFiles = () => {
      list.empty();
      this.fileButtons = [];
      const query = this.query.trim().toLocaleLowerCase();
      let visible = 0;
      this.rows.forEach((row, index) => {
        if (query && !`${row.mappingLabel} ${row.path}`.toLocaleLowerCase().includes(query)) return;
        visible++;
        const name = row.path.slice(row.path.lastIndexOf("/") + 1);
        const parent = row.path.slice(0, Math.max(0, row.path.lastIndexOf("/")));
        const label = `${row.mappingLabel || row.mappingId} — ${row.path}`;
        const file = list.createEl("button", {
          type: "button",
          cls: "mugs-recon-file",
          attr: { title: label, "aria-label": label, ...(index === this.selected ? { "aria-current": "true" } : {}) },
        });
        file.createSpan({ cls: "mugs-recon-file-name", text: name });
        file.createSpan({ cls: "mugs-recon-file-location", text: [row.mappingLabel || row.mappingId, parent].filter(Boolean).join(" · ") });
        this.fileButtons.push(file);
        file.addEventListener("click", () => {
          if (this.closed || this.isBusy() || index === this.selected) return;
          this.selected = index;
          // Keep the list mounted: selecting a file must not lose scroll or focus.
          for (const button of this.fileButtons) {
            if (button === file) button.setAttribute("aria-current", "true");
            else button.removeAttribute("aria-current");
          }
          void this.showSelection(detail);
        });
      });
      count.textContent = query ? `${visible} of ${this.rows.length} files` : `${this.rows.length} file${this.rows.length === 1 ? "" : "s"}`;
      if (!visible) list.createEl("p", { cls: "mugs-muted", text: "No matching files." });
    };
    search.addEventListener("input", () => {
      if (this.closed || this.isBusy()) return;
      this.query = search.value;
      renderFiles();
    });
    renderFiles();
    void this.showSelection(detail);
  }

  private async showSelection(detail: HTMLElement): Promise<void> {
    const generation = ++this.generation;
    const row = this.rows[this.selected];
    const current = () => !this.closed && generation === this.generation;
    let ready = false;
    detail.empty();
    const header = detail.createDiv({ cls: "mugs-recon-heading" });
    header.createEl("h3", { text: row.path.slice(row.path.lastIndexOf("/") + 1), cls: "mugs-recon-title" });
    header.createEl("p", { text: row.path, cls: "mugs-recon-path" });
    header.createEl("p", { text: `${row.mappingLabel || row.mappingId} · ${directionLabel(row.direction)}`, cls: "mugs-recon-context" });
    const revision = header.createEl("details", { cls: "mugs-recon-version" });
    revision.createEl("summary", { text: "Version details" });
    revision.createEl("p", { text: `Connection: ${row.mappingId}` });
    revision.createEl("p", { text: `Repository commit: ${row.ref}` });
    if (row.reason) revision.createEl("p", { text: `Kept because: ${row.reason}` });
    const previewBar = detail.createDiv({ cls: "mugs-recon-preview-bar" });
    previewBar.createSpan({ text: "Repository preview", cls: "mugs-file-count" });
    const status = previewBar.createEl("span", { text: "Loading preview…", cls: "mugs-recon-preview-status" });
    status.setAttribute("role", "status");
    const retry = previewBar.createEl("button", { text: "Retry preview", type: "button" });
    retry.hidden = true;
    retry.disabled = true;
    const preview = detail.createEl("pre", { cls: "mugs-recon-preview", attr: { tabindex: "0", "aria-label": `Repository preview of ${row.path}` } });
    preview.style.whiteSpace = "pre-wrap";
    preview.style.overflowWrap = "anywhere";
    preview.style.overflow = "auto";
    const error = detail.createEl("p", { cls: "mugs-recon-error" });
    error.setAttribute("role", "alert");
    retry.addEventListener("click", () => {
      if (current() && !this.isBusy() && !retry.disabled) this.render(this.root!);
    });
    const actions = detail.createDiv({ cls: "mugs-recon-primary" });
    const recover = actions.createEl("button", { text: "Add to vault", type: "button", cls: "mod-cta" });
    actions.createEl("p", {
      text: row.direction === "push-only"
        ? "Add to vault copies this file to your device, even with Upload only."
        : "Add to vault copies this file to your device.",
      cls: "mugs-muted",
    });
    const deletion = detail.createEl("details", { cls: "mugs-recon-deletion" });
    deletion.createEl("summary", { text: "Delete from repository…" });
    if (row.direction === "pull-only") {
      deletion.createEl("p", { text: "Download only: deleting repository files isn't allowed." });
    }
    // Wrapping label associates the native checkbox directly with its file.
    const confirmationLabel = deletion.createEl("label");
    const confirmation = confirmationLabel.createEl("input", { type: "checkbox" });
    confirmation.required = true;
    confirmationLabel.createEl("span", {
      text: `Delete "${row.path}" from the repository for "${row.mappingLabel || row.mappingId}". A recovery backup must be saved first. This affects other users too.`,
    });
    const remove = deletion.createEl("button", { text: "Delete from repository", type: "button" });
    const update = () => {
      const blocked = !current() || !ready || this.deciding;
      recover.disabled = blocked;
      confirmation.disabled = blocked || row.direction === "pull-only";
      remove.disabled = blocked || row.direction === "pull-only" || !confirmation.checked;
      for (const button of this.fileButtons) button.disabled = this.deciding;
    };
    confirmation.addEventListener("change", update);
    const decide = async (action: "delete" | "recover") => {
      if (!current() || !ready || this.isBusy()) return;
      if (action === "delete" && (row.direction === "pull-only" || !confirmation.checked)) return;
      this.deciding = true;
      error.textContent = "";
      status.textContent = action === "recover" ? "Adding to vault…" : "Saving backup and deleting repository file…";
      update();
      try {
        await this.deps.decide(row, action);
        // Remove successful decisions even if closed; never redraw a closed host.
        this.rows.splice(this.rows.indexOf(row), 1);
        this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
        this.deciding = false;
        if (!current()) return;
        this.render(this.root!);
      } catch (cause) {
        this.deciding = false;
        if (!current()) return;
        confirmation.checked = false;
        error.textContent = `Could not ${action === "recover" ? "add" : "delete"} file: ${this.errorText(cause)}. Check the error before retrying.`;
        status.textContent = "Not completed. The file remains in this review.";
        update();
      }
    };
    recover.addEventListener("click", () => { void decide("recover"); });
    remove.addEventListener("click", () => { void decide("delete"); });
    update();
    try {
      const text = await this.deps.preview(row);
      if (!current()) return;
      preview.textContent = text.slice(0, PREVIEW_LIMIT);
      status.textContent = text.length > PREVIEW_LIMIT
        ? `Preview shortened to ${PREVIEW_LIMIT} characters. Actions apply to the entire file.`
        : "Preview ready. Actions apply to the entire file.";
      ready = true;
      update();
    } catch (cause) {
      if (!current()) return;
      status.textContent = "Preview unavailable. Load a preview before making changes.";
      error.textContent = `Could not load preview: ${this.errorText(cause)}`;
      retry.disabled = this.deciding;
      retry.hidden = false;
      update();
    }
  }

  private errorText(cause: unknown): string {
    return (cause instanceof Error ? cause.message : String(cause)).slice(0, PREVIEW_LIMIT);
  }
}
