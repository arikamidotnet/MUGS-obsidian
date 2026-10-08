import { describe, it, expect } from "vitest";
import { clearlyNewer, sameChange, resolveConflictAuto, canAutoResolve, autoResolvedContent, RECENCY_NEAR_EQUAL_MS } from "./policy";
import type { SyncPolicy, FileConflict } from "../types";

const policy = (over: Partial<SyncPolicy> = {}): SyncPolicy => ({
  autoMerge: true,
  defaultResolution: "both",
  sameChangeAccept: true,
  recencyWins: true,
  paused: false,
  intervalSeconds: 300,
  obsidianConfig: { enabled: false, entries: [] },
  ...over,
});

const conflict = (over: Partial<FileConflict> = {}): FileConflict => ({
  path: "f.md",
  base: "base",
  ours: "O",
  theirs: "T",
  ...over,
});

describe("clearlyNewer — recency with near-equal margin", () => {
  it("returns 'ours' when ours is later by more than the margin", () => {
    expect(clearlyNewer(2_000_000, 1_000_000)).toBe("ours");
  });

  it("returns 'theirs' when theirs is later by more than the margin", () => {
    expect(clearlyNewer(1_000_000, 2_000_000)).toBe("theirs");
  });

  it("treats differences within the near-equal margin as null (fall back to policy)", () => {
    expect(clearlyNewer(1_000_000, 1_000_000 + RECENCY_NEAR_EQUAL_MS)).toBeNull();
    expect(clearlyNewer(1_000_000, 1_000_000 + RECENCY_NEAR_EQUAL_MS - 1)).toBeNull();
  });

  it("returns a winner only when the difference exceeds the margin", () => {
    expect(clearlyNewer(1_000_000 + RECENCY_NEAR_EQUAL_MS + 1, 1_000_000)).toBe("ours");
  });

  it("returns null when either timestamp is missing", () => {
    expect(clearlyNewer(undefined, 2000)).toBeNull();
    expect(clearlyNewer(2000, undefined)).toBeNull();
    expect(clearlyNewer(undefined, undefined)).toBeNull();
  });

  it("honors a custom margin", () => {
    expect(clearlyNewer(1100, 1000, 50)).toBe("ours");
    expect(clearlyNewer(1100, 1000, 500)).toBeNull();
  });
});

describe("sameChange — jj same-change rule", () => {
  it("is true when both sides made the identical change", () => {
    expect(sameChange("x", "x")).toBe(true);
  });

  it("distinguishes an empty file from a deletion (both distinct from each other and from deletions)", () => {
    expect(sameChange("", "")).toBe(true); // both empty files -> same change
    expect(sameChange(undefined, undefined)).toBe(true); // both deleted -> same change
    expect(sameChange("", undefined)).toBe(false); // empty file vs deletion -> different
  });

  it("is false for genuinely different content", () => {
    expect(sameChange("O", "T")).toBe(false);
  });
});

describe("resolveConflictAuto — recency then default-resolution fallback", () => {
  it("picks the more-recently-saved side under recency-wins", () => {
    const r = resolveConflictAuto(conflict({ oursSavedAt: 1_000_000, theirsModifiedAt: 1000 }), policy());
    expect(r).toEqual({ choice: "ours", reason: "recency — ours saved later" });
  });

  it("picks theirs when their save is more recent", () => {
    expect(resolveConflictAuto(conflict({ oursSavedAt: 1000, theirsModifiedAt: 1_000_000 }), policy())?.choice).toBe("theirs");
  });

  it("falls back to defaultResolution when saves are near-equal", () => {
    const r = resolveConflictAuto(
      conflict({ oursSavedAt: 1000, theirsModifiedAt: 1000 + RECENCY_NEAR_EQUAL_MS - 10 }),
      policy({ defaultResolution: "theirs" }),
    );
    expect(r?.choice).toBe("theirs");
  });

  it("falls back to defaultResolution when timestamps are missing", () => {
    const r = resolveConflictAuto(conflict(), policy({ defaultResolution: "ours" }));
    expect(r).toEqual({ choice: "ours", reason: "default resolution (ours)" });
  });

  it("skips recency entirely when disabled and uses defaultResolution", () => {
    const r = resolveConflictAuto(conflict({ oursSavedAt: 9_999_999, theirsModifiedAt: 1 }), policy({ recencyWins: false, defaultResolution: "theirs" }));
    expect(r?.choice).toBe("theirs");
  });

  it("is always resolvable for a configured policy", () => {
    expect(canAutoResolve(conflict(), policy())).toBe(true);
  });
});

describe("autoResolvedContent — resolves to the chosen side's text", () => {
  it("returns theirs for a 'theirs' choice", () => {
    expect(autoResolvedContent(conflict({ ours: "O", theirs: "T" }), resolveConflictAuto(conflict({ ours: "O", theirs: "T" }), policy({ defaultResolution: "theirs" }))!)).toBe("T");
  });

  it("'both' best-effort combines non-overlapping edits via the merge", () => {
    const c = conflict({ base: ["a", "b", "c"].join("\n"), ours: ["A", "b", "c"].join("\n"), theirs: ["a", "b", "C"].join("\n") });
    const r = resolveConflictAuto(c, policy({ defaultResolution: "both" }));
    expect(autoResolvedContent(c, r!)).toBe(["A", "b", "C"].join("\n"));
  });
});
