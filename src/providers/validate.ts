/**
 * MUGS — credential form validation ("static analysis").
 *
 * Pure, Obsidian-free checks for the values a user types into the add-account
 * form: the API base URL, the allowed-repo slugs, and the local repository path.
 * Everything here is synchronous and offline — the optional live "Test
 * connection" probe lives in the settings tab and reuses the provider adapters.
 *
 * Problems are structured (field + level + kind) so the UI can show them inline
 * under the right row, style errors vs warnings differently, and keep
 * required-field noise hidden until the user actually submits the form.
 */
import type { ProviderKind } from "../types";
import { providerOption } from "./factory";

/** Which credential-form field a problem belongs to. */
export type CredentialField = "label" | "token" | "baseUrl" | "repos" | "localPath";

/** `error` blocks adding the account; `warn` is advisory and never blocks. */
export type ProblemLevel = "error" | "warn";

/** `required` problems stay hidden until the user submits; `format` ones show as they type. */
export type ProblemKind = "required" | "format";

export interface FieldProblem {
  field: CredentialField;
  level: ProblemLevel;
  kind: ProblemKind;
  message: string;
}

/** The values the add-account form collects. */
export interface CredentialFormInput {
  kind: ProviderKind;
  label: string;
  token: string;
  baseUrl: string;
  repos: string[];
}

/** Known SaaS hosts whose website URL is a common mistake for the API endpoint. */
interface SaasHostRule {
  host: string;
  /** API path that must be present for this host, when it is not the bare host. */
  requiredPath?: string;
  /** The endpoint the user probably meant. */
  suggestion: string;
}

const SAAS_HOSTS: Partial<Record<ProviderKind, SaasHostRule>> = {
  github: { host: "github.com", suggestion: "https://api.github.com" },
  gitlab: { host: "gitlab.com", requiredPath: "/api/v4", suggestion: "https://gitlab.com/api/v4" },
  bitbucket: { host: "bitbucket.org", suggestion: "https://api.bitbucket.org" },
  gitea: { host: "gitea.com", requiredPath: "/api/v1", suggestion: "https://gitea.com/api/v1" },
};

const problem = (field: CredentialField, level: ProblemLevel, kind: ProblemKind, message: string): FieldProblem => ({
  field,
  level,
  kind,
  message,
});

/**
 * Validate a provider's API base URL (or the local `file://` repository path).
 * Returns `null` when the value is acceptable — including an empty hosted value,
 * which falls back to the provider's default endpoint in `buildProvider`.
 */
export function validateBaseUrl(kind: ProviderKind, raw: string): FieldProblem | null {
  const value = raw.trim();

  if (kind === "local") {
    if (!value) {
      return problem("localPath", "error", "required", "Enter the repository path as file:///absolute/path/to/repo.git.");
    }
    if (!/^file:\/\//i.test(value)) {
      return problem("localPath", "error", "format", "Local repositories need a file:// URL, e.g. file:///absolute/path/to/repo.git.");
    }
    const path = value.replace(/^file:\/\//i, "").replace(/\/+$/, "");
    if (!path || path === ".") {
      return problem("localPath", "error", "format", "The file:// URL must point at a repository directory.");
    }
    return null;
  }

  if (!value) {
    const option = providerOption(kind);
    // Self-hosted-only providers have no default endpoint to fall back on.
    if (option?.selfHostedOnly) {
      return problem("baseUrl", "error", "required", `Enter your ${option.label} API endpoint (e.g. ${option.endpointHint}).`);
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem("baseUrl", "error", "format", "That is not a valid URL — include the scheme, e.g. https://host/api.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return problem("baseUrl", "error", "format", "Use an http(s) endpoint.");
  }

  const rule = SAAS_HOSTS[kind];
  if (rule && url.hostname.toLowerCase() === rule.host) {
    const path = url.pathname.replace(/\/+$/, "");
    if (rule.requiredPath) {
      if (path !== rule.requiredPath) {
        return problem("baseUrl", "warn", "format", `The ${providerOption(kind)?.label ?? kind} API endpoint looks like ${rule.suggestion}.`);
      }
    } else {
      return problem("baseUrl", "warn", "format", `Use the API host ${rule.suggestion}, not the website URL.`);
    }
  }

  return null;
}

/**
 * Validate one `owner/repo` (or `group/sub/repo`) slug for a provider. Empty is
 * allowed (allowed-repos is optional). `local` has no repo slugs.
 */
export function validateRepoSlug(kind: ProviderKind, raw: string): FieldProblem | null {
  const value = raw.trim();
  if (!value || kind === "local") return null;

  const reject = (message: string): FieldProblem => problem("repos", "error", "format", message);

  if (/\s/.test(value)) return reject("Remove spaces from the repository path.");
  if (value.startsWith("/") || value.endsWith("/")) {
    return reject("Repository paths have no leading or trailing slash (e.g. owner/repo).");
  }
  const segments = value.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return reject("Repository paths must be owner/repo with no empty or relative segments.");
  }
  // GitLab allows nested groups (group/sub/repo); the other hosted backends are owner/repo.
  if (segments.length < 2) {
    return reject("Use owner/repo (one slash).");
  }
  if (kind !== "gitlab" && segments.length > 2) {
    return reject(`Use exactly owner/repo for ${providerOption(kind)?.label ?? kind}.`);
  }
  return null;
}

/** Validate every allowed-repo slug, returning one problem per bad entry. */
export function validateRepoList(kind: ProviderKind, repos: readonly string[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const repo of repos) {
    const p = validateRepoSlug(kind, repo);
    if (p) problems.push({ ...p, message: `"${repo.trim()}": ${p.message}` });
  }
  return problems;
}

/**
 * Validate the whole add-account form. Returns every problem found; the caller
 * decides which to surface (e.g. hiding `required` ones until submit).
 */
export function validateCredentialForm(input: CredentialFormInput): FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (!input.label.trim()) {
    problems.push(problem("label", "error", "required", "A label is required."));
  }
  if (input.kind !== "local" && !input.token) {
    problems.push(problem("token", "error", "required", "A token is required for a hosted account."));
  }
  const base = validateBaseUrl(input.kind, input.baseUrl);
  if (base) problems.push(base);
  problems.push(...validateRepoList(input.kind, input.repos));

  return problems;
}

/** True when any problem would block adding the account. */
export function hasBlockingProblem(problems: readonly FieldProblem[]): boolean {
  return problems.some((p) => p.level === "error");
}
