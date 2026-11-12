import { describe, it, expect } from "vitest";
import type { FolderMapping, Credential, FileConflict, Agent } from "../types";
import type { Provider, RepoSummary } from "../providers/types";
import type { ProviderInput } from "../providers/factory";
import type { GitRunner, GitResult } from "../git/types";
import type { ConflictStore, WorkingTreeWriter } from "./cloneManager";
import { syncAllMappings, storeWritableAccessor } from "./driver";
import { EditorOpenGuard } from "./editorOpen";
import { resumeKey } from "./resume";
import { MugsStore, MemoryIO } from "../store";
import { MemoryTrashStore } from "./trash";
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
    // Directory autofill is exercised against real remotes; the sync driver does
    // not use it, so a stub keeps this fake satisfying the Provider contract.
    async listDirectories() {
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
  /** Paths returned by `git diff --name-only --diff-filter=D` (remote deletions). */
  deletedPaths?: string[];
  /** Epoch seconds served by every `git log -1 --format=%ct <ref> -- <path>` call
   *  (the remote-side recency input for automatic conflict resolution). */
  pathLogTimeSecs?: number;
  /** Paths served by `git ls-files` (the clone-side tracked-file list). */
  lsFiles?: string[];
}

/** A git runner that never touches disk: rev-parse/merge-base/show/diff are canned,
 *  everything else is a no-op success. Leading `-c <value>` pairs (credential-helper
 *  config, core.quotePath) are stripped before dispatch — an authed client prefixes
 *  every command with them. */
function makeRunner(o: { head: string; remote: string; ancestor: boolean; cloned?: boolean } & ContentScenario): { runner: GitRunner; calls: string[][]; callOpts: Array<{ cwd?: string; env?: Record<string, string> } | undefined> } {
  const mergeBaseSha = o.mergeBaseSha ?? "M0";
  const showMap = o.showMap ?? {};
  const changedPaths = o.changedPaths ?? [];
  const deletedPaths = o.deletedPaths ?? [];
  const calls: string[][] = [];
  const callOpts: Array<{ cwd?: string; env?: Record<string, string> } | undefined> = [];
  const runner: GitRunner = {
    run: async (args, opts): Promise<GitResult> => {
      calls.push([...args]);
      callOpts.push(opts);
      let i = 0;
      while (args[i] === "-c") i += 2; // skip -c <value> pairs
      const cmd = args[i];
      const rest = args.slice(i);
      if (cmd === "rev-parse") {
        const ref = rest[1];
        if (ref === "--is-inside-work-tree") return { code: o.cloned ? 0 : 128, stdout: o.cloned ? "true" : "", stderr: "" };
        if (ref === "HEAD") return { code: 0, stdout: o.head, stderr: "" };
        return { code: 0, stdout: o.remote, stderr: "" };
      }
      if (cmd === "merge-base") {
        // --is-ancestor is the ancestry oracle; a bare merge-base returns the SHA.
        if (rest.includes("--is-ancestor")) return { code: o.ancestor ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: mergeBaseSha, stderr: "" };
      }
      if (cmd === "show") {
        const refPath = rest[1];
        const idx = refPath.indexOf(":");
        const ref = refPath.slice(0, idx);
        const path = refPath.slice(idx + 1);
        const content = showMap[ref]?.[path];
        if (content === undefined) return { code: 128, stdout: "", stderr: "" };
        return { code: 0, stdout: content, stderr: "" };
      }
      if (cmd === "status") return { code: 0, stdout: changedPaths.map((p) => ` M ${p}`).join("\n"), stderr: "" }; // porcelain (push staging)
      if (cmd === "diff") {
        if (rest.includes("--diff-filter=D")) return { code: 0, stdout: deletedPaths.join("\n"), stderr: "" };
        return { code: 0, stdout: changedPaths.join("\n"), stderr: "" };
      }
      if (cmd === "log") return { code: 0, stdout: o.pathLogTimeSecs !== undefined ? String(o.pathLogTimeSecs) : "", stderr: "" };
      if (cmd === "ls-files") return { code: 0, stdout: (o.lsFiles ?? []).join("\n"), stderr: "" };
      return { code: 0, stdout: "", stderr: "" }; // clone / fetch / ls-files / reset / add / commit / push
    },
  };
  return { runner, calls, callOpts };
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

  it("skips a local provider that has no repo path (credential.baseUrl)", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential({ kind: "local" })], // no baseUrl -> cannot resolve repo
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: /baseUrl/ });
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

describe("syncAllMappings — HTTP(S) credentials for git", () => {
  it("hands the credential's token to git without exposing it in argv", async () => {
    // Regression: the REST provider got the token but the git clone/fetch/push did
    // not, so git fell back to the machine's credential helper and the clone failed
    // with "HTTP Basic: Access denied".
  const { runner, calls, callOpts } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: false });
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential({ username: "arikamidotnet" })],
      getToken: () => "glpat-secret",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("L1").accessor,
    });
    const idx = calls.findIndex((c) => c.includes("clone"));
    expect(idx).toBeGreaterThanOrEqual(0);
    const cloneArgs = calls[idx];
    // Credentials ride as a per-invocation helper that clears inherited helpers…
    const credIdx = cloneArgs.findIndex((a) => a === "-c");
    expect(cloneArgs[credIdx + 1]).toBe("credential.helper=");
    expect(cloneArgs.join(" ")).toContain("username=$MUGS_GIT_USER");
    expect(cloneArgs.join(" ")).toContain("password=$MUGS_GIT_TOKEN");
    // …and both values stay in the environment, out of argv (no leak to ps/config).
    for (const a of cloneArgs) expect(a).not.toContain("glpat-secret");
    expect(callOpts[idx]?.env?.MUGS_GIT_USER).toBe("arikamidotnet");
    expect(callOpts[idx]?.env?.MUGS_GIT_TOKEN).toBe("glpat-secret");
    expect(callOpts[idx]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not attach credentials for the local provider (filesystem path)", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: false });
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential({ kind: "local", baseUrl: "file:///tmp/shared.git" })],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("L1").accessor,
    });
    const cloneCall = calls.find((c) => c[0] === "clone")!;
    expect(cloneCall).toEqual(["clone", "/tmp/shared.git", expect.any(String)]);
  });
});

describe("syncAllMappings — legacy folder-scoped repo resolution", () => {
  it("resolves a legacy no-repoRef mapping to the credential's single visible repo instead of skipping", async () => {
    // Regression: mappings created before repoRef existed (or after a load stripped it)
    // carry a random id that matches no repo id; with exactly one accessible repo the
    // link must still resolve, else every such mapping skips with "repo not found".
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const { accessor, state } = spyAccessor("L1"); // base == localSha -> clean fast-forward
    const legacy: FolderMapping = {
      id: "1a5c9571-7db0-471e-bc33-2e16db582c3b", label: "01 concepts",
      remotePath: "01 concepts", localFolder: "01 concepts",
      providerId: "c1", direction: "push-pull",
    };
    const outcomes = await syncAllMappings({
      mappings: [legacy],
      credentials: [credential({ repos: ["fbr-rom/FBR-WRK"] })],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("fbr-rom/FBR-WRK")), // allowlisted synth: id IS the path
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: legacy.id, status: "ok", pull: "fast-forward" });
    expect(state.pull).toEqual([[legacy.id, "R1"]]);
  });

  it("still skips a legacy mapping when several repos are visible (ambiguous)", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const outcomes = await syncAllMappings({
      mappings: [mapping({ id: "legacy-uuid", remotePath: "notes", localFolder: "notes" })], // matches neither repo
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => ({
        kind: "gitlab",
        async listRepos() { return [fakeRepo("r1"), fakeRepo("r2")]; },
        async getBranches() { return []; },
        async getMembers() { return []; },
        async listDirectories() { return []; },
      }),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes[0]).toMatchObject({ status: "skipped", reason: /repo not found/ });
  });
});

describe("syncAllMappings — sync outcomes", () => {
  it("threads the credential's allowed repos into the provider built for sync", async () => {
    // Regression: the sync-time provider build must forward allowedRepos so a
    // project-scoped fine-grained token skips /projects enumeration (else 403).
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const inputs: ProviderInput[] = [];
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential({ repos: ["fbr-rom/FBR-WRK"] })],
      getToken: () => "t",
      buildProvider: (input) => { inputs.push(input); return fakeProvider(fakeRepo("m1")); },
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor().accessor,
    });
    expect(outcomes[0]).toMatchObject({ status: "ok" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.allowedRepos).toEqual(["fbr-rom/FBR-WRK"]);
  });

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
    // First run clones the repo (blobless) before syncing.
  const cloneCall = calls.find((c) => c.includes("clone"));
  const cloneIdx = cloneCall!.indexOf("clone");
  expect(cloneCall![cloneIdx + 1]).toBe("--filter=blob:none");
  expect(cloneCall).toContain("https://example.com/m1.git");
    // A pass that pushed records the POST-push tip as the remote baseline (the
    // pre-push remoteSha left the 3-way base one commit stale).
    expect(outcomes).toEqual([{ mappingId: "m1", label: "Notes", status: "ok", pull: "fast-forward", push: true, newRemoteSha: "L1" }]);
    expect(state.push).toEqual([["m1", "L1"]]);
    expect(state.pull).toEqual([["m1", "L1"]]);
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

  it("auto-resolves an overlapping divergence by recency and stages the winner for push (mirror mode)", async () => {
    // Regression: recencyWins never fired because ours/theirs timestamps were never
    // populated in the sync path, and auto-resolved winners were never staged in
    // mirror mode — the same conflict would resurface on every later sync.
    const OURS_MS = Date.now();
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = {
      writeFile: (p, content) => { writes.push([p, content]); return Promise.resolve(); },
    };
    const store = memoryConflictStore();
    const vaultMirror = {
      list: async () => ["todo.md"],
      read: async (_folder: string, rel: string) => (rel === "todo.md" ? "a\nLOCAL\nc\n" : ""),
      write: async () => {},
      remove: async () => {},
      mtime: async () => OURS_MS, // the vault copy was just saved
    };
    const { runner, calls } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true,
      changedPaths: ["todo.md"], // porcelain sees the staged winner -> commit path
      showMap: { "origin/main": { "todo.md": "a\nREMOTE\nc\n" } },
      pathLogTimeSecs: 1_000_000, // remote's edit is ancient -> recency picks ours
    });
    const outcomes = await syncAllMappings({
      mappings: [mapping()], // push-pull, base "" -> add/add against the remote tip
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor, // never synced -> first pass over the mapping
      workingTree,
      conflicts: store.store,
      policy: { ...DEFAULT_SYNC_POLICY }, // autoMerge + recencyWins on, "both" fallback
      vaultMirror,
    });
    // Overlapping add/add auto-resolved by recency: the newer vault copy wins.
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok" });
    expect(store.getState()).toEqual([]); // nothing surfaced for manual resolve
    // The ours-winner was written into the clone working tree and staged for push.
    expect(writes).toEqual([[`${CLONE_ROOT}/c1/m1/todo.md`, "a\nLOCAL\nc\n"]]);
    expect(calls.some((cl) => cl.includes("add") && cl.includes("todo.md"))).toBe(true);
    expect(calls.some((cl) => cl.includes("commit"))).toBe(true);
  });

  it("skips per-file reads and shows entirely on an unchanged push-only pass (steady-state shortcut)", async () => {
    // Regression: every pass re-read every vault file and ran `git show` per
    // in-scope path (~2 minutes on a 2,000-file vault — the status bar was busy
    // ~40% of the time). With the remote tip unchanged and vault mtimes
    // predating the last completed pass, the merge universe is empty and the
    // pass does no content work at all.
    const LAST_DONE = Date.now();
    const reads: string[] = [];
    const vaultMirror = {
      list: async () => ["todo.md"],
      read: async (_folder: string, rel: string) => { reads.push(rel); return "a\nb\nc\n"; },
      write: async () => {},
      remove: async () => {},
      mtime: async () => LAST_DONE - 1000, // untouched since the last pass
    };
    const { runner, calls } = makeRunner({
      head: "R1", remote: "R1", ancestor: true, cloned: true, // remote tip == baseline
      lsFiles: ["todo.md"], // the clone tracks the file — without the shortcut it would be shown
    });
    const outcomes = await syncAllMappings({
      mappings: [mapping({ direction: "push-only" })],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: {
        lastRemoteSha: () => "R1",
        recordPull: () => undefined,
        recordPush: () => undefined,
        recordConflict: () => undefined,
        lastCompletedAt: () => LAST_DONE,
      },
      vaultMirror,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok" });
    // No content work at all: no `git show`, no vault reads — even though the
    // clone tracks the file (ls-files listed it) and the mirror has it.
    expect(calls.some((cl) => cl.includes("show"))).toBe(false);
    expect(reads).toEqual([]);
  });

  it("auto-merges a clean divergence into the working tree and pushes", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const store = memoryConflictStore();
    const { runner, calls } = makeRunner({
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
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", label: "Notes", status: "ok", pull: "rebase", push: true, newRemoteSha: "L1" });
    // Clean merge written into the clone's working tree at <cloneRoot>/<providerId>/<id>/<path>.
    expect(writes).toEqual([["/vault/.mugs-clones/c1/m1/notes/todo.md", J(["A", "b", "C"])]]);
    // The branch is re-pointed at the remote tip before staging, so the commit + push
    // land as a fast-forward instead of on the old diverged HEAD (non-FF rejection).
    const resetIdx = calls.findIndex((c) => c.includes("reset"));
    expect(calls[resetIdx]?.includes("origin/main")).toBe(true);
    expect(calls.findIndex((c) => c.includes("commit"))).toBeGreaterThan(resetIdx);
    expect(store.getState()).toEqual([]); // no conflicts recorded
    expect(state.push).toEqual([["m1", "L1"]]);
    expect(state.pull).toEqual([["m1", "L1"]]); // post-push tip recorded
  });

  it("clears previously-recorded conflicts once a pass completes cleanly", async () => {
    // Stale records from an older divergent state must not haunt the Diff view after
    // a clean pass — the merge re-evaluates every in-scope file each sync.
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const store = memoryConflictStore([{ path: "notes/old.md", base: "b", ours: "O", theirs: "T" }]);
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("L1").accessor, // clean fast-forward, nothing diverged
      conflicts: store.store,
    });
    expect(outcomes[0].status).toBe("ok");
    expect(store.getState()).toEqual([]); // superseded by the clean pass
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

describe("syncAllMappings — local provider (existing local clone)", () => {
  it("fast-forwards a pull-only local mapping without pushing", async () => {
    const { runner } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true });
    const { accessor, state } = spyAccessor("L1"); // base == localSha -> no unpushed work
    const outcomes = await syncAllMappings({
      mappings: [mapping({ direction: "pull-only" })],
      credentials: [credential({ kind: "local", baseUrl: "file:///tmp/shared.git" })],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
    });
    expect(outcomes).toEqual([{ mappingId: "m1", label: "Notes", status: "ok", pull: "fast-forward", push: false, newRemoteSha: "R1" }]);
    expect(state.pull).toEqual([["m1", "R1"]]);
    expect(state.push).toEqual([]);
  });

  it("pulls fast-forward and pushes unpushed local work on a local push-pull mapping, cloning first", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: false }); // not yet cloned
    const { accessor, state } = spyAccessor("B0"); // base != localSha -> unpushed
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential({ kind: "local", baseUrl: "file:///tmp/shared.git" })],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
    });
    // First run clones the local repo (ensureClone) before syncing.
  const cloneCall = calls.find((c) => c.includes("clone"));
    const cloneIdx = cloneCall!.indexOf("clone");
    expect(cloneCall![cloneIdx + 1]).toBe("/tmp/shared.git");
    expect(outcomes).toEqual([{ mappingId: "m1", label: "Notes", status: "ok", pull: "fast-forward", push: true, newRemoteSha: "L1" }]);
    expect(state.push).toEqual([["m1", "L1"]]);
    expect(state.pull).toEqual([["m1", "L1"]]);
  });

  it("surfaces a divergent file as a durable conflict on a local rebase pull", async () => {
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
      credentials: [credential({ kind: "local", baseUrl: "file:///tmp/shared.git" })],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      conflicts: store.store,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", label: "Notes", status: "conflict" });
    expect(store.getState()).toEqual([
      { path: "notes/todo.md", base: J(["a", "shared", "c"]), ours: J(["a", "LOCAL", "c"]), theirs: J(["a", "REMOTE", "c"]) },
    ]);
    expect(state.conflict).toEqual(["m1"]);
  });
});

describe("syncAllMappings — sync outcomes", () => {
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
  it("materializes a clean-merge result into the clone even while the vault file is open (the guard protects vault writes, not staging)", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const editorOpen = new EditorOpenGuard(["notes/todo.md"]); // vault file open w/ unsaved changes
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
    // Clone working-tree writes are staging material and never clobber the user's
    // open editor (the vault-side write-back guard lives in mirrorPull, in vault
    // path space). The old repo-space check here never matched and was dead.
    expect(writes).toEqual([["/vault/.mugs-clones/c1/m1/notes/todo.md", J(["A", "b", "C"])]]);
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

describe("syncAllMappings — .obsidian/ scope gating (Area 9)", () => {
  it("merges only vault-wide .obsidian/ files, keeping personal ones local", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged, non-overlapping -> clean merge
      changedPaths: [".obsidian/themes/x.css", ".obsidian/settings.json"],
      showMap: {
        M0: { ".obsidian/themes/x.css": J(["a", "b", "c"]), ".obsidian/settings.json": J(["p", "q", "r"]) },
        HEAD: { ".obsidian/themes/x.css": J(["A", "b", "c"]), ".obsidian/settings.json": J(["P", "q", "r"]) },
        "origin/main": { ".obsidian/themes/x.css": J(["a", "b", "C"]), ".obsidian/settings.json": J(["p", "Q", "r"]) },
      },
    });
    const { accessor } = spyAccessor(""); // unpushed -> rebase, clean merge
    await syncAllMappings({
      mappings: [mapping({ id: "obs", localFolder: ".obsidian", remotePath: "" })],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("obs")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      workingTree,
      // Enabled with no user overrides -> default personal/vault-wide classification.
      obsidianConfig: { enabled: true, entries: [] },
    });
    // Only the vault-wide theme is merged/written; personal settings.json stays local.
    expect(writes).toEqual([["/vault/.mugs-clones/c1/obs/.obsidian/themes/x.css", J(["A", "b", "C"])]]);
  });

  it("syncs nothing under .obsidian/ when the feature is disabled (repo-side config must never clobber a teammate's config)", async () => {
    const writes: Array<[string, string]> = [];
    const workingTree: WorkingTreeWriter = { writeFile: (p, c) => { writes.push([p, c]); return Promise.resolve(); } };
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true,
      changedPaths: [".obsidian/themes/x.css"],
      showMap: {
        M0: { ".obsidian/themes/x.css": J(["a", "b", "c"]) },
        HEAD: { ".obsidian/themes/x.css": J(["A", "b", "c"]) },
        "origin/main": { ".obsidian/themes/x.css": J(["a", "b", "C"]) },
      },
    });
    const { accessor } = spyAccessor("");
    await syncAllMappings({
      mappings: [mapping({ id: "obs", localFolder: ".obsidian", remotePath: "" })],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("obs")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: accessor,
      workingTree,
      // Explicitly disabled -> .obsidian/ paths are out of scope entirely: the old
      // behavior pulled repo-side config into every user's .obsidian dir.
      obsidianConfig: { enabled: false, entries: [] },
    });
    expect(writes).toEqual([]);
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

describe("syncAllMappings — agent attribution on push (Area 10)", () => {
  it("attributes an agent's push to that agent with an On-behalf-of trailer", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: false, changedPaths: ["notes/todo.md"] }); // clone + unpushed
    const actingAgent: Agent = { id: "agent-1", displayName: "Research Bot", committerEmail: "bot@local", ownerHuman: "Ada" };
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor, // unpushed -> push
      pickAgent: () => actingAgent,
    });
    const commitCall = calls.find((c) => c.includes("commit"))!;
    // Message carries the on-behalf-of trailer for the owner…
    expect(commitCall.join(" ")).toContain("On-behalf-of: Ada");
    // …and the commit is authored by the agent's committer identity.
    const authorIdx = commitCall.indexOf("--author");
    expect(commitCall[authorIdx + 1]).toBe("Research Bot <bot@local>");
  });

  it("leaves attribution to git defaults when no agent acts on the mapping", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: false, changedPaths: ["notes/todo.md"] });
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor,
      pickAgent: () => undefined, // no agent -> plain sync commit
    });
    const commitCall = calls.find((c) => c.includes("commit"))!;
    expect(commitCall.join(" ")).not.toContain("On-behalf-of");
    expect(commitCall).not.toContain("--author");
  });
});

describe("syncAllMappings — review-queue 'held' gates push (Area 8)", () => {
  it("excludes a held path from staging while still pushing in-scope changes", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true, changedPaths: ["notes/keep.md", "notes/held.md"] });
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor, // unpushed -> fast-forward + push
      heldPaths: () => new Set(["notes/held.md"]),
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok", push: true });
    const addCall = calls.find((c) => c.includes("add") && c.includes("notes/keep.md"))!;
    // The held file is staged out so it never leaves the machine; the in-scope change still pushes.
    expect(addCall).toContain("notes/keep.md");
    expect(addCall).not.toContain("notes/held.md");
  });

  it("pushes everything when nothing is held (heldPaths returns empty)", async () => {
    const { runner, calls } = makeRunner({ head: "L1", remote: "R1", ancestor: true, cloned: true, changedPaths: ["notes/a.md", "notes/b.md"] });
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor,
      heldPaths: () => new Set<string>(),
    });
    const addCall = calls.find((c) => c.includes("add") && c.includes("notes/a.md"))!;
    expect(addCall).toContain("notes/b.md");
  });
});

describe("syncAllMappings — recoverable deletions via .mugs-trash (Area 3)", () => {
  it("records prior content before removing a both-sides-deleted file on rebase", async () => {
    const trash = new MemoryTrashStore();
    const { runner } = makeRunner({
      head: "L1", remote: "R1", ancestor: false, cloned: true, // diverged -> rebase pull
      changedPaths: ["notes/both.md"],
      // Base has content; HEAD and origin/main omit it => both sides deleted.
      showMap: { M0: { "notes/both.md": "original content" } },
    });
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [credential()],
      getToken: () => "t",
      buildProvider: () => fakeProvider(fakeRepo("m1")),
      cloneRoot: CLONE_ROOT,
      runner,
      lastSync: spyAccessor("").accessor, // unpushed -> rebase + push
      trash,
    });
    expect(outcomes[0]).toMatchObject({ mappingId: "m1", status: "ok" });
    // The deletion was recorded in the trash before removal (recoverable), even though the
    // local side was already gone so no prior content survived to store.
    expect(trash.has("m1", "notes/both.md")).toBe(true);
    expect(trash.get("m1", "notes/both.md")).toBe("");
  });
});
