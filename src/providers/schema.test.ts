import { describe, it, expect } from "vitest";
import {
  repoSummarySchema,
  branchSummarySchema,
  memberSchema,
  type MemberRole,
} from "./schema";

describe("provider contract — RepoSummary", () => {
  it("accepts a normalized project object with all fields", () => {
    const repo = repoSummarySchema.parse({
      id: "12345",
      name: "notes",
      pathWithNamespace: "team/notes",
      httpUrlToRepo: "https://gitlab.com/team/notes.git",
      defaultBranch: "main",
      description: "Personal notes",
      visibility: "private",
    });
    expect(repo.id).toBe("12345");
    expect(repo.pathWithNamespace).toBe("team/notes");
    expect(repo.defaultBranch).toBe("main");
  });

  it("omits optional fields when absent", () => {
    const repo = repoSummarySchema.parse({
      id: "1",
      name: "n",
      pathWithNamespace: "u/n",
      httpUrlToRepo: "https://example.com/u/n.git",
      defaultBranch: "main",
    });
    expect(repo.description).toBeUndefined();
    expect(repo.visibility).toBeUndefined();
  });

  it("requires the core fields", () => {
    expect(() => repoSummarySchema.parse({ id: "1" })).toThrow();
  });

  it("rejects a non-URL clone link", () => {
    expect(() =>
      repoSummarySchema.parse({
        id: "1",
        name: "n",
        pathWithNamespace: "u/n",
        httpUrlToRepo: "not-a-url",
        defaultBranch: "main",
      }),
    ).toThrow();
  });

  it("rejects an unknown visibility value", () => {
    expect(() =>
      repoSummarySchema.parse({
        id: "1",
        name: "n",
        pathWithNamespace: "u/n",
        httpUrlToRepo: "https://example.com/u/n.git",
        defaultBranch: "main",
        visibility: "secret" as never,
      }),
    ).toThrow();
  });
});

describe("provider contract — BranchSummary", () => {
  it("captures push rights and protection/default flags", () => {
    const b = branchSummarySchema.parse({
      name: "main",
      protected: true,
      default: true,
      canPush: true,
    });
    expect(b.canPush).toBe(true);
    expect(b.protected).toBe(true);
    expect(b.default).toBe(true);
  });

  it("rejects missing canPush (needed for sync decisions)", () => {
    expect(() =>
      branchSummarySchema.parse({ name: "x", protected: false, default: false }),
    ).toThrow();
  });
});

describe("provider contract — Member", () => {
  it("accepts a collaborator with a normalized role", () => {
    const m = memberSchema.parse({
      id: "7",
      username: "ada",
      name: "Ada Lovelace",
      role: "maintainer" as MemberRole,
    });
    expect(m.role).toBe("maintainer");
    expect(m.name).toBe("Ada Lovelace");
  });

  it("rejects an unknown role", () => {
    expect(() =>
      memberSchema.parse({ id: "7", username: "ada", role: "superuser" as MemberRole }),
    ).toThrow();
  });

  it("omits optional name/avatar when absent", () => {
    const m = memberSchema.parse({ id: "8", username: "grace", role: "guest" });
    expect(m.name).toBeUndefined();
    expect(m.avatarUrl).toBeUndefined();
  });
});
