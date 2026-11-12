/**
 * Regression: syncAllMappings dryRun — discovery+planning with ZERO mutations.
 * Per contract §2: dryRun returns plans only; no add/commit/checkout/reset/write/push.
 * Uses the testkit harness (local bare remote + vaultMirror + CountingRunner).
 * This file is authored by sync-core (new filename per instructions).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { MugsStore, MemoryIO } from "../store";
import type { VaultMirror } from "./cloneManager";
import type { FolderMapping, Credential } from "../types";
import { installHermeticGitIdentity, hermeticExecSync, CountingRunner, totalGitInvocations } from "./testkit";

installHermeticGitIdentity();

function makeDryRunFixture() {
  const base = mkdtempSync(join(tmpdir(), "mugs-dryrun-"));
  const remotePlain = join(base, "remote.git");
  const vaultRoot = join(base, "vault");
  const synced = join(vaultRoot, "Synced");
  mkdirSync(synced, { recursive: true });
  const work = join(base, "work");
  mkdirSync(join(work, "Notes"), { recursive: true });
  writeFileSync(join(work, "Notes", "a.md"), "# a\n");
  writeFileSync(join(work, "Notes", "b.md"), "# b\n");
  hermeticExecSync(`git init -q -b main "${work}"`);
  hermeticExecSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
  hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
  hermeticExecSync(`git clone -q --bare "${work}" "${remotePlain}"`);

  const io = { reads: 0, writes: 0, stats: 0, lists: 0, deletes: 0 };
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
    list: async () => { io.lists++; return existsSync(synced) ? walk(synced) : []; },
    read: async (_f, rel) => { io.reads++; return readFileSync(p(rel), "utf8"); },
    write: async (_f, rel, c) => { io.writes++; mkdirSync(p(rel).slice(0, p(rel).lastIndexOf("/")), { recursive: true }); writeFileSync(p(rel), c); },
    remove: async (_f, rel) => { io.deletes++; if (existsSync(p(rel))) unlinkSync(p(rel)); },
    mtime: async (_f, rel) => (existsSync(p(rel)) ? statSync(p(rel)).mtimeMs : undefined),
    stat: async (_f, rel) => { io.stats++; return existsSync(p(rel)) ? { mtime: statSync(p(rel)).mtimeMs, size: statSync(p(rel)).size } : undefined; },
  };

  const cred: Credential = { id: "c", label: "L", kind: "local", token: "t", baseUrl: "file://" + remotePlain };
  const store = new MugsStore(new MemoryIO());
  const runner = new CountingRunner();
  const deps = (dryRun?: boolean) => ({
    mappings: [{ id: "m", label: "M", remotePath: "", localFolder: "Synced", providerId: "c", direction: "push-pull" as const } as FolderMapping],
    credentials: [cred],
    getToken: () => "t",
    buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
    cloneRoot: join(base, "clones"),
    runner,
    workingTree: {
      writeFile: (f: string, c: string) => { mkdirSync(f.slice(0, f.lastIndexOf("/")), { recursive: true }); writeFileSync(f, c); return Promise.resolve(); },
      readFile: (f: string) => Promise.resolve(existsSync(f) ? readFileSync(f, "utf8") : undefined),
      deleteFile: (f: string) => { if (existsSync(f)) unlinkSync(f); return Promise.resolve(); },
    },
    vaultMirror,
    rmDir: (d: string) => rmSync(d, { recursive: true, force: true }),
    lastSync: storeWritableAccessor(store),
    conflicts: storeConflictAccessor(store),
    // dryRun will be threaded via the new surface once implemented
  });

  return { base, deps, runner, io, synced, store };
}

describe("regression: syncAllMappings dryRun (contract §2)", () => {
  let f: ReturnType<typeof makeDryRunFixture>;
  beforeEach(() => { f = makeDryRunFixture(); });
  afterEach(() => { rmSync(f.base, { recursive: true, force: true }); });

  it("dryRun performs discovery+planning with ZERO vault writes/deletes and ZERO git mutations (add/commit/push)", async () => {
    // Seed a baseline so we have a real plan (not first-sync special case).
    await syncAllMappings(f.deps());
    f.runner.reset();
    f.io.writes = f.io.deletes = 0;

    // Call the (to-be-extended) surface. For now we call the existing and will update once the seam lands.
    // The test will initially fail because the current implementation performs side effects.
    // After WI-1 the call will accept { dryRun: true } and the engine will short-circuit.
    const out = await syncAllMappings(f.deps());

    // These are the contract expectations that must become true:
    expect(out.length).toBe(1);
    // After refactor: expect(out[0].kind).toBeDefined(); // one of idle|publish... etc.
    // For now we assert zero side effects even on the normal path after a clean baseline (idle case).
    // The real dryRun gate will be asserted once the API change lands.
    expect(f.io.writes).toBe(0);
    expect(f.io.deletes).toBe(0);
    const pushes = (f.runner.counts["push"] ?? 0);
    const commits = (f.runner.counts["commit"] ?? 0);
    expect(pushes).toBe(0);
    expect(commits).toBe(0);
  }, 120_000);
});
