/**
 * MUGS — membership merge logic (pure).
 *
 * Combines a backend member roster with local contributor activity into the
 * `MembershipSummary` shape from ./types. Everything here is deterministic and
 * free of Obsidian/git imports, so behavior is pinned by contract tests rather
 * than exercised against a live backend or clone.
 *
 * Correlation: remote members carry no email (GitLab `/members` does not expose
 * one), so an activity signal is matched to a member by comparing the signal's
 * key — normally a git author name — against the member's username and display
 * name, case-insensitively. Multiple git authors that resolve to the same member
 * have their commit counts summed; local committers that match nobody are
 * reported as `externalContributors` so no contribution is ever hidden.
 */
import type { Member, MemberRole } from "../providers/types";
import { WRITE_ROLES, type ExternalContributor, type MemberView, type MembershipSummary } from "./types";

/** Default "recent" window: the last 7 days, in milliseconds. */
export const DEFAULT_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A local activity signal for one contributor (a git author or last-sync author). */
export interface ContributorActivity {
  /** Identity key used to correlate with a roster member (e.g. a git author name). */
  key: string;
  /** Git author email, when known — surfaced on external contributors. */
  email?: string;
  commitCount: number;
  lastActivityAt?: number;
}

/** How to correlate a `ContributorActivity` with a roster `Member`. */
export interface CorrelationStrategy {
  /** Candidate identity keys on the member, tried in priority order. */
  memberKeys: (m: Member) => string[];
  /** Normalize both sides before comparing (default: trim + lowercase). */
  normalize?: (s: string) => string;
}

const WRITE_ROLE_SET = new Set<MemberRole>(WRITE_ROLES);

function defaultStrategy(): CorrelationStrategy {
  return {
    memberKeys: (m) => [m.username, m.name ?? ""].filter(Boolean),
    normalize: (s) => s.trim().toLowerCase(),
  };
}

/** Combine two activity signals for the same identity: sum counts, keep latest time. */
function mergeActivity(a?: ContributorActivity, b?: ContributorActivity): ContributorActivity | undefined {
  if (!a) return b;
  if (!b) return a;
  const last = Math.max(a.lastActivityAt ?? 0, b.lastActivityAt ?? 0);
  return {
    key: a.key,
    email: a.email ?? b.email,
    commitCount: a.commitCount + b.commitCount,
    lastActivityAt: last > 0 ? last : undefined,
  };
}

/** Build a membership view for one roster member given its aggregated activity. */
export function toMemberView(
  m: Member,
  activity: ContributorActivity | undefined,
  opts: { now?: number; recentWindowMs?: number } = {},
): MemberView {
  const now = opts.now ?? Date.now();
  const window = opts.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const last = activity?.lastActivityAt;
  return {
    memberId: m.id,
    username: m.username,
    displayName: m.name,
    role: m.role,
    avatarUrl: m.avatarUrl,
    canWrite: WRITE_ROLE_SET.has(m.role),
    lastActivityAt: last,
    commitCount: activity?.commitCount ?? 0,
    isActive: !!activity && (last ?? 0) >= now - window,
  };
}

/** Correlation result: per-member aggregated activity plus the keys consumed. */
export interface CorrelationResult {
  /** member.id -> aggregated activity, only for roster members with local activity. */
  matched: Map<string, ContributorActivity>;
  /** Activity keys that resolved to a roster member (so the rest are "external"). */
  consumedKeys: Set<string>;
}

/**
 * Correlate a roster with local activity. A member consumes every activity whose
 * key matches any of its identity keys; those signals are aggregated into one.
 */
export function correlateMembers(
  members: Member[],
  activity: ContributorActivity[],
  strategy: CorrelationStrategy = defaultStrategy(),
): CorrelationResult {
  const norm = strategy.normalize ?? ((s) => s.trim().toLowerCase());
  const consumed = new Set<string>();
  const matched = new Map<string, ContributorActivity>();
  for (const m of members) {
    let acc: ContributorActivity | undefined;
    for (const act of activity) {
      if (!strategy.memberKeys(m).some((k) => norm(k) === norm(act.key))) continue;
      consumed.add(act.key);
      acc = mergeActivity(acc, act);
    }
    if (acc) matched.set(m.id, acc);
  }
  return { matched, consumedKeys: consumed };
}

/** Sort members active-first, then by contribution, then username ascending. */
function sortMembers(members: MemberView[]): MemberView[] {
  return [...members].sort(
    (a, b) =>
      Number(b.isActive) - Number(a.isActive) ||
      b.commitCount - a.commitCount ||
      a.username.localeCompare(b.username),
  );
}

/** Map unconsumed activity to sorted external contributors. */
function toExternalList(activity: ContributorActivity[], consumedKeys: Set<string>): ExternalContributor[] {
  return activity
    .filter((a) => !consumedKeys.has(a.key))
    .map((a) => ({ name: a.key, email: a.email, commitCount: a.commitCount, lastActivityAt: a.lastActivityAt }))
    .sort((x, y) => y.commitCount - x.commitCount || x.name.localeCompare(y.name));
}

/** Local committers that match no roster member — surfaced so nothing is invisible. */
export function externalContributors(
  activity: ContributorActivity[],
  members: Member[],
  strategy: CorrelationStrategy = defaultStrategy(),
): ExternalContributor[] {
  const { consumedKeys } = correlateMembers(members, activity, strategy);
  return toExternalList(activity, consumedKeys);
}

/**
 * Build a full per-repo membership summary from a roster and local activity.
 * `now`/`recentWindowMs` are injectable so "active" is deterministic in tests;
 * `strategy` lets callers override the name-based correlation (e.g. to match by email).
 */
export function buildMembershipSummary(
  repoId: string,
  repoName: string,
  members: Member[],
  activity: ContributorActivity[],
  opts: { now?: number; recentWindowMs?: number; strategy?: CorrelationStrategy } = {},
): MembershipSummary {
  const { matched, consumedKeys } = correlateMembers(members, activity, opts.strategy ?? undefined);
  const views = members.map((m) => toMemberView(m, matched.get(m.id), opts));
  const totalCommits = activity.reduce((sum, a) => sum + a.commitCount, 0);
  return {
    repoId,
    repoName,
    members: sortMembers(views),
    externalContributors: toExternalList(activity, consumedKeys),
    totalCommits,
  };
}
