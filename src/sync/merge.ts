/**
 * MUGS — pure 3-way file content merge.
 *
 * Given the last-synced baseline and the current local ("ours") and remote
 * ("theirs") contents of a file, produce a single merged text: edits that only
 * one side made are taken automatically; identical edits collapse to one; edits
 * that overlap on both sides are left as git-style conflict markers for the user
 * to resolve. This is a line-level diff3 implementation — non-overlapping edits
 * from each side merge cleanly, so two users touching different parts of the same
 * file do not spuriously conflict.
 *
 * Written as an executable spec independent of the git CLI (like classifier.ts)
 * so the intended behavior is pinned by tests. Content is `string | undefined`;
 * `undefined` is a deletion (jj `None`), strictly distinct from an empty file (`""`).
 * {@link threeWayMerge} resolves every delete case deterministically; the line-level
 * {@link textMerge}/diff3 walk only ever sees present contents.
 */
import { classifyFile, type FileDiff } from "./classifier";

/** Outcome of merging one file: the merged text plus whether it needs resolution. */
export interface MergeResult {
  /** Merged text; contains conflict markers when `conflict` is true. An empty string
   *  means "no content" — distinguish it from a deletion using the absent flags below. */
  content: string;
  /** True when local and remote diverged on overlapping lines (needs manual resolve). */
  conflict: boolean;
  /** True when the baseline was absent (file new since last sync). */
  baseAbsent?: boolean;
  /** True when the local side is a deletion — distinct from an empty file, which is "". */
  oursAbsent?: boolean;
  /** True when the remote side is a deletion. */
  theirsAbsent?: boolean;
}

/** A single merged region emitted by the diff3 walk. */
type Chunk =
  | { type: "context" | "merge"; lines: string[] }
  | { type: "conflict"; ours: string[]; theirs: string[] };

interface Anchor {
  base: number;
  ours: number;
  theirs: number;
}

/** Split text into lines. Splitting/joining on "\n" round-trips exactly (no data loss). */
function splitLines(text: string): string[] {
  return text.split("\n");
}

const joinLines = (lines: string[]): string => lines.join("\n");

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Longest common subsequence between two line arrays, returned as pairs of
 * matching indices [i in x, j in y], sorted increasingly on both axes. O(n*m).
 */
function lcsPairs(x: string[], y: string[]): Array<[number, number]> {
  const n = x.length;
  const m = y.length;
  // dp[i][j] = LCS length of x[i:] and y[j:]. Filled bottom-up.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * From base-matched candidates (base line matched in both ours and theirs), pick
 * the maximal set that stays strictly increasing on all three axes. Ours and base
 * indices are already strictly increasing across candidates, so this is a longest
 * strictly-increasing-subsequence on the theirs index.
 */
function pickAnchors(candidates: Anchor[]): Anchor[] {
  const n = candidates.length;
  if (n === 0) return [];
  const t = candidates.map((c) => c.theirs);
  // lower_bound: first index whose value >= target -> gives strictly increasing LIS.
  const lowerBound = (arr: number[], target: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const tailsIdx: number[] = []; // tailsIdx[l] = candidate index ending a length-(l+1) increasing run
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const pos = lowerBound(tailsIdx, t[i]);
    if (pos > 0) prev[i] = tailsIdx[pos - 1];
    if (pos === tailsIdx.length) tailsIdx.push(i);
    else tailsIdx[pos] = i;
  }
  const result: Anchor[] = [];
  let k = tailsIdx.length > 0 ? tailsIdx[tailsIdx.length - 1] : -1;
  while (k >= 0) {
    result.push(candidates[k]);
    k = prev[k];
  }
  result.reverse();
  return result;
}

/** Classify the region between two anchors and choose what to keep. */
function classifyRegion(base: string[], ours: string[], theirs: string[]): Chunk | null {
  if (base.length === 0 && ours.length === 0 && theirs.length === 0) return null;
  // Both sides unchanged relative to baseline -> nothing new here.
  if (arraysEqual(ours, base) && arraysEqual(theirs, base)) return null;
  // Only theirs changed -> take theirs.
  if (arraysEqual(ours, base)) return { type: "merge", lines: theirs };
  // Only ours changed -> take ours.
  if (arraysEqual(theirs, base)) return { type: "merge", lines: ours };
  // Both sides made the identical change -> collapse to one copy.
  if (arraysEqual(ours, theirs)) return { type: "merge", lines: ours };
  // Genuine overlap conflict.
  return { type: "conflict", ours, theirs };
}

/** Run the diff3 walk over three line arrays and emit merged chunks. */
export function diff3Chunks(base: string[], ours: string[], theirs: string[]): Chunk[] {
  const baseOurs = lcsPairs(base, ours);
  const baseTheirs = lcsPairs(base, theirs);
  const theirsByBase = new Map(baseTheirs.map(([b, t]) => [b, t] as const));

  // Base lines matched in both ours and theirs are candidate stable anchors.
  const candidates: Anchor[] = [];
  for (const [b, o] of baseOurs) {
    const t = theirsByBase.get(b);
    if (t !== undefined) candidates.push({ base: b, ours: o, theirs: t });
  }
  const anchors = pickAnchors(candidates);

  const chunks: Chunk[] = [];
  let cb = -1;
  let co = -1;
  let ct = -1;
  const sentinels: Anchor[] = [...anchors, { base: base.length, ours: ours.length, theirs: theirs.length }];
  for (const a of sentinels) {
    const region = classifyRegion(base.slice(cb + 1, a.base), ours.slice(co + 1, a.ours), theirs.slice(ct + 1, a.theirs));
    if (region) chunks.push(region);
    // Emit the anchor's shared line as context (skip the trailing sentinel).
    const isSentinel = a.base === base.length && a.ours === ours.length && a.theirs === theirs.length;
    if (!isSentinel) chunks.push({ type: "context", lines: [base[a.base]] });
    cb = a.base;
    co = a.ours;
    ct = a.theirs;
  }
  return chunks;
}

/** Render merged chunks into a single text string (conflict regions get markers). */
function renderChunks(chunks: Chunk[]): string {
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "conflict") {
      out.push(`<<<<<<< ours`, ...chunk.ours, "=======", ...chunk.theirs, ">>>>>>> theirs");
    } else {
      out.push(...chunk.lines);
    }
  }
  return joinLines(out);
}

/**
 * Pure line-level diff3 over three present contents. `base` may be "" (used as the
 * empty baseline when both sides add a brand-new file). This never sees deletions —
 * {@link threeWayMerge} resolves delete cases before delegating here.
 */
function textMerge(base: string, ours: string, theirs: string): MergeResult {
  if (base === "" && ours === "" && theirs === "") return { content: "", conflict: false };
  const chunks = diff3Chunks(splitLines(base), splitLines(ours), splitLines(theirs));
  const content = renderChunks(chunks);
  const conflict = chunks.some((c) => c.type === "conflict");
  return { content, conflict };
}

/**
 * Merge one file's contents (baseline + local + remote) into a single text.
 *
 * Content is `string | undefined`; `undefined` is a **deletion** (jj `None`),
 * strictly distinct from an empty file (`""`). This resolves every delete case
 * deterministically so the sync layer never emits a false content conflict on a
 * delete:
 *
 * - delete/delete                 -> the file stays deleted (both absent)
 * - modify/delete (either side)   -> keep the surviving/modifying side's content
 * - new-file add/add              -> identical collapses; overlapping-different conflicts
 * - new-file delete/add           -> keep the addition
 * - pre-existing, both present    -> normal line-level diff3 merge
 */
export function threeWayMerge(
  base: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
): MergeResult {
  const baseAbsent = base === undefined;
  const oursAbsent = ours === undefined;
  const theirsAbsent = theirs === undefined;
  const deleted = (): MergeResult => ({ content: "", conflict: false, baseAbsent, oursAbsent, theirsAbsent });

  // Nothing on any side -> the file is gone.
  if (baseAbsent && oursAbsent && theirsAbsent) return deleted();
  // Both sides deleted a pre-existing file -> stays deleted.
  if (!baseAbsent && oursAbsent && theirsAbsent) return deleted();

  // modify/delete: one side kept/modified the pre-existing file, the other deleted it.
  // Keep the surviving content (less lossy than a deletion); never conflict.
  if (!baseAbsent && oursAbsent && !theirsAbsent) {
    return { content: theirs!, conflict: false, baseAbsent: false, oursAbsent: true, theirsAbsent: false };
  }
  if (!baseAbsent && !oursAbsent && theirsAbsent) {
    return { content: ours!, conflict: false, baseAbsent: false, oursAbsent: false, theirsAbsent: true };
  }

  // File new since last sync (baseline absent).
  if (baseAbsent) {
    // One side deleted the new file, the other has it -> keep the content.
    if (oursAbsent && theirs !== undefined) return { content: theirs, conflict: false, baseAbsent: true, oursAbsent: true, theirsAbsent: false };
    if (ours !== undefined && theirsAbsent) return { content: ours, conflict: false, baseAbsent: true, oursAbsent: false, theirsAbsent: true };
    // Both have it -> add/add: identical collapses to one; overlapping-different conflicts.
    if (ours !== undefined && theirs !== undefined) {
      const m = textMerge("", ours, theirs);
      return { ...m, baseAbsent: true, oursAbsent: false, theirsAbsent: false };
    }
    // New file, both deleted -> gone.
    return deleted();
  }

  // Pre-existing file, both present -> normal line-level merge. All undefined cases
  // above are exhausted, so base/ours/theirs are non-undefined here.
  const m = textMerge(base!, ours!, theirs!);
  return { ...m, baseAbsent: false, oursAbsent: false, theirsAbsent: false };
}

/** Merge every file in a diff set, preserving input order. */
export function mergeAll(diffs: FileDiff[]): Array<{ path: string; content: string; conflict: boolean }> {
  return diffs.map((d) => {
    // Preserve undefined (deletion) so delete cases resolve via threeWayMerge semantics.
    const merged = threeWayMerge(d.base, d.local, d.remote);
    return { path: d.path, content: merged.content, conflict: merged.conflict };
  });
}

/** Re-export for callers that want a single classification-consistent label. */
export { classifyFile };
