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
  blocked: number;   // files or mapping transactions awaiting a safe retry/review
}

/** Distinct terminal status kinds — each maps to its own user-facing message. */
export type ReportKind =
  | "pending"
  | "blocked"
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
  // Provider API errors (surfaced verbatim from the driver, e.g. "provider API
  // 401 error …" / "GitHub 403 error fetching repository …"): 401/403 are
  // credential problems (fix the token/scope), 429/5xx are retryable (rate
  // limit / server-side) — both distinct from a plain network outage. The
  // status code is anchored to the "API/GitHub/GitLab <code>" prefix so a repo
  // named e.g. "issue-401" in a 404 message is not misread as an auth error.
  if (/(api|github|gitlab) (401|403)\b/.test(r)) return "auth";
  // Remote Git auth rejections ("git fetch failed (128): remote: HTTP Basic:
  // Access denied / Authentication failed") contain "fetch failed", so check
  // them BEFORE the generic network-fetch fallback.
  if (r.includes("access denied") || r.includes("authentication failed") || r.includes("token rejected")) return "auth";
  if (/(api|github|gitlab) (429|5\d\d)\b/.test(r)) return "offline";
  if (r.includes("reach provider") || r.includes("network") || r.includes("offline") || r.includes("timeout") || r.includes("fetch failed")) return "offline";
  // Covers "missing token", "token missing on this device — …", "OAuth session
  // expired", and "no credential": every device-local token/grant gap is an auth problem.
  if (
    r.includes("token") ||
    r.includes("credential") ||
    r.includes("auth") ||
    r.includes("oauth") ||
    r.includes("session expired") ||
    r.includes("locked")
  ) return "auth";
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
    publish: outcomes.reduce((n, o) => n + (o.counts?.publish ?? (o.push === true ? 1 : 0)), 0),
    applied: outcomes.reduce((n, o) => n + (o.counts?.apply ?? (o.status === "ok" && o.pull !== undefined && o.pull !== "none" ? 1 : 0)), 0),
    deferred: outcomes.reduce((n, o) => n + (o.counts?.deferred ?? 0), 0),
    conflicted: outcomes.reduce((n, o) => n + Math.max(o.counts?.conflicted ?? 0, o.conflicts?.length ?? 0), 0),
    failed: Math.max(outcomes.reduce((n, o) => n + (o.pendingFailures ?? 0), 0), pendingOps?.filter(o => o.state === "failed").length ?? 0),
    pending: pendingOps?.length ?? 0,
    blocked: outcomes.reduce((n, o) => n + Math.max(o.blocked?.length ?? 0, o.status === "blocked" ? 1 : 0), 0),
  };

  const skips = outcomes.filter((o) => o.status === "skipped");
  const byKind = new Map<ReportKind, number>();
  for (const s of skips) {
    const kind = classifySkipReason(s.reason);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    counts.failed += 1;
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
    // Distinguish a token actively rejected by the remote (HTTP Basic: Access
    // denied / 401 / 403 / missing write_repository scope) from a locally
    // missing or passphrase-locked token so the notice points at the real fix.
    const authSkips = skips.filter((s) => classifySkipReason(s.reason) === "auth");
    const allRejectedByRemote = authSkips.length > 0 && authSkips.every((s) => {
      const r = (s.reason ?? "").toLowerCase();
      return (
        r.includes("access denied") ||
        r.includes("authentication failed") ||
        r.includes("token rejected") ||
        /(api|github|gitlab) (401|403)\b/.test(r)
      );
    });
    const detail = allRejectedByRemote
      ? `${authN} mapping${authN === 1 ? "" : "s"} skipped — token rejected by remote (expired or missing read_repository/write_repository scope) — update or reconnect in Settings → MUGS → Accounts`
      : `${authN} mapping${authN === 1 ? "" : "s"} skipped — token missing: unlock credentials, or re-enter the token in Settings → MUGS → Accounts (locked tokens unlock under Security)`;
    return {
      kind: "auth",
      counts,
      message: parts([detail, countText(counts)]),
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
  if (counts.blocked > 0 || outcomes.some(o => o.kind === "blocked")) {
    return { kind: "blocked", counts, message: parts(["changes blocked — retry or review required", countText(counts)]) };
  }
  if (counts.pending > 0 || counts.deferred > 0 || counts.failed > 0 || outcomes.some(o => o.kind === "retry-pending")) {
    return { kind: "pending", counts, message: parts(["changes pending — not fully synced", countText(counts)]) };
  }
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

/** Advisory Notice lines for ok-mappings that finished with blocked files.
 *  Review-queue blocks (unknown remote-only, withheld deletions, unverified
 *  content) point at Review; binary-content blocks never create review entries,
 *  so they get wording that says what happened instead of pointing at an empty
 *  queue. Counts and labels only — never file names or contents. */
export function advisoryNotices(outcomes: SyncOutcome[]): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    const blocked = o.blocked ?? [];
    if (o.status !== "ok" || blocked.length === 0) continue;
    const n = blocked.length;
    const binary = blocked.filter((b) => /binary/i.test(b.reason ?? "")).length;
    const files = `${n} file${n === 1 ? "" : "s"}`;
    if (binary === n) {
      lines.push(`MUGS — ${o.label}: ${files} not synced — binary content is excluded from text sync.`);
    } else if (binary > 0) {
      lines.push(`MUGS — ${o.label}: ${files} left unchanged for safety (${binary} binary, excluded from text sync). Open "Review repository files" to decide the rest.`);
    } else {
      lines.push(`MUGS — ${o.label}: ${files} left unchanged for safety. Open "Review repository files" to decide.`);
    }
  }
  return lines;
}

/** Compact count text — counts only, never file names or contents. */
function countText(c: StatusCounts): string {
  const seg: string[] = [];
  if (c.publish) seg.push(`pushed ${c.publish}`);
  if (c.applied) seg.push(`applied ${c.applied}`);
  if (c.deferred) seg.push(`deferred ${c.deferred}`);
  if (c.conflicted) seg.push(`conflicted ${c.conflicted}`);
  if (c.pending) seg.push(`pending ${c.pending}`);
  if (c.blocked) seg.push(`blocked ${c.blocked}`);
  if (c.failed) seg.push(`failed ${c.failed}`);
  return seg.length > 0 ? seg.join(", ") : "no changes";
}

function describeThrown(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
