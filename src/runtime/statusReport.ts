/**
 * MUGS — status reporting (contract §7).
 *
 * Pure summarizer: turns per-mapping sync outcomes plus the durable pendingOps
 * into (a) COUNTS (publish/applied/deferred/conflicted/failed/pending) and (b) a
 * DISTINCT terminal state — offline / auth / conflict / paused each get their own
 * message so "why did nothing happen" is never a mystery. Messages carry counts
 * and mapping labels only — never note contents.
 */
import type { SyncOutcome } from "../sync/driver";
import type { PendingOperation, SaveResult } from "../types";

/** The aggregate counts surfaced in Notices and the status-bar tooltip. */
export interface StatusCounts {
  publish: number;   // local changes staged/committed for push
  applied: number;   // remote changes written into the vault
  deferred: number;  // operations intentionally postponed (editor-open, etc.)
  conflicted: number;// files awaiting manual resolution
  failed: number;    // mappings that errored/were skipped for a persistent reason
  pending: number;   // durable pendingOps not yet applied+verified
}

/** Distinct terminal status kinds — each maps to its own user-facing message. */
export type ReportKind =
  | "conflict"     // needs a manual merge
  | "offline"      // provider unreachable — will retry with backoff
  | "auth"         // credentials missing/locked/invalid
  | "paused"       // user-paused (passes never even start)
  | "skipped"      // skipped for another persistent reason
  | "error"        // hard failure (thrown / refused save)
  | "synced"       // at least one mapping completed + save ok
  | "idle";        // nothing configured / nothing to do

export interface StatusReport {
  kind: ReportKind;
  counts: StatusCounts;
  /** Count-only human summary (mapping labels ok, note contents never). */
  message: string;
}

/** Classify a skip reason string into a ReportKind. Conservative: unknown → "skipped". */
export function classifySkipReason(reason: string | undefined): ReportKind {
  const r = (reason ?? "").toLowerCase();
  if (r.includes("reach provider") || r.includes("network") || r.includes("offline") || r.includes("timeout")) return "offline";
  if (r.includes("token") || r.includes("credential") || r.includes("auth") || r.includes("locked")) return "auth";
  return "skipped";
}

/** Build the aggregate report for one completed pass. */
export function buildStatusReport(opts: {
  outcomes: SyncOutcome[];
  pendingOps?: PendingOperation[];
  saveResult?: SaveResult;
  thrown?: unknown;
  quiet?: boolean;
}): StatusReport {
  const { outcomes, pendingOps, saveResult, thrown } = opts;
  const counts: StatusCounts = {
    publish: outcomes.filter((o) => o.status === "ok" && o.push === true).length,
    applied: outcomes.filter((o) => o.status === "ok" && o.pull !== undefined).length,
    deferred: 0, // driver-side pendingOps consumption lands with sync-core's planner (seam)
    conflicted: outcomes.reduce((n, o) => n + (o.conflicts?.length ?? 0), 0),
    failed: 0,
    pending: pendingOps?.length ?? 0,
  };

  const skips = outcomes.filter((o) => o.status === "skipped");
  const byKind = new Map<ReportKind, number>();
  for (const s of skips) {
    const kind = classifySkipReason(s.reason);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    if (kind === "offline" || kind === "auth") counts.failed += 1;
    else counts.failed += 1;
  }

  const parts = (extra: string[]): string =>
    [`MUGS`, ...extra].join(" — ");

  // Priority: hard error > conflict > auth > offline > skipped > synced > idle.
  if (thrown) {
    return {
      kind: "error",
      counts,
      message: parts(["sync failed", describeThrown(thrown)]),
    };
  }
  if (saveResult && !saveResult.ok) {
    return {
      kind: "error",
      counts,
      message: parts([`sync results could not be persisted (${saveResult.reason})`, countText(counts)]),
    };
  }
  if (counts.conflicted > 0) {
    return {
      kind: "conflict",
      counts,
      message: parts([`${counts.conflicted} file${counts.conflicted === 1 ? "" : "s"} need a manual merge`, countText(counts)]),
    };
  }
  const authN = byKind.get("auth") ?? 0;
  const offlineN = byKind.get("offline") ?? 0;
  if (authN > 0) {
    return {
      kind: "auth",
      counts,
      message: parts([`${authN} mapping${authN === 1 ? "" : "s"} skipped — unlock credentials or add the missing token (Settings → MUGS)`, countText(counts)]),
    };
  }
  if (offlineN > 0) {
    return {
      kind: "offline",
      counts,
      message: parts([`${offlineN} mapping${offlineN === 1 ? "" : "s"} skipped — provider unreachable, will retry automatically`, countText(counts)]),
    };
  }
  const otherSkips = skips.length - authN - offlineN;
  if (otherSkips > 0) {
    return {
      kind: "skipped",
      counts,
      message: parts([`${otherSkips} mapping${otherSkips === 1 ? "" : "s"} skipped`, countText(counts)]),
    };
  }
  const oks = outcomes.filter((o) => o.status === "ok").length;
  if (oks > 0) {
    return {
      kind: "synced",
      counts,
      message: parts([`synced`, countText(counts)]),
    };
  }
  return {
    kind: "idle",
    counts,
    message: parts(["nothing to sync", countText(counts)]),
  };
}

/** Compact count text — counts only, never file names or contents. */
function countText(c: StatusCounts): string {
  const seg: string[] = [];
  if (c.publish) seg.push(`pushed ${c.publish}`);
  if (c.applied) seg.push(`applied ${c.applied}`);
  if (c.deferred) seg.push(`deferred ${c.deferred}`);
  if (c.conflicted) seg.push(`conflicted ${c.conflicted}`);
  if (c.pending) seg.push(`pending ${c.pending}`);
  if (c.failed) seg.push(`failed ${c.failed}`);
  return seg.length > 0 ? seg.join(", ") : "no changes";
}

function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
