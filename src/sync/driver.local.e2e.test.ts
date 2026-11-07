/**
 * Real-git end-to-end tests for the local provider. Unlike driver.test.ts (which uses a
 * fake GitRunner), these drive the real ChildProcessRunner against real bare repos on disk,
 * so they prove `git clone`/`fetch`/`rebase`/`push` + the clone-dir layout actually work.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { ChildProcessRunner } from "../git/runner";
import { MugsStore, MemoryIO } from "../store";
import { cloneDir } from "./cloneManager";
import type { FolderMapping, Credential } from "../types";

const REMOTE_URL = "file://" + join(tmpdir(), "mugs-e2e-shared.git"); // clone SOURCE (as the driver's baseUrl)
const REMOTE_PATH = join(tmpdir(), "mugs-e2e-shared.git");             // plain bare-repo path for seeding
const CLONE_ROOT = join(tmpdir(), "mugs-e2e-clones");
let remoteWork: string;

/** Create a bare repo at REMOTE_PATH with Notes/diary.md line 3 == `line`, committed on main. */
function seedRemote(line: string): void {
  rmSync(REMOTE_PATH, { recursive: true, force: true });
  remoteWork = join(tmpdir(), "mugs-e2e-src");
  rmSync(remoteWork, { recursive: true, force: true });
  execSync(`git init -q -b main "${remoteWork}"`);
  mkdirSync(join(remoteWork, "Notes"), { recursive: true });
  writeFileSync(join(remoteWork, "Notes", "diary.md"), `# Diary\n\n${line}\n`);
  writeFileSync(join(remoteWork, "README.md"), "# readme\n");
  execSync(`git -C "${remoteWork}" config user.name T && git -C "${remoteWork}" config user.email t@l`);
  execSync(`git -C "${remoteWork}" add -A && git -C "${remoteWork}" commit -q -m init`);
  execSync(`git clone -q --bare "${remoteWork}" "${REMOTE_PATH}"`);
  rmSync(remoteWork, { recursive: true, force: true });
}

function localCred(): Credential {
  return { id: "cred-local-shared", label: "Local", kind: "local", token: "local", baseUrl: REMOTE_URL };
}
function mapping(over: Partial<FolderMapping> = {}): FolderMapping {
  return { id: "map-synced-notes", label: "Synced notes", remotePath: "", localFolder: "Synced", providerId: "cred-local-shared", direction: "push-pull", ...over };
}
function clonePath(): string {
  return cloneDir({ root: CLONE_ROOT }, "cred-local-shared", "map-synced-notes");
}

beforeAll(() => {
  rmSync(CLONE_ROOT, { recursive: true, force: true });
  seedRemote("base line");
});
afterAll(() => {
  rmSync(CLONE_ROOT, { recursive: true, force: true });
  rmSync(REMOTE_PATH, { recursive: true, force: true });
});

describe("local provider — real git end-to-end", () => {
  it("clones the bare remote and lands its files under .mugs-clones on first sync", async () => {
    const store = new MugsStore(new MemoryIO());
    await store.load();
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [localCred()],
      getToken: () => "local",
      buildProvider: () => ({ kind: "local", async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      conflicts: storeConflictAccessor(store),
    });

    const diary = join(clonePath(), "Notes", "diary.md");
    console.log("clonePath =", clonePath());
    console.log("remote tree:", execSync(`find "${REMOTE_PATH}" -maxdepth 3 2>/dev/null`).toString());
    console.log("clone root tree:", execSync(`find "${CLONE_ROOT}" 2>/dev/null`).toString());
    expect(existsSync(diary)).toBe(true);
    expect(readFileSync(diary, "utf8")).toContain("base line");
    // The clone really is a git work tree at the expected layout path.
    execSync(`git -C "${clonePath()}" rev-parse --is-inside-work-tree`);
    console.log("first-sync outcome:", JSON.stringify(outcomes[0]));
  });

  it("surfaces a conflict when local and remote edit the same line differently", async () => {
    seedRemote("base line");
    const store = new MugsStore(new MemoryIO());
    await store.load();

    // Sync #1: clone + record baseline.
    await syncAllMappings({
      mappings: [mapping()],
      credentials: [localCred()],
      getToken: () => "local",
      buildProvider: () => ({ kind: "local", async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      conflicts: storeConflictAccessor(store),
    });

    // Another device advances the remote with a different edit of line 3.
    const scratch = join(tmpdir(), "mugs-e2e-scratch");
    rmSync(scratch, { recursive: true, force: true });
    execSync(`git clone -q "${REMOTE_PATH}" "${scratch}"`);
    writeFileSync(join(scratch, "Notes", "diary.md"), "# Diary\n\nREMOTE EDIT by another device.\n");
    execSync(`git -C "${scratch}" config user.name O && git -C "${scratch}" config user.email o@l`);
    execSync(`git -C "${scratch}" add -A && git -C "${scratch}" commit -q -m "remote edit"`);
    execSync(`git -C "${scratch}" push -q "${REMOTE_PATH}" main`);
    rmSync(scratch, { recursive: true, force: true });

    // The MUGS clone makes its own (overlapping) edit of line 3 and commits it locally.
    const cp = clonePath();
    writeFileSync(join(cp, "Notes", "diary.md"), "# Diary\n\nLOCAL EDIT by vault user.\n");
    execSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
    execSync(`git -C "${cp}" add -A && git -C "${cp}" commit -q -m "local edit"`);

    // Sync #2: diverged pull should surface the overlapping file as a conflict.
    const outcomes = await syncAllMappings({
      mappings: [mapping()],
      credentials: [localCred()],
      getToken: () => "local",
      buildProvider: () => ({ kind: "local", async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      conflicts: storeConflictAccessor(store),
    });

    console.log("second-sync outcome:", JSON.stringify(outcomes[0]));
    expect(outcomes[0].status).toBe("conflict");
    expect(store.getConflicts("map-synced-notes").map((c) => c.path)).toContain("Notes/diary.md");
  });

  it("pushes a clean divergence by re-pointing the branch at the remote tip (fast-forward)", async () => {
    // Isolated bare remote + clone root so this scenario cannot interfere with the
    // shared fixtures above (and vice versa).
    const base = join(tmpdir(), "mugs-e2e-diverge");
    const remotePlain = join(base, "remote.git");
    const work = join(base, "work");
    const cloneRoot = join(base, "clones");
    rmSync(base, { recursive: true, force: true });

    execSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "diary.md"), "# Diary\n\nbase line\n");
    execSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
    execSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
    execSync(`git clone -q --bare "${work}" "${remotePlain}"`);
    rmSync(work, { recursive: true, force: true });

    const cred: Credential = { id: "cred-diverge", label: "Local", kind: "local", token: "t", baseUrl: "file://" + remotePlain };
    const mappingId = "map-diverge";
    const deps = () => ({
      mappings: [{ id: mappingId, label: "Notes", remotePath: "", localFolder: "Synced", providerId: "cred-diverge", direction: "push-pull" as const }],
      credentials: [cred],
      getToken: () => "t",
      buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
      cloneRoot,
      runner: new ChildProcessRunner(),
      // Production parity: main.ts always injects a working-tree writer so merged
      // content is materialized in the clone before the branch is re-pointed.
      workingTree: { writeFile: (p: string, c: string) => { writeFileSync(p, c); return Promise.resolve(); } },
      lastSync: storeWritableAccessor(new MugsStore(new MemoryIO())),
      conflicts: storeConflictAccessor(new MugsStore(new MemoryIO())),
    });

    // Sync #1: clone + record the baseline.
    await syncAllMappings(deps());

    // Another device advances the remote with a non-overlapping new file.
    const scratch = join(base, "scratch");
    execSync(`git clone -q "${remotePlain}" "${scratch}"`);
    writeFileSync(join(scratch, "Notes", "remote-addition.md"), "remote addition\n");
    execSync(`git -C "${scratch}" config user.name O && git -C "${scratch}" config user.email o@l`);
    execSync(`git -C "${scratch}" add -A && git -C "${scratch}" commit -q -m "remote addition"`);
    execSync(`git -C "${scratch}" push -q "${remotePlain}" main`);
    rmSync(scratch, { recursive: true, force: true });

    // The MUGS clone commits its own non-overlapping new file -> histories diverge.
    const cp = cloneDir({ root: cloneRoot }, "cred-diverge", mappingId);
    writeFileSync(join(cp, "Notes", "local-addition.md"), "local addition\n");
    execSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
    execSync(`git -C "${cp}" add -A && git -C "${cp}" commit -q -m "local addition"`);

    // Sync #2: the divergence resolves as a clean merge; the branch re-points at the
    // remote tip so the push fast-forwards. Before the fix, git rejected this push as
    // non-fast-forward (the merged content was committed on the old diverged HEAD).
    const outcomes = await syncAllMappings(deps());
    console.log("clean-divergence outcome:", JSON.stringify(outcomes[0]));
    expect(outcomes[0].status).toBe("ok");

    // The remote now carries BOTH sides' content, and nothing was lost.
    const check = join(base, "check");
    execSync(`git clone -q "${remotePlain}" "${check}"`);
    expect(readFileSync(join(check, "Notes", "remote-addition.md"), "utf8")).toBe("remote addition\n");
    expect(readFileSync(join(check, "Notes", "local-addition.md"), "utf8")).toBe("local addition\n");
    expect(readFileSync(join(check, "Notes", "diary.md"), "utf8")).toContain("base line");
    rmSync(base, { recursive: true, force: true });
  });

  it("excludes .trash/ from push when syncTrashFolder is false, includes it when true", async () => {
    // Isolated bare remote + clone root per scenario so the two gates don't interfere.
    for (const syncTrashFolder of [false, true]) {
      const base = join(tmpdir(), `mugs-e2e-trash-${syncTrashFolder}`);
      const remotePlain = join(base, "remote.git");
      const work = join(base, "work");
      const cloneRoot = join(base, "clones");
      rmSync(base, { recursive: true, force: true });

      // Seed a bare repo containing a .trash/ folder and an ordinary notes/ folder.
      execSync(`git init -q -b main "${work}"`);
      mkdirSync(join(work, ".trash"), { recursive: true });
      mkdirSync(join(work, "notes"), { recursive: true });
      writeFileSync(join(work, ".trash", "old.md"), "# old trash\n");
      writeFileSync(join(work, "notes", "foo.md"), "# foo\n");
      execSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
      execSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
      execSync(`git clone -q --bare "${work}" "${remotePlain}"`);
      rmSync(work, { recursive: true, force: true });

      const cred: Credential = { id: "cred-trash", label: "Local", kind: "local", token: "t", baseUrl: "file://" + remotePlain };
      const mappingId = `map-trash-${syncTrashFolder}`;
      const deps = () => ({
        mappings: [{ id: mappingId, label: "Whole", remotePath: "", localFolder: ".", providerId: "cred-trash", direction: "push-pull" as const, syncTrashFolder }],
        credentials: [cred],
        getToken: () => "t",
        buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
        cloneRoot,
        runner: new ChildProcessRunner(),
        lastSync: storeWritableAccessor(new MugsStore(new MemoryIO())),
        conflicts: storeConflictAccessor(new MugsStore(new MemoryIO())),
      });

      // Sync #1 lands the seeded tree in the clone; record baseline.
      await syncAllMappings(deps());

      // Local edits in the clone: commit an ordinary file (creating unpushed work that
      // enables a push) and leave an uncommitted modification of a tracked .trash/ file,
      // which is exactly what the inScope gate filters when staging on push.
      const cp = cloneDir({ root: cloneRoot }, "cred-trash", mappingId);
      writeFileSync(join(cp, "notes", "bar.md"), "# bar\n");
      execSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
      execSync(`git -C "${cp}" add notes/bar.md && git -C "${cp}" commit -q -m "add bar"`);
      writeFileSync(join(cp, ".trash", "old.md"), "# old trash MODIFIED\n"); // uncommitted

      // Sync #2 pushes; the gate decides whether the uncommitted .trash/ change leaves the machine.
      await syncAllMappings(deps());

      const check = join(base, "check.git");
      execSync(`git clone -q "${remotePlain}" "${check}"`);
      expect(existsSync(join(check, "notes", "bar.md"))).toBe(true); // committed ordinary file always pushes
      const trashContent = readFileSync(join(check, ".trash", "old.md"), "utf8");
      expect(trashContent).toBe(syncTrashFolder ? "# old trash MODIFIED\n" : "# old trash\n");
      rmSync(check, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
