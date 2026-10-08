import { describe, it, expect } from "vitest";
import { threeWayMerge, mergeAll, diff3Chunks } from "./merge";
import type { FileDiff } from "./classifier";

const J = (lines: string[]): string => lines.join("\n");

describe("threeWayMerge — unchanged / one-sided", () => {
  it("returns the baseline when nothing changed on either side", () => {
    const base = J(["h1", "body"]);
    expect(threeWayMerge(base, base, base)).toEqual({ content: base, conflict: false });
  });

  it("takes local-only changes (unpushed)", () => {
    expect(threeWayMerge("v1", "L1", "v1")).toEqual({ content: "L1", conflict: false });
  });

  it("takes remote-only changes (unpulled)", () => {
    expect(threeWayMerge("v1", "v1", "R1")).toEqual({ content: "R1", conflict: false });
  });

  it("collapses identical edits from both sides to a single copy", () => {
    expect(threeWayMerge("v1", "same", "same")).toEqual({ content: "same", conflict: false });
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
    expect(threeWayMerge(base, ours, theirs)).toEqual({ content: J(["A", "b", "c", "d", "Z"]), conflict: false });
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
    expect(threeWayMerge(base, ours, theirs)).toEqual({ content: expected, conflict: true });
  });

  it("emits conflict markers when both sides change the same line differently", () => {
    const base = J(["a", "b", "c"]);
    const ours = J(["A", "b", "c"]); // changed line 1
    const theirs = J(["T", "b", "c"]); // changed line 1 differently
    expect(threeWayMerge(base, ours, theirs)).toEqual({
      content: ["<<<<<<< ours", "A", "=======", "T", ">>>>>>> theirs", "b", "c"].join("\n"),
      conflict: true,
    });
  });
});

describe("threeWayMerge — empty files", () => {
  it("treats all-empty as unchanged empty", () => {
    expect(threeWayMerge("", "", "")).toEqual({ content: "", conflict: false });
  });

  it("adds content to a previously empty file (one side)", () => {
    expect(threeWayMerge("", J(["x", "y"]), "")).toEqual({ content: J(["x", "y"]), conflict: false });
  });

  it("conflicts when both sides create an empty file with different content", () => {
    expect(threeWayMerge("", "x", "y").conflict).toBe(true);
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
