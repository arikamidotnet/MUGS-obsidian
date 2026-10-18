/**
 * MUGS — recoverable deletion log (`.mugs-trash`).
 *
 * Mirrors the jj/GitButler idea that a deletion is not a loss: before any file is
 * removed from a clone's working tree during sync, its content is recorded here so
 * the deletion is reversible and we can tell an auto-removal apart from a user delete.
 *
 * Pure and dependency-free (like MemoryIO / WorkingTreeWriter) so it is unit-tested
 * with fakes; `main.ts` supplies a filesystem-backed implementation rooted at
 * `<clone>/.mugs-trash/<mapping>/<path>`.
 */

/** Where a trashed file lives inside a clone, keyed by mapping id and repo-relative path. */
export function trashPath(cloneDir: string, mappingId: string, relPath: string): string {
  return `${cloneDir}/.mugs-trash/${mappingId}/${relPath}`;
}

/** Records a file's content before it is removed from the working tree. */
export interface TrashStore {
  /**
   * Record `content` (or undefined for an already-empty record) under its mapping +
   * repo-relative path so a later deletion can be restored. Called immediately before
   * the file is actually removed from the clone's working tree.
   */
  trash(mappingId: string, relPath: string, content: string | undefined): void;
}

/** In-memory TrashStore for tests and non-Obsidian hosts. */
export class MemoryTrashStore implements TrashStore {
  private items = new Map<string, string>();

  trash(mappingId: string, relPath: string, content: string | undefined): void {
    this.items.set(key(mappingId, relPath), content ?? "");
  }

  /** Whether a file was trashed for this mapping/path. */
  has(mappingId: string, relPath: string): boolean {
    return this.items.has(key(mappingId, relPath));
  }

  /** The recorded content (empty string when the original was empty/undefined). */
  get(mappingId: string, relPath: string): string | undefined {
    return this.items.get(key(mappingId, relPath));
  }

  /** Remove every trashed file for a mapping after it has been restored. */
  clearMapping(mappingId: string): void {
    for (const k of [...this.items.keys()]) {
      const [mid] = k.split("\u0000");
      if (mid === mappingId) this.items.delete(k);
    }
  }

  /** Number of trashed files. */
  get size(): number {
    return this.items.size;
  }
}

function key(mappingId: string, relPath: string): string {
  return `${mappingId}\u0000${relPath}`;
}

/**
 * Filesystem-backed TrashStore rooted at `<cloneRoot>/.mugs-trash`. Records each trashed
 * file at `.mugs-trash/<mappingId>/<relPath>` so a sync-driven deletion is recoverable.
 * Synchronous writes (matching the {@link TrashStore} contract) keep the record in place
 * before the corresponding working-tree removal, avoiding a delete/record race. Uses the
 * Node `fs` API, available in the Obsidian/Electron runtime (as `node:child_process` already
 * is in git/runner.ts).
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export class FileSystemTrashStore implements TrashStore {
  constructor(private readonly root: string) {}

  trash(mappingId: string, relPath: string, content: string | undefined): void {
    const target = `${this.root}/${mappingId}/${relPath}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content ?? "");
  }

  /** Read the recorded content for a trashed file (empty string when none was recorded). */
  restore(mappingId: string, relPath: string): string {
    try {
      return readFileSync(`${this.root}/${mappingId}/${relPath}`, "utf8");
    } catch {
      return "";
    }
  }

  /** Remove a mapping's trashed files (e.g. after an explicit restore). */
  clearMapping(mappingId: string): void {
    rmSync(`${this.root}/${mappingId}`, { recursive: true, force: true });
  }
}
