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

/**
 * Display + endpoint metadata for one backend, defined once so the credential
 * dropdown, the endpoint autofill and the validator all read the same list
 * (instead of each hard-coding its own copy).
 */
export interface ProviderOption {
  kind: ProviderKind;
  /** Human-facing label for dropdowns. */
  label: string;
  /** Fallback API base URL used when a credential has none (buildProvider). */
  defaultBaseUrl: string;
  /** Value prefilled into the credential form. "" when the provider has no
   *  canonical SaaS endpoint and the user must supply their own instance. */
  prefillBaseUrl: string;
  /** Short placeholder describing the expected endpoint. */
  endpointHint: string;
  /** True when the provider is always self-hosted (no SaaS default to prefill). */
  selfHostedOnly: boolean;
}

/** Single source of truth for provider labels, endpoints and form prefill values. */
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    kind: "gitlab",
    label: "GitLab",
    defaultBaseUrl: "https://gitlab.com/api/v4",
    prefillBaseUrl: "https://gitlab.com/api/v4",
    endpointHint: "https://gitlab.com/api/v4",
    selfHostedOnly: false,
  },
  {
    kind: "github",
    label: "GitHub",
    defaultBaseUrl: "https://api.github.com",
    prefillBaseUrl: "https://api.github.com",
    endpointHint: "https://api.github.com",
    selfHostedOnly: false,
  },
  {
    kind: "bitbucket",
    label: "Bitbucket",
    defaultBaseUrl: "https://api.bitbucket.org",
    prefillBaseUrl: "https://api.bitbucket.org",
    endpointHint: "https://api.bitbucket.org",
    selfHostedOnly: false,
  },
  {
    kind: "gitea",
    label: "Gitea",
    defaultBaseUrl: "https://gitea.com/api/v1",
    prefillBaseUrl: "https://gitea.com/api/v1",
    endpointHint: "https://gitea.com/api/v1",
    selfHostedOnly: false,
  },
  {
    kind: "forgejo",
    label: "Forgejo",
    defaultBaseUrl: "https://forgejo.example.com/api/v1", // self-hosted; user sets baseUrl
    prefillBaseUrl: "", // no SaaS endpoint — the user enters their instance
    endpointHint: "https://your-forgejo-host/api/v1",
    selfHostedOnly: true,
  },
  {
    kind: "local",
    label: "Local (existing clone)",
    defaultBaseUrl: "",
    prefillBaseUrl: "",
    endpointHint: "file:///absolute/path/to/repo.git",
    selfHostedOnly: false,
  },
];

/** Public-API base URLs per backend, derived from {@link PROVIDER_OPTIONS}. */
const DEFAULT_BASE_URL = Object.fromEntries(
  PROVIDER_OPTIONS.filter((o) => o.kind !== "local").map((o) => [o.kind, o.defaultBaseUrl]),
) as Record<Exclude<ProviderKind, "local">, string>;

/** Metadata for a provider kind, or undefined for an unknown kind. */
export function providerOption(kind: ProviderKind): ProviderOption | undefined {
  return PROVIDER_OPTIONS.find((o) => o.kind === kind);
}

/**
 * Public-API base URL used as the fallback when a credential has none.
 * `local` has no REST API, so it returns "".
 */
export function defaultBaseUrl(kind: ProviderKind): string {
  return kind === "local" ? "" : DEFAULT_BASE_URL[kind];
}

/**
 * Endpoint value prefilled into the credential form for a backend. Differs from
 * {@link defaultBaseUrl} only for self-hosted-only providers (Forgejo), which
 * prefill blank so the user must enter their own instance rather than a fake host.
 */
export function prefillBaseUrl(kind: ProviderKind): string {
  return providerOption(kind)?.prefillBaseUrl ?? "";
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
