/**
 * MUGS — release-readiness end-to-end battery (real git, disposable fixtures).
 *
 * These are the go/no-go gates from the release plan, run against real bare
 * repos and real filesystem vaults (never the live FBR-WRK vault):
 *  1. two-device push/pull convergence through the vault mirror
 *  2. manual conflict resolution -> next sync convergence (no resurfacing)
 *  3. vault deletion propagation + the coverage reconciliation gate
 *  4. restored-file detection (an old mtime must never hide new content)
 *  5. large-vault steady-state timing (the snapshot shortcut's payoff)
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { ChildProcessRunner } from "../git/runner";
import { MugsStore, MemoryIO } from "../store";
import type { VaultMirror, WorkingTreeWriter } from "./cloneManager";
import { resolveConflictFile } from "./conflict";
import type { FolderMapping, Credential } from "../types";
import { installHermeticGitIdentity, hermeticExecSync, expectedIdentityCloneDir, recordedCloneDir, CountingRunner } from "./testkit";
import { decideReviewBatch, reviewConfig } from "../runtime/reconciliationBulk";
import { MemoryTrashStore } from "./trash";

installHermeticGitIdentity();

/** Filesystem VaultMirror over <vaultRoot>/Synced — the seam main.ts wires, text only,
 *  including the stat seam the steady-state snapshot shortcut requires. */
function fsVaultMirror(vaultRoot: string): VaultMirror {
  const folderPath = (rel: string) => join(vaultRoot, "Synced", rel);
  const walk = (dir: string, base = ""): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const abs = join(dir, entry);
      const rel = base ? `${base}/${entry}` : entry;
      if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
      else out.push(rel);
    }
    return out;
  };
  return {
    list: async () => {
      const dir = join(vaultRoot, "Synced");
      return existsSync(dir) ? walk(dir) : [];
    },
    read: async (_folder, rel) => readFileSync(folderPath(rel), "utf8"),
    write: async (_folder, rel, content) => {
      const p = folderPath(rel);
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, content);
    },
    remove: async (_folder, rel) => {
      if (existsSync(folderPath(rel))) unlinkSync(folderPath(rel));
    },
    mtime: async (_folder, rel) => (existsSync(folderPath(rel)) ? statSync(folderPath(rel)).mtimeMs : undefined),
    stat: async (_folder, rel) =>
      existsSync(folderPath(rel)) ? { mtime: statSync(folderPath(rel)).mtimeMs, size: statSync(folderPath(rel)).size } : undefined,
  };
}

function makeFixture(name: string) {
  const base = join(mkdtempSync(join(tmpdir(), "mugs-rc-")), name);
  const remotePlain = join(base, "remote.git");
  const cloneRoot = join(base, "clones");
  const vaultRoot = join(base, "vault");
  const syncedVault = join(vaultRoot, "Synced");
  mkdirSync(syncedVault, { recursive: true });

  const cred: Credential = { id: "cred-rc", label: "Local", kind: "local", token: "t", baseUrl: "file://" + remotePlain };
  const mapping = (over: Partial<FolderMapping> = {}): FolderMapping => ({
    id: "map-rc", label: "RC", remotePath: "", localFolder: "Synced", providerId: "cred-rc", direction: "push-pull", ...over,
  });
  const workingTree: WorkingTreeWriter = {
    writeFile: (p, c) => {
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, c);
      return Promise.resolve();
    },
    readFile: (p) => Promise.resolve(existsSync(p) ? readFileSync(p, "utf8") : undefined),
    deleteFile: (p) => {
      if (existsSync(p)) unlinkSync(p);
      return Promise.resolve();
    },
  };
  const store = new MugsStore(new MemoryIO());
  const deps = (mappingOver: Partial<FolderMapping> = {}) => ({
    mappings: [mapping(mappingOver)],
    credentials: [cred],
    getToken: () => "t",
    buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
    cloneRoot,
    runner: new ChildProcessRunner(),
    workingTree,
    vaultMirror: fsVaultMirror(vaultRoot),
    rmDir: (d: string) => rmSync(d, { recursive: true, force: true }),
    lastSync: storeWritableAccessor(store),
    conflicts: storeConflictAccessor(store),
    policy: { autoMerge: false, defaultResolution: "both" as const, sameChangeAccept: true, recencyWins: false, paused: false, intervalSeconds: 300, firstSyncDirection: "pull" as const, obsidianConfig: { enabled: false, entries: [] } },
  });
  const seedRemote = (files: Record<string, string>): void => {
    const work = join(base, "work");
    rmSync(work, { recursive: true, force: true });
    for (const [p, c] of Object.entries(files)) {
      const abs = join(work, p);
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, c);
    }
    hermeticExecSync(`git init -q -b main "${work}"`);
    hermeticExecSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
    hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
    hermeticExecSync(`git clone -q --bare "${work}" "${remotePlain}"`);
    rmSync(work, { recursive: true, force: true });
  };
  /** A second device: clone, write files, commit, push. */
  const secondDevice = (files: Record<string, string>, message: string): void => {
    const scratch = join(base, "scratch");
    rmSync(scratch, { recursive: true, force: true });
    hermeticExecSync(`git clone -q "${remotePlain}" "${scratch}"`);
    for (const [p, c] of Object.entries(files)) {
      const abs = join(scratch, p);
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, c);
    }
    hermeticExecSync(`git -C "${scratch}" config user.name O && git -C "${scratch}" config user.email o@l`);
    hermeticExecSync(`git -C "${scratch}" add -A && git -C "${scratch}" commit -q -m "${message}"`);
    hermeticExecSync(`git -C "${scratch}" push -q "${remotePlain}" main`);
    rmSync(scratch, { recursive: true, force: true });
  };
  const remoteHas = (rel: string): string => {
    const check = join(base, "check");
    rmSync(check, { recursive: true, force: true });
    hermeticExecSync(`git clone -q "${remotePlain}" "${check}"`);
    return existsSync(join(check, rel)) ? readFileSync(join(check, rel), "utf8") : "";
  };
  return { base, remotePlain, cloneRoot, vaultRoot, syncedVault, cred, mapping, workingTree, store, deps, seedRemote, secondDevice, remoteHas, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("release readiness — real git end-to-end", () => {
  it.each(["delete", "recover"] as const)("bulk %s processes 30 reviewed paths in one engine pass", async action => {
    const f = makeFixture(`bulk-${action}`);
    try {
      const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`remote-${i}.md`, `remote text ${i}\n`]));
      f.seedRemote({ ...files, "keep.md": "local proof\n" });
      writeFileSync(join(f.syncedVault, "keep.md"), "local proof\n");
      const mapping = f.mapping({ direction: "push-only" });
      f.store.upsertCredential(f.cred);
      f.store.upsertMapping(mapping);
      const runner = new CountingRunner();
      const trash = new MemoryTrashStore();
      const deps = { ...f.deps({ direction: "push-only" }), runner, trash };
      deps.vaultMirror.exists = async (_folder, rel) => existsSync(join(f.syncedVault, rel));
      await syncAllMappings(deps);
      const state = f.store.getSettings().lastSync[mapping.id].reconciliation!;
      const rows = Object.entries(state.review).map(([path, entry]) => ({
        ...entry, path, fingerprint: state.fingerprint, direction: mapping.direction,
        mappingId: mapping.id, mappingLabel: mapping.label,
      }));
      expect(rows).toHaveLength(30);
      runner.reset();
      let passes = 0;
      const result = await decideReviewBatch({
        getSettings: () => f.store.getSettings(),
        setLastSync: state => f.store.setLastSync(state),
        save: () => f.store.save(),
        acquire: () => () => {},
        sync: async () => {
          passes++;
          const outcomes = await syncAllMappings(deps);
          expect(outcomes[0].status).toBe("ok");
          return (await f.store.save()).ok;
        },
        verify: async () => new Set(rows.filter(row => action === "recover"
          ? readFileSync(join(f.syncedVault, row.path), "utf8") === files[row.path]
          : hermeticExecSync(`git --git-dir="${f.remotePlain}" ls-tree --name-only HEAD -- "${row.path}"`).toString().trim() === "").map(row => row.path)),
      }, rows, action, reviewConfig(f.store.getSettings(), mapping.id));
      expect(passes).toBe(1);
      expect(result.persisted).toBe(true);
      expect(result.rows.every(row => row.status === "applied")).toBe(true);
      expect(runner.counts.fetch).toBe(1);
      expect(runner.counts.push ?? 0).toBe(action === "delete" ? 1 : 0);
      expect(trash.size).toBe(action === "delete" ? 30 : 0);
      for (const [path, content] of Object.entries(files)) {
        if (action === "delete") expect(trash.get(mapping.id, path)).toBe(content);
        else expect(readFileSync(join(f.syncedVault, path), "utf8")).toBe(content);
      }
      expect(f.store.getSettings().lastSync[mapping.id].reconciliation!.review).toEqual({});
      await syncAllMappings(deps);
      expect(f.remoteHas("keep.md")).toBe("local proof\n");
      expect(f.remoteHas("remote-0.md")).toBe(action === "delete" ? "" : files["remote-0.md"]);
    } finally { f.cleanup(); }
  }, 120_000);

  it.each(["push-only", "pull-only", "push-pull"] as const)(
    "%s: a 250-file idle pass reads no content and does not rewrite, commit or push",
    async (direction) => {
      const f = makeFixture(`idle-${direction}`);
      try {
        const files = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`note-${i}.md`, `note ${i}\n`]));
        f.seedRemote(files);
        const deps = f.deps({ direction });
        const mirror = deps.vaultMirror;
        const runner = new CountingRunner();
        let reads = 0, writes = 0;
        const measured = {
          ...deps, runner,
          vaultMirror: { ...mirror,
            read: async (folder: string, path: string) => { reads++; return mirror.read(folder, path); },
            write: async (folder: string, path: string, text: string) => { writes++; return mirror.write(folder, path, text); },
          },
        };
        // Push-only never imports repository content automatically.
        if (direction === "push-only") {
          for (const [path, text] of Object.entries(files)) writeFileSync(join(f.syncedVault, path), text);
        }
        await syncAllMappings(measured);
        await syncAllMappings(measured); // record post-import stat pairs
        runner.reset(); reads = writes = 0;
        const start = Date.now();
        const idle = await syncAllMappings(measured);
        expect(idle[0].status).toBe("ok");
        expect(reads).toBe(0);
        expect(writes).toBe(0);
        for (const verb of ["show", "add", "commit", "commit-tree", "push"]) expect(runner.counts[verb] ?? 0).toBe(0);
        console.log(`[idle-${direction}] files=250 reads=${reads} writes=${writes} elapsed=${Date.now() - start}ms`);
        if (direction !== "pull-only") {
          writeFileSync(join(f.syncedVault, "note-0.md"), "one changed note\n");
          runner.reset(); reads = writes = 0;
          const edited = await syncAllMappings(measured);
          expect(edited[0].status).toBe("ok");
          expect(edited[0].push).toBe(true);
          expect(reads).toBeLessThanOrEqual(5);
          expect(writes).toBe(0); // local content is already in the vault
          expect(f.remoteHas("note-0.md")).toBe("one changed note\n");
          console.log(`[one-edit-${direction}] files=250 reads=${reads} writes=${writes}`);
        }
      } finally { f.cleanup(); }
    }, 120_000,
  );
  it("converges two devices through the vault mirror without content loss", async () => {
    const f = makeFixture("two-device");
    f.seedRemote({ "Notes/diary.md": "# Diary\n\nbase\n" });

    // Device A: init (pull) then a vault edit -> sync pushes it.
    await syncAllMappings(f.deps());
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), "# Diary\n\nbase\n\nEDIT from device A\n");
    const outA = await syncAllMappings(f.deps());
    expect(outA[0].status).toBe("ok");
    expect(f.remoteHas("Notes/diary.md")).toContain("EDIT from device A");

    // Device B pushes a NON-overlapping new file.
    f.secondDevice({ "Notes/from-b.md": "added on device B\n" }, "device b");
    const outB = await syncAllMappings(f.deps());
    expect(outB[0].status).toBe("ok");
    // Device A's vault received B's file; the remote received A's earlier edit.
    expect(readFileSync(join(f.syncedVault, "Notes", "from-b.md"), "utf8")).toBe("added on device B\n");
    expect(f.remoteHas("Notes/diary.md")).toContain("EDIT from device A");
    f.cleanup();
  });

  it("requires a fresh decision when the remote changes after manual resolution", async () => {
    const f = makeFixture("stale-resolution");
    try {
      f.seedRemote({ "note.md": "base\n" });
      await syncAllMappings(f.deps());
      f.secondDevice({ "note.md": "remote reviewed\n" }, "reviewed edit");
      writeFileSync(join(f.syncedVault, "note.md"), "local winner\n");
      expect((await syncAllMappings(f.deps()))[0].status).toBe("conflict");
      f.store.setConflicts("map-rc", f.store.getConflicts("map-rc").map(c => ({
        ...c, resolved: true, resolvedContent: "local winner\n",
      })));
      f.secondDevice({ "note.md": "new remote edit\n" }, "remote moved after review");
      expect((await syncAllMappings(f.deps()))[0].status).toBe("conflict");
      expect(f.remoteHas("note.md")).toBe("new remote edit\n");
      expect(readFileSync(join(f.syncedVault, "note.md"), "utf8")).toBe("local winner\n");
      expect(f.store.getConflicts("map-rc")[0].resolved).not.toBe(true);
    } finally { f.cleanup(); }
  });

  it("manual conflict resolution converges: vault + clone written, next sync does not resurface it", async () => {
    const f = makeFixture("resolve-converge");
    f.seedRemote({ "Notes/diary.md": "# Diary\n\nbase line\n" });
    await syncAllMappings(f.deps());

    // Both sides edit the SAME line differently -> genuine conflict on the next pass.
    f.secondDevice({ "Notes/diary.md": "# Diary\n\nREMOTE EDIT\n" }, "remote edit");
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), "# Diary\n\nLOCAL EDIT\n");
    const outConflict = await syncAllMappings(f.deps());
    expect(outConflict[0].status).toBe("conflict");

    // Resolve through the production store path: pick "theirs" (the second device's
    // content) — the UI now writes BOTH the clone and the vault, then clears the record.
    const conflicts = f.store.getConflicts("map-rc");
    expect(conflicts.map((c) => c.path)).toContain("Notes/diary.md");
    const next = resolveConflictFile(conflicts, "Notes/diary.md", "theirs")!;
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), next.resolvedContent);
    // S03: resolve the clone via the engine-recorded dir (identity layout), never a hardcoded path.
    const cp = recordedCloneDir(f.store, "map-rc") ?? expectedIdentityCloneDir(f.cloneRoot, { providerId: "cred-rc", repoId: "map-rc", remoteUrl: f.remotePlain });
    writeFileSync(join(cp, "Notes", "diary.md"), next.resolvedContent);
    f.store.setConflicts("map-rc", next.conflicts);

    // Sync: the resolution pushes; the remote converges; nothing re-conflicts.
    const outOk = await syncAllMappings(f.deps());
    expect(outOk[0].status).toBe("ok");
    expect(f.remoteHas("Notes/diary.md")).toBe("# Diary\n\nREMOTE EDIT\n");
    // A follow-up pass stays clean (the old bug re-surfaced the same conflict forever).
    const outAgain = await syncAllMappings(f.deps());
    expect(outAgain[0].status).toBe("ok");
    expect(f.store.getConflicts("map-rc")).toEqual([]);
    f.cleanup();
  });

  it.each(["ours", "both"] as const)("an explicit %s resolution publishes the chosen winner and converges", async (choice) => {
    const f = makeFixture(`resolve-${choice}`);
    f.seedRemote({ "Notes/diary.md": "# Diary\n\nbase line\n" });
    await syncAllMappings(f.deps());

    // Both sides edit the SAME line differently -> genuine conflict.
    f.secondDevice({ "Notes/diary.md": "# Diary\n\nREMOTE EDIT\n" }, "remote edit");
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), "# Diary\n\nLOCAL EDIT\n");
    const outConflict = await syncAllMappings(f.deps());
    expect(outConflict[0].status).toBe("conflict");

    // Resolve the choice the way the production transaction does: write the winner
    // into vault + clone AND keep the record marked resolved as engine evidence —
    // dropping it left the winner unpublishable (the pass re-conflicted forever).
    const conflicts = f.store.getConflicts("map-rc");
    expect(conflicts.map((c) => c.path)).toContain("Notes/diary.md");
    const winner = choice === "ours" ? "# Diary\n\nLOCAL EDIT\n" : "# Diary\n\nLOCAL EDIT\n\n# Diary\n\nREMOTE EDIT\n";
    const cp = recordedCloneDir(f.store, "map-rc") ?? expectedIdentityCloneDir(f.cloneRoot, { providerId: "cred-rc", repoId: "map-rc", remoteUrl: f.remotePlain });
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), winner);
    writeFileSync(join(cp, "Notes", "diary.md"), winner);
    f.store.setConflicts(
      "map-rc",
      conflicts.map((c) => (c.path === "Notes/diary.md" ? { ...c, resolved: true, resolvedContent: winner } : c)),
    );
    // A further local edit AFTER the decision is the newest local intent: the
    // evidence binds the reviewed remote bytes, not the exact local bytes (a
    // stamping/linter plugin may rewrite the file right after the resolution).
    const newest = winner + "plus a later edit\n";
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), newest);

    // The next pass publishes the local content instead of re-conflicting it.
    const outOk = await syncAllMappings(f.deps());
    expect(outOk[0].status).toBe("ok");
    expect(outOk[0].push).toBe(true);
    expect(f.remoteHas("Notes/diary.md")).toBe(newest);
    // A follow-up pass stays clean and the evidence record is gone.
    const outAgain = await syncAllMappings(f.deps());
    expect(outAgain[0].status).toBe("ok");
    expect(f.store.getConflicts("map-rc")).toEqual([]);
    f.cleanup();
  });

  it("propagates a vault deletion to the remote once correspondence is proven", async () => {
    const f = makeFixture("delete-propagation");
    f.seedRemote({ "Notes/keep.md": "keep\n", "Notes/gone.md": "this file gets deleted\n" });

    // Init populates the vault (mirror-pull) -> vaultPopulated is recorded.
    await syncAllMappings(f.deps());
    expect(existsSync(join(f.syncedVault, "Notes", "gone.md"))).toBe(true);
    expect(f.store.getSettings().lastSync["map-rc"]?.vaultPopulated).toBe(true);

    // The user deletes a note in Obsidian; the next sync must push the deletion.
    unlinkSync(join(f.syncedVault, "Notes", "gone.md"));
    const out = await syncAllMappings(f.deps());
    expect(out[0].status).toBe("ok");
    expect(f.remoteHas("Notes/gone.md")).toBe(""); // deleted on the remote
    expect(f.remoteHas("Notes/keep.md")).toBe("keep\n"); // untouched file survives
    expect(existsSync(join(f.syncedVault, "Notes", "gone.md"))).toBe(false);
    const again = await syncAllMappings(f.deps());
    expect(again[0].status).toBe("ok");
    expect(f.remoteHas("Notes/gone.md")).toBe("");
    expect(existsSync(join(f.syncedVault, "Notes", "gone.md"))).toBe(false);
    f.cleanup();
  });

  it("detects a restored file whose old mtime would fool an mtime-only shortcut", async () => {
    const f = makeFixture("restored-file");
    f.seedRemote({ "Notes/a.md": "v1\n" });
    // The VAULT holds the same content (the remote was seeded with the same tree) —
    // the snapshot is keyed on vault files, so the fixture must have one.
    mkdirSync(join(f.syncedVault, "Notes"), { recursive: true });
    writeFileSync(join(f.syncedVault, "Notes", "a.md"), "v1\n");

    // Push-only mapping: init uploads the vault; the pass records the content snapshot.
    await syncAllMappings(f.deps({ direction: "push-only" }));
    const snapshot = f.store.getSettings().lastSync["map-rc"]?.contentSnapshot;
    expect(snapshot && Object.keys(snapshot).length > 0).toBe(true);

    // "Restore from backup": change content but backdate the mtime to before the
    // last pass. An mtime-only shortcut would skip this file as unchanged.
    const target = join(f.syncedVault, "Notes", "a.md");
    writeFileSync(target, "v2 RESTORED\n");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(target, old, old);

    const out = await syncAllMappings(f.deps({ direction: "push-only" }));
    expect(out[0].status).toBe("ok");
    expect(f.remoteHas("Notes/a.md")).toBe("v2 RESTORED\n"); // content change detected
    f.cleanup();
  });

  it("steady-state snapshot shortcut collapses a 1,500-file idle pass (and never skips changes)", async () => {
    const f = makeFixture("perf");
    // Vault: 1,500 small files; remote starts EMPTY (push-only first sync uploads them).
    for (let i = 0; i < 1500; i++) {
      writeFileSync(join(f.syncedVault, `note-${String(i).padStart(4, "0")}.md`), `# note ${i}\n\nlorem ipsum content\n`);
    }
    f.seedRemote({ "README.md": "seed\n" });

    const timing = async (): Promise<number> => {
      const t0 = Date.now();
      const out = await syncAllMappings(f.deps({ direction: "push-only" }));
      expect(out[0].status).toBe("ok");
      return Date.now() - t0;
    };
    // Pass 1 = the real work: blobless clone + 1,500-file read/merge/add/commit/push.
    // Pass 2+ = steady state: the snapshot says every file is unchanged, so the pass
    // reads NO content at all (fingerprint scan only) and collapses to seconds.
    const initMs = await timing();
    const idleMs = await timing();

    // The snapshot was recorded and the idle pass collapsed to a small fraction of
    // the init pass (generous margin so slow CI cannot flake).
    const snapshot = f.store.getSettings().lastSync["map-rc"]?.contentSnapshot;
    expect(snapshot && Object.keys(snapshot).length).toBe(1500);
    expect(idleMs).toBeLessThan(Math.max(initMs / 2, initMs - 1500));

    // A REAL edit (even with an old-looking mtime) must still push: the shortcut
    // never hides content changes.
    writeFileSync(join(f.syncedVault, "note-0000.md"), "# note 0 CHANGED\n");
    const out = await syncAllMappings(f.deps({ direction: "push-only" }));
    expect(out[0].status).toBe("ok");
    expect(f.remoteHas("note-0000.md")).toBe("# note 0 CHANGED\n");
    console.log(`[perf] init=${initMs}ms idle=${idleMs}ms`);
    f.cleanup();
  }, 300_000);
});
