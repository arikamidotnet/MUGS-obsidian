import type { MugsSettings, LastSyncState } from "../types";
import type { SaveResult } from "../store";
import type { ReconciliationReviewRow } from "../ui/reconciliationReview";
import { gitBlobId } from "../sync/reconciliation";
import { checkRelPath } from "../git/safePath";

export const BULK_LIMIT = 500;
export const CATEGORY_LABELS = {
  exact: "Exact-content duplicate / move candidates",
  filename: "Filename-only candidates",
  unmatched: "No matching vault file",
  inconclusive: "Inconclusive scan",
} as const;
export type ReviewCategory = keyof typeof CATEGORY_LABELS;
export interface CategorizedReview {
  row: ReconciliationReviewRow;
  category: ReviewCategory;
  matches: string[];
  matchCount: number;
}
export interface ReviewAnalysis {
  entries: CategorizedReview[];
  scanned: number;
  skipped: number;
}
export interface BulkResult {
  rows: { row: ReconciliationReviewRow; status: "applied" | "requeued" | "pending" }[];
  persisted: boolean;
}

/** Current bytes only; no remote reads, settings writes, or inferred ownership. */
export async function analyzeReview(
  rows: ReconciliationReviewRow[],
  files: { path: string; size: number }[],
  read: (path: string) => Promise<string>,
  signal?: AbortSignal,
  limits = { files: 10000, fileBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 },
): Promise<ReviewAnalysis> {
  const hashes = new Map<string, string[]>();
  const names = new Map<string, string[]>();
  const lengths = new Set(rows.map(row => row.blob.length));
  let scanned = 0, skipped = 0, bytes = 0;
  const add = (index: Map<string, string[]>, key: string, path: string) => {
    const paths = index.get(key) ?? [];
    paths.push(path);
    index.set(key, paths);
  };
  const seen = new Set<string>();
  for (const file of files) {
    signal?.throwIfAborted();
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    if (!checkRelPath(file.path).ok || file.path.split("/").some(part => part.startsWith("."))) {
      skipped++;
      continue;
    }
    add(names, file.path.slice(file.path.lastIndexOf("/") + 1), file.path);
    if (scanned >= limits.files || !Number.isFinite(file.size) || file.size < 0 ||
        file.size > limits.fileBytes || bytes + file.size > limits.totalBytes) {
      skipped++;
      continue;
    }
    scanned++;
    // Count attempted reads too: repeated failures cannot evade the scan budget.
    bytes += file.size;
    try {
      const content = await read(file.path);
      signal?.throwIfAborted();
      const size = Buffer.byteLength(content, "utf8");
      if (size > limits.fileBytes || bytes + Math.max(0, size - file.size) > limits.totalBytes || content.includes("\0")) {
        skipped++;
        continue;
      }
      bytes += Math.max(0, size - file.size);
      for (const length of lengths) add(hashes, gitBlobId(content, length), file.path);
    } catch {
      signal?.throwIfAborted();
      skipped++;
    }
    // Yield to the host so cancel/close can interrupt even cached adapter reads.
    if (scanned % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return {
    scanned, skipped,
    entries: rows.map(row => {
      const exact = hashes.get(row.blob) ?? [];
      const filename = names.get(row.path.slice(row.path.lastIndexOf("/") + 1)) ?? [];
      const matches = exact.length ? exact : filename;
      return {
        row: { ...row },
        category: exact.length ? "exact" : filename.length ? "filename" : skipped ? "inconclusive" : "unmatched",
        matches: matches.slice(0, 20),
        matchCount: matches.length,
      };
    }),
  };
}

/** Non-secret shape captured at render: catches edits before the next engine fingerprint refresh. */
export function reviewConfig(settings: MugsSettings, id: string): string {
  const mapping = settings.mappings.find(m => m.id === id);
  const credential = settings.credentials.find(c => c.id === mapping?.providerId);
  return JSON.stringify({
    mapping, config: settings.sync.obsidianConfig,
    provider: credential && { id: credential.id, kind: credential.kind, baseUrl: credential.baseUrl, repos: credential.repos },
  });
}

export interface BulkDecisionDeps {
  getSettings: () => MugsSettings;
  setLastSync: (state: LastSyncState) => void;
  save: () => Promise<SaveResult>;
  acquire: () => (() => void);
  sync: (mappingId: string) => Promise<boolean>;
  verify: (rows: ReconciliationReviewRow[], action: "delete" | "recover") => Promise<Set<string>>;
}

/** One mapping, one durable intent save, one engine pass. Never sync per file. */
export async function decideReviewBatch(
  deps: BulkDecisionDeps,
  input: ReconciliationReviewRow[],
  action: "delete" | "recover",
  expectedConfig: string,
): Promise<BulkResult> {
  const release = deps.acquire();
  try {
    const rows = input.map(row => ({ ...row }));
    if (!rows.length || rows.length > BULK_LIMIT) throw new Error(`choose 1–${BULK_LIMIT} files`);
    if (action !== "delete" && action !== "recover") throw new Error("invalid review action");
    const settings = deps.getSettings();
    const id = rows[0].mappingId;
    const mapping = settings.mappings.find(m => m.id === id);
    const before = settings.lastSync[id];
    const state = before?.reconciliation;
    if (!mapping || !state || reviewConfig(settings, id) !== expectedConfig) {
      throw new Error("the connection changed — refresh review");
    }
    if (action === "delete" && mapping.direction === "pull-only") throw new Error("Download only cannot delete repository files");
    if (Object.keys(state.decisions).length) throw new Error("this folder has pending decisions — complete sync before retrying");
    const paths = new Set<string>();
    for (const row of rows) {
      const entry = state.review[row.path];
      if (row.mappingId !== id || paths.has(row.path) || !checkRelPath(row.path).ok ||
          row.fingerprint !== state.fingerprint || row.direction !== mapping.direction ||
          row.ref !== rows[0].ref || !entry || entry.ref !== row.ref || entry.blob !== row.blob) {
        throw new Error("the review changed — refresh and preview a new batch");
      }
      paths.add(row.path);
    }
    const decisions = { ...state.decisions };
    for (const row of rows) decisions[row.path] = { ref: row.ref, blob: row.blob, action };
    deps.setLastSync({ ...before, reconciliation: { ...state, decisions } });
    try {
      const saved = await deps.save();
      if (!saved.ok) throw new Error("could not persist decisions — nothing was applied");
    } catch (error) {
      // Remove unsaved intent so a later scheduler pass cannot apply it.
      const current = deps.getSettings().lastSync[id];
      if (current?.reconciliation) {
        deps.setLastSync({ ...current, reconciliation: { ...current.reconciliation, decisions: state.decisions } });
      }
      throw error;
    }
    const persisted = await deps.sync(id);
    const after = deps.getSettings().lastSync[id]?.reconciliation;
    let verified = new Set<string>();
    if (after?.fingerprint === state.fingerprint) {
      try { verified = await deps.verify(rows, action); } catch { /* No evidence is not success. */ }
    }
    return {
      persisted,
      rows: rows.map(row => ({
        row,
        status: !after || after.fingerprint !== state.fingerprint || after.decisions[row.path]
          ? "pending" : after.review[row.path] ? "requeued" : verified.has(row.path) ? "applied" : "pending",
      })),
    };
  } finally {
    release();
  }
}
