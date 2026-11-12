import { Modal, type App } from "obsidian";

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

export interface ReconciliationModalDeps {
  rows: ReconciliationReviewRow[];
  preview: (row: ReconciliationReviewRow) => Promise<string>;
  decide: (row: ReconciliationReviewRow, action: "delete" | "recover") => Promise<void>;
}

const PREVIEW_LIMIT = 32 * 1024;

/** Explicit reconciliation, separate from the staging/review queue.
 * The injected backend must validate identity/revision and serialize decisions
 * with sync, including saving recoverable originals before deletion.
 */
export class ReconciliationModal extends Modal {
  private readonly rows: ReconciliationReviewRow[];
  private generation = 0;
  private closed = true;
  private deciding = false;
  private selected = 0;

  constructor(app: App, private readonly deps: ReconciliationModalDeps) {
    super(app);
    // Keep exactly the reviewed identity even if the caller refreshes its rows.
    this.rows = deps.rows.map((row) => Object.freeze({ ...row }));
  }

  onOpen(): void {
    this.closed = false;
    this.render();
  }

  onClose(): void {
    this.closed = true;
    this.generation++;
    this.contentEl.empty();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.style.maxWidth = "100%";
    root.style.overflowWrap = "anywhere";
    root.createEl("h2", { text: "Reconcile remote-only files" });
    root.createEl("p", {
      text: "Unknown remote-only files are retained by the safety guard because their deletion history cannot be proven. Review a file before explicitly recovering or deleting it.",
    });
    if (!this.rows.length) {
      root.createEl("p", { text: "No remote-only files to review. Run sync first to discover retained files, then open reconciliation again." });
      return;
    }

    // Wrapping labels avoid global IDs and associate native controls directly.
    const label = root.createEl("label");
    label.createEl("span", { text: "Mapping / remote file" });
    const picker = label.createEl("select");
    picker.style.maxWidth = "100%";
    picker.disabled = this.deciding;
    this.rows.forEach((row, index) => {
      const option = picker.createEl("option", { text: `${row.mappingLabel || row.mappingId} — ${row.path}` });
      option.value = String(index);
    });
    picker.value = String(this.selected);
    const detail = root.createDiv();
    picker.addEventListener("change", () => {
      if (this.closed || this.deciding) return;
      const next = Number(picker.value);
      if (!Number.isInteger(next) || !this.rows[next]) return;
      this.selected = next;
      void this.showSelection(detail, picker);
    });
    void this.showSelection(detail, picker);
  }

  private async showSelection(detail: HTMLElement, picker: HTMLSelectElement): Promise<void> {
    const generation = ++this.generation;
    const row = this.rows[this.selected];
    const current = () => !this.closed && generation === this.generation;
    let ready = false;
    detail.empty();
    detail.createEl("p", { text: `Mapping: ${row.mappingLabel || row.mappingId} (${row.mappingId})` });
    detail.createEl("p", { text: `Repository-relative path: ${row.path}` });
    detail.createEl("p", { text: `Remote commit: ${row.ref}` });
    detail.createEl("p", { text: `Direction: ${row.direction}` });
    if (row.reason) detail.createEl("p", { text: `Retained because: ${row.reason}` });
    detail.createEl("p", {
      text: "Recovery is an explicit user-requested import into the vault, including for push-only mappings; it is not automatic sync. Remote deletion requires a recoverable backup of the original before deletion.",
    });
    if (row.direction === "pull-only") {
      detail.createEl("p", { text: "Remote deletion is not permitted for pull-only mappings." });
    }
    const status = detail.createEl("p", { text: "Loading remote preview…" });
    status.setAttribute("role", "status");
    const preview = detail.createEl("pre");
    preview.style.whiteSpace = "pre-wrap";
    preview.style.overflowWrap = "anywhere";
    preview.style.maxHeight = "24rem";
    preview.style.overflow = "auto";
    const error = detail.createEl("p");
    error.setAttribute("role", "alert");
    const retry = detail.createEl("button", { text: "Retry preview", type: "button" });
    retry.disabled = true;
    retry.addEventListener("click", () => {
      if (current() && !this.deciding && !retry.disabled) void this.showSelection(detail, picker);
    });
    const confirmationLabel = detail.createEl("label");
    const confirmation = confirmationLabel.createEl("input", { type: "checkbox" });
    confirmation.required = true;
    confirmationLabel.createEl("span", {
      text: `I confirm deletion of mapping "${row.mappingLabel || row.mappingId}" (${row.mappingId}), path "${row.path}", at remote commit "${row.ref}", and understand that a recoverable backup of the remote original must be saved before deletion.`,
    });
    const recover = detail.createEl("button", { text: "Recover into vault (explicit import)", type: "button" });
    const remove = detail.createEl("button", { text: "Delete remote file", type: "button" });
    const update = () => {
      const blocked = !current() || !ready || this.deciding;
      recover.disabled = blocked;
      confirmation.disabled = blocked || row.direction === "pull-only";
      remove.disabled = blocked || row.direction === "pull-only" || !confirmation.checked;
      picker.disabled = this.deciding;
    };
    confirmation.addEventListener("change", update);
    const decide = async (action: "delete" | "recover") => {
      if (!current() || !ready || this.deciding) return;
      if (action === "delete" && (row.direction === "pull-only" || !confirmation.checked)) return;
      this.deciding = true;
      error.textContent = "";
      status.textContent = action === "recover" ? "Recovering explicitly into the vault…" : "Saving recovery backup and deleting remote file…";
      update();
      try {
        await this.deps.decide(row, action);
        // Remove successful decisions even if closed; never redraw a closed modal.
        this.rows.splice(this.rows.indexOf(row), 1);
        this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
        this.deciding = false;
        if (!current()) return;
        if (!this.rows.length) this.close();
        else this.render();
      } catch (cause) {
        this.deciding = false;
        if (!current()) return;
        confirmation.checked = false;
        error.textContent = `Could not ${action === "recover" ? "recover" : "delete"} file: ${this.errorText(cause)}. No success was confirmed; retry only after checking the error.`;
        status.textContent = "Decision failed; the file remains in this review.";
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
        ? `Preview truncated: showing the first ${PREVIEW_LIMIT} characters only. Actions apply to the entire file.`
        : "Remote preview loaded. Actions apply to the entire file.";
      ready = true;
      update();
    } catch (cause) {
      if (!current()) return;
      status.textContent = "Remote preview unavailable. Actions remain disabled.";
      error.textContent = `Could not load preview: ${this.errorText(cause)}`;
      retry.disabled = this.deciding;
      update();
    }
  }

  private errorText(cause: unknown): string {
    return (cause instanceof Error ? cause.message : String(cause)).slice(0, PREVIEW_LIMIT);
  }
}
