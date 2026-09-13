import { describe, it, expect } from "vitest";
import { GitHubProvider } from "./github";
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

const BASE = "https://api.github.com";

function provider(transport: HttpTransport) {
  return new GitHubProvider({ baseUrl: BASE, token: "secret-token", transport });
}

describe("GitHubProvider — auth", () => {
  it("authenticates with the Authorization: Bearer header (not PRIVATE-TOKEN)", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [] }));
    await provider(t).listRepos();
    const h = t.calls[0].headers;
    expect(h["Authorization"]).toBe("Bearer secret-token");
    expect(h["PRIVATE-TOKEN"]).toBeUndefined();
  });

  it("strips a trailing slash from the base URL", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [] }));
    await new GitHubProvider({ baseUrl: "https://api.github.com/", token: "t", transport: t }).listRepos();
    expect(t.calls[0].url.startsWith("https://api.github.com/user/repos")).toBe(true);
  });
});

describe("GitHubProvider — listRepos", () => {
  it("maps native camelCase repos to the RepoSummary contract", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [
        {
          id: 42,
          name: "notes",
          full_name: "team/notes",
          html_url: "https://github.com/team/notes",
          default_branch: "main",
          description: "Personal notes",
          private: true,
        },
      ],
    }));
    const repos = await provider(t).listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: "42",
      name: "notes",
      pathWithNamespace: "team/notes",
      httpUrlToRepo: "https://github.com/team/notes.git",
      defaultBranch: "main",
      visibility: "private",
    });
  });

  it("follows the rel=\"next\" Link header across pages", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("page=2"))
        return { status: 200, body: [{ id: 2, name: "b", full_name: "u/b", html_url: "https://github.com/u/b", default_branch: "main" }] };
      return {
        status: 200,
        body: [{ id: 1, name: "a", full_name: "u/a", html_url: "https://github.com/u/a", default_branch: "main" }],
        linkHeader: '<https://api.github.com/user/repos?page=2>; rel="next"',
      };
    });
    const repos = await provider(t).listRepos();
    expect(repos.map((r) => r.id)).toEqual(["1", "2"]);
    expect(t.calls).toHaveLength(2);
  });

  it("throws on a non-2xx response while paginating", async () => {
    const t = new FakeTransport(() => ({ status: 401, body: { message: "bad token" } }));
    await expect(provider(t).listRepos()).rejects.toThrow(/401/);
  });
});

describe("GitHubProvider — getMembers", () => {
  it("maps collaborator + per-user permission role to the Member contract", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/permission")) return { status: 200, body: { role: "write" } };
      return {
        status: 200,
        body: [{ login: "ada", name: "Ada", avatar_url: "https://x/ada.png" }],
      };
    });
    const members = await provider(t).getMembers("team/notes");
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: "ada", username: "ada", name: "Ada", role: "maintainer" });
    // Namespaced repo path is URL-encoded in both the list and per-user paths.
    expect(t.calls[0].url).toBe("https://api.github.com/repos/team%2Fnotes/collaborators?per_page=100");
    expect(t.calls[1].url).toBe("https://api.github.com/repos/team%2Fnotes/collaborators/ada/permission");
  });

  it("defaults to guest when the permission lookup fails", async () => {
    const t = new FakeTransport((url) => {
      if (url.includes("/permission")) return { status: 404, body: {} };
      return { status: 200, body: [{ login: "guest-user" }] };
    });
    const members = await provider(t).getMembers("t/n");
    expect(members[0].role).toBe("guest");
  });
});

describe("GitHubProvider — getBranches", () => {
  it("marks the default branch and computes canPush from protection + access level", async () => {
    const t = new FakeTransport((url) => {
      if (url.endsWith("/access-level")) return { status: 200, body: { role: "write" } };
      // Route the branches list before the bare repo GET (both contain "/repos/").
      if (url.includes("/branches"))
        return {
          status: 200,
          body: [
            { name: "main", protected: false },
            { name: "release", protected: true },
          ],
        };
      return { status: 200, body: { id: 1, default_branch: "main" } };
    });
    const branches = await provider(t).getBranches("team/notes");
    expect(branches).toEqual([
      { name: "main", protected: false, default: true, canPush: true },
      { name: "release", protected: true, default: false, canPush: false },
    ]);
  });

  it("blocks pushes for a read-only acting user", async () => {
    const t = new FakeTransport((url) => {
      if (url.endsWith("/access-level")) return { status: 200, body: { role: "read" } };
      // Route the branches list before the bare repo GET.
      if (url.includes("/branches")) return { status: 200, body: [{ name: "main", protected: false }] };
      return { status: 200, body: { default_branch: "main" } };
    });
    const branches = await provider(t).getBranches("t/n");
    expect(branches[0].canPush).toBe(false);
  });

  it("throws on a non-2xx response fetching the repo", async () => {
    const t = new FakeTransport(() => ({ status: 404, body: {} }));
    await expect(provider(t).getBranches("t/n")).rejects.toThrow(/404/);
  });
});
