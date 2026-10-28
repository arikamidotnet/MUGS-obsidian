/**
 * MUGS — auto folder-matching (pure).
 *
 * Suggests one-click folder mappings when a remote repo's top-level directory name
 * matches a top-level vault folder. Used by the add-mapping form to offer "Notes → Notes"
 * style suggestions so users skip manual entry. No git/Obsidian imports — fully unit-tested.
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

/** A fuzzy match with a similarity score, for ranking suggestions that aren't exact. */
export interface FuzzyMatch extends FolderMatch {
  /** Similarity ratio (0–1); higher is better. Exact matches are always 1. */
  score: number;
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

/** Simple case-insensitive substring check for fuzzy matching. */
function containsFold(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA.length <= lowerB.length) return lowerB.includes(lowerA);
  return lowerA.includes(lowerB);
}

/** Normalize a name for fuzzy comparison: lowercase, strip common separators. */
function normalizeForFuzzy(name: string): string {
  return name.toLowerCase().replace(/[-_.\s]+/g, "");
}

/** Compute a similarity ratio between two strings (0–1) using normalized subsequence matching. */
function similarity(a: string, b: string): number {
  const na = normalizeForFuzzy(a);
  const nb = normalizeForFuzzy(b);
  if (!na || !nb) return 0;

  // Exact match after normalization.
  if (na === nb) return 1;

  // Substring containment bonus.
  if (containsFold(na, nb)) {
    const ratio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    // Boost substring matches but cap below exact.
    return Math.min(0.95, 0.7 + 0.25 * ratio);
  }

  // Dice coefficient on bigrams for a rough similarity score.
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const aBi = bigrams(na);
  const bBi = bigrams(nb);
  if (aBi.size === 0 || bBi.size === 0) return 0;

  let overlap = 0;
  for (const bg of aBi) {
    if (bBi.has(bg)) overlap++;
  }
  const dice = (2 * overlap) / (aBi.size + bBi.size);

  // Only suggest if there's meaningful similarity.
  return dice > 0.3 ? Math.min(0.85, dice) : 0;
}

/** Minimum score for a fuzzy suggestion to be included in results. */
const FUZZY_THRESHOLD = 0.4;

/** Maximum number of fuzzy suggestions per remote dir. */
const MAX_FUZZY_PER_DIR = 3;

/**
 * Compute both exact and fuzzy matches between remote directories and vault folders.
 * Returns a ranked list: exact matches first (sorted by label), then fuzzy matches
 * (sorted by score descending, then label). Each result includes its similarity score.
 */
export function matchFolderPairsFuzzy(
  remoteDirs: Iterable<string>,
  vaultFolders: Iterable<string>,
): FuzzyMatch[] {
  const remotes = Array.from(remoteDirs);
  const vaults = Array.from(vaultFolders);

  // Collect exact matches first (they always score 1.0).
  const exactMatches: FuzzyMatch[] = [];
  const usedVaults = new Set<string>();
  for (const remote of remotes) {
    if (!remote || remote.includes("/")) continue;
    const vaultIdx = vaults.indexOf(remote);
    if (vaultIdx >= 0 && !usedVaults.has(remote)) {
      exactMatches.push({ remotePath: remote, localFolder: remote, label: remote, score: 1 });
      usedVaults.add(remote);
    }
  }

  // Collect fuzzy matches for remaining remotes/vaults.
  const fuzzyMatches: FuzzyMatch[] = [];
  for (const remote of remotes) {
    if (!remote || remote.includes("/")) continue;
    const candidates: Array<{ vault: string; score: number }> = [];
    for (const vault of vaults) {
      if (usedVaults.has(vault)) continue; // don't suggest already-matched folders
      const score = similarity(remote, vault);
      if (score >= FUZZY_THRESHOLD) candidates.push({ vault, score });
    }
    // Sort by score desc, then label asc for stable ordering.
    candidates.sort((a, b) => b.score - a.score || a.vault.localeCompare(b.vault));
    const top = candidates.slice(0, MAX_FUZZY_PER_DIR);
    for (const { vault, score } of top) {
      fuzzyMatches.push({ remotePath: remote, localFolder: vault, label: `${remote} → ${vault}`, score });
    }
  }

  // Sort exact matches by label, fuzzy by score desc then label.
  exactMatches.sort((a, b) => a.label.localeCompare(b.label));
  fuzzyMatches.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  return [...exactMatches, ...fuzzyMatches];
}
