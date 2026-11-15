import type { MugsSettings } from "../types";

export interface MappingPreflight {
  id: string;
  label: string;
  blockers: string[];
  cloneDir?: string;
  lastObservedAt?: number;
  reviewCount: number;
  conflictCount: number;
  pendingCount: number;
}

/** Saved evidence only. No Git fetch, filesystem write, or implicit authorization. */
export function mappingPreflight(settings: MugsSettings, id: string, clonePresent: boolean): MappingPreflight {
  const mapping = settings.mappings.find(m => m.id === id);
  if (!mapping) throw new Error("mapping no longer exists");
  const state = settings.lastSync[id];
  const reviewCount = Object.keys(state?.reconciliation?.review ?? {}).length;
  const conflictCount = (settings.conflicts[id] ?? []).filter(c => !c.resolved).length;
  const pendingCount = state?.pendingOps?.length ?? 0;
  const blockers: string[] = [];
  if (!clonePresent || !state?.cloneDir) blockers.push("local clone has not been verified");
  if (!state?.baseSha) blockers.push("no proven sync baseline");
  if (reviewCount) blockers.push(`${reviewCount} repository files need review`);
  if (conflictCount) blockers.push(`${conflictCount} unresolved conflicts`);
  if (pendingCount) blockers.push(`${pendingCount} pending operations`);
  if ((settings.staging[id] ?? []).some(change => change.state === "held")) blockers.push("held changes");
  if (state?.status === "error" || state?.status === "conflict") blockers.push(`last sync ${state.status}`);
  if (settings.sync.rollout?.blocked[id]) blockers.push(settings.sync.rollout.blocked[id].reason);
  return {
    id, label: mapping.label || id, blockers, cloneDir: state?.cloneDir,
    lastObservedAt: Math.max(state?.lastPullAt ?? 0, state?.lastPushAt ?? 0) || undefined,
    reviewCount, conflictCount, pendingCount,
  };
}
