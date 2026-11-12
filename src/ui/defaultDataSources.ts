/**
 * MUGS — default view data sources (pure of Obsidian).
 *
 * Concrete {@link MapDataSource}/{@link DiffDataSource} implementations backed by
 * the persisted store and a real local git clone per mapping. They import no
 * Obsidian API, so they stay unit-testable with an injected runner; `main.ts`
 * wires them into the context via `setMugsContext`.
 *
 * Graceful degradation: when a mapping has no clone (or git fails), the Map row
 * carries no owner and the Diff returns empty — nothing throws, so the views
 * still open and show "configure/sync first" states. Backend roster binding
 * (`Provider.getMembers`) is intentionally out of scope here (later phase).
 */
import type { MugsStore } from "../store";
import type { FolderMapping, SyncStatus, FileConflict } from "../types";
import { GitClient, type AuthorActivity } from "../git/client";
import { ChildProcessRunner } from "../git/runner";
import type { GitRunner } from "../git/types";
import { cloneDir, type CloneLayout, type LastSyncAccessor, type WorkingTreeWriter } from "../sync/cloneManager";
import { repoToVaultPath } from "../sync/mirror";
import { authorsByFileFromLog, type AuthorsByFile } from "./diffModel";
import type {
  MapDataSource,
  MapRow,
  DiffDataSource,
  DiffResult,
  DiffQuery,
  ConflictDataSource,
  ConflictQuery,
  ConflictResolutionQuery,
  ConflictResolutionResult,
} from "./dataSources";
import { unresolvedConflicts, resolveConflictFile } from "../sync/conflict";

/** Default on-disk folder (under the vault) holding per-mapping clones. */
export const DEFAULT_CLONE_DIRNAME = ".mugs-clones";

const CLONE_LAYOUT: CloneLayout = { root: DEFAULT_CLONE_DIRNAME };

/** True when `dir` is a checked-out git work tree (best-effort, never throws). */
async function isWorkTree(client: GitClient, dir: string): Promise<boolean> {
  const r = await client.run(["rev-parse", "--is-inside-work-tree"], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Choose the owning user: most recent activity, ties broken by commit count. */
function pickOwner(authors: AuthorActivity[]): string | undefined {
  let best: AuthorActivity | undefined;
  for (const a of authors) {
    if (!best) {
      best = a;
      continue;
    }
    const delta = (a.lastActivityAt ?? 0) - (best.lastActivityAt ?? 0);
    if (delta > 0 || (delta === 0 && a.commitCount > best.commitCount)) best = a;
  }
  return best?.name;
}

/** Join vault root + mapping folder + folder-relative path into a vault-absolute path. */
function joinVaultAbs(root: string, localFolder: string, rel: string): string {
  const folder = localFolder === "." ? "" : localFolder.replace(/\/+$/, "");
  return [root, folder, rel].filter((s) => s.length > 0).join("/");
}

/** Build a LastSyncAccessor over the store's persisted last-sync map. */
function storeLastSyncAccessor(store: MugsStore): LastSyncAccessor {
  return {
    lastRemoteSha: (id) => store.getSettings().lastSync[id]?.lastRemoteSha,
    recordPull: () => undefined,
    recordPush: () => undefined,
  };
}

/** Map view data source: mappings + last-sync status from the store, owner from clones. */
export class StoreMapDataSource implements MapDataSource {
  constructor(
    private readonly store: MugsStore,
    private readonly cloneRoot: string,
    private readonly runner: GitRunner = new ChildProcessRunner(),
  ) {}

  async getRows(): Promise<MapRow[]> {
    const settings = this.store.getSettings();
    const lastSync = settings.lastSync;
    const rows: MapRow[] = [];

    for (const m of settings.mappings) {
      let owner: string | undefined;
      try {
        // Same clone-dir resolution as the sync engine (repoRef ?? id) — the old
        // m.id-only form missed every folder-scoped mapping's shared clone.
        const dir = cloneDir({ root: this.cloneRoot }, m.providerId, m.repoRef ?? m.id);
        // Bind EVERY git call to the clone — an unbound client ran rev-parse/log in the
        // plugin process's cwd (the wrong repository), so owner attribution silently
        // failed for every mapping.
        const client = new GitClient(this.runner).at(dir);
        if (await isWorkTree(client, dir)) {
          owner = pickOwner(await client.recentAuthors("HEAD", 100));
        }
      } catch {
        owner = undefined; // no clone / git error -> surface without an owner
      }
      const ls = lastSync[m.id];
      // Skips provable from settings alone: a mapping pointing at a missing
      // credential can never run, so the Map row says "skipped" (with the reason)
      // instead of a quiet "pending" that implies sync will get to it eventually.
      const credential = settings.credentials.find((c) => c.id === m.providerId);
      const skipReason = !credential
        ? "no credential selected — choose one for this mapping in MUGS settings"
        : credential.kind === "local" && !credential.baseUrl?.trim()
          ? "local provider needs a repo path — set it in the credential's settings"
          : undefined;
      const conflictCount = unresolvedConflicts(this.store.getConflicts(m.id)).length;
      rows.push({
        mapping: m,
        status: ls?.status ?? "pending",
        owner,
        lastPushAt: ls?.lastPushAt,
        lastPullAt: ls?.lastPullAt,
        skipReason,
        conflictCount: conflictCount > 0 ? conflictCount : undefined,
      });
    }

    return rows;
  }
}

/** Diff view data source: per-mapping diff vs. remote baseline + per-file authors. */
export class StoreDiffDataSource implements DiffDataSource {
  constructor(
    private readonly store: MugsStore,
    private readonly cloneRoot: string,
    private readonly runner: GitRunner = new ChildProcessRunner(),
  ) {}

  async getDiff(query: DiffQuery): Promise<DiffResult> {
    const settings = this.store.getSettings();
    const mapping = settings.mappings.find((m) => m.id === query.mappingId);
    if (!mapping) return { diffText: "", authorsByFile: {}, outcome: "no-mapping" };

    // Same clone-dir resolution as the sync engine (repoRef ?? id) — the old
    // m.id-only form made the Diff view permanently "no comparison available"
    // for every folder-scoped mapping.
    const dir = cloneDir({ root: this.cloneRoot }, mapping.providerId, mapping.repoRef ?? mapping.id);
    // Bind EVERY git call to the clone: rev-parse/diff/log on an unbound client ran
    // in the plugin process's cwd — the WRONG repository — so perfectly synced
    // mappings showed "no comparison available" (baseline unresolvable there).
    const client = new GitClient(this.runner).at(dir);
    try {
      if (!(await isWorkTree(client, dir))) return { diffText: "", authorsByFile: {}, outcome: "no-clone" };

      const to = query.ref ?? "HEAD";
      const base = await this.resolveBase(client, mapping);
      if (!base) return { diffText: "", authorsByFile: {}, outcome: "no-baseline" }; // nothing to compare against yet

      let diffText: string;
      try {
        diffText = await client.diff(base, to);
      } catch (err) {
        // A failed diff is NOT an empty diff: report the git error instead of the
        // misleading "no changes" message (a bad ref / missing object / large-file
        // failure all surfaced as a clean tree before this).
        return { diffText: "", authorsByFile: {}, baseRef: base, outcome: "git-error", detail: err instanceof Error ? err.message : String(err) };
      }
      const range = `${base}...${to}`;
      const log = await client.run(["log", `--max-count=300`, "--name-only", `--format=%an%x1f%ae%x1e`, range]);
      const authorsByFile: AuthorsByFile = log.code === 0 ? authorsByFileFromLog(log.stdout) : {};
      return { diffText, authorsByFile, baseRef: base, outcome: diffText.trim() ? "changed" : "identical" };
    } catch (err) {
      return { diffText: "", authorsByFile: {}, outcome: "git-error", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Resolve a sensible "from" ref: last synced remote SHA (verified present in this clone),
   *  else the mapping's branch tip, else origin/HEAD. Verifies the explicit baseline
   *  SHA still exists (handles re-clones, GC, shallow histories, etc.). */
  private async resolveBase(client: GitClient, mapping: FolderMapping): Promise<string | undefined> {
    const explicit = storeLastSyncAccessor(this.store).lastRemoteSha(mapping.id);
    // Prove the baseline commit exists (cat-file), not just that the string parses:
    // rev-parse --verify happily echoes an unparsed 40-char SHA, and a re-clone can
    // lose the recorded baseline object entirely.
    if (explicit && (await client.commitExists(explicit))) return explicit;
    const candidates = mapping.branch ? [`origin/${mapping.branch}`, "origin/HEAD"] : ["origin/HEAD"];
    for (const ref of candidates) {
      const r = await client.run(["rev-parse", "--verify", "--quiet", ref]);
      if (r.code === 0) return ref;
    }
    return undefined;
  }
}

/**
 * Conflict data source: lists a mapping's unresolved conflicts and applies resolutions.
 * Resolution writes the chosen content into the clone's working tree (via the injected
 * {@link WorkingTreeWriter}) and drops the file from the durable store, so it survives
 * across sessions until resolved. Once every file is resolved the mapping's last-sync
 * status clears back to "up-to-date".
 */
/** Optional seams so a manual resolution lands in the VAULT as well as the clone.
 *  Without a vault write the next sync read "ours" from the stale vault copy and the
 *  same conflict resurfaced (or the resolution was overwritten) on every pass. */
export interface ConflictWriteSeams {
  /** Writes/deletes resolved content into the vault folder (absolute paths). */
  vault?: WorkingTreeWriter;
  /** Vault-root absolute path prefix (e.g. /home/me/Vault) used to map repo paths
   *  to vault files. Required when `vault` is set. */
  vaultRoot?: string;
  /** Optional editor-open gate: return false to refuse the vault write (the file is
   *  open with unsaved changes). The whole resolution is then rejected — a partial
   *  resolution (clone written, vault stale) would resurface as the same conflict. */
  writeSafe?: (absVaultPath: string) => boolean;
}

export class StoreConflictDataSource implements ConflictDataSource {
  constructor(
    private readonly store: MugsStore,
    private readonly cloneRoot: string,
    private readonly workingTree?: WorkingTreeWriter,
    private readonly seams: ConflictWriteSeams = {},
  ) {}

  async getConflicts(query: ConflictQuery): Promise<FileConflict[]> {
    const mapping = this.store.getSettings().mappings.find((m) => m.id === query.mappingId);
    if (!mapping) return [];
    return unresolvedConflicts(this.store.getConflicts(mapping.id));
  }

  async resolveConflict(query: ConflictResolutionQuery): Promise<ConflictResolutionResult> {
    const mapping = this.store.getSettings().mappings.find((m) => m.id === query.mappingId);
    if (!mapping) return { remaining: 0 };
    const before = this.store.getConflicts(mapping.id);
    const hit = before.find((c) => c.path === query.path);
    const next = resolveConflictFile(before, query.path, query.choice);
    // Unknown path — nothing to do (still report the pre-existing count).
    if (!next) return { remaining: before.length };
    // BOTH writes happen before the record is dropped — the old code cleared the
    // record after writing only the clone, so the vault kept the conflicting copy and
    // the same conflict resurfaced (or the resolution was overwritten) on the next sync.
    const dir = cloneDir({ root: this.cloneRoot }, mapping.providerId, mapping.repoRef ?? mapping.id);
    const cloneAbs = `${dir}/${query.path}`;
    const vaultRel = repoToVaultPath(mapping, query.path);
    const vaultAbs =
      this.seams.vaultRoot && vaultRel !== null ? joinVaultAbs(this.seams.vaultRoot, mapping.localFolder, vaultRel) : undefined;
    if (vaultAbs && this.seams.writeSafe && !this.seams.writeSafe(vaultAbs)) {
      throw new Error(`${query.path} is open with unsaved changes — close it and resolve again`);
    }
    // A deletion win removes the file from BOTH sides instead of writing content.
    const deletion =
      (query.choice === "ours" && hit?.oursAbsent === true) || (query.choice === "theirs" && hit?.theirsAbsent === true);
    if (deletion) {
      await this.workingTree?.deleteFile?.(cloneAbs);
      if (vaultAbs) await this.seams.vault?.deleteFile?.(vaultAbs);
    } else {
      await this.workingTree?.writeFile(cloneAbs, next.resolvedContent);
      if (vaultAbs) await this.seams.vault?.writeFile(vaultAbs, next.resolvedContent);
    }
    this.store.setConflicts(mapping.id, next.conflicts);
    // Clear the mapping's conflict status once every file is resolved.
    const status = next.conflicts.length > 0 ? "conflict" : "up-to-date";
    const current = this.store.getSettings().lastSync[mapping.id] ?? { mappingId: mapping.id };
    this.store.setLastSync({ ...current, mappingId: mapping.id, status });
    await this.store.save();
    return { remaining: next.conflicts.length };
  }
}
