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
import type { FolderMapping, Credential, LastSyncState, FileConflict, ObsidianConfigPolicy } from "../types";
import type { Provider, RepoSummary } from "../providers/types";
import type { HttpTransport } from "../providers/http";
import type { ProviderInput } from "../providers/factory";
import type { GitRunner } from "../git/types";
import { GitClient } from "../git/client";
import { CloneManager, type LastSyncAccessor, type SyncResult, type WorkingTreeWriter, type ConflictStore } from "./cloneManager";
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
    if (credential.kind === "local") { skip(mapping, "local provider needs a manual repo setup"); continue; }

    const token = deps.getToken(credential.id);
    if (!token) { skip(mapping, "missing token"); continue; }

    let provider = providerCache.get(credential.id);
    if (!provider) {
      provider = deps.buildProvider({ kind: credential.kind, baseUrl: credential.baseUrl, token }, { actingUsername: credential.username });
      providerCache.set(credential.id, provider);
    }

    let repos: RepoSummary[];
    try {
      repos = await provider.listRepos();
    } catch {
      skip(mapping, "could not reach provider"); continue;
    }
    const repo = repos.find((r) => r.id === mapping.id);
    if (!repo) { skip(mapping, "repo not found or not accessible"); continue; }

    try {
      await manager.ensureClone(mapping, repo);
      const result = await manager.syncMapping(mapping, repo);
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
