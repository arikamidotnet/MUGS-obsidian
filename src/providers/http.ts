/**
 * MUGS — provider HTTP transport abstraction.
 *
 * Provider adapters talk to backend REST APIs through this seam instead of
 * calling `fetch` directly. That keeps them unit-testable: tests inject a fake
 * transport that returns canned JSON, so no network is touched. The default
 * implementation wraps the global `fetch` (available in Obsidian/Electron and
 * Node 18+). Auth headers are supplied by each adapter (GitLab uses
 * `PRIVATE-TOKEN`, GitHub uses `Authorization`) — this transport is auth-agnostic.
 */

/** A parsed HTTP response: status, body, and the raw `Link` header if present. */
export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
  /** Value of the response `Link` header, if any (GitHub/GitLab use it for pagination). */
  linkHeader?: string | null;
}

/** Minimal GET transport used by provider adapters. */
export interface HttpTransport {
  get<T = unknown>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>>;
}

/** Default transport backed by the global `fetch`. */
export class FetchTransport implements HttpTransport {
  async get<T = unknown>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>> {
    const res = await fetch(url, { headers: init.headers });
    const linkHeader = res.headers.get("Link");
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch {
      // Non-JSON error bodies (e.g. an HTML 404 page): surface the status with an empty body.
      body = undefined as unknown as T;
    }
    return { status: res.status, body, linkHeader };
  }
}

/** Build a path with query params appended (values are stringified; null/undefined skipped). */
export function withQuery(path: string, params?: Record<string, string | number | boolean>): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Follow a paginated `Link` header, concatenating the body arrays across pages.
 * Used by adapters whose list endpoints page via `rel="next"`.
 */
export async function paginateAll(
  transport: HttpTransport,
  url: string,
  headers: Record<string, string>,
): Promise<unknown[]> {
  const acc: unknown[] = [];
  let next: string | null = url;
  while (next) {
    const res = await transport.get<unknown>(next, { headers });
    if (res.status >= 400) throw new Error(`GitLab ${res.status} error paginating ${next}`);
    if (Array.isArray(res.body)) acc.push(...(res.body as unknown[]));
    next = extractNextLink(res.linkHeader);
  }
  return acc;
}

/** Extract the `rel="next"` URL from a raw `Link` header value. */
function extractNextLink(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    // Standard Link header format: `<https://host/page>; rel="next"`
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}
