import { describe, it, expect } from "vitest";
import type { Member } from "../providers/types";
import {
  buildMembershipSummary,
  correlateMembers,
  externalContributors,
  toMemberView,
  type ContributorActivity,
  type CorrelationStrategy,
} from "./merge";
import type { MembershipSummary } from "./types";

// --- fixtures --------------------------------------------------------------

function member(over: Partial<Member>): Member {
  return { id: "m1", username: "ada", name: "Ada Lovelace", role: "developer", ...over };
}

const activity = (key: string, over: Partial<ContributorActivity> = {}): ContributorActivity => ({
  key,
  commitCount: 1,
  lastActivityAt: 1_000,
  ...over,
});

// --- toMemberView ----------------------------------------------------------

describe("toMemberView", () => {
  it("maps write roles (owner/maintainer) to canWrite and others to false", () => {
    expect(toMemberView(member({ role: "owner" }), undefined).canWrite).toBe(true);
    expect(toMemberView(member({ role: "maintainer" }), undefined).canWrite).toBe(true);
    expect(toMemberView(member({ role: "developer" }), undefined).canWrite).toBe(false);
    expect(toMemberView(member({ role: "guest" }), undefined).canWrite).toBe(false);
  });

  it("defaults commitCount to 0 and isActive to false with no activity", () => {
    const v = toMemberView(member({}), undefined);
    expect(v.commitCount).toBe(0);
    expect(v.isActive).toBe(false);
    expect(v.lastActivityAt).toBeUndefined();
  });

  it("gates isActive on the injected now/recentWindowMs window", () => {
    const now = 10_000;
    const recent = toMemberView(member({}), activity("ada", { lastActivityAt: 9_000 }), {
      now,
      recentWindowMs: 5_000, // 9000 >= 10000-5000 -> active
    });
    const stale = toMemberView(member({}), activity("ada", { lastActivityAt: 1_000 }), {
      now,
      recentWindowMs: 5_000, // 1000 < 5000 -> inactive
    });
    expect(recent.isActive).toBe(true);
    expect(stale.isActive).toBe(false);
  });

  it("carries displayName and avatarUrl through", () => {
    const v = toMemberView(member({ name: "Ada", avatarUrl: "https://a/x.png" }), activity("ada"));
    expect(v.displayName).toBe("Ada");
    expect(v.avatarUrl).toBe("https://a/x.png");
  });
});

// --- correlation -----------------------------------------------------------

describe("correlateMembers", () => {
  it("matches an activity key to a member by username, case-insensitively", () => {
    const members = [member({ username: "ada" })];
    const { matched, consumedKeys } = correlateMembers(members, [activity("ADA")]);
    expect(matched.has("m1")).toBe(true);
    expect(consumedKeys).toEqual(new Set(["ADA"]));
  });

  it("aggregates multiple authors that resolve to the same member (sum counts, keep latest)", () => {
    const members = [member({ username: "ada" })];
    const { matched } = correlateMembers(members, [
      activity("Ada", { commitCount: 2, lastActivityAt: 100 }),
      activity("ada", { commitCount: 3, lastActivityAt: 300 }),
    ]);
    const agg = matched.get("m1");
    expect(agg?.commitCount).toBe(5);
    expect(agg?.lastActivityAt).toBe(300);
  });

  it("falls back to the display name when username does not match", () => {
    const members = [member({ username: "grace", name: "Grace Hopper" })];
    const { matched } = correlateMembers(members, [activity("grace hopper")]);
    expect(matched.has("m1")).toBe(true);
  });

  it("does not match when neither key aligns", () => {
    const members = [member({ username: "ada" })];
    const { matched, consumedKeys } = correlateMembers(members, [activity("bob")]);
    expect(matched.size).toBe(0);
    expect(consumedKeys.size).toBe(0);
  });

  it("honors a custom strategy (derive a slug key the default matcher would miss)", () => {
    const members = [member({ username: "ada" })];
    // Default memberKeys are ["ada", "Ada Lovelace"]; neither matches "ADA_01".
    const slugStrategy: CorrelationStrategy = {
      memberKeys: (m) => [`${m.username}_01`],
      normalize: (s) => s.toLowerCase(),
    };
    const { matched, consumedKeys } = correlateMembers(members, [activity("ADA_01")], slugStrategy);
    expect(matched.has("m1")).toBe(true);
    expect(consumedKeys).toEqual(new Set(["ADA_01"]));
  });
});

// --- external contributors -------------------------------------------------

describe("externalContributors", () => {
  it("surfaces unmatched committers and excludes matched ones, sorted by contribution then name", () => {
    const members = [member({ username: "ada" })];
    const ext = externalContributors([activity("bob", { commitCount: 2 }), activity("cyd", { commitCount: 2 }), activity("ada")], members);
    expect(ext.map((e) => e.name)).toEqual(["bob", "cyd"]); // ada consumed; tie broken by name
    expect(ext[0].commitCount).toBe(2);
  });

  it("returns an empty list when every contributor matches a roster member", () => {
    const members = [member({ username: "ada" })];
    expect(externalContributors([activity("ada")], members)).toEqual([]);
  });
});

// --- buildMembershipSummary ------------------------------------------------

describe("buildMembershipSummary", () => {
  it("passes repo id/name through and totals all commits", () => {
    const members = [member({ username: "ada" }), member({ username: "bob", id: "m2" })];
    const summary = buildMembershipSummary("r1", "notes", members, [activity("ada", { commitCount: 3 }), activity("bob", { commitCount: 4 })]);
    expect(summary.repoId).toBe("r1");
    expect(summary.repoName).toBe("notes");
    expect(summary.totalCommits).toBe(7);
    expect(summary.externalContributors).toEqual([]);
  });

  it("sorts members active-first, then by contribution, then username", () => {
    const now = 100_000;
    const members = [
      member({ id: "a", username: "ada", role: "developer" }),
      member({ id: "b", username: "bob", role: "developer" }),
      member({ id: "c", username: "cyd", role: "developer" }),
    ];
    const summary: MembershipSummary = buildMembershipSummary(
      "r",
      "repo",
      members,
      [
        activity("ada", { commitCount: 1, lastActivityAt: now - 1000 }), // active, few commits
        activity("bob", { commitCount: 9, lastActivityAt: now - 1000 }), // active, many commits -> first
        activity("cyd", { commitCount: 5, lastActivityAt: 0 }), // stale (old timestamp)
      ],
      { now, recentWindowMs: 10_000 },
    );
    expect(summary.members.map((m) => m.username)).toEqual(["bob", "ada", "cyd"]);
    expect(summary.members[0].isActive).toBe(true);
    expect(summary.members[2].isActive).toBe(false);
  });

  it("keeps unmatched committers in externalContributors and counts them in the total", () => {
    const members = [member({ username: "ada" })];
    const summary = buildMembershipSummary("r", "repo", members, [activity("ada", { commitCount: 1 }), activity("ghost", { commitCount: 2 })]);
    expect(summary.externalContributors.map((e) => e.name)).toEqual(["ghost"]);
    expect(summary.totalCommits).toBe(3);
  });

  it("is deterministic for identical input", () => {
    const members = [member({ username: "ada" })];
    const a = buildMembershipSummary("r", "repo", members, [activity("ada"), activity("bob")]);
    const b = buildMembershipSummary("r", "repo", members, [activity("ada"), activity("bob")]);
    expect(a).toEqual(b);
  });
});
