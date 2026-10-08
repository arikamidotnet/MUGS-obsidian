import { describe, it, expect } from "vitest";
import { StoreMapDataSource, StoreDiffDataSource, StoreConflictDataSource } from "./defaultDataSources";
import { MugsStore, MemoryIO } from "../store";
import type { GitRunner, GitResult } from "../git/types";
import type { FolderMapping } from "../types";

// --- fakes -----------------------------------------------------------------

const ok = (stdout = "", code = 0): GitResult => ({ code, stdout, stderr: "" });
const fail = (): GitResult => ({ code: 1, stdout: "", stderr: "git failed" });

/** Records every args array and routes through the supplied handler. */
class FakeRunner implements GitRunner {
  readonly calls: string[][] = [];
  constructor(private h: (args: string[]) => GitResult) {}
  run(args: string[], _opts?: { cwd?: string }): Promise<GitResult> {
    this.calls.push(args);
    return Promise.resolve(this.h(args));
  }
}

/** US/RS-separated `git log` records for recentAuthors (name<US>email<US>timestamp). */
const RECENT_LOG = "Ada Lovelace\u001fada@example.com\u001f200\u001eLinus Torvalds\u001flinus@example.com\u001f100";
/** US/RS-separated `git log --name-only` records for authorsByFileFromLog. */
const AUTHORS_LOG = "Ada Lovelace\u001fada@example.com\nnotes/day.md\nnotes/other.md";

interface RunnerCfg {
  worktree?: boolean;
  originSha?: string | null;
  diffCode?: number;
}

function makeRunner(cfg: RunnerCfg = {}) {
  const worktree = cfg.worktree ?? true;
  return new FakeRunner((args) => {
    if (args[0] === "rev-parse") {
      if (args.includes("--is-inside-work-tree")) return worktree ? ok("true\n") : fail();
      if (args.includes("--verify")) return cfg.originSha ? ok(`${cfg.originSha}\n`) : fail();
      return ok("headsha\n");
    }
    if (args[0] === "log") {
      // getRows uses recentAuthors (timestamps); getDiff uses --name-only attribution log.
      return args.includes("--name-only") ? ok(AUTHORS_LOG) : ok(RECENT_LOG);
    }
    if (args[0] === "diff") return cfg.diffCode ? ok("@@ diff @@", cfg.diffCode) : ok("@@ diff @@");
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

// --- StoreDiffDataSource ---------------------------------------------------

describe("StoreDiffDataSource.getDiff — graceful degradation", () => {
  it("returns empty for an unknown mapping id", async () => {
    const store = storeWith([mapping()]);
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner());
    await expect(ds.getDiff({ mappingId: "nope" })).resolves.toEqual({ diffText: "", authorsByFile: {} });
  });

  it("returns empty when the mapping has no clone", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ worktree: false }));
    await expect(ds.getDiff({ mappingId: "m1" })).resolves.toEqual({ diffText: "", authorsByFile: {} });
  });

  it("swallows a git failure and returns an empty diff", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner({ diffCode: 1 }));
    await expect(ds.getDiff({ mappingId: "m1" })).resolves.toEqual({ diffText: "", authorsByFile: {} });
  });

  it("returns the diff text and per-file authors using an explicit last-synced base", async () => {
    const store = storeWith([mapping()], { m1: { mappingId: "m1", lastRemoteSha: "base123", status: "ok" } });
    const ds = new StoreDiffDataSource(store, ".mugs-clones", makeRunner());
    const res = await ds.getDiff({ mappingId: "m1" });
    expect(res.diffText).toBe("@@ diff @@");
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
    // The fallback rev-parse origin/branch was consulted.
    expect(runner.calls.some((a) => a.includes("--verify") && a.includes("origin/main"))).toBe(true);
  });
});

// --- StoreConflictDataSource -------------------------------------------------

class FakeWorkingTree {
  readonly writes: Array<[string, string]> = [];
  async writeFile(p: string, c: string): Promise<void> { this.writes.push([p, c]); }
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
    expect(store.getConflicts("m1")).toEqual([]); // entry dropped when the list is empty
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
    expect(store.getConflicts("m1")).toEqual([]);
  });
});
