import { describe, it, expect } from "vitest";
import { cloneUrlFor, resolveDefaultBranch } from "./repoUrls";

describe("cloneUrlFor", () => {
  it("builds a GitLab clone URL (strips /api/v4)", () => {
    expect(cloneUrlFor("https://gitlab.com/api/v4", "fbr-rom/FBR-WRK")).toBe("https://gitlab.com/fbr-rom/FBR-WRK.git");
  });

  it("builds a GitHub clone URL (drops the api. subdomain)", () => {
    expect(cloneUrlFor("https://api.github.com", "team/notes")).toBe("https://github.com/team/notes.git");
  });

  it("builds a Gitea clone URL (strips /api/v1)", () => {
    expect(cloneUrlFor("https://gitea.com/api/v1", "o/r")).toBe("https://gitea.com/o/r.git");
  });

  it("builds a Bitbucket clone URL (bare host, no api. subdomain)", () => {
    expect(cloneUrlFor("https://api.bitbucket.org", "ws/repo")).toBe("https://bitbucket.org/ws/repo.git");
  });

  it("handles self-hosted GitLab with nested group paths", () => {
    expect(cloneUrlFor("https://git.example.com/api/v4", "grp/sub/repo")).toBe("https://git.example.com/grp/sub/repo.git");
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(cloneUrlFor("https://gitlab.com/api/v4/", "o/r")).toBe("https://gitlab.com/o/r.git");
  });

  it("handles GitHub Enterprise (api path, no api. subdomain)", () => {
    expect(cloneUrlFor("https://ghe.example.com/api/v3", "team/repo")).toBe("https://ghe.example.com/team/repo.git");
  });
});

describe("resolveDefaultBranch", () => {
  const branches = [
    { name: "dev", protected: false, default: false, canPush: true },
    { name: "main", protected: false, default: true, canPush: true },
  ];

  it("picks the branch flagged default", () => {
    expect(resolveDefaultBranch(branches)).toBe("main");
  });

  it("falls back to the first branch when none is flagged", () => {
    expect(resolveDefaultBranch([{ name: "trunk", protected: false, default: false, canPush: true }])).toBe("trunk");
  });

  it("returns empty for an empty list", () => {
    expect(resolveDefaultBranch([])).toBe("");
  });
});
