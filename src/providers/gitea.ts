/**
 * MUGS — Gitea / Forgejo provider adapter.
 *
 * Implements the abstract `Provider` contract (see src/providers/types.ts) for
 * Gitea and Forgejo instances using their REST API: `/user/repos` for discovery,
 * `/repos/{owner}/{repo}/members` for collaborators, and
 * `/repos/{owner}/{repo}/branches` (+ `/repos/{owner}/{repo}` for the default
 * branch) for branches. Native JSON is mapped into the host-agnostic contract
 * schemas, then parsed (the ADL principle). All HTTP goes through an injectable
 * HttpTransport (src/providers/http.ts); tests supply a fake transport, so no
 * network is needed.
 */
import type { Provider, RepoSummary, BranchSummary, Member } from "./types";
import { repoSummarySchema, branchSummarySchema, memberSchema, type MemberRole } from "./schema";
import type { ProviderKind } from "../types";
import { FetchTransport, withQuery, paginateAll, type HttpTransport } from "./http";

/** Whether this adapter represents Gitea or Forgejo (same API shape). */
export type GiteaKind = "gitea" | "forgejo";

export interface GiteaOptions {
  /** API base URL, e.g. https://gitea.com/api/v1 or a self-hosted instance. */
  baseUrl: string;
  /** Personal access token. */
  token: string;
  /** Which backend this adapter represents. Defaults to "gitea". */
  kind?: GiteaKind;
  /** Optional transport override for tests. Defaults to global fetch. */
  transport?: HttpTransport;
}

// --- Native shapes (subset of fields we consume) ---------------------------

interface GiteaProject {
  id: number | string;
  name: string;
  full_name: string; // owner/repo
  html_url: string; // https://host/owner/repo
  clone_url?: string;
  ssh_url: string;
  default_branch?: string;
  description?: string | null;
  private?: boolean;
}

interface GiteaMember {
  id: number | string;
  username: string;
  fullname?: string;
  email?: string;
  role: string; // owner | admin | write | read
}

interface GiteaBranch {
  name: string;
  protected: boolean;
}

/** URL-encode a namespaced repo id ("owner/repo") so it is safe in the path. */
function encodeRepoPath(repoId: string): string {
  return encodeURIComponent(repoId);
}

function mapProject(p: GiteaProject): RepoSummary {
  // Prefer the HTTPS clone URL when present, else derive from html_url.
  const httpUrl = p.clone_url ?? `${p.html_url.replace(/\/$/, "")}.git`;
  return repoSummarySchema.parse({
    id: String(p.id),
    name: p.name,
    pathWithNamespace: p.full_name,
    httpUrlToRepo: httpUrl,
    defaultBranch: p.default_branch ?? "",
    description: p.description ?? undefined,
    visibility: p.private ? "private" : "public",
  });
}

function mapMember(m: GiteaMember): Member {
  const role: MemberRole =
    m.role === "admin" ? "maintainer" : m.role === "write" ? "developer" : m.role === "owner" ? "owner" : "guest";
  return memberSchema.parse({
    id: String(m.id),
    username: m.username,
    name: m.fullname ?? undefined,
    role,
  });
}

/**
 * Gitea/Forgejo adapter. Auth + discovery only — the sync engine is plain git
 * over HTTPS (see Decision 1 in the design plan).
 */
export class GiteaProvider implements Provider {
  readonly kind: ProviderKind;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly transport: HttpTransport;

  constructor(opts: GiteaOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.kind = (opts.kind ?? "gitea") as ProviderKind;
    this.transport = opts.transport ?? new FetchTransport();
  }

  /** Gitea/Forgejo authenticate with `Authorization: token` (vs GitLab's PRIVATE-TOKEN). */
  private headers(): Record<string, string> {
    return { Accept: "application/json", Authorization: `token ${this.token}` };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const url = withQuery(`${this.baseUrl}/user/repos`, { visibility: "all", per_page: 100 });
    const raw = await paginateAll(this.transport, url, this.headers());
    return raw.map((p) => mapProject(p as GiteaProject));
  }

  async getMembers(repoId: string): Promise<Member[]> {
    const url = withQuery(`${this.baseUrl}/repos/${encodeRepoPath(repoId)}/members`, { per_page: 100 });
    const raw = await paginateAll(this.transport, url, this.headers());
    return raw.map((m) => mapMember(m as GiteaMember));
  }

  async getBranches(repoId: string): Promise<BranchSummary[]> {
    // Resolve the repo's default branch (needed to mark the `default` flag).
    const repoRes = await this.transport.get<GiteaProject>(`${this.baseUrl}/repos/${encodeRepoPath(repoId)}`, { headers: this.headers() });
    const defaultBranch = repoRes.status >= 200 && repoRes.status < 300 ? (repoRes.body?.default_branch ?? "") : "";

    const url = withQuery(`${this.baseUrl}/repos/${encodeRepoPath(repoId)}/branches`, { per_page: 100 });
    const res = await this.transport.get<GiteaBranch[]>(url, { headers: this.headers() });
    if (res.status >= 400) throw new Error(`Gitea ${res.status} error fetching branches for ${repoId}`);
    return (res.body ?? []).map((b) =>
      branchSummarySchema.parse({
        name: b.name,
        protected: !!b.protected,
        default: defaultBranch ? b.name === defaultBranch : false,
        // A protected branch can't be pushed to directly; the acting token is
        // assumed write-capable for non-protected branches.
        canPush: !b.protected,
      }),
    );
  }
}
