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
});
