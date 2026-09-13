import { describe, it, expect } from "vitest";
import { GiteaProvider } from "./gitea";
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

const BASE = "https://gitea.com/api/v1";

function provider(transport: HttpTransport, kind?: "gitea" | "forgejo") {
  return new GiteaProvider({ baseUrl: BASE, token: "secret-token", transport, kind });
}

describe("GiteaProvider — auth + kind", () => {
  it("authenticates with the Authorization: token header (not PRIVATE-TOKEN)", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [] }));
    await provider(t).listRepos();
    const h = t.calls[0].headers;
    expect(h["Authorization"]).toBe("token secret-token");
    expect(h["PRIVATE-TOKEN"]).toBeUndefined();
  });

  it("defaults to kind gitea and honors a forgejo override", () => {
    expect(new GiteaProvider({ baseUrl: BASE, token: "t" }).kind).toBe("gitea");
    expect(new GiteaProvider({ baseUrl: BASE, token: "t", kind: "forgejo" }).kind).toBe("forgejo");
  });
});

describe("GiteaProvider — listRepos", () => {
  it("maps native fields to the RepoSummary contract (prefers clone_url)", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [
        {
          id: 42,
          name: "notes",
          full_name: "team/notes",
          html_url: "https://gitea.com/team/notes",
          clone_url: "https://gitea.com/team/notes.git",
          default_branch: "main",
          description: "Personal notes",
          private: true,
        },
      ],
    }));
    const repos = await provider(t).listRepos();
    expect(repos[0]).toMatchObject({
      id: "42",
      name: "notes",
      pathWithNamespace: "team/notes",
      httpUrlToRepo: "https://gitea.com/team/notes.git",
      defaultBranch: "main",
      visibility: "private",
    });
  });

  it("derives the clone URL from html_url when clone_url is absent", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [{ id: 1, name: "n", full_name: "u/n", html_url: "https://gitea.com/u/n", default_branch: "main" }],
    }));
    const repos = await provider(t).listRepos();
    expect(repos[0].httpUrlToRepo).toBe("https://gitea.com/u/n.git");
  });

  it("follows the rel=\"next\" Link header across pages", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("page=2"))
        return { status: 200, body: [{ id: 2, name: "b", full_name: "u/b", html_url: "https://gitea.com/u/b", default_branch: "main" }] };
      return {
        status: 200,
        body: [{ id: 1, name: "a", full_name: "u/a", html_url: "https://gitea.com/u/a", default_branch: "main" }],
        linkHeader: '<https://gitea.com/api/v1/user/repos?page=2>; rel="next"',
      };
    });
    const repos = await provider(t).listRepos();
    expect(repos.map((r) => r.id)).toEqual(["1", "2"]);
    expect(t.calls).toHaveLength(2);
  });
});

describe("GiteaProvider — getMembers", () => {
  it("maps native role strings to normalized MUGS roles and URL-encodes the repo id", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [
        { id: 1, username: "admin-user", fullname: "Admin", role: "admin" },
        { id: 2, username: "write-user", role: "write" },
        { id: 3, username: "read-user", role: "read" },
      ],
    }));
    const members = await provider(t).getMembers("group/project");
    expect(members.map((m) => m.role)).toEqual(["maintainer", "developer", "guest"]);
    expect(members[0].name).toBe("Admin");
    expect(t.calls[0].url).toBe("https://gitea.com/api/v1/repos/group%2Fproject/members?per_page=100");
  });
});

describe("GiteaProvider — getBranches", () => {
  it("marks the default branch and sets canPush from protection", async () => {
    const t = new FakeTransport((url) => {
      // includes() (not endsWith()) because the branches URL carries ?per_page=100.
      if (url.includes("/branches"))
        return {
          status: 200,
          body: [
            { name: "main", protected: false },
            { name: "release", protected: true },
          ],
        };
      // /repos/{id} returns the repo (with default_branch)
      return { status: 200, body: { id: 1, full_name: "t/n", default_branch: "main" } };
    });
    const branches = await provider(t).getBranches("t/n");
    expect(branches).toEqual([
      { name: "main", protected: false, default: true, canPush: true },
      { name: "release", protected: true, default: false, canPush: false },
    ]);
  });

  it("throws on a non-2xx response fetching branches", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/branches")) return { status: 404, body: {} };
      return { status: 200, body: { id: 1, default_branch: "main" } };
    });
    await expect(provider(t).getBranches("t/n")).rejects.toThrow(/404/);
  });
});
