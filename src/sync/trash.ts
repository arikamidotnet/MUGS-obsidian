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

/** In-memory TrashStore for tests and non-Obsidian hosts.
 *  S06: records are VERSIONED by operation/content identity — a second deletion at
 *  the same path appends a new version instead of overwriting the first recovery
 *  copy. get() returns the LATEST version; versionOf() exposes the full history. */
export class MemoryTrashStore implements TrashStore {
  private items = new Map<string, string[]>();

  trash(mappingId: string, relPath: string, content: string | undefined): void {
    const k = key(mappingId, relPath);
    const versions = this.items.get(k) ?? [];
    versions.push(content ?? "");
    this.items.set(k, versions);
  }

  /** Whether a file was trashed for this mapping/path. */
  has(mappingId: string, relPath: string): boolean {
    return this.items.has(key(mappingId, relPath));
  }

  /** The LATEST recorded content (empty string when the original was empty/undefined). */
  get(mappingId: string, relPath: string): string | undefined {
    const versions = this.items.get(key(mappingId, relPath));
    return versions?.[versions.length - 1];
  }

  /** Every recorded version for the path, oldest first (S06: history survives). */
  versionsOf(mappingId: string, relPath: string): string[] {
    return [...(this.items.get(key(mappingId, relPath)) ?? [])];
  }

  /** Remove every trashed file for a mapping after it has been restored. */
  clearMapping(mappingId: string): void {
    for (const k of [...this.items.keys()]) {
      const [mid] = k.split("\u0000");
      if (mid === mappingId) this.items.delete(k);
    }
  }

  /** Number of DISTINCT trashed paths (version history not counted). */
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
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { checkRelPath, joinUnderRoot } from "../git/safePath";

/** S06: versioned on-disk record — `<relPath>.mugs-v<epoch36>-<hash8>` keyed by
 *  operation time + content identity, so a second deletion of the same path can
 *  never overwrite the first recovery copy. */
function versionedName(content: string | undefined): string {
  const h = createHash("sha256").update(content ?? "").digest("hex").slice(0, 8);
  return `.mugs-v${Date.now().toString(36)}-${h}`;
}

export class FileSystemTrashStore implements TrashStore {
  constructor(private readonly root: string) {}

  trash(mappingId: string, relPath: string, content: string | undefined): void {
    const target = `${this.root}/${mappingId}/${relPath}${versionedName(content)}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content ?? "");
  }

  /** Version SUFFIXES for a trashed path (".mugs-v<ts>-<hash>"), oldest first —
   *  each joins directly after <relPath> to form the on-disk record path. */
  private versions(mappingId: string, relPath: string): string[] {
    const dir = `${this.root}/${mappingId}/${dirname(relPath)}`;
    const base = relPath.split("/").pop() ?? relPath;
    try {
      return readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.mugs-v`))
        .map((f) => f.slice(base.length))
        .sort();
    } catch {
      return [];
    }
  }

  /** Read the LATEST recorded content for a trashed file ("" when none was recorded). */
  restore(mappingId: string, relPath: string): string {
    const versions = this.versions(mappingId, relPath);
    if (versions.length === 0) return "";
    try {
      return readFileSync(`${this.root}/${mappingId}/${relPath}${versions[versions.length - 1]}`, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * S06 restore: write the latest recovery copy back to `<destRoot>/<relPath>`.
   * Containment is by construction (joinUnderRoot on a safePath-validated rel) and
   * an EXISTING destination file is never clobbered without explicit intent
   * (`overwrite: true`). Returns a typed result for the caller to surface.
   */
  restoreTo(
    mappingId: string,
    relPath: string,
    destRoot: string,
    opts: { overwrite?: boolean } = {},
  ): { ok: true; dest: string } | { ok: false; reason: "unsafe-path" | "no-version" | "target-exists"; detail?: string } {
    const safe = checkRelPath(relPath);
    if (!safe.ok) return { ok: false, reason: "unsafe-path", detail: safe.reason };
    const versions = this.versions(mappingId, relPath);
    if (versions.length === 0) return { ok: false, reason: "no-version" };
    const joined = joinUnderRoot(destRoot, relPath);
    if (!joined.ok) return { ok: false, reason: "unsafe-path", detail: joined.reason };
    const dest = joined.value;
    if (!opts.overwrite && existsSync(dest)) return { ok: false, reason: "target-exists" };
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, this.restore(mappingId, relPath));
    return { ok: true, dest };
  }

  /** Remove a mapping's trashed files (e.g. after an explicit restore). */
  clearMapping(mappingId: string): void {
    rmSync(`${this.root}/${mappingId}`, { recursive: true, force: true });
  }
}
