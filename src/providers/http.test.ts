import { describe, it, expect, vi, afterEach } from "vitest";
import { withQuery, extractNextLink, paginateAll, FetchTransport, type HttpTransport, type HttpResponse, safeExtractNextLink, safeResolveNext, redactUrl } from "./http";

/** Fake transport that routes on URL substring and records calls. */
class FakeTransport implements HttpTransport {
  readonly calls: { url: string; headers: Record<string, string> }[] = [];
  constructor(private handler: (url: string) => HttpResponse | Promise<HttpResponse>) {}
  async get<T = unknown>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>> {
    this.calls.push({ url, headers: init.headers });
    return this.handler(url) as HttpResponse<T>;
  }
}

afterEach(() => vi.unstubAllGlobals());

// --- withQuery -------------------------------------------------------------

describe("withQuery", () => {
  it("returns the path unchanged when no params are given", () => {
    expect(withQuery("/projects")).toBe("/projects");
    expect(withQuery("/projects", undefined)).toBe("/projects");
  });

  it("appends stringified number/boolean values", () => {
    expect(withQuery("/projects", { per_page: 100, include_wikis: true })).toBe(
      "/projects?per_page=100&include_wikis=true",
    );
  });

  it("URL-encodes values and skips null/undefined", () => {
    expect(withQuery("/projects", { q: "a b/c", bad: undefined, nil: null })).toBe("/projects?q=a+b%2Fc");
  });
});

// --- extractNextLink -------------------------------------------------------

describe("extractNextLink", () => {
  it("returns null for empty/absent headers", () => {
    expect(extractNextLink(null)).toBeNull();
    expect(extractNextLink(undefined)).toBeNull();
    expect(extractNextLink("")).toBeNull();
  });

  it("extracts the rel=next URL from a standard Link header", () => {
    expect(extractNextLink('<https://host/projects?page=2>; rel="next"')).toBe(
      "https://host/projects?page=2",
    );
  });

  it("picks next out of a multi-link header (prev, next, last)", () => {
    const link = '<https://host?page=1>; rel="prev", <https://host?page=3>; rel="next", <https://host?page=9>; rel="last"';
    expect(extractNextLink(link)).toBe("https://host?page=3");
  });

  it("ignores other rel values and malformed input", () => {
    expect(extractNextLink('<https://host?page=2>; rel="prev"')).toBeNull();
    expect(extractNextLink("not a link header")).toBeNull();
  });
});

// --- paginateAll -----------------------------------------------------------

describe("paginateAll", () => {
  it("follows a 3-page Link chain and concatenates the arrays", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://host/projects?per_page=100": {
        status: 200,
        body: [{ id: 1 }],
        linkHeader: '<https://host/projects?per_page=100&page=2>; rel="next"',
      },
      "https://host/projects?per_page=100&page=2": {
        status: 200,
        body: [{ id: 2 }],
        linkHeader: '<https://host/projects?per_page=100&page=3>; rel="next"',
      },
      "https://host/projects?per_page=100&page=3": { status: 200, body: [{ id: 3 }] },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://host/projects?per_page=100", {});
    expect(all.map((p) => (p as { id: number }).id)).toEqual([1, 2, 3]);
    expect(t.calls).toHaveLength(3);
  });

  it("stops on the first page when there is no Link header", async () => {
    const t = new FakeTransport(() => ({ status: 200, body: [{ id: 1 }] }));
    const all = await paginateAll(t, "https://host/projects", {});
    expect(all).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
  });

  it("throws on a non-2xx response while paginating", async () => {
    const t = new FakeTransport(() => ({ status: 500, body: {} }));
    await expect(paginateAll(t, "https://host/projects", {})).rejects.toThrow(/500/);
  });

  it("refuses to follow cross-origin next links (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host/projects": {
        status: 200,
        body: [{ id: 1 }],
        linkHeader: '<https://evil.host/projects?page=2>; rel="next"',
      },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host/projects", { Authorization: "Bearer x" });
    // Only the first page should be fetched; the cross-origin next must be ignored.
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
    // Headers for the first call must have contained the auth.
    expect(t.calls[0].headers.Authorization || t.calls[0].headers.authorization).toBeDefined();
  });

  it("redacts URLs in pagination error messages (C04)", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      body: [{ id: 1 }],
      linkHeader: '<https://user:sekret@host/p?page=2>; rel="next"',
    }));
    // The next page will 500; the error message must not contain the userinfo.
    const pages2: Record<string, HttpResponse> = {
      "https://user:sekret@host/p?page=2": { status: 500, body: {} },
    };
    // Patch handler to switch after first call
    const fake = new FakeTransport((u) => (u.includes("page=2") ? pages2[u]! : { status: 200, body: [{ id: 1 }], linkHeader: '<https://user:sekret@host/p?page=2>; rel="next"' }));
    await expect(paginateAll(fake, "https://host/p", {})).rejects.toThrow(/<redacted>/);
    // And the secret must not be present.
    await expect(paginateAll(fake, "https://host/p", {})).rejects.not.toThrow(/sekret/);
  });

  it("ignores javascript: next links (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host/p": { status: 200, body: [{ id: 1 }], linkHeader: '<javascript:alert(1)>; rel="next"' },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host/p", { Authorization: "Bearer x" });
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
  });

  it("ignores data: next links (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host/p": { status: 200, body: [{ id: 1 }], linkHeader: '<data:text/html,xx>; rel="next"' },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host/p", { Authorization: "Bearer x" });
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
  });

  it("ignores protocol-relative next links (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host/p": { status: 200, body: [{ id: 1 }], linkHeader: '<//evil.host/p2>; rel="next"' },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host/p", { Authorization: "Bearer x" });
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
  });

  it("ignores port-mismatch next links (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host:8443/p": { status: 200, body: [{ id: 1 }], linkHeader: '<https://api.host:8444/p2>; rel="next"' },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host:8443/p", { Authorization: "Bearer x" });
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
  });

  it("ignores scheme-mismatch (http vs https) next links (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host/p": { status: 200, body: [{ id: 1 }], linkHeader: '<http://api.host/p2>; rel="next"' },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host/p", { Authorization: "Bearer x" });
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
  });

  it("ignores cross-origin absolute next even if Link appears relative-ish (C04)", async () => {
    const pages: Record<string, HttpResponse> = {
      "https://api.host/p": { status: 200, body: [{ id: 1 }], linkHeader: '<https://evil.host/xx>; rel="next"' },
    };
    const t = new FakeTransport((url) => pages[url]!);
    const all = await paginateAll(t, "https://api.host/p", { Authorization: "Bearer x" });
    expect(all.map((p: any) => p.id)).toEqual([1]);
    expect(t.calls).toHaveLength(1);
  });
});

// --- safeResolveNext / safeExtractNextLink (C04) ---------------------------
describe("safeResolveNext / safeExtractNextLink (C04)", () => {
  const base = "https://api.host:8443/base";
  it("accepts same-origin absolute", () => {
    expect(safeResolveNext("https://api.host:8443/n", base)).toMatch(/api.host:8443/);
  });
  it("accepts relative resolved to same origin", () => {
    expect(safeResolveNext("/next", base)).toMatch(/api.host:8443/);
  });
  it("rejects cross-origin absolute", () => {
    expect(safeResolveNext("https://evil.host/n", base)).toBeNull();
  });
  it("rejects javascript:", () => {
    expect(safeResolveNext("javascript:alert(1)", base)).toBeNull();
  });
  it("rejects data:", () => {
    expect(safeResolveNext("data:text/html,xx", base)).toBeNull();
  });
  it("rejects protocol-relative", () => {
    expect(safeResolveNext("//evil.host/n", base)).toBeNull();
  });
  it("rejects port mismatch", () => {
    expect(safeResolveNext("https://api.host:8444/n", base)).toBeNull();
  });
  it("rejects scheme mismatch (http vs https)", () => {
    expect(safeResolveNext("http://api.host:8443/n", base)).toBeNull();
  });
  it("path traversal on same-origin stays same-origin (C04 origin gate does not enforce path containment)", () => {
    // /../../evil against https://api.host:8443/base normalizes to same-origin path; accepted by origin check.
    const res = safeResolveNext("/../../evil", base);
    expect(res).toMatch(/api.host:8443/);
  });
  it("safeExtractNextLink extracts then resolves (C04)", () => {
    expect(safeExtractNextLink('<https://api.host:8443/n2>; rel="next"', base)).toMatch(/n2/);
    expect(safeExtractNextLink('<//evil.host/n2>; rel="next"', base)).toBeNull();
  });
});

// --- FetchTransport --------------------------------------------------------

describe("FetchTransport", () => {
  function stubFetch(res: { status: number; link?: string | null; jsonBody?: unknown; throwOnJson?: boolean }) {
    const fakeFetch = vi.fn(async () => ({
      status: res.status,
      headers: { get: (h: string) => (h.toLowerCase() === "link" ? res.link ?? null : null) },
      json: async () => {
        if (res.throwOnJson) throw new Error("invalid JSON");
        return res.jsonBody;
      },
    }));
    vi.stubGlobal("fetch", fakeFetch);
    return fakeFetch;
  }

  it("returns status, parsed body, and the Link header", async () => {
    stubFetch({ status: 200, link: '<https://host?page=2>; rel="next"', jsonBody: [{ id: 1 }] });
    const out = await new FetchTransport().get("https://host/projects", { headers: { "PRIVATE-TOKEN": "t" } });
    expect(out.status).toBe(200);
    expect(out.body).toEqual([{ id: 1 }]);
    expect(out.linkHeader).toContain('rel="next"');
  });

  it("surfaces an empty body with the status when the JSON is not parseable", async () => {
    stubFetch({ status: 404, throwOnJson: true });
    const out = await new FetchTransport().get("https://host/missing", { headers: {} });
    expect(out.status).toBe(404);
    expect(out.body).toBeUndefined();
  });
});
