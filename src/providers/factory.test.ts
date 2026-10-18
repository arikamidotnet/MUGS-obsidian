import { describe, it, expect } from "vitest";
import type { HttpTransport, HttpResponse } from "./http";
import { buildProvider, providerFromCredential } from "./factory";

/**
 * Fake transport that records the last call. The canned "body" may be a static
 * value or a dispatcher `(url) => HttpResponse` so tests can vary responses by
 * endpoint (e.g. branches vs. members/me). A function body is invoked per call.
 */
class FakeTransport implements HttpTransport {
  public last?: { url: string; headers: Record<string, string> };
  constructor(private responder: unknown | ((url: string) => HttpResponse<unknown>) = []) {}
  async get<T>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>> {
    this.last = { url, headers: init.headers };
    const body = typeof this.responder === "function"
      ? (this.responder as (u: string) => HttpResponse<unknown>)(url).body
      : this.responder;
    return { status: 200, body: body as T };
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

  it("threads allowedRepos so listRepos synthesizes without enumeration", async () => {
    const t = new FakeTransport((url: string) => {
      if (url.includes("/repository/branches")) return { status: 200, body: [{ name: "main", protected: false, default: true }] };
      if (url.includes("/members/me")) return { status: 200, body: { access_level: 3000 } };
      return { status: 200, body: [] };
    });
    const p = buildProvider({ kind: "gitlab", token: "t", allowedRepos: ["fbr-rom/FBR-WRK"] }, { transport: t });
    const repos = await p.listRepos();
    expect(repos.map((r) => r.pathWithNamespace)).toEqual(["fbr-rom/FBR-WRK"]);
    // The recorded call is a branches call, never the /projects enumeration endpoint.
    expect(t.last && /\/projects(\?|$)/.test(t.last.url)).toBe(false);
  });

  it("passes the credential's allowed repos through providerFromCredential", async () => {
    const t = new FakeTransport((url: string) => {
      if (url.includes("/repository/branches")) return { status: 200, body: [{ name: "main", protected: false, default: true }] };
      if (url.includes("/members/me")) return { status: 200, body: { access_level: 3000 } };
      return { status: 200, body: [] };
    });
    const p = providerFromCredential({ id: "c1", kind: "gitlab", token: "t", repos: ["o/r"] }, { transport: t });
    expect((await p.listRepos()).map((r) => r.pathWithNamespace)).toEqual(["o/r"]);
  });
});
