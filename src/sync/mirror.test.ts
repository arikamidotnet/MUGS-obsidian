import { describe, it, expect } from "vitest";
import { planMirrorPush, planMirrorPull, vaultToRepoPath, repoToVaultPath } from "./mirror";
import type { FolderMapping } from "../types";

function mapping(over: Partial<FolderMapping> = {}): FolderMapping {
  return { id: "m1", label: "Notes", remotePath: "", localFolder: "notes", providerId: "c1", direction: "push-pull", ...over };
}

describe("path mapping helpers", () => {
  it("maps vault-relative paths onto the remotePath subtree", () => {
    const m = mapping({ remotePath: "01 concepts" });
    expect(vaultToRepoPath(m, "a/b.md")).toBe("01 concepts/a/b.md");
    expect(repoToVaultPath(m, "01 concepts/a/b.md")).toBe("a/b.md");
  });

  it("maps an unscoped mapping onto the repo root", () => {
    const m = mapping({ remotePath: "" });
    expect(vaultToRepoPath(m, "a.md")).toBe("a.md");
    expect(repoToVaultPath(m, "a.md")).toBe("a.md");
  });

  it("rejects paths outside the subtree and the subtree root itself", () => {
    const m = mapping({ remotePath: "01 concepts" });
    expect(repoToVaultPath(m, "other/a.md")).toBeNull();
    expect(repoToVaultPath(m, "01 concepts")).toBeNull();
  });
});

describe("planMirrorPush — vault → clone", () => {
  it("writes each vault file at its repo-relative mirror path, parents first", () => {
    const m = mapping({ remotePath: "notes" });
    const plan = planMirrorPush({
      mapping: m,
      vaultFiles: [
        { path: "deep/nested/file.md", content: "c" },
        { path: "top.md", content: "t" },
      ],
      clonePaths: [],
      includeDeletions: false,
    });
    // orderApplyOps: shallower writes first.
    expect(plan.ops).toEqual([
      { path: "notes/top.md", kind: "write", content: "t" },
      { path: "notes/deep/nested/file.md", kind: "write", content: "c" },
    ]);
    expect(plan.refused).toBe(false);
  });

  it("honors include/exclude scoping on the mirrored repo path", async () => {
    const m = mapping({ includes: ["*.md"], excludes: ["drafts/**"] });
    const plan = planMirrorPush({
      mapping: m,
      vaultFiles: [
        { path: "keep.md", content: "k" },
        { path: "drafts/skip.md", content: "s" },
        { path: "image.png", content: "b" },
      ],
      clonePaths: [],
      includeDeletions: false,
    });
    expect(plan.ops.map((o) => o.path)).toEqual(["keep.md"]);
  });

  it("deletes in-scope clone files with no vault counterpart when deletions are on", () => {
    const m = mapping({ remotePath: "notes" });
    const plan = planMirrorPush({
      mapping: m,
      vaultFiles: [{ path: "keep.md", content: "k" }],
      clonePaths: ["notes/keep.md", "notes/gone.md", "other/untouched.md", "notes"],
      includeDeletions: true,
    });
    // gone.md deleted (vault lacks it); other/ and out-of-scope paths untouched.
    const del = plan.ops.filter((o) => o.kind === "delete");
    expect(del).toEqual([{ path: "notes/gone.md", kind: "delete" }]);
    // Deletes come after writes.
    expect(plan.ops[plan.ops.length - 1]?.kind).toBe("delete");
  });

  it("keeps remote-only files on a first-sync push (additive only)", () => {
    const m = mapping({ remotePath: "notes" });
    const plan = planMirrorPush({
      mapping: m,
      vaultFiles: [{ path: "new.md", content: "n" }],
      clonePaths: ["notes/remote-only.md"],
      includeDeletions: false,
    });
    expect(plan.ops).toEqual([{ path: "notes/new.md", kind: "write", content: "n" }]);
  });

  it("refuses when the vault side is empty", () => {
    const plan = planMirrorPush({ mapping: mapping(), vaultFiles: [], clonePaths: ["a.md"], includeDeletions: true });
    expect(plan).toEqual({ ops: [], refused: true });
  });
});

describe("planMirrorPull — clone → vault", () => {
  it("writes clone files into the vault folder at folder-relative paths", () => {
    const m = mapping({ remotePath: "notes" });
    const plan = planMirrorPull({
      mapping: m,
      cloneFiles: [
        { path: "notes/a.md", content: "a" },
        { path: "other/b.md", content: "b" }, // out of scope
      ],
      deletedRepoPaths: [],
    });
    expect(plan.ops).toEqual([{ path: "a.md", kind: "write", content: "a" }]);
  });

  it("plans deletions only from the git-derived deleted list, scoped to the subtree", () => {
    const m = mapping({ remotePath: "notes" });
    const plan = planMirrorPull({
      mapping: m,
      cloneFiles: [{ path: "notes/kept.md", content: "k" }],
      deletedRepoPaths: ["notes/removed.md", "other/x.md"],
    });
    const del = plan.ops.filter((o) => o.kind === "delete");
    expect(del).toEqual([{ path: "removed.md", kind: "delete" }]);
  });

  it("never deletes vault files that are merely absent from the clone (not yet pushed)", () => {
    // A brand-new local note has no clone counterpart; the pull plan must not
    // contain any deletion for it — deletions come only from the remote's list.
    const plan = planMirrorPull({ mapping: mapping(), cloneFiles: [], deletedRepoPaths: [] });
    expect(plan.ops).toEqual([]);
  });
});
