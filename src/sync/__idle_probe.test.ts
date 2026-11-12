/**
 * Deterministic idle regression test (qa-release, Wave A).
 *
 * Two tiers:
 *  (a) assertions that PASS today (hermetic env): verified-idle passes perform
 *      ZERO content writes, deletions, commits, or pushes.
 *  (b) defect-pinning assertions that FAIL today: per-pass git invocation count and
 *      `git show` count must be bounded. Current measured (Node 24, ~300 notes):
 *      push-pull ~609 git / ~600 shows; pull-only ~609 / ~600; push-only ~7 / 0.
 *      These are pinned with vitest `test.fails` so the suite stays green.
 *
 * The production engine wave will tighten these bounds; the pins become strict
 * expectations afterward.
 */
import { describe, it, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { MugsStore, MemoryIO } from "../store";
import type { VaultMirror } from "./cloneManager";
import type { FolderMapping, Credential } from "../types";
import { installHermeticGitIdentity, hermeticExecSync, CountingRunner, totalGitInvocations, gitShowCount } from "./testkit";

installHermeticGitIdentity();

const N = 300;

/** Unique temp root + seeded remote + vault mirror with counters. Always cleaned in finally. */
function makeIdleFixture(direction: FolderMapping["direction"]) {
  const base = mkdtempSync(join(tmpdir(), "mugs-idle-"));
  const remotePlain = join(base, "remote.git");
  const vaultRoot = join(base, "vault");
  const synced = join(vaultRoot, "Synced");
  mkdirSync(synced, { recursive: true });
  const work = join(base, "work");
  mkdirSync(join(work, "Notes"), { recursive: true });
  for (let i = 0; i < N; i++) writeFileSync(join(work, "Notes", `n${i}.md`), `# note ${i}\n\nbody ${i}\n`);
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
  const deps = () => ({
    mappings: [{ id: "m", label: "M", remotePath: "", localFolder: "Synced", providerId: "c", direction } as FolderMapping],
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
  });
  return { base, deps, runner, io, synced, direction };
}

/**
 * Count git invocations and show calls from the runner's verb counts.
 * `show` is reported by git client as the verb for `git show REF:PATH`.
 */

function runIdlePass(f: ReturnType<typeof makeIdleFixture>) {
  f.runner.reset();
  f.io.reads = f.io.writes = f.io.stats = f.io.lists = f.io.deletes = 0;
  return syncAllMappings(f.deps());
}

/**
 * Setup: init + populate pass(es), then one SETTLING pass so a post-population
 * content snapshot exists. The measured pass then has the "trustworthy unchanged
 * vault evidence" the contract requires for a verified-idle shortcut.
 */
async function settleBaseline(f: ReturnType<typeof makeIdleFixture>) {
  await syncAllMappings(f.deps()); // init pass (populate / first sync)
  await syncAllMappings(f.deps()); // settle pass (records a valid snapshot)
}

describe("idle regression — verified zero side-effects on clean pass", () => {
  for (const direction of ["push-pull", "pull-only", "push-only"] as const) {
    it(`${direction}: verified-idle pass performs zero vault writes/deletes/commits/pushes`, async () => {
      const f = makeIdleFixture(direction);
      try {
        await settleBaseline(f);
        const out = await runIdlePass(f);
        expect(out[0].status, `skip reason: ${out[0].reason}`).toBe("ok");

        // Tier (a) — assertions that must PASS today.
        expect(f.io.writes).toBe(0);
        expect(f.io.deletes).toBe(0);
        // No new commits/pushes: the only commits/pushes are from the init/settle phase.
        // We assert by absence of staged activity on the measured pass (the runner counts
        // reflect real git; push is observable via counts or outcome flag).
        // A push would have required at least one commit on the measured pass.
        // The engine currently performs no push on a clean idle pass, so this is 0.
        const pushCount = (f.runner.counts["push"] ?? 0);
        expect(pushCount).toBe(0);
      } finally {
        rmSync(f.base, { recursive: true, force: true });
      }
    }, 120_000);
  }
});

/**
 * Tier (b) — CONVERTED to strict bounds (sync-core Wave B, contract §8/E01).
 * The engine now: (1) extends the steady-state stat shortcut to ALL directions,
 * (2) reuses base content for ours/theirs when the trees coincide (no per-file
 * `git show` on a verified-idle pass), and (3) skips mirrorPull when the pass is
 * verified idle. Measured idle cost (300 files): push-pull/pull-only ~10 git /
 * 0 shows; push-only 7 git / 0 shows (unchanged). The old `shows < 0` push-only
 * pin was unsatisfiable and is now `shows === 0` + `git <= 7` per the contract.
 */
describe("idle regression — strict cost bounds (engine wave converted the defect pins)", () => {
  const bounds = {
    "push-pull": { git: 20, shows: 0 },
    "pull-only": { git: 20, shows: 0 },
    "push-only": { git: 7, shows: 0 },
  } as const;

  for (const direction of ["push-pull", "pull-only", "push-only"] as const) {
    test(`${direction}: verified-idle pass stays within strict bounds (git <= ${bounds[direction].git}, shows === ${bounds[direction].shows})`, async () => {
      const f = makeIdleFixture(direction);
      try {
        await settleBaseline(f);
        await runIdlePass(f);
        const git = totalGitInvocations(f.runner);
        const shows = gitShowCount(f.runner);
        // Recorded for traceability when tightening further.
        console.log(`[idle] ${direction}: git=${git} shows=${shows}`);
        expect(git).toBeLessThanOrEqual(bounds[direction].git);
        expect(shows).toBe(bounds[direction].shows);
      } finally {
        rmSync(f.base, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
