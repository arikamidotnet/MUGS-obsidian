import { describe, it, expect } from "vitest";
import { matchFolderPairs } from "./folderMatch";

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
