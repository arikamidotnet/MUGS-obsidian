/** Opt-in real-vault canary; never uses the vault's configured mappings or clones.
 *  Hermetic in CI: skipped unless BOTH MUGS_FBR_CANARY=1 and MUGS_FBR_VAULT (the
 *  absolute path of the vault to exercise) are set, so no operator path ships
 *  in the public source. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { syncAllMappings, storeConflictAccessor, storeWritableAccessor } from "./driver";
import { MugsStore, MemoryIO } from "../store";
import { ChildProcessRunner } from "../git/runner";
import type { VaultMirror, WorkingTreeWriter } from "./cloneManager";
import type { Credential, FolderMapping } from "../types";

const VAULT = process.env.MUGS_FBR_VAULT ?? "";

describe.skipIf(process.env.MUGS_FBR_CANARY !== "1" || !VAULT)("isolated real-vault canary", () => {
  it("pushes and pulls synthetic text in the actual vault without touching company mappings", async () => {
    const base = mkdtempSync(join(tmpdir(), "mugs-fbr-canary-"));
    const folder = `MUGS-canary-${process.pid}-${Date.now()}`;
    const vaultFolder = join(VAULT, folder);
    const remote = join(base, "remote.git");
    const seed = join(base, "seed");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "MUGS Canary", GIT_AUTHOR_EMAIL: "mugs-canary@example.invalid", GIT_COMMITTER_NAME: "MUGS Canary", GIT_COMMITTER_EMAIL: "mugs-canary@example.invalid" },
    }).trim();
    const list = (): string[] => existsSync(vaultFolder) ? readdirSync(vaultFolder).filter(name => name.endsWith(".md")) : [];
    const path = (name: string) => join(vaultFolder, name);
    const mirror: VaultMirror = {
      list: async () => list(),
      read: async (_folder, name) => readFileSync(path(name), "utf8"),
      write: async (_folder, name, content) => { writeFileSync(path(name), content); },
      remove: async (_folder, name) => { unlinkSync(path(name)); },
      exists: async (_folder, name) => existsSync(path(name)),
      mtime: async (_folder, name) => existsSync(path(name)) ? statSync(path(name)).mtimeMs : undefined,
      stat: async (_folder, name) => existsSync(path(name)) ? { mtime: statSync(path(name)).mtimeMs, size: statSync(path(name)).size } : undefined,
      listable: (name) => name.endsWith(".md"),
    };
    const writer: WorkingTreeWriter = {
      writeFile: async (name, content) => { mkdirSync(join(name, ".."), { recursive: true }); writeFileSync(name, content); },
      readFile: async (name) => existsSync(name) ? readFileSync(name, "utf8") : undefined,
      deleteFile: async (name) => { if (existsSync(name)) unlinkSync(name); },
    };
    const mapping: FolderMapping = { id: "fbr-canary", label: "FBR canary", localFolder: folder, remotePath: "", direction: "push-pull", providerId: "fbr-local" };
    const credential: Credential = { id: "fbr-local", label: "Canary", kind: "local", token: "", baseUrl: `file://${remote}` };
    const store = new MugsStore(new MemoryIO());
    let created = false;
    try {
      expect(existsSync(vaultFolder)).toBe(false);
      mkdirSync(vaultFolder);
      created = true;
      mkdirSync(seed);
      git(seed, "init", "-q", "-b", "main");
      writeFileSync(join(seed, "remote.md"), "remote initial\n");
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", "seed");
      git(base, "clone", "-q", "--bare", seed, remote);
      await store.load();
      const deps = () => ({
        mappings: [mapping], credentials: [credential], getToken: () => "",
        buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
        cloneRoot: join(base, "clones"), runner: new ChildProcessRunner(), workingTree: writer, vaultMirror: mirror,
        lastSync: storeWritableAccessor(store), conflicts: storeConflictAccessor(store),
        policy: { autoMerge: false, defaultResolution: "both" as const, recencyWins: false, paused: false, intervalSeconds: 300, firstSyncDirection: "pull" as const, obsidianConfig: { enabled: false, entries: [] } },
      });
      expect((await syncAllMappings(deps()))[0].status).toBe("ok");
      expect(readFileSync(path("remote.md"), "utf8")).toBe("remote initial\n");
      writeFileSync(path("local.md"), "local change\n");
      const pushed = await syncAllMappings(deps());
      expect(pushed[0].status).toBe("ok");
      expect(git(base, "--git-dir", remote, "show", "HEAD:local.md")).toBe("local change");
      git(seed, "pull", "-q", "--ff-only", remote, "main");
      writeFileSync(join(seed, "incoming.md"), "inbound change\n");
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", "inbound");
      git(seed, "push", "-q", remote, "main");
      expect((await syncAllMappings(deps()))[0].status).toBe("ok");
      expect(readFileSync(path("incoming.md"), "utf8")).toBe("inbound change\n");
      expect((await syncAllMappings(deps()))[0].status).toBe("ok");
      expect(list().sort()).toEqual(["incoming.md", "local.md", "remote.md"]);
    } finally {
      if (created) rmSync(vaultFolder, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);
});
