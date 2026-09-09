/**
 * MUGS — provider adapter contract.
 *
 * `Provider` is the abstract interface every backend adapter (GitLab, GitHub,
 * etc.) must satisfy. The data shapes it returns are defined by the Zod schemas
 * in schema.ts and re-exported here for convenience. Keeping adapters behind
 * this single interface is what makes backends interchangeable behind one
 * contract — an adapter is correct when it satisfies `Provider`, not when it
 * happens to work against one host (see the ADL section of the design plan).
 */
import type { ProviderKind } from "../types";
import type { RepoSummary, BranchSummary, Member, MemberRole } from "./schema";

export type { RepoSummary, BranchSummary, Member, MemberRole };

/** A git backend adapter: auth + discovery only (the sync engine is plain git). */
export interface Provider {
  /** Which backend this adapter talks to. */
  readonly kind: ProviderKind;

  /** Repositories the acting user can access (to pick as destinations). */
  listRepos(): Promise<RepoSummary[]>;

  /** Branches of a repo, with push/protected/default flags for sync decisions. */
  getBranches(repoId: string): Promise<BranchSummary[]>;

  /** Collaborators on a repo, for the local membership (visibility) view. */
  getMembers(repoId: string): Promise<Member[]>;
}
