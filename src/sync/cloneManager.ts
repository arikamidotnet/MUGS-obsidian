/**
 * MUGS — per-mapping clone manager.
 *
 * Orchestrates a single mapping's sync against its local git clone: ensure the
 * clone exists, fetch, read the commit topology, decide pull/push via the pure
 * `planSync` (which reuses decideSyncAction from the sync contract), then execute
 * it through the GitClient. On divergence (rebase pull over unpushed local work)
 * file-level 3-way content merge is layered on top of this topology decision: clean
 * changes are merged into the working tree and only genuine conflicts are surfaced.
 *
 * The driver depends on injected seams (GitClient, a last-sync accessor, optional
 * WorkingTreeWriter + ConflictStore) so the pure decision logic stays unit-testable
 * and the runtime path compiles/bundles.
 */
import type { GitClient } from "../git/client";
import type { FolderMapping, FileConflict, SyncPolicy, ObsidianConfigPolicy, Agent } from "../types";
import { authorRefForAgent } from "./attribution";
import type { RepoSummary } from "../providers/types";
import { decideSyncAction, type SyncAction } from "./rebase-policy";
import { formatCommitMessage } from "./commit-message";
import { applyMerge, type AppliedChange } from "./conflict";
import { isInScope, detectRenames, type Rename } from "./exclusion";
import { isUnderObsidianRoot, shouldSyncObsidianPath } from "./obsidianScope";
import { orderApplyOps, type ApplyOp } from "./applier";
import { EditorOpenGuard } from "./editorOpen";
import { canAutoResolve, resolveConflictAuto, autoResolvedContent } from "./policy";

/** Pull action, mirrored from the sync contract. */
export type SyncPull = SyncAction;

/** The full push/pull decision for one sync pass. */
export interface SyncDecision {
  /** What to do on pull (from decideSyncAction). */
  pull: SyncPull;
  /** Whether local changes should be pushed. */
  push: boolean;
  /** True when a diverged pull would need manual conflict resolution. */
  needsConflictResolution: boolean;
}

/** Inputs to the pure sync decision (topology + direction + unpushed state). */
export interface PlanInput {
  direction: FolderMapping["direction"];
  base: string;
  localSha: string;
  remoteSha: string;
  isAncestor: (maybeAncestor: string, descendants: string[]) => boolean;
  /** True when the local HEAD differs from the last-synced baseline. */
  localHasUnpushed: boolean;
}

/** Pure push/pull decision — reused by the driver and pinned by tests. */
export function planSync(p: PlanInput): SyncDecision {
  const pull = decideSyncAction({ base: p.base, localSha: p.localSha, remoteSha: p.remoteSha, isAncestor: p.isAncestor });
  const push = (p.direction === "push-pull" || p.direction === "push-only") && p.localHasUnpushed;
  // A diverged pull on top of unpushed local work needs a rebase that may conflict.
  const needsConflictResolution = pull === "rebase" && p.localHasUnpushed;
  return { pull, push, needsConflictResolution };
}

/** Narrow view of the persisted last-sync state the manager needs. */
export interface LastSyncAccessor {
  /** Persisted remote SHA this mapping was last synced to ("" when never). */
  lastRemoteSha(mappingId: string): string | undefined;
  recordPull(mappingId: string, remoteSha: string): void;
  recordPush(mappingId: string, localSha: string): void;
/** Optional: mark a mapping's persisted status as needing conflict resolution. */
  recordConflict?(mappingId: string): void;
}

/** Writes merged file content (and removes deleted files) into a clone's working tree. */
export interface WorkingTreeWriter {
  writeFile(absPath: string, content: string): Promise<void>;
  /** Optional: remove a file from the working tree when both sides deleted it. */
  deleteFile?(absPath: string): Promise<void> | void;
}

/** Durable per-mapping conflict store. Optional; when omitted conflicts are computed but not persisted. */
export interface ConflictStore {
  getConflicts(mappingId: string): FileConflict[];
  setConflicts(mappingId: string, conflicts: FileConflict[]): void;
}

/** Where on-disk clones live and how to slugify ids into folder names. */
export interface CloneLayout {
  root: string;
  slug?: (s: string) => string;
}

const defaultSlug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Stable on-disk path for a mapping's clone, grouped by provider. */
export function cloneDir(layout: CloneLayout, providerId: string, id: string): string {
  const slug = layout.slug ?? defaultSlug;
  return `${layout.root}/${slug(providerId)}/${slug(id)}`;
}

/** Result of one sync pass for a mapping. */
export interface SyncResult {
  mappingId: string;
  pull: SyncPull;
  push: boolean;
  needsConflictResolution: boolean;
  newRemoteSha?: string;
  /** Files that diverged and need manual resolution (empty when none). */
  conflicts: FileConflict[];
  /** Files moved by content identity between local and remote (empty when none). */
  renames?: Rename[];
}

export class CloneManager {
  constructor(
    private client: GitClient,
    private layout: CloneLayout,
    private syncs: LastSyncAccessor,
    private readonly seams: {
      workingTree?: WorkingTreeWriter;
      conflicts?: ConflictStore;
      /** Automatic-first resolution policy; when present + autoMerge, genuine conflicts
       *  are auto-resolved (recency-wins / defaultResolution) instead of surfaced. */
      policy?: SyncPolicy;
      /** Tracks paths open with unsaved changes so writes never clobber an in-progress edit. */
      editorOpen?: EditorOpenGuard;
      /** Opt-in `.obsidian/` config sync scope (Area 9). When enabled, per-path
       *  personal/vault-wide classification gates which `.obsidian/` files are pulled/pushed. */
      obsidianConfig?: ObsidianConfigPolicy;
      /** Optional: resolve the agent sub-user acting on a mapping's push. When it returns
       *  an agent, the commit is attributed to that agent and carries an "On-behalf-of"
       *  trailer for its owner (Area 10). Absent -> plain sync attribution (unchanged). */
      pickAgent?: (mapping: FolderMapping) => Agent | undefined;
    } = {},
  ) {}

  get workingTree(): WorkingTreeWriter | undefined {
    return this.seams.workingTree;
  }

  get conflicts(): ConflictStore | undefined {
    return this.seams.conflicts;
  }

  private get policy(): SyncPolicy | undefined {
    return this.seams.policy;
  }

  private get editorOpen(): EditorOpenGuard | undefined {
    return this.seams.editorOpen;
  }

  private get obsidianConfig(): ObsidianConfigPolicy | undefined {
    return this.seams.obsidianConfig;
  }

  private get pickAgent(): ((mapping: FolderMapping) => Agent | undefined) | undefined {
    return this.seams.pickAgent;
  }

  /**
   * Whether a repo path is in the mapping's scope. Composes the folder-scope check
   * (`isInScope`) with `.obsidian/` personal-vs-vault-wide gating: when obsidian config
   * sync is enabled, `.obsidian/` paths are pulled/pushed only if {@link shouldSyncObsidianPath}
   * says they are vault-wide. With obsidian disabled (default) this is exactly `isInScope`,
   * so existing behavior is unchanged.
   */
  private inScope(mapping: FolderMapping, path: string): boolean {
    if (!isInScope(mapping, path)) return false;
    const config = this.obsidianConfig;
    if (config?.enabled && isUnderObsidianRoot(path)) {
      return shouldSyncObsidianPath(path, config);
    }
    return true;
  }

  /** True when `dir` is already a checked-out git work tree. */
  async isCloned(dir: string): Promise<boolean> {
    const r = await this.client.run(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /** Clone the mapping's repo if it is not already present. */
  async ensureClone(mapping: FolderMapping, repo: RepoSummary): Promise<string> {
    const dir = cloneDir(this.layout, mapping.providerId, mapping.id);
    if (!(await this.isCloned(dir))) {
      await this.client.clone(repo.httpUrlToRepo, dir);
    }
    return dir;
  }

  /** Run a full sync pass for one mapping against its resolved repo. */
  async syncMapping(mapping: FolderMapping, repo: RepoSummary): Promise<SyncResult> {
    const dir = cloneDir(this.layout, mapping.providerId, mapping.id);
    const branch = mapping.branch ?? repo.defaultBranch;
    const base = this.syncs.lastRemoteSha(mapping.id) ?? "";

    await this.client.fetch();
    const localSha = await this.client.currentHead();
    const remoteSha = await this.client.revParse(`origin/${branch}`);

    // decideSyncAction consults the ancestry oracle at most once (with
    // localSha, [remoteSha]); precompute it so the pure contract stays synchronous.
    const localContainsRemote = await this.client.isAncestor(localSha, [remoteSha]);

    const decision = planSync({
      direction: mapping.direction,
      base,
      localSha,
      remoteSha,
      isAncestor: () => localContainsRemote,
      localHasUnpushed: localSha !== base,
    });

    // Diverged histories with unpushed local work. Merge file contents ourselves so
    // clean changes apply and only genuine conflicts are surfaced for resolution.
    if (decision.pull === "rebase") {
      const merged = await this.mergeContents(mapping, repo, branch);
      if (merged.conflicts.length > 0) {
        const all = [...(this.conflicts?.getConflicts(mapping.id) ?? []), ...merged.conflicts];
        this.conflicts?.setConflicts(mapping.id, all);
        return { mappingId: mapping.id, pull: "rebase", push: false, needsConflictResolution: true, conflicts: merged.conflicts, renames: merged.renames };
      }
      // Clean merge is now in the working tree; fall through to commit + push below.
    } else if (decision.pull !== "none") {
      await this.client.pull("origin", branch, "ff");
    }

    if (decision.push) {
      // Stage only in-scope working-tree changes so excluded paths are never pushed.
      // When nothing is uncommitted to scope-filter, fall back to the subtree/whole-repo add.
      const changed = await this.client.workingTreePaths();
      const scoped = changed.filter((path) => this.inScope(mapping, path));
      const paths = scoped.length > 0 ? scoped : mapping.remotePath ? [mapping.remotePath] : undefined;
      await this.client.add(paths);
      // Attribute an agent sub-user's push to that agent (with on-behalf-of trailer for
      // its owner); otherwise leave attribution to the repo's configured git identity.
      const agent = this.pickAgent?.(mapping);
      const author = agent ? authorRefForAgent(agent) : undefined;
      await this.client.commit(
        formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath, ownerHuman: author?.ownerHuman }),
        author?.email ? { name: author.name, email: author.email } : undefined,
      );
      await this.client.push("origin", branch);
      this.syncs.recordPush(mapping.id, localSha);
    }

    this.syncs.recordPull(mapping.id, remoteSha);
    return { mappingId: mapping.id, pull: decision.pull, push: decision.push, needsConflictResolution: false, newRemoteSha: remoteSha, conflicts: [], renames: [] };
  }

  /**
   * Gather files that differ between local and remote since their merge-base, merge
   * each with a 3-way merge, write clean results into the working tree, and return
   * divergent files as conflicts. Local content is read from HEAD (committed state).
   */
  private async mergeContents(mapping: FolderMapping, repo: RepoSummary, branch: string): Promise<{ applied: AppliedChange[]; conflicts: FileConflict[]; renames: Rename[] }> {
    const dir = cloneDir(this.layout, mapping.providerId, mapping.id);
    const remoteRef = `origin/${branch}`;
    const baseSha = await this.client.mergeBase("HEAD", remoteRef);
    const localPaths = new Set(await this.client.changedPaths(`${baseSha}...HEAD`));
    const remotePaths = new Set(await this.client.changedPaths(`${baseSha}...${remoteRef}`));

    // Union both sides into one Set so a file changed on local AND remote is merged once.
    const inScopePaths = Array.from(new Set<string>([...localPaths, ...remotePaths])).filter((path) => this.inScope(mapping, path));

    const entries = inScopePaths.map(async (path) => ({
      path,
      base: await this.client.show(baseSha, path),
      // Preserve undefined so a deleted side is treated as a deletion (jj None), not an empty file.
      ours: await this.client.show("HEAD", path),
      theirs: await this.client.show(remoteRef, path),
    }));
    const resolved = await Promise.all(entries);

    // Recognize cross-device moves by content identity so a rename surfaces as a move
    // rather than a delete + add pair. Only changed paths are compared; unchanged files
    // appear on both sides and never match the removed/added sets.
    const renames = detectRenames(
      Object.fromEntries(resolved.filter((r) => r.base !== undefined).map((r) => [r.path, r.base as string])),
      Object.fromEntries(resolved.filter((r) => r.theirs !== undefined).map((r) => [r.path, r.theirs as string])),
    );

    const { applied, conflicts } = applyMerge(resolved);

    // Automatic-first resolution: when a policy is injected and auto-merge is on, resolve
    // genuine conflicts automatically (recency-wins / defaultResolution) and write the
    // resolved content instead of surfacing them. Only unresolvable conflicts are returned
    // for manual review. With no policy injected this is a no-op — behavior is unchanged.
    let surfacedConflicts = conflicts;
    const toApply: Array<ApplyOp & { content?: string }> = applied.map(toWriteOp);
    if (this.policy?.autoMerge) {
      surfacedConflicts = [];
      for (const c of conflicts) {
        if (canAutoResolve(c, this.policy)) {
          const content = autoResolvedContent(c, resolveConflictAuto(c, this.policy)!);
          // Skip a no-op write when the resolved content already equals local.
          const local = c.oursAbsent ? "" : c.ours;
          if (content !== local) toApply.push({ path: c.path, kind: "write", content });
        } else {
          surfacedConflicts.push(c);
        }
      }
    }

    // Safe applier ordering: writes before deletes, parents before children.
    await this.applyOrdered(dir, orderApplyOps(toApply));
    return { applied, conflicts: surfacedConflicts, renames };
  }

  /**
   * Apply ordered write/delete operations to the working tree. Writes skip any path that is
   * open with unsaved changes (the editor-open guard) so a remote/merge result never clobbers
   * an in-progress edit; deletions remove both-sides-deleted files.
   */
  private async applyOrdered(dir: string, ops: Array<ApplyOp & { content?: string }>): Promise<void> {
    for (const op of ops) {
      const absPath = `${dir}/${op.path}`;
      if (op.kind === "delete") {
        await this.workingTree?.deleteFile?.(absPath);
        continue;
      }
      if (this.editorOpen && !this.editorOpen.isWriteSafe(op.path)) continue; // open w/ unsaved changes -> skip
      await this.workingTree?.writeFile(absPath, op.content ?? "");
    }
  }
}

/** Map an applied change to a write/delete op for the applier ordering. */
function toWriteOp(a: AppliedChange): ApplyOp & { content?: string } {
  return "content" in a ? { path: a.path, kind: "write", content: a.content } : { path: a.path, kind: "delete" };
}
