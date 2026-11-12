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
import { GitClient, type GitAuth, type Author } from "../git/client";
import type { FolderMapping, FileConflict, SyncPolicy, ObsidianConfigPolicy, Agent } from "../types";
import { authorRefForAgent } from "./attribution";
import type { RepoSummary } from "../providers/types";
import { decideSyncAction, type SyncAction } from "./rebase-policy";
import { formatCommitMessage } from "./commit-message";
import { applyMerge, type AppliedChange, type FileVersions } from "./conflict";
import type { SyncPlanKind, PendingOperation } from "../types";
import { checkRelPath } from "../git/safePath";
import { isInScope, detectRenames, type Rename } from "./exclusion";
import { isUnderObsidianRoot, shouldSyncObsidianPath } from "./obsidianScope";
import { orderApplyOps, type ApplyOp } from "./applier";
import { planMirrorPull, vaultToRepoPath, repoToVaultPath } from "./mirror";
import type { TrashStore } from "./trash";
import { EditorOpenGuard } from "./editorOpen";

/** Pull action, mirrored from the sync contract. */
export type SyncPull = SyncAction;

/** A file whose content could not be read this pass (S02): surfaced per-file with a
 *  redacted reason, NEVER treated as absence/deletion. ADDITIVE (Wave B). */
export interface BlockedFile {
  path: string;
  reason: string;
}

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

/**
 * Resolve the remote branch ref name for a mapping's sync pass.
 *
 * Prefers an explicit mapping branch, then the repo default branch. Falls back to
 * "HEAD" when neither is known — e.g. a synthesized allowed-repo entry whose
 * branches could not be resolved (a scoped token that couldn't list them). An empty
 * name would otherwise break `origin/<branch>` refs; `origin/HEAD` is created on
 * clone and keeps tracking the remote's default branch.
 */
export function resolveSyncBranch(mapping: { branch?: string }, repo: { defaultBranch: string }): string {
  return (mapping.branch ?? repo.defaultBranch) || "HEAD";
}

/** Narrow view of the persisted last-sync state the manager needs. */
export interface LastSyncAccessor {
  /** Persisted remote SHA this mapping was last synced to ("" when never). */
  lastRemoteSha(mappingId: string): string | undefined;
  recordPull(mappingId: string, remoteSha: string): void;
  recordPush(mappingId: string, localSha: string): void;
/** Optional: mark a mapping's persisted status as needing conflict resolution. */
  recordConflict?(mappingId: string): void;
  /** Optional: true once a mirror-pull has populated the mapping's vault folder.
   *  Gates vault-deletion propagation: absent when unknown/never populated, in
   *  which case a vault-absent file must NOT be treated as a user deletion. */
  vaultPopulated?(mappingId: string): boolean | undefined;
  /** Optional: mark the mapping's vault folder as populated by a mirror-pull. */
  recordVaultSync?(mappingId: string): void;
  /** Optional: epoch ms of the mapping's most recent completed pull or push —
   *  the steady-state shortcut's mtime reference point. */
  lastCompletedAt?(mappingId: string): number | undefined;
  /** Optional: per-file (mtimeMs, size) snapshot recorded at the last completed
   *  push-only pass. Without it the shortcut never skips files (full read). */
  contentSnapshot?(mappingId: string): Record<string, [number, number]> | undefined;
  /** Optional: persist a fresh per-file snapshot after a completed pass. */
  recordContentSnapshot?(mappingId: string, snap: Record<string, [number, number]>): void;
  /** ADDITIVE (S01): durable operations not yet applied+verified. Non-empty BLOCKS
   *  correspondence advance and forces replan/verify before new reconciliation. */
  pendingOps?(mappingId: string): PendingOperation[] | undefined;
  /** ADDITIVE (S01): replace the mapping's durable pendingOps list. */
  recordPendingOps?(mappingId: string, ops: PendingOperation[]): void;
  /** ADDITIVE (S01): record the PROVEN correspondence SHA — called only after every
   *  planned vault application completed AND state persisted. */
  recordCorrespondence?(mappingId: string, sha: string): void;
}

/** Writes merged file content (and removes deleted files) into a clone's working tree. */
export interface WorkingTreeWriter {
  writeFile(absPath: string, content: string): Promise<void>;
  /** Optional: remove a file from the working tree when both sides deleted it. */
  deleteFile?(absPath: string): Promise<void> | void;
  /** Optional: read a clone working-tree file (returns undefined when absent).
   *  Used by the vault mirror to copy clone content and to trash deletions. */
  readFile?(absPath: string): Promise<string | undefined>;
}

/**
 * Filesystem view of a mapping's vault folder, wired in main.ts from the Obsidian
 * vault adapter. Paths are relative to the mapping's `localFolder` ("." = whole
 * vault). This is the seam that makes the vault the authoritative local side of
 * every sync: vault files mirror into clones on push, clone content mirrors back
 * into the vault on pull.
 */
export interface VaultMirror {
  /** List syncable text files under the folder (folder-relative paths). */
  list(localFolder: string): Promise<string[]>;
  /** Read one file (folder-relative). */
  read(localFolder: string, relPath: string): Promise<string>;
  /** Write one file (folder-relative), creating parent folders as needed. */
  write(localFolder: string, relPath: string, content: string): Promise<void>;
  /** Remove one file (folder-relative). */
  remove(localFolder: string, relPath: string): Promise<void>;
  /** Optional: last-modified time (ms epoch) of one file — the "ours" recency
   *  input for automatic conflict resolution. Absent/undefined leaves the policy
   *  to fall back to defaultResolution. */
  mtime?(localFolder: string, relPath: string): Promise<number | undefined>;
  /** Optional: mtime + size of one file — the steady-state shortcut's change
   *  detector. The skip rule needs BOTH fields (mtime alone lied: a file restored
   *  from a backup has an old mtime but new content). Absent -> the shortcut
   *  never engages and every pass takes the full safe path. */
  stat?(localFolder: string, relPath: string): Promise<{ mtime: number; size: number } | undefined>;
  /** Optional: true when a path could ever appear in list() (not a binary
   *  extension, not under a dot-folder). Repo paths the mirror can never list
   *  are excluded from merge/mirror scope entirely so filtered-out remote files
   *  (a teammate's PNG, a dot-folder entry) are never treated as vault deletions
   *  — the binary-corruption guard. Default true. */
  listable?(path: string): boolean;
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

/** Steady-state skip rule (pure): a file may be skipped as unchanged only when BOTH
 *  the current (mtime, size) pair matches the snapshot recorded at the last completed
 *  pass AND its mtime predates that pass. A missing snapshot entry (first run after
 *  upgrade, brand-new file) or an unavailable stat never skips — the safe direction. */
export function isSnapshotStale(fp: [number, number] | undefined, prev: [number, number] | undefined, lastDone: number): boolean {
  return fp !== undefined && prev !== undefined && fp[0] === prev[0] && fp[1] === prev[1] && fp[0] <= lastDone;
}

/** Stable on-disk path for a mapping's clone, grouped by provider. */
export function cloneDir(layout: CloneLayout, providerId: string, id: string): string {
  const slug = layout.slug ?? defaultSlug;
  return `${layout.root}/${slug(providerId)}/${slug(id)}`;
}

/** Options for one mapping's sync pass. */
export interface SyncOpts {
  /** Which side wins when this mapping has never synced (no lastSync baseline):
   *  "pull" populates the vault from the remote (default); "push" uploads the
   *  vault onto the remote without downloading its history. */
  firstSync?: "pull" | "push";
  /** Optional progress reporter — receives human-readable phase text (rendered
   *  live in the status bar) while the pass runs. */
  onStatus?: (message: string) => void;
  /** ADDITIVE (contract §2): when true the pass performs discovery + planning ONLY
   *  and returns before any mutation (no clone writes, no vault writes/deletes,
   *  no add/commit/push). The result carries the plan kind/counts. */
  dryRun?: boolean;
  /** ADDITIVE (contract §7): cancellation signal threaded into every GitRunOpts. */
  signal?: AbortSignal;
  /** ADDITIVE (contract §8 / E02): watcher uncertainty (startup, lost events, changed
   *  configFingerprint). When true the steady-state stat shortcut is disabled for the
   *  pass — every file is re-verified so a same-size/same-mtime replacement can never
   *  report a false success. */
  uncertain?: boolean;
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
  /** ADDITIVE (contract §2): the plan kind for this pass — "idle" for a verified no-op. */
  kind?: SyncPlanKind;
  /** ADDITIVE (contract §2): per-outcome plan counts. */
  counts?: { publish: number; apply: number; deferred: number; conflicted: number };
  /** ADDITIVE (S02/§9): per-file blocked outcomes (unreadable content, unsafe path,
   *  binary) with redacted reasons — never treated as absence/deletion. */
  blocked?: BlockedFile[];
  /** ADDITIVE (S01): count of pendingOps stuck in "failed" state after recovery. */
  pendingFailures?: number;
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
      /** Records a file's content before it is removed from the working tree during sync,
       *  so both-sides-deletions are recoverable via `.mugs-trash` (Area 3). Optional. */
      trash?: TrashStore;
      /** Optional: set of paths explicitly held back for review (Area 8). Held paths are
       *  excluded from the push stage so they never leave the machine. Absent -> nothing held. */
      heldPaths?: (mappingId: string) => ReadonlySet<string> | undefined;
      /** Optional: filesystem view of the mapping's vault folder. When present the
       *  vault is the authoritative local side (mirrored into clones on push, populated
       *  from clones on pull); when absent sync is clone↔remote only (legacy behavior). */
      vaultMirror?: VaultMirror;
      /** Optional: recursively remove a directory — used to clear the half-baked .git an
       *  interrupted clone leaves behind (git refuses to clone into a non-empty dir). */
      rmDir?: (dir: string) => void;
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

  private get trash(): TrashStore | undefined {
    return this.seams.trash;
  }

  private get heldPaths(): (mappingId: string) => ReadonlySet<string> | undefined {
    return this.seams.heldPaths ?? (() => undefined);
  }

  private get vaultMirror(): VaultMirror | undefined {
    return this.seams.vaultMirror;
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
    if (isUnderObsidianRoot(path)) {
      // .obsidian content syncs ONLY via the opt-in config feature. The gate used
      // to run only when the feature was enabled, so with it OFF repo-side
      // .obsidian paths were pulled into every teammate's config — now they are
      // always out of scope unless the feature is on and classifies them
      // vault-wide (the contract obsidianScope documents).
      return config?.enabled === true && shouldSyncObsidianPath(path, config);
    }
    // Opt-out gate for the vault `.trash/` folder: excluded when this mapping opts out.
    if (mapping.syncTrashFolder === false && isTrashPath(path)) return false;
    return true;
  }

  /** True when the vault mirror could ever list this path (not a binary
   *  extension, not inside a dot-folder). Repo-side paths the mirror can never
   *  list are excluded from merges and mirror ops entirely — otherwise a remote
   *  file the vault cannot represent (a teammate-uploaded PNG, a dot-folder
   *  entry) would read as "ours deleted" and get corrupted or deleted. Defaults
   *  true without the optional seam (legacy/test mirrors). */
  private mirrorListable(path: string): boolean {
    return this.vaultMirror?.listable?.(path) ?? true;
  }

  /** Committer identity for MUGS commits: the pinned agent when set, else the
   *  credential's username with a noreply email on the git host. Never the
   *  machine's global git config — unset on a fresh teammate machine, where
   *  every push would fail with "tell me who you are". */
  private committerFor(mapping: FolderMapping, auth: GitAuth | undefined, repo: RepoSummary): Author | undefined {
    const agent = this.pickAgent?.(mapping);
    const ref = agent ? authorRefForAgent(agent) : undefined;
    if (ref?.email) return { name: ref.name, email: ref.email };
    const name = auth?.username;
    if (!name) return undefined; // local provider — falls back to git config (tests set it)
    let host = "mugs.local";
    try {
      host = new URL(repo.httpUrlToRepo).host || host;
    } catch {
      // non-URL remote — keep the fallback host
    }
    return { name, email: `${name}@noreply.${host}` };
  }

  /** True when `dir` is a git work tree with a resolvable HEAD. The HEAD check
   *  matters: a clone interrupted mid-transfer leaves a .git whose HEAD dangles at
   *  `.invalid` with no refs — `--is-inside-work-tree` alone would accept it, and
   *  every later sync would fail on rev-parse. Requiring HEAD makes failed clones
   *  self-heal by re-cloning. (A clone of an empty repo also fails this check —
   *  re-cloning an empty repo is free.) */
  async isCloned(dir: string): Promise<boolean> {
    const wt = await this.client.run(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
    if (!(wt.code === 0 && wt.stdout.trim() === "true")) return false;
    const head = await this.client.run(["rev-parse", "HEAD"], { cwd: dir });
    return head.code === 0;
  }

  /** Clone the mapping's repo if not already present. All mappings pointing at the
   *  same repo share ONE clone — the dir is keyed by the resolved repo
   *  (`repoRef ?? repo.id`), so ten folder-scoped legacy links over one repo cost
   *  one clone, not ten. `auth` supplies HTTP(S) credentials. `noCheckout` skips the
   *  working-tree checkout for a push-first init (the vault content is written in
   *  before anything is committed). Both modes fetch blobless over http(s) so the
   *  first sync downloads refs + a snapshot instead of the full pack history. */
  async ensureClone(mapping: FolderMapping, repo: RepoSummary, auth?: GitAuth, mode: "checkout" | "no-checkout" = "checkout"): Promise<string> {
    const dir = cloneDir(this.layout, mapping.providerId, mapping.repoRef ?? repo.id);
    if (await this.isCloned(dir)) return dir;
    // Clear any half-cloned remains — git refuses to clone into a non-empty dir.
    this.seams.rmDir?.(dir);
    await this.client.withAuth(auth).clone(repo.httpUrlToRepo, dir, { filter: "blob:none", noCheckout: mode === "no-checkout" });
    return dir;
  }

  /** Run a full sync pass for one mapping against its resolved repo. `auth`
   *  supplies HTTP(S) credentials; `opts.firstSync` picks the winner on a
   *  never-synced mapping ("pull" populates the vault from the remote — the
   *  default; "push" uploads the vault onto the remote without downloading its
   *  history); `opts.onStatus` receives human-readable phase text for live UI. */
  async syncMapping(mapping: FolderMapping, repo: RepoSummary, auth?: GitAuth, opts: SyncOpts = {}): Promise<SyncResult> {
    const dir = cloneDir(this.layout, mapping.providerId, mapping.repoRef ?? repo.id);
    const branch = resolveSyncBranch(mapping, repo);
    const base = this.syncs.lastRemoteSha(mapping.id) ?? "";
    const status = opts.onStatus;

    // Bind git ops to the clone dir; without a cwd they would run in process.cwd().
    const c = this.client.withAuth(auth).at(dir);

    // Committer identity for every push this pass (fresh-machine safe).
    const committer = this.committerFor(mapping, auth, repo);
    const firstPush = base === "" && (opts.firstSync ?? "pull") === "push" && mapping.direction !== "pull-only";
    if (!(await this.isCloned(dir))) {
      status?.(firstPush ? "first sync: cloning repository (refs only, no history download)" : "first sync: cloning repository");
      // Clear any half-cloned remains — git refuses to clone into a non-empty dir.
      this.seams.rmDir?.(dir);
      await this.client.withAuth(auth).clone(repo.httpUrlToRepo, dir, { filter: "blob:none", noCheckout: firstPush });
    }
    if (firstPush) return this.firstSyncPush(mapping, branch, c, dir, status, committer);

    // Push-only mappings still fetch — the remote tip is what a push must build
    // on to stay fast-forward — but the label should say why, not imply pulling.
    status?.(
      base === ""
        ? "first sync: fetching remote"
        : mapping.direction === "push-only"
          ? "checking remote tip"
          : "fetching remote changes",
    );
    await c.fetch();
    const localSha = await c.currentHead();
    const remoteRef = `origin/${branch}`;
    let remoteSha: string;
    try {
      remoteSha = await c.revParse(remoteRef);
    } catch {
      throw new Error(`branch "${branch}" was not found on the remote (deleted or renamed upstream?) — check the mapping's branch setting`);
    }
    // Effective 3-way base: the recorded baseline, else the true merge-base of the
    // local and remote tips (a clone whose baseline was lost — settings reset —
    // must not treat every file as brand-new).
    const baseSha = await this.effectiveBase(base, c, localSha, remoteRef);

    // decideSyncAction consults the ancestry oracle at most once (with
    // localSha, [remoteSha]); precompute it so the pure contract stays synchronous.
    const localContainsRemote = await c.isAncestor(localSha, [remoteSha]);

    const decision = planSync({
      direction: mapping.direction,
      base,
      localSha,
      remoteSha,
      isAncestor: () => localContainsRemote,
      localHasUnpushed: localSha !== base,
    });

    // Planning phase (contract §2): derive the SyncPlan from topology + direction.
    // Idle is PROVISIONAL here — it is verified only after mergeSides' stat-scan
    // proves trustworthy unchanged-vault evidence (contract §8). The dryRun gate
    // lives at plan time: planning is read-only, so a dry run returns immediately
    // with the plan and never reaches mergeSides/execute (zero mutations).
    const plannedKind: SyncPlanKind =
      decision.pull === "none" && !decision.push
        ? "idle"
        : decision.pull === "rebase" && decision.push
          ? "merge-clean"
          : decision.pull === "rebase"
            ? "apply-remote"
            : decision.push
              ? "publish-local"
              : "apply-remote";
    const plannedCounts = { publish: decision.push ? 1 : 0, apply: decision.pull === "none" ? 0 : 1, deferred: 0, conflicted: 0 };
    if (opts.dryRun) {
      // Zero mutations from here on: no merge/apply/commit/push.
      return {
        mappingId: mapping.id,
        pull: decision.pull,
        push: decision.push,
        needsConflictResolution: false,
        conflicts: [],
        renames: [],
        kind: plannedKind,
        counts: plannedCounts,
      };
    }

    // S01 recovery: pendingOps from a previous pass (deferred by the editor guard or
    // interrupted) are verified against actual vault bytes FIRST — completed entries
    // drop, incomplete ones re-apply (the editor may have closed since). Never
    // silently dropped; failures surface with attempts+lastError.
    const remainingPending = await this.recoverPendingOps(mapping);

    // 3-way merge the local side in as "ours": base = the last-synced tree, theirs =
    // the remote tip, ours = the mapping's vault folder (via the mirror) or, without
    // a mirror, the clone's own HEAD (legacy clone↔remote semantics). Clean results
    // land in the clone's working tree; genuine conflicts are surfaced below.
    const merged = await this.mergeSides(mapping, c, dir, baseSha, localSha, remoteRef, remoteSha, status, {
      uncertain: opts.uncertain || remainingPending.length > 0,
      signal: opts.signal,
    });

    if (merged.conflicts.length > 0) {
      // Replace-by-path, not append: a fresh divergence supersedes the stored record
      // for the same file. The old append duplicated every still-divergent file's full
      // base/ours/theirs contents on every pass (~5 min) — with autoMerge off that
      // grew data.json without bound and showed N copies per file in the panel.
      const prior = new Map((this.conflicts?.getConflicts(mapping.id) ?? []).map((c) => [c.path, c]));
      for (const c of merged.conflicts) prior.set(c.path, c);
      this.conflicts?.setConflicts(mapping.id, [...prior.values()]);
      return {
        mappingId: mapping.id,
        pull: decision.pull,
        push: false,
        needsConflictResolution: true,
        conflicts: merged.conflicts,
        renames: merged.renames,
        kind: "conflict",
        counts: { ...plannedCounts, conflicted: merged.conflicts.length },
        blocked: merged.blocked,
      };
    }

    // Clean merge is now in the working tree. Re-point the branch at the remote tip
    // (mixed reset keeps the working tree) so the merged content commits on top of
    // the tip and the push fast-forwards — committing on the old diverged HEAD would
    // leave the push non-fast-forward and git would reject it. Skipped when the
    // branch already sits at the tip.
    if (localSha !== remoteSha) {
      await c.reset(remoteRef);
    }

    // Pull side: land the clone's now-current content back into the vault folder
    // (skipped for push-only mappings — they must never take remote content).
    // E01: on a VERIFIED-idle pass (remote unchanged, correspondence proven, and the
    // merge produced nothing to apply) mirrorPull would be pure no-op re-reading —
    // skip it. First-sync/never-populated mappings always take the full path.
    if (mapping.direction !== "push-only") {
      const alreadyPopulated = this.syncs.vaultPopulated?.(mapping.id) ?? false;
      const verifiedIdle = decision.pull === "none" && alreadyPopulated && merged.applied.length === 0 && merged.autoResolvedPaths.length === 0;
      let deferred: PendingOperation[] = [];
      if (!verifiedIdle) {
        deferred = await this.mirrorPull(mapping, dir, c, baseSha, remoteRef, status, opts.signal);
      }
      // S01: deferred vault operations (editor-open guard) become DURABLE pendingOps.
      // They ride in persisted state until applied+verified; correspondence never
      // advances past unapplied work.
      this.syncs.recordPendingOps?.(mapping.id, deferred.length > 0 ? deferred : this.syncs.pendingOps?.(mapping.id) ?? []);
      if (deferred.length > 0) status?.(`deferred ${deferred.length} vault change(s) — files open with unsaved edits`);
    } else {
      this.syncs.recordPendingOps?.(mapping.id, this.syncs.pendingOps?.(mapping.id) ?? []);
    }

    // Push side: stage, commit and push the in-scope merged changes. Without a
    // vault mirror, uncommitted clone working-tree changes also stage (legacy
    // clone-side semantics). Held paths (Area 8 review queue) never leave the machine.
    let pushed = false;
    if (mapping.direction !== "pull-only") {
      const held = this.heldPaths?.(mapping.id);
      const legacyChanges = this.vaultMirror ? [] : await c.workingTreePaths();
      const stagedPaths = [...new Set([...merged.applied.map((a) => a.path), ...merged.autoResolvedPaths, ...legacyChanges])].filter(
        (path) => this.inScope(mapping, path) && !(held?.has(path) ?? false),
      );
      if (stagedPaths.length > 0) {
        status?.(base === "" ? `first sync: committing vault content (${stagedPaths.length} files)` : `committing (${stagedPaths.length} files)`);
        await c.add(stagedPaths);
        // S04: commit eligibility is STAGED-ONLY and SCOPED. The gate is a pathspec-
        // scoped `git diff --cached --name-only -- <stagedPaths>`, so pre-existing
        // index entries OUTSIDE this mapping's scope (another mapping's or a user's
        // staged work in the shared clone) can neither enter the commit nor trip an
        // empty one. Full porcelain stays discovery-only.
        if (await this.hasScopedStagedChanges(c, stagedPaths)) {
          const agent = this.pickAgent?.(mapping);
          const author = agent ? authorRefForAgent(agent) : undefined;
          await c.commit(
            formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath, ownerHuman: author?.ownerHuman }),
            author?.email ? { name: author.name, email: author.email } : undefined,
            committer,
          );
          status?.("pushing to remote");
          await c.push("origin", branch);
          this.syncs.recordPush(mapping.id, await c.currentHead());
          pushed = true;
        } else if (decision.push) {
          // Nothing new to commit, but the branch carries unpushed commits.
          await c.push("origin", branch);
          pushed = true;
        }
      } else if (decision.push) {
        await c.push("origin", branch);
        this.syncs.recordPush(mapping.id, localSha);
        pushed = true;
      }
    }

    // A fully clean pass supersedes any previously recorded conflicts: the merge
    // re-evaluates every in-scope file each pass, so stale records (from an older
    // divergent state, since resolved or overwritten) would only clutter the UI.
    if (this.conflicts) this.conflicts.setConflicts(mapping.id, []);
    // Persist the per-file fingerprints gathered during THIS pass so the next
    // steady-state check compares against a snapshot of the last COMPLETED pass.
    this.syncs.recordContentSnapshot?.(mapping.id, merged.fingerprints);
    // Record the post-push tip when this pass pushed: the pre-push remoteSha would
    // leave the 3-way base one commit stale, surfacing spurious conflicts (and
    // content duplication under the default "both" resolution) on the next pass.
    const finalRemoteSha = pushed ? await c.currentHead() : remoteSha;
    this.syncs.recordPull(mapping.id, finalRemoteSha);
    // S01: correspondence (the PROVEN vault↔repo point) advances ONLY when every
    // planned vault application completed — no deferred writes/deletes and no
    // pending ops left. Otherwise correspondence stays at the last proven point and
    // the pendingOps list forces replan/verify on the next pass.
    const pendingNow = this.syncs.pendingOps?.(mapping.id) ?? [];
    const blockedNow = pendingNow.filter((p) => p.state === "failed");
    if (pendingNow.length === 0) {
      this.syncs.recordCorrespondence?.(mapping.id, finalRemoteSha);
    }
    const deferredNow = pendingNow.filter((p) => p.state !== "failed").length;
    const verifiedIdlePass = decision.pull === "none" && !pushed && pendingNow.length === 0 && merged.applied.length === 0 && merged.autoResolvedPaths.length === 0;
    return {
      mappingId: mapping.id,
      pull: decision.pull,
      push: pushed,
      needsConflictResolution: false,
      newRemoteSha: finalRemoteSha,
      conflicts: [],
      renames: [],
      kind: verifiedIdlePass ? "idle" : pushed ? "publish-local" : decision.pull !== "none" ? "apply-remote" : "idle",
      counts: {
        publish: pushed ? merged.applied.length : 0,
        apply: decision.pull !== "none" ? merged.applied.length : 0,
        deferred: deferredNow,
        conflicted: 0,
      },
      blocked: merged.blocked,
      ...(blockedNow.length > 0 ? { pendingFailures: blockedNow.length } : {}),
    };
  }

  /**
   * Push-first initialization: upload the vault folder onto the remote without
   * downloading its history. The clone is blobless + no-checkout (refs and trees
   * only); the index is populated from the remote tip via a mixed reset so the
   * commit builds ON the tip tree; vault content is written over it (additive —
   * remote-only files are kept, never deleted) and pushed as a fast-forward. On
   * an empty remote (unborn HEAD) this creates the branch's first commit.
   */
  private async firstSyncPush(mapping: FolderMapping, branch: string, c: GitClient, dir: string, status?: (m: string) => void, committer?: Author): Promise<SyncResult> {
    const head = await c.currentHead(); // "" when the remote is empty (unborn HEAD)
    if (head) {
      // A --no-checkout clone leaves the index EMPTY; a commit from an empty index
      // would read as "delete every tip file not re-added". Populate the index from
      // the tip first (mixed reset keeps the — empty — working tree).
      await c.reset("HEAD");
    }
    // NAMES-ONLY vault scan: the pre-streaming version preloaded every vault file's
    // content into memory to plan the push — a multi-thousand-file first sync OOMed
    // the process before writing a byte. Content is read file-by-file at write time.
    const vaultNames = this.vaultMirror ? await this.vaultMirror.list(mapping.localFolder) : [];
    if (vaultNames.length === 0) {
      throw new Error(
        `first-sync push refused: vault folder "${mapping.localFolder}" has no files — switch first-sync direction to pull, or add files to the folder first`,
      );
    }
    const held = this.heldPaths?.(mapping.id);
    // §9: every path is safePath-validated BEFORE use; rejected paths are blocked
    // (skipped + surfaced), never sanitized.
    const uploads = vaultNames
      .map((rel) => ({ rel, repoPath: vaultToRepoPath(mapping, rel) }))
      .filter(({ repoPath }) => this.inScope(mapping, repoPath) && this.mirrorListable(repoPath) && checkRelPath(repoPath).ok)
      .filter(({ repoPath }) => !(held?.has(repoPath) ?? false));
    status?.(`first sync: uploading vault (${uploads.length} files)`);
    // Additive: remote-only files are kept — no deletions during a push-first init.
    let skippedUploads = 0;
    for (const { rel, repoPath } of uploads) {
      let content: string;
      try {
        content = await this.vaultMirror!.read(mapping.localFolder, rel);
      } catch (err) {
        // One unreadable file must not abort the whole init — skip it.
        console.warn("MUGS: skipping unreadable vault file during first-sync push:", rel, err);
        skippedUploads++;
        continue;
      }
      const absPath = `${dir}/${repoPath}`;
      await this.workingTree?.writeFile(absPath, content);
    }

    const writePaths = uploads.map(({ repoPath }) => repoPath);
    let pushed = false;
    if (writePaths.length > 0) {
      await c.add(writePaths);
      if ((await c.porcelain()).length > 0) {
        const agent = this.pickAgent?.(mapping);
        const author = agent ? authorRefForAgent(agent) : undefined;
        await c.commit(
          formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath, ownerHuman: author?.ownerHuman }),
          author?.email ? { name: author.name, email: author.email } : undefined,
          committer,
        );
        status?.("first sync: pushing to remote");
        await c.push("origin", branch);
        pushed = true;
      }
    }
    const newHead = await c.currentHead();
    this.syncs.recordPush(mapping.id, newHead);
    this.syncs.recordPull(mapping.id, newHead);
    // E03: populated is set ONLY on real correspondence — every in-scope vault file
    // actually reached the remote. Skipped (unreadable/held) uploads leave the vault
    // and remote divergent, so the flag stays unset and deletions stay disabled.
    if (skippedUploads === 0) {
      this.syncs.recordVaultSync?.(mapping.id);
    } else {
      status?.(`first sync: ${skippedUploads} file(s) could not be read — deletions stay disabled for this mapping`);
    }
    // A completed init supersedes any previously recorded conflicts for the mapping.
    if (this.conflicts) this.conflicts.setConflicts(mapping.id, []);
    return { mappingId: mapping.id, pull: "none", push: pushed, needsConflictResolution: false, newRemoteSha: newHead, conflicts: [], renames: [] };
  }

  /** The recorded last-sync SHA when present, else the true merge-base of the two
   *  tips; "" when there is no local history or no common ancestor at all.
   *  Mirror-mode note: a missing baseline IS the first sync — no merge-base
   *  fallback there, or the empty vault would read as "ours deleted everything"
   *  against base==theirs, and differing files would silently resolve as ours-only
   *  edits instead of surfacing as add/add conflicts. The fallback exists for the
   *  legacy no-mirror mode, where the clone's own history is the local side. */
  private async effectiveBase(base: string, c: GitClient, localSha: string, remoteRef: string): Promise<string> {
    if (base) return base;
    if (!localSha) return "";
    if (this.vaultMirror) return "";
    try {
      return await c.mergeBase(localSha, remoteRef);
    } catch {
      return "";
    }
  }

  private async mergeSides(
    mapping: FolderMapping,
    c: GitClient,
    dir: string,
    baseSha: string,
    localSha: string,
    remoteRef: string,
    remoteSha: string,
    status?: (m: string) => void,
    o?: { uncertain?: boolean; signal?: AbortSignal },
  ): Promise<{ applied: AppliedChange[]; conflicts: FileConflict[]; renames: Rename[]; autoResolvedPaths: string[]; fingerprints: Record<string, [number, number]>; blocked: BlockedFile[] }> {
    // Steady-state shortcut (ALL directions, contract §8/E01): when the remote tip
    // equals the recorded baseline and a vault file's (mtime, size) pair matches the
    // snapshot recorded at the last completed pass (mtime predating it), ours ==
    // theirs == base is PROVEN — the per-file vault read AND both `git show`s are
    // skipped. mtime ALONE was not safe: a file restored from a backup (old mtime,
    // new content) was skipped as unchanged; the exact pair + mtime-ordering rule
    // closes that. Uncertainty (startup, watcher doubt, changed fingerprint,
    // pending work) disables the skip entirely — verify, never report false success.
    const remoteUnchanged = baseSha !== "" && remoteSha === baseSha;
    const statAvailable = this.vaultMirror?.stat !== undefined;
    const steadyState = statAvailable;
    const lastDone = remoteUnchanged ? (this.syncs.lastCompletedAt?.(mapping.id) ?? 0) : 0;
    const prevSnap = remoteUnchanged && !o?.uncertain ? (this.syncs.contentSnapshot?.(mapping.id) ?? {}) : {};
    const staleRels = new Set<string>();
    const fingerprints: Record<string, [number, number]> = {};
    if (steadyState) {
      for (const rel of await this.vaultMirror!.list(mapping.localFolder)) {
        const repoPath = vaultToRepoPath(mapping, rel);
        if (!this.inScope(mapping, repoPath) || !this.mirrorListable(repoPath)) continue;
        let fp: [number, number] | undefined;
        try {
          const st = await this.vaultMirror!.stat!(mapping.localFolder, rel);
          fp = st ? [st.mtime, st.size] : undefined;
        } catch {
          fp = undefined; // unreadable -> treat as fresh (safe direction)
        }
        if (fp) fingerprints[rel] = fp;
        if (remoteUnchanged && !o?.uncertain && isSnapshotStale(fp, prevSnap[rel], lastDone)) staleRels.add(rel);
      }
    }
    const isStale = (repoPath: string): boolean => {
      const rel = repoToVaultPath(mapping, repoPath);
      return rel !== null && staleRels.has(rel);
    };
    const allClonePaths = (await c.lsFiles()).filter((p) => this.inScope(mapping, p) && this.mirrorListable(p) && checkRelPath(p).ok);
    const clonePaths = allClonePaths.filter((p) => !isStale(p));
    // NAMES-ONLY vault scan: the pre-streaming version preloaded EVERY vault file's
    // content here, then held base+ours+theirs for the whole tree simultaneously —
    // a 900-file folder ran the process out of heap during a full pass. Content is
    // now read per bounded batch (see below) and released after each batch applies.
    const vaultNames = this.vaultMirror ? new Set(await this.vaultMirror.list(mapping.localFolder)) : new Set<string>();
    // Without a mirror the vault side is absent, so the changed-path diffs are the
    // merge universe (legacy clone↔remote semantics: ours = the clone's HEAD).
    const diffPaths = this.vaultMirror
      ? []
      : baseSha
        ? [
            ...(await c.changedPaths(`${baseSha}...${localSha}`)),
            ...(await c.changedPaths(`${baseSha}...${remoteRef}`)),
          ].filter((p) => this.inScope(mapping, p) && this.mirrorListable(p))
        : [];
    const allPaths = new Set<string>([...clonePaths, ...diffPaths]);
    if (this.vaultMirror) {
      // Vault-only paths (brand-new local files the clone has never seen) join the
      // merge universe too — names are cheap, content is read per batch.
      for (const rel of vaultNames) {
        const repoPath = vaultToRepoPath(mapping, rel);
        if (this.inScope(mapping, repoPath) && this.mirrorListable(repoPath) && !staleRels.has(rel)) allPaths.add(repoPath);
      }
    }

    // Legacy-state reconciliation (fail-safe, one-time per mapping): without the
    // vaultPopulated flag a vault-absent file is NEVER treated as a deletion, so a
    // genuinely deleted file would never leave the remote. When the vault folder
    // contains EVERY in-scope remote file, correspondence is proven and the flag can
    // be set; when it does not, keep deletions disabled and say why — never guess.
    if (this.vaultMirror && mapping.direction !== "pull-only" && !(this.syncs.vaultPopulated?.(mapping.id) ?? false)) {
      const missing = allClonePaths.filter((p) => {
        const rel = repoToVaultPath(mapping, p);
        return rel === null || !vaultNames.has(rel);
      });
      if (allClonePaths.length > 0 && missing.length === 0) {
        this.syncs.recordVaultSync?.(mapping.id);
      } else if (missing.length > 0) {
        status?.(`reconciliation: ${missing.length} remote file(s) not in the vault — deletions stay disabled for this mapping`);
      }
    }
    // A vault-absent in-scope file is a genuine user deletion ONLY once a sync has
    // established vault↔remote correspondence (vaultPopulated — set by a mirror-pull,
    // a completed first-sync push, or the coverage reconciliation above). Before that
    // the file is simply one the vault has not seen yet, and treating it as deleted
    // would wipe remote content. Pull-only mappings never push deletions.
    const deletable = mapping.direction !== "pull-only" && (this.syncs.vaultPopulated?.(mapping.id) ?? false);
    // Empty-vault guard: a populated mapping whose vault folder went empty (rename,
    // move, typo) must refuse the pass rather than mirror-delete the entire remote
    // subtree for every teammate. Names-based — an empty/unreadable folder has no
    // in-scope entries to merge, and mirroring would mean mass deletion.
    if (this.vaultMirror && deletable && vaultNames.size === 0 && clonePaths.length > 0) {
      throw new Error(
        `vault folder "${mapping.localFolder}" is empty but the remote still has ${clonePaths.length} in-scope file(s) — refusing to sync (was the folder renamed, moved, or misconfigured?). Restore the folder or remove the mapping.`,
      );
    }

    status?.(`merging (${allPaths.size} files)`);

    // Bounded-batch streaming merge: read -> merge -> (auto-)resolve -> apply, one
    // batch at a time. Content for at most MERGE_BATCH paths is alive at once, so
    // memory scales with the batch size instead of the tree size. Per-batch
    // orderApplyOps keeps writes-before-deletes/parents-before-children inside the
    // batch (cross-batch path swaps were already near-impossible in the old
    // whole-tree apply and remain guarded by the applier's own ordering).
    const MERGE_BATCH = 32;
    const paths = [...allPaths];
    const appliedPaths: string[] = [];
    const autoResolvedPaths: string[] = [];
    const surfacedConflicts: FileConflict[] = [];
    const blocked: BlockedFile[] = [];
    const renames: Rename[] = [];
    // Typed reads (S02): an ERROR result blocks the file for this pass with a
    // redacted reason — it must NEVER be treated as absence (which would plan a
    // deletion or push one). Only {kind:"absent"} is a true deletion on that side.
    const readTyped = async (ref: string, path: string): Promise<string | undefined | null> => {
      const res = await c.showTyped(ref, path);
      if (res.kind === "content") return res.content;
      if (res.kind === "absent") return undefined;
      blocked.push({ path, reason: res.error.message });
      return null; // blocked marker
    };
    for (let i = 0; i < paths.length; i += MERGE_BATCH) {
      const batch = paths.slice(i, i + MERGE_BATCH);
      const entries: FileVersions[] = [];
      for (const path of batch) {
        // Preserve undefined so a deleted side is treated as a deletion (jj None), not an empty file.
        let base: string | undefined;
        if (baseSha) {
          const b = await readTyped(baseSha, path);
          if (b === null) continue; // blocked — surfaced per-file, never a deletion
          base = b;
        }
        let ours: string | undefined;
        if (!this.vaultMirror) {
          // When the clone HEAD is exactly the baseline tree, ours == base by
          // construction — reuse instead of a second show (E01 idle cost).
          if (baseSha && localSha === baseSha) {
            ours = base;
          } else {
            const r = await readTyped("HEAD", path);
            if (r === null) continue;
            ours = r;
          }
        } else {
          const rel = repoToVaultPath(mapping, path);
          if (rel !== null && vaultNames.has(rel)) {
            // A LISTED file whose read FAILS skips only that file for this pass —
            // it must not read as a deletion (which would push one).
            try {
              ours = await this.vaultMirror!.read(mapping.localFolder, rel);
            } catch (err) {
              blocked.push({ path, reason: `vault file unreadable: ${String(err).slice(0, 160)}` });
              continue;
            }
          } else if (deletable) {
            ours = undefined; // vault had it (populated) and no longer does -> deletion
          } else if (baseSha) {
            // not seen yet -> act as unchanged (the base content the vault has not
            // taken yet); base was already read above — reuse it (E01).
            ours = base;
          } else {
            ours = undefined;
          }
        }
        // When the remote tip IS the baseline tree, theirs == base by construction —
        // reuse instead of a second show per file (E01 idle cost: 600 → 0 shows).
        let theirs: string | undefined;
        if (remoteSha === baseSha && baseSha) {
          theirs = base;
        } else {
          const t = await readTyped(remoteRef, path);
          if (t === null) continue;
          theirs = t;
        }
        // S06: binary content must never enter text concatenation — a NUL byte in
        // any side marks the file binary; blocked with a distinct reason.
        if ([base, ours, theirs].some((s) => s !== undefined && s.includes("\0"))) {
          blocked.push({ path, reason: "binary content excluded from text merge" });
          continue;
        }
        entries.push({ path, base, ours, theirs });
      }
      const resolved = await Promise.all(entries);

      // Recognize cross-device moves by content identity so a rename surfaces as a
      // move rather than a delete + add pair (per batch — a move whose two halves
      // land in different batches surfaces as delete + add, never as content loss).
      renames.push(
        ...detectRenames(
          Object.fromEntries(resolved.filter((r) => r.base !== undefined).map((r) => [r.path, r.base as string])),
          Object.fromEntries(resolved.filter((r) => r.theirs !== undefined).map((r) => [r.path, r.theirs as string])),
        ),
      );

      const { applied, conflicts } = applyMerge(resolved);

      // Recency inputs (Area 2): attach each side's last-modified time so the policy's
      // recency-wins rule can actually pick a winner. Vault side: the file's mtime
      // (mirror seam). Remote side: the last commit that touched the path — commit
      // metadata only, so blobless partial clones never lazy-fetch a blob for this.
      if (conflicts.length > 0 && this.policy?.recencyWins) {
        for (const cf of conflicts) {
          if (!cf.oursAbsent) {
            const vaultRel = repoToVaultPath(mapping, cf.path);
            if (vaultRel !== null) {
              try {
                cf.oursSavedAt = await this.vaultMirror?.mtime?.(mapping.localFolder, vaultRel);
              } catch {
                // stat unavailable -> leave undefined
              }
            }
          }
          try {
            const secs = await c.lastModifiedAt(remoteRef, cf.path);
            if (secs !== undefined) cf.theirsModifiedAt = secs * 1000;
          } catch {
            // log unavailable -> leave undefined
          }
        }
      }

      // S06 (contract §4): autoMerge now means CLEAN three-way auto-merge ONLY.
      // Genuine conflicts (unresolved hunks, delete/modify, divergent add/add,
      // binary) are RECORDED and SURFACED — never silently auto-resolved.
      // recencyWins / defaultResolution:"both" are one-click UI suggestions
      // (conflictActions) requiring explicit user choice, not engine defaults.
      const batchSurfaced = conflicts;
      // Best-effort recoverable content for deletes: the clone's current (theirs) content,
      // so a deletion is recorded in `.mugs-trash` before the working-tree removal.
      const priorByPath = new Map(resolved.map((e) => [e.path, e.theirs]));
      const toApply: Array<ApplyOp & { content?: string; priorContent?: string }> = applied.map((a) => {
        const op: ApplyOp & { content?: string; priorContent?: string } = toWriteOp(a);
        if (op.kind === "delete") op.priorContent = priorByPath.get(a.path);
        return op;
      });

      // Safe applier ordering: writes before deletes, parents before children.
      await this.applyOrdered(dir, orderApplyOps(toApply), mapping.id);
      for (const a of applied) appliedPaths.push(a.path);
      surfacedConflicts.push(...batchSurfaced);
      // Batch contents are unreachable from here — memory stays bounded.
    }
    return {
      applied: appliedPaths.map((path) => ({ path } as AppliedChange)),
      conflicts: surfacedConflicts,
      renames,
      autoResolvedPaths,
      fingerprints,
      blocked,
    };
  }

  /** S01 recovery: verify pendingOps against ACTUAL vault bytes before any new
   *  reconciliation. Completed operations (file bytes already match / file already
   *  gone) are dropped; incomplete ones re-apply (the editor may have closed since);
   *  failures are kept surfaced with attempts+lastError — never silently dropped,
   *  never republished as a new local edit. Returns the still-outstanding list. */
  private async recoverPendingOps(mapping: FolderMapping): Promise<PendingOperation[]> {
    const pending = this.syncs.pendingOps?.(mapping.id) ?? [];
    if (pending.length === 0 || !this.vaultMirror) return pending.length > 0 && !this.vaultMirror ? pending : [];
    const remaining: PendingOperation[] = [];
    for (const op of pending) {
      if (op.state === "failed") {
        remaining.push(op); // surfaced to the user; retried only via explicit resolution
        continue;
      }
      let current: string | undefined;
      try {
        current = await this.vaultMirror.read(mapping.localFolder, op.path);
      } catch {
        current = undefined;
      }
      if (op.kind === "vault-write") {
        if (current === (op.content ?? "")) continue; // applied + verified -> complete
        const vaultPath = vaultRootPath(mapping.localFolder, op.path);
        if (this.editorOpen && !this.editorOpen.isWriteSafe(vaultPath)) {
          remaining.push({ ...op, attempts: op.attempts + 1 });
          continue;
        }
        try {
          await this.vaultMirror.write(mapping.localFolder, op.path, op.content ?? "");
        } catch (err) {
          remaining.push({ ...op, attempts: op.attempts + 1, lastError: String(err).slice(0, 200) });
        }
      } else if (op.kind === "vault-delete") {
        if (current === undefined) continue; // already gone -> verified
        const vaultPath = vaultRootPath(mapping.localFolder, op.path);
        if (this.editorOpen && !this.editorOpen.isWriteSafe(vaultPath)) {
          remaining.push({ ...op, attempts: op.attempts + 1 });
          continue;
        }
        try {
          this.trash?.trash(mapping.id, vaultPath, current);
          await this.vaultMirror.remove(mapping.localFolder, op.path);
        } catch (err) {
          remaining.push({ ...op, attempts: op.attempts + 1, lastError: String(err).slice(0, 200) });
        }
      } else {
        // clone-commit / remote-push: the normal pass re-plans and re-runs them.
        remaining.push(op);
      }
    }
    this.syncs.recordPendingOps?.(mapping.id, remaining);
    return remaining;
  }

  /** S04: commit eligibility — STAGED-ONLY and SCOPED. Runs
   *  `git diff --cached --name-only -z -- <paths>` and requires a non-empty result,
   *  so pre-existing index entries outside this mapping's pathspec can neither enter
   *  the commit nor trigger an empty one. Full porcelain is discovery-only. */
  private async hasScopedStagedChanges(c: GitClient, paths: string[]): Promise<boolean> {
    if (paths.length === 0) return false;
    const CHUNK = 500;
    for (let i = 0; i < paths.length; i += CHUNK) {
      const scope = paths.slice(i, i + CHUNK);
      const r = await c.run(["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "-z", "--", ...scope]);
      if (r.code !== 0) return false; // cannot prove eligibility -> no commit (safe)
      if (r.stdout.split("\u0000").some((s) => s.length > 0)) return true;
    }
    return false;
  }

  /** Pull the clone's current in-scope content into the vault folder: writes for
   *  every in-scope clone file (skipping no-ops the vault already has), deletions
   *  only for paths git says the remote side removed since the last sync — never
   *  for vault files the remote simply has never seen. Writes AND deletes are
   *  editor-protected: a path open with unsaved changes is DEFERRED into a durable
   *  pendingOp (returned to the caller for persistence) instead of silently
   *  skipped — correspondence never advances past unapplied work (S01). STREAMING:
   *  plan ops are name-only; clone content is read one file at a time in the apply
   *  loop, so memory stays flat on huge trees. Returns the deferred pendingOps. */
  private async mirrorPull(
    mapping: FolderMapping,
    dir: string,
    c: GitClient,
    baseSha: string,
    remoteRef: string,
    status?: (m: string) => void,
    signal?: AbortSignal,
  ): Promise<PendingOperation[]> {
    if (!this.vaultMirror) return [];
    const passOpId = Date.now().toString(36);
    const deferred: PendingOperation[] = [];
    // Names only — contents are read per op below. §9: every path from the index
    // listing passes checkRelPath before use; rejected paths are blocked, never
    // sanitized.
    const clonePaths = (await c.lsFiles()).filter((p) => this.inScope(mapping, p) && this.mirrorListable(p) && checkRelPath(p).ok);
    const deletedRepoPaths = baseSha
      ? (await c.deletedPaths(`${baseSha}..${remoteRef}`)).filter((p) => this.inScope(mapping, p) && this.mirrorListable(p) && checkRelPath(p).ok)
      : [];
    // Reuse the pure pull planner for ordering + scoping; placeholder contents are
    // replaced with the real (lazily read) clone content in the apply loop below.
    const plan = planMirrorPull({
      mapping,
      cloneFiles: clonePaths.map((p) => ({ path: p, content: "" })),
      deletedRepoPaths,
    });
    status?.(baseSha === "" ? `first sync: populating vault (${clonePaths.length} files)` : `updating vault (${plan.ops.length} changes)`);

    for (const op of plan.ops) {
      if (signal?.aborted) break; // cancelled is never success — stop applying
      if (op.kind === "delete") {
        // Record the vault file's content before removing it so a remote-driven
        // deletion is recoverable via `.mugs-trash` (Area 3).
        let prior: string | undefined;
        try {
          prior = await this.vaultMirror.read(mapping.localFolder, op.path);
        } catch {
          prior = undefined;
        }
        // S01: editor protection for DELETES too — a file open with unsaved changes
        // is never removed; the deletion defers into a durable pendingOp.
        const delVaultPath = vaultRootPath(mapping.localFolder, op.path);
        if (this.editorOpen && !this.editorOpen.isWriteSafe(delVaultPath)) {
          deferred.push({
            opId: `${mapping.id}:${passOpId}:vault-delete:${op.path}`,
            kind: "vault-delete",
            path: op.path,
            state: "pending",
            createdAt: Date.now(),
            attempts: 0,
          });
          continue;
        }
        this.trash?.trash(mapping.id, delVaultPath, prior);
        await this.vaultMirror.remove(mapping.localFolder, op.path);
        continue;
      }
      // Prefer the working-tree content (it carries uncommitted merged results);
      // fall back to the committed tip for files not yet materialized on disk —
      // e.g. fetched-since-last-checkout files (a mixed reset never writes them).
      let content = await this.readCloneFile(dir, op.path);
      if (content === undefined) {
        // S02 typed read: an ERROR blocks the file (per-file blocked outcome) —
        // it must never read as absence (which would skip the write and strand
        // the vault stale while correspondence advanced).
        const res = await c.showTyped(remoteRef, op.path);
        if (res.kind === "content") content = res.content;
        else if (res.kind === "error") {
          deferred.push({
            opId: `${mapping.id}:${passOpId}:vault-write:${op.path}`,
            kind: "vault-write",
            path: op.path,
            refSha: remoteRef,
            state: "failed",
            createdAt: Date.now(),
            attempts: 1,
            lastError: res.error.message,
          });
          continue;
        } else continue; // genuinely absent at the ref — nothing to write
      }
      // Skip a no-op write (vault content already current).
      let current: string | undefined;
      try {
        current = await this.vaultMirror.read(mapping.localFolder, op.path);
      } catch {
        current = undefined; // absent -> definitely needs the write
      }
      if (current === content) continue;
      const vaultPath = vaultRootPath(mapping.localFolder, op.path);
      // S01: never clobber a file that is open with unsaved changes (Area 5) —
      // the write defers into a durable pendingOp and is retried/verified next pass.
      if (this.editorOpen && !this.editorOpen.isWriteSafe(vaultPath)) {
        deferred.push({
          opId: `${mapping.id}:${passOpId}:vault-write:${op.path}`,
          kind: "vault-write",
          path: op.path,
          content,
          refSha: remoteRef,
          state: "pending",
          createdAt: Date.now(),
          attempts: 0,
        });
        continue;
      }
      await this.vaultMirror.write(mapping.localFolder, op.path, content);
    }
    // The vault folder now mirrors the clone's in-scope content — from here on, a
    // vault-absent in-scope file is a real deletion (see mergeSides' `deletable`).
    // With deferred work the claim is only partial: the caller persists pendingOps
    // and leaves correspondence at its previous proven point.
    this.syncs.recordVaultSync?.(mapping.id);
    return deferred;
  }


  /** Read a clone working-tree file (undefined when absent or unreadable). */
  private async readCloneFile(dir: string, repoPath: string): Promise<string | undefined> {
    try {
      return await this.workingTree?.readFile?.(`${dir}/${repoPath}`);
    } catch {
      return undefined;
    }
  }

  /**
   * Apply ordered write/delete operations to the working tree. Writes skip any path that is
   * open with unsaved changes (the editor-open guard) so a remote/merge result never clobbers
   * an in-progress edit; deletions remove both-sides-deleted files.
   */
  private async applyOrdered(dir: string, ops: Array<ApplyOp & { content?: string; priorContent?: string }>, mappingId: string): Promise<void> {
    for (const op of ops) {
      const absPath = `${dir}/${op.path}`;
      if (op.kind === "delete") {
        // Record the file's prior content before removing it so a sync-driven deletion is
        // recoverable via `.mugs-trash` (Area 3). Runs synchronously ahead of deleteFile.
        this.trash?.trash(mappingId, op.path, op.priorContent);
        await this.workingTree?.deleteFile?.(absPath);
        continue;
      }
      // NOTE: no editor-open guard here — these are CLONE working-tree writes
      // (staging material), not vault writes; the vault-side guard lives in
      // mirrorPull where paths are in vault space. The old repo-space check never
      // matched and was dead.
      await this.workingTree?.writeFile(absPath, op.content ?? "");
    }
  }
}

/** True when `path` is inside the vault `.trash/` folder (a top-level dotfolder). */
function isTrashPath(path: string): boolean {
  return path === ".trash" || path.startsWith(".trash/");
}

/** Map an applied change to a write/delete op for the applier ordering. */
function toWriteOp(a: AppliedChange): ApplyOp & { content?: string } {
  return "content" in a ? { path: a.path, kind: "write", content: a.content } : { path: a.path, kind: "delete" };
}

/** Join a mapping's vault folder with a folder-relative path into a vault-root-relative
 *  path ("."/"" folder = the vault root). Used for editor-open checks and trash records. */
function vaultRootPath(localFolder: string, rel: string): string {
  const folder = localFolder === "." ? "" : localFolder.replace(/\/+$/, "");
  return folder ? `${folder}/${rel}` : rel;
}
