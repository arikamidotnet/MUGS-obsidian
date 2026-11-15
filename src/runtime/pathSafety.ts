import { lstat } from "node:fs/promises";
import { checkRelPath, ensureNoSymlinkAncestors } from "../git/safePath";

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT" || /^Error: ENOENT\b/.test(String(error));
}

/** Fail closed on unreadable prefixes and symlinks, including the final target.
 * Recheck directly before adapter mutation; does not claim OS-level race immunity. */
export async function assertSafeAdapterPath(root: string, rel: string): Promise<void> {
  if (!checkRelPath(rel).ok) throw new Error("unsafe adapter path");
  if (!root) return;
  const safe = await ensureNoSymlinkAncestors(root, rel, {
    lstat: async path => {
      try { return await lstat(path); }
      catch (e) { if (isMissingFile(e)) return null; throw e; }
    },
  });
  if (!safe.ok) throw new Error("unsafe or unreadable filesystem path");
}
