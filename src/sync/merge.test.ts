import { describe, it, expect } from "vitest";
import { threeWayMerge, mergeAll, diff3Chunks } from "./merge";
import type { FileDiff } from "./classifier";

const J = (lines: string[]): string => lines.join("\n");

describe("threeWayMerge — unchanged / one-sided", () => {
  it("returns the baseline when nothing changed on either side", () => {
    const base = J(["h1", "body"]);
    const r = threeWayMerge(base, base, base);
    expect(r.content).toBe(base);
    expect(r.conflict).toBe(false);
  });

  it("takes local-only changes (unpushed)", () => {
    const r = threeWayMerge("v1", "L1", "v1");
    expect(r.content).toBe("L1");
    expect(r.conflict).toBe(false);
  });

  it("takes remote-only changes (unpulled)", () => {
    const r = threeWayMerge("v1", "v1", "R1");
    expect(r.content).toBe("R1");
    expect(r.conflict).toBe(false);
  });

  it("collapses identical edits from both sides to a single copy", () => {
    const r = threeWayMerge("v1", "same", "same");
    expect(r.content).toBe("same");
    expect(r.conflict).toBe(false);
  });

  it("round-trips unchanged multi-line content exactly", () => {
    const base = J(["a", "b", "c", "d"]);
    expect(threeWayMerge(base, base, base).content).toBe(base);
  });
});

describe("threeWayMerge — line-level (non-overlapping edits merge cleanly)", () => {
  it("merges edits in different parts of the same file without conflicting", () => {
    const base = J(["a", "b", "c", "d", "e"]);
    const ours = J(["A", "b", "c", "d", "e"]); // changed line 1
    const theirs = J(["a", "b", "c", "d", "Z"]); // changed line 5
    const r = threeWayMerge(base, ours, theirs);
    expect(r.content).toBe(J(["A", "b", "c", "d", "Z"]));
    expect(r.conflict).toBe(false);
  });

  it("handles two separate non-overlapping conflicts as two marker blocks", () => {
    const base = J(["a", "b", "c", "d", "e"]);
    const ours = J(["X", "b", "c", "d", "Y"]); // changed a and e
    const theirs = J(["Z", "b", "c", "d", "W"]); // changed a and e differently
    const expected = [
      "<<<<<<< ours",
      "X",
      "=======",
      "Z",
      ">>>>>>> theirs",
      "b",
      "c",
      "d",
      "<<<<<<< ours",
      "Y",
      "=======",
      "W",
      ">>>>>>> theirs",
    ].join("\n");
    const r = threeWayMerge(base, ours, theirs);
    expect(r.content).toBe(expected);
    expect(r.conflict).toBe(true);
  });

  it("emits conflict markers when both sides change the same line differently", () => {
    const base = J(["a", "b", "c"]);
    const ours = J(["A", "b", "c"]); // changed line 1
    const theirs = J(["T", "b", "c"]); // changed line 1 differently
    const r = threeWayMerge(base, ours, theirs);
    expect(r.content).toBe(["<<<<<<< ours", "A", "=======", "T", ">>>>>>> theirs", "b", "c"].join("\n"));
    expect(r.conflict).toBe(true);
  });
});

describe("threeWayMerge — empty files", () => {
  it("treats all-empty as unchanged empty", () => {
    const r = threeWayMerge("", "", "");
    expect(r.content).toBe("");
    expect(r.conflict).toBe(false);
  });

  it("adds content to a previously empty file (one side)", () => {
    const r = threeWayMerge("", J(["x", "y"]), "");
    expect(r.content).toBe(J(["x", "y"]));
    expect(r.conflict).toBe(false);
  });

  it("conflicts when both sides create an empty file with different content", () => {
    expect(threeWayMerge("", "x", "y").conflict).toBe(true);
  });
});

describe("threeWayMerge — deletions (undefined = deletion, distinct from empty \"\")", () => {
  it("stays deleted when both sides delete a pre-existing file", () => {
    const r = threeWayMerge("content", undefined, undefined);
    expect(r.conflict).toBe(false);
    expect(r.oursAbsent).toBe(true);
    expect(r.theirsAbsent).toBe(true);
    expect(r.content).toBe("");
  });

  it("keeps the remote modification when local deletes (modify/delete)", () => {
    const r = threeWayMerge("base", undefined, "R");
    expect(r.conflict).toBe(false);
    expect(r.oursAbsent).toBe(true);
    expect(r.theirsAbsent).toBe(false);
    expect(r.content).toBe("R");
  });

  it("keeps the local modification when remote deletes (modify/delete, other direction)", () => {
    const r = threeWayMerge("base", "L", undefined);
    expect(r.conflict).toBe(false);
    expect(r.oursAbsent).toBe(false);
    expect(r.theirsAbsent).toBe(true);
    expect(r.content).toBe("L");
  });

  it("distinguishes an empty file from a deletion (empty stays, deletion goes)", () => {
    // Empty file on local vs unchanged remote -> empty content, NOT absent.
    const empty = threeWayMerge("content", "", "content");
    expect(empty.content).toBe("");
    expect(empty.oursAbsent).toBe(false);
    // Local deleted (undefined) vs remote has content -> deletion semantics resolve to theirs.
    const del = threeWayMerge("content", undefined, "x");
    expect(del.oursAbsent).toBe(true);
  });

  it("stays deleted when a new file is deleted on both sides (no base)", () => {
    const r = threeWayMerge(undefined, undefined, undefined);
    expect(r.conflict).toBe(false);
    expect(r.oursAbsent).toBe(true);
    expect(r.theirsAbsent).toBe(true);
  });

  it("keeps the addition when one side deletes a new file and the other has it", () => {
    const r = threeWayMerge(undefined, undefined, "R");
    expect(r.conflict).toBe(false);
    expect(r.content).toBe("R");
    expect(r.oursAbsent).toBe(true);
  });

  it("conflicts when both sides add a brand-new file with different content (add/add)", () => {
    expect(threeWayMerge(undefined, "L", "R").conflict).toBe(true);
  });

  it("collapses identical new-file additions to one copy (add/add same)", () => {
    const r = threeWayMerge(undefined, "same", "same");
    expect(r.content).toBe("same");
    expect(r.conflict).toBe(false);
  });
});

describe("diff3Chunks — region classification", () => {
  it("emits context for shared lines and a merge for one-sided changes", () => {
    const chunks = diff3Chunks(["a", "b", "c"], ["a", "X", "c"], ["a", "b", "c"]);
    expect(chunks).toEqual([
      { type: "context", lines: ["a"] },
      { type: "merge", lines: ["X"] },
      { type: "context", lines: ["c"] },
    ]);
  });

  it("emits a conflict chunk for an overlapping change", () => {
    const chunks = diff3Chunks(["a"], ["A"], ["T"]);
    expect(chunks).toEqual([{ type: "conflict", ours: ["A"], theirs: ["T"] }]);
  });
});

describe("mergeAll — per-file over a diff set", () => {
  it("merges each file in order and flags conflicts", () => {
    const diffs: FileDiff[] = [
      { path: "clean", local: J(["a", "b"]), remote: J(["a", "B"]), base: J(["a", "b"]) }, // remote-only -> merge
      { path: "bad", local: "L", remote: "R", base: "base" }, // divergent -> conflict
    ];
    const merged = mergeAll(diffs);
    expect(merged).toEqual([
      { path: "clean", content: J(["a", "B"]), conflict: false },
      { path: "bad", content: ["<<<<<<< ours", "L", "=======", "R", ">>>>>>> theirs"].join("\n"), conflict: true },
    ]);
  });
});
