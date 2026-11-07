/**
 * MUGS — sync driver.
 *
 * Orchestrates a full sync pass across every mapping: for each mapping it resolves
 * the credential, builds a `Provider`, finds the repo the mapping points at, and
 * runs one `CloneManager.syncMapping` pass against it. The pure per-mapping logic
 * lives in CloneManager; this module only wires credentials → providers → repos →
 * manager and reports outcomes.
 *
 * Everything the driver needs is injected (mappings, credentials, token resolver,
 * provider factory, git runner, clone root, last-sync accessor), so it is fully
 * unit-testable with fakes and no real git/network. `main.ts` supplies the concrete
 * seams (ChildProcessRunner, store-backed accessor) and calls this from the ribbon
 * and command.
 */
import type { FolderMapping, Credential, LastSyncState, FileConflict, ObsidianConfigPolicy, Agent } from "../types";
import type { Provider, RepoSummary } from "../providers/types";
import type { HttpTransport } from "../providers/http";
import type { ProviderInput } from "../providers/factory";
import type { GitRunner } from "../git/types";
import { GitClient, type GitAuth } from "../git/client";
import { CloneManager, type LastSyncAccessor, type SyncResult, type SyncOpts, type VaultMirror, type WorkingTreeWriter, type ConflictStore } from "./cloneManager";
import type { TrashStore } from "./trash";
import type { EditorOpenGuard } from "./editorOpen";
import type { MugsStore } from "../store";
import type { SyncPolicy } from "../types";

/** Result of syncing one mapping. */
export interface SyncOutcome {
  mappingId: string;
  label: string;
  status: "ok" | "conflict" | "skipped";
  /** Human-readable reason when skipped (e.g. "no credential", "repo not found"). */
  reason?: string;
  pull?: SyncResult["pull"];
  push?: boolean;
  newRemoteSha?: string;
  /** Files that diverged and need manual resolution (present when status is "conflict"). */
  conflicts?: FileConflict[];
}

/** Options accepted by the injected provider factory (mirrors buildProvider). */
export interface ProviderFactory {
  (input: ProviderInput, opts?: { transport?: HttpTransport; actingUsername?: string }): Provider;
}

/** All seams the driver needs — inject fakes in tests, concrete values in main.ts. */
export interface SyncDriverDeps {
  mappings: FolderMapping[];
  credentials: Credential[];
  /** Resolve the live (possibly decrypted) token for a credential id. */
  getToken: (credentialId: string) => string | undefined;
  buildProvider: ProviderFactory;
  /** On-disk directory holding per-mapping clones, e.g. "<vault>/.mugs-clones". */
  cloneRoot: string;
  runner: GitRunner;
  lastSync: LastSyncAccessor;
  /** Optional: write merged file content into the working tree on a clean divergence merge. */
  workingTree?: WorkingTreeWriter;
  /** Optional: durable per-mapping conflict store, so conflicts survive across sessions. */
  conflicts?: ConflictStore;
  /** Optional: automatic-first resolution policy; when provided + autoMerge, genuine
   *  conflicts are auto-resolved (recency-wins / defaultResolution) instead of surfaced. */
  policy?: SyncPolicy;
  /** Optional: tracks paths open with unsaved changes so writes never clobber an edit. */
  editorOpen?: EditorOpenGuard;
  /** Optional: opt-in `.obsidian/` config sync scope (Area 9). When enabled, personal vs
   *  vault-wide classification gates which `.obsidian/` files are pulled/pushed. */
  obsidianConfig?: ObsidianConfigPolicy;
  /** Optional: resolve the agent sub-user acting on a mapping's push. When it returns an
   *  agent, the commit is attributed to that agent with an "On-behalf-of" owner trailer.
   *  Absent -> plain sync attribution (unchanged). */
  pickAgent?: (mapping: FolderMapping) => Agent | undefined;
  /** Optional: record a file's content before it is removed from the working tree during
   *  sync, so both-sides-deletions are recoverable via `.mugs-trash` (Area 3). */
  trash?: TrashStore;
  /** Optional: set of paths explicitly held back for review (Area 8). Held paths are
   *  excluded from push. Absent -> nothing held. */
  heldPaths?: (mappingId: string) => ReadonlySet<string> | undefined;
  /** Optional: filesystem view of each mapping's vault folder. When present the vault
   *  is the authoritative local side of every sync (mirrored into clones on push,
   *  populated from clones on pull). Wired in main.ts from the vault adapter. */
  vaultMirror?: VaultMirror;
  /** Optional: recursively remove a directory — clears the half-baked .git left by an
   *  interrupted clone so a retry can re-clone. */
  rmDir?: (dir: string) => void;
  /** Which side wins a mapping's FIRST sync (no baseline yet): "pull" (default) populates
   *  the vault from the remote; "push" uploads the vault without downloading history. */
  firstSyncDirection?: "pull" | "push";
  /** Optional: live progress reporter — receives phase text per mapping (status bar). */
  onStatus?: (message: string) => void;
  /** Optional: notified when a legacy mapping (no repoRef) resolves to a repo, so the
   *  caller can backfill repoRef — that pins the shared clone dir and fixes UI paths. */
  onRepoResolved?: (mappingId: string, repoRef: string) => void;
}

/**
 * Resolve the repo a mapping points at within the credential's visible repos.
 *
 * Match order: pinned `repoRef` (scoped links share one clone per repo), then the
 * legacy whole-repo form whose `id` IS the repo id, then — for legacy folder-scoped
 * links created before `repoRef` existed (random ids that match no repo id) — the
 * credential's single visible repo when exactly one is accessible. That fallback is
 * unambiguous: a credential scoped to one repo can only be pointing that mapping at
 * it. With several visible repos a legacy link stays unresolved rather than guessed.
 */
export function resolveRepo(
  repos: RepoSummary[],
  mapping: Pick<FolderMapping, "id" | "repoRef">,
): RepoSummary | undefined {
  const direct = repos.find((r) => (mapping.repoRef ? r.id === mapping.repoRef : r.id === mapping.id));
  if (direct) return direct;
  if (!mapping.repoRef && repos.length === 1) return repos[0];
  return undefined;
}

/** Run one sync pass over every mapping and return a per-mapping outcome list. */
export async function syncAllMappings(deps: SyncDriverDeps): Promise<SyncOutcome[]> {
  const client = new GitClient(deps.runner);
  const layout = { root: deps.cloneRoot };
  const manager = new CloneManager(client, layout, deps.lastSync, {
    workingTree: deps.workingTree,
    conflicts: deps.conflicts,
    policy: deps.policy,
    editorOpen: deps.editorOpen,
    obsidianConfig: deps.obsidianConfig,
    pickAgent: deps.pickAgent,
    trash: deps.trash,
    heldPaths: deps.heldPaths,
    vaultMirror: deps.vaultMirror,
    rmDir: deps.rmDir,
  });
  const providerCache = new Map<string, Provider>();
  const results: SyncOutcome[] = [];

  const outcome = (mapping: FolderMapping, status: SyncOutcome["status"], extra: Partial<SyncOutcome> = {}): SyncOutcome => ({
    mappingId: mapping.id,
    label: mapping.label ?? mapping.id,
    status,
    ...extra,
  });
  const record = (o: SyncOutcome): void => { results.push(o); };
  const skip = (mapping: FolderMapping, reason: string): void => { record(outcome(mapping, "skipped", { reason })); };

  for (const mapping of deps.mappings) {
    const credential = deps.credentials.find((c) => c.id === mapping.providerId);
    if (!credential) { skip(mapping, "no credential"); continue; }

    let repos: RepoSummary[];
    // HTTP(S) credentials for the clone/fetch/push that follow. The REST provider
    // already carries the token for API calls, but git-over-HTTPS needs it too —
    // otherwise git falls back to the machine's credential helper and the clone
    // fails with "HTTP Basic: Access denied". Local providers use a filesystem path.
    let auth: GitAuth | undefined;
    if (credential.kind === "local") {
      // Local provider has no REST adapter: it syncs an existing local repo directly.
      // The repo path is stored in credential.baseUrl as a file:// URL (the schema requires
      // baseUrl to be a valid URL). git's file:// scheme parser is unreliable across builds,
      // so pass a plain absolute filesystem path to `git clone`/fetch/push instead. Fall
      // through to the shared clone/sync path below.
      const rawUrl = credential.baseUrl?.trim();
      if (!rawUrl) { skip(mapping, "local provider needs a repo path set as the credential baseUrl"); continue; }
      const remotePath = rawUrl.startsWith("file://") ? rawUrl.slice("file://".length) : rawUrl;
      repos = [
        {
          id: mapping.id,
          name: mapping.label ?? mapping.id,
          pathWithNamespace: mapping.remotePath,
          httpUrlToRepo: remotePath,
          defaultBranch: mapping.branch ?? "main",
        },
      ];
    } else {
      const token = deps.getToken(credential.id);
      if (!token) { skip(mapping, "missing token"); continue; }
      // Any non-empty username works for token auth; `oauth2` is the GitLab convention.
      auth = { username: credential.username ?? "oauth2", token };

      let provider = providerCache.get(credential.id);
      if (!provider) {
        provider = deps.buildProvider({ kind: credential.kind, baseUrl: credential.baseUrl, token, allowedRepos: credential.repos }, { actingUsername: credential.username });
        providerCache.set(credential.id, provider);
      }

      try {
        repos = await provider.listRepos();
      } catch {
        skip(mapping, "could not reach provider"); continue;
      }
    }
    const repo = resolveRepo(repos, mapping);
    if (!repo) { skip(mapping, "repo not found or not accessible"); continue; }
    // Backfill repoRef on legacy folder-scoped links so the shared per-repo clone dir
    // (and the UI's clone-dir resolution) sticks across sessions.
    if (!mapping.repoRef) deps.onRepoResolved?.(mapping.id, repo.id);

    try {
      const opts: SyncOpts = {
        firstSync: deps.firstSyncDirection ?? "pull",
        onStatus: deps.onStatus,
      };
      const result = await manager.syncMapping(mapping, repo, auth, opts);
      if (result.conflicts.length > 0) {
        deps.lastSync.recordConflict?.(mapping.id);
        record(outcome(mapping, "conflict", { pull: result.pull, conflicts: result.conflicts }));
        continue;
      }
      if (result.needsConflictResolution) {
        deps.lastSync.recordConflict?.(mapping.id);
        record(outcome(mapping, "conflict", { pull: result.pull }));
        continue;
      }
      record(outcome(mapping, "ok", { pull: result.pull, push: result.push, newRemoteSha: result.newRemoteSha }));
    } catch (error) {
      skip(mapping, errorMessage(error));
    }
  }

  return results;
}

/** Extract a readable message from a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a writable last-sync accessor over the store, merging each update into the
 * existing per-mapping state (so unrelated fields like lastPushAt are preserved) and
 * stamping an appropriate status. Call `store.save()` once after a run to persist.
 */
export function storeWritableAccessor(store: MugsStore): LastSyncAccessor {
  return {
    lastRemoteSha: (id) => store.getSettings().lastSync[id]?.lastRemoteSha,
    // Persist the git base SHA + a monotonic op id so an offline session resumes cleanly
    // from where it left off (resume.ts). baseSha is the pre-pull remote point we advance from.
    recordPull: (id, remoteSha) =>
      persistLastSync(store, id, (cur) => ({ ...cur, mappingId: id, baseSha: cur.lastRemoteSha ?? "", lastRemoteSha: remoteSha, opId: (cur.opId ?? 0) + 1, status: "ok", lastPullAt: Date.now() })),
    recordPush: (id, localSha) =>
      persistLastSync(store, id, (cur) => ({ ...cur, mappingId: id, baseSha: cur.baseSha ?? "", lastLocalSha: localSha, opId: (cur.opId ?? 0) + 1, status: "ok", lastPushAt: Date.now() })),
    recordConflict: (id) => persistLastSync(store, id, (cur) => ({ ...cur, mappingId: id, status: "conflict" })),
    vaultPopulated: (id) => store.getSettings().lastSync[id]?.vaultPopulated,
    recordVaultSync: (id) => persistLastSync(store, id, (cur) => ({ ...cur, mappingId: id, vaultPopulated: true })),
  };
}

/**
 * Build a held-paths accessor over the store's review-queue `staging` map. A path is held
 * when its staging entry state is "held", so held files are excluded from push (Area 8).
 */
export function storeHeldAccessor(store: MugsStore): { heldPaths: (mappingId: string) => ReadonlySet<string> } {
  return {
    heldPaths: (mappingId) => {
      const entries = store.getStaging(mappingId) ?? [];
      return new Set(entries.filter((e) => e.state === "held").map((e) => e.path));
    },
  };
}

/** Build a durable conflict store over the store, so conflicts persist across sessions. */
export function storeConflictAccessor(store: MugsStore): ConflictStore {
  return {
    getConflicts: (id) => store.getConflicts(id),
    setConflicts: (id, conflicts) => store.setConflicts(id, conflicts),
  };
}

/** Merge a mutation into the stored per-mapping last-sync state and write it back. */
function persistLastSync(store: MugsStore, id: string, mutate: (current: LastSyncState) => LastSyncState): void {
  const current: LastSyncState = store.getSettings().lastSync[id] ?? { mappingId: id };
  store.setLastSync(mutate(current));
}
