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
import type { FolderMapping, FileConflict } from "../types";
import type { RepoSummary } from "../providers/types";
import { decideSyncAction, type SyncAction } from "./rebase-policy";
import { formatCommitMessage } from "./commit-message";
import { applyMerge, type AppliedFile } from "./conflict";

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

/** Writes merged file content into a clone's working tree. Injected so the manager stays testable. */
export interface WorkingTreeWriter {
  writeFile(absPath: string, content: string): Promise<void>;
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
}

export class CloneManager {
  constructor(
    private client: GitClient,
    private layout: CloneLayout,
    private syncs: LastSyncAccessor,
    private readonly seams: { workingTree?: WorkingTreeWriter; conflicts?: ConflictStore } = {},
  ) {}

  get workingTree(): WorkingTreeWriter | undefined {
    return this.seams.workingTree;
  }

  get conflicts(): ConflictStore | undefined {
    return this.seams.conflicts;
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
        return { mappingId: mapping.id, pull: "rebase", push: false, needsConflictResolution: true, conflicts: merged.conflicts };
      }
      // Clean merge is now in the working tree; fall through to commit + push below.
    } else if (decision.pull !== "none") {
      await this.client.pull("origin", branch, "ff");
    }

    if (decision.push) {
      const paths = mapping.remotePath ? [mapping.remotePath] : undefined;
      await this.client.add(paths);
      await this.client.commit(formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath }));
      await this.client.push("origin", branch);
      this.syncs.recordPush(mapping.id, localSha);
    }

    this.syncs.recordPull(mapping.id, remoteSha);
    return { mappingId: mapping.id, pull: decision.pull, push: decision.push, needsConflictResolution: false, newRemoteSha: remoteSha, conflicts: [] };
  }

  /**
   * Gather files that differ between local and remote since their merge-base, merge
   * each with a 3-way merge, write clean results into the working tree, and return
   * divergent files as conflicts. Local content is read from HEAD (committed state).
   */
  private async mergeContents(mapping: FolderMapping, repo: RepoSummary, branch: string): Promise<{ applied: AppliedFile[]; conflicts: FileConflict[] }> {
    const dir = cloneDir(this.layout, mapping.providerId, mapping.id);
    const remoteRef = `origin/${branch}`;
    const baseSha = await this.client.mergeBase("HEAD", remoteRef);
    const localPaths = new Set(await this.client.changedPaths(`${baseSha}...HEAD`));
    const remotePaths = new Set(await this.client.changedPaths(`${baseSha}...${remoteRef}`));

    // Union both sides into one Set so a file changed on local AND remote is merged once.
    const entries = Array.from(new Set<string>([...localPaths, ...remotePaths]))
      .filter((path) => this.inScope(mapping, path))
      .map(async (path) => ({
        path,
        base: await this.client.show(baseSha, path),
        ours: (await this.client.show("HEAD", path)) ?? "",
        theirs: (await this.client.show(remoteRef, path)) ?? "",
      }));
    const resolved = await Promise.all(entries);

    const { applied, conflicts } = applyMerge(resolved);
    await Promise.all(applied.map((a) => this.workingTree?.writeFile(`${dir}/${a.path}`, a.content)));
    return { applied, conflicts };
  }

  /** True when `path` is under the mapping's remotePath subtree (or unscoped). */
  private inScope(mapping: FolderMapping, path: string): boolean {
    const rp = mapping.remotePath;
    if (!rp) return true;
    return path === rp || path.startsWith(`${rp}/`);
  }
}
