import { describe, it, expect } from "vitest";
import { GitLabProvider } from "./gitlab";
import type { HttpTransport, HttpResponse } from "./http";

/** Fake transport that routes on URL substring and records calls. */
class FakeTransport implements HttpTransport {
  readonly calls: { url: string; headers: Record<string, string> }[] = [];
  constructor(private handler: (url: string) => HttpResponse | Promise<HttpResponse>) {}
  async get<T = unknown>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>> {
    this.calls.push({ url, headers: init.headers });
    return this.handler(url) as HttpResponse<T>;
  }
}

const BASE = "https://gitlab.com/api/v4";

function provider(transport: HttpTransport) {
  return new GitLabProvider({ baseUrl: BASE, token: "secret-token", transport });
}

describe("GitLabProvider — auth", () => {
  it("authenticates with the PRIVATE-TOKEN header (not Authorization)", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [] }));
    await provider(t).listRepos();
    const h = t.calls[0].headers;
    expect(h["PRIVATE-TOKEN"]).toBe("secret-token");
    expect(h.Authorization).toBeUndefined();
  });

  it("strips a trailing slash from the base URL", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [] }));
    await new GitLabProvider({ baseUrl: "https://gitlab.com/api/v4/", token: "t", transport: t }).listRepos();
    // Trailing slash on the base must not produce api/v4//projects
    expect(t.calls[0].url.startsWith("https://gitlab.com/api/v4/projects")).toBe(true);
  });
});

describe("GitLabProvider — listRepos", () => {
  it("maps native snake_case projects to the RepoSummary contract", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [
        {
          id: 42,
          name: "notes",
          path_with_namespace: "team/notes",
          http_url_to_repo: "https://gitlab.com/team/notes.git",
          default_branch: "main",
          description: "Personal notes",
          visibility: "private",
        },
      ],
    }));
    const repos = await provider(t).listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: "42",
      name: "notes",
      pathWithNamespace: "team/notes",
      httpUrlToRepo: "https://gitlab.com/team/notes.git",
      defaultBranch: "main",
      visibility: "private",
    });
  });

  it("follows the rel=\"next\" Link header across pages", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("page=2")) return { status: 200, body: [{ id: 2, name: "b", path_with_namespace: "u/b", http_url_to_repo: "https://gitlab.com/u/b.git", default_branch: "main" }] };
      return { status: 200, body: [{ id: 1, name: "a", path_with_namespace: "u/a", http_url_to_repo: "https://gitlab.com/u/a.git", default_branch: "main" }], linkHeader: '<https://gitlab.com/api/v4/projects?page=2>; rel="next"' };
    });
    const repos = await provider(t).listRepos();
    expect(repos.map((r) => r.id)).toEqual(["1", "2"]);
    // Two GETs: page 1 (with Link) then page 2 (no Link).
    expect(t.calls).toHaveLength(2);
  });

  it("throws on a non-2xx response while paginating", async () => {
    const t = new FakeTransport(() => ({ status: 404, body: { message: "404 Project not found" } }));
    await expect(provider(t).listRepos()).rejects.toThrow(/404/);
  });
});

describe("GitLabProvider — getMembers", () => {
  it("maps GitLab access_level to normalized roles", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [
        { id: 1, username: "owner-user", name: "Owner", access_level: 5000 },
        { id: 2, username: "maint-user", access_level: 4000 },
        { id: 3, username: "dev-user", access_level: 3000 },
        { id: 4, username: "guest-user", access_level: 1000 },
      ],
    }));
    const members = await provider(t).getMembers("7");
    expect(members.map((m) => m.role)).toEqual(["owner", "maintainer", "developer", "guest"]);
    expect(members[0].username).toBe("owner-user");
  });

  it("URL-encodes namespaced project paths in the members endpoint", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [] }));
    await provider(t).getMembers("group/project");
    expect(t.calls[0].url).toBe("https://gitlab.com/api/v4/projects/group%2Fproject/members?per_page=100");
  });
});

describe("GitLabProvider — getBranches", () => {
  it("computes canPush from protection + acting user access level", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/members/me")) return { status: 200, body: { id: 1, username: "me", access_level: 3000 } };
      return {
        status: 200,
        body: [
          { name: "main", protected: false, default: true },
          { name: "release", protected: true, default: false },
        ],
      };
    });
    const branches = await provider(t).getBranches("7");
    expect(branches).toEqual([
      { name: "main", protected: false, default: true, canPush: true },
      { name: "release", protected: true, default: false, canPush: false },
    ]);
  });

  it("marks every branch unpushable for a guest-level acting user", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/members/me")) return { status: 200, body: { id: 1, username: "me", access_level: 1000 } };
      return { status: 200, body: [{ name: "main", protected: false, default: true }] };
    });
    const branches = await provider(t).getBranches("7");
    expect(branches[0].canPush).toBe(false);
  });

  it("defaults to developer access when /members/me is unavailable", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/members/me")) return { status: 403, body: { message: "403" } };
      return { status: 200, body: [{ name: "main", protected: false, default: true }] };
    });
    const branches = await provider(t).getBranches("7");
    expect(branches[0].canPush).toBe(true);
  });

  it("throws on a non-2xx response fetching branches", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/members/me")) return { status: 200, body: { id: 1, username: "me", access_level: 3000 } };
      return { status: 404, body: { message: "404" } };
    });
    await expect(provider(t).getBranches("7")).rejects.toThrow(/404/);
  });
});
