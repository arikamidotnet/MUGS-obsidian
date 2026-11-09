/**
 * MUGS — Obsidian adapter path conversion (pure).
 *
 * The Obsidian DataAdapter speaks VAULT-RELATIVE paths. Handed an absolute path
 * it normalizes by stripping the leading slash and joining onto the vault base
 * path — so `adapter.write("/home/me/Vault/.mugs-clones/x/y.md", …)` silently
 * writes to `<vault>/home/me/Vault/.mugs-clones/x/y.md` instead of the clone,
 * and `git add` then fails on a pathspec that matches nothing (the silent
 * push-skip bug: every first-sync push skipped while junk dirs grew inside
 * the vault).
 *
 * MUGS clones live inside the vault under `.mugs-clones/`, so absolute clone
 * paths convert cleanly to relative ones. Paths outside the vault base pass
 * through unchanged (the caller decides what those mean).
 */
export function toAdapterPath(basePath: string, absPath: string): string {
  if (!basePath) return absPath;
  const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}
