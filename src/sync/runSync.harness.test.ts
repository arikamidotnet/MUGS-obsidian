/**
 * Standalone harness that replicates EXACTLY what MugsPlugin.runSync() does:
 *   1. buildProvider(settings) + ChildProcessRunner + store accessors
 *   2. syncAllMappings({ ...deps })
 * Drives REAL git against a local bare repo (no GitLab), so it isolates whether the
 * MUGS sync logic itself works end-to-end, independent of any backend-specific issue.
 *
 * Run: npx vitest run src/sync/runSync.harness.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor, storeHeldAccessor } from "./driver";
import { buildProvider } from "../providers/factory";
import { ChildProcessRunner } from "../git/runner";
import { MugsStore, MemoryIO } from "../store";
import { cloneDir, type VaultMirror } from "./cloneManager";
import { StoreDiffDataSource } from "../ui/defaultDataSources";
import type { FolderMapping, Credential, MugsSettings } from "../types";
import { installHermeticGitIdentity, hermeticExecSync } from "./testkit";

// Hermetic git: never depend on machine global identity.
installHermeticGitIdentity();
const REMOTE_PATH = join(tmpdir(), `mugs-harness-${process.pid}.git`);
const CLONE_ROOT = join(tmpdir(), `mugs-harness-clones-${process.pid}`);
let remoteWork: string;

/** Seed a bare repo with Notes/diary.md + README on main. */
function seedRemote(): void {
  rmSync(REMOTE_PATH, { recursive: true, force: true });
  remoteWork = join(tmpdir(), `mugs-harness-src-${process.pid}`);
  rmSync(remoteWork, { recursive: true, force: true });
  hermeticExecSync(`git init -q -b main "${remoteWork}"`);
  mkdirSync(join(remoteWork, "Notes"), { recursive: true });
  writeFileSync(join(remoteWork, "Notes", "diary.md"), "# Diary\n\nhello from remote\n");
  writeFileSync(join(remoteWork, "README.md"), "# readme\n");
  hermeticExecSync(`git -C "${remoteWork}" config user.name T && git -C "${remoteWork}" config user.email t@l`);
  hermeticExecSync(`git -C "${remoteWork}" add -A && git -C "${remoteWork}" commit -q -m init`);
  hermeticExecSync(`git clone -q --bare "${remoteWork}" "${REMOTE_PATH}"`);
  rmSync(remoteWork, { recursive: true, force: true });
}

const cred: Credential = { id: "cred-local", label: "Local", kind: "local", token: "local", baseUrl: `file://${REMOTE_PATH}` };

function mapping(): FolderMapping {
  return { id: "map-notes", label: "Notes", remotePath: "", localFolder: "Synced", providerId: "cred-local", direction: "push-pull" };
}

/** Build settings the way runSync() reads them from the store. */
function makeSettings(): MugsSettings {
  return {
    credentials: [cred],
    mappings: [mapping()],
    agents: [],
    sync: { intervalSeconds: 300, paused: false, obsidianConfig: null },
    lastSync: {},
    conflicts: {},
    staging: [],
  } as unknown as MugsSettings;
}

let store: MugsStore;

/** Real working-tree writer over the filesystem — mirrors exactly what main.ts wires
 *  from the vault adapter. In the new sync flow the writer is load-bearing (merged
 *  content materializes through it), so a no-op stub would test nothing. */
const workingTree = {
  writeFile: (p: string, c: string) => {
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    writeFileSync(p, c);
    return Promise.resolve();
  },
  readFile: (p: string) => Promise.resolve(existsSync(p) ? readFileSync(p, "utf8") : undefined),
  deleteFile: (p: string) => {
    if (existsSync(p)) unlinkSync(p);
    return Promise.resolve();
  },
};

beforeAll(() => {
  seedRemote();
  mkdirSync(CLONE_ROOT, { recursive: true });
    store = new MugsStore({ read: async () => ({}), write: async () => {} });
});

afterAll(() => {
  rmSync(REMOTE_PATH, { recursive: true, force: true });
  rmSync(CLONE_ROOT, { recursive: true, force: true });
});

describe("runSync harness — real git push+pull (no GitLab)", () => {
  it("clones the remote into the clone dir and reports ok", async () => {
    const settings = makeSettings();
    const outcomes = await syncAllMappings({
      mappings: settings.mappings,
      credentials: settings.credentials,
      getToken: (id) => store.getToken(id),
      buildProvider,
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      workingTree,
      conflicts: storeConflictAccessor(store),
      editorOpen: undefined as never,
      trash: undefined as never,
      heldPaths: storeHeldAccessor(store).heldPaths,
      pickAgent: (m) => m.agentId ? store.getAgents().find((a) => a.id === m.agentId) : undefined,
    });

    expect(outcomes.length).toBe(1);
    expect(outcomes[0].status, `skip reason: ${outcomes[0].reason}`).toBe("ok");
    // Clone dir should now contain the pulled files.
    const diary = join(CLONE_ROOT, "cred-local", "map-notes", "Notes", "diary.md");
    expect(require("node:fs").existsSync(diary)).toBe(true);
  });

  // Verified green under hermetic env: the SUT commit path inherits the hermetic
  // identity from process.env (GitClient.commit only overrides env when a committer
  // is supplied; local-provider committerFor returns undefined). The production
  // identity seam (git-runtime E07) should still be hardened so commits never
  // depend on ambient process env — but no test currently fails on it.
  it("pulls a NEW remote change into the clone dir (push-pull direction)", async () => {
    // Append a new commit to the bare repo directly.
    const tmp = join(tmpdir(), `mugs-harness-seed-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    hermeticExecSync(`git clone -q "${REMOTE_PATH}" "${tmp}"`);
    writeFileSync(join(tmp, "Notes", "diary.md"), "# Diary\n\nhello from remote\n+ second line pushed to remote\n");
    hermeticExecSync(`git -C "${tmp}" add -A && git -C "${tmp}" commit -q -m "add line"`);
    hermeticExecSync(`git -C "${tmp}" push -q origin main`);
    rmSync(tmp, { recursive: true, force: true });

    const settings = makeSettings();
    const outcomes = await syncAllMappings({
      mappings: settings.mappings,
      credentials: settings.credentials,
      getToken: (id) => store.getToken(id),
      buildProvider,
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      workingTree,
      conflicts: storeConflictAccessor(store),
      editorOpen: undefined as never,
      trash: undefined as never,
      heldPaths: storeHeldAccessor(store).heldPaths,
      pickAgent: (m) => m.agentId ? store.getAgents().find((a) => a.id === m.agentId) : undefined,
    });

    expect(outcomes[0].status, `skip reason: ${outcomes[0].reason}`).toBe("ok");
    const diary = join(CLONE_ROOT, "cred-local", "map-notes", "Notes", "diary.md");
    const content = require("node:fs").readFileSync(diary, "utf8");
    expect(content).toContain("+ second line pushed to remote");
  });

  it("pushes a NEW local change up to the bare repo (push-pull direction)", async () => {
    // Write + commit a new file in the clone dir's working tree. MUGS only pushes
    // committed unpushed work (localSha !== base), so we must commit before syncing.
    const targetDir = join(CLONE_ROOT, "cred-local", "map-notes", "Notes");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "local-note.md"), "# local note\ncreated from vault\n");
    hermeticExecSync(`git -C "${targetDir}" config user.name V && git -C "${targetDir}" config user.email v@l`);
    hermeticExecSync(`git -C "${targetDir}" add -A && git -C "${targetDir}" commit -q -m "add local note"`);

    const settings = makeSettings();
    const outcomes = await syncAllMappings({
      mappings: settings.mappings,
      credentials: settings.credentials,
      getToken: (id) => store.getToken(id),
      buildProvider,
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      workingTree,
      conflicts: storeConflictAccessor(store),
      editorOpen: undefined as never,
      trash: undefined as never,
      heldPaths: storeHeldAccessor(store).heldPaths,
      pickAgent: (m) => m.agentId ? store.getAgents().find((a) => a.id === m.agentId) : undefined,
    });

    expect(outcomes[0].status, `skip reason: ${outcomes[0].reason}`).toBe("ok");
    // Verify the push landed on the bare repo by cloning it fresh.
    const verify = join(tmpdir(), `mugs-harness-verify-${process.pid}`);
    rmSync(verify, { recursive: true, force: true });
    hermeticExecSync(`git clone -q "${REMOTE_PATH}" "${verify}"`);
    expect(require("node:fs").existsSync(join(verify, "Notes", "local-note.md"))).toBe(true);
    rmSync(verify, { recursive: true, force: true });
  });

  it("unreachable repo yields a skipped outcome (the silent-failure path)", async () => {
    // Point the mapping at a non-existent remote path to force a skip.
    const badCred: Credential = { id: "cred-bad", label: "Bad", kind: "local", token: "local", baseUrl: `file://${REMOTE_PATH}/does-not-exist.git` };
    const settings = makeSettings();
    (settings as unknown as { credentials: Credential[] }).credentials = [badCred];
    (settings.mappings[0] as FolderMapping).providerId = "cred-bad";

    // The driver is designed to SKIP (not throw) on an unreachable repo — that's the
    // silent-failure path. Assert we get a skipped outcome with a reason so runSync()
    // can surface it as a Notice instead of doing nothing.
    const outcomes = await syncAllMappings({
      mappings: settings.mappings,
      credentials: settings.credentials,
      getToken: (id) => store.getToken(id),
      buildProvider,
      cloneRoot: CLONE_ROOT,
      runner: new ChildProcessRunner(),
      lastSync: storeWritableAccessor(store),
      workingTree,
      conflicts: storeConflictAccessor(store),
      editorOpen: undefined as never,
      trash: undefined as never,
      heldPaths: storeHeldAccessor(store).heldPaths,
      pickAgent: (m) => m.agentId ? store.getAgents().find((a) => a.id === m.agentId) : undefined,
    });

    expect(outcomes.length).toBe(1);
    expect(outcomes[0].status).toBe("skipped");
    expect(String(outcomes[0].reason ?? "")).toMatch(/not accessible|could not reach|clone|error/i);
});
});
