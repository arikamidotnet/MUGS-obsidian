import { describe, it, expect } from "vitest";
import type { FolderMapping, Credential, FileConflict } from "../types";
import type { Provider, RepoSummary } from "../providers/types";
import type { GitRunner, GitResult } from "../git/types";
import type { ConflictStore, WorkingTreeWriter } from "./cloneManager";
import { syncAllMappings, storeWritableAccessor } from "./driver";
import { EditorOpenGuard } from "./editorOpen";
import { resumeKey } from "./resume";
import { MugsStore, MemoryIO } from "../store";
import { DEFAULT_SYNC_POLICY } from "../types";

const J = (lines: string[]): string => lines.join("\n");

function fakeRepo(id: string): RepoSummary {
  return { id, name: "repo", pathWithNamespace: id, httpUrlToRepo: `https://example.com/${id}.git`, defaultBranch: "main" };
}

function fakeProvider(repo?: RepoSummary): Provider {
  return {
    kind: "gitlab",
    async listRepos() {
      return repo ? [repo] : [];
    },
    async getBranches() {
      return [];
    },
    async getMembers() {
      return [];
    },
  };
}

function mapping(over: Partial<FolderMapping> = {}): FolderMapping {
  return { id: "m1", label: "Notes", remotePath: "", localFolder: "notes", providerId: "c1", direction: "push-pull", ...over };
}

function credential(over: Partial<Credential> = {}): Credential {
  return { id: "c1", label: "Work", kind: "gitlab", token: "glpat", ...over };
}

/** Canned content for the file-level merge commands (show / merge-base / diff --name-only). */
interface ContentScenario {
  /** SHA returned by a bare `git merge-base` (the ancestry oracle uses --is-ancestor instead). */
  mergeBaseSha?: string;
  /** ref -> (path -> content|undefined) served by `git show REF:PATH`. */
  showMap?: Record<string, Record<string, string | undefined>>;
  /** Paths returned by every `git diff --name-only` call. */
  changedPaths?: string[];
}

/** A git runner that never touches disk: rev-parse/merge-base are canned, everything else is a no-op success. */
function makeRunner(o: { head: string; remote: string; ancestor: boolean; cloned?: boolean } & ContentScenario): { runner: GitRunner; calls: string[][] } {
  const mergeBaseSha = o.mergeBaseSha ?? "M0";
  const showMap = o.showMap ?? {};
  const changedPaths = o.changedPaths ?? [];
  const calls: string[][] = [];
  const runner: GitRunner = {
    run: async (args): Promise<GitResult> => {
      calls.push([...args]);
      const cmd = args[0];
      if (cmd === "rev-parse") {
        const ref = args[1];
        if (ref === "--is-inside-work-tree") return { code: o.cloned ? 0 : 128, stdout: o.cloned ? "true" : "", stderr: "" };
        if (ref === "HEAD") return { code: 0, stdout: o.head, stderr: "" };
        return { code: 0, stdout: o.remote, stderr: "" };
      }
      if (cmd === "merge-base") {
        // --is-ancestor is the ancestry oracle; a bare merge-base returns the SHA.
        if (args.includes("--is-ancestor")) return { code: o.ancestor ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: mergeBaseSha, stderr: "" };
      }
      if (cmd === "show") {
        const refPath = args[1];
        const idx = refPath.indexOf(":");
        const ref = refPath.slice(0, idx);
        const path = refPath.slice(idx + 1);
        const content = showMap[ref]?.[path];
        if (content === undefined) return { code: 128, stdout: "", stderr: "" };
        return { code: 0, stdout: content, stderr: "" };
      }
      if (cmd === "diff") return { code: 0, stdout: changedPaths.join("\n"), stderr: "" };
      return { code: 0, stdout: "", stderr: "" }; // fetch / pull / add / commit / push
    },
  };
  return { runner, calls };
}

/** In-memory ConflictStore spy that records the latest persisted list per mapping. */
function memoryConflictStore(initial: FileConflict[] = []): { store: ConflictStore; getState: () => FileConflict[] } {
  const state: FileConflict[] = [...initial];
  return {
    store: {
      getConflicts: () => [...state],
      setConflicts: (_mappingId: string, conflicts: FileConflict[]) => { state.length = 0; state.push(...conflicts); },
    },
    getState: () => [...state],
  };
}

interface SpyState {
  pull: Array<[string, string]>;
  push: Array<[string, string]>;
  conflict: string[];
}

function spyAccessor(base?: string): { accessor: Parameters<typeof syncAllMappings>[0]["lastSync"]; state: SpyState } {
  const state: SpyState = { pull: [], push: [], conflict: [] };
  const accessor = {
    lastRemoteSha: (id: string) => base,
    recordPull: (id: string, remoteSha: string) => {
      state.pull.push([id, remoteSha]);
    },
    recordPush: (id: string, localSha: string) => {
      state.push.push([id, localSha]);
    },
    recordConflict: (id: string) => {
      state.conflict.push(id);
    },
  };
  return { accessor: accessor as Parameters<typeof syncAllMappings>[0]["lastSync"], state };
}

const CLONE_ROOT = "/vault/.mugs-clones";

describe("syncAllMappings — skips", () => {
  it("skips a mapping with no matching credential", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const outcomes = await syncAllMappings({
      mappings: [mapping({ providerId: "missing" })],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes).toEqual([{ mappingId: "m1", label: "Notes", status: "skipped", reason: "no credential" }]);
  });

  it("skips a local provider (no REST adapter)", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential({ kind: "local" })],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: /local/ });
  });

  it("skips a mapping whose credential has no token", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => undefined,
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: "missing token" });
  });

  it("skips a mapping whose repo is not in the provider's list", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(undefined), // listRepos -> []
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: /repo not found/ });
  });
});

describe("syncAllMappings — sync outcomes", () => {
  it("fast-forwards a pull-only mapping without pushing", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const { accessor, state } = spyAccessor("L1"); // base == localSha -> no unpushed work
    const outcomes = await syncAllMappings({
      mappings: [mapping({ direction: "pull-only" })],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
    });
    expect(outcomes).toEqual([{ mappingId: "m1", label: "Notes", status: "ok", pull: "fast-forward", push: false, newRemoteSha: "R1" }]);
    expect(state.pull).toEqual([["m1", "R1"]]);
    expect(state.push).toEqual([]);
    expect(state.conflict).toEqual([]);
  });

  it("pulls fast-forward and pushes unpushed local work on a push-pull mapping, cloning first", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: false }); // not yet cloned
    const { accessor, state } = spyAccessor("B0"); // base != localSha -> unpushed
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
    });
    // First run clones the repo (ensureClone) before syncing.
    const cloneCall = calls.find((c) => c[0] === "clone");
    expect(cloneCall?.[1]).toBe("https://example.com/m1.git");
    expect(outcomes).toEqual([{ mappingId: "m1", label: "Notes", status: "ok", pull: "fast-forward", push: true, newRemoteSha: "R1" }]);
    expect(state.push).toEqual([["m1", "L1"]]);
    expect(state.pull).toEqual([["m1", "R1"]]);
  });

  it("records a divergent file as a durable conflict on a rebase pull", async () => {
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged
      changedPaths: ["notes/todo.md"],
      showMap: {
        M0: { "notes/todo.md": J(["a", "shared", "c"]) }, // base
        HEAD: { "notes/todo.md": J(["a", "LOCAL", "c"]) }, // ours edits the middle line
        "origin/main": { "notes/todo.md": J(["a", "REMOTE", "c"]) }, // theirs edits it differently -> conflict
      },
    });
    const store = memoryConflictStore();
    const { accessor, state } = spyAccessor(""); // never synced -> base "" -> unpushed
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      conflicts: store.store,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", label: "Notes", status: "conflict" });
    expect(store.getState()).toEqual([{
      path: "notes/todo.md",
      base: J(["a", "shared", "c"]),
      ours: J(["a", "LOCAL", "c"]),
      theirs: J(["a", "REMOTE", "c"]),
    }]);
    expect(state.conflict).toEqual(["m1"]);
    // A conflicting pull is not executed (no push yet).
    expect(state.pull).toEqual([]);
    expect(state.push).toEqual([]);
  });

  it("auto-merges a clean divergence into the working tree and pushes", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const store = memoryConflictStore();
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged but non-overlapping edits
      changedPaths: ["notes/todo.md"],
      showMap: {
        M0: { "notes/todo.md": J(["a", "b", "c"]) }, // base
        HEAD: { "notes/todo.md": J(["A", "b", "c"]) }, // ours changes line 1
        "origin/main": { "notes/todo.md": J(["a", "b", "C"]) }, // theirs changes line 3 -> clean merge
      },
    });
    const { accessor, state } = spyAccessor(""); // unpushed local work
    const outcomes = await syncAllMappings({
      mappings: [mapping()], // push-pull
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      workingTree,
      conflicts: store.store,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", label: "Notes", status: "ok", pull: "rebase", push: true, newRemoteSha: "R1" });
    // Clean merge written into the clone's working tree at <cloneRoot>/<providerId>/<id>/<path>.
    expect(writes).toEqual([["/vault/.mugs-clones/c1/m1/notes/todo.md", J(["A", "b", "C"])]]);
    expect(store.getState()).toEqual([]); // no conflicts recorded
    expect(state.push).toEqual([["m1", "L1"]]);
    expect(state.pull).toEqual([["m1", "R1"]]);
  });

  it("accumulates new divergent files onto previously-recorded conflicts", async () => {
    const { runner } = makeRunner({
      head: "L2", remote: "R1", ancestor: false, cloned: true, // diverged again on a second run
      changedPaths: ["notes/other.md"],
      showMap: {
        M0: { "notes/other.md": J(["x"]) },
        HEAD: { "notes/other.md": J(["y"]) },
        "origin/main": { "notes/other.md": J(["z"]) },
      },
    });
    const store = memoryConflictStore([{ path: "notes/todo.md", base: "b", ours: "O", theirs: "T" }]); // pre-existing
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor, // unpushed local work (L2)
      conflicts: store.store,
    });
    expect(store.getState().map((c) => c.path)).toEqual(["notes/todo.md", "notes/other.md"]);
  });

  it("filters out excluded paths from a clean divergence merge (scope excludes)", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged
      changedPaths: ["notes/a.md", "notes/b.log"], // b.log is excluded by the mapping
      showMap: {
        M0: { "notes/a.md": J(["a", "b", "c"]) },
        HEAD: { "notes/a.md": J(["A", "b", "c"]) },
        "origin/main": { "notes/a.md": J(["a", "b", "C"]) },
      },
    });
    const { accessor } = spyAccessor(""); // unpushed local work
    const outcomes = await syncAllMappings({
      mappings: [mapping({ excludes: ["*.log"] })],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      workingTree,
    });
    // Only the in-scope file is merged/written; the excluded .log is dropped.
    expect(writes).toEqual([["/vault/.mugs-clones/c1/m1/notes/a.md", J(["A", "b", "C"])]]);
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok" });
  });

  it("continues past a skipped mapping and reports every mapping", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const { accessor } = spyAccessor("L1"); // base == localSha -> clean fast-forward
    const outcomes = await syncAllMappings({
      mappings: [mapping({ id: "bad", providerId: "missing" }), mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["skipped", "ok"]);
  });
});

describe("syncAllMappings — policy-driven auto-resolution (Area D)", () => {
  it("auto-resolves a genuine conflict via injected policy instead of surfacing it", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const store = memoryConflictStore();
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged, overlapping edit -> conflict
      changedPaths: ["notes/todo.md"],
      showMap: {
        M0: { "notes/todo.md": J(["a", "shared", "c"]) },
        HEAD: { "notes/todo.md": J(["a", "LOCAL", "c"]) },
        "origin/main": { "notes/todo.md": J(["a", "REMOTE", "c"]) },
      },
    });
    const { accessor, state } = spyAccessor(""); // unpushed local work -> rebase
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      conflicts: store.store,
      workingTree,
      policy: { ...DEFAULT_SYNC_POLICY, defaultResolution: "theirs" },
    });
    // Auto-resolved to theirs and written into the working tree; NOT surfaced as a conflict.
    expect(writes).toEqual([["/vault/.mugs-clones/c1/m1/notes/todo.md", J(["a", "REMOTE", "c"])]]);
    expect(store.getState()).toEqual([]);
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok" });
    expect(state.conflict).toEqual([]);
  });

  it("still surfaces a conflict when no policy is injected (default behavior unchanged)", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const store = memoryConflictStore();
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true,
      changedPaths: ["notes/todo.md"],
      showMap: {
        M0: { "notes/todo.md": J(["a", "shared", "c"]) },
        HEAD: { "notes/todo.md": J(["a", "LOCAL", "c"]) },
        "origin/main": { "notes/todo.md": J(["a", "REMOTE", "c"]) },
      },
    });
    const { accessor } = spyAccessor("");
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      conflicts: store.store,
      workingTree,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "conflict" });
    expect(store.getState()).toEqual([
      { path: "notes/todo.md", base: J(["a", "shared", "c"]), ours: J(["a", "LOCAL", "c"]), theirs: J(["a", "REMOTE", "c"]) },
    ]);
  });
});

describe("syncAllMappings — editor-open write-back guard (Area D)", () => {
  it("skips writing a clean-merge result for a file open with unsaved changes", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const editorOpen = new EditorOpenGuard(["notes/todo.md"]); // open w/ unsaved changes
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged, non-overlapping -> clean merge
      changedPaths: ["notes/todo.md"],
      showMap: {
        M0: { "notes/todo.md": J(["a", "b", "c"]) },
        HEAD: { "notes/todo.md": J(["A", "b", "c"]) },
        "origin/main": { "notes/todo.md": J(["a", "b", "C"]) },
      },
    });
    const { accessor } = spyAccessor(""); // unpushed -> rebase, clean merge
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      workingTree,
      editorOpen,
    });
    // The merged result is NOT written because the file is open with unsaved changes.
    expect(writes).toEqual([]);
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok" });
  });

  it("writes normally when the path is not open (guard does not over-block)", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const editorOpen = new EditorOpenGuard(["other.md"]); // a different file is open
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true,
      changedPaths: ["notes/todo.md"],
      showMap: {
        M0: { "notes/todo.md": J(["a", "b", "c"]) },
        HEAD: { "notes/todo.md": J(["A", "b", "c"]) },
        "origin/main": { "notes/todo.md": J(["a", "b", "C"]) },
      },
    });
    const { accessor } = spyAccessor("");
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      workingTree,
      editorOpen,
    });
    expect(writes).toEqual([["/vault/.mugs-clones/c1/m1/notes/todo.md", J(["A", "b", "C"])]]);
  });
});

describe("storeWritableAccessor — resumable base SHA + op id (Area D)", () => {
  it("persists a resume baseline and increments the op id across pulls, surviving save/reload", async () => {
    const io = new MemoryIO();
    const store = new MugsStore(io);
    await store.load();
    const acc = storeWritableAccessor(store);
    acc.recordPull("m1", "R1"); // first pull: baseSha="" (never synced), opId=1, lastRemoteSha="R1"
    acc.recordPull("m1", "R2"); // second pull: baseSha="R1" (resume point), opId=2, lastRemoteSha="R2"
    await store.save();

    // Fresh store reading the same IO — simulates an offline->reconnect session.
    const reloaded = new MugsStore(io);
    const s = await reloaded.load();
    expect(s.lastSync["m1"]).toMatchObject({ mappingId: "m1", baseSha: "R1", opId: 2, lastRemoteSha: "R2" });
    expect(resumeKey(s.lastSync["m1"] ?? {})).toBe("R1\u00002");
  });

  it("increments the op id on push while preserving the base SHA", async () => {
    const io = new MemoryIO();
    const store = new MugsStore(io);
    await store.load();
    const acc = storeWritableAccessor(store);
    acc.recordPull("m1", "R1"); // baseSha="" (no prior remote), opId=1, lastRemoteSha="R1"
    acc.recordPull("m1", "R2"); // baseSha="R1" (pre-pull baseline), opId=2, lastRemoteSha="R2"
    acc.recordPush("m1", "L3"); // push preserves the pull-established baseSha, opId=3
    const s = store.getSettings().lastSync["m1"];
    expect(s?.baseSha).toBe("R1"); // push did not clobber the reconciliation baseline
    expect(s?.opId).toBe(3);
    expect(resumeKey(s ?? {})).toBe("R1\u00003");
  });
});
