/**
 * MUGS — pull-synchronization policy (pure).
 *
 * Decides what a pull should do given the topology of three commits: the
 * last-synced baseline, the local HEAD, and the remote HEAD. Ancestry is supplied
 * by an oracle (`isAncestor`) so this stays pure and unit-testable; the actual
 * `git rebase`/`git merge` runs against that decision in the git client. A
 * rebase that later conflicts is reported by the client, not decided here.
 */

/** The pull action to take for the current topology. */
export type SyncAction = "none" | "fast-forward" | "rebase";

/** Topology inputs plus an ancestry oracle (ancestor ∈ descendants' history). */
export interface SyncTopology {
  /** SHA of the remote commit we last synced from; "" when never synced. */
  base: string;
  /** Current local HEAD SHA. */
  localSha: string;
  /** Current remote HEAD SHA. */
  remoteSha: string;
  /** True when `maybeAncestor` is an ancestor of any SHA in `descendants`. */
  isAncestor: (maybeAncestor: string, descendants: string[]) => boolean;
}

/** Decide the pull action for a sync topology. */
export function decideSyncAction(t: SyncTopology): SyncAction {
  // Already in sync locally and remotely.
  if (t.localSha === t.remoteSha) return "none";

  // Remote has not advanced since the last sync — nothing to pull.
  if (t.base !== "" && t.remoteSha === t.base) return "none";

  // Never synced before: adopt remote unless local already equals it (handled above).
  if (t.base === "") {
    return t.localSha === "" ? "fast-forward" : "rebase";
  }

  // Remote already contains our local work → local can fast-forward up to remote.
  if (t.isAncestor(t.localSha, [t.remoteSha])) return "fast-forward";

  // Otherwise the histories have diverged: rebase local onto the remote tip.
  return "rebase";
}
