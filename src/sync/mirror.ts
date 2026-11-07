/**
 * MUGS — vault↔clone content mirror (pure planning).
 *
 * The sync engine moves content between the remote repo and the mapping's clone
 * (git), and between the clone and the mapping's vault folder (this module's
 * plans, applied by CloneManager through injected FS seams). Planning is pure:
 * given a snapshot of both sides it emits an ordered op list, so every rule —
 * path mapping, scoping, deletions, the empty-vault safety guard — is pinned by
 * unit tests without touching git or the filesystem.
 *
 * Path convention: `FolderMapping.remotePath` is the repo-side subtree root and
 * `localFolder` the vault-side root; a vault file `localFolder/A/B.md` mirrors
 * to the repo path `remotePath/A/B.md` (an unscoped mapping with `remotePath
 * ""` maps the vault folder onto the repo root).
 */
import type { FolderMapping } from "../types";
import { isInScope, normalizePath, normalizeRemotePath } from "./exclusion";
import { orderApplyOps } from "./applier";

/** One side's view of a file: its path within that side's root plus content. */
export interface MirrorFile {
  path: string;
  content: string;
}

/** A planned mirror operation. `path` is relative to the destination side's root. */
export interface MirrorOp {
  path: string;
  kind: "write" | "delete";
  content?: string;
}

/** Result of planning a mirror pass: ordered ops plus guard flags. */
export interface MirrorPlan {
  ops: MirrorOp[];
  /**
   * True when the plan was refused: the vault side is empty, so mirroring would
   * either push nothing over a populated remote (first init) or mirror-delete
   * the whole remote subtree (regular sync). Callers must surface this instead
   * of applying anything.
   */
  refused: boolean;
}

/** Map a vault-folder-relative path to its repo-relative mirror path. */
export function vaultToRepoPath(mapping: Pick<FolderMapping, "remotePath">, vaultRel: string): string {
  const rp = normalizeRemotePath(mapping.remotePath);
  const rel = normalizePath(vaultRel);
  return rp ? `${rp}/${rel}` : rel;
}

/**
 * Map a repo-relative path back to its vault-folder-relative path, or null when
 * the path lies outside the mapping's remotePath subtree (or is the subtree root
 * itself, which is a folder, not a file).
 */
export function repoToVaultPath(mapping: Pick<FolderMapping, "remotePath">, repoPath: string): string | null {
  const rp = normalizeRemotePath(mapping.remotePath);
  const norm = normalizePath(repoPath);
  if (!rp) return norm || null;
  if (norm === rp) return null;
  if (norm.startsWith(`${rp}/`)) return norm.slice(rp.length + 1);
  return null;
}

/**
 * Plan the vault → clone half: copy every in-scope vault file into the clone at
 * its repo-relative mirror path, and (optionally) delete in-scope clone files
 * whose vault counterpart is gone.
 *
 * Deletions are opt-in because the two flows differ: a regular sync mirrors
 * deletions (the vault folder is the authoritative local side), while a
 * first-sync push is deliberately additive — remote-only files are kept so an
 * initial push can never destroy remote content the vault simply hasn't seen.
 *
 * The empty-vault guard refuses whenever the vault side has no in-scope files:
 * mirroring then means either a no-op push (first init — pointless, and the
 * remote should populate the vault instead) or mass deletion (regular sync —
 * almost certainly a misconfigured or missing folder).
 */
export function planMirrorPush(input: {
  mapping: FolderMapping;
  /** Vault files under the mapping's localFolder (folder-relative paths). */
  vaultFiles: MirrorFile[];
  /** Current in-scope clone files (repo-relative, from `git ls-files`). */
  clonePaths: string[];
  /** Mirror vault-side deletions onto the clone (regular syncs only). */
  includeDeletions: boolean;
}): MirrorPlan {
  const { mapping, vaultFiles, clonePaths, includeDeletions } = input;
  if (vaultFiles.length === 0) return { ops: [], refused: true };

  const ops: MirrorOp[] = [];
  const vaultRels = new Set<string>();
  for (const f of vaultFiles) {
    const rel = normalizePath(f.path);
    vaultRels.add(rel);
    const repoPath = vaultToRepoPath(mapping, rel);
    if (!isInScope(mapping, repoPath)) continue;
    ops.push({ path: repoPath, kind: "write", content: f.content });
  }
  if (includeDeletions) {
    for (const p of clonePaths) {
      if (!isInScope(mapping, p)) continue;
      const rel = repoToVaultPath(mapping, p);
      if (rel === null) continue;
      if (!vaultRels.has(rel)) ops.push({ path: p, kind: "delete" });
    }
  }
  return { ops: orderApplyOps(ops), refused: false };
}

/**
 * Plan the clone → vault half: copy every in-scope clone file into the vault
 * folder at its folder-relative mirror path, plus deletions for files the remote
 * side removed. Deletions come ONLY from the caller's git-derived list — never
 * from "vault file with no clone counterpart", which would erase brand-new
 * local notes that simply have not been pushed yet.
 */
export function planMirrorPull(input: {
  mapping: FolderMapping;
  /** In-scope clone files (repo-relative paths + working-tree content). */
  cloneFiles: MirrorFile[];
  /** Repo-relative paths deleted by the remote side since our last sync. */
  deletedRepoPaths: string[];
}): MirrorPlan {
  const { mapping, cloneFiles, deletedRepoPaths } = input;
  const ops: MirrorOp[] = [];
  for (const f of cloneFiles) {
    if (!isInScope(mapping, f.path)) continue;
    const rel = repoToVaultPath(mapping, f.path);
    if (rel === null) continue;
    ops.push({ path: rel, kind: "write", content: f.content });
  }
  for (const p of deletedRepoPaths) {
    if (!isInScope(mapping, p)) continue;
    const rel = repoToVaultPath(mapping, p);
    if (rel === null) continue;
    ops.push({ path: rel, kind: "delete" });
  }
  return { ops: orderApplyOps(ops), refused: false };
}
