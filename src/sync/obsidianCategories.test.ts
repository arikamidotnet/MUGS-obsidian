import { describe, it, expect } from "vitest";
import { categorizeObsidianEntries } from "./obsidianCategories";
import type { ObsidianEntryPolicy } from "../types";

const entries = (...paths: string[]): ObsidianEntryPolicy[] =>
  paths.map((path) => ({ path, scope: "personal" }));

describe("categorizeObsidianEntries — known bucketing", () => {
  it("buckets known entries into their named categories with descriptions", () => {
    const cats = categorizeObsidianEntries(entries("settings.json", "themes", "snippets"));
    const main = cats.find((c) => c.id === "main");
    const themes = cats.find((c) => c.id === "themes");
    expect(main?.paths).toEqual(["settings.json"]);
    expect(main?.title).toBe("Main settings");
    expect(themes?.paths).toEqual(["snippets", "themes"]); // sorted within group
    expect(themes?.description.length).toBeGreaterThan(0);
  });

  it("orders known groups deterministically and places Other last", () => {
    const cats = categorizeObsidianEntries(entries("plugins", "settings.json", "mystery.txt"));
    const ids = cats.map((c) => c.id);
    // main (table order) before plugins; other is last.
    expect(ids.indexOf("main")).toBeLessThan(ids.indexOf("plugins"));
    expect(ids[ids.length - 1]).toBe("other");
    const other = cats.find((c) => c.id === "other");
    expect(other?.paths).toEqual(["mystery.txt"]);
  });

  it("groups multiple known entries under the same category", () => {
    const cats = categorizeObsidianEntries(entries("themes", "snippets"));
    const themes = cats.find((c) => c.id === "themes");
    expect(themes?.paths).toEqual(["snippets", "themes"]);
  });
});

describe("categorizeObsidianEntries — edge cases", () => {
  it("returns an empty list for no entries", () => {
    expect(categorizeObsidianEntries([])).toEqual([]);
  });

  it("falls every unknown entry under Other and de-dupes repeated paths", () => {
    const cats = categorizeObsidianEntries(entries("weird.json", "weird.json"));
    const other = cats.find((c) => c.id === "other");
    expect(other?.paths).toEqual(["weird.json"]);
  });

  it("does not depend on the entry scope (bucketing only)", () => {
    const vaultWide: ObsidianEntryPolicy[] = [{ path: "themes", scope: "vault-wide" }];
    const personal: ObsidianEntryPolicy[] = [{ path: "themes", scope: "personal" }];
    expect(categorizeObsidianEntries(vaultWide).map((c) => c.id)).toEqual(
      categorizeObsidianEntries(personal).map((c) => c.id),
    );
  });
});
