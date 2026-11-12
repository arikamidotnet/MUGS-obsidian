/**
 * Path-level ownership for legacy mappings. Neither a filename nor an mtime
 * proves that a vault has received a remote file. A matching Git blob does.
 */
import { createHash } from "node:crypto";
import type { FolderMapping, ObsidianConfigPolicy, ReconciliationState, RepoIdentity } from "../types";
import { checkRelPath } from "../git/safePath";

export function reconciliationFingerprint(mapping: FolderMapping, identity: RepoIdentity, config?: ObsidianConfigPolicy): string {
  return createHash("sha256").update(JSON.stringify({
    identity,
    id: mapping.id,
    localFolder: mapping.localFolder,
    remotePath: mapping.remotePath,
    direction: mapping.direction,
    includes: mapping.includes ?? [],
    excludes: mapping.excludes ?? [],
    syncTrashFolder: mapping.syncTrashFolder ?? true,
    config: config ?? { enabled: false, entries: [] },
  })).digest("hex");
}

export function emptyReconciliation(fingerprint: string): ReconciliationState {
  return { version: 1, fingerprint, proven: {}, review: {}, decisions: {} };
}

/** Hash the exact UTF-8 bytes using Git's blob object framing, not plain text hash. */
export function gitBlobId(content: string, objectIdLength = 40): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash(objectIdLength === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Parse `ls-tree -r -z --full-tree`: no lazy blob downloads, no lossy path split. */
export function parseReconciliationTree(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const record of output.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("invalid Git tree record");
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (meta.length !== 3 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(meta[2])) {
      throw new Error("invalid Git tree object identity");
    }
    // Symlinks and submodules are not text files and cannot acquire ownership.
    if (!["100644", "100755"].includes(meta[0]) || meta[1] !== "blob") continue;
    if (!checkRelPath(path).ok) continue;
    result.set(path, meta[2]);
  }
  return result;
}
