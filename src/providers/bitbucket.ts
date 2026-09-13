/**
 * MUGS — Bitbucket provider adapter.
 *
 * Implements the abstract `Provider` contract (see src/providers/types.ts) for
 * Bitbucket Cloud/Server using the /2.0 REST API, whose shape is
 * workspace/repo. Two things differ from GitLab/GitHub:
 *   1. Lists page via a JSON `next` cursor (not a `Link` header), so this adapter
 *      uses its own small paginator instead of paginateAll.
 *   2. Repositories are addressed as "workspace/repo".
 *
 * Auth is an OAuth token via the `Authorization: Bearer` header. Native JSON is
 * mapped into the host-agnostic contract schemas, then parsed (the ADL principle).
 * All HTTP goes through an injectable HttpTransport (src/providers/http.ts); tests
 * supply a fake transport, so no network is needed.
 */
import type { Provider, RepoSummary, BranchSummary, Member } from "./types";
import { repoSummarySchema, branchSummarySchema, memberSchema, type MemberRole } from "./schema";
import { FetchTransport, withQuery, type HttpTransport } from "./http";

/** Bitbucket participant roles mapped to the normalized MUGS member role. */
const PARTICIPANT_ROLE: Record<string, MemberRole> = {
  OWNER: "owner",
  ADMIN: "maintainer",
  MEMBER: "developer",
  CONTRIBUTOR: "developer",
};

/** Participant roles that may push to a branch. */
const WRITE_CAPABLE_ROLES = new Set(["OWNER", "ADMIN", "MEMBER"]);

/** A write-capable token pushes by default when the acting user is unknown. */
const DEFAULT_WRITE_CAPABLE = true;

export interface BitbucketOptions {
  /** API base URL, e.g. https://api.bitbucket.org or a self-hosted instance. */
  baseUrl: string;
  /** OAuth / access token. */
  token: string;
  /** Optional transport override for tests. Defaults to global fetch. */
  transport?: HttpTransport;
  /** Acting user's Bitbucket username, used to compute per-branch push rights. */
  actingUsername?: string;
}

// --- Native Bitbucket shapes (subset of fields we consume) -----------------

interface BitbucketCloneLink {
  name: string; // "https" | "ssh"
  href: string;
}

interface BitbucketRepo {
  uuid: string;
  name: string;
  full_name: string; // workspace/repo
  links?: { clone?: BitbucketCloneLink[] };
  mainbranch?: { name: string };
  description?: string;
  is_private?: boolean;
}

interface BitbucketUser {
  username: string;
  name?: string;
  avatar_url?: string;
}

interface BitbucketParticipant {
  role: string; // OWNER | ADMIN | MEMBER | CONTRIBUTOR
  user?: BitbucketUser;
}

interface BitbucketRef {
  name: string;
}

/**
 * Paginate a Bitbucket /2.0 list that pages via a JSON `next` cursor, returning
 * the concatenated `values` arrays. Callers cast to their element type.
 */
async function paginateValues(
  transport: HttpTransport,
  url: string,
  headers: Record<string, string>,
): Promise<unknown[]> {
  const acc: unknown[] = [];
  let next: string | null = url;
  while (next) {
    // Cast the body to a page shape; typed at the call sites.
    const res = await transport.get<unknown>(next, { headers });
    if (res.status >= 400) throw new Error(`Bitbucket ${res.status} error paginating ${next}`);
    const page = res.body as { values?: unknown[]; next?: string | null } | undefined;
    if (Array.isArray(page?.values)) acc.push(...page.values);
    next = page?.next ?? null;
  }
  return acc;
}

/** URL-encode a namespaced repo id ("workspace/repo") so it is safe in the path. */
function encodeRepoPath(repoId: string): string {
  return encodeURIComponent(repoId);
}

function mapProject(r: BitbucketRepo): RepoSummary {
  const https = r.links?.clone?.find((c) => c.name === "https");
  return repoSummarySchema.parse({
    id: r.uuid,
    name: r.name,
    pathWithNamespace: r.full_name,
    httpUrlToRepo: https?.href ?? "",
    defaultBranch: r.mainbranch?.name ?? "",
    description: r.description,
    visibility: r.is_private ? "private" : "public",
  });
}

function mapParticipant(p: BitbucketParticipant): Member {
  const user = p.user ?? { username: "" };
  return memberSchema.parse({
    id: user.username,
    username: user.username,
    name: user.name ?? undefined,
    role: PARTICIPANT_ROLE[p.role] ?? "guest",
    avatarUrl: user.avatar_url || undefined,
  });
}

/**
 * Bitbucket adapter. Auth + discovery only — the sync engine is plain git over
 * HTTPS (see Decision 1 in the design plan).
 */
export class BitbucketProvider implements Provider {
  readonly kind = "bitbucket" as const;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly actingUsername?: string;
  private readonly transport: HttpTransport;

  constructor(opts: BitbucketOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.actingUsername = opts.actingUsername;
    this.transport = opts.transport ?? new FetchTransport();
  }

  private headers(): Record<string, string> {
    return { Accept: "application/json", Authorization: `Bearer ${this.token}` };
  }

  async listRepos(): Promise<RepoSummary[]> {
    const url = withQuery(`${this.baseUrl}/2.0/repositories`, { include_public: false, per_page: 100 });
    const raw = (await paginateValues(this.transport, url, this.headers())) as BitbucketRepo[];
    return raw.map((r) => mapProject(r));
  }

  async getMembers(repoId: string): Promise<Member[]> {
    const url = withQuery(`${this.baseUrl}/2.0/repositories/${encodeRepoPath(repoId)}/participants`, { per_page: 100 });
    const raw = (await paginateValues(this.transport, url, this.headers())) as BitbucketParticipant[];
    return raw.map((p) => mapParticipant(p));
  }

  async getBranches(repoId: string): Promise<BranchSummary[]> {
    const encoded = encodeRepoPath(repoId);
    const repoRes = await this.transport.get<BitbucketRepo>(`${this.baseUrl}/2.0/repositories/${encoded}`, {
      headers: this.headers(),
    });
    const defaultBranch = repoRes.status >= 200 && repoRes.status < 300 ? (repoRes.body?.mainbranch?.name ?? "") : "";

    // Determine push rights from the acting user's participant role, if known.
    let writeCapable = DEFAULT_WRITE_CAPABLE;
    if (this.actingUsername) {
      const participantsUrl = withQuery(`${this.baseUrl}/2.0/repositories/${encoded}/participants`, { per_page: 100 });
      const participants = (await paginateValues(this.transport, participantsUrl, this.headers())) as BitbucketParticipant[];
      const me = participants.find((p) => p.user?.username === this.actingUsername);
      writeCapable = me ? WRITE_CAPABLE_ROLES.has(me.role) : DEFAULT_WRITE_CAPABLE;
    }

    const refsUrl = withQuery(`${this.baseUrl}/2.0/repositories/${encoded}/refs`, { kind: "branch", per_page: 100 });
    const refs = (await paginateValues(this.transport, refsUrl, this.headers())) as BitbucketRef[];
    return refs.map((b) =>
      branchSummarySchema.parse({
        name: b.name,
        protected: false, // Bitbucket does not expose per-branch protection in the refs list.
        default: defaultBranch ? b.name === defaultBranch : false,
        canPush: writeCapable,
      }),
    );
  }
}
