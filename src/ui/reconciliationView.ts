/**
 * MUGS — repository-file review tab (`mugs-reconciliation`).
 *
 * Hosts the {@link ReconciliationReview} component inside a normal workspace
 * tab (replacing the old popup modal) so it matches the Overview/Changes/
 * Conflicts pages: shared navigation, refresh action, and a refresh pushed by
 * the plugin's UI events — but never mid-decision.
 */
import { ItemView, type WorkspaceLeaf } from "obsidian";
import type MugsPlugin from "../main";
import { ReconciliationReview } from "./reconciliationReview";
import { renderNavigation } from "./navigation";
import { getMugsContext } from "./dataSources";

export const MUGS_RECONCILIATION_VIEW_TYPE = "mugs-reconciliation";

export class ReconciliationView extends ItemView {
  private review?: ReconciliationReview;
  private unsubscribe?: () => void;
  private closed = true;
  private host?: HTMLElement;

  constructor(private readonly plugin: MugsPlugin, leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return MUGS_RECONCILIATION_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "MUGS Review";
  }

  getIcon(): string {
    return "file-search";
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.empty();
    this.contentEl.addClass("mugs-review-view");
    renderNavigation(this.contentEl, MUGS_RECONCILIATION_VIEW_TYPE);
    // The component empties its container on every render, so it owns a child
    // host — never the view root (which also holds the shared navigation).
    this.host = this.contentEl.createDiv({ cls: "mugs-review-host" });
    this.addAction("refresh", "Refresh review", () => void this.refresh());
    this.unsubscribe?.();
    this.unsubscribe = getMugsContext().actions?.subscribe?.(() => {
      // Sync finished: pick up newly queued/resolved files — unless a decision
      // is mid-flight (the component re-renders itself when it settles).
      if (!this.review?.isBusy()) void this.refresh();
    });
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.review?.detach();
    this.review = undefined;
    this.host = undefined;
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async refresh(): Promise<void> {
    if (this.closed || this.review?.isBusy()) return;
    const previous = this.review;
    previous?.detach();
    this.review = new ReconciliationReview(this.plugin.reconciliationDeps());
    this.review.render(this.host ?? this.contentEl);
  }
}
