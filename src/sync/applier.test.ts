import { describe, it, expect } from "vitest";
import { orderApplyOps, ApplyGuard, type ApplyOp } from "./applier";

describe("orderApplyOps — writes before deletes, parents first", () => {
  const kinds = (a: ApplyOp[]): string[] => a.map((o) => o.kind);
  const paths = (a: ApplyOp[]): string[] => a.map((o) => o.path);

  it("applies all writes before any delete", () => {
    expect(kinds(orderApplyOps([{ path: "a.txt", kind: "delete" }, { path: "b.txt", kind: "write" }]))).toEqual([
      "write",
      "delete",
    ]);
  });

  it("writes parents before children (shallower first)", () => {
    expect(paths(orderApplyOps([{ path: "docs/guide.md", kind: "write" }, { path: "docs", kind: "write" }]))).toEqual([
      "docs",
      "docs/guide.md",
    ]);
  });

  it("is deterministic for equal depth/kind (lexicographic)", () => {
    expect(paths(orderApplyOps([{ path: "b.txt", kind: "write" }, { path: "a.txt", kind: "write" }]))).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  it("deletes deepest first (children before their now-empty parent)", () => {
    expect(paths(orderApplyOps([{ path: "docs", kind: "delete" }, { path: "docs/guide.md", kind: "delete" }]))).toEqual([
      "docs/guide.md",
      "docs",
    ]);
  });

  it("orders a mixed set: writes shallow-first, then deletes deepest-first", () => {
    const ops: ApplyOp[] = [
      { path: "z.txt", kind: "delete" },
      { path: "a/b/c.md", kind: "write" },
      { path: "a", kind: "delete" },
      { path: "a/b", kind: "delete" },
    ];
    // write first; then deletes deepest-first (a/b) with depth-1 ties lexicographic (a < z.txt)
    expect(paths(orderApplyOps(ops))).toEqual(["a/b/c.md", "a/b", "a", "z.txt"]);
  });
});

describe("ApplyGuard — per-path re-entrancy", () => {
  it("blocks a re-entrant apply of the same path", () => {
    const g = new ApplyGuard();
    expect(g.enter("a.md")).toBe(true);
    expect(g.isApplying("a.md")).toBe(true);
    expect(g.enter("a.md")).toBe(false);
  });

  it("withLock skips when the path is already active", async () => {
    const g = new ApplyGuard();
    g.enter("a.md");
    let calls = 0;
    const r = await g.withLock("a.md", async () => {
      calls++;
      return "x";
    });
    expect(r.applied).toBe(false);
    expect(calls).toBe(0);
    g.exit("a.md");
  });

  it("applies once and releases the lock so a later call runs", async () => {
    const g = new ApplyGuard();
    const r1 = await g.withLock("a.md", async () => "first");
    expect(r1.applied).toBe(true);
    expect(r1.result).toBe("first");
    const r2 = await g.withLock("a.md", async () => "second");
    expect(r2.applied).toBe(true);
    expect(r2.result).toBe("second");
    expect(g.size).toBe(0);
  });

  it("keeps distinct paths independent", async () => {
    const g = new ApplyGuard();
    g.enter("a.md");
    expect(g.isApplying("b.md")).toBe(false);
    g.exit("a.md");
    expect(g.size).toBe(0);
  });
});
