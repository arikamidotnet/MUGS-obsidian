import { describe, it, expect } from "vitest";
import { matchFolderPairs, matchFolderPairsFuzzy } from "./folderMatch";

describe("matchFolderPairs — exact top-level name matching", () => {
  it("suggests a pair when a remote dir matches a vault folder exactly", () => {
    const matches = matchFolderPairs(["Notes", "Projects"], ["Notes", "Inbox"]);
    expect(matches).toEqual([{ remotePath: "Notes", localFolder: "Notes", label: "Notes" }]);
  });

  it("ignores non-matching and nested paths, de-dupes, and sorts", () => {
    const matches = matchFolderPairs(
      ["Zeta", "alpha/nested", "Alpha", "alpha", "Beta"],
      ["Beta", "Alpha"],
    );
    expect(matches).toEqual([
      { remotePath: "Alpha", localFolder: "Alpha", label: "Alpha" },
      { remotePath: "Beta", localFolder: "Beta", label: "Beta" },
    ]);
  });

  it("is case-sensitive and returns nothing when there are no matches", () => {
    expect(matchFolderPairs(["notes"], ["Notes"])).toEqual([]);
    expect(matchFolderPairs([], [])).toEqual([]);
    expect(matchFolderPairs(["A", "B"], [])).toEqual([]);
  });

  it("treats iterables (arrays and sets) as inputs", () => {
    const matches = matchFolderPairs(new Set(["Docs"]), new Set(["Docs", "Readme"]));
    expect(matches.map((m) => m.label)).toEqual(["Docs"]);
  });
});

describe("matchFolderPairsFuzzy — exact + fuzzy suggestions ranked by score", () => {
  it("exact matches come first with score 1.0 and are sorted alphabetically", () => {
    const result = matchFolderPairsFuzzy(
      ["Notes", "Projects"],
      ["Notes", "Inbox", "Projects"],
    );
    expect(result).toEqual([
      { remotePath: "Notes", localFolder: "Notes", label: "Notes", score: 1 },
      { remotePath: "Projects", localFolder: "Projects", label: "Projects", score: 1 },
    ]);
  });

  it("returns empty when nothing matches at all (below threshold)", () => {
    const result = matchFolderPairsFuzzy(["zzz"], ["abc"]);
    expect(result).toEqual([]);
  });

  it("suggests fuzzy near-misses with score < 1 and label showing both sides", () => {
    // "Notes" vs "My Notes" — normalized to "notes"/"mynotes": substring match.
    const result = matchFolderPairsFuzzy(["Notes"], ["My Notes"]);
    expect(result.length).toBe(1);
    expect(result[0].remotePath).toBe("Notes");
    expect(result[0].localFolder).toBe("My Notes");
    expect(result[0].label).toBe("Notes → My Notes");
    expect(result[0].score).toBeGreaterThan(0);
    expect(result[0].score).toBeLessThan(1);
  });

  it("does not suggest a vault folder that was already matched exactly by another remote", () => {
    // "Docs" exact-matches, so it should NOT also appear as a fuzzy suggestion.
    const result = matchFolderPairsFuzzy(["Docs"], ["Docs"]);
    expect(result).toEqual([
      { remotePath: "Docs", localFolder: "Docs", label: "Docs", score: 1 },
    ]);
    // Only one entry — no duplicate fuzzy match for the same vault folder.
    expect(result.filter((r) => r.localFolder === "Docs")).toHaveLength(1);
  });

  it("does not filter dotfolders itself — the caller is responsible", () => {
    // matchFolderPairsFuzzy returns .obsidian if both sides have it; filtering happens in settingsTab.
    const result = matchFolderPairsFuzzy([".obsidian"], [".obsidian"]);
    expect(result).toEqual([
      { remotePath: ".obsidian", localFolder: ".obsidian", label: ".obsidian", score: 1 },
    ]);
  });

  it("handles empty inputs gracefully", () => {
    expect(matchFolderPairsFuzzy([], [])).toEqual([]);
    expect(matchFolderPairsFuzzy(["A"], [])).toEqual([]);
    expect(matchFolderPairsFuzzy([], ["B"])).toEqual([]);
  });
});
