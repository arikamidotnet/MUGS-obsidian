import { describe, it, expect } from "vitest";
import {
  globToRegExp,
  GitignoreMatcher,
  shouldSync,
  matchesAnyInclude,
  type ExclusionRules,
} from "./exclusion";
import { classifyFile, classifyAll, localChanges, conflicts, type FileDiff } from "./classifier";
import { decideSyncAction, type SyncTopology } from "./rebase-policy";
import { formatCommitMessage } from "./commit-message";

// --- exclusion -------------------------------------------------------------

describe("globToRegExp", () => {
  const cases: [string, string, boolean][] = [
    ["*.log", "foo.log", true],
    ["*.log", "a/b/foo.log", true], // no slash → any depth
    ["*.log", "foo.txt", false],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/x/a.ts", false], // has slash → anchored to root
    ["**/foo", "foo", true], // globstar at start matches root
    ["**/foo", "a/b/foo", true],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**/b", "a/x/cb", false],
    ["docs/", "docs/guide.md", true], // directory prefix matches subtree
  ];
  it.each(cases)("glob %s %s -> %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe("GitignoreMatcher", () => {
  it("excludes matches and re-includes with ! negation", () => {
    const m = new GitignoreMatcher(["*.log", "!keep.log"]);
    expect(m.isExcluded("a.log")).toBe(true);
    expect(m.isExcluded("keep.log")).toBe(false); // last match wins
  });

  it("ignores blank lines and comments", () => {
    const m = new GitignoreMatcher(["", "# comment", "*.tmp"]);
    expect(m.isExcluded("x.tmp")).toBe(true);
    expect(m.isExcluded("y.md")).toBe(false);
  });

  it("normalizes backslashes", () => {
    const m = new GitignoreMatcher(["*.log"]);
    expect(m.isExcluded("a\\b.log")).toBe(true);
  });
});

describe("shouldSync (allowlist + denylist)", () => {
  it("syncs everything when no includes and no excludes", () => {
    expect(shouldSync("any/file.md", { includes: [], excludes: [] })).toBe(true);
  });

  it("respects the include allowlist", () => {
    const rules: ExclusionRules = { includes: ["notes/**"], excludes: [] };
    expect(shouldSync("notes/day.md", rules)).toBe(true);
    expect(shouldSync("other/day.md", rules)).toBe(false);
  });

  it("excludes denylisted paths even when included", () => {
    const rules: ExclusionRules = { includes: ["**"], excludes: ["**/*.tmp"] };
    expect(shouldSync("a/b.tmp", rules)).toBe(false);
    expect(shouldSync("a/b.md", rules)).toBe(true);
  });

  it("matchesAnyInclude is true when the allowlist is empty", () => {
    expect(matchesAnyInclude("x/y", [])).toBe(true);
  });
});

// --- classifier ------------------------------------------------------------

describe("classifyFile", () => {
  const base = "v1";
  it("classifies all five dispositions", () => {
    expect(classifyFile({ path: "a", local: base, remote: base, base })).toBe("up-to-date");
    expect(classifyFile({ path: "b", local: "L", remote: base, base })).toBe("local");
    expect(classifyFile({ path: "c", local: base, remote: "R", base })).toBe("remote");
    expect(classifyFile({ path: "d", local: "same", remote: "same", base })).toBe("merged");
    expect(classifyFile({ path: "e", local: "L", remote: "R", base })).toBe("conflict");
  });

  it("treats undefined as a deletion", () => {
    expect(classifyFile({ path: "del", local: undefined, remote: base, base })).toBe("local"); // deleted locally = unpushed delete
    expect(classifyFile({ path: "del2", local: base, remote: undefined, base })).toBe("remote");
    expect(classifyFile({ path: "both-del", local: undefined, remote: undefined, base })).toBe("merged");
  });

  it("handles a file new since last sync (no base)", () => {
    expect(classifyFile({ path: "new", local: "x", remote: undefined, base: undefined })).toBe("local");
    expect(classifyFile({ path: "new2", local: "x", remote: "x", base: undefined })).toBe("merged");
  });

  it("classifyAll preserves order and derives change lists", () => {
    const diffs: FileDiff[] = [
      { path: "a", local: "L", remote: base, base },
      { path: "b", local: base, remote: "R", base },
      { path: "c", local: "L", remote: "R", base },
    ];
    expect(classifyAll(diffs).map((d) => d.change)).toEqual(["local", "remote", "conflict"]);
    expect(localChanges(diffs)).toEqual(["a"]);
    expect(conflicts(diffs)).toEqual(["c"]);
  });
});

// --- rebase-policy ---------------------------------------------------------

function topology(overrides: Partial<SyncTopology>): SyncTopology {
  const base = "BASE";
  return {
    base,
    localSha: "LOCAL",
    remoteSha: "REMOTE",
    isAncestor: () => false,
    ...overrides,
  };
}

describe("decideSyncAction", () => {
  // Build an ancestry oracle from explicit (ancestor -> descendant) edges.
  const oracleFrom = (edges: [string, string][]): SyncTopology["isAncestor"] => {
    const set = new Set<string>(edges.flatMap(([a, d]) => [`${a}>${d}`]));
    return (anc: string, desc: string[]) => desc.some((d) => set.has(`${anc}>${d}`));
  };

  it("none when local and remote are identical", () => {
    expect(decideSyncAction(topology({ localSha: "X", remoteSha: "X" }))).toBe("none");
  });

  it("none when remote has not advanced since the last sync", () => {
    expect(decideSyncAction(topology({ base: "BASE", remoteSha: "BASE" }))).toBe("none");
  });

  it("fast-forward when local is an ancestor of remote", () => {
    expect(
      decideSyncAction(
        topology({ localSha: "BASE", remoteSha: "REMOTE", isAncestor: oracleFrom([["BASE", "REMOTE"]]) }),
      ),
    ).toBe("fast-forward");
  });

  it("rebase when histories have diverged", () => {
    expect(decideSyncAction(topology({ localSha: "LOCAL", remoteSha: "REMOTE" }))).toBe("rebase");
  });

  it("never-synced: fast-forward if no local commits, else rebase", () => {
    expect(decideSyncAction(topology({ base: "", localSha: "", remoteSha: "REMOTE" }))).toBe("fast-forward");
    expect(decideSyncAction(topology({ base: "", localSha: "LOCAL", remoteSha: "REMOTE" }))).toBe("rebase");
  });

  it("honors a real ancestry oracle (local is ancestor of remote)", () => {
    const t = topology({ localSha: "A", remoteSha: "C" });
    expect(decideSyncAction({ ...t, isAncestor: oracleFrom([["A", "C"], ["A", "B"]]) })).toBe("fast-forward");
  });
});

// --- commit-message --------------------------------------------------------

describe("formatCommitMessage", () => {
  it("builds a compact subject with no body when optional fields are absent", () => {
    expect(formatCommitMessage({ op: "push" })).toBe("mugs push");
  });

  it("includes label, remote path, and a body when provided", () => {
    const msg = formatCommitMessage({
      op: "pull",
      label: "work notes",
      remotePath: "notes/day.md",
      author: "Ada <ada@example.com>",
    });
    expect(msg).toBe(
      [
        "mugs pull (work notes) notes/day.md",
        "",
        "Remote path: notes/day.md",
        "Author: Ada <ada@example.com>",
      ].join("\n"),
    );
  });

  it("is deterministic for identical input", () => {
    const a = formatCommitMessage({ op: "rebase", label: "x" });
    const b = formatCommitMessage({ op: "rebase", label: "x" });
    expect(a).toBe(b);
  });
});
