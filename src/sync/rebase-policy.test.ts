import { describe, it, expect } from "vitest";
import { decideSyncAction, type SyncTopology } from "./rebase-policy";

/** Build an isAncestor oracle from a set of (ancestor -> descendant) edges. */
function ancestorOracle(edges: [string, string][]): SyncTopology["isAncestor"] {
  const rel = new Set(edges.map(([a, b]) => `${a}<<${b}`));
  return (maybeAncestor: string, descendants: string[]): boolean =>
    descendants.some((d) => rel.has(`${maybeAncestor}<<${d}`));
}

const topo = (over: Partial<SyncTopology>): SyncTopology => ({
  base: "base",
  localSha: "local",
  remoteSha: "remote",
  isAncestor: ancestorOracle([]),
  ...over,
});

describe("decideSyncAction", () => {
  it("none when local and remote are already the same commit", () => {
    expect(decideSyncAction(topo({ localSha: "same", remoteSha: "same" }))).toBe("none");
  });

  it("none when the remote has not advanced since the last sync", () => {
    // base == remoteSha means remote is exactly where we last synced.
    expect(decideSyncAction(topo({ base: "b3", localSha: "localA", remoteSha: "b3" }))).toBe("none");
  });

  it("never-synced + empty local → fast-forward (adopt remote)", () => {
    expect(decideSyncAction(topo({ base: "", localSha: "", remoteSha: "remoteR" }))).toBe("fast-forward");
  });

  it("never-synced + local has work → rebase local onto the fresh remote", () => {
    expect(decideSyncAction(topo({ base: "", localSha: "localL", remoteSha: "remoteR" }))).toBe("rebase");
  });

  it("fast-forward when local is an ancestor of remote (remote contains our work)", () => {
    const t = topo({
      base: "b0",
      localSha: "A",
      remoteSha: "C",
      isAncestor: ancestorOracle([["A", "B"], ["A", "C"], ["B", "C"]]),
    });
    expect(decideSyncAction(t)).toBe("fast-forward");
  });

  it("rebase when histories have diverged (local not an ancestor of remote)", () => {
    const t = topo({
      base: "b0",
      localSha: "L",
      remoteSha: "R",
      isAncestor: ancestorOracle([["b0", "L"], ["b0", "R"]]), // b0 ancestors of both, but L not of R
    });
    expect(decideSyncAction(t)).toBe("rebase");
  });

  it("never-synced with empty local AND empty remote → none (both equal)", () => {
    expect(decideSyncAction(topo({ base: "", localSha: "", remoteSha: "" }))).toBe("none");
  });

  it("prefers the equal-remote check over ancestry when local is ancestor of an unchanged remote", () => {
    // Remote equals base (unchanged) even though local differs → nothing to pull.
    expect(decideSyncAction(topo({ base: "b0", localSha: "L", remoteSha: "b0" }))).toBe("none");
  });
});
