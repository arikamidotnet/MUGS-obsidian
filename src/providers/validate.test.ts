/**
 * MUGS — credential form validation tests.
 *
 * Pins the offline "static analysis" the settings tab shows inline: endpoint
 * shape per provider (including the common website-vs-API-URL mistake), repo
 * slug rules, and the local `file://` path requirement.
 */
import { describe, it, expect } from "vitest";
import {
  validateBaseUrl,
  validateRepoSlug,
  validateRepoList,
  validateCredentialForm,
  hasBlockingProblem,
  normalizeLocalBaseUrl,
} from "./validate";

describe("validateBaseUrl", () => {
  it("accepts each provider's default endpoint", () => {
    expect(validateBaseUrl("gitlab", "https://gitlab.com/api/v4")).toBeNull();
    expect(validateBaseUrl("github", "https://api.github.com")).toBeNull();
    expect(validateBaseUrl("bitbucket", "https://api.bitbucket.org")).toBeNull();
    expect(validateBaseUrl("gitea", "https://gitea.com/api/v1")).toBeNull();
  });

  it("accepts a self-hosted instance endpoint", () => {
    expect(validateBaseUrl("gitlab", "https://gitlab.example.com/api/v4")).toBeNull();
    expect(validateBaseUrl("gitea", "https://gitea.example.com/api/v1")).toBeNull();
  });

  it("warns when the website URL is used instead of the API endpoint", () => {
    const gh = validateBaseUrl("github", "https://github.com");
    expect(gh?.level).toBe("warn");
    expect(gh?.message).toContain("api.github.com");

    const gl = validateBaseUrl("gitlab", "https://gitlab.com");
    expect(gl?.level).toBe("warn");
    expect(gl?.message).toContain("api/v4");

    expect(validateBaseUrl("bitbucket", "https://bitbucket.org")?.message).toContain("api.bitbucket.org");
    expect(validateBaseUrl("gitea", "https://gitea.com")?.message).toContain("api/v1");
  });

  it("errors on a malformed URL or a non-http scheme", () => {
    expect(validateBaseUrl("github", "not a url")?.level).toBe("error");
    expect(validateBaseUrl("github", "ftp://example.com")?.level).toBe("error");
  });

  it("leaves an empty hosted value to the provider default", () => {
    expect(validateBaseUrl("github", "")).toBeNull();
  });

  it("requires an endpoint for self-hosted-only providers", () => {
    const p = validateBaseUrl("forgejo", "");
    expect(p?.level).toBe("error");
    expect(p?.kind).toBe("required");
  });

  it("requires a file:// URL for local repositories", () => {
    expect(validateBaseUrl("local", "file:///tmp/repo.git")).toBeNull();
    expect(validateBaseUrl("local", "")?.kind).toBe("required");
    expect(validateBaseUrl("local", "https://example.com/repo.git")?.level).toBe("error");
  });

  it("accepts a bare absolute Linux path for local repositories", () => {
    expect(validateBaseUrl("local", "/home/user/repo.git")).toBeNull();
    expect(validateBaseUrl("local", "/srv/git/repo")).toBeNull();
  });

  it("still rejects relative paths, empty input, and a bare file:// without a path", () => {
    expect(validateBaseUrl("local", "home/user/repo")?.level).toBe("error");
    expect(validateBaseUrl("local", "")?.kind).toBe("required");
    expect(validateBaseUrl("local", "file://")?.level).toBe("error");
  });
});

describe("normalizeLocalBaseUrl", () => {
  it("converts a bare absolute Linux path to a file:// URL", () => {
    expect(normalizeLocalBaseUrl("/home/user/repo.git")).toBe("file:///home/user/repo.git");
    expect(normalizeLocalBaseUrl("/srv/git/repo")).toBe("file:///srv/git/repo");
  });

  it("trims whitespace and leaves file:// URLs and hosted endpoints untouched", () => {
    expect(normalizeLocalBaseUrl("  /tmp/repo  ")).toBe("file:///tmp/repo");
    expect(normalizeLocalBaseUrl("file:///tmp/repo.git")).toBe("file:///tmp/repo.git");
    expect(normalizeLocalBaseUrl("https://gitlab.com/api/v4")).toBe("https://gitlab.com/api/v4");
  });
});

describe("validateRepoSlug", () => {
  it("accepts owner/repo for every hosted provider", () => {
    for (const kind of ["github", "gitlab", "bitbucket", "gitea", "forgejo"] as const) {
      expect(validateRepoSlug(kind, "owner/repo")).toBeNull();
    }
  });

  it("allows nested groups only for GitLab", () => {
    expect(validateRepoSlug("gitlab", "group/sub/repo")).toBeNull();
    expect(validateRepoSlug("github", "group/sub/repo")?.level).toBe("error");
    expect(validateRepoSlug("bitbucket", "workspace/repo/extra")?.level).toBe("error");
  });

  it("rejects malformed paths", () => {
    expect(validateRepoSlug("github", "owner")?.level).toBe("error");
    expect(validateRepoSlug("github", "/owner/repo")?.level).toBe("error");
    expect(validateRepoSlug("github", "owner/repo/")?.level).toBe("error");
    expect(validateRepoSlug("github", "owner//repo")?.level).toBe("error");
    expect(validateRepoSlug("github", "owner/repo extra")?.level).toBe("error");
  });

  it("treats empty as absent (allowed repos is optional)", () => {
    expect(validateRepoSlug("github", "")).toBeNull();
    expect(validateRepoSlug("local", "anything")).toBeNull();
  });
});

describe("validateRepoList", () => {
  it("reports one problem per bad entry and quotes it", () => {
    const problems = validateRepoList("github", ["team/good", "bad", "team/other"]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('"bad"');
  });
});

describe("validateCredentialForm", () => {
  it("flags missing label and token for a hosted account", () => {
    const problems = validateCredentialForm({ kind: "gitlab", label: "", token: "", baseUrl: "https://gitlab.com/api/v4", repos: [] });
    expect(problems.map((p) => p.field).sort()).toEqual(["label", "token"]);
    expect(hasBlockingProblem(problems)).toBe(true);
  });

  it("accepts a complete hosted account", () => {
    const problems = validateCredentialForm({ kind: "gitlab", label: "Work", token: "glpat-123", baseUrl: "https://gitlab.com/api/v4", repos: ["team/repo"] });
    expect(problems).toEqual([]);
    expect(hasBlockingProblem(problems)).toBe(false);
  });

  it("accepts a complete local repository", () => {
    const problems = validateCredentialForm({ kind: "local", label: "Local", token: "", baseUrl: "file:///tmp/repo.git", repos: [] });
    expect(problems).toEqual([]);
  });

  it("treats a bad URL as blocking but a website URL only as a warning", () => {
    const bad = validateCredentialForm({ kind: "github", label: "GH", token: "t", baseUrl: "nope", repos: [] });
    expect(hasBlockingProblem(bad)).toBe(true);

    const warn = validateCredentialForm({ kind: "github", label: "GH", token: "t", baseUrl: "https://github.com", repos: [] });
    expect(hasBlockingProblem(warn)).toBe(false);
    expect(warn.some((p) => p.level === "warn")).toBe(true);
  });
});
