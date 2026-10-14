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
        const dir = cloneDir({ root: this.cloneRoot }, m.providerId, m.id);
        const client = new GitClient(this.runner);
        if (await isWorkTree(client, dir)) {
          owner = pickOwner(await client.recentAuthors("HEAD", 100));
        }
      } catch {
        owner = undefined; // no clone / git error -> surface without an owner
      }
      const ls = lastSync[m.id];
      rows.push({
        mapping: m,
        status: ls?.status ?? "pending",
        owner,
        lastPushAt: ls?.lastPushAt,
        lastPullAt: ls?.lastPullAt,
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
    if (!mapping) return { diffText: "", authorsByFile: {} };

    const dir = cloneDir({ root: this.cloneRoot }, mapping.providerId, mapping.id);
    const client = new GitClient(this.runner);
    try {
      if (!(await isWorkTree(client, dir))) return { diffText: "", authorsByFile: {} };

      const to = query.ref ?? "HEAD";
      const base = await this.resolveBase(client, mapping);
      if (!base) return { diffText: "", authorsByFile: {} }; // nothing to compare against yet

      const diffText = await client.diff(base, to);
      const range = `${base}...${to}`;
      const log = await client.run(["log", `--limit=300`, `--name-only`, `--format=%an%x1f%ae%x1e`, range]);
      const authorsByFile: AuthorsByFile = log.code === 0 ? authorsByFileFromLog(log.stdout) : {};
      return { diffText, authorsByFile };
    } catch {
      return { diffText: "", authorsByFile: {} };
    }
  }

  /** Resolve a sensible "from" ref: last synced remote SHA, else origin/<branch>. */
  private async resolveBase(client: GitClient, mapping: FolderMapping): Promise<string | undefined> {
    const explicit = storeLastSyncAccessor(this.store).lastRemoteSha(mapping.id);
    if (explicit) return explicit;
    const branch = mapping.branch ?? "main";
    const r = await client.run(["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
    return r.code === 0 ? `origin/${branch}` : undefined;
  }
}

/**
 * Conflict data source: lists a mapping's unresolved conflicts and applies resolutions.
 * Resolution writes the chosen content into the clone's working tree (via the injected
 * {@link WorkingTreeWriter}) and drops the file from the durable store, so it survives
 * across sessions until resolved. Once every file is resolved the mapping's last-sync
 * status clears back to "up-to-date".
 */
export class StoreConflictDataSource implements ConflictDataSource {
  constructor(
    private readonly store: MugsStore,
    private readonly cloneRoot: string,
    private readonly workingTree?: WorkingTreeWriter,
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
    const next = resolveConflictFile(before, query.path, query.choice);
    // Unknown path — nothing to do (still report the pre-existing count).
    if (!next) return { remaining: before.length };
    // Write the chosen content into the working tree so a later commit carries it.
    if (this.workingTree) {
      const absPath = `${cloneDir({ root: this.cloneRoot }, mapping.providerId, mapping.id)}/${query.path}`;
      await this.workingTree.writeFile(absPath, next.resolvedContent);
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
