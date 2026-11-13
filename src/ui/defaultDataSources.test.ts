import { describe, it, expect } from "vitest";
import { StoreMapDataSource, StoreDiffDataSource, StoreConflictDataSource } from "./defaultDataSources";
import { MugsStore, MemoryIO } from "../store";
import type { GitRunner, GitResult } from "../git/types";
import type { FolderMapping } from "../types";
import type { WorkingTreeWriter } from "../sync/cloneManager";

// --- fakes -----------------------------------------------------------------

const ok = (stdout = "", code = 0): GitResult => ({ code, stdout, stderr: "" });
const fail = (): GitResult => ({ code: 1, stdout: "", stderr: "git failed" });

/** Records every call (args + opts) and routes through the supplied handler. */
class FakeRunner implements GitRunner {
  readonly calls: Array<{ args: string[]; opts?: { cwd?: string } }> = [];
  constructor(private h: (args: string[]) => GitResult) {}
  run(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
    this.calls.push({ args, opts });
    return Promise.resolve(this.h(args));
  }
}
/** Args sets recorded by a runner (for callers that only care about argv). */
const argSets = (r: FakeRunner): string[][] => r.calls.map((c) => c.args);

/** US/RS-separated `git log` records for recentAuthors (name<US>email<US>timestamp). */
const RECENT_LOG = "Ada Lovelace\u001fada@example.com\u001f200\u001eLinus Torvalds\u001flinus@example.com\u001f100";
/** US/RS-separated `git log --name-only` records for authorsByFileFromLog. */
const AUTHORS_LOG = "Ada Lovelace\u001fada@example.com\nnotes/day.md\nnotes/other.md";

interface RunnerCfg {
  worktree?: boolean;
  originSha?: string | null;
  /** When set, rev-parse --verify for this exact string succeeds (simulates a recorded lastRemoteSha that still exists). */
  lastRemoteSha?: string;
  /** cat-file -e fails for these strings (commit object absent from the clone). */
  missingShas?: string[];
  /** `git diff` succeeds but prints nothing (baseline tree == HEAD tree). */
  emptyDiff?: boolean;
  diffCode?: number;
}

function makeRunner(cfg: RunnerCfg = {}) {
  const worktree = cfg.worktree ?? true;
  return new FakeRunner((args) => {
    // cat-file args look like ["cat-file", "-e", "<sha>^{commit}"] — match by prefix.
    if (args[0] === "cat-file") return cfg.missingShas?.some((s) => args.some((a) => a.startsWith(s))) ? fail() : ok("");
    if (args[0] === "rev-parse") {
      if (args.includes("--is-inside-work-tree")) return worktree ? ok("true\n") : fail();
      if (args.includes("--verify")) {
        // Accept an explicit lastRemoteSha value if provided in cfg.
        if (cfg.lastRemoteSha && args.includes(cfg.lastRemoteSha)) return ok(`${cfg.lastRemoteSha}\n`);
        return cfg.originSha ? ok(`${cfg.originSha}\n`) : fail();
      }
      return ok("headsha\n");
    }
    if (args[0] === "log") {
      // getRows uses recentAuthors (timestamps); getDiff uses --name-only attribution log.
      return args.includes("--name-only") ? ok(AUTHORS_LOG) : ok(RECENT_LOG);
    }
    if (args[0] === "diff") {
      if (cfg.diffCode) return ok("@@ diff @@", cfg.diffCode);
      return cfg.emptyDiff ? ok("") : ok("@@ diff @@");
    }
    return ok("");
  });
}

// --- fixtures --------------------------------------------------------------

function mapping(over: Partial<FolderMapping> = {}): FolderMapping {
  return {
    id: "m1",
    label: "Notes",
    remotePath: "",
    localFolder: "notes",
    providerId: "c1",
    branch: "main",
    direction: "push-pull",
    ...over,
  };
}

function storeWith(mappings: FolderMapping[], lastSync?: Record<string, Parameters<MugsStore["setLastSync"]>[0]>) {
  const store = new MugsStore(new MemoryIO());
  for (const m of mappings) store.upsertMapping(m);
  if (lastSync) for (const s of Object.values(lastSync)) store.setLastSync(s);
  return store;
}

// --- StoreMapDataSource ----------------------------------------------------

describe("StoreMapDataSource.getRows — owner attribution", () => {
  it("scans shared clone history once per refresh and does not fetch or sync", async () => {
    const store = storeWith([mapping(), mapping({ id: "m2", localFolder: "other" })], {
      m1: { mappingId: "m1", cloneDir: "/shared", status: "ok" },
      m2: { mappingId: "m2", cloneDir: "/shared", status: "ok" },
    });
    const runner = makeRunner();
    const ds = new StoreMapDataSource(store, ".mugs-clones", runner);
    expect((await ds.getRows()).map((row) => row.owner)).toEqual(["Ada Lovelace", "Ada Lovelace"]);
    expect(runner.calls.filter((call) => call.args[0] === "log")).toHaveLength(1);
    expect(runner.calls.some((call) => ["fetch", "push", "commit"].includes(call.args[0]))).toBe(false);
    await ds.getRows();
    expect(runner.calls.filter((call) => call.args[0] === "log")).toHaveLength(2);
  });
  it("attributes the most-recently-active collaborator as the owner", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "ok" } });
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner());
    const rows = await ds.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner).toBe("Ada Lovelace"); // lastActivityAt 200 > Linus 100
    expect(rows[0].status).toBe("ok");
  });

  it("breaks activity ties by commit count", async () => {
    const twoAda = "Ada\u001fa@x\u001f100\u001eAda\u001fa@x\u001f100\u001eLinus\u001fl@x\u001f100";
    const runner = new FakeRunner((args) => (args[0] === "log" ? ok(twoAda) : ok("true\n")));
    const store = storeWith([mapping()]);
    const ds = new StoreMapDataSource(store, ".mugs-clones", runner);
    const rows = await ds.getRows();
    expect(rows[0].owner).toBe("Ada"); // same timestamp, but 2 commits vs Linus' 1
  });

  it("leaves the owner undefined when there is no clone (graceful degradation)", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "pending" } });
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner({ worktree: false }));
    const rows = await ds.getRows();
    expect(rows[0].owner).toBeUndefined();
    expect(rows[0].status).toBe("pending");
  });

  it("swallows git errors and still returns a row without an owner", async () => {
    const runner = new FakeRunner(() => fail()); // every git call fails
    const store = storeWith([mapping()]);
    const ds = new StoreMapDataSource(store, ".mugs-clones", runner);
    const rows = await ds.getRows();
    expect(rows[0].owner).toBeUndefined();
  });
});

describe("StoreMapDataSource.getRows — honest skip reasons + conflict counts", () => {
  it("marks a mapping with no credential as skipped (with reason) instead of quietly pending", async () => {
    const store = storeWith([mapping({ providerId: "deleted-cred" })], { m1: { mappingId: "m1", status: "ok" } });
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner());
    const rows = await ds.getRows();
    expect(rows[0].skipReason).toContain("no credential selected");
    expect(rows[0].status).toBe("ok"); // recorded status kept; the view layers "skipped" on top
  });

  it("flags a local-provider credential with no repo path", async () => {
    const store = storeWith([mapping()]);
    store.upsertCredential({ id: "c1", label: "local", kind: "local", token: "", baseUrl: "" });
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner());
    const rows = await ds.getRows();
    expect(rows[0].skipReason).toContain("repo path");
  });

  it("sets no skip reason when a usable credential exists", async () => {
    const store = storeWith([mapping()]);
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "tok", baseUrl: "https://gitlab.example.com/api/v4" });
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner());
    const rows = await ds.getRows();
    expect(rows[0].skipReason).toBeUndefined();
  });

  it("counts only UNresolved conflicts so the Map card can say \"needs merge (n files)\"", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [
      conflict({ path: "open.md" }),
      conflict({ path: "done.md", resolved: true, resolvedContent: "OURS" }),
    ]);
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner());
    const rows = await ds.getRows();
    expect(rows[0].conflictCount).toBe(1);
  });

  it("omits the conflict count when nothing is unresolved", async () => {
    const store = storeWith([mapping()]);
    const ds = new StoreMapDataSource(store, ".mugs-clones", makeRunner());
    const rows = await ds.getRows();
    expect(rows[0].conflictCount).toBeUndefined();
  });
});

// --- StoreDiffDataSource ---------------------------------------------------

describe("StoreDiffDataSource.getDiff — graceful degradation", () => {
  it("returns outcome no-mapping for an unknown mapping id", async () => {
    const store = storeWith([mapping()]);
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner());
    await expect(ds.getDiff({ mappingId: "nope" })).resolves.toEqual({ diffText: "", authorsByFile: {}, outcome: "no-mapping" });
  });

  it("runs every git command inside the mapping's clone directory (cwd binding)", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base123", status: "ok" } });
    const runner = makeRunner({ lastRemoteSha: "base123" });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", runner);
    await ds.getDiff({ mappingId: "m1" });
    expect(runner.calls.length).toBeGreaterThan(0);
    // An unbound client ran rev-parse/diff/log in the plugin process's cwd — the wrong
    // repository — which is exactly the "no comparison available" live bug.
    for (const call of runner.calls) expect(call.opts?.cwd).toBe(".mugs-clones/c1/m1");
  });

  it("returns baseRef + outcome changed when an explicit last-synced SHA resolves to a diff", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base123", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ lastRemoteSha: "base123" }));
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.diffText).toBe("@@ diff @@");
    expect(res.baseRef).toBe("base123");
    expect(res.outcome).toBe("changed");
  });

  it("returns outcome identical when the baseline resolved but the trees are equal", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "abc123", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ lastRemoteSha: "abc123", emptyDiff: true }));
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.diffText).toBe("");
    expect(res.baseRef).toBe("abc123");
    expect(res.outcome).toBe("identical");
  });

  it("returns outcome no-clone when the mapping has no clone", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ worktree: false }));
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res).toEqual({ diffText: "", authorsByFile: {}, outcome: "no-clone" });
  });

  it("reports a git error (not 'no changes') when the diff command fails", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ diffCode: 1, lastRemoteSha: "base" }));
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.outcome).toBe("git-error");
    expect(res.baseRef).toBe("base");
    expect(res.detail).toBeTruthy();
  });

  it("falls back to origin/<branch> when the recorded baseline commit is missing from the clone", async () => {
    // cat-file -e fails for the recorded SHA (re-clone lost the object) — resolveBase
    // must fall back instead of comparing against a phantom baseline.
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base123", status: "ok" } });
    const runner = makeRunner({ missingShas: ["base123"], originSha: "originsha" });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", runner);
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.outcome).toBe("changed");
    expect(res.baseRef).toBe("origin/main");
    expect(argSets(runner).some((a) => a.includes("--verify") && a.includes("origin/main"))).toBe(true);
  });

  it("returns the diff text and per-file authors using an explicit last-synced base", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base123", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ lastRemoteSha: "base123" }));
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.diffText).toBe("@@ diff @@");
    expect(res.baseRef).toBe("base123");
    expect(res.outcome).toBe("changed");
    expect(res.authorsByFile).toEqual({
      "notes/day.md": [{ name: "Ada Lovelace", email: "ada@example.com" }],
      "notes/other.md": [{ name: "Ada Lovelace", email: "ada@example.com" }],
    });
  });

  it("falls back to origin/<branch> as the base when no last-synced SHA is recorded", async () => {
    const store = storeWith([mapping()]); // no lastSync -> resolveBase uses origin/main
    const runner = makeRunner({ originSha: "originsha" });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", runner);
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.diffText).toBe("@@ diff @@");
    expect(res.baseRef).toBe("origin/main");
    // The fallback rev-parse origin/branch was consulted.
    expect(argSets(runner).some((a) => a.includes("--verify") && a.includes("origin/main"))).toBe(true);
  });

  it("attributes owners from a client bound to the clone (Map cwd binding)", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "ok" } });
    const runner = makeRunner();
    const ds = new StoreMapDataSource(store, ".mugs-clones", runner);
    await ds.getRows();
    expect(runner.calls.length).toBeGreaterThan(0);
    for (const call of runner.calls) expect(call.opts?.cwd).toBe(".mugs-clones/c1/m1");
  });
});

// --- StoreConflictDataSource -------------------------------------------------

class FakeWorkingTree {
  readonly writes: Array<[string, string]> = [];
  readonly deletes: string[] = [];
  async writeFile(p: string, c: string): Promise<void> { this.writes.push([p, c]); }
  async deleteFile(p: string): Promise<void> { this.deletes.push(p); }
}

const conflict = (over: Partial<Parameters<MugsStore["setConflicts"]>[1][number]> = {}): Parameters<MugsStore["setConflicts"]>[1][number] => ({
  path: "a.md",
  ours: "OURS",
  theirs: "THEIRS",
  ...over,
});

describe("StoreConflictDataSource", () => {
  it("lists only unresolved conflicts (drops resolved entries)", async () => {
    const store = storeWith([mapping()]);
    store.setConflicts("m1", [
      conflict({ path: "open.md" }),
      conflict({ path: "done.md", resolved: true, resolvedContent: "OURS" }),
    ]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones");
    expect((await ds.getConflicts({ mappingId: "m1" })).map((c) => c.path)).toEqual(["open.md"]);
  });

  it("returns an empty list for an unknown mapping id", async () => {
    const store = storeWith([mapping()]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones");
    await expect(ds.getConflicts({ mappingId: "nope" })).resolves.toEqual([]);
  });

  it("writes the chosen content into the working tree and clears status when last resolved", async () => {
    const wt = new FakeWorkingTree();
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [conflict({ ours: "OURS", theirs: "THEIRS" })]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones", wt);

    const res = await ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "theirs" });

    expect(res).toEqual({ remaining: 0 });
    // Written to <cloneRoot>/<providerId>/<id>/<path>.
    expect(wt.writes).toEqual([[".mugs-clones/c1/m1/a.md", "THEIRS"]]);
    // The record is kept marked resolved (engine evidence for the next pass), and
    // the unresolved surface is empty.
    expect(store.getConflicts("m1")).toEqual([expect.objectContaining({ path: "a.md", resolved: true, resolvedContent: "THEIRS" })]);
    expect((await ds.getConflicts({ mappingId: "m1" }))).toEqual([]);
    expect(store.getSettings().lastSync.m1.status).toBe("up-to-date"); // conflict status cleared
  });

  it("keeps the mapping in conflict status while files remain", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [conflict({ path: "a.md" }), conflict({ path: "b.md" })]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones");

    const res = await ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "ours" });

    expect(res.remaining).toBe(1);
    expect((await ds.getConflicts({ mappingId: "m1" })).map((c) => c.path)).toEqual(["b.md"]);
    expect(store.getSettings().lastSync.m1.status).toBe("conflict"); // still blocked
  });

  it("writes the resolution into the VAULT as well as the clone (mirror-safe)", async () => {
    const wt = new FakeWorkingTree();
    const vault = new FakeWorkingTree();
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [conflict()]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones", wt, { vault, vaultRoot: "/vault" });

    const res = await ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "theirs" });

    expect(res).toEqual({ remaining: 0 });
    expect(wt.writes).toEqual([[".mugs-clones/c1/m1/a.md", "THEIRS"]]);
    // Vault path: root + localFolder + repo→vault-mapped path — without this write
    // the next sync read the stale vault copy as "ours" and the conflict resurfaced.
    expect(vault.writes).toEqual([["/vault/notes/a.md", "THEIRS"]]);
    expect(store.getConflicts("m1")).toEqual([expect.objectContaining({ resolved: true, resolvedContent: "THEIRS" })]);
  });

  it("keeps the conflict record when the vault write fails (no half-applied resolution)", async () => {
    const wt = new FakeWorkingTree();
    const failingVault = { writeFile: async () => { throw new Error("disk full"); } } as unknown as WorkingTreeWriter;
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [conflict()]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones", wt, { vault: failingVault, vaultRoot: "/vault" });

    await expect(ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "theirs" })).rejects.toThrow("disk full");
    // The record survives so the user can retry — a cleared record over a stale vault
    // copy would silently lose the resolution on the next sync.
    expect(store.getConflicts("m1")).toHaveLength(1);
  });

  it("refuses the whole resolution when the file is open with unsaved changes", async () => {
    const wt = new FakeWorkingTree();
    const vault = new FakeWorkingTree();
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [conflict()]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones", wt, { vault, vaultRoot: "/vault", writeSafe: () => false });

    await expect(ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "theirs" })).rejects.toThrow(/unsaved changes/);
    expect(wt.writes).toEqual([]); // clone not written either — all-or-nothing
    expect(store.getConflicts("m1")).toHaveLength(1);
  });

  it("deletes the file on both sides when the winning side is a deletion", async () => {
    const wt = new FakeWorkingTree();
    const vault = new FakeWorkingTree();
    const store = storeWith([mapping()], { m1: { mappingId: "m1", status: "conflict" } });
    store.setConflicts("m1", [conflict({ oursAbsent: true, ours: "" })]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones", wt, { vault, vaultRoot: "/vault" });

    await ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "ours" });

    expect(wt.deletes).toEqual([".mugs-clones/c1/m1/a.md"]);
    expect(vault.deletes).toEqual(["/vault/notes/a.md"]);
    expect(store.getConflicts("m1")).toEqual([expect.objectContaining({ resolved: true })]);
  });

  it("treats an unknown path as a no-op and reports the pre-existing count", async () => {
    const store = storeWith([mapping()]);
    store.setConflicts("m1", [conflict()]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones");
    await expect(ds.resolveConflict({ mappingId: "m1", path: "missing.md", choice: "ours" })).resolves.toEqual({ remaining: 1 });
    expect(store.getConflicts("m1")).toHaveLength(1); // untouched
  });

  it("updates the store even without a working-tree writer", async () => {
    const store = storeWith([mapping()]);
    store.setConflicts("m1", [conflict()]);
    const ds = new StoreConflictDataSource(store, ".mugs-clones"); // no workingTree

    const res = await ds.resolveConflict({ mappingId: "m1", path: "a.md", choice: "both" });

    expect(res.remaining).toBe(0);
    expect(store.getConflicts("m1")).toEqual([expect.objectContaining({ resolved: true })]);
  });
});
