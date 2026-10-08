import { describe, it, expect } from "vitest";
import { isInScope, detectRenames, uniqueConflictPath, normalizeRemotePath } from "./exclusion";

describe("isInScope — subtree + include/exclude composition", () => {
  it("includes everything when unscoped (remotePath empty)", () => {
    expect(isInScope({ remotePath: "" }, "any/file.md")).toBe(true);
    expect(isInScope({ remotePath: "", excludes: ["*.log"] }, "notes/x.log")).toBe(false);
    expect(isInScope({ remotePath: "", excludes: ["*.log"] }, "notes/x.md")).toBe(true);
  });

  it("restricts to the remotePath subtree", () => {
    const cfg = { remotePath: "diary" };
    expect(isInScope(cfg, "diary/2024-01-01.md")).toBe(true);
    expect(isInScope(cfg, "diary/nested/deep.md")).toBe(true);
    expect(isInScope(cfg, "notes/x.md")).toBe(false);
    // remotePath itself (repo-root file named like the scope) is in scope.
    expect(isInScope(cfg, "diary")).toBe(true);
  });

  it("honors trailing slashes on remotePath", () => {
    const cfg = { remotePath: "diary/" };
    expect(isInScope(cfg, "diary/a.md")).toBe(true);
    expect(isInScope(cfg, "other/a.md")).toBe(false);
  });

  it("applies includes (allowlist) within the subtree", () => {
    const cfg = { remotePath: "docs", includes: ["*.md"] };
    expect(isInScope(cfg, "docs/guide.md")).toBe(true);
    expect(isInScope(cfg, "docs/api.json")).toBe(false);
  });

  it("applies excludes (denylist) within the subtree and lets ! re-include", () => {
    const cfg = { remotePath: "docs", excludes: ["**/*.tmp.md"] };
    expect(isInScope(cfg, "docs/a.tmp.md")).toBe(false);
    expect(isInScope(cfg, "docs/a.md")).toBe(true);
  });

  it("excludes paths outside the subtree even if they match includes", () => {
    const cfg = { remotePath: "docs", includes: ["*.md"] };
    expect(isInScope(cfg, "blog/post.md")).toBe(false);
  });
});

describe("normalizeRemotePath", () => {
  it("strips leading ./ and trailing slashes", () => {
    expect(normalizeRemotePath("./diary/")).toBe("diary");
    expect(normalizeRemotePath("diary///")).toBe("diary");
    expect(normalizeRemotePath("")).toBe("");
  });
});

describe("detectRenames — content identity moves", () => {
  it("detects a file moved from one path to another with identical content", () => {
    const before = { "old.md": "SAME", "keep.md": "k" };
    const after = { "new.md": "SAME", "keep.md": "k" };
    expect(detectRenames(before, after)).toEqual([{ from: "old.md", to: "new.md" }]);
  });

  it("ignores empty-content ids so empty files do not masquerade as renames", () => {
    const before = { "a.md": "" };
    const after = { "b.md": "" };
    expect(detectRenames(before, after)).toEqual([]);
  });

  it("returns nothing when there is no content-identity match", () => {
    const before = { "old.md": "X" };
    const after = { "new.md": "Y" };
    expect(detectRenames(before, after)).toEqual([]);
  });

  it("does not report a path as renamed to itself", () => {
    const before = { "a.md": "SAME" };
    const after = { "a.md": "SAME" };
    expect(detectRenames(before, after)).toEqual([]);
  });
});

describe("uniqueConflictPath — collision-safe path generation", () => {
  it("returns the base path when there is no collision", () => {
    expect(uniqueConflictPath("Note.md")).toBe("Note.md");
    expect(uniqueConflictPath("Note.md", new Set(["other.md"]))).toBe("Note.md");
  });

  it("appends (conflict N) before the extension on collision", () => {
    const existing = new Set(["Note.md", "Note (conflict 1).md"]);
    expect(uniqueConflictPath("Note.md", existing)).toBe("Note (conflict 2).md");
  });

  it("handles paths with no extension", () => {
    expect(uniqueConflictPath("README", new Set(["README"]))).toBe("README (conflict 1)");
  });
});
