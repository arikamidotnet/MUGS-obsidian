/**
 * MUGS — pure GitLab OAuth 2.0 (PKCE) protocol helpers.
 *
 * Dependency-free (Node `node:crypto` + `fetch` only, zero Obsidian imports),
 * so every step — PKCE generation, authorize URL construction, code exchange,
 * rotating refresh, expiry skew, and secret-bundle serialization — is unit-tested
 * with an injected POST transport.
 *
 * Least-privilege default scopes (`read_api write_repository read_user`):
 * enough to list repos/folders, read the acting username, and push/pull Git over
 * HTTPS without granting full `api` access to issues, MRs, or CI/CD.
 */
import { createHash, randomBytes } from "node:crypto";
import { describeError, FetchTransport, type HttpTransport } from "./http";

/** Minimal GitLab OAuth scopes needed by MUGS (read metadata + Git push/pull + username). */
export const OAUTH_SCOPES = "read_api write_repository read_user";

/** Default loopback redirect URI (exact-match compliant with GitLab Doorkeeper). */
export const DEFAULT_OAUTH_REDIRECT_URI = "http://127.0.0.1:47291/callback";

/** Prefix marking a serialized OAuth token bundle stored in the existing secret slot. */
export const OAUTH_SECRET_PREFIX = "mugs-oauth-v1:";

/** Secret OAuth token bundle persisted inside SecretStorage (or data.json fallback). */
export interface OAuthTokenBundle {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds when `accessToken` expires. */
  expiresAt?: number;
  scope?: string;
}

/** Injectable HTTP POST transport for OAuth token endpoints (tests inject fakes). */
export type OAuthPostTransport = (
  url: string,
  body: URLSearchParams,
) => Promise<{ status: number; body: unknown; message?: string }>;

/** Typed error thrown when refreshing a GitLab OAuth token fails. */
export class OAuthRefreshError extends Error {
  readonly invalidGrant: boolean;
  readonly status: number;

  constructor(message: string, opts: { invalidGrant: boolean; status: number }) {
    super(message);
    this.name = "OAuthRefreshError";
    this.invalidGrant = opts.invalidGrant;
    this.status = opts.status;
  }
}

/** Default form-encoded POST transport backed by global `fetch` with a 30s timeout. */
export const fetchOAuthPost: OAuthPostTransport = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  const message = res.status >= 400 ? describeError(parsed) : undefined;
  return { status: res.status, body: parsed, message };
};

/** Serialize an OAuth token bundle into the single-string secret slot. */
export function encodeOAuthSecret(bundle: OAuthTokenBundle): string {
  return `${OAUTH_SECRET_PREFIX}${JSON.stringify({
    accessToken: bundle.accessToken,
    ...(bundle.refreshToken ? { refreshToken: bundle.refreshToken } : {}),
    ...(bundle.expiresAt !== undefined ? { expiresAt: bundle.expiresAt } : {}),
    ...(bundle.scope ? { scope: bundle.scope } : {}),
  })}`;
}

/** Parse a stored secret string as an OAuth bundle, or return null for plain PATs. */
export function decodeOAuthSecret(raw: string | undefined): OAuthTokenBundle | null {
  if (!raw || !raw.startsWith(OAUTH_SECRET_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(OAUTH_SECRET_PREFIX.length)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" && parsed.refreshToken.length > 0 ? parsed.refreshToken : undefined,
      expiresAt: typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : undefined,
      scope: typeof parsed.scope === "string" && parsed.scope.length > 0 ? parsed.scope : undefined,
    };
  } catch {
    return null;
  }
}

/** Generate RFC 7636 PKCE verifier/challenge (S256) plus a random CSRF state token. */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string; state: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

/** Derive the GitLab host origin (e.g. `https://gitlab.com`) from an API base URL. */
export function gitlabOriginFromBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || "https://gitlab.com/api/v4";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://gitlab.com";
  }
}

/** Build the GitLab `/oauth/authorize` URL for Authorization Code + PKCE (S256). */
export function buildGitLabAuthorizeUrl(opts: {
  origin: string;
  clientId: string;
  redirectUri?: string;
  codeChallenge: string;
  state: string;
  scopes?: string;
}): string {
  const origin = opts.origin.replace(/\/+$/, "");
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI,
    response_type: "code",
    state: opts.state,
    scope: opts.scopes ?? OAUTH_SCOPES,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${origin}/oauth/authorize?${params.toString()}`;
}

/** Build a prefilled GitLab personal access token creation URL for one-click PAT setup. */
export function buildGitLabCreateTokenUrl(baseUrl?: string): string {
  const origin = gitlabOriginFromBaseUrl(baseUrl);
  const params = new URLSearchParams({
    name: "MUGS",
    scopes: "read_api,write_repository",
  });
  return `${origin}/-/user_settings/personal_access_tokens?${params.toString()}`;
}

/** True when an OAuth access token is expired or within `skewMs` (default 120s) of expiring. */
export function isOAuthTokenExpiring(
  expiresAt: number | undefined,
  nowMs = Date.now(),
  skewMs = 120_000,
): boolean {
  if (expiresAt === undefined) return false;
  return nowMs + skewMs >= expiresAt;
}

interface RawOAuthTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  created_at?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function parseTokenBundle(body: unknown, nowMs: number): OAuthTokenBundle {
  const b = (body && typeof body === "object" ? body : {}) as RawOAuthTokenResponse;
  if (typeof b.access_token !== "string" || !b.access_token) {
    throw new Error("GitLab OAuth response did not include an access_token");
  }
  const expiresIn = typeof b.expires_in === "number" && Number.isFinite(b.expires_in) && b.expires_in > 0
    ? b.expires_in
    : undefined;
  return {
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? nowMs + expiresIn * 1000 : undefined,
    scope: typeof b.scope === "string" && b.scope ? b.scope : undefined,
  };
}

/** Exchange an OAuth authorization code + PKCE verifier for access + refresh tokens. */
export async function exchangeGitLabCode(opts: {
  origin: string;
  clientId: string;
  redirectUri?: string;
  code: string;
  codeVerifier: string;
  post?: OAuthPostTransport;
  nowMs?: number;
}): Promise<OAuthTokenBundle> {
  const post = opts.post ?? fetchOAuthPost;
  const origin = opts.origin.replace(/\/+$/, "");
  const params = new URLSearchParams({
    client_id: opts.clientId,
    code: opts.code,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI,
    code_verifier: opts.codeVerifier,
  });
  const res = await post(`${origin}/oauth/token`, params);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitLab OAuth token exchange failed (${res.status})${res.message ? ` — ${res.message}` : ""}`);
  }
  return parseTokenBundle(res.body, opts.nowMs ?? Date.now());
}

/** Refresh an expiring GitLab OAuth access token using its single-use rotating refresh token. */
export async function refreshGitLabToken(opts: {
  origin: string;
  clientId: string;
  redirectUri?: string;
  refreshToken: string;
  post?: OAuthPostTransport;
  nowMs?: number;
}): Promise<OAuthTokenBundle> {
  const post = opts.post ?? fetchOAuthPost;
  const origin = opts.origin.replace(/\/+$/, "");
  const params = new URLSearchParams({
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
    grant_type: "refresh_token",
    redirect_uri: opts.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI,
  });
  const res = await post(`${origin}/oauth/token`, params);
  if (res.status < 200 || res.status >= 300) {
    const raw = (res.body && typeof res.body === "object" ? res.body : {}) as RawOAuthTokenResponse;
    const errText = [raw.error, raw.error_description, res.message].filter((v) => typeof v === "string").join(" ");
    const invalidGrant =
      (res.status === 400 || res.status === 401) &&
      (res.status === 401 || /invalid_grant|invalid_token|revoked/i.test(errText));
    throw new OAuthRefreshError(
      `GitLab OAuth token refresh failed (${res.status})${res.message ? ` — ${res.message}` : ""}`,
      { invalidGrant, status: res.status },
    );
  }
  return parseTokenBundle(res.body, opts.nowMs ?? Date.now());
}

/** Fetch the authenticated GitLab user's username (`GET /api/v4/user`) via Bearer OAuth token. */
export async function fetchGitLabUsername(opts: {
  baseUrl?: string;
  accessToken: string;
  transport?: HttpTransport;
}): Promise<string | undefined> {
  const transport = opts.transport ?? new FetchTransport();
  const base = (opts.baseUrl?.trim() || "https://gitlab.com/api/v4").replace(/\/+$/, "");
  try {
    const res = await transport.get<{ username?: unknown }>(`${base}/user`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${opts.accessToken}` },
    });
    if (res.status >= 200 && res.status < 300 && typeof res.body?.username === "string" && res.body.username) {
      return res.body.username;
    }
  } catch {
    // Non-fatal: username auto-fill degrades gracefully.
  }
  return undefined;
}
