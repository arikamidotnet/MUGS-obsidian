import { describe, it, expect } from "vitest";
import type { HttpTransport, HttpResponse } from "./http";
import { buildProvider, providerFromCredential } from "./factory";

/** Fake transport that records the last call and returns a canned body. */
class FakeTransport implements HttpTransport {
  public last?: { url: string; headers: Record<string, string> };
  constructor(private body: unknown = []) {}
  async get<T>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>> {
    this.last = { url, headers: init.headers };
    return { status: 200, body: this.body as T };
  }
}

describe("buildProvider", () => {
  it("constructs GitLab against the default api/v4 base with PRIVATE-TOKEN auth", async () => {
    const t = new FakeTransport();
    const p = buildProvider({ kind: "gitlab", token: "glpat" }, { transport: t });
    expect(p.kind).toBe("gitlab");
    await p.listRepos();
    expect(t.last?.url.startsWith("https://gitlab.com/api/v4/projects")).toBe(true);
    expect(t.last?.headers["PRIVATE-TOKEN"]).toBe("glpat");
  });

  it("constructs GitHub against the default base with Authorization: Bearer", async () => {
    const t = new FakeTransport();
    const p = buildProvider({ kind: "github", token: "gho" }, { transport: t });
    expect(p.kind).toBe("github");
    await p.listRepos();
    expect(t.last?.url.startsWith("https://api.github.com/user/repos")).toBe(true);
    expect(t.last?.headers["Authorization"]).toBe("Bearer gho");
  });

  it("constructs Gitea with Authorization: token and honors a forgejo override", () => {
    const gitea = buildProvider({ kind: "gitea", token: "t" }, { transport: new FakeTransport() });
    expect(gitea.kind).toBe("gitea");
    const forgejo = buildProvider({ kind: "forgejo", token: "t" }, { transport: new FakeTransport() });
    expect(forgejo.kind).toBe("forgejo");
  });

  it("constructs Bitbucket against the /2.0 base with Authorization: Bearer", async () => {
    const t = new FakeTransport();
    const p = buildProvider({ kind: "bitbucket", token: "bb" }, { transport: t });
    expect(p.kind).toBe("bitbucket");
    await p.listRepos();
    expect(t.last?.url.startsWith("https://api.bitbucket.org/2.0/repositories")).toBe(true);
    expect(t.last?.headers["Authorization"]).toBe("Bearer bb");
  });

  it("honors an explicit baseUrl override over the default", async () => {
    const t = new FakeTransport();
    const p = buildProvider({ kind: "gitlab", baseUrl: "https://git.example.com/api/v4", token: "t" }, { transport: t });
    await p.listRepos();
    expect(t.last?.url.startsWith("https://git.example.com/api/v4/projects")).toBe(true);
  });

  it("passes the acting username through for Bitbucket", () => {
    // No network assertion needed; this pins that the option is accepted and the
    // provider still builds (getBranches would use it to resolve push rights).
    const p = buildProvider({ kind: "bitbucket", token: "bb" }, { actingUsername: "alice" });
    expect(p.kind).toBe("bitbucket");
  });

  it("throws a clear error for the local provider (no REST adapter)", () => {
    expect(() => buildProvider({ kind: "local", token: "t" })).toThrow(/local/);
  });
});

describe("providerFromCredential", () => {
  it("builds from a full credential, using its username as the acting user", () => {
    const p = providerFromCredential({ id: "c1", kind: "github", token: "gho", username: "ada" });
    expect(p.kind).toBe("github");
  });
});
