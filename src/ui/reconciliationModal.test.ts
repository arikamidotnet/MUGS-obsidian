import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ReconciliationModal, type ReconciliationReviewRow } from "./reconciliationModal";

// Test-local fake DOM/Modal follows views.test.ts without changing the shared
// Obsidian stub or adding a browser dependency. HTML sinks deliberately throw.
const { El } = vi.hoisted(() => {
  class El {
    children: El[] = [];
    handlers: Record<string, (() => void)[]> = {};
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
    createEl(tag: string, opts?: { text?: string; type?: string }): El {
      const el = new El(tag);
      el.textContent = opts?.text ?? "";
      el.type = opts?.type ?? "";
      this.children.push(el);
      return el;
    }
    createDiv(): El { return this.createEl("div"); }
    empty(): void { this.children = []; }
    setAttribute(key: string, value: string): void { this.attrs[key] = value; }
    addEventListener(type: string, handler: () => void): void {
      (this.handlers[type] ??= []).push(handler);
    }
    fire(type: string): void {
      // Deliberately bypass disabled here to also exercise handler safety guards.
      this.handlers[type]?.forEach((handler) => handler());
    }
  }
  return { El };
});

vi.mock("obsidian", () => ({
  Modal: class {
    contentEl = new El("div");
    constructor(_app: unknown) {}
    onOpen(): void {}
    onClose(): void {}
    open(): void { this.onOpen(); }
    close(): void { this.onClose(); }
  },
}));

type FakeEl = InstanceType<typeof El>;
const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
const text = (el: FakeEl): string => walk(el).map((child) => child.textContent).join("\n");
const root = (modal: ReconciliationModal): FakeEl => modal.contentEl as unknown as FakeEl;
const tag = (modal: ReconciliationModal, name: string): FakeEl => walk(root(modal)).find((el) => el.tagName === name)!;
const button = (modal: ReconciliationModal, label: string): FakeEl =>
  walk(root(modal)).find((el) => el.tagName === "button" && el.textContent === label)!;
const recover = (modal: ReconciliationModal): FakeEl => button(modal, "Recover into vault (explicit import)");
const remove = (modal: ReconciliationModal): FakeEl => button(modal, "Delete remote file");
const checkbox = (modal: ReconciliationModal): FakeEl => tag(modal, "input");
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
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
  const modal = new ReconciliationModal({} as App, { rows, preview, decide });
  modal.onOpen();
  return { modal, preview, decide };
};
const confirm = (modal: ReconciliationModal): void => {
  checkbox(modal).checked = true;
  checkbox(modal).fire("change");
};
const select = (modal: ReconciliationModal, index: number): void => {
  const picker = tag(modal, "select");
  picker.value = String(index);
  picker.fire("change");
};

describe("ReconciliationModal", () => {
  it("explains empty discovery without calling the backend", () => {
    const { modal, preview, decide } = make([]);
    expect(text(root(modal))).toContain("Reconcile remote-only files");
    expect(text(root(modal))).toContain("Run sync first");
    expect(text(root(modal))).toContain("safety guard");
    expect(preview).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(walk(root(modal)).some((el) => el.tagName === "button")).toBe(false);
  });

  it("shows literal full identity and bounded preview, using labeled native controls", async () => {
    const selected = row({ mappingLabel: "<img src=x onerror=alert(1)>", path: `${"long/".repeat(200)}<script>.md` });
    const content = "<script>alert('literal')</script>\n" + "x".repeat(40000);
    const { modal } = make([selected], vi.fn(async () => content));
    await flush();
    const rendered = text(root(modal));
    for (const literal of [selected.path, selected.mappingLabel, selected.mappingId, selected.ref, selected.direction, selected.reason!]) {
      expect(rendered).toContain(literal);
    }
    expect(tag(modal, "pre").textContent).toBe(content.slice(0, 32768));
    expect(rendered).toContain("Preview truncated");
    expect(rendered).toContain("entire file");
    expect(tag(modal, "pre").style.overflow).toBe("auto");
    expect(root(modal).style.overflowWrap).toBe("anywhere");
    const labels = walk(root(modal)).filter((el) => el.tagName === "label");
    expect(labels.some((el) => el.children.includes(tag(modal, "select")))).toBe(true);
    expect(labels.some((el) => el.children.includes(checkbox(modal)))).toBe(true);
    expect(checkbox(modal).type).toBe("checkbox");
    expect(checkbox(modal).required).toBe(true);
    expect(recover(modal).type).toBe("button");
    expect(remove(modal).type).toBe("button");
  });

  it("blocks actions until preview resolves and deletion until exact-row confirmation", async () => {
    const pending = deferred<string>();
    const { modal, decide } = make([row()], vi.fn(() => pending.promise));
    expect(recover(modal).disabled).toBe(true);
    expect(remove(modal).disabled).toBe(true);
    expect(checkbox(modal).disabled).toBe(true);
    recover(modal).fire("click");
    confirm(modal);
    remove(modal).fire("click");
    expect(decide).not.toHaveBeenCalled();
    // Native disabled checkbox cannot be checked by a user while loading.
    checkbox(modal).checked = false;
    pending.resolve("ready");
    await flush();
    expect(recover(modal).disabled).toBe(false);
    expect(remove(modal).disabled).toBe(true);
    remove(modal).fire("click");
    expect(decide).not.toHaveBeenCalled();
    confirm(modal);
    expect(remove(modal).disabled).toBe(false);
    remove(modal).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledWith(row(), "delete");
    expect(root(modal).children).toHaveLength(0);
  });

  it.each(["push-only", "pull-only", "push-pull"] as const)("permits explicit recovery for %s", async (direction) => {
    const selected = row({ direction });
    const { modal, decide } = make([selected]);
    await flush();
    expect(text(root(modal))).toContain("explicit user-requested import");
    expect(text(root(modal))).toContain("including for push-only");
    expect(recover(modal).disabled).toBe(false);
    expect(checkbox(modal).checked).toBe(false);
    recover(modal).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledWith(selected, "recover");
    expect(root(modal).children).toHaveLength(0);
  });

  it("never deletes pull-only files, including direct handler invocation", async () => {
    const { modal, decide } = make([row({ direction: "pull-only" })]);
    await flush();
    expect(text(root(modal))).toContain("not permitted for pull-only");
    confirm(modal);
    expect(remove(modal).disabled).toBe(true);
    expect(checkbox(modal).disabled).toBe(true);
    remove(modal).fire("click");
    expect(decide).not.toHaveBeenCalled();
  });

  it("ignores stale successful previews and detached row action handlers", async () => {
    const pending = deferred<string>();
    const { modal, decide } = make([row(), row({ path: "second.md" })],
      vi.fn(async (selected) => selected.path === "second.md" ? "CURRENT" : pending.promise));
    const oldRecover = recover(modal);
    select(modal, 1);
    await flush();
    pending.resolve("STALE CONTENT");
    await flush();
    expect(tag(modal, "pre").textContent).toBe("CURRENT");
    expect(text(root(modal))).not.toContain("STALE CONTENT");
    oldRecover.fire("click");
    expect(decide).not.toHaveBeenCalled();
  });

  it("drops stale preview results/errors and resets confirmation when selection changes", async () => {
    const pending = deferred<string>();
    const { modal } = make([row(), row({ mappingId: "m2", path: "second.md" })],
      vi.fn(async (selected) => selected.mappingId === "m1" ? pending.promise : "SECOND"));
    select(modal, 1);
    await flush();
    confirm(modal);
    select(modal, 0);
    expect(checkbox(modal).checked).toBe(false);
    select(modal, 1);
    await flush();
    pending.reject(new Error("STALE"));
    await flush();
    expect(text(root(modal))).not.toContain("STALE");
    expect(tag(modal, "pre").textContent).toBe("SECOND");
    expect(checkbox(modal).checked).toBe(false);
    expect(remove(modal).disabled).toBe(true);
  });

  it("does not redraw or decide after close while preview is pending", async () => {
    const pending = deferred<string>();
    const { modal, decide } = make([row()], vi.fn(() => pending.promise));
    const oldRecover = recover(modal);
    modal.onClose();
    pending.resolve("AFTER CLOSE");
    await flush();
    oldRecover.fire("click");
    expect(root(modal).children).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();
  });

  it("renders preview errors literally and allows a safe preview retry", async () => {
    const preview = vi.fn()
      .mockRejectedValueOnce(new Error("<b>read failed</b>"))
      .mockResolvedValueOnce("retried text");
    const { modal, decide } = make([row()], preview);
    await flush();
    expect(text(root(modal))).toContain("<b>read failed</b>");
    expect(recover(modal).disabled).toBe(true);
    expect(remove(modal).disabled).toBe(true);
    expect(button(modal, "Retry preview").disabled).toBe(false);
    recover(modal).fire("click");
    expect(decide).not.toHaveBeenCalled();
    button(modal, "Retry preview").fire("click");
    await flush();
    expect(tag(modal, "pre").textContent).toBe("retried text");
    expect(recover(modal).disabled).toBe(false);
    expect(remove(modal).disabled).toBe(true);
  });

  it("serializes decisions, locks selection, and requires fresh confirmation after failure", async () => {
    const pending = deferred<void>();
    const decide = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    const { modal } = make([row(), row({ path: "second.md" })], undefined, decide);
    await flush();
    confirm(modal);
    remove(modal).fire("click");
    expect(tag(modal, "select").disabled).toBe(true);
    expect(recover(modal).disabled).toBe(true);
    expect(remove(modal).disabled).toBe(true);
    expect(checkbox(modal).disabled).toBe(true);
    recover(modal).fire("click");
    remove(modal).fire("click");
    select(modal, 1);
    expect(decide).toHaveBeenCalledTimes(1);
    pending.reject(new Error("<script>stale revision</script>"));
    await flush();
    expect(text(root(modal))).toContain("<script>stale revision</script>");
    expect(text(root(modal))).toContain("file remains in this review");
    expect(checkbox(modal).checked).toBe(false);
    expect(remove(modal).disabled).toBe(true);
    expect(recover(modal).disabled).toBe(false);
    expect(tag(modal, "select").disabled).toBe(false);
    confirm(modal);
    remove(modal).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(tag(modal, "select").children).toHaveLength(1);
    expect(text(root(modal))).toContain("second.md");
    expect(checkbox(modal).checked).toBe(false);
  });

  it("uses an immutable snapshot and removes success without rendering after close", async () => {
    const selected = row();
    const pending = deferred<void>();
    const { modal, preview, decide } = make([selected], undefined, vi.fn(() => pending.promise));
    selected.ref = "caller-ref-changed";
    selected.path = "caller-path-changed";
    await flush();
    const snapshot = preview.mock.calls[0][0];
    expect(Object.isFrozen(snapshot)).toBe(true);
    recover(modal).fire("click");
    expect(decide).toHaveBeenCalledWith(snapshot, "recover");
    modal.onClose();
    pending.resolve(undefined);
    await flush();
    expect(root(modal).children).toHaveLength(0);
    modal.onOpen();
    expect(text(root(modal))).toContain("No remote-only files");
  });

  it("keeps failed recovery available for explicit retry without delete confirmation", async () => {
    const decide = vi.fn().mockRejectedValueOnce(new Error("vault unavailable")).mockResolvedValueOnce(undefined);
    const { modal } = make([row({ direction: "push-only" })], undefined, decide);
    await flush();
    recover(modal).fire("click");
    await flush();
    expect(text(root(modal))).toContain("vault unavailable");
    expect(recover(modal).disabled).toBe(false);
    expect(remove(modal).disabled).toBe(true);
    recover(modal).fire("click");
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(root(modal).children).toHaveLength(0);
  });
});
