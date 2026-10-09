/**
 * MUGS — conflict action labels (pure).
 *
 * Turns a raw {@link FileConflict} into human-readable "what each side did"
 * descriptions, in the spirit of Manyana's diff view where you see
 * "ours modified (+2 −1)" instead of two opaque blobs. Pure and dependency-free:
 * pinned by contract tests so the sidebar panel can render labels without knowing
 * how they were computed.
 */

import type { FileConflict } from "./conflict";

export interface ConflictAction {
  /** Which side this describes. */
  side: "ours" | "theirs";
  /** The operation the side performed relative to the base, if any. */
  verb: "added" | "removed" | "modified" | "deleted" | "unchanged";
  /** Human description, e.g. "modified (added 2, removed 1)". */
  detail: string;
}

/** Split content into lines; a deletion (undefined) yields no lines. */
function lines(content?: string): string[] {
  if (content === undefined || content === null) return [];
  return content.split("\n");
}

/** Approximate added/removed line counts between base and side via set difference. */
function delta(baseLines: string[], sideLines: string[]): { added: number; removed: number } {
  const base = new Set(baseLines);
  const added = sideLines.filter((l) => !base.has(l)).length;
  const removed = baseLines.filter((l) => !sideLines.includes(l)).length;
  return { added, removed };
}

/**
 * Describe what each side did to a conflict so the human sees the operation rather
 * than two opaque blobs. Pure and deterministic — pinned by tests.
 */
export function describeConflictActions(c: FileConflict): { ours: ConflictAction; theirs: ConflictAction } {
  const baseLines = lines(c.base);

  const forSide = (side: "ours" | "theirs", absent: boolean, content?: string): ConflictAction => {
    if (absent) return { side, verb: "deleted", detail: "deleted the file" };
    const { added, removed } = delta(baseLines, lines(content));
    if (added === 0 && removed === 0) return { side, verb: "unchanged", detail: "no change vs base" };
    if (removed === 0) return { side, verb: "added", detail: `added ${added} line${added === 1 ? "" : "s"}` };
    if (added === 0) return { side, verb: "removed", detail: `removed ${removed} line${removed === 1 ? "" : "s"}` };
    return { side, verb: "modified", detail: `modified (added ${added}, removed ${removed})` };
  };

  return {
    ours: forSide("ours", !!c.oursAbsent, c.ours),
    theirs: forSide("theirs", !!c.theirsAbsent, c.theirs),
  };
}
