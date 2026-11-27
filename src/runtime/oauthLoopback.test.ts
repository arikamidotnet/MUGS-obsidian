import { describe, it, expect } from "vitest";
import { runLoopbackOAuth } from "./oauthLoopback";

describe("oauthLoopback — 127.0.0.1 callback server", () => {
  it("resolves the authorization code when state matches and shuts down cleanly", async () => {
    let listeningUri = "";
    const promise = runLoopbackOAuth({
      authorizeUrl: "https://gitlab.com/oauth/authorize?state=good-state",
      redirectUri: "http://127.0.0.1:0/callback",
      expectedState: "good-state",
      onListening: (uri) => { listeningUri = uri; },
      openBrowser: async () => {
        const res = await fetch(`${listeningUri}?code=auth-code-123&state=good-state`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("Signed in to MUGS");
      },
    });
    await expect(promise).resolves.toEqual({ code: "auth-code-123" });
  });

  it("rejects on CSRF state mismatch with 400", async () => {
    let listeningUri = "";
    const promise = runLoopbackOAuth({
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      redirectUri: "http://127.0.0.1:0/callback",
      expectedState: "expected-state",
      onListening: (uri) => { listeningUri = uri; },
      openBrowser: async () => {
        const res = await fetch(`${listeningUri}?code=abc&state=wrong-state`);
        expect(res.status).toBe(400);
      },
    });
    await expect(promise).rejects.toThrow(/state mismatch/i);
  });

  it("rejects with the provider error when user denies authorization", async () => {
    let listeningUri = "";
    const promise = runLoopbackOAuth({
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      redirectUri: "http://127.0.0.1:0/callback",
      expectedState: "st-1",
      onListening: (uri) => { listeningUri = uri; },
      openBrowser: async () => {
        const res = await fetch(`${listeningUri}?error=access_denied&error_description=User+denied`);
        expect(res.status).toBe(400);
      },
    });
    await expect(promise).rejects.toThrow(/User denied/i);
  });

  it("cancels cleanly via AbortSignal", async () => {
    const controller = new AbortController();
    const promise = runLoopbackOAuth({
      authorizeUrl: "https://gitlab.com/oauth/authorize",
      redirectUri: "http://127.0.0.1:0/callback",
      expectedState: "st-2",
      signal: controller.signal,
      openBrowser: () => {
        controller.abort();
      },
    });
    await expect(promise).rejects.toThrow(/cancelled/i);
  });
});
