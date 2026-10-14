/**
 * MUGS — view data-source seams (pure).
 *
 * The Map/Diff views never touch the store or git directly; they ask an injected
 * data source for already-shaped rows. This keeps the views thin and the logic
 * here unit-testable without Obsidian. `main.ts` installs concrete
 * implementations via {@link setMugsContext} before any view opens.
 */
import type { FolderMapping, SyncStatus } from "../types";
import type { AuthorRef, AuthorsByFile } from "./diffModel";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

/** One row of the Map view: a mapping plus runtime enrichment. */
export interface MapRow {
  mapping: FolderMapping;
  status: SyncStatus;
  /** Owning user (recent git author) when the clone is available. */
  owner?: string;
  /** Most recent push time (ms epoch), if known. */
  lastPushAt?: number;
  /** Most recent pull time (ms epoch), if known. */
  lastPullAt?: number;
}

/** Supplies the data the Map view renders. */
export interface MapDataSource {
  getRows(): Promise<MapRow[]>;
}

/** What the Diff view asks for: a diff plus per-file authors for attribution. */
export interface DiffQuery {
  mappingId: string;
  /** Optional explicit "to" ref (defaults to HEAD). */
  ref?: string;
}

export interface DiffResult {
  diffText: string;
  authorsByFile: AuthorsByFile;
}

/** Supplies the data the Diff view renders. */
export interface DiffDataSource {
  getDiff(query: DiffQuery): Promise<DiffResult>;
}

/** Which mapping's conflicts to read. */
export interface ConflictQuery {
  mappingId: string;
}

/** Resolve one file of a mapping's conflict with a chosen winner. */
export interface ConflictResolutionQuery {
  mappingId: string;
  /** Repo-relative path of the conflicting file. */
  path: string;
  /** "ours" / "theirs" / "both" (auto-merge when possible). */
  choice: ResolveChoice;
}

/** Outcome of resolving one file: how many unresolved conflicts remain for the mapping. */
export interface ConflictResolutionResult {
  remaining: number;
}

/** Supplies the conflicts a mapping still needs resolved, and applies resolutions. */
export interface ConflictDataSource {
  /** Unresolved conflicts for a mapping (empty when none). */
  getConflicts(query: ConflictQuery): Promise<FileConflict[]>;
  /** Resolve one file; persists the working-tree write + store update. */
  resolveConflict(query: ConflictResolutionQuery): Promise<ConflictResolutionResult>;
}

/** The runtime context the views depend on. */
export interface MugsContext {
  map: MapDataSource;
  diff: DiffDataSource;
  conflicts: ConflictDataSource;
}

let context: MugsContext | null = null;

/** Install the data sources the views will use (called once from main.ts). */
export function setMugsContext(ctx: MugsContext): void {
  context = ctx;
}

/** Retrieve the installed context. Throws if main.ts has not initialized it. */
export function getMugsContext(): MugsContext {
  if (!context) {
    throw new Error("MUGS UI context is not initialized — views must be registered by the plugin.");
  }
  return context;
}

/** Test seam: clear the installed context. Not used in production. */
export function __resetMugsContextForTests(): void {
  context = null;
}

// Re-exported for convenience so callers import types from one place.
export type { AuthorRef };
