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
  /** Human-readable error detail extracted from a JSON error body when status >= 400. */
  message?: string;
}

/** Minimal GET transport used by provider adapters. */
export interface HttpTransport {
  get<T = unknown>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>>;
}

/** Default transport backed by the global `fetch`. */
export class FetchTransport implements HttpTransport {
  async get<T = unknown>(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse<T>> {
    // Hard timeout: a hung request would stall the whole sync pass (and the
    // in-flight guard then blocks every later pass until the plugin reloads).
    const res = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(30_000) });
    const linkHeader = res.headers.get("Link");
    let body: T;
    try {
      body = (await res.json()) as T;
    } catch {
      // Non-JSON error bodies (e.g. an HTML 404 page): surface the status with an empty body.
      body = undefined as unknown as T;
    }
    // Extract a human-readable reason from JSON error bodies (GitLab's `error_description`,
    // GitHub-style `message`/`error`) so notices explain *why* the request failed.
    const message = res.status >= 400 ? describeError(body) : undefined;
    return { status: res.status, body, linkHeader, message };
  }
}

/** Build a path with query params appended (values are stringified; null/undefined skipped). */
export function withQuery(path: string, params?: Record<string, string | number | boolean | null | undefined>): string {
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
 * Used by adapters whose list endpoints page via `rel="next"`. A safety cap
 * aborts a cyclic or broken Link header instead of looping forever.
 */
const MAX_PAGES = 100;

export async function paginateAll(
  transport: HttpTransport,
  url: string,
  headers: Record<string, string>,
): Promise<unknown[]> {
  // Determine the approved origin from the initial URL (the provider's configured base or first list URL).
  let baseOrigin: string;
  try {
    baseOrigin = new URL(url).origin;
  } catch {
    // If the initial URL is somehow invalid, refuse to paginate rather than guess.
    throw new Error(`invalid pagination base url (${redactUrl(url)})`);
  }

  const acc: unknown[] = [];
  let next: string | null = url;
  let pages = 0;
  while (next) {
    if (++pages > MAX_PAGES) throw new Error(`provider pagination exceeded ${MAX_PAGES} pages — aborting (${redactUrl(url)})`);

    // Gate headers: only send auth-bearing headers to the approved origin.
    let sendHeaders = headers;
    try {
      if (new URL(next).origin !== baseOrigin) {
        // Cross-origin next link — drop token-bearing headers; keep Accept for JSON negotiation.
        const { Accept, accept, ...rest } = headers as any;
        sendHeaders = Accept || accept ? { Accept: (Accept || accept) as string } : {};
      }
    } catch {
      // Unparseable next URL — do not forward headers.
      sendHeaders = {};
    }

    const res = await transport.get<unknown>(next, { headers: sendHeaders });
    // Neutral wording + redacted URL in the message.
    if (res.status >= 400) throw new Error(`provider API ${res.status} error paginating${res.message ? ` — ${res.message}` : ""} (${redactUrl(next)})`);
    if (Array.isArray(res.body)) acc.push(...(res.body as unknown[]));

    // Only follow next links that are same-origin with the initial base (or safely resolvable relative to it).
    // Resolve relative links against the URL we just fetched for correctness on providers that emit relative nexts.
    const candidate = safeExtractNextLink(res.linkHeader, next);
    next = candidate;
  }
  return acc;
}

/** Pull a human-readable error message from a parsed API error body (GitLab/GitHub-style). */
export function describeError(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const key of ["error_description", "message", "error"]) {
      const v = b[key];
      if (typeof v === "string" && v.length) return v;
    }
  }
  return undefined;
}

/** Extract the `rel="next"` URL from a raw `Link` header value. */
export function extractNextLink(link: string | null | undefined): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    // Standard Link header format: `<https://host/page>; rel="next"`
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * Redact userinfo, tokens, and Authorization-like material from a URL or message.
 * Safe for logs and error strings (C04).
 */
export function redactUrl(u: string): string {
  if (!u) return u;
  // user:pass@ or token@ in URL authority
  let s = u.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\/\s@]+@([^\s]+)/g, "$1<redacted>@$2");
  // token query params commonly seen in provider pagination
  s = s.replace(/([?&](?:token|access_token|private_token|auth|key)=)[^&\s]+/gi, "$1<redacted>");
  return s;
}

/**
 * Resolve and validate a raw next URL (bare string or extracted from Link) against an approved origin.
 * Relative URLs are resolved against `base` (which should be the current page URL for correctness).
 * Only http(s) same-origin results are returned; javascript:, data:, protocol-relative, or cross-origin are rejected.
 */
export function safeResolveNext(rawNext: string | null | undefined, base: string): string | null {
  if (!rawNext) return null;
  let candidate: string;
  try {
    candidate = new URL(rawNext, base).toString();
  } catch {
    return null;
  }
  try {
    if (!/^https?:$/.test(new URL(candidate).protocol)) return null;
  } catch {
    return null;
  }
  let baseOrigin: string;
  try {
    baseOrigin = new URL(base).origin;
  } catch {
    return null;
  }
  let candOrigin: string;
  try {
    candOrigin = new URL(candidate).origin;
  } catch {
    return null;
  }
  if (candOrigin === baseOrigin) return candidate;
  return null;
}

/**
 * Safely extract a `rel="next"` URL and validate it against an approved origin.
 * Only absolute http(s) URLs are accepted. Relative links are resolved against `base`.
 * Returns null for any cross-origin, javascript:, data:, or protocol-relative result.
 * `base` should be the provider's configured API base or the current page URL.
 */
export function safeExtractNextLink(link: string | null | undefined, base: string): string | null {
  const raw = extractNextLink(link);
  return safeResolveNext(raw, base);
}

/**
 * Secure pagination that validates every next link against the configured base
 * and never forwards auth headers cross-origin. Redacts URLs in error messages.
 */
export async function paginateAllSafe(
  transport: HttpTransport,
  url: string,
  headers: Record<string, string>,
  baseForOrigin: string,
): Promise<unknown[]> {
  const acc: unknown[] = [];
  let next: string | null = url;
  let pages = 0;
  while (next) {
    if (++pages > MAX_PAGES) {
      throw new Error(`provider pagination exceeded ${MAX_PAGES} pages — aborting (${redactUrl(url)})`);
    }
    // Only forward auth headers when the URL is within the approved origin.
    const u = new URL(next);
    const baseOrigin = new URL(baseForOrigin).origin;
    const sendHeaders = u.origin === baseOrigin ? headers : { Accept: headers.Accept || "application/json" };
    const res = await transport.get<unknown>(next, { headers: sendHeaders });
    if (res.status >= 400) {
      throw new Error(`provider API ${res.status} error paginating${res.message ? ` — ${res.message}` : ""} (${redactUrl(next)})`);
    }
    if (Array.isArray(res.body)) acc.push(...(res.body as unknown[]));
    // Resolve relative links against the current page URL.
    const candidate = safeExtractNextLink(res.linkHeader, next);
    next = candidate;
  }
  return acc;
}
