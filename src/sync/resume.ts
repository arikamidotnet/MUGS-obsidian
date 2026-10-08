/**
 * MUGS — resumable sync state (pure).
 *
 * Last-sync bookkeeping is keyed on the git base SHA + an operation id (not merely a
 * timestamp) so an offline session resumes cleanly from where it left off and a reconnect
 * reconciles deterministically — analogous to Obsidian Sync's version-number resume, but
 * backed by git history. This module derives that deterministic key; persistence lives in
 * the store/driver.
 */
import type { LastSyncState } from "../types";

/** Shape needed to compute a resume key — both fields are optional on {@link LastSyncState}. */
export interface ResumeKeyable {
  baseSha?: string;
  opId?: number;
}

/**
 * Deterministic resume key for a mapping: `<baseSha>\u0000<opId>` when a base SHA is known,
 * otherwise undefined (never synced / nothing to resume from). The NUL separator keeps the
 * two components unambiguous. An offline session stores this and, on reconnect, reconciles
 * forward from it rather than re-deriving state from a wall-clock timestamp.
 */
export function resumeKey(state: ResumeKeyable): string | undefined {
  return state.baseSha ? `${state.baseSha}\u0000${state.opId ?? ""}` : undefined;
}
