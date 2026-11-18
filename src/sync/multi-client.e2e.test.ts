/**
 * Multi-client soak (release gate): two independent clients — each with its own
 * store, clone and vault folder — sync one shared bare remote through the real
 * driver + real git. Proves the multi-user behaviors a company rollout depends
 * on, with NO Obsidian and no network (file:// remote):
 * - first-sync pull populates both clients from the same seed
 * - distinct edits on each client converge on both sides
 * - non-overlapping edits to one file merge automatically (three-way)
 * - same-region edits are a GENUINE conflict: auto-resolved to the clearly
 *   newer side when recency-wins is confident, otherwise surfaced for review —
 *   each client keeps its own bytes when not confident, the conflict is
 *   recorded, nothing is published over the other side, and a user-style
 *   resolution converges both
 * - a deletion on one client propagates to the other
 * - a fully converged pass is a verified idle no-op (no new commits)
 * - with automatic resolution OFF, the same conflict surfaces identically — the
 *   autoMerge flag never changes what is lost (nothing) or surfaced (both sides)
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { syncAllMappings, storeConflictAccessor, storeWritableAccessor, type SyncOutcome } from "./driver";
import { MugsStore, MemoryIO } from "../store";
import { ChildProcessRunner } from "../git/runner";
import type { VaultMirror, WorkingTreeWriter } from "./cloneManager";
import type { Credential, FolderMapping, SyncPolicy } from "../types";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "MUGS Soak", GIT_AUTHOR_EMAIL: "mugs-soak@example.invalid",
      GIT_COMMITTER_NAME: "MUGS Soak", GIT_COMMITTER_EMAIL: "mugs-soak@example.invalid",
    },
  }).trim();

interface Client {
  vault: string;
  store: MugsStore;
  sync: () => Promise<SyncOutcome[]>;
  read: (name: string) => string;
  write: (name: string, content: string) => void;
}

/** Build one independent client: its own vault folder, store, clone root and mirror. */
function makeClient(base: string, name: string, remote: string, policy: Partial<SyncPolicy>): Client {
  const vault = join(base, `vault-${name}`);
  const cloneRoot = join(base, `clones-${name}`);
  mkdirSync(vault);
  const list = (): string[] =>
    existsSync(vault) ? readdirSync(vault).filter(f => f.endsWith(".md")) : [];
  const path = (name2: string) => join(vault, name2);
  const mirror: VaultMirror = {
    list: async () => list(),
    read: async (_f, n) => readFileSync(path(n), "utf8"),
    write: async (_f, n, content) => { writeFileSync(path(n), content); },
    remove: async (_f, n) => { unlinkSync(path(n)); },
    exists: async (_f, n) => existsSync(path(n)),
    mtime: async (_f, n) => (existsSync(path(n)) ? statSync(path(n)).mtimeMs : undefined),
    stat: async (_f, n) => (existsSync(path(n)) ? { mtime: statSync(path(n)).mtimeMs, size: statSync(path(n)).size } : undefined),
    listable: n => n.endsWith(".md"),
  };
  const writer: WorkingTreeWriter = {
    writeFile: async (abs, content) => { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); },
    readFile: async abs => (existsSync(abs) ? readFileSync(abs, "utf8") : undefined),
    deleteFile: async abs => { if (existsSync(abs)) unlinkSync(abs); },
  };
  const mapping: FolderMapping = { id: "soak", label: `Soak ${name}`, localFolder: "notes", remotePath: "", direction: "push-pull", providerId: "soak-local" };
  const credential: Credential = { id: "soak-local", label: "Soak local", kind: "local", token: "", baseUrl: `file://${remote}` };
  const store = new MugsStore(new MemoryIO());
  const sync = async () => syncAllMappings({
    mappings: [mapping], credentials: [credential], getToken: () => "",
    buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
    cloneRoot, runner: new ChildProcessRunner(), workingTree: writer, vaultMirror: mirror,
    lastSync: storeWritableAccessor(store), conflicts: storeConflictAccessor(store),
    policy: {
      autoMerge: true, defaultResolution: "both" as const, sameChangeAccept: true, recencyWins: false,
      paused: false, intervalSeconds: 300, firstSyncDirection: "pull" as const,
      obsidianConfig: { enabled: false, entries: [] }, ...policy,
    },
  });
  return { vault, store, sync, read: n => readFileSync(path(n), "utf8"), write: (n, c) => writeFileSync(path(n), c) };
}

/** Fresh shared remote seeded with one base file, plus two clients. */
function setup(policy: Partial<SyncPolicy> = {}): { base: string; remote: string; a: Client; b: Client } {
  const base = mkdtempSync(join(tmpdir(), "mugs-soak-"));
  const remote = join(base, "remote.git");
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "base.md"), "alpha\nbravo\ncharlie\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(base, "clone", "-q", "--bare", seed, remote);
  return { base, remote, a: makeClient(base, "a", remote, policy), b: makeClient(base, "b", remote, policy) };
}

describe("multi-client soak — two real clients through one shared git remote", () => {
  it("converges automatically: distinct and non-overlapping edits merge, same-region edits keep both sides, deletions propagate, converged passes are idle", async () => {
    const { base, remote, a, b } = setup();
    try {
      // First sync: both clients pull the same seed.
      expect((await a.sync())[0].status).toBe("ok");
      expect((await b.sync())[0].status).toBe("ok");
      expect(a.read("base.md")).toBe("alpha\nbravo\ncharlie\n");
      expect(b.read("base.md")).toBe("alpha\nbravo\ncharlie\n");

      // Distinct new files on each client appear on the other.
      a.write("a-note.md", "from A\n");
      b.write("b-note.md", "from B\n");
      await a.sync(); await b.sync(); await a.sync();
      expect(existsSync(join(b.vault, "a-note.md"))).toBe(true);
      expect(existsSync(join(a.vault, "b-note.md"))).toBe(true);

      // Non-overlapping edits to the same file: automatic three-way merge.
      a.write("base.md", "ALPHA-A\nbravo\ncharlie\n");
      b.write("base.md", "alpha\nbravo\nCHARLIE-B\n");
      await a.sync(); await b.sync(); await a.sync();
      const merged = a.read("base.md");
      expect(merged).toBe(b.read("base.md"));
      expect(merged).toContain("ALPHA-A");
      expect(merged).toContain("bravo");
      expect(merged).toContain("CHARLIE-B");

      // Same-region edits from the same base are a GENUINE conflict. This soak
      // runs with recency-wins OFF (the default here), so the engine is not
      // confident and surfaces the conflict for review rather than auto-resolving
      // it. Neither side loses bytes: A keeps BRAVO-A, B keeps BRAVO-B, B
      // publishes nothing over A, and the conflict is recorded in B's store so
      // the Conflicts panel can offer one-click resolution.
      a.write("base.md", merged.replace("bravo", "BRAVO-A"));
      b.write("base.md", merged.replace("bravo", "BRAVO-B"));
      expect((await a.sync())[0].status).toBe("ok"); // A publishes its side
      const conflicted = await b.sync();
      expect(conflicted[0].status).toBe("conflict");
      expect(a.read("base.md")).toContain("BRAVO-A");
      expect(b.read("base.md")).toContain("BRAVO-B");
      expect(b.read("base.md")).not.toContain("BRAVO-A");
      expect(b.store.getConflicts("soak").some(c => c.path === "base.md")).toBe(true);

      // One-click resolution (the Conflicts panel's real flow, S07): the chosen
      // content is written to the vault AND the conflict is marked resolved with
      // its content — the next pass publishes it as an ours-only change against
      // the same remote bytes, then every client converges on it.
      const both = merged.replace("bravo", "BRAVO-A\nBRAVO-B");
      b.write("base.md", both);
      b.store.setConflicts("soak", b.store.getConflicts("soak")
        .map(c => c.path === "base.md" ? { ...c, resolved: true, resolvedContent: both } : c));
      expect((await b.sync())[0].status).toBe("ok");
      await a.sync();
      const settled = a.read("base.md");
      expect(settled).toContain("BRAVO-A");
      expect(settled).toContain("BRAVO-B");
      expect(b.read("base.md")).toBe(settled);

      // A deletion on one client reaches the other.
      unlinkSync(join(b.vault, "a-note.md"));
      await b.sync(); await a.sync();
      expect(existsSync(join(a.vault, "a-note.md"))).toBe(false);
      expect(existsSync(join(b.vault, "a-note.md"))).toBe(false);

      // Fully converged: the next pass is a verified idle no-op — no new commit.
      const headBefore = git(base, "--git-dir", remote, "rev-parse", "HEAD");
      const idle = await a.sync();
      expect(idle[0].status).toBe("ok");
      expect(idle[0].kind).toBe("idle");
      expect(git(base, "--git-dir", remote, "rev-parse", "HEAD")).toBe(headBefore);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it("with automatic resolution off, a same-region conflict is surfaced with both sides intact and no local file clobbered", async () => {
    const { base, a, b } = setup({ autoMerge: false, defaultResolution: "both", sameChangeAccept: false });
    try {
      await a.sync(); await b.sync();
      a.write("base.md", "alpha\nBRAVO-A\ncharlie\n");
      b.write("base.md", "alpha\nBRAVO-B\ncharlie\n");
      await a.sync(); // A publishes its side first.
      const outcomes = await b.sync(); // B now genuinely conflicts.
      expect(outcomes[0].status).toBe("conflict");
      const recorded = outcomes[0].conflicts ?? [];
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded[0].ours).toContain("BRAVO-B");
      expect(recorded[0].theirs).toContain("BRAVO-A");
      // Persisted for review across sessions; neither vault file was overwritten.
      expect(b.store.getConflicts("soak").some(c => c.path === recorded[0].path)).toBe(true);
      expect(a.read("base.md")).toContain("BRAVO-A");
      expect(b.read("base.md")).toContain("BRAVO-B");
      expect(b.read("base.md")).not.toContain("BRAVO-A");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);

  it("with recency-wins on, a same-region conflict auto-resolves to the clearly newer side and both clients converge", async () => {
    const { base, a, b } = setup({ recencyWins: true });
    try {
      await a.sync(); await b.sync();
      a.write("base.md", "alpha\nBRAVO-A\ncharlie\n");
      await a.sync(); // A publishes its side; the remote commit is now the "theirs" baseline.
      b.write("base.md", "alpha\nBRAVO-B\ncharlie\n");
      // Make B's save clearly newer than A's commit (beyond the 5s near-equal margin)
      // by stamping B's file mtime ahead of the commit time. The recency inputs are a
      // real fs mtime and a real git commit time, so fake timers can't drive them —
      // utimesSync sets the mtime directly, deterministically, with no real wait.
      utimesSync(join(b.vault, "base.md"), 0, Date.now() / 1000 + 60);
      const outcomes = await b.sync();
      // B's save is clearly newer than A's commit -> auto-resolved to B's side, no
      // conflict surfaced, and the winner is published.
      expect(outcomes[0].status).toBe("ok");
      expect(b.store.getConflicts("soak")).toEqual([]);
      expect(b.read("base.md")).toContain("BRAVO-B");
      expect(b.read("base.md")).not.toContain("BRAVO-A");
      // A's next pass pulls the winner (A's side is unchanged vs its base) and converges.
      await a.sync();
      expect(a.read("base.md")).toBe(b.read("base.md"));
      expect(a.read("base.md")).toContain("BRAVO-B");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);
});
