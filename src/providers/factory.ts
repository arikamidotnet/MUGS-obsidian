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
}

/** Public-API base URLs per backend. GitLab's already includes its `/api/v4` prefix. */
const DEFAULT_BASE_URL: Record<Exclude<ProviderKind, "local">, string> = {
  github: "https://api.github.com",
  gitlab: "https://gitlab.com/api/v4",
  bitbucket: "https://api.bitbucket.org",
  gitea: "https://gitea.com/api/v1",
  forgejo: "https://forgejo.example.com/api/v1", // self-hosted; user should set baseUrl
};

/** Build the `Provider` for a credential. Throws for `local` (no REST adapter). */
export function buildProvider(input: ProviderInput, opts: { transport?: HttpTransport; actingUsername?: string } = {}): Provider {
  const kind = input.kind;
  if (kind === "local") {
    throw new Error("The 'local' provider has no REST adapter — it syncs an existing local clone directly.");
  }
  const baseUrl = input.baseUrl?.trim() || DEFAULT_BASE_URL[kind];
  const token = input.token ?? "";

  // Share the injected transport (tests) when present; providers fall back to
  // global fetch otherwise.
  const shared = { transport: opts.transport };
  switch (kind) {
    case "gitlab":
      return new GitLabProvider({ baseUrl, token, ...shared });
    case "github":
      return new GitHubProvider({ baseUrl, token, ...shared });
    case "gitea":
    case "forgejo":
      return new GiteaProvider({ baseUrl, token, kind: kind as GiteaKind, ...shared });
    case "bitbucket":
      return new BitbucketProvider({ baseUrl, token, actingUsername: opts.actingUsername, ...shared });
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown provider kind: ${String(_exhaustive)}`);
    }
  }
}

/** Convenience: build a provider from a full stored credential, resolving its username as the acting user. */
export function providerFromCredential(credential: Pick<Credential, "id" | "kind" | "baseUrl" | "username"> & { token: string }, opts: { transport?: HttpTransport } = {}): Provider {
  return buildProvider({ kind: credential.kind, baseUrl: credential.baseUrl, token: credential.token }, { ...opts, actingUsername: credential.username });
}
