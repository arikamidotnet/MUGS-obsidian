/**
 * Test-side clone-dir resolution for the identity layout (S03, contract §3).
 *
 * The engine clones into `<cloneRoot>/<shortHash(identity)>/<sanitized-branch>` and
 * RECORDS the resolved dir into lastSync state (`LastSyncState.cloneDir`). Tests must
 * resolve clone dirs the same two ways the engine/UI do — never by hardcoding the
 * legacy `<root>/<providerId>/<mappingId>` layout:
 *
 *  - recordedCloneDir(store, mappingId)  — read what the engine recorded (preferred
 *    after at least one sync pass ran against that store).
 *  - expectedIdentityCloneDir(root, id)  — recompute the layout for a never-synced
 *    mapping (or to pin the layout contract). `remoteUrl` is the PLAIN remote path
 *    the engine sees as repo.httpUrlToRepo (canonicalization is applied here).
 */
import { identityCloneDir, canonicalizeRemote } from "../repoIdentity";
import type { MugsStore } from "../../store";

export interface ExpectedCloneIdentity {
  providerId: string;
  /** Resolved repo key: `mapping.repoRef ?? repo.id` (local provider: `?? mapping.id`). */
  repoId: string;
  /** Resolved branch; defaults "main" (mapping.branch ?? repo.defaultBranch). */
  branch?: string;
  /** Plain remote path/URL as the engine receives it (no `file://` prefix). */
  remoteUrl: string;
}

/** Recompute the engine's identity clone dir for the given identity. */
export function expectedIdentityCloneDir(root: string, id: ExpectedCloneIdentity): string {
  return identityCloneDir(root, {
    providerId: id.providerId,
    repoId: id.repoId,
    branch: id.branch ?? "main",
    canonicalRemote: canonicalizeRemote(id.remoteUrl),
  });
}

/** The engine-recorded clone dir for a synced mapping (undefined before the first pass). */
export function recordedCloneDir(store: MugsStore, mappingId: string): string | undefined {
  return store.getSettings().lastSync[mappingId]?.cloneDir;
}
