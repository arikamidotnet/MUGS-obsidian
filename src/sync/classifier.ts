/**
 * MUGS — pure 3-way file classifier.
 *
 * The sync contract's heart: given the last-synced baseline and the current
 * local and remote contents of a file, classify what happened to it. This is
 * written as an executable specification independent of the git CLI so the
 * intended behavior is pinned by tests (see the ADL section of the design plan).
 *
 * `undefined` content represents a deletion on that side.
 */

/** The disposition of a single file relative to baseline, local, and remote. */
export type FileChange =
  | "up-to-date" // unchanged on both sides
  | "local" // changed locally only (unpushed)
  | "remote" // changed remotely only (unpulled)
  | "merged" // changed identically on both sides
  | "conflict"; // diverged (both changed differently)

/** Per-file inputs to the classifier. */
export interface FileDiff {
  path: string;
  /** Current local content, or undefined if deleted locally. */
  local?: string;
  /** Current remote content, or undefined if deleted remotely. */
  remote?: string;
  /** Last-synced baseline content, or undefined if the file is new since last sync. */
  base?: string;
}

/** Classify a single file's change relative to baseline/local/remote. */
export function classifyFile(d: FileDiff): FileChange {
  const localChanged = d.local !== d.base;
  const remoteChanged = d.remote !== d.base;

  if (!localChanged && !remoteChanged) return "up-to-date";
  if (localChanged && !remoteChanged) return "local";
  if (!localChanged && remoteChanged) return "remote";

  // Both sides changed relative to baseline.
  return d.local === d.remote ? "merged" : "conflict";
}

/** Classify every file in a diff set, preserving input order. */
export function classifyAll(diffs: FileDiff[]): { path: string; change: FileChange }[] {
  return diffs.map((d) => ({ path: d.path, change: classifyFile(d) }));
}

/** Files that must be pushed (changed locally and not yet reflected remotely). */
export function localChanges(diffs: FileDiff[]): string[] {
  return classifyAll(diffs).filter((c) => c.change === "local").map((c) => c.path);
}

/** Files that diverged and need manual resolution. */
export function conflicts(diffs: FileDiff[]): string[] {
  return classifyAll(diffs).filter((c) => c.change === "conflict").map((c) => c.path);
}
