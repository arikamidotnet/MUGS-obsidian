import { describe, it, expect } from "vitest";
import { classifyFile, classifyAll, localChanges, conflicts, type FileDiff } from "./classifier";

/** Helper: a file with the given local/remote/baseline contents. */
const f = (path: string, local?: string, remote?: string, base?: string): FileDiff => ({ path, local, remote, base });

describe("classifyFile", () => {
  it("up-to-date when neither side changed from baseline", () => {
    expect(classifyFile(f("a.txt", "x", "x", "x"))).toBe("up-to-date");
  });

  it("up-to-date for a brand-new file untouched on both sides (undefined base)", () => {
    expect(classifyFile(f("new.txt", undefined, undefined, undefined))).toBe("up-to-date");
  });

  it("local when only local changed", () => {
    expect(classifyFile(f("a.txt", "y", "x", "x"))).toBe("local");
  });

  it("remote when only remote changed", () => {
    expect(classifyFile(f("a.txt", "x", "y", "x"))).toBe("remote");
  });

  it("merged when both sides changed identically", () => {
    expect(classifyFile(f("a.txt", "y", "y", "x"))).toBe("merged");
  });

  it("conflict when both sides changed differently", () => {
    expect(classifyFile(f("a.txt", "y", "z", "x"))).toBe("conflict");
  });

  describe("deletion semantics (undefined content = deleted on that side)", () => {
    it("local deletion only → local (needs to be pushed as a delete)", () => {
      expect(classifyFile(f("a.txt", undefined, "x", "x"))).toBe("local");
    });

    it("remote deletion only → remote (needs to be pulled as a delete)", () => {
      expect(classifyFile(f("a.txt", "x", undefined, "x"))).toBe("remote");
    });

    it("deleted on both sides identically → merged (identical change; matches contract.test.ts)", () => {
      expect(classifyFile(f("a.txt", undefined, undefined, "x"))).toBe("merged");
    });

    it("new file added locally only (undefined base) → local", () => {
      expect(classifyFile(f("fresh.md", "hello", undefined, undefined))).toBe("local");
    });

    it("new file added remotely only (undefined base) → remote", () => {
      expect(classifyFile(f("fresh.md", undefined, "hello", undefined))).toBe("remote");
    });

    it("new file identical on both sides (undefined base) → merged", () => {
      expect(classifyFile(f("fresh.md", "hello", "hello", undefined))).toBe("merged");
    });

    it("empty-string content differs from undefined (a real empty file is not a delete)", () => {
      expect(classifyFile(f("empty.txt", "", "x", "x"))).toBe("local");
      expect(classifyFile(f("empty.txt", "x", "", "x"))).toBe("remote");
    });
  });

  it("treats whitespace/identity strictly (trailing newline matters)", () => {
    expect(classifyFile(f("a.txt", "x\n", "x", "x"))).toBe("local");
    expect(classifyFile(f("a.txt", "x", "x\n", "x"))).toBe("remote");
  });
});

describe("classifyAll", () => {
  it("classifies every file and preserves input order", () => {
    const out = classifyAll([f("z.txt", "y", "x", "x"), f("a.txt", "x", "y", "x")]);
    expect(out).toEqual([
      { path: "z.txt", change: "local" },
      { path: "a.txt", change: "remote" },
    ]);
  });

  it("returns an empty list for no diffs", () => {
    expect(classifyAll([])).toEqual([]);
  });
});

describe("localChanges / conflicts selectors", () => {
  const diffs = [
    f("push.txt", "y", "x", "x"), // local
    f("pull.txt", "x", "y", "x"), // remote
    f("conflict.txt", "y", "z", "x"), // conflict
    f("same.txt", "y", "y", "x"), // merged
    f("clean.txt", "x", "x", "x"), // up-to-date
  ];

  it("localChanges returns only locally-changed paths", () => {
    expect(localChanges(diffs)).toEqual(["push.txt"]);
  });

  it("conflicts returns only diverged paths", () => {
    expect(conflicts(diffs)).toEqual(["conflict.txt"]);
  });

  it("both selectors are empty when nothing changed", () => {
    const clean = [f("a", "x", "x", "x")];
    expect(localChanges(clean)).toEqual([]);
    expect(conflicts(clean)).toEqual([]);
  });
});
