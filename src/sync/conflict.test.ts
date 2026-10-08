import { describe, it, expect } from "vitest";
import {
  collectConflicts,
  resolveConflict,
  applyResolution,
  isResolved,
  unresolvedConflicts,
  applyMerge,
  type FileConflict,
  type FileVersions,
} from "./conflict";
import type { FileDiff } from "./classifier";

const J = (lines: string[]): string => lines.join("\n");

describe("collectConflicts", () => {
  it("keeps only divergent files with base/ours/theirs captured", () => {
    const diffs: FileDiff[] = [
      { path: "clean", local: J(["a", "b"]), remote: J(["a", "B"]), base: J(["a", "b"]) }, // remote-only -> not a conflict
      { path: "ours-only", local: "L", remote: "base", base: "base" }, // local only
      { path: "bad", local: "L", remote: "R", base: "base" }, // divergent
    ];
    expect(collectConflicts(diffs)).toEqual([{ path: "bad", base: "base", ours: "L", theirs: "R" }]);
  });

  it("captures undefined sides as empty strings", () => {
    const diffs: FileDiff[] = [{ path: "del", local: undefined, remote: "R", base: "base" }];
    // local undefined + remote changed vs base -> divergent (both changed relative to base)
    expect(collectConflicts(diffs)).toEqual([{ path: "del", base: "base", ours: "", theirs: "R" }]);
  });
});

describe("resolveConflict", () => {
  const c: FileConflict = { path: "f", base: "b", ours: "O", theirs: "T" };

  it("takes ours", () => {
    expect(resolveConflict(c, "ours")).toBe("O");
  });

  it("takes theirs", () => {
    expect(resolveConflict(c, "theirs")).toBe("T");
  });

  it("both: concatenates when the sides still diverge", () => {
    expect(resolveConflict(c, "both")).toBe(J(["O", "T"]));
  });

  it("both: auto-merges non-overlapping edits cleanly", () => {
    const clean: FileConflict = { path: "f", base: J(["a", "b", "c"]), ours: J(["A", "b", "c"]), theirs: J(["a", "b", "C"]) };
    expect(resolveConflict(clean, "both")).toBe(J(["A", "b", "C"]));
  });
});

describe("applyResolution / isResolved / unresolvedConflicts", () => {
  it("marks a conflict resolved and records its content", () => {
    const c: FileConflict = { path: "f", ours: "O", theirs: "T" };
    const done = applyResolution(c, "ours");
    expect(isResolved(done)).toBe(true);
    expect(done.resolvedContent).toBe("O");
    // original is untouched (immutability)
    expect(isResolved(c)).toBe(false);
  });

  it("filters to only unresolved conflicts", () => {
    const list: FileConflict[] = [
      { path: "a", ours: "1", theirs: "2" },
      applyResolution({ path: "b", ours: "3", theirs: "4" }, "theirs"),
    ];
    expect(unresolvedConflicts(list).map((c) => c.path)).toEqual(["a"]);
  });
});

describe("applyMerge — clean vs divergent per file", () => {
  it("applies remote-only changes and records divergent files as conflicts", () => {
    const entries: FileVersions[] = [
      { path: "clean.md", base: J(["a", "b"]), ours: J(["a", "b"]), theirs: J(["a", "B"]) }, // remote-only
      { path: "bad.md", base: "base", ours: "L", theirs: "R" }, // divergent
    ];
    const { applied, conflicts } = applyMerge(entries);
    expect(applied).toEqual([{ path: "clean.md", content: J(["a", "B"]) }]);
    expect(conflicts).toEqual([{ path: "bad.md", base: "base", ours: "L", theirs: "R" }]);
  });

  it("omits files whose merged result equals local (no-op) and merges non-overlapping edits", () => {
    const entries: FileVersions[] = [
      { path: "same.md", base: J(["a", "b"]), ours: J(["a", "b"]), theirs: J(["a", "b"]) }, // unchanged
      { path: "both.md", base: J(["a", "b", "c"]), ours: J(["A", "b", "c"]), theirs: J(["a", "b", "C"]) }, // non-overlapping
    ];
    const { applied, conflicts } = applyMerge(entries);
    expect(applied).toEqual([{ path: "both.md", content: J(["A", "b", "C"]) }]);
    expect(conflicts).toEqual([]);
  });
});
