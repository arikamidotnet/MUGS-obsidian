import { describe, it, expect } from "vitest";
import type { HttpTransport, HttpResponse } from "./http";
import { BitbucketProvider } from "./bitbucket";

/**
 * Fake transport that routes on URL substring and returns canned JSON. It also
 * supports the JSON `next` cursor pagination used by Bitbucket's /2.0 API: a
 * response may carry a `next` field pointing at the next page URL, which the
 * provider will request again.
 */
class FakeTransport implements HttpTransport {
  public calls: Array<{ url: string; headers: Record<string, string> }> = [];

  constructor(private routes: Record<string, HttpResponse>) {}

  async get<T>(url: string, init: { headers?: Record<string, string> }): Promise<HttpResponse<T>> {
    this.calls.push({ url, headers: init.headers ?? {} });
    for (const [key, res] of Object.entries(this.routes)) {
      if (url.includes(key)) return res as HttpResponse<T>;
    }
    throw new Error(`No route for ${url}`);
  }
}

const BASE = "https://api.bitbucket.org";

describe("BitbucketProvider", () => {
  it("sends an Authorization: Bearer header (OAuth)", async () => {
    const t = new FakeTransport({
      "/repositories": { status: 200, body: { values: [], next: null } },
    });
    await new BitbucketProvider({ baseUrl: BASE, token: "tok", transport: t }).listRepos();
    expect(t.calls[0].headers.Authorization).toBe("Bearer tok");
    expect(t.calls[0].headers.Accept).toBe("application/json");
  });

  it("kind is bitbucket", () => {
    const p = new BitbucketProvider({ baseUrl: BASE, token: "tok" });
    expect(p.kind).toBe("bitbucket");
  });

  it("listRepos maps workspace/repo repos with clone URL and default branch", async () => {
    const t = new FakeTransport({
      "/repositories": {
        status: 200,
        body: {
          values: [
            {
              uuid: "uuid-1",
              name: "notes",
              full_name: "acme/notes",
              is_private: true,
              mainbranch: { name: "main" },
              links: { clone: [{ name: "ssh", href: "git@bitbucket.org:acme/notes.git" }, { name: "https", href: "https://bitbucket.org/acme/notes.git" }] },
            },
          ],
          next: null,
        },
      },
    });
    const repos = await new BitbucketProvider({ baseUrl: BASE, token: "tok", transport: t }).listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({
      id: "uuid-1",
      name: "notes",
      pathWithNamespace: "acme/notes",
      httpUrlToRepo: "https://bitbucket.org/acme/notes.git",
      defaultBranch: "main",
      visibility: "private",
    });
  });

  it("getMembers maps participant roles to normalized member roles", async () => {
    const t = new FakeTransport({
      "/participants": {
        status: 200,
        body: {
          values: [
            { role: "OWNER", user: { username: "boss", name: "The Boss" } },
            { role: "ADMIN", user: { username: "admin" } },
            { role: "MEMBER", user: { username: "dev" } },
            { role: "CONTRIBUTOR", user: { username: "contrib" } },
            { role: "UNKNOWN_ROLE", user: { username: "weird" } },
          ],
          next: null,
        },
      },
    });
    const members = await new BitbucketProvider({ baseUrl: BASE, token: "tok", transport: t }).getMembers("acme/notes");
    expect(members.map((m) => m.username)).toEqual(["boss", "admin", "dev", "contrib", "weird"]);
    expect(members.map((m) => m.role)).toEqual(["owner", "maintainer", "developer", "developer", "guest"]);
  });

  it("getBranches returns refs with default flag and write-capable push rights by default", async () => {
    const t = new FakeTransport({
      // Order matters: check the more specific paths before the bare repo path.
      "/participants": { status: 200, body: { values: [], next: null } },
      "/refs": { status: 200, body: { values: [{ name: "main" }, { name: "dev" }], next: null } },
      "/repositories/acme%2Fnotes": {
        status: 200,
        body: { uuid: "uuid-1", name: "notes", full_name: "acme/notes", mainbranch: { name: "main" } },
      },
    });
    const branches = await new BitbucketProvider({ baseUrl: BASE, token: "tok", transport: t }).getBranches("acme/notes");
    expect(branches.map((b) => b.name)).toEqual(["main", "dev"]);
    const main = branches.find((b) => b.name === "main")!;
    const dev = branches.find((b) => b.name === "dev")!;
    expect(main.default).toBe(true);
    expect(dev.default).toBe(false);
    // No acting user → write-capable token pushes by default.
    expect(main.canPush).toBe(true);
  });

  it("getBranches computes canPush=false for a read-only acting user", async () => {
    const t = new FakeTransport({
      "/participants": {
        status: 200,
        body: { values: [{ role: "CONTRIBUTOR", user: { username: "reader" } }], next: null },
      },
      "/refs": { status: 200, body: { values: [{ name: "main" }], next: null } },
      "/repositories/acme%2Fnotes": { status: 200, body: { mainbranch: { name: "main" } } },
    });
    const branches = await new BitbucketProvider({
      baseUrl: BASE,
      token: "tok",
      actingUsername: "reader",
      transport: t,
    }).getBranches("acme/notes");
    expect(branches[0].canPush).toBe(false);
  });

  it("paginates a JSON `next` cursor across pages", async () => {
    const firstPage = { status: 200, body: { values: [{ name: "a" }], next: `${BASE}/2.0/repositories/acme/notes/refs?page=2` } };
    const secondPage = { status: 200, body: { values: [{ name: "b" }], next: null } };
    const t = new FakeTransport({
      "/participants": { status: 200, body: { values: [], next: null } },
      "/refs?page=2": secondPage,
      "/refs": firstPage,
      "/repositories/acme%2Fnotes": { status: 200, body: { mainbranch: { name: "main" } } },
    });
    const branches = await new BitbucketProvider({ baseUrl: BASE, token: "tok", transport: t }).getBranches("acme/notes");
    expect(branches.map((b) => b.name)).toEqual(["a", "b"]);
  });
});
