import { describe, expect, it, vi } from "vitest";
import { ReconciliationReview, type ReconciliationReviewRow } from "./reconciliationReview";
import { BulkReview } from "./reconciliationBulk";
import type { ReviewAnalysis, BulkResult } from "../runtime/reconciliationBulk";

// Test-local fake DOM follows views.test.ts without changing the shared
// Obsidian stub or adding a browser dependency. HTML sinks deliberately throw.
const { El } = vi.hoisted(() => {
  class El {
    children: El[] = [];
    handlers: Record<string, ((e?: unknown) => void)[]> = {};
    attrs: Record<string, string> = {};
    style: Record<string, string> = {};
    textContent = "";
    value = "";
    type = "";
    checked = false;
    required = false;
    disabled = false;
    constructor(public tagName: string) {}
    set innerHTML(_value: string) { throw new Error("HTML injection sink"); }
    createEl(tag: string, opts?: { text?: string; type?: string; cls?: string; attr?: Record<string, string> }): El {
      const el = new El(tag);
      el.textContent = opts?.text ?? "";
      el.type = opts?.type ?? "";
      if (opts?.cls) el.attrs["class"] = opts.cls;
      for (const [k, v] of Object.entries(opts?.attr ?? {})) el.setAttribute(k, v);
      this.children.push(el);
      return el;
    }
    createDiv(opts?: { cls?: string }): El { return this.createEl("div", opts); }
    createSpan(opts?: { text?: string; cls?: string }): El { return this.createEl("span", opts); }
    empty(): void { this.children = []; }
    setAttribute(key: string, value: string): void { this.attrs[key] = value; }
    removeAttribute(key: string): void { delete this.attrs[key]; }
    addClass(cls: string): void { this.attrs["class"] = `${this.attrs["class"] ?? ""} ${cls}`.trim(); }
    addEventListener(type: string, handler: (e?: unknown) => void): void {
      (this.handlers[type] ??= []).push(handler);
    }
    fire(type: string): void {
      // Deliberately bypass disabled here to also exercise handler safety.
      this.handlers[type]?.forEach((handler) => handler());
    }
  }
  return { El };
});

type FakeEl = InstanceType<typeof El>;
const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const text = (el: FakeEl): string => walk(el).map((child) => child.textContent).join("\n");
const tag = (root: FakeEl, name: string): FakeEl => walk(root).find((el) => el.tagName === name)!;
const button = (root: FakeEl, label: string): FakeEl =>
  walk(root).find((el) => el.tagName === "button" && el.textContent === label)!;
const fileButtons = (root: FakeEl): FakeEl[] =>
  walk(root).filter((el) => el.tagName === "button" && (el.attrs["class"] ?? "").includes("mugs-recon-file"));
const recover = (root: FakeEl): FakeEl => button(root, "Add to vault");
const remove = (root: FakeEl): FakeEl => button(root, "Delete from repository");
const checkbox = (root: FakeEl): FakeEl => walk(root).find((el) => el.tagName === "input" && el.type === "checkbox")!;
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const row = (over: Partial<ReconciliationReviewRow> = {}): ReconciliationReviewRow => ({
  mappingId: "m1", mappingLabel: "Notes", path: "repo/notes/remote-only.md",
  ref: "0123456789abcdef0123456789abcdef01234567", blob: "blob-id",
  fingerprint: "mapping-identity", direction: "push-pull", reason: "Unknown history", ...over,
});
const make = (
  rows = [row()],
  preview = vi.fn(async (_row: ReconciliationReviewRow) => "remote text"),
  decide = vi.fn(async (_row: ReconciliationReviewRow, _action: "delete" | "recover") => {}),
) => {
  const root = new El("div");
  const review = new ReconciliationReview({ rows, preview, decide });
  review.render(root as unknown as HTMLElement);
  return { root, review, preview, decide };
};
const confirm = (root: FakeEl): void => {
  checkbox(root).checked = true;
  checkbox(root).fire("change");
};
const select = (root: FakeEl, index: number): void => {
  fileButtons(root)[index]!.fire("click");
};

const makeBulk = (direction: ReconciliationReviewRow["direction"] = "push-only") => {
  const rows = [row({ direction }), row({ direction, path: "<script>.md" })];
  const analysis: ReviewAnalysis = { scanned: 2, skipped: 0, entries: rows.map(row => ({
    row, category: "exact", matches: ["renamed/local.md"], matchCount: 1,
  })) };
  const root = new El("div");
  const analyze = vi.fn(async (_signal: AbortSignal) => analysis);
  const decide = vi.fn(async (rows: ReconciliationReviewRow[], _action: "delete" | "recover"): Promise<BulkResult> => ({
    persisted: true, rows: rows.map(row => ({ row, status: "applied" })),
  }));
  const bulk = new BulkReview({ analyze, decide, blocked: () => false });
  bulk.render(root as unknown as HTMLElement);
  return { root, bulk, analyze, decide };
};

describe("bulk review UI", () => {
  it("analyzes only on demand and requires preview and explicit confirmation", async () => {
    const f = makeBulk();
    expect(f.analyze).not.toHaveBeenCalled();
    button(f.root, "Analyze review items").fire("click");
    await flush();
    expect(text(f.root)).toContain("2\nExact-content duplicate / move candidates");
    button(f.root, "Preview batch").fire("click");
    expect(text(f.root)).toContain("<script>.md");
    expect(text(f.root)).toContain("renamed/local.md");
    const apply = button(f.root, "Apply confirmed batch");
    expect(apply.disabled).toBe(true);
    apply.fire("click");
    expect(f.decide).not.toHaveBeenCalled();
    confirm(f.root);
    apply.fire("click");
    apply.fire("click");
    await flush();
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.decide.mock.calls[0][0]).toHaveLength(2);
    expect(f.decide.mock.calls[0][1]).toBe("recover");
    expect(text(f.root)).toContain("2 applied; 0 re-queued; 0 pending");
  });

  it("loads a comparison only when the candidate is selected and never treats it as consent", async () => {
    const f = makeBulk();
    const compare = vi.fn(async () => ({ local: "same bytes", remote: "same bytes" }));
    const bulk = new BulkReview({ analyze: f.analyze, compare, decide: f.decide, blocked: () => false });
    const root = new El("div");
    bulk.render(root as unknown as HTMLElement);
    button(root, "Analyze review items").fire("click");
    await flush();
    button(root, "Preview batch").fire("click");
    expect(compare).not.toHaveBeenCalled();
    button(root, "Compare with renamed/local.md").fire("click");
    await flush();
    expect(compare).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain("Saved vault bytes and reviewed repository bytes are identical");
    expect(f.decide).not.toHaveBeenCalled();
    expect(button(root, "Apply confirmed batch").disabled).toBe(true);
  });

  it.each(["cancel", "replace", "change", "detach", "reanalyze"])("rejects old confirmed controls after %s", async reason => {
    const f = makeBulk();
    button(f.root, "Analyze review items").fire("click");
    await flush();
    button(f.root, "Preview batch").fire("click");
    confirm(f.root);
    const old = button(f.root, "Apply confirmed batch");
    if (reason === "cancel") button(f.root, "Cancel batch").fire("click");
    if (reason === "replace") button(f.root, "Preview batch").fire("click");
    if (reason === "change") tag(f.root, "select").fire("change");
    if (reason === "detach") f.bulk.detach();
    if (reason === "reanalyze") { button(f.root, "Analyze review items").fire("click"); await flush(); }
    old.fire("click");
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("blocks pull-only deletion, and cancellation records no intent", async () => {
    const f = makeBulk("pull-only");
    button(f.root, "Analyze review items").fire("click");
    await flush();
    const selects = walk(f.root).filter(el => el.tagName === "select");
    selects[2].value = "delete";
    selects[2].fire("change");
    button(f.root, "Preview batch").fire("click");
    expect(text(f.root)).toContain("deleting repository files isn't allowed");
    expect(walk(f.root).some(el => el.textContent === "Apply confirmed batch")).toBe(false);
    const pending = deferred<ReviewAnalysis>();
    f.analyze.mockImplementation(() => pending.promise);
    button(f.root, "Analyze review items").fire("click");
    const signal = f.analyze.mock.calls.at(-1)![0];
    button(f.root, "Cancel analysis").fire("click");
    expect(signal.aborted).toBe(true);
    pending.reject(new Error("aborted"));
    await flush();
    expect(text(f.root)).toContain("Analysis cancelled");
    expect(f.decide).not.toHaveBeenCalled();
  });

  it("keeps failure/partial results visible without permitting replay", async () => {
    const f = makeBulk();
    f.decide.mockResolvedValue({ persisted: false, rows: [] });
    button(f.root, "Analyze review items").fire("click");
    await flush();
    button(f.root, "Preview batch").fire("click");
    confirm(f.root);
    const apply = button(f.root, "Apply confirmed batch");
    apply.fire("click");
    await flush();
    expect(text(f.root)).toContain("Effects may be partial");
    apply.fire("click");
    expect(f.decide).toHaveBeenCalledTimes(1);
  });
});

describe("ReconciliationReview (Review tab)", () => {
  it("explains empty discovery without calling the backend", () => {
    const { root, preview, decide } = make([]);
    expect(text(root)).toContain("Review repository files");
    expect(text(root)).toContain("Run sync");
    expect(text(root)).toContain("safe to delete");
    expect(preview).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(walk(root).some((el) => el.tagName === "button")).toBe(false);
  });

  it("lists every file with selection state and full identity on hover, bounded preview, labeled native controls", async () => {
    // The hostile-label row is SELECTED so its literal identity reaches the detail pane.
    const hostile = row({ mappingId: "m2", mappingLabel: "<img src=x onerror=alert(1)>", path: `${"long/".repeat(200)}<script>.md` });
    const plain = row();
    const content = "<script>alert('literal')</script>\n" + "x".repeat(40000);
    const { root } = make([hostile, plain], vi.fn(async () => content));
    await flush();
    const rendered = text(root);
    for (const literal of [hostile.path, hostile.mappingLabel, hostile.mappingId, hostile.ref, "Both ways", hostile.reason!]) {
      expect(rendered).toContain(literal);
    }
    // File list: one button per row, selected marked, full label on hover.
    const files = fileButtons(root);
    expect(files).toHaveLength(2);
    expect(files[0]!.attrs["aria-current"]).toBe("true");
    expect(files[1]!.attrs["aria-current"]).toBeUndefined();
    expect(files[1]!.attrs.title).toBe(`${plain.mappingLabel} — ${plain.path}`);
    expect(files[0]!.type).toBe("button");
    // Bounded literal preview.
    expect(tag(root, "pre").textContent).toBe(content.slice(0, 32768));
    expect(rendered).toContain("Preview shortened");
    expect(rendered).toContain("entire file");
    expect(tag(root, "pre").style.overflow).toBe("auto");
    expect(root.style.overflowWrap).toBe("anywhere");
    // Native controls stay labeled and typed.
    const labels = walk(root).filter((el) => el.tagName === "label");
    expect(labels.some((el) => el.children.includes(checkbox(root)))).toBe(true);
    expect(checkbox(root).type).toBe("checkbox");
    expect(checkbox(root).required).toBe(true);
    expect(recover(root).type).toBe("button");
    expect(remove(root).type).toBe("button");
  });

  it("moves the selection between listed files without reloading the whole page state", async () => {
    const { root, review } = make([row(), row({ mappingId: "m2", path: "second.md" })], vi.fn(async (r) => `content:${r.path}`));
    await flush();
    expect(text(root)).toContain("repo/notes/remote-only.md");
    const mountedFiles = fileButtons(root);
    select(root, 1);
    await flush();
    const files = fileButtons(root);
    expect(files[0]).toBe(mountedFiles[0]);
    expect(files[1]).toBe(mountedFiles[1]);
    expect(files[1]!.attrs["aria-current"]).toBe("true");
    expect(files[0]!.attrs["aria-current"]).toBeUndefined();
    expect(tag(root, "h3").textContent).toBe("second.md");
    expect(tag(root, "pre").textContent).toBe("content:second.md");
    expect(review.isBusy()).toBe(false);
  });

  it("filters by filename, parent path and folder without changing reviewed identity", async () => {
    const first = row();
    const second = row({ path: "research/second.md", mappingLabel: "Research" });
    const { root, decide } = make([first, second]);
    await flush();
    const search = walk(root).find(el => el.tagName === "input" && el.type === "search")!;
    for (const query of ["SECOND", "research/"]) {
      search.value = query;
      search.fire("input");
      expect(fileButtons(root)).toHaveLength(1);
      expect(fileButtons(root)[0].attrs.title).toContain("research/second.md");
    }
    search.value = "no match";
    search.fire("input");
    expect(fileButtons(root)).toHaveLength(0);
    expect(text(root)).toContain("No matching files.");
    expect(tag(root, "h3").textContent).toBe("remote-only.md");
    recover(root).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledWith(first, "recover");
  });

  it("blocks actions until preview resolves and deletion until exact-row confirmation", async () => {
    const pending = deferred<string>();
    const { root, decide } = make([row()], vi.fn(() => pending.promise));
    expect(recover(root).disabled).toBe(true);
    expect(remove(root).disabled).toBe(true);
    expect(checkbox(root).disabled).toBe(true);
    recover(root).fire("click");
    confirm(root);
    remove(root).fire("click");
    expect(decide).not.toHaveBeenCalled();
    // Native disabled checkbox cannot be checked by a user while loading.
    checkbox(root).checked = false;
    pending.resolve("ready");
    await flush();
    expect(recover(root).disabled).toBe(false);
    expect(remove(root).disabled).toBe(true);
    remove(root).fire("click");
    expect(decide).not.toHaveBeenCalled();
    confirm(root);
    expect(remove(root).disabled).toBe(false);
    remove(root).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledWith(row(), "delete");
    // Last decided file: the tab stays open with the empty state, no actions.
    expect(text(root)).toContain("No files to review");
    expect(walk(root).some((el) => el.tagName === "button" && el.textContent === "Add to vault")).toBe(false);
  });

  it.each(["push-only", "pull-only", "push-pull"] as const)("permits explicit recovery for %s", async (direction) => {
    const selected = row({ direction });
    const { root, decide } = make([selected]);
    await flush();
    expect(text(root)).toContain("copies this file to your device");
    if (direction === "push-only") {
      expect(text(root)).toContain("even with Upload only");
    }
    expect(recover(root).disabled).toBe(false);
    expect(checkbox(root).checked).toBe(false);
    recover(root).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledWith(selected, "recover");
    expect(text(root)).toContain("No files to review");
  });

  it("never deletes pull-only files, including direct handler invocation", async () => {
    const { root, decide } = make([row({ direction: "pull-only" })]);
    await flush();
    expect(text(root)).toContain("deleting repository files isn't allowed");
    confirm(root);
    expect(remove(root).disabled).toBe(true);
    expect(checkbox(root).disabled).toBe(true);
    remove(root).fire("click");
    expect(decide).not.toHaveBeenCalled();
  });

  it("ignores stale successful previews and detached row action handlers", async () => {
    const pending = deferred<string>();
    const { root, decide } = make([row(), row({ path: "second.md" })],
      vi.fn(async (selected) => selected.path === "second.md" ? "CURRENT" : pending.promise));
    const oldRecover = recover(root);
    select(root, 1);
    await flush();
    pending.resolve("STALE CONTENT");
    await flush();
    expect(tag(root, "pre").textContent).toBe("CURRENT");
    expect(text(root)).not.toContain("STALE CONTENT");
    oldRecover.fire("click");
    expect(decide).not.toHaveBeenCalled();
  });

  it("drops stale preview results/errors and resets confirmation when selection changes", async () => {
    const pending = deferred<string>();
    const { root } = make([row(), row({ mappingId: "m2", path: "second.md" })],
      vi.fn(async (selected) => selected.mappingId === "m1" ? pending.promise : "SECOND"));
    select(root, 1);
    await flush();
    confirm(root);
    select(root, 0);
    await flush();
    expect(checkbox(root).checked).toBe(false);
    select(root, 1);
    await flush();
    pending.reject(new Error("STALE"));
    await flush();
    expect(text(root)).not.toContain("STALE");
    expect(tag(root, "pre").textContent).toBe("SECOND");
    expect(checkbox(root).checked).toBe(false);
    expect(remove(root).disabled).toBe(true);
  });

  it("does not redraw or decide after detach while preview is pending", async () => {
    const pending = deferred<string>();
    const { root, review, decide } = make([row()], vi.fn(() => pending.promise));
    const oldRecover = recover(root);
    review.detach();
    pending.resolve("AFTER DETACH");
    await flush();
    oldRecover.fire("click");
    expect(text(root)).not.toContain("AFTER DETACH");
    expect(decide).not.toHaveBeenCalled();
  });

  it("renders preview errors literally and allows a safe preview retry", async () => {
    const preview = vi.fn()
      .mockRejectedValueOnce(new Error("<b>read failed</b>"))
      .mockResolvedValueOnce("retried text");
    const { root, decide } = make([row()], preview);
    await flush();
    expect(text(root)).toContain("<b>read failed</b>");
    expect(recover(root).disabled).toBe(true);
    expect(remove(root).disabled).toBe(true);
    expect(button(root, "Retry preview").disabled).toBe(false);
    recover(root).fire("click");
    expect(decide).not.toHaveBeenCalled();
    button(root, "Retry preview").fire("click");
    await flush();
    expect(tag(root, "pre").textContent).toBe("retried text");
    expect(preview).toHaveBeenCalledTimes(2);
  });
});
