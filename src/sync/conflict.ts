/**
 * MUGS — file-level conflict records.
 *
 * A {@link FileConflict} captures the three versions of one diverged file (base +
 * ours + theirs) so it can be persisted durably and resolved later, even across
 * sessions or after a rebase moves the working tree. Resolution picks a winner
 * ("ours" / "theirs" / "both") and records the resulting content; once resolved
 * the mapping is no longer blocked on that file.
 *
 * Pure and dependency-free (like classifier.ts), so it is pinned by tests.
 */
import { classifyFile, type FileDiff } from "./classifier";
import { threeWayMerge } from "./merge";
import type { FileConflict } from "../types";

/** Re-exported so consumers of this module get the record type alongside the helpers. */
export type { FileConflict };

/** How to resolve a conflicting file. */
export type ResolveChoice = "ours" | "theirs" | "both";

/** Build conflict records for every file the classifier labels as divergent. */
export function collectConflicts(diffs: FileDiff[]): FileConflict[] {
  const out: FileConflict[] = [];
  for (const d of diffs) {
    if (classifyFile(d) === "conflict") {
      out.push({ path: d.path, base: d.base, ours: d.local ?? "", theirs: d.remote ?? "" });
    }
  }
  return out;
}

/** Compute the resolved text for a choice. "both" auto-merges when possible and
 * otherwise concatenates ours then theirs (so neither side's content is lost). */
export function resolveConflict(c: FileConflict, choice: ResolveChoice): string {
  switch (choice) {
    case "ours":
      return c.ours;
    case "theirs":
      return c.theirs;
    case "both": {
      const merged = threeWayMerge(c.base ?? "", c.ours, c.theirs);
      return merged.conflict ? [c.ours, c.theirs].join("\n") : merged.content;
    }
  }
}

/** Return a copy of the conflict marked resolved with its resolved content recorded. */
export function applyResolution(c: FileConflict, choice: ResolveChoice): FileConflict {
  return { ...c, resolved: true, resolvedContent: resolveConflict(c, choice) };
}

/** True when the conflict has been resolved. */
export function isResolved(c: FileConflict): boolean {
  return c.resolved === true;
}

/** Only the conflicts that still need resolution. */
export function unresolvedConflicts(conflicts: FileConflict[]): FileConflict[] {
  return conflicts.filter((c) => !isResolved(c));
}

/**
 * Resolve one file's conflict and return the updated list with that entry removed,
 * plus its resolved content. Returns undefined when no conflict for `path` exists so
 * callers can treat an unknown path as a no-op. Pure — performs no I/O.
 */
export function resolveConflictFile(
  conflicts: FileConflict[],
  path: string,
  choice: ResolveChoice,
): { conflicts: FileConflict[]; resolvedContent: string } | undefined {
  const hit = conflicts.find((c) => c.path === path);
  if (!hit) return undefined;
  return {
    conflicts: conflicts.filter((c) => c.path !== path),
    resolvedContent: resolveConflict(hit, choice),
  };
}

/** The three versions of one file to merge. */
export interface FileVersions {
  path: string;
  base?: string;
  ours: string;
  theirs: string;
}

/** A clean (non-conflicting) merged file ready to write into the working tree. */
export interface AppliedFile {
  path: string;
  content: string;
}

/**
 * Merge a set of files at once: divergent files become {@link FileConflict}s, and
 * clean changes (remote-only, or non-overlapping with ours) are returned as
 * {@link AppliedFile}s to write into the working tree. A file whose merged result
 * equals local is a no-op and omitted from `applied`.
 */
export function applyMerge(entries: FileVersions[]): { applied: AppliedFile[]; conflicts: FileConflict[] } {
  const applied: AppliedFile[] = [];
  const conflicts: FileConflict[] = [];
  for (const e of entries) {
    const merged = threeWayMerge(e.base ?? "", e.ours, e.theirs);
    if (merged.conflict) {
      conflicts.push({ path: e.path, base: e.base, ours: e.ours, theirs: e.theirs });
    } else if (merged.content !== e.ours) {
      applied.push({ path: e.path, content: merged.content });
    }
  }
  return { applied, conflicts };
}
