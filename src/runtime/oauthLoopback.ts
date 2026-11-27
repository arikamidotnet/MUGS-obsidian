/**
 * MUGS — loopback OAuth 2.0 callback server (`127.0.0.1`).
 *
 * Binds a temporary Node `http.Server` strictly to `127.0.0.1` so GitLab's
 * Authorization Code + PKCE flow works universally on Linux (including minimal
 * Arch/Wayland WMs without XDG `obsidian://` URI registration), macOS, and Windows.
 *
 * Guarantees:
 * - Binds strictly to `127.0.0.1` (never `0.0.0.0`).
 * - Validates CSRF `state` before accepting any `code`.
 * - Shuts down the server and clears timers/listeners unconditionally in `finally`
 *   (calling `closeAllConnections` so browser keep-alive sockets never leak).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface LoopbackOAuthOptions {
  /** Full GitLab `/oauth/authorize?...` URL to open in the user's browser. */
  authorizeUrl: string;
  /** Exact loopback redirect URI registered on the GitLab OAuth application. */
  redirectUri: string;
  /** Expected CSRF `state` parameter generated alongside PKCE. */
  expectedState: string;
  /** Opens `authorizeUrl` in the system browser. */
  openBrowser: (url: string) => void | Promise<void>;
  /** Maximum time to wait for the user to finish browser sign-in (default 3 min). */
  timeoutMs?: number;
  /** Optional abort signal (e.g. Cancel button or plugin unload). */
  signal?: AbortSignal;
  /** Optional callback fired once bound (receives actual `http://127.0.0.1:<port><path>`). */
  onListening?: (actualRedirectUri: string) => void;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;line-height:1.5;color:#222}` +
    `h1{font-size:1.25rem;margin-bottom:8px}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

/** Run one loopback OAuth callback round-trip and return the validated authorization `code`. */
export async function runLoopbackOAuth(opts: LoopbackOAuthOptions): Promise<{ code: string }> {
  let parsed: URL;
  try {
    parsed = new URL(opts.redirectUri);
  } catch {
    throw new Error("Invalid OAuth redirect URI");
  }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")) {
    throw new Error("OAuth redirect URI must use http://127.0.0.1 or http://localhost");
  }
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("OAuth redirect URI has an invalid port");
  }
  const expectedPath = parsed.pathname || "/";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (opts.signal?.aborted) {
    throw new Error("GitLab sign-in cancelled");
  }

  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (onAbort && opts.signal) {
      opts.signal.removeEventListener("abort", onAbort);
      onAbort = undefined;
    }
    if (server) {
      const s = server;
      server = undefined;
      try {
        s.closeAllConnections?.();
        s.close();
      } catch {
        // already closed
      }
    }
  };

  return new Promise<{ code: string }>((resolve, reject) => {
    let settled = false;
    const finishOk = (code: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code });
    };
    const finishErr = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (reqUrl.pathname !== expectedPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("Not found");
        return;
      }

      const error = reqUrl.searchParams.get("error");
      const errorDesc = reqUrl.searchParams.get("error_description");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(htmlPage("GitLab sign-in cancelled", "Authorization was denied or cancelled. You can close this tab and return to Obsidian."));
        finishErr(new Error(`GitLab sign-in denied: ${errorDesc || error}`));
        return;
      }

      const state = reqUrl.searchParams.get("state");
      if (state !== opts.expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(htmlPage("Invalid sign-in state", "The sign-in state did not match. Close this tab and retry from Obsidian."));
        finishErr(new Error("GitLab sign-in failed: OAuth state mismatch"));
        return;
      }

      const code = reqUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(htmlPage("Missing authorization code", "GitLab did not return an authorization code. Close this tab and retry from Obsidian."));
        finishErr(new Error("GitLab sign-in failed: missing authorization code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(htmlPage("Signed in to MUGS", "GitLab authorization succeeded. You can return to Obsidian and close this tab."));
      finishOk(code);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finishErr(new Error(`Port ${port} is already in use — close any other MUGS sign-in in progress and try again`));
      } else {
        finishErr(new Error(`Could not start local sign-in callback server: ${err.message}`));
      }
    });

    if (opts.signal) {
      onAbort = () => finishErr(new Error("GitLab sign-in cancelled"));
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finishErr(new Error("GitLab sign-in timed out — try again from Settings → MUGS → Accounts"));
      }, timeoutMs);
    }

    server.listen(port, "127.0.0.1", () => {
      if (settled || !server) return;
      const addr = server.address() as AddressInfo | null;
      const boundPort = addr?.port ?? port;
      opts.onListening?.(`http://127.0.0.1:${boundPort}${expectedPath}`);
      Promise.resolve(opts.openBrowser(opts.authorizeUrl)).catch((err) => {
        finishErr(new Error(`Could not open browser for GitLab sign-in: ${err instanceof Error ? err.message : String(err)}`));
      });
    });
  });
}
