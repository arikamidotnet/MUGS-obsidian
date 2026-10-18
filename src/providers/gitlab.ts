/**
 * MUGS — GitLab provider adapter.
 *
 * Implements the abstract `Provider` contract (see src/providers/types.ts) for
 * gitlab.com and self-hosted GitLab, using the v4 REST API. Auth is a PAT via
 * the `PRIVATE-TOKEN` header with the `api` scope. Native snake_case JSON is
 * mapped into the host-agnostic contract schemas, then parsed — so this adapter
 * is correct when it satisfies the abstract interfaces, not just when it works
 * against one repo (the ADL principle).
 *
 * All HTTP goes through an injectable HttpTransport (src/providers/http.ts);
 * tests supply a fake transport, so no network is required.
 */
import type { Provider, RepoSummary, BranchSummary, Member } from "./types";
import {
  repoSummarySchema,
  branchSummarySchema,
  memberSchema,
  type MemberRole,
} from "./schema";
import {
  FetchTransport,
  withQuery,
  paginateAll,
  type HttpTransport,
} from "./http";
import { cloneUrlFor, resolveDefaultBranch } from "./repoUrls";

/** GitLab access levels mapped to the normalized MUGS member role. */
const ACCESS_LEVELS: Record<number, MemberRole> = {
  5000: "owner",
  4000: "maintainer",
  3000: "developer",
  2000: "guest", // reporter
  1000: "guest", // guest
  0: "guest", // no access / legacy guest
};

/** A write-capable PAT has at least Developer (3000); used as the default when the acting user is unknown. */
const DEFAULT_ACCESS_LEVEL = 3000;

export interface GitLabOptions {
  /** API base URL, e.g. https://gitlab.com/api/v4 or a self-hosted instance. */
  baseUrl: string;
  /** Personal access token (PRIVATE-TOKEN) with the `api` scope. */
  token: string;
  /** Optional transport override for tests. Defaults to global fetch. */
  transport?: HttpTransport;
  /** Explicit allowed repos (`owner/repo`). When set, listRepos returns these
   *  directly instead of calling GET /projects — for project-scoped fine-grained tokens. */
  allowedRepos?: string[];
}

// --- Native GitLab shapes (subset of fields we consume) ---------------------

interface GitLabProject {
  id: number | string;
  name: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  default_branch?: string;
  description?: string | null;
  visibility?: "private" | "internal" | "public";
}

interface GitLabMember {
  id: number | string;
  username: string;
  name?: string;
  access_level: number;
  avatar_url?: string;
}

interface GitLabBranch {
  name: string;
  protected: boolean;
  default: boolean;
}

/** URL-encode a project id/path so namespaced paths ("group/project") are safe in the path. */
function encodeRepoPath(repoId: string): string {
  return encodeURIComponent(repoId);
}

function mapProject(p: GitLabProject): RepoSummary {
  return repoSummarySchema.parse({
    id: String(p.id),
    name: p.name,
    pathWithNamespace: p.path_with_namespace,
    httpUrlToRepo: p.http_url_to_repo,
    defaultBranch: p.default_branch ?? "",
    description: p.description ?? undefined,
    visibility: p.visibility,
  });
}

function mapMember(m: GitLabMember): Member {
  return memberSchema.parse({
    id: String(m.id),
    username: m.username,
    name: m.name ?? undefined,
    role: ACCESS_LEVELS[m.access_level] ?? "guest",
    avatarUrl: m.avatar_url || undefined,
  });
}

/**
 * GitLab adapter. Auth + discovery only — the sync engine is plain git over
 * HTTPS (see Decision 1 in the design plan).
 */
export class GitLabProvider implements Provider {
  readonly kind = "gitlab" as const;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: HttpTransport;
  private readonly allowedRepos?: string[];

  constructor(opts: GitLabOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.transport = opts.transport ?? new FetchTransport();
    this.allowedRepos = opts.allowedRepos;
  }

  /** `PRIVATE-TOKEN` is the GitLab auth header (vs GitHub's `Authorization`). */
  private headers(): Record<string, string> {
    return { Accept: "application/json", "PRIVATE-TOKEN": this.token };
  }

  async listRepos(): Promise<RepoSummary[]> {
    // Explicitly-allowed repos: synthesize directly (no /projects call), so a
    // fine-grained token scoped to specific projects works without the user-level
    // "[Project: Read]" enumeration permission.
    if (this.allowedRepos && this.allowedRepos.length > 0) {
      return Promise.all(this.allowedRepos.map((path) => this.synthRepo(path)));
    }
    const url = withQuery(`${this.baseUrl}/projects`, { per_page: 100 });
    const raw = await paginateAll(this.transport, url, this.headers());
    return raw.map((p) => mapProject(p as GitLabProject));
  }

  /** Build a RepoSummary for an explicitly-allowed repo path. The default branch is
   *  resolved via the repo-specific branches endpoint (works with project-scoped tokens). */
  private async synthRepo(path: string): Promise<RepoSummary> {
    let defaultBranch = "";
    try {
      defaultBranch = resolveDefaultBranch(await this.getBranches(path));
    } catch {
      defaultBranch = "";
    }
    return repoSummarySchema.parse({
      id: path,
      name: path.split("/").pop() ?? path,
      pathWithNamespace: path,
      httpUrlToRepo: cloneUrlFor(this.baseUrl, path),
      defaultBranch,
    });
  }

  async getMembers(repoId: string): Promise<Member[]> {
    const url = withQuery(`${this.baseUrl}/projects/${encodeRepoPath(repoId)}/members`, {
      per_page: 100,
    });
    const raw = await paginateAll(this.transport, url, this.headers());
    return raw.map((m) => mapMember(m as GitLabMember));
  }

  async getBranches(repoId: string): Promise<BranchSummary[]> {
    const myAccess = await this.resolveMyAccessLevel(repoId);
    const url = `${this.baseUrl}/projects/${encodeRepoPath(repoId)}/repository/branches`;
    const res = await this.transport.get<GitLabBranch[]>(url, { headers: this.headers() });
    if (res.status >= 400) throw new Error(`GitLab ${res.status} error fetching branches for ${repoId}${res.message ? ` — ${res.message}` : ""}`);
    return (res.body ?? []).map((b) =>
      branchSummarySchema.parse({
        name: b.name,
        protected: !!b.protected,
        default: !!b.default,
        // A protected branch can't be pushed to directly; otherwise push rights
        // require at least Developer access.
        canPush: !b.protected && myAccess >= DEFAULT_ACCESS_LEVEL,
      }),
    );
  }

  /** Fetch the acting user's project access level once (via /members/me), defaulting conservatively. */
  private async resolveMyAccessLevel(repoId: string): Promise<number> {
    const url = `${this.baseUrl}/projects/${encodeRepoPath(repoId)}/members/me`;
    const res = await this.transport.get<GitLabMember>(url, { headers: this.headers() });
    if (res.status >= 400 || !res.body) return DEFAULT_ACCESS_LEVEL;
    return res.body.access_level ?? DEFAULT_ACCESS_LEVEL;
  }

  /** Immediate child directories under `path` via the repository/tree API. */
  async listDirectories(repoId: string, path = ""): Promise<string[]> {
    const base = `${this.baseUrl}/projects/${encodeRepoPath(repoId)}/repository/tree`;
    const url = withQuery(base, path ? { path } : {});
    const res = await this.transport.get<{ type: string; path: string }[]>(url, { headers: this.headers() });
    if (res.status >= 400) throw new Error(`GitLab ${res.status} error fetching directories for ${repoId}${path ? ` (${path})` : ""}${res.message ? ` — ${res.message}` : ""}`);
    const dirs = (res.body ?? []).filter((t) => t.type === "tree").map((t) => t.path.split("/").pop() ?? "");
    return [...new Set(dirs)].sort();
  }
}
