/**
 * MUGS — provider URL / branch helpers shared by the REST adapters.
 *
 * Standalone (no import of any concrete adapter) so both `factory.ts` and the
 * per-backend providers can use it without a circular import. Used to synthesize
 * a working {@link RepoSummary} for explicitly-allowed repos that are never
 * fetched from a global enumeration endpoint (`/projects`, `/user/repos`).
 */
import type { BranchSummary } from "./types";

/**
 * Build an HTTPS git clone URL for a repository path on a given API base URL.
 *
 * Strips the trailing REST-api path segment (`/api`, `/api/vN`, `/2.0`) and the
 * public `api.` subdomain (github.com / bitbucket.org expose REST under `api.*`
 * but clone from the bare host), then appends `.git`.
 */
export function cloneUrlFor(baseUrl: string, pathWithNamespace: string): string {
  let root = baseUrl.replace(/\/+$/, "");
  root = root.replace(/\/(?:api|2\.0)(?:\/v\d+)?$/, "");
  root = root.replace(/^https?:\/\/api\./i, "https://");
  return `${root}/${pathWithNamespace}.git`;
}

/** Pick the default branch name from a provider's branch list (flagged default, else first). */
export function resolveDefaultBranch(branches: BranchSummary[]): string {
  return branches.find((b) => b.default)?.name ?? branches[0]?.name ?? "";
}
