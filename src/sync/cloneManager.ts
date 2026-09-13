/**
 * MUGS — per-mapping clone manager.
 *
 * Orchestrates a single mapping's sync against its local git clone: ensure the
 * clone exists, fetch, read the commit topology, decide pull/push via the pure
 * `planSync` (which reuses decideSyncAction from the sync contract), then execute
 * it through the GitClient. File-level 3-way content merge is layered on top of
 * this topology decision in later work; conflict detection here is at commit
 * granularity (diverged histories with unpushed local work).
 *
 * The driver depends on injected seams (GitClient, a last-sync accessor) so the
 * pure decision logic stays unit-testable and the runtime path compiles/bundles.
 */
import type { GitClient } from "../git/client";
import type { FolderMapping } from "../types";
import type { RepoSummary } from "../providers/types";
import { decideSyncAction, type SyncAction } from "./rebase-policy";
import { formatCommitMessage } from "./commit-message";

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
  lastRemoteSha(mappingId: string): string | undefined;
  recordPull(mappingId: string, remoteSha: string): void;
  recordPush(mappingId: string, localSha: string): void;
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
}

export class CloneManager {
  constructor(
    private client: GitClient,
    private layout: CloneLayout,
    private syncs: LastSyncAccessor,
  ) {}

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

    if (decision.needsConflictResolution) {
      return { mappingId: mapping.id, pull: decision.pull, push: false, needsConflictResolution: true };
    }

    // Pull first so a rebase lands local work on top of the remote tip.
    if (decision.pull !== "none") {
      await this.client.pull("origin", branch, decision.pull === "fast-forward" ? "ff" : "rebase");
    }

    if (decision.push) {
      const paths = mapping.remotePath ? [mapping.remotePath] : undefined;
      await this.client.add(paths);
      await this.client.commit(formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath }));
      await this.client.push("origin", branch);
      this.syncs.recordPush(mapping.id, localSha);
    }

    this.syncs.recordPull(mapping.id, remoteSha);
    return { mappingId: mapping.id, pull: decision.pull, push: decision.push, needsConflictResolution: false, newRemoteSha: remoteSha };
  }
}
