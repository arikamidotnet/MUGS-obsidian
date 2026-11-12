/**
 * Real-git end-to-end tests for the local provider. Unlike driver.test.ts (which uses a
 * fake GitRunner), these drive the real ChildProcessRunner against real bare repos on disk,
 * so they prove `git clone`/`fetch`/`rebase`/`push` + the clone-dir layout actually work.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import { ChildProcessRunner } from "../git/runner";
import { MugsStore, MemoryIO } from "../store";
import type { VaultMirror } from "./cloneManager";
import { StoreDiffDataSource } from "../ui/defaultDataSources";
import type { FolderMapping, Credential } from "../types";
import { installHermeticGitIdentity, hermeticExecSync, expectedIdentityCloneDir, recordedCloneDir } from "./testkit";

// Ensure every manual git op and every SUT git op inherits a stable identity.
installHermeticGitIdentity();

const REMOTE_URL = "file://" + join(tmpdir(), "mugs-e2e-shared.git"); // clone SOURCE (as the driver's baseUrl)
const REMOTE_PATH = join(tmpdir(), "mugs-e2e-shared.git");             // plain bare-repo path for seeding
const CLONE_ROOT = join(tmpdir(), "mugs-e2e-clones");
let remoteWork: string;

/** Create a bare repo at REMOTE_PATH with Notes/diary.md line 3 == `line`, committed on main. */
function seedRemote(line: string): void {
  rmSync(REMOTE_PATH, { recursive: true, force: true });
  remoteWork = join(tmpdir(), "mugs-e2e-src");
  rmSync(remoteWork, { recursive: true, force: true });
  hermeticExecSync(`git init -q -b main "${remoteWork}"`);
  mkdirSync(join(remoteWork, "Notes"), { recursive: true });
  writeFileSync(join(remoteWork, "Notes", "diary.md"), `# Diary\n\n${line}\n`);
  writeFileSync(join(remoteWork, "README.md"), "# readme\n");
  hermeticExecSync(`git -C "${remoteWork}" config user.name T && git -C "${remoteWork}" config user.email t@l`);
  hermeticExecSync(`git -C "${remoteWork}" add -A && git -C "${remoteWork}" commit -q -m init`);
  hermeticExecSync(`git clone -q --bare "${remoteWork}" "${REMOTE_PATH}"`);
  rmSync(remoteWork, { recursive: true, force: true });
}

function localCred(): Credential {
  return { id: "cred-local-shared", label: "Local", kind: "local", token: "local", baseUrl: REMOTE_URL };
}
function mapping(over: Partial<FolderMapping> = {}): FolderMapping {
  return { id: "map-synced-notes", label: "Synced notes", remotePath: "", localFolder: "Synced", providerId: "cred-local-shared", direction: "push-pull", ...over };
}
/** S03 identity layout: the dir the engine clones into for the shared mapping
 *  (repoId = repoRef ?? repo.id = mapping.id; branch = "main"). Cross-checked
 *  against the engine-recorded cloneDir in the first-sync test. */
function clonePath(): string {
  return expectedIdentityCloneDir(CLONE_ROOT, { providerId: "cred-local-shared", repoId: "map-synced-notes", remoteUrl: REMOTE_PATH });
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

    // S03: the recorded cloneDir (UI resolution source) must match the identity layout.
    expect(recordedCloneDir(store, "map-synced-notes")).toBe(clonePath());
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
    hermeticExecSync(`git clone -q "${REMOTE_PATH}" "${scratch}"`);
    writeFileSync(join(scratch, "Notes", "diary.md"), "# Diary\n\nREMOTE EDIT by another device.\n");
    hermeticExecSync(`git -C "${scratch}" config user.name O && git -C "${scratch}" config user.email o@l`);
    hermeticExecSync(`git -C "${scratch}" add -A && git -C "${scratch}" commit -q -m "remote edit"`);
    hermeticExecSync(`git -C "${scratch}" push -q "${REMOTE_PATH}" main`);
    rmSync(scratch, { recursive: true, force: true });

    // The MUGS clone makes its own (overlapping) edit of line 3 and commits it locally.
    const cp = clonePath();
    writeFileSync(join(cp, "Notes", "diary.md"), "# Diary\n\nLOCAL EDIT by vault user.\n");
    hermeticExecSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
    hermeticExecSync(`git -C "${cp}" add -A && git -C "${cp}" commit -q -m "local edit"`);

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

    hermeticExecSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "diary.md"), "# Diary\n\nbase line\n");
    hermeticExecSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
    hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
    hermeticExecSync(`git clone -q --bare "${work}" "${remotePlain}"`);
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
    hermeticExecSync(`git clone -q "${remotePlain}" "${scratch}"`);
    writeFileSync(join(scratch, "Notes", "remote-addition.md"), "remote addition\n");
    hermeticExecSync(`git -C "${scratch}" config user.name O && git -C "${scratch}" config user.email o@l`);
    hermeticExecSync(`git -C "${scratch}" add -A && git -C "${scratch}" commit -q -m "remote addition"`);
    hermeticExecSync(`git -C "${scratch}" push -q "${remotePlain}" main`);
    rmSync(scratch, { recursive: true, force: true });

    // The MUGS clone commits its own non-overlapping new file -> histories diverge.
    const cp = expectedIdentityCloneDir(cloneRoot, { providerId: "cred-diverge", repoId: mappingId, remoteUrl: remotePlain });
    writeFileSync(join(cp, "Notes", "local-addition.md"), "local addition\n");
    hermeticExecSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
    hermeticExecSync(`git -C "${cp}" add -A && git -C "${cp}" commit -q -m "local addition"`);

    // Sync #2: the divergence resolves as a clean merge; the branch re-points at the
    // remote tip so the push fast-forwards. Before the fix, git rejected this push as
    // non-fast-forward (the merged content was committed on the old diverged HEAD).
    const outcomes = await syncAllMappings(deps());
    console.log("clean-divergence outcome:", JSON.stringify(outcomes[0]));
    expect(outcomes[0].status).toBe("ok");

    // The remote now carries BOTH sides' content, and nothing was lost.
    const check = join(base, "check");
    hermeticExecSync(`git clone -q "${remotePlain}" "${check}"`);
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
      hermeticExecSync(`git init -q -b main "${work}"`);
      mkdirSync(join(work, ".trash"), { recursive: true });
      mkdirSync(join(work, "notes"), { recursive: true });
      writeFileSync(join(work, ".trash", "old.md"), "# old trash\n");
      writeFileSync(join(work, "notes", "foo.md"), "# foo\n");
      hermeticExecSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
      hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
      hermeticExecSync(`git clone -q --bare "${work}" "${remotePlain}"`);
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
      const cp = expectedIdentityCloneDir(cloneRoot, { providerId: "cred-trash", repoId: mappingId, remoteUrl: remotePlain });
      writeFileSync(join(cp, "notes", "bar.md"), "# bar\n");
      hermeticExecSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
      hermeticExecSync(`git -C "${cp}" add notes/bar.md && git -C "${cp}" commit -q -m "add bar"`);
      writeFileSync(join(cp, ".trash", "old.md"), "# old trash MODIFIED\n"); // uncommitted

      // Sync #2 pushes; the gate decides whether the uncommitted .trash/ change leaves the machine.
      await syncAllMappings(deps());

      const check = join(base, "check.git");
      hermeticExecSync(`git clone -q "${remotePlain}" "${check}"`);
      expect(existsSync(join(check, "notes", "bar.md"))).toBe(true); // committed ordinary file always pushes
      const trashContent = readFileSync(join(check, ".trash", "old.md"), "utf8");
      expect(trashContent).toBe(syncTrashFolder ? "# old trash MODIFIED\n" : "# old trash\n");
      rmSync(check, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("vault mirror + first-sync direction — real git end-to-end", () => {
  /** A filesystem VaultMirror over a "vault" dir with a "Synced" folder, exactly the
   *  seam main.ts wires from the Obsidian vault adapter (text files only). */
  function fsVaultMirror(vaultRoot: string): VaultMirror {
    const folderPath = (rel: string) => join(vaultRoot, "Synced", rel);
    const walk = (dir: string, base = ""): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".")) continue; // dot-folders are excluded, like getFiles()
        const abs = join(dir, entry);
        const rel = base ? `${base}/${entry}` : entry;
        if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
        else out.push(rel);
      }
      return out;
    };
    return {
      // Like vault.getFiles(): a missing folder is an empty list, never a throw.
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
    };
  }

  /** Isolated fixture: bare remote (seeded by the caller) + empty clone root + vault dir. */
  function fixture(name: string): { base: string; remotePlain: string; cloneRoot: string; vaultRoot: string; syncedVault: string } {
    const base = join(tmpdir(), `mugs-e2e-${name}`);
    rmSync(base, { recursive: true, force: true });
    const out = {
      base,
      remotePlain: join(base, "remote.git"),
      cloneRoot: join(base, "clones"),
      vaultRoot: join(base, "vault"),
      get syncedVault() { return join(out.vaultRoot, "Synced"); },
    };
    mkdirSync(join(out.vaultRoot, "Synced"), { recursive: true });
    return out;
  }

  /** Commit a work dir's tree into a fresh bare remote on main. */
  function seedRemoteFrom(work: string, remotePlain: string): void {
    execSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
    execSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
    execSync(`git clone -q --bare "${work}" "${remotePlain}"`);
    rmSync(work, { recursive: true, force: true });
  }

  /** Deps for one sync pass over a folder mapping with the vault mirror wired. */
  const depsFor = (f: ReturnType<typeof fixture>, store: MugsStore, firstSync: "pull" | "push") => ({
    mappings: [{ id: "map-mirror", label: "Notes", remotePath: "", localFolder: "Synced", providerId: "cred-mirror", direction: "push-pull" as const }],
    credentials: [{ id: "cred-mirror", label: "Local", kind: "local" as const, token: "t", baseUrl: "file://" + f.remotePlain }],
    getToken: () => "t",
    buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
    cloneRoot: f.cloneRoot,
    runner: new ChildProcessRunner(),
    workingTree: {
      // Production parity: main.ts's writer creates parent folders (a --no-checkout
      // clone has no directories on disk until the mirror writes them).
      writeFile: (p: string, c: string) => {
        mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
        writeFileSync(p, c);
        return Promise.resolve();
      },
      readFile: (p: string) => Promise.resolve(existsSync(p) ? readFileSync(p, "utf8") : undefined),
      deleteFile: (p: string) => { if (existsSync(p)) unlinkSync(p); return Promise.resolve(); },
    },
    vaultMirror: fsVaultMirror(f.vaultRoot),
    rmDir: (d: string) => rmSync(d, { recursive: true, force: true }),
    firstSyncDirection: firstSync,
    lastSync: storeWritableAccessor(store),
    conflicts: storeConflictAccessor(store),
  });

  it("pull-first init populates the vault folder from the remote", async () => {
    const f = fixture("pull-init");
    const work = join(f.base, "work");
    execSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "diary.md"), "# Diary\n\nfrom remote\n");
    writeFileSync(join(work, "README.md"), "# readme\n");
    seedRemoteFrom(work, f.remotePlain);

    const store = new MugsStore(new MemoryIO());
    const outcomes = await syncAllMappings(depsFor(f, store, "pull"));
    expect(outcomes[0].status).toBe("ok");
    // The remote's whole tree landed under the vault's Synced folder.
    expect(readFileSync(join(f.syncedVault, "Notes", "diary.md"), "utf8")).toContain("from remote");
    expect(readFileSync(join(f.syncedVault, "README.md"), "utf8")).toContain("readme");
    rmSync(f.base, { recursive: true, force: true });
  });

  it("push-first init uploads the vault without downloading history; vault wins overlaps, remote-only files kept", async () => {
    const f = fixture("push-init");
    // Remote: a STALE version of diary.md plus a file the vault does not have.
    const work = join(f.base, "work");
    execSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "diary.md"), "# Diary\n\nSTALE remote content\n");
    writeFileSync(join(work, "Notes", "remote-only.md"), "remote only\n");
    seedRemoteFrom(work, f.remotePlain);

    // Vault: the up-to-date content the user wants to push.
    mkdirSync(join(f.syncedVault, "Notes"), { recursive: true });
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), "# Diary\n\nFRESH vault content\n");
    writeFileSync(join(f.syncedVault, "new-note.md"), "brand new from vault\n");

    const store = new MugsStore(new MemoryIO());
    const outcomes = await syncAllMappings(depsFor(f, store, "push"));
    expect(outcomes[0].status).toBe("ok");

    // The remote now carries the vault content (overlap wins) AND the remote-only file.
    const check = join(f.base, "check");
    execSync(`git clone -q "${f.remotePlain}" "${check}"`);
    expect(readFileSync(join(check, "Notes", "diary.md"), "utf8")).toContain("FRESH vault content");
    expect(readFileSync(join(check, "Notes", "remote-only.md"), "utf8")).toBe("remote only\n");
    expect(readFileSync(join(check, "new-note.md"), "utf8")).toBe("brand new from vault\n");
    // The push was additive: the vault folder was NOT populated with remote-only content.
    expect(existsSync(join(f.syncedVault, "Notes", "remote-only.md"))).toBe(false);

    // Sync #2 (baseline now recorded) runs the regular push-pull flow: the remote-only
    // file pulls down into the vault, and nothing conflicts.
    const outcomes2 = await syncAllMappings(depsFor(f, store, "push"));
    expect(outcomes2[0].status).toBe("ok");
    expect(readFileSync(join(f.syncedVault, "Notes", "remote-only.md"), "utf8")).toBe("remote only\n");
    rmSync(f.base, { recursive: true, force: true });
  });

  it("refuses a push-first init when the vault folder is empty (never wipes a populated remote)", async () => {
    const f = fixture("push-refuse");
    const work = join(f.base, "work");
    execSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "important.md"), "do not delete\n");
    seedRemoteFrom(work, f.remotePlain);
    // Vault Synced folder left empty.

    const store = new MugsStore(new MemoryIO());
    const outcomes = await syncAllMappings(depsFor(f, store, "push"));
    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[0].reason).toContain("first-sync push refused");
    // The remote was untouched.
    const check = join(f.base, "check");
    execSync(`git clone -q "${f.remotePlain}" "${check}"`);
    expect(readFileSync(join(check, "Notes", "important.md"), "utf8")).toBe("do not delete\n");
    rmSync(f.base, { recursive: true, force: true });
  });

  it("pushes a vault edit and pulls a remote edit on later syncs (both directions, no history loss)", async () => {
    const f = fixture("roundtrip");
    const work = join(f.base, "work");
    execSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "diary.md"), "# Diary\n\nbase\n");
    seedRemoteFrom(work, f.remotePlain);

    const store = new MugsStore(new MemoryIO());
    // Init: pull the base into the vault.
    await syncAllMappings(depsFor(f, store, "pull"));
    expect(readFileSync(join(f.syncedVault, "Notes", "diary.md"), "utf8")).toContain("base");

    // Vault edit (the normal user flow: edit a note in Obsidian).
    writeFileSync(join(f.syncedVault, "Notes", "diary.md"), "# Diary\n\nbase + vault edit\n");
    const o2 = await syncAllMappings(depsFor(f, store, "pull"));
    expect(o2[0].status).toBe("ok");

    // Another device edits a DIFFERENT file and pushes.
    const scratch = join(f.base, "scratch");
    execSync(`git clone -q "${f.remotePlain}" "${scratch}"`);
    writeFileSync(join(scratch, "Notes", "peer.md"), "from another device\n");
    execSync(`git -C "${scratch}" config user.name O && git -C "${scratch}" config user.email o@l`);
    execSync(`git -C "${scratch}" add -A && git -C "${scratch}" commit -q -m peer`);
    execSync(`git -C "${scratch}" push -q origin main`);
    rmSync(scratch, { recursive: true, force: true });

    // Sync #3: the vault keeps its edit AND receives the peer's file.
    const o3 = await syncAllMappings(depsFor(f, store, "pull"));
    expect(o3[0].status).toBe("ok");
    expect(readFileSync(join(f.syncedVault, "Notes", "diary.md"), "utf8")).toContain("base + vault edit");
    expect(readFileSync(join(f.syncedVault, "Notes", "peer.md"), "utf8")).toBe("from another device\n");

    // The remote carries the vault edit too.
    const check = join(f.base, "check");
    execSync(`git clone -q "${f.remotePlain}" "${check}"`);
    expect(readFileSync(join(check, "Notes", "diary.md"), "utf8")).toContain("base + vault edit");
    rmSync(f.base, { recursive: true, force: true });
  });
});

describe("sync then diff — real git verification", () => {
  it("after a successful sync the Diff data source reports identical with a baseline ref; an edit produces changed", async () => {
    // Isolated bare remote + clone root.
    const base = join(tmpdir(), "mugs-e2e-sync-diff");
    const remotePlain = join(base, "remote.git");
    const cloneRoot = join(base, "clones");
    const work = join(base, "work");
    rmSync(base, { recursive: true, force: true });

    execSync(`git init -q -b main "${work}"`);
    mkdirSync(join(work, "Notes"), { recursive: true });
    writeFileSync(join(work, "Notes", "diary.md"), "# Diary\n\nbase\n");
    execSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
    execSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
    execSync(`git clone -q --bare "${work}" "${remotePlain}"`);
    rmSync(work, { recursive: true, force: true });

    const cred: Credential = { id: "cred-sd", label: "Local", kind: "local", token: "t", baseUrl: "file://" + remotePlain };
    const mappingId = "map-sd";
    const mapping = { id: mappingId, label: "SD", remotePath: "", localFolder: "Synced", providerId: "cred-sd", direction: "push-pull" as const };

    const store = new MugsStore(new MemoryIO());
    await store.load();
    store.upsertMapping(mapping);
    const deps = () => ({
      mappings: [mapping],
      credentials: [cred],
      getToken: () => "t",
      buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
      cloneRoot,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      conflicts: storeConflictAccessor(store),
    });

    // First sync establishes the clone and records lastRemoteSha (baseline).
    const r1 = await syncAllMappings(deps());
    expect(r1[0].status).toBe("ok");
    expect(store.getSettings().lastSync[mappingId]?.lastRemoteSha).toBeTruthy();

    // Diff data source, wired exactly as main.ts does for the real UI.
    const diffDs = new StoreDiffDataSource(store, cloneRoot, new ChildProcessRunner());
    const d1 = await diffDs.getDiff({ mappingId });
    expect(d1.outcome).toBe("identical");
    expect(typeof d1.baseRef).toBe("string");
    expect((d1.baseRef ?? "").length).toBeGreaterThan(0);

    // Make a real commit in the clone (simulates local work since last sync).
    const cp = expectedIdentityCloneDir(cloneRoot, { providerId: "cred-sd", repoId: mappingId, remoteUrl: remotePlain });
    writeFileSync(join(cp, "Notes", "diary.md"), "# Diary\n\nbase\n\nEDIT\n");
    execSync(`git -C "${cp}" config user.name V && git -C "${cp}" config user.email v@l`);
    execSync(`git -C "${cp}" add -A && git -C "${cp}" commit -q -m edit`);

    // Sync pushes the change and advances the recorded baseline.
    const r2 = await syncAllMappings(deps());
    expect(r2[0].status).toBe("ok");

    // Against the new baseline the tree is again identical.
    const d2 = await diffDs.getDiff({ mappingId });
    expect(d2.outcome).toBe("identical");

    // Unsynced local change (new file) — diff vs recorded baseline must report changed + non-empty diffText.
    writeFileSync(join(cp, "Notes", "extra.md"), "new file\n");
    execSync(`git -C "${cp}" add -A && git -C "${cp}" commit -q -m "add-extra"`);
    const d3 = await diffDs.getDiff({ mappingId });
    expect(d3.outcome).toBe("changed");
    expect(d3.diffText.length).toBeGreaterThan(0);
    expect(d3.baseRef).toBeTruthy();

    rmSync(base, { recursive: true, force: true });
  });
});
