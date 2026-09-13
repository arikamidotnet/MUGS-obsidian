/**
 * MUGS — GitHub provider adapter.
 *
 * Implements the abstract `Provider` contract (see src/providers/types.ts) for
 * github.com and GitHub Enterprise, using the REST API v3. Auth is a PAT/OAuth
 * token via the `Authorization: Bearer` header. Native JSON is mapped into the
 * host-agnostic contract schemas, then parsed — so this adapter is correct when
 * it satisfies the abstract interfaces, not just when it works against one repo
 * (the ADL principle).
 *
 * All HTTP goes through an injectable HttpTransport (src/providers/http.ts);
 * tests supply a fake transport, so no network is required. GitHub pages lists
 * via the `Link` header, which paginateAll follows.
 */
import type { Provider, RepoSummary, BranchSummary, Member } from "./types";
import { repoSummarySchema, branchSummarySchema, memberSchema, type MemberRole } from "./schema";
import { FetchTransport, withQuery, paginateAll, type HttpTransport } from "./http";

/** GitHub permission roles mapped to the normalized MUGS member role. */
const PERMISSION_ROLE: Record<string, MemberRole> = {
  admin: "maintainer",
  write: "maintainer",
  triage: "developer",
  read: "guest",
};

/** Roles that may push to a non-protected branch. */
const WRITE_CAPABLE = new Set(["owner", "admin", "write"]);

/** A write-capable token has at least `write`; used as the default when unknown. */
const DEFAULT_WRITE_CAPABLE = true;

export interface GitHubOptions {
  /** API base URL, e.g. https://api.github.com or a GitHub Enterprise host. */
  baseUrl: string;
  /** Personal access / OAuth token. */
  token: string;
  /** Optional transport override for tests. Defaults to global fetch. */
  transport?: HttpTransport;
}

// --- Native GitHub shapes (subset of fields we consume) --------------------

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string; // owner/repo
  html_url: string; // https://github.com/owner/repo
  default_branch?: string;
  description?: string | null;
  private?: boolean;
}

interface GitHubContributor {
  login: string;
  name?: string | null;
  avatar_url?: string;
}

interface GitHubPermission {
  role: string; // admin | write | triage | read
}

interface GitHubBranch {
  name: string;
  protected: boolean;
}

/** URL-encode a namespaced repo id ("owner/repo") so it is safe in the path. */
function encodeRepoPath(repoId: string): string {
  return encodeURIComponent(repoId);
}

function mapProject(r: GitHubRepo): RepoSummary {
  return repoSummarySchema.parse({
    id: String(r.id),
    name: r.name,
    pathWithNamespace: r.full_name,
    httpUrlToRepo: `${r.html_url}.git`,
    defaultBranch: r.default_branch ?? "",
    description: r.description ?? undefined,
    visibility: r.private ? "private" : "public",
  });
}

function mapMember(c: GitHubContributor, role: string): Member {
  return memberSchema.parse({
    id: c.login,
    username: c.login,
    name: c.name ?? undefined,
    role: PERMISSION_ROLE[role] ?? "guest",
    avatarUrl: c.avatar_url || undefined,
  });
}

/**
 * GitHub adapter. Auth + discovery only — the sync engine is plain git over
 * HTTPS (see Decision 1 in the design plan).
 */
export class GitHubProvider implements Provider {
  readonly kind = "github" as const;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: HttpTransport;

  constructor(opts: GitHubOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.transport = opts.transport ?? new FetchTransport();
  }

  /** `Authorization: Bearer` is the GitHub auth header (vs GitLab's PRIVATE-TOKEN). */
  private headers(): Record<string, string> {
    return { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}` };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const url = withQuery(`${this.baseUrl}/user/repos`, { visibility: "all", per_page: 100 });
    const raw = await paginateAll(this.transport, url, this.headers());
    return raw.map((r) => mapProject(r as GitHubRepo));
  }

  async getMembers(repoId: string): Promise<Member[]> {
    const base = `${this.baseUrl}/repos/${encodeRepoPath(repoId)}`;
    const url = withQuery(`${base}/collaborators`, { per_page: 100 });
    const raw = await paginateAll(this.transport, url, this.headers());
    const members: Member[] = [];
    for (const c of raw as GitHubContributor[]) {
      // Per-collaborator permission lookup — GitHub has no single member-roles list.
      const perm = await this.transport.get<GitHubPermission>(`${base}/collaborators/${encodeRepoPath(c.login)}/permission`, {
        headers: this.headers(),
      });
      members.push(mapMember(c, perm.status >= 200 && perm.status < 300 ? (perm.body?.role ?? "read") : "read"));
    }
    return members;
  }

  async getBranches(repoId: string): Promise<BranchSummary[]> {
    const base = `${this.baseUrl}/repos/${encodeRepoPath(repoId)}`;
    const repo = await this.transport.get<GitHubRepo>(base, { headers: this.headers() });
    const defaultBranch = repo.status >= 200 && repo.status < 300 ? (repo.body?.default_branch ?? "") : "";

    const access = await this.transport.get<GitHubPermission>(`${base}/access-level`, { headers: this.headers() });
    const writeCapable =
      access.status >= 200 && access.status < 300 ? WRITE_CAPABLE.has(access.body?.role ?? "") : DEFAULT_WRITE_CAPABLE;

    const url = withQuery(`${base}/branches`, { per_page: 100 });
    const res = await paginateAll(this.transport, url, this.headers());
    return (res as GitHubBranch[]).map((b) =>
      branchSummarySchema.parse({
        name: b.name,
        protected: !!b.protected,
        default: defaultBranch ? b.name === defaultBranch : false,
        // A protected branch can't be pushed to directly; otherwise push rights
        // require a write-capable token.
        canPush: !b.protected && writeCapable,
      }),
    );
  }
}
