/**
 * MUGS — provider factory.
 *
 * Turns a persisted {@link Credential} into a concrete `Provider` adapter, so the
 * sync driver and any other caller construct backends through one path instead of
 * repeating the kind switch. The token is resolved by the caller (the store
 * decrypts it when needed); this factory only wires baseUrl + token (+ optional
 * transport/acting-username for tests). Kept free of Obsidian so it stays
 * unit-testable with a fake transport.
 */
import type { ProviderKind } from "../types";
import type { Credential } from "../types";
import type { Provider } from "./types";
import type { HttpTransport } from "./http";
import { GitLabProvider } from "./gitlab";
import { GitHubProvider } from "./github";
import { GiteaProvider, type GiteaKind } from "./gitea";
import { BitbucketProvider } from "./bitbucket";

/** Inputs needed to build a provider. `token` may be absent (caller decides). */
export interface ProviderInput {
  kind: ProviderKind;
  /** API base URL; when omitted the per-kind default below is used. */
  baseUrl?: string;
  /** Resolved token (already decrypted by the store, or plaintext from the form). */
  token?: string;
  /**
   * Explicit allowed repos (`owner/repo`). When non-empty, the provider returns
   * these directly from `listRepos()` instead of calling a global enumeration
   * endpoint — for fine-grained tokens scoped to specific projects only.
   */
  allowedRepos?: string[];
}

/** Public-API base URLs per backend. GitLab's already includes its `/api/v4` prefix. */
const DEFAULT_BASE_URL: Record<Exclude<ProviderKind, "local">, string> = {
  github: "https://api.github.com",
  gitlab: "https://gitlab.com/api/v4",
  bitbucket: "https://api.bitbucket.org",
  gitea: "https://gitea.com/api/v1",
  forgejo: "https://forgejo.example.com/api/v1", // self-hosted; user should set baseUrl
};

/**
 * Public-API base URL used to prefill the credential form for each backend.
 * `local` has no REST API, so it returns "" (the field is left blank).
 */
export function defaultBaseUrl(kind: ProviderKind): string {
  return kind === "local" ? "" : DEFAULT_BASE_URL[kind];
}

/**
 * Build an HTTPS git clone URL for a repository path on a given API base URL.
 *
 * Strips the trailing REST-api path segment (`/api`, `/api/vN`, `/2.0`) and the
 * public `api.` subdomain (github.com / bitbucket.org expose REST under `api.*`
 * but clone from the bare host), then appends `.git`. Used to synthesize a working
 * clone URL for explicitly-allowed repos that are never fetched from an endpoint.
 */
export function cloneUrlFor(baseUrl: string, pathWithNamespace: string): string {
  let root = baseUrl.replace(/\/+$/, "");
  root = root.replace(/\/(?:api|2\.0)(?:\/v\d+)?/, "");
  root = root.replace(/^https?:\/\/api\./i, "https://");
  return `${root}/${pathWithNamespace}.git`;
}

/** Build the `Provider` for a credential. Throws for `local` (no REST adapter). */
export function buildProvider(input: ProviderInput, opts: { transport?: HttpTransport; actingUsername?: string } = {}): Provider {
  const kind = input.kind;
  if (kind === "local") {
    throw new Error("The 'local' provider has no REST adapter — it syncs an existing local clone directly.");
  }
  const baseUrl = input.baseUrl?.trim() || DEFAULT_BASE_URL[kind];
  const token = input.token ?? "";
  const allowedRepos = input.allowedRepos;

  // Share the injected transport (tests) when present; providers fall back to
  // global fetch otherwise.
  const shared = { transport: opts.transport };
  switch (kind) {
    case "gitlab":
      return new GitLabProvider({ baseUrl, token, allowedRepos, ...shared });
    case "github":
      return new GitHubProvider({ baseUrl, token, allowedRepos, ...shared });
    case "gitea":
    case "forgejo":
      return new GiteaProvider({ baseUrl, token, kind: kind as GiteaKind, allowedRepos, ...shared });
    case "bitbucket":
      return new BitbucketProvider({ baseUrl, token, actingUsername: opts.actingUsername, allowedRepos, ...shared });
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown provider kind: ${String(_exhaustive)}`);
    }
  }
}

/** Convenience: build a provider from a full stored credential, resolving its username as the acting user. */
export function providerFromCredential(credential: Pick<Credential, "id" | "kind" | "baseUrl" | "username"> & { token: string; repos?: string[] }, opts: { transport?: HttpTransport } = {}): Provider {
  return buildProvider({ kind: credential.kind, baseUrl: credential.baseUrl, token: credential.token, allowedRepos: credential.repos }, { ...opts, actingUsername: credential.username });
}
