/**
 * MUGS — editor-open write-back guard (pure).
 *
 * Obsync's core lesson: never overwrite a file that is currently open in an editor with
 * unsaved changes, or the user's in-progress edit is lost when sync applies a remote/merge
 * result. This module encodes that rule as a pure predicate plus a per-path guard class so
 * it can be unit-tested without Obsidian; `main.ts` supplies the live set of open leaves
 * (with unsaved changes) and feeds it in.
 */

/**
 * True when writing `path` into the working tree is safe — i.e. the file is NOT open in an
 * editor with unsaved changes (the `openEditors === 0` rule, generalized to a path set).
 */
export function isWriteSafe(path: string, openWithUnsaved: ReadonlySet<string>): boolean {
  return !openWithUnsaved.has(path);
}

/**
 * Per-path guard tracking which paths are currently open with unsaved changes. Mirrors the
 * {@link ApplyGuard} model (per-path re-entrancy) so the sync layer reasons about "is this
 * path safe to write" the same way it reasons about "is this path mid-application".
 */
export class EditorOpenGuard {
  private open = new Set<string>();

  constructor(paths: Iterable<string> = []) {
    for (const p of paths) this.open.add(p);
  }

  /** Mark `path` as open with unsaved changes. */
  track(path: string): void {
    this.open.add(path);
  }

  /** Clear the open-with-unsaved-changes state for `path`. */
  untrack(path: string): void {
    this.open.delete(path);
  }

  /** True when `path` is open with unsaved changes. */
  isOpenWithUnsaved(path: string): boolean {
    return this.open.has(path);
  }

  /** True when writing `path` into the working tree will not clobber an in-progress edit. */
  isWriteSafe(path: string): boolean {
    return !this.open.has(path);
  }

  /** Number of paths currently tracked as open-with-unsaved-changes. */
  get size(): number {
    return this.open.size;
  }
}
