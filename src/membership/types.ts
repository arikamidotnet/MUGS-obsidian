/**
 * MUGS — multi-user membership view (data layer).
 *
 * Pure, with no Obsidian or git imports so it stays unit-testable in isolation.
 * This module merges two disjoint signals into one representation for the
 * visibility-only membership view (design Decision 2):
 *
 *   - a backend's member roster + roles (`Member[]` from `Provider.getMembers`)
 *     describing who *can* edit, via the repo's permission model; and
 *   - local activity derived from the per-mapping clone (`ContributorActivity`,
 *     e.g. last-sync authors and recent committers) describing who *has* edited.
 *
 * The view reports access and activity — it does not enforce either.
 */
import type { MemberRole } from "../providers/types";

/** Roles that grant write access in the normalized backend permission model. */
export const WRITE_ROLES: readonly MemberRole[] = ["owner", "maintainer"] as const;

/** A roster member merged with local activity, for rendering in the view. */
export interface MemberView {
  /** Stable provider member id (unique within the repo). */
  memberId: string;
  /** Backend username/login. */
  username: string;
  /** Display name, if the provider exposed one. */
  displayName?: string;
  /** Effective collaborator role from the backend permission model. */
  role: MemberRole;
  /** Avatar URL, if available. */
  avatarUrl?: string;
  /** Whether the backend grants write access (owner/maintainer). */
  canWrite: boolean;
  /** Epoch-ms of this member's most recent local activity, if any. */
  lastActivityAt?: number;
  /** Local commits authored in the recent window. */
  commitCount: number;
  /** True when there is activity within `recentWindowMs` of the reference `now`. */
  isActive: boolean;
}

/** A local committer with no matching roster member — surfaced, never hidden. */
export interface ExternalContributor {
  /** Git author name (the only identity the roster can be correlated against). */
  name: string;
  /** Git author email, when known. */
  email?: string;
  commitCount: number;
  lastActivityAt?: number;
}

/** A single repo's membership summary for the visibility view. */
export interface MembershipSummary {
  repoId: string;
  repoName: string;
  /** Roster members, sorted active-first, then by contribution, then username. */
  members: MemberView[];
  /** Local committers that match no roster member (visibility only). */
  externalContributors: ExternalContributor[];
  /** Total commits across every contributor in the activity signal. */
  totalCommits: number;
}
