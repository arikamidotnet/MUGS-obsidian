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
import { GitClient, type GitAuth } from "../git/client";
import type { FolderMapping, FileConflict, SyncPolicy, ObsidianConfigPolicy, Agent } from "../types";
import { authorRefForAgent } from "./attribution";
import type { RepoSummary } from "../providers/types";
import { decideSyncAction, type SyncAction } from "./rebase-policy";
import { formatCommitMessage } from "./commit-message";
import { applyMerge, type AppliedChange } from "./conflict";
import { isInScope, detectRenames, type Rename } from "./exclusion";
import { isUnderObsidianRoot, shouldSyncObsidianPath } from "./obsidianScope";
import { orderApplyOps, type ApplyOp } from "./applier";
import { planMirrorPush, planMirrorPull, vaultToRepoPath, repoToVaultPath, type MirrorFile, type MirrorOp } from "./mirror";
import type { TrashStore } from "./trash";
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

/** Options for one mapping's sync pass. */
export interface SyncOpts {
  /** Which side wins when this mapping has never synced (no lastSync baseline):
   *  "pull" populates the vault from the remote (default); "push" uploads the
   *  vault onto the remote without downloading its history. */
  firstSync?: "pull" | "push";
  /** Optional progress reporter — receives human-readable phase text (rendered
   *  live in the status bar) while the pass runs. */
  onStatus?: (message: string) => void;
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
    if (config?.enabled && isUnderObsidianRoot(path)) {
      return shouldSyncObsidianPath(path, config);
    }
    // Opt-out gate for the vault `.trash/` folder: excluded when this mapping opts out.
    if (mapping.syncTrashFolder === false && isTrashPath(path)) return false;
    return true;
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

    const firstPush = base === "" && (opts.firstSync ?? "pull") === "push" && mapping.direction !== "pull-only";
    if (!(await this.isCloned(dir))) {
      status?.(firstPush ? "first sync: cloning repository (refs only, no history download)" : "first sync: cloning repository");
      // Clear any half-cloned remains — git refuses to clone into a non-empty dir.
      this.seams.rmDir?.(dir);
      await this.client.withAuth(auth).clone(repo.httpUrlToRepo, dir, { filter: "blob:none", noCheckout: firstPush });
    }
    if (firstPush) return this.firstSyncPush(mapping, branch, c, dir, status);

    status?.(base === "" ? "first sync: fetching remote" : "fetching remote changes");
    await c.fetch();
    const localSha = await c.currentHead();
    const remoteRef = `origin/${branch}`;
    const remoteSha = await c.revParse(remoteRef);
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

    // 3-way merge the local side in as "ours": base = the last-synced tree, theirs =
    // the remote tip, ours = the mapping's vault folder (via the mirror) or, without
    // a mirror, the clone's own HEAD (legacy clone↔remote semantics). Clean results
    // land in the clone's working tree; genuine conflicts are surfaced below.
    const merged = await this.mergeSides(mapping, c, dir, baseSha, localSha, remoteRef, status);

    if (merged.conflicts.length > 0) {
      const all = [...(this.conflicts?.getConflicts(mapping.id) ?? []), ...merged.conflicts];
      this.conflicts?.setConflicts(mapping.id, all);
      return { mappingId: mapping.id, pull: decision.pull, push: false, needsConflictResolution: true, conflicts: merged.conflicts, renames: merged.renames };
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
    if (mapping.direction !== "push-only") {
      await this.mirrorPull(mapping, dir, c, baseSha, remoteRef, merged.vaultByRepo, status);
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
        // Only commit when something is actually staged — mirroring content that
        // already equals the remote tree stages nothing and `git commit` would fail
        // with "nothing to commit".
        if ((await c.porcelain()).length > 0) {
          const agent = this.pickAgent?.(mapping);
          const author = agent ? authorRefForAgent(agent) : undefined;
          await c.commit(
            formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath, ownerHuman: author?.ownerHuman }),
            author?.email ? { name: author.name, email: author.email } : undefined,
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
    this.syncs.recordPull(mapping.id, remoteSha);
    return { mappingId: mapping.id, pull: decision.pull, push: pushed, needsConflictResolution: false, newRemoteSha: remoteSha, conflicts: [], renames: [] };
  }

  /**
   * Push-first initialization: upload the vault folder onto the remote without
   * downloading its history. The clone is blobless + no-checkout (refs and trees
   * only); the index is populated from the remote tip via a mixed reset so the
   * commit builds ON the tip tree; vault content is written over it (additive —
   * remote-only files are kept, never deleted) and pushed as a fast-forward. On
   * an empty remote (unborn HEAD) this creates the branch's first commit.
   */
  private async firstSyncPush(mapping: FolderMapping, branch: string, c: GitClient, dir: string, status?: (m: string) => void): Promise<SyncResult> {
    const head = await c.currentHead(); // "" when the remote is empty (unborn HEAD)
    if (head) {
      // A --no-checkout clone leaves the index EMPTY; a commit from an empty index
      // would read as "delete every tip file not re-added". Populate the index from
      // the tip first (mixed reset keeps the — empty — working tree).
      await c.reset("HEAD");
    }
    const vaultFiles = await this.readVaultFiles(mapping);
    const plan = planMirrorPush({ mapping, vaultFiles, clonePaths: [], includeDeletions: false });
    if (plan.refused) {
      throw new Error(
        `first-sync push refused: vault folder "${mapping.localFolder}" has no files — switch first-sync direction to pull, or add files to the folder first`,
      );
    }
    status?.(`first sync: uploading vault (${plan.ops.length} files)`);
    await this.applyToClone(dir, plan.ops, mapping.id);

    const held = this.heldPaths?.(mapping.id);
    const writePaths = plan.ops
      .filter((o) => o.kind === "write")
      .map((o) => o.path)
      .filter((path) => this.inScope(mapping, path) && !(held?.has(path) ?? false));
    let pushed = false;
    if (writePaths.length > 0) {
      await c.add(writePaths);
      if ((await c.porcelain()).length > 0) {
        const agent = this.pickAgent?.(mapping);
        const author = agent ? authorRefForAgent(agent) : undefined;
        await c.commit(
          formatCommitMessage({ op: "push", label: mapping.label, remotePath: mapping.remotePath, ownerHuman: author?.ownerHuman }),
          author?.email ? { name: author.name, email: author.email } : undefined,
        );
        status?.("first sync: pushing to remote");
        await c.push("origin", branch);
        pushed = true;
      }
    }
    const newHead = await c.currentHead();
    this.syncs.recordPush(mapping.id, newHead);
    this.syncs.recordPull(mapping.id, newHead);
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
    status?: (m: string) => void,
  ): Promise<{ applied: AppliedChange[]; conflicts: FileConflict[]; renames: Rename[]; vaultByRepo: Map<string, string>; autoResolvedPaths: string[] }> {
    const clonePaths = (await c.lsFiles()).filter((p) => this.inScope(mapping, p));
    const vaultFiles = await this.readVaultFiles(mapping);
    const vaultByRepo = new Map<string, string>();
    for (const f of vaultFiles) {
      const repoPath = vaultToRepoPath(mapping, f.path);
      if (this.inScope(mapping, repoPath)) vaultByRepo.set(repoPath, f.content);
    }
    // Without a mirror the vault side is absent, so the changed-path diffs are the
    // merge universe (legacy clone↔remote semantics: ours = the clone's HEAD).
    const diffPaths = this.vaultMirror
      ? []
      : baseSha
        ? [
            ...(await c.changedPaths(`${baseSha}...${localSha}`)),
            ...(await c.changedPaths(`${baseSha}...${remoteRef}`)),
          ].filter((p) => this.inScope(mapping, p))
        : [];
    const allPaths = new Set<string>([...clonePaths, ...vaultByRepo.keys(), ...diffPaths]);

    status?.(`merging (${allPaths.size} files)`);

    // A vault-absent in-scope file is a genuine user deletion ONLY once a mirror-pull
    // has populated the vault (push-pull mappings). Before that — first sync, or a
    // push-first init that never pulled — the file is simply one the vault has not
    // seen yet, and treating it as deleted would wipe remote content.
    const deletable = mapping.direction === "push-pull" && (this.syncs.vaultPopulated?.(mapping.id) ?? false);
    const entries = Array.from(allPaths).map(async (path) => ({
      path,
      // Preserve undefined so a deleted side is treated as a deletion (jj None), not an empty file.
      base: baseSha ? await c.show(baseSha, path) : undefined,
      ours: vaultByRepo.has(path)
        ? vaultByRepo.get(path)
        : this.vaultMirror
          ? deletable
            ? undefined // vault had it (populated) and no longer does -> deletion
            : baseSha
              ? await c.show(baseSha, path) // not seen yet -> act as unchanged; mirror-pull will fetch it
              : undefined
          : await c.show("HEAD", path),
      theirs: await c.show(remoteRef, path),
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

    // Recency inputs (Area 2): attach each side's last-modified time so the policy's
    // recency-wins rule can actually pick a winner. Before this the timestamps were
    // never populated anywhere in the sync path, so every genuine conflict fell
    // through to defaultResolution — recencyWins was effectively display-only.
    // Vault side: the file's mtime (mirror seam). Remote side: the last commit that
    // touched the path — commit metadata only, so blobless partial clones never
    // lazy-fetch a blob for this. Failures leave a timestamp undefined, which just
    // falls back to defaultResolution.
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

    // Automatic-first resolution: when a policy is injected and autoMerge is on, resolve
    // genuine conflicts automatically (recency-wins / defaultResolution) and write the
    // resolved content instead of surfacing them. Only unresolvable conflicts are returned
    // for manual review. With no policy injected this is a no-op — behavior is unchanged.
    let surfacedConflicts = conflicts;
    // Best-effort recoverable content for deletes: the clone's current (theirs) content,
    // so a deletion is recorded in `.mugs-trash` before the working-tree removal.
    const priorByPath = new Map(resolved.map((e) => [e.path, e.theirs]));
    const toApply: Array<ApplyOp & { content?: string; priorContent?: string }> = applied.map((a) => {
      const op: ApplyOp & { content?: string; priorContent?: string } = toWriteOp(a);
      if (op.kind === "delete") op.priorContent = priorByPath.get(a.path);
      return op;
    });
    // Auto-resolved conflict paths, staged on the push side alongside merged.applied —
    // a resolution that never gets committed would resurface as the same conflict on
    // every later sync (and mirror mode stages nothing implicitly).
    const autoResolvedPaths: string[] = [];
    if (this.policy?.autoMerge) {
      surfacedConflicts = [];
      for (const cf of conflicts) {
        if (canAutoResolve(cf, this.policy)) {
          const content = autoResolvedContent(cf, resolveConflictAuto(cf, this.policy)!);
          // Always write the resolved content into the clone working tree. Even when
          // it equals the vault's copy (an "ours" win) the clone does not hold it yet,
          // and `git add` stages from the working tree — the previous no-op skip left
          // ours-wins uncommitted in the clone forever.
          toApply.push({ path: cf.path, kind: "write", content });
          autoResolvedPaths.push(cf.path);
        } else {
          surfacedConflicts.push(cf);
        }
      }
    }

    // Safe applier ordering: writes before deletes, parents before children.
    await this.applyOrdered(dir, orderApplyOps(toApply), mapping.id);
    return { applied, conflicts: surfacedConflicts, renames, vaultByRepo, autoResolvedPaths };
  }

  /** Pull the clone's current in-scope content into the vault folder: writes for
   *  every in-scope clone file (skipping no-ops the vault already has and files
   *  open with unsaved edits), deletions only for paths git says the remote side
   *  removed since the last sync — never for vault files the remote simply has
   *  never seen. */
  private async mirrorPull(
    mapping: FolderMapping,
    dir: string,
    c: GitClient,
    baseSha: string,
    remoteRef: string,
    vaultByRepo: Map<string, string>,
    status?: (m: string) => void,
  ): Promise<void> {
    if (!this.vaultMirror) return;
    const cloneFiles: MirrorFile[] = [];
    for (const p of (await c.lsFiles()).filter((p) => this.inScope(mapping, p))) {
      // Prefer the working-tree content (it carries uncommitted merged results);
      // fall back to the committed tip for files not yet materialized on disk —
      // e.g. fetched-since-last-checkout files (a mixed reset never writes them).
      const content = (await this.readCloneFile(dir, p)) ?? (await c.show(remoteRef, p));
      if (content !== undefined) cloneFiles.push({ path: p, content });
    }
    const deletedRepoPaths = baseSha
      ? (await c.deletedPaths(`${baseSha}..${remoteRef}`)).filter((p) => this.inScope(mapping, p))
      : [];
    const plan = planMirrorPull({ mapping, cloneFiles, deletedRepoPaths });
    status?.(baseSha === "" ? `first sync: populating vault (${cloneFiles.length} files)` : `updating vault (${plan.ops.length} changes)`);

    for (const op of plan.ops) {
      if (op.kind === "delete") {
        // Record the vault file's content before removing it so a remote-driven
        // deletion is recoverable via `.mugs-trash` (Area 3).
        let prior: string | undefined;
        try {
          prior = await this.vaultMirror.read(mapping.localFolder, op.path);
        } catch {
          prior = undefined;
        }
        this.trash?.trash(mapping.id, vaultRootPath(mapping.localFolder, op.path), prior);
        await this.vaultMirror.remove(mapping.localFolder, op.path);
        continue;
      }
      // Skip a no-op write (vault content already current) and never clobber a
      // file that is open with unsaved changes (the editor-open guard, Area 5).
      const repoPath = vaultToRepoPath(mapping, op.path);
      if (vaultByRepo.get(repoPath) === (op.content ?? "")) continue;
      const vaultPath = vaultRootPath(mapping.localFolder, op.path);
      if (this.editorOpen && !this.editorOpen.isWriteSafe(vaultPath)) continue;
      await this.vaultMirror.write(mapping.localFolder, op.path, op.content ?? "");
    }
    // The vault folder now mirrors the clone's in-scope content — from here on, a
    // vault-absent in-scope file is a real deletion (see mergeSides' `deletable`).
    this.syncs.recordVaultSync?.(mapping.id);
  }

  /** Apply mirror ops (vault→clone direction) into a clone's working tree. Write
   *  parents are created by the writer seam; deletions record recoverable content
   *  in `.mugs-trash` first. Ops must already be apply-ordered. */
  private async applyToClone(dir: string, ops: MirrorOp[], mappingId: string): Promise<void> {
    for (const op of ops) {
      const absPath = `${dir}/${op.path}`;
      if (op.kind === "delete") {
        this.trash?.trash(mappingId, op.path, await this.readCloneFile(dir, op.path));
        await this.workingTree?.deleteFile?.(absPath);
        continue;
      }
      await this.workingTree?.writeFile(absPath, op.content ?? "");
    }
  }

  /** List + read the mapping's vault files (folder-relative). Empty without a mirror. */
  private async readVaultFiles(mapping: FolderMapping): Promise<MirrorFile[]> {
    if (!this.vaultMirror) return [];
    const rels = await this.vaultMirror.list(mapping.localFolder);
    const files: MirrorFile[] = [];
    for (const rel of rels) {
      files.push({ path: rel, content: await this.vaultMirror.read(mapping.localFolder, rel) });
    }
    return files;
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
      if (this.editorOpen && !this.editorOpen.isWriteSafe(op.path)) continue; // open w/ unsaved changes -> skip
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
