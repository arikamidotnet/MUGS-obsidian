import { describe, it, expect, vi } from "vitest";
import { OAuthTokenManager, type OAuthStoreLike } from "./oauthRefresh";
import { OAuthRefreshError, type OAuthTokenBundle } from "../providers/gitlabOAuth";

function fakeOAuthStore(opts: {
  authMode?: "token" | "oauth";
  bundle?: OAuthTokenBundle;
  plainToken?: string;
}) {
  let bundle = opts.bundle;
  const expired = new Set<string>();
  let saveCalls = 0;
  const store: OAuthStoreLike & { saveCalls: () => number; isExpired: (id: string) => boolean; currentBundle: () => OAuthTokenBundle | undefined } = {
    getSettings: () => ({
      credentials: [
        {
          id: "c1",
          kind: "gitlab",
          baseUrl: "https://gitlab.com/api/v4",
          authMode: opts.authMode ?? "oauth",
          oauth: opts.authMode === "token"
            ? undefined
            : { clientId: "app-1", redirectUri: "http://127.0.0.1:47291/callback", expiresAt: bundle?.expiresAt },
        },
      ],
    }),
    getToken: () => opts.plainToken ?? bundle?.accessToken,
    getOAuthBundle: () => bundle,
    setOAuthBundle: (_id, next) => { bundle = next; },
    markOAuthExpired: (id) => { expired.add(id); },
    save: async () => { saveCalls += 1; return { ok: true }; },
    saveCalls: () => saveCalls,
    isExpired: (id) => expired.has(id),
    currentBundle: () => bundle,
  };
  return store;
}

describe("OAuthTokenManager — single-flight rotating refresh", () => {
  it("passes non-OAuth credentials straight through without calling refresh", async () => {
    const store = fakeOAuthStore({ authMode: "token", plainToken: "glpat-123" });
    const refresh = vi.fn();
    const mgr = new OAuthTokenManager(store, refresh);
    expect(await mgr.resolveAccessToken("c1")).toBe("glpat-123");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("returns the current access token without refreshing when not yet near expiry", async () => {
    const now = 1_000_000;
    const store = fakeOAuthStore({
      bundle: { accessToken: "acc-fresh", refreshToken: "ref-1", expiresAt: now + 600_000 },
    });
    const refresh = vi.fn();
    const mgr = new OAuthTokenManager(store, refresh, { now: () => now, skewMs: 120_000 });
    expect(await mgr.resolveAccessToken("c1")).toBe("acc-fresh");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("deduplicates 5 concurrent refreshes into 1 HTTP call and persists the rotated bundle once", async () => {
    const now = 1_000_000;
    const store = fakeOAuthStore({
      bundle: { accessToken: "acc-old", refreshToken: "ref-1", expiresAt: now + 30_000 },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const refresh = vi.fn(async () => {
      await gate;
      return { accessToken: "acc-rotated", refreshToken: "ref-2", expiresAt: now + 7_200_000 };
    });
    const mgr = new OAuthTokenManager(store, refresh, { now: () => now, skewMs: 120_000 });

    const calls = Promise.all([
      mgr.resolveAccessToken("c1"),
      mgr.resolveAccessToken("c1"),
      mgr.resolveAccessToken("c1"),
      mgr.resolveAccessToken("c1"),
      mgr.resolveAccessToken("c1"),
    ]);
    release();
    const results = await calls;

    expect(results).toEqual(["acc-rotated", "acc-rotated", "acc-rotated", "acc-rotated", "acc-rotated"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.saveCalls()).toBe(1);
    expect(store.currentBundle()?.refreshToken).toBe("ref-2");
  });

  it("marks credential expired and returns undefined on invalid_grant", async () => {
    const now = 1_000_000;
    const store = fakeOAuthStore({
      bundle: { accessToken: "acc-old", refreshToken: "ref-revoked", expiresAt: now - 1000 },
    });
    const refresh = vi.fn(async () => {
      throw new OAuthRefreshError("revoked", { invalidGrant: true, status: 400 });
    });
    const mgr = new OAuthTokenManager(store, refresh, { now: () => now });

    expect(await mgr.resolveAccessToken("c1")).toBeUndefined();
    expect(store.isExpired("c1")).toBe(true);
    expect(store.saveCalls()).toBe(0);
  });

  it("rethrows transient 503 errors without invalidating the grant", async () => {
    const now = 1_000_000;
    const store = fakeOAuthStore({
      bundle: { accessToken: "acc-old", refreshToken: "ref-1", expiresAt: now - 1000 },
    });
    const refresh = vi.fn(async () => {
      throw new OAuthRefreshError("503 unavailable", { invalidGrant: false, status: 503 });
    });
    const mgr = new OAuthTokenManager(store, refresh, { now: () => now });

    await expect(mgr.resolveAccessToken("c1")).rejects.toThrow(/503/);
    expect(store.isExpired("c1")).toBe(false);
    expect(store.currentBundle()?.refreshToken).toBe("ref-1");
  });
});
