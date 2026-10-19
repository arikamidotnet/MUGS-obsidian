/**
 * MUGS — auto folder-matching (pure).
 *
 * Suggests one-click folder mappings when a remote repo's top-level directory name
 * exactly matches a top-level vault folder. Used by the add-mapping form to offer
 * "Notes → Notes" style suggestions so users skip manual entry. No git/Obsidian
 * imports — fully unit-tested.
 */

/** A suggested mapping pair: a remote path and the matching vault folder. */
export interface FolderMatch {
  /** Remote repo-relative directory (top-level). */
  remotePath: string;
  /** Matching top-level vault folder (exact name match). */
  localFolder: string;
  /** Human-friendly label derived from the shared name. */
  label: string;
}

/**
 * Compute exact-name matches between top-level remote directories and top-level
 * vault folders. A pair is suggested when a remote dir name equals a vault folder
 * name exactly (case-sensitive, single path component). Nested paths are ignored.
 * Results are de-duplicated and sorted by name for stable ordering.
 */
export function matchFolderPairs(
  remoteDirs: Iterable<string>,
  vaultFolders: Iterable<string>,
): FolderMatch[] {
  const vault = new Set(vaultFolders);
  const matches: FolderMatch[] = [];
  const seen = new Set<string>();
  for (const remote of remoteDirs) {
    // Top-level only: ignore nested paths like "a/b".
    if (!remote || remote.includes("/")) continue;
    if (!vault.has(remote)) continue;
    if (seen.has(remote)) continue;
    seen.add(remote);
    matches.push({ remotePath: remote, localFolder: remote, label: remote });
  }
  matches.sort((a, b) => a.label.localeCompare(b.label));
  return matches;
}
