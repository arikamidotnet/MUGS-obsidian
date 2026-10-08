/**
 * MUGS — safe working-tree applier.
 *
 * Two invariants keep merge/write results from corrupting the working tree:
 *
 *  1. **Ordering.** Writes must materialize parents before children (shallower paths
 *     first) and deletions happen last, so a parent is never removed out from under
 *     its still-being-written children and no orphaned/partial states are left.
 *  2. **No re-entrancy.** A write can itself fire the vault event that triggered sync;
 *     applying the same path twice in flight clobbers in-progress work. {@link ApplyGuard}
 *     serializes per-path so a sync-triggered write never re-enters the driver for a
 *     path already being applied.
 *
 * Both are pure and dependency-free, so they are unit-tested with fakes.
 */

/** A single working-tree operation produced by a merge apply. */
export interface ApplyOp {
  path: string;
  kind: "write" | "delete";
}

/** Path depth = number of `/`-separated segments (a root file is depth 1). */
function depth(path: string): number {
  const norm = path.replace(/\/+$/, "");
  return norm === "" ? 0 : norm.split("/").length;
}

/**
 * Order operations for safe application: all writes before deletes. Within the write
 * phase, shallower paths (parents) come before deeper ones so a parent exists before its
 * children; within the delete phase, deeper paths (children) come first so a folder is
 * never deleted out from under still-present contents. Ties are broken lexicographically
 * for determinism.
 */
export function orderApplyOps(ops: ApplyOp[]): ApplyOp[] {
  const writeKind = (o: ApplyOp): number => (o.kind === "write" ? 0 : 1);
  return [...ops].sort((a, b) => {
    // Writes before deletes...
    const kd = writeKind(a) - writeKind(b);
    if (kd !== 0) return kd;
    // ...writes materialize parents first (shallow -> deep); deletions remove children
    // first (deep -> shallow) so a folder is never deleted out from under its contents.
    const dd = a.kind === "write" ? depth(a.path) - depth(b.path) : depth(b.path) - depth(a.path);
    if (dd !== 0) return dd;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

/**
 * Per-path re-entrancy guard. Track the set of paths currently being applied so a
 * write that itself triggers the sync event cannot apply the same path again in
 * flight (which would clobber the in-progress result). Enter before applying, exit
 * after; {@link isApplying} reports whether a path is mid-application.
 */
export class ApplyGuard {
  private active = new Set<string>();

  /** True when `path` is currently being applied. */
  isApplying(path: string): boolean {
    return this.active.has(path);
  }

  /** Mark `path` as applying; returns true if it was not already active (false = re-entrant). */
  enter(path: string): boolean {
    if (this.active.has(path)) return false;
    this.active.add(path);
    return true;
  }

  /** Mark `path` no longer applying. */
  exit(path: string): void {
    this.active.delete(path);
  }

  /**
   * Apply `fn` for `path` under the guard, returning its result. If `path` is already
   * active (a re-entrant call), `fn` is skipped and `applied` is false so callers can
   * avoid duplicate work / feedback loops.
   */
  async withLock<T>(path: string, fn: () => Promise<T> | T): Promise<{ applied: boolean; result?: T }> {
    if (!this.enter(path)) return { applied: false };
    try {
      const result = await fn();
      return { applied: true, result };
    } finally {
      this.exit(path);
    }
  }

  /** Number of paths currently being applied. */
  get size(): number {
    return this.active.size;
  }
}
