import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  OAUTH_SCOPES,
  DEFAULT_OAUTH_REDIRECT_URI,
  OAUTH_SECRET_PREFIX,
  encodeOAuthSecret,
  decodeOAuthSecret,
  generatePkcePair,
  gitlabOriginFromBaseUrl,
  buildGitLabAuthorizeUrl,
  buildGitLabCreateTokenUrl,
  isOAuthTokenExpiring,
  exchangeGitLabCode,
  refreshGitLabToken,
  OAuthRefreshError,
  fetchGitLabUsername,
  type OAuthPostTransport,
} from "./gitlabOAuth";

describe("gitlabOAuth — PKCE, URLs, and bundle serialization", () => {
  it("generates a valid RFC 7636 S256 PKCE pair and random CSRF state", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(a.codeChallenge).toBe(createHash("sha256").update(a.codeVerifier).digest("base64url"));
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("derives host origins from API base URLs and builds authorize + create-token URLs", () => {
    expect(gitlabOriginFromBaseUrl()).toBe("https://gitlab.com");
    expect(gitlabOriginFromBaseUrl("https://git.company.internal/api/v4")).toBe("https://git.company.internal");

    const authUrl = new URL(buildGitLabAuthorizeUrl({
      origin: "https://git.company.internal/",
      clientId: "app-123",
      codeChallenge: "chal-abc",
      state: "st-xyz",
    }));
    expect(authUrl.origin).toBe("https://git.company.internal");
    expect(authUrl.pathname).toBe("/oauth/authorize");
    expect(authUrl.searchParams.get("client_id")).toBe("app-123");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(DEFAULT_OAUTH_REDIRECT_URI);
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("scope")).toBe(OAUTH_SCOPES);
    expect(authUrl.searchParams.get("code_challenge")).toBe("chal-abc");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("state")).toBe("st-xyz");

    const patUrl = new URL(buildGitLabCreateTokenUrl("https://git.company.internal/api/v4"));
    expect(patUrl.origin).toBe("https://git.company.internal");
    expect(patUrl.pathname).toBe("/-/user_settings/personal_access_tokens");
    expect(patUrl.searchParams.get("name")).toBe("MUGS");
    expect(patUrl.searchParams.get("scopes")).toBe("read_api,write_repository");
  });

  it("encodes and decodes OAuth secret bundles while returning null for plain PATs", () => {
    const bundle = { accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1_700_000_000_000, scope: OAUTH_SCOPES };
    const encoded = encodeOAuthSecret(bundle);
    expect(encoded.startsWith(OAUTH_SECRET_PREFIX)).toBe(true);
    expect(decodeOAuthSecret(encoded)).toEqual(bundle);
    expect(decodeOAuthSecret("glpat-plain-token")).toBeNull();
    expect(decodeOAuthSecret("")).toBeNull();
    expect(decodeOAuthSecret(`${OAUTH_SECRET_PREFIX}not-json`)).toBeNull();
  });

  it("evaluates expiry with the safety skew window", () => {
    const now = 1_000_000;
    expect(isOAuthTokenExpiring(undefined, now)).toBe(false);
    expect(isOAuthTokenExpiring(now + 300_000, now, 120_000)).toBe(false);
    expect(isOAuthTokenExpiring(now + 120_000, now, 120_000)).toBe(true);
    expect(isOAuthTokenExpiring(now - 1, now, 120_000)).toBe(true);
  });
});

describe("gitlabOAuth — token exchange, rotating refresh, and username lookup", () => {
  it("exchanges authorization code + PKCE verifier for a token bundle", async () => {
    let seenUrl = "";
    let seenBody = "";
    const post: OAuthPostTransport = async (url, body) => {
      seenUrl = url;
      seenBody = body.toString();
      return {
        status: 200,
        body: { access_token: "acc-new", refresh_token: "ref-new", expires_in: 7200, scope: OAUTH_SCOPES },
      };
    };

    const bundle = await exchangeGitLabCode({
      origin: "https://gitlab.com",
      clientId: "cid-1",
      code: "code-99",
      codeVerifier: "ver-99",
      post,
      nowMs: 1_000_000,
    });
    expect(seenUrl).toBe("https://gitlab.com/oauth/token");
    expect(seenBody).toContain("grant_type=authorization_code");
    expect(seenBody).toContain("code=code-99");
    expect(seenBody).toContain("code_verifier=ver-99");
    expect(bundle).toEqual({
      accessToken: "acc-new",
      refreshToken: "ref-new",
      expiresAt: 1_000_000 + 7_200_000,
      scope: OAUTH_SCOPES,
    });
  });

  it("refreshes a rotating token and classifies invalid_grant vs transient errors", async () => {
    const okPost: OAuthPostTransport = async () => ({
      status: 200,
      body: { access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600 },
    });
    const refreshed = await refreshGitLabToken({
      origin: "https://gitlab.com",
      clientId: "cid-1",
      refreshToken: "ref-1",
      post: okPost,
      nowMs: 2_000_000,
    });
    expect(refreshed.accessToken).toBe("acc-2");
    expect(refreshed.refreshToken).toBe("ref-2");
    expect(refreshed.expiresAt).toBe(2_000_000 + 3_600_000);

    const revokedPost: OAuthPostTransport = async () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "The provided authorization grant is invalid" },
      message: "The provided authorization grant is invalid",
    });
    await expect(refreshGitLabToken({
      origin: "https://gitlab.com",
      clientId: "cid-1",
      refreshToken: "ref-old",
      post: revokedPost,
    })).rejects.toSatisfy((err: unknown) => err instanceof OAuthRefreshError && err.invalidGrant === true && err.status === 400);

    const transientPost: OAuthPostTransport = async () => ({
      status: 503,
      body: { error: "temporarily_unavailable" },
      message: "temporarily_unavailable",
    });
    await expect(refreshGitLabToken({
      origin: "https://gitlab.com",
      clientId: "cid-1",
      refreshToken: "ref-1",
      post: transientPost,
    })).rejects.toSatisfy((err: unknown) => err instanceof OAuthRefreshError && err.invalidGrant === false && err.status === 503);
  });

  it("fetches the authenticated username using Authorization: Bearer", async () => {
    let authHeader = "";
    const username = await fetchGitLabUsername({
      baseUrl: "https://gitlab.com/api/v4",
      accessToken: "acc-live",
      transport: {
        get: async (_url, init) => {
          authHeader = init.headers.Authorization ?? "";
          return { status: 200, body: { username: "alice" } as never };
        },
      },
    });
    expect(authHeader).toBe("Bearer acc-live");
    expect(username).toBe("alice");
  });
});
