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

  describe("delete-aware classification", () => {
    it("does NOT surface a modify/delete (local deletes, remote modifies) — resolved cleanly", () => {
      const diffs: FileDiff[] = [{ path: "del", local: undefined, remote: "R", base: "base" }];
      expect(collectConflicts(diffs)).toEqual([]);
    });

    it("does NOT surface a delete/delete — both sides removed the file", () => {
      const diffs: FileDiff[] = [{ path: "del", local: undefined, remote: undefined, base: "base" }];
      expect(collectConflicts(diffs)).toEqual([]);
    });

    it("surfaces a genuine add/add conflict (new file, both different) with absent flags omitted", () => {
      const diffs: FileDiff[] = [{ path: "new", local: "L", remote: "R", base: undefined }];
      expect(collectConflicts(diffs)).toEqual([{ path: "new", base: undefined, ours: "L", theirs: "R" }]);
    });

    it("records absent flags on a genuine conflict where one side deleted a new file", () => {
      // base absent + local deleted + remote has it -> keep theirs (no conflict)
      const diffs: FileDiff[] = [{ path: "new", local: undefined, remote: "R", base: undefined }];
      expect(collectConflicts(diffs)).toEqual([]);
    });
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

  describe("deletions and absent flags", () => {
    it("records a deletion when both sides deleted the file", () => {
      const entries: FileVersions[] = [
        { path: "gone.md", base: J(["a"]), ours: undefined, theirs: undefined },
      ];
      const { applied, conflicts } = applyMerge(entries);
      expect(applied).toEqual([{ path: "gone.md" }]);
      expect(conflicts).toEqual([]);
    });

    it("keeps the surviving side on a modify/delete (local deleted, remote modified)", () => {
      const entries: FileVersions[] = [
        { path: "m.md", base: J(["a", "b"]), ours: undefined, theirs: J(["a", "B"]) },
      ];
      const { applied, conflicts } = applyMerge(entries);
      expect(applied).toEqual([{ path: "m.md", content: J(["a", "B"]) }]);
      expect(conflicts).toEqual([]);
    });

    it("keeps theirs when a new file is deleted on one side and present on the other", () => {
      const entries: FileVersions[] = [
        { path: "new.md", base: undefined, ours: undefined, theirs: "R" },
      ];
      const { applied, conflicts } = applyMerge(entries);
      expect(applied).toEqual([{ path: "new.md", content: "R" }]);
      expect(conflicts).toEqual([]);
    });

    it("surfaces a genuine add/add conflict with absent flags omitted", () => {
      const entries: FileVersions[] = [
        { path: "c.md", base: undefined, ours: "L", theirs: "R" },
      ];
      const { applied, conflicts } = applyMerge(entries);
      expect(applied).toEqual([]);
      expect(conflicts).toEqual([{ path: "c.md", base: undefined, ours: "L", theirs: "R" }]);
    });
  });
});
