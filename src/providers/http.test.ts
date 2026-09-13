import { describe, it, expect, vi, afterEach } from "vitest";
import { withQuery, extractNextLink, paginateAll, FetchTransport, type HttpTransport, type HttpResponse } from "./http";

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
