/**
 * MUGS — automatic conflict-resolution policy (pure).
 *
 * The sync engine is "automatic-first": every divergence it can resolve, it resolves
 * without pausing the user for a manual decision. This module holds the pure decision
 * logic that reads an injected {@link SyncPolicy} and decides how to auto-resolve a
 * genuine conflict — it never performs I/O and never blocks sync. The diff/panel view
 * remains a monitoring surface showing what merged and what was auto-resolved (and why).
 *
 * Resolution order:
 *   1. recency-wins — when both sides carry a save timestamp that differ by more than a
 *      small near-equal margin, pick the more-recently-saved side (the user's
 *      time-series heuristic; low-risk because vault files rarely move in/out).
 *   2. default-resolution fallback — otherwise fall back to `sync.defaultResolution`
 *      ("both" best-effort combines both sides, "ours"/"theirs" is last-write-wins).
 *
 * Written as an executable spec independent of Obsidian/git so it is pinned by tests.
 */
import type { SyncPolicy, FileConflict } from "../types";
import { resolveConflict, type ResolveChoice } from "./conflict";

/**
 * Two saves within this many milliseconds are treated as "simultaneous" (a common case
 * for fast successive edits on one machine, or clock skew between a local mtime and a
 * remote commit date). Near-equal falls back to `defaultResolution` rather than flipping
 * winner based on noise — this avoids flip-flop across syncs.
 */
export const RECENCY_NEAR_EQUAL_MS = 5000;

/** Which of two timestamps is clearly the newer one, or null when they are near-equal. */
export type ClearlyNewer = "ours" | "theirs";

/**
 * Return which side was saved more recently when the two timestamps differ by more than
 * `marginMs`; otherwise null (near-equal / missing timestamp). Missing either timestamp
 * also yields null so the caller falls back to {@link SyncPolicy.defaultResolution}.
 */
export function clearlyNewer(
  oursSavedAt: number | undefined,
  theirsModifiedAt: number | undefined,
  marginMs = RECENCY_NEAR_EQUAL_MS,
): ClearlyNewer | null {
  if (oursSavedAt === undefined || theirsModifiedAt === undefined) return null;
  const diff = Math.abs(oursSavedAt - theirsModifiedAt);
  if (diff <= marginMs) return null;
  return oursSavedAt > theirsModifiedAt ? "ours" : "theirs";
}

/**
 * jj's same-change rule: both sides made the identical change. `undefined` is a deletion,
 * so two deletions count as the same change (both removed the file) while an empty file
 * ("") is distinct from a deletion. Identical changes need no resolution — they collapse
 * to one copy in {@link threeWayMerge}; this predicate exists for policy transparency and
 * for callers that want to short-circuit before recording a conflict.
 */
export function sameChange(ours: string | undefined, theirs: string | undefined): boolean {
  return ours === theirs;
}

/** A decided automatic resolution plus a human-readable reason for the panel log. */
export interface AutoResolution {
  choice: ResolveChoice;
  /** Why this choice was made (e.g. "recency — ours saved later", "default resolution (both)"). */
  reason: string;
}

/**
 * Decide how to auto-resolve a genuine conflict under the given policy, or undefined when
 * the policy cannot decide (defensive — every configured policy can always fall back to a
 * `defaultResolution`, so this is effectively always defined). Never throws, never blocks.
 */
export function resolveConflictAuto(c: FileConflict, policy: SyncPolicy): AutoResolution | undefined {
  if (policy.recencyWins) {
    const newer = clearlyNewer(c.oursSavedAt, c.theirsModifiedAt);
    if (newer === "ours") return { choice: "ours", reason: "recency — ours saved later" };
    if (newer === "theirs") return { choice: "theirs", reason: "recency — theirs saved later" };
    // null => near-equal or missing timestamp -> fall through to defaultResolution.
  }
  return { choice: policy.defaultResolution, reason: `default resolution (${policy.defaultResolution})` };
}

/** Whether the policy can auto-resolve this conflict (used to decide surface-vs-apply). */
export function canAutoResolve(c: FileConflict, policy: SyncPolicy): boolean {
  return resolveConflictAuto(c, policy) !== undefined;
}

/** The resolved text for an automatic choice — same as a manual {@link resolveConflict}. */
export function autoResolvedContent(c: FileConflict, resolution: AutoResolution): string {
  return resolveConflict(c, resolution.choice);
}
