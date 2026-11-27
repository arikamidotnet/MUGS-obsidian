/**
 * MUGS — single-flight OAuth 2.0 token refresh coordinator.
 *
 * GitLab OAuth access tokens expire after 2 hours and refresh tokens are
 * single-use rotating: two concurrent refreshes for the same credential would
 * race and invalidate the grant. This coordinator serializes refreshes per
 * `credentialId`, persists the rotated bundle to the store BEFORE returning,
 * and distinguishes permanent grant revocation (`invalidGrant`) from transient
 * network/5xx errors (which leave the refresh token intact for retry).
 */
import {
  DEFAULT_OAUTH_REDIRECT_URI,
  gitlabOriginFromBaseUrl,
  isOAuthTokenExpiring,
  type OAuthTokenBundle,
} from "../providers/gitlabOAuth";

export interface OAuthCredentialLike {
  id: string;
  kind: string;
  baseUrl?: string;
  authMode?: "token" | "oauth";
  oauth?: {
    clientId: string;
    redirectUri: string;
    expiresAt?: number;
    scope?: string;
  };
}

export interface OAuthStoreLike {
  getSettings(): { credentials: OAuthCredentialLike[] };
  getToken(id: string): string | undefined;
  getOAuthBundle?(id: string): OAuthTokenBundle | undefined;
  setOAuthBundle?(id: string, bundle: OAuthTokenBundle): void;
  markOAuthExpired?(id: string): void;
  save(): Promise<{ ok: boolean }>;
}

export type OAuthRefresher = (input: {
  origin: string;
  clientId: string;
  redirectUri: string;
  refreshToken: string;
}) => Promise<OAuthTokenBundle>;

export class OAuthTokenManager {
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly skewMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: OAuthStoreLike,
    private readonly refresh: OAuthRefresher,
    opts: { skewMs?: number; now?: () => number } = {},
  ) {
    this.skewMs = opts.skewMs ?? 120_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Resolve a ready-to-use access token for `credentialId`.
   *  - Non-OAuth credentials pass through synchronously to `store.getToken`.
   *  - Non-expiring OAuth tokens return immediately without network I/O.
   *  - Expiring OAuth tokens refresh once (single-flight per credential),
   *    persist the rotated bundle, and return the fresh `accessToken`. */
  async resolveAccessToken(credentialId: string): Promise<string | undefined> {
    const cred = this.store.getSettings().credentials.find((c) => c.id === credentialId);
    if (!cred || cred.authMode !== "oauth") {
      return this.store.getToken(credentialId);
    }

    const bundle = this.store.getOAuthBundle?.(credentialId);
    if (!bundle) {
      return this.store.getToken(credentialId);
    }

    if (!isOAuthTokenExpiring(bundle.expiresAt, this.now(), this.skewMs)) {
      return bundle.accessToken;
    }

    if (!bundle.refreshToken) {
      this.store.markOAuthExpired?.(credentialId);
      return undefined;
    }

    const existing = this.inFlight.get(credentialId);
    if (existing) return existing;

    const run = this.performRefresh(cred, bundle.refreshToken).finally(() => {
      if (this.inFlight.get(credentialId) === run) {
        this.inFlight.delete(credentialId);
      }
    });
    this.inFlight.set(credentialId, run);
    return run;
  }

  private async performRefresh(cred: OAuthCredentialLike, refreshToken: string): Promise<string | undefined> {
    const clientId = cred.oauth?.clientId;
    if (!clientId) {
      this.store.markOAuthExpired?.(cred.id);
      return undefined;
    }
    const origin = gitlabOriginFromBaseUrl(cred.baseUrl);
    const redirectUri = cred.oauth?.redirectUri || DEFAULT_OAUTH_REDIRECT_URI;
    try {
      const next = await this.refresh({ origin, clientId, redirectUri, refreshToken });
      // Persist the rotated refresh token BEFORE handing out the new access token
      // so a crash or restart never strands the credential on the spent token.
      this.store.setOAuthBundle?.(cred.id, next);
      await this.store.save();
      return next.accessToken;
    } catch (err) {
      if ((err as { invalidGrant?: boolean })?.invalidGrant === true) {
        this.store.markOAuthExpired?.(cred.id);
        return undefined;
      }
      // Transient network/5xx failure: keep the refresh token intact and let the caller retry.
      throw err;
    }
  }
}
