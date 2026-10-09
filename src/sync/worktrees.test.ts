import { describe, it, expect } from "vitest";
import {
  slugForRef,
  agentBranch,
  isAgentBranch,
  resolveWorktree,
  uniqueAgentBranch,
  AGENT_BRANCH_PREFIX,
  type Worktree,
} from "./worktrees";

describe("slugForRef — valid git ref segment", () => {
  it("lowercases and collapses invalid runs to a single dash", () => {
    expect(slugForRef("Agent_Name!!")).toBe("agent_name");
    expect(slugForRef("a/b\\c")).toBe("a-b-c");
    expect(slugForRef("bad   name")).toBe("bad-name");
  });

  it("trims leading/trailing dots and dashes", () => {
    expect(slugForRef("..foo..")).toBe("foo");
    expect(slugForRef("-bar-")).toBe("bar");
  });

  it("caps at the git ref-segment limit and falls back when empty", () => {
    expect(slugForRef("x".repeat(100))).toHaveLength(63);
    expect(slugForRef("!!!")).toBe("agent");
    expect(slugForRef("   ")).toBe("agent");
  });
});

describe("agentBranch / isAgentBranch", () => {
  it("derives a deterministic mugs-agent/<slug> branch", () => {
    expect(agentBranch("alice-01")).toBe(`${AGENT_BRANCH_PREFIX}/alice-01`);
    // Same id always yields the same branch (stable across sessions).
    expect(agentBranch("alice-01")).toBe(agentBranch("alice-01"));
  });

  it("flags only mugs-agent branches", () => {
    expect(isAgentBranch(`${AGENT_BRANCH_PREFIX}/alice`)).toBe(true);
    expect(isAgentBranch("main")).toBe(false);
    expect(isAgentBranch("feature/x")).toBe(false);
  });
});

describe("resolveWorktree — isolation check", () => {
  const existing: Worktree[] = [
    { id: "w1", name: "research", branch: `${AGENT_BRANCH_PREFIX}/alice`, path: "/vault/wt/alice" },
  ];

  it("reports a branch collision without flagging an unrelated path", () => {
    expect(
      resolveWorktree(existing, { branch: `${AGENT_BRANCH_PREFIX}/alice`, path: "/other/tree" }),
    ).toEqual({ conflict: "branch", existing: existing[0] });
  });

  it("reports a path collision without flagging an unrelated branch", () => {
    expect(
      resolveWorktree(existing, { branch: `${AGENT_BRANCH_PREFIX}/bob`, path: "/vault/wt/alice" }),
    ).toEqual({ conflict: "path", existing: existing[0] });
  });

  it("allows a free candidate", () => {
    expect(resolveWorktree(existing, { branch: `${AGENT_BRANCH_PREFIX}/bob`, path: "/vault/wt/bob" })).toEqual({});
  });
});

describe("uniqueAgentBranch — collision backoff", () => {
  it("returns the canonical branch when free", () => {
    expect(uniqueAgentBranch("alice", [])).toBe(agentBranch("alice"));
  });

  it("appends -2, -3 … until unique", () => {
    const taken = [agentBranch("alice"), `${agentBranch("alice")}-2`];
    expect(uniqueAgentBranch("alice", taken)).toBe(`${agentBranch("alice")}-3`);
  });
});
