import type { FolderMapping, MugsSettings, SyncPolicy } from "../types";
import type { SyncOutcome } from "../sync/driver";

export function automaticMappings(settings: Pick<MugsSettings, "mappings" | "sync">): FolderMapping[] {
  const rollout = settings.sync.rollout;
  if (rollout?.mode !== "staged") return settings.mappings;
  const enabled = new Set(rollout.enabledMappingIds);
  return settings.mappings.filter(mapping => enabled.has(mapping.id) && !rollout.blocked[mapping.id]);
}

export function rolloutFailure(outcome: SyncOutcome, settings: MugsSettings): string | undefined {
  if (outcome.status !== "ok") return outcome.reason ?? outcome.status;
  if (outcome.blocked?.length) return `${outcome.blocked.length} files blocked`;
  if (outcome.counts?.deferred) return `${outcome.counts.deferred} changes deferred`;
  if (outcome.pendingFailures) return `${outcome.pendingFailures} pending failures`;
  if (outcome.kind === "retry-pending") return "retry pending";
  const state = settings.lastSync[outcome.mappingId];
  if (state?.pendingOps?.length) return `${state.pendingOps.length} operations pending`;
  if (settings.conflicts[outcome.mappingId]?.some(conflict => !conflict.resolved)) return "unresolved conflicts";
  if (Object.keys(state?.reconciliation?.review ?? {}).length) return "repository files need review";
  return undefined;
}

/** Apply a one-shot canary result for one mapping. A failure records why and
 *  removes the mapping from the automatic set; a clean result enables exactly
 *  that mapping and clears a prior block, because the explicit canary IS the
 *  user's authorization to resume. Other mappings are never touched. */
export function recordCanary(
  rollout: NonNullable<SyncPolicy["rollout"]>, id: string, reason?: string,
): NonNullable<SyncPolicy["rollout"]> {
  const next = structuredClone(rollout);
  const at = Date.now();
  if (reason) {
    next.lastResult[id] = { status: "blocked", at, reason };
    next.enabledMappingIds = next.enabledMappingIds.filter(candidate => candidate !== id);
    return next;
  }
  next.lastResult[id] = { status: "ok", at };
  if (!next.enabledMappingIds.includes(id)) next.enabledMappingIds.push(id);
  delete next.blocked[id];
  return next;
}

/** Return an immutable policy update; a failed pass is disabled before it can run again. */
export function recordRollout(
  policy: SyncPolicy, outcomes: SyncOutcome[], settings: MugsSettings, saveError?: string,
): SyncPolicy["rollout"] {
  const rollout = policy.rollout;
  if (rollout?.mode !== "staged") return rollout;
  const next = structuredClone(rollout);
  for (const outcome of outcomes) {
    if (!next.enabledMappingIds.includes(outcome.mappingId)) continue;
    const reason = saveError ?? rolloutFailure(outcome, settings);
    const at = Date.now();
    next.lastResult[outcome.mappingId] = reason ? { status: "blocked", at, reason } : { status: "ok", at };
    if (reason) {
      next.blocked[outcome.mappingId] = { reason, at };
      next.enabledMappingIds = next.enabledMappingIds.filter(id => id !== outcome.mappingId);
    }
  }
  return next;
}
