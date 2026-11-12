/**
 * Wave B engine regression suite (sync-core) — real-git, hermetic.
 *
 * Covers:
 * - S01: deferred writes/deletes become durable pendingOps; correspondence never
 *   advances past unapplied work; a restart after a deferred remote update never
 *   pushes stale vault content as a new local change.
 * - S03: shared-clone isolation (one identity = one clone; A's pass never commits
 *   B's stray index/worktree state), per-branch worktrees, legacy dirty/unpushed
 *   clone blocks (never reset), cross-process advisory lock blocks.
 * - E02: same-size/same-mtime replacement detected when uncertain, and the
 *   stat shortcut still skips when certain.
 * - dryRun: discovery+planning with ZERO mutations (contract §2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { MugsStore, MemoryIO } from "../store";
import type { VaultMirror } from "./cloneManager";
import { cloneDir } from "./cloneManager";
import type { FolderMapping, Credential } from "../types";
import { installHermeticGitIdentity, hermeticExecSync, CountingRunner } from "./testkit";
import { identityCloneDir } from "./repoIdentity";
import { EditorOpenGuard } from "./editorOpen";

installHermeticGitIdentity();

function sh(cmd: string): string {
  return execSync(cmd, { shell: "/bin/bash", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

interface Fixture {
  base: string;
  remote: string;
  synced: string;
  io: { reads: number; writes: number; deletes: number };
  runner: CountingRunner;
  store: MugsStore;
  ioMem: MemoryIO;
  deps: (over?: { mappings?: FolderMapping[]; editorOpen?: EditorOpenGuard; watcherUncertain?: boolean }) => Parameters<typeof syncAllMappings>[0];
}

function makeFixture(direction: FolderMapping["direction"] = "push-pull"): Fixture {
  const base = mkdtempSync(join(tmpdir(), "mugs-waveb-"));
  const remote = join(base, "remote.git");
  const synced = join(base, "vault", "Synced");
  mkdirSync(synced, { recursive: true });
  writeFileSync(join(synced, "F.md"), "v1\n");
  writeFileSync(join(synced, "G.md"), "g\n");
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "F.md"), "v1\n");
  writeFileSync(join(work, "G.md"), "g\n");
  hermeticExecSync(`git init -q -b main "${work}"`);
  hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
  hermeticExecSync(`git clone -q --bare "${work}" "${remote}"`);
  rmSync(work, { recursive: true, force: true });

  const io = { reads: 0, writes: 0, deletes: 0 };
  const p = (rel: string) => join(synced, rel);
  const walk = (dir: string, b = ""): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir)) {
      if (e.startsWith(".")) continue;
      const abs = join(dir, e);
      const rel = b ? `${b}/${e}` : e;
      if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
      else out.push(rel);
    }
    return out;
  };
  const vaultMirror: VaultMirror = {
    list: async () => (existsSync(synced) ? walk(synced) : []),
    read: async (_f, rel) => { io.reads++; return readFileSync(p(rel), "utf8"); },
    write: async (_f, rel, c) => { io.writes++; mkdirSync(p(rel).slice(0, p(rel).lastIndexOf("/")), { recursive: true }); writeFileSync(p(rel), c); },
    remove: async (_f, rel) => { io.deletes++; if (existsSync(p(rel))) unlinkSync(p(rel)); },
    mtime: async (_f, rel) => (existsSync(p(rel)) ? statSync(p(rel)).mtimeMs : undefined),
    stat: async (_f, rel) => (existsSync(p(rel)) ? { mtime: statSync(p(rel)).mtimeMs, size: statSync(p(rel)).size } : undefined),
  };

  const cred: Credential = { id: "c", label: "L", kind: "local", token: "t", baseUrl: "file://" + remote };
  const ioMem = new MemoryIO();
  const store = new MugsStore(ioMem);
  const runner = new CountingRunner();
  const mapping: FolderMapping = { id: "m", label: "M", remotePath: "", localFolder: "Synced", providerId: "c", direction };

  const deps = (over: { mappings?: FolderMapping[]; editorOpen?: EditorOpenGuard; watcherUncertain?: boolean } = {}) => ({
    mappings: over.mappings ?? [mapping],
    credentials: [cred],
    getToken: () => "t",
    buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
    cloneRoot: join(base, "clones"),
    runner,
    workingTree: {
      writeFile: (fp: string, c: string) => { mkdirSync(fp.slice(0, fp.lastIndexOf("/")), { recursive: true }); writeFileSync(fp, c); return Promise.resolve(); },
      readFile: (fp: string) => Promise.resolve(existsSync(fp) ? readFileSync(fp, "utf8") : undefined),
      deleteFile: (fp: string) => { if (existsSync(fp)) unlinkSync(fp); return Promise.resolve(); },
    },
    vaultMirror,
    rmDir: (d: string) => rmSync(d, { recursive: true, force: true }),
    lastSync: storeWritableAccessor(store),
    conflicts: storeConflictAccessor(store),
    editorOpen: over.editorOpen,
    watcherUncertain: over.watcherUncertain,
  });

  return { base, remote, synced, io, runner, store, ioMem, deps };
}

let f: Fixture;
beforeEach(() => { f = makeFixture(); });
afterEach(() => { rmSync(f.base, { recursive: true, force: true }); });

const remoteTip = (): string => sh(`git -C "${f.remote}" rev-parse main`).trim();
const remoteFile = (name: string): string => sh(`git -C "${f.remote}" show main:${name}`).toString();
const PUSH_ONLY: FolderMapping[] = [{ id: "m", label: "M", remotePath: "", localFolder: "Synced", providerId: "c", direction: "push-only" }];

describe("S01: deferred work -> durable pendingOps; correspondence gating; restart safety", () => {
  it("defers editor-held write+delete into pendingOps, never advances correspondence, and a restart re-applies without stale pushes", async () => {
    // Pass 1: prove correspondence (vault == remote @ v1).
    await syncAllMappings(f.deps());
    const shaV1 = remoteTip();
    expect(f.store.getSettings().lastSync["m"]?.correspondenceSha).toBe(shaV1);
    expect(f.store.getSettings().lastSync["m"]?.vaultPopulated).toBe(true);

    // Remote advances: F -> v2, G deleted.
    const work = join(f.base, "remoteWork");
    hermeticExecSync(`git clone -q "${f.remote}" "${work}"`);
    writeFileSync(join(work, "F.md"), "v2\n");
    sh(`git -C "${work}" rm -q G.md`);
    hermeticExecSync(`git -C "${work}" commit -q -a -m "remote change"`);
    sh(`git -C "${work}" push -q origin main`);
    rmSync(work, { recursive: true, force: true });
    const shaV2 = remoteTip();
    expect(shaV2).not.toBe(shaV1);

    // Pass 2: the editor holds BOTH F.md and G.md open with unsaved changes.
    f.runner.reset();
    f.io.writes = f.io.deletes = 0;
    const editor = new EditorOpenGuard(["Synced/F.md", "Synced/G.md"]);
    const out2 = await syncAllMappings(f.deps({ editorOpen: editor }));
    expect(out2[0]?.status).toBe("ok");
    // Nothing touched in the vault...
    expect(f.io.writes).toBe(0);
    expect(f.io.deletes).toBe(0);
    expect(readFileSync(join(f.synced, "F.md"), "utf8")).toBe("v1\n");
    expect(existsSync(join(f.synced, "G.md"))).toBe(true);
    // ...the work is DURABLE in pendingOps...
    const pending = f.store.getSettings().lastSync["m"]?.pendingOps ?? [];
    expect(pending.map((o) => o.kind).sort()).toEqual(["vault-delete", "vault-write"]);
    expect(pending.every((o) => o.state === "pending")).toBe(true);
    // ...and correspondence did NOT advance past the unapplied work.
    expect(f.store.getSettings().lastSync["m"]?.correspondenceSha).toBe(shaV1);
    // No stale push happened on the deferred pass.
    expect(f.runner.counts["push"] ?? 0).toBe(0);
    // Persist (the runtime saves after every pass; main.ts owns save()).
    await f.store.save();

    // RESTART: a fresh store over the same persisted IO (new session), guard removed.
    const store2 = new MugsStore(f.ioMem);
    await store2.load();
    expect(store2.getSettings().lastSync["m"]?.pendingOps?.length ?? 0).toBe(2);
    const depsRestart = { ...f.deps(), lastSync: storeWritableAccessor(store2) };
    f.runner.reset();
    f.io.writes = f.io.deletes = 0;
    const out3 = await syncAllMappings(depsRestart);
    expect(out3[0]?.status).toBe("ok");
    // Recovery applied the deferred work: F == v2, G removed (recoverable via trash).
    expect(readFileSync(join(f.synced, "F.md"), "utf8")).toBe("v2\n");
    expect(existsSync(join(f.synced, "G.md"))).toBe(false);
    // pendingOps cleared, correspondence advanced to the proven tip.
    expect(store2.getSettings().lastSync["m"]?.pendingOps?.length ?? 0).toBe(0);
    expect(store2.getSettings().lastSync["m"]?.correspondenceSha).toBe(shaV2);
    // The stale vault content was NEVER pushed as a new local change.
    expect(f.runner.counts["push"] ?? 0).toBe(0);
    expect(remoteTip()).toBe(shaV2);
    expect(remoteFile("F.md")).toBe("v2\n");
  }, 120_000);
});

function canonicalRemoteLocal(remote: string): string {
  return remote.replace(/\.git$/, "");
}

function makeMirror(folder: string, vaultRoot: string): VaultMirror {
  return {
    list: async () => {
      const d = join(vaultRoot, folder);
      return existsSync(d) ? sh(`find "${d}" -type f -not -path "*/.*" | sed "s|^${d}/||"`).split("\n").filter(Boolean) : [];
    },
    read: async (_f, rel) => readFileSync(join(vaultRoot, folder, rel), "utf8"),
    write: async (_f, rel, c) => { const t = join(vaultRoot, folder, rel); mkdirSync(t.slice(0, t.lastIndexOf("/")), { recursive: true }); writeFileSync(t, c); },
    remove: async (_f, rel) => { const t = join(vaultRoot, folder, rel); if (existsSync(t)) unlinkSync(t); },
    stat: async (_f, rel) => { const t = join(vaultRoot, folder, rel); return existsSync(t) ? { mtime: statSync(t).mtimeMs, size: statSync(t).size } : undefined; },
  };
}

function makeSharedDeps(base: string, remote: string, store: MugsStore, runner: CountingRunner, vaultRoot: string, m: FolderMapping) {
  const cred: Credential = { id: "c", label: "L", kind: "local", token: "t", baseUrl: "file://" + remote };
  return {
    mappings: [m],
    credentials: [cred],
    getToken: () => "t",
    buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
    cloneRoot: join(base, "clones"),
    runner,
    workingTree: {
      writeFile: (fp: string, c: string) => { mkdirSync(fp.slice(0, fp.lastIndexOf("/")), { recursive: true }); writeFileSync(fp, c); return Promise.resolve(); },
      readFile: (fp: string) => Promise.resolve(existsSync(fp) ? readFileSync(fp, "utf8") : undefined),
      deleteFile: (fp: string) => { if (existsSync(fp)) unlinkSync(fp); return Promise.resolve(); },
    },
    vaultMirror: makeMirror(m.localFolder, vaultRoot),
    rmDir: (d: string) => rmSync(d, { recursive: true, force: true }),
    lastSync: storeWritableAccessor(store),
    conflicts: storeConflictAccessor(store),
  };
}

describe("S03: shared-clone isolation + advisory lock + legacy inventory", () => {
  it("two mappings share one identity clone; a sync of A never commits B's stray staged state (S04 scoped gate)", async () => {
    const base = mkdtempSync(join(tmpdir(), "mugs-iso-"));
    try {
      const remote = join(base, "remote.git");
      const work = join(base, "work");
      mkdirSync(join(work, "a"), { recursive: true });
      mkdirSync(join(work, "b"), { recursive: true });
      writeFileSync(join(work, "a", "one.md"), "one\n");
      writeFileSync(join(work, "b", "two.md"), "two\n");
      hermeticExecSync(`git init -q -b main "${work}"`);
      hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
      hermeticExecSync(`git clone -q --bare "${work}" "${remote}"`);
      rmSync(work, { recursive: true, force: true });

      const vaultRoot = join(base, "vault");
      mkdirSync(join(vaultRoot, "A"), { recursive: true });
      mkdirSync(join(vaultRoot, "B"), { recursive: true });
      const store = new MugsStore(new MemoryIO());
      const runner = new CountingRunner();
      const mapA: FolderMapping = { id: "a", label: "A", remotePath: "a", localFolder: "A", providerId: "c", direction: "push-pull", repoRef: "shared" };
      const mapB: FolderMapping = { id: "b", label: "B", remotePath: "b", localFolder: "B", providerId: "c", direction: "push-pull", repoRef: "shared" };

      // Populate both mappings — they share ONE identity clone.
      await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mapA));
      await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mapB));
      const shared = identityCloneDir(join(base, "clones"), { providerId: "c", repoId: "shared", branch: "main", canonicalRemote: canonicalRemoteLocal(remote) });
      expect(existsSync(join(shared, ".git"))).toBe(true);

      // B's in-flight state: a stray file staged into the shared index.
      writeFileSync(join(shared, "stray.md"), "B's unfinished work\n");
      sh(`git -C "${shared}" add stray.md`);

      // A edits its file and syncs.
      writeFileSync(join(vaultRoot, "A", "one.md"), "one v2\n");
      runner.reset();
      const out = await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mapA));
      expect(out[0]?.status).toBe("ok");
      expect(out[0]?.push).toBe(true);

      // The commit contains ONLY A's file — B's stray state never entered.
      const lastFiles = sh(`git -C "${shared}" show --name-only --format= HEAD`).trim().split("\n").sort();
      expect(lastFiles).toEqual(["a/one.md"]);
      // B's stray file is STILL staged (untouched, uncommitted) in the shared index.
      expect(sh(`git -C "${shared}" diff --cached --name-only`).trim()).toContain("stray.md");
      expect(existsSync(join(shared, "stray.md"))).toBe(true);
      // And the push fast-forwarded the remote to the shared clone's HEAD.
      expect(sh(`git -C "${remote}" rev-parse main`).trim()).toBe(sh(`git -C "${shared}" rev-parse HEAD`).trim());
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it("different branches get independent worktrees; a foreign lock blocks; a dirty legacy clone blocks instead of resetting", async () => {
    const base = mkdtempSync(join(tmpdir(), "mugs-iso2-"));
    try {
      const remote = join(base, "remote.git");
      const work = join(base, "work");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "main.md"), "main\n");
      hermeticExecSync(`git init -q -b main "${work}"`);
      hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
      hermeticExecSync(`git -C "${work}" checkout -q -b side`);
      writeFileSync(join(work, "side.md"), "side\n");
      sh(`git -C "${work}" add -A`);
      hermeticExecSync(`git -C "${work}" commit -q -m side`);
      hermeticExecSync(`git -C "${work}" checkout -q main`);
      hermeticExecSync(`git clone -q --bare "${work}" "${remote}"`);
      rmSync(work, { recursive: true, force: true });

      const vaultRoot = join(base, "vault");
      const store = new MugsStore(new MemoryIO());
      const runner = new CountingRunner();
      const mkMapping = (id: string, branch: string): FolderMapping => ({ id, label: id, remotePath: "", localFolder: id, providerId: "c", direction: "push-pull", branch, repoRef: "shared" });

      // Two branches -> two independent clone dirs.
      await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mkMapping("mb", "main")));
      await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mkMapping("sb", "side")));
      const idMain = { providerId: "c", repoId: "shared", branch: "main", canonicalRemote: canonicalRemoteLocal(remote) };
      const dirMain = identityCloneDir(join(base, "clones"), idMain);
      const dirSide = identityCloneDir(join(base, "clones"), { ...idMain, branch: "side" });
      expect(dirMain).not.toBe(dirSide);
      expect(existsSync(join(dirMain, "main.md"))).toBe(true);
      expect(existsSync(join(dirSide, "side.md"))).toBe(true);
      expect(existsSync(join(dirMain, "side.md"))).toBe(false);

      // Cross-process advisory lock (a SIBLING file next to the clone dir, so it
      // can never interfere with `git clone` into the dir): a foreign pid blocks.
      writeFileSync(`${dirMain}.mugs-sync.lock`, "999999:123");
      writeFileSync(join(vaultRoot, "mb", "main.md"), "edited\n");
      const outLocked = await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mkMapping("mb", "main")));
      expect(outLocked[0]?.status).toBe("blocked");
      expect(outLocked[0]?.reason).toContain("another process");
      rmSync(`${dirMain}.mugs-sync.lock`, { force: true });

      // Legacy clone (provider/repoId layout) holding an UNPUSHED commit -> blocked,
      // and the legacy commit is NEVER reset.
      const legacy = cloneDir({ root: join(base, "clones") }, "c", "shared");
      hermeticExecSync(`git clone -q "${remote}" "${legacy}"`);
      writeFileSync(join(legacy, "legacy.md"), "precious unpushed work\n");
      sh(`git -C "${legacy}" add -A`);
      hermeticExecSync(`git -C "${legacy}" commit -q -m "legacy local work"`);
      const legacyHead = sh(`git -C "${legacy}" rev-parse HEAD`).trim();
      const outLegacy = await syncAllMappings(makeSharedDeps(base, remote, store, runner, vaultRoot, mkMapping("mb2", "main")));
      expect(outLegacy[0]?.status).toBe("blocked");
      expect(outLegacy[0]?.reason).toContain("legacy clone");
      expect(sh(`git -C "${legacy}" rev-parse HEAD`).trim()).toBe(legacyHead);
      expect(existsSync(join(legacy, "legacy.md"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("E02: same-size/same-mtime replacement", () => {
  it("is detected when the watcher is uncertain (full re-verify), and the shortcut still skips when certain", async () => {
    // Push-only steady state: pass 1 records the snapshot.
    await syncAllMappings(f.deps({ mappings: PUSH_ONLY }));
    const snap = f.store.getSettings().lastSync["m"]?.contentSnapshot?.["F.md"];
    expect(snap).toBeDefined();
    const shaV1 = remoteTip();

    // Same-size replacement with the mtime forged back to the snapshot pair.
    writeFileSync(join(f.synced, "F.md"), "V1\n");
    utimesSync(join(f.synced, "F.md"), snap![0] / 1000, snap![0] / 1000);

    // Certain pass: the exact stat pair (predating the pass) skips — shortcut intact.
    f.runner.reset();
    f.io.reads = 0;
    const outCertain = await syncAllMappings(f.deps({ mappings: PUSH_ONLY }));
    expect(outCertain[0]?.status).toBe("ok");
    expect(f.io.reads).toBe(0);
    expect(f.runner.counts["push"] ?? 0).toBe(0);

    // Uncertain pass (startup/watcher doubt): the shortcut is disabled — the
    // replacement is verified by content and pushed. No false success.
    f.runner.reset();
    f.io.reads = 0;
    const outUncertain = await syncAllMappings(f.deps({ mappings: PUSH_ONLY, watcherUncertain: true }));
    expect(outUncertain[0]?.status).toBe("ok");
    expect(outUncertain[0]?.push).toBe(true);
    expect(f.io.reads).toBeGreaterThan(0);
    expect(remoteTip()).not.toBe(shaV1);
    expect(remoteFile("F.md")).toBe("V1\n");
  }, 120_000);
});

describe("dryRun (contract §2): discovery+planning with zero mutations", () => {
  it("plans without touching the vault, clone, or remote", async () => {
    // Baseline.
    await syncAllMappings(f.deps());
    const tipBefore = remoteTip();

    // Local edit + remote advance: a real pass would publish AND apply.
    writeFileSync(join(f.synced, "F.md"), "v1 local edit\n");
    const work = join(f.base, "remoteWork");
    hermeticExecSync(`git clone -q "${f.remote}" "${work}"`);
    writeFileSync(join(work, "G.md"), "g remote edit\n");
    hermeticExecSync(`git -C "${work}" commit -q -a -m remote2`);
    sh(`git -C "${work}" push -q origin main`);
    rmSync(work, { recursive: true, force: true });
    const tipAfterSetup = remoteTip();
    const commitCount = Number(sh(`git -C "${f.remote}" rev-list --count main`).trim());

    f.runner.reset();
    f.io.writes = f.io.deletes = 0;
    const out = await syncAllMappings(f.deps(), { dryRun: true });
    expect(out[0]?.status).toBe("ok");
    expect(out[0]?.kind).toBeDefined();
    expect(out[0]?.counts).toBeDefined();
    // ZERO mutations anywhere.
    expect(f.io.writes).toBe(0);
    expect(f.io.deletes).toBe(0);
    for (const verb of ["add", "commit", "push", "reset", "checkout"]) {
      expect(f.runner.counts[verb] ?? 0).toBe(0);
    }
    expect(readFileSync(join(f.synced, "F.md"), "utf8")).toBe("v1 local edit\n"); // vault untouched
    expect(remoteTip()).toBe(tipAfterSetup); // dry run did not push or commit
    expect(Number(sh(`git -C "${f.remote}" rev-list --count main`).trim())).toBe(commitCount);
  }, 120_000);
});
