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

/**
 * Build conflict records for every file that genuinely diverges. Uses the same
 * {@link threeWayMerge} verdict as the sync driver, so a modify/delete or
 * delete/delete (which resolve cleanly) is NOT surfaced as a content conflict —
 * only overlapping add/add or edit/edit conflicts appear here.
 */
export function collectConflicts(diffs: FileDiff[]): FileConflict[] {
  const out: FileConflict[] = [];
  for (const d of diffs) {
    const m = threeWayMerge(d.base, d.local, d.remote);
    if (m.conflict) {
      out.push({
        path: d.path,
        base: d.base,
        ours: d.local ?? "",
        theirs: d.remote ?? "",
        ...(d.local === undefined ? { oursAbsent: true } : {}),
        ...(d.remote === undefined ? { theirsAbsent: true } : {}),
      });
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

/** The three versions of one file to merge. `undefined` ours/theirs is a deletion. */
export interface FileVersions {
  path: string;
  base?: string;
  /** Current local ("ours") content, or undefined if deleted locally. */
  ours?: string;
  /** Current remote ("theirs") content, or undefined if deleted remotely. */
  theirs?: string;
}

/** A clean (non-conflicting) merged file ready to write into the working tree. */
export interface AppliedFile {
  path: string;
  content: string;
}

/** A file that both sides deleted — recorded so the driver removes it from the working tree. */
export interface AppliedDelete {
  path: string;
}

/** The result of applying a merge set: files to write and/or deletions to perform. */
export type AppliedChange = AppliedFile | AppliedDelete;

/**
 * Merge a set of files at once: divergent files become {@link FileConflict}s, and
 * clean changes (remote-only, or non-overlapping with ours) are returned as
 * {@link AppliedFile}s to write into the working tree. A file whose merged result
 * equals local is a no-op and omitted from `applied`.
 */
export function applyMerge(entries: FileVersions[]): { applied: AppliedChange[]; conflicts: FileConflict[] } {
  const applied: AppliedChange[] = [];
  const conflicts: FileConflict[] = [];
  for (const e of entries) {
    const merged = threeWayMerge(e.base, e.ours, e.theirs);
    if (merged.conflict) {
      // Genuine overlap conflict — capture absent flags so the diff view can render deletes.
      conflicts.push({
        path: e.path,
        base: e.base,
        ours: e.ours ?? "",
        theirs: e.theirs ?? "",
        ...(e.ours === undefined ? { oursAbsent: true } : {}),
        ...(e.theirs === undefined ? { theirsAbsent: true } : {}),
      });
    } else if (merged.oursAbsent && merged.theirsAbsent) {
      // Both sides deleted the file -> record a deletion to apply.
      applied.push({ path: e.path });
    } else if (merged.content !== (e.ours ?? "")) {
      applied.push({ path: e.path, content: merged.content });
    }
  }
  return { applied, conflicts };
}
