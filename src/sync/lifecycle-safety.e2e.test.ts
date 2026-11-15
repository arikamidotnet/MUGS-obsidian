import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChildProcessRunner } from "../git/runner";
import { MemoryIO, MugsStore } from "../store";
import type { FolderMapping } from "../types";
import { syncAllMappings, storeConflictAccessor, storeWritableAccessor } from "./driver";
import { EditorOpenGuard } from "./editorOpen";
import { MemoryTrashStore } from "./trash";
import { HERMETIC_GIT_ENV } from "./testkit/gitHermetic";

/** Every path and Git mutation belongs to this test's newly allocated temp tree. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mugs-lifecycle-safety-"));
  const peer = join(root, "peer"), remote = join(root, "remote.git"), vault = join(root, "vault");
  mkdirSync(peer); mkdirSync(vault);
  const git = (args: string[], cwd = peer) => execFileSync("git", args, {
    cwd, env: {
      ...process.env, ...HERMETIC_GIT_ENV, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      // Keep missing-path diagnostics independent of random 401/403 substrings
      // in commit hashes. The dedicated client tests cover that separate bug.
      GIT_AUTHOR_DATE: "1700000078 +0000", GIT_COMMITTER_DATE: "1700000078 +0000",
    }, stdio: ["ignore", "pipe", "pipe"],
  }).toString();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(peer, "F.md"), "base\n");
  writeFileSync(join(peer, "G.md"), "keep\n");
  git(["add", "-A"]); git(["commit", "-q", "-m", "init"]);
  git(["clone", "-q", "--bare", peer, remote]);
  git(["remote", "add", "origin", remote]);
  const mapping: FolderMapping = { id: "m", label: "M", providerId: "c", remotePath: "", localFolder: "Synced", direction: "push-pull" };
  const io = new MemoryIO();
  let store = new MugsStore(io);
  const editor = new EditorOpenGuard();
  const held = new Set<string>();
  const faults = { read: false, write: false, remove: false, noopWrite: false, noopRemove: false, verifyRead: false, noopCloneWrite: false, noopCloneRemove: false };
  let afterMutation = false;
  const writes: string[] = [];
  const deletes: string[] = [];
  const folder = (name: string) => name === "Synced" ? vault : join(root, name);
  const p = (name: string, rel: string) => join(folder(name), rel);
  const walk = (dir: string): string[] => existsSync(dir) ? readdirSync(dir).flatMap(name => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs).map(child => `${name}/${child}`) : [name];
  }) : [];
  const mirror = {
    list: async (name: string) => walk(folder(name)),
    exists: async (name: string, rel: string) => existsSync(p(name, rel)),
    read: async (name: string, rel: string) => {
      if (rel === "F.md" && (faults.read || (faults.verifyRead && afterMutation))) throw new Error("permission denied");
      return readFileSync(p(name, rel), "utf8");
    },
    write: async (name: string, rel: string, content: string) => {
      writes.push(`${name}/${rel}`);
      if (faults.write) throw new Error("write denied");
      if (faults.noopWrite) return;
      mkdirSync(dirname(p(name, rel)), { recursive: true });
      writeFileSync(p(name, rel), content);
      afterMutation = true;
    },
    remove: async (name: string, rel: string) => {
      deletes.push(`${name}/${rel}`);
      if (faults.remove) throw new Error("delete denied");
      if (faults.noopRemove) return;
      if (existsSync(p(name, rel))) unlinkSync(p(name, rel));
      afterMutation = true;
    },
  };
  const deps = () => ({
    mappings: [mapping],
    credentials: [{ id: "c", label: "Local", kind: "local" as const, token: "fixture", baseUrl: `file://${remote}` }],
    getToken: () => undefined,
    buildProvider: () => { throw new Error("local fixture must not contact providers"); },
    cloneRoot: join(root, "clones"), runner: new ChildProcessRunner(),
    lastSync: storeWritableAccessor(store), conflicts: storeConflictAccessor(store),
    heldPaths: () => held, editorOpen: editor, vaultMirror: mirror, trash: new MemoryTrashStore(),
    workingTree: {
      readFile: async (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined,
      writeFile: async (path: string, content: string) => {
        if (faults.noopCloneWrite && path.endsWith("/F.md")) return;
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
      },
      deleteFile: async (path: string) => {
        if (faults.noopCloneRemove && path.endsWith("/F.md")) return;
        if (existsSync(path)) unlinkSync(path);
      },
    },
    rmDir: (path: string) => rmSync(path, { recursive: true, force: true }),
  });
  return {
    root, peer, remote, vault, mapping, faults, writes, deletes, editor, held, mirror, deps,
    get store() { return store; },
    sync: () => syncAllMappings(deps()),
    read: (rel = "F.md") => readFileSync(join(vault, rel), "utf8"),
    local: (content: string, rel = "F.md") => writeFileSync(join(vault, rel), content),
    remoteText: (rel = "F.md") => git(["--git-dir", remote, "show", `main:${rel}`]),
    tip: () => git(["--git-dir", remote, "rev-parse", "main"]).trim(),
    change: (files: Record<string, string | null>) => {
      for (const [rel, text] of Object.entries(files)) {
        const path = join(peer, rel);
        if (text === null) unlinkSync(path);
        else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
      }
      git(["add", "-A"]); git(["commit", "-q", "-m", "peer update"]); git(["push", "-q", "origin", "main"]);
    },
    restart: async () => { await store.save(); store = new MugsStore(io); await store.load(); },
    clearFaults: () => { afterMutation = false; for (const key of Object.keys(faults)) faults[key as keyof typeof faults] = false; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

let f: ReturnType<typeof fixture>;
beforeEach(async () => { f = fixture(); await f.sync(); f.clearFaults(); f.writes.length = f.deletes.length = 0; });
afterEach(() => f.cleanup());

describe("lifecycle safety: fresh planning, never blind pending replay", () => {
  it("keeps held advisory files intact across repeated passes and restart", async () => {
    f.held.add("F.md");
    f.change({ "G.md": "peer edit\n" });
    await f.sync();
    expect(f.store.getSettings().lastSync.m.pendingOps ?? []).toEqual([]);
    await f.restart();
    await f.sync();
    expect(f.read()).toBe("base\n");
    expect(f.writes).not.toContain("Synced/F.md");
    expect(f.remoteText()).toBe("base\n");
  });

  it.each(["push-pull", "pull-only"] as const)("does not delete the local modified survivor in %s", async direction => {
    f.mapping.direction = direction;
    // Establish ownership under the chosen direction before the race.
    await f.sync();
    f.local("valuable local edit\n");
    f.change({ "F.md": null });
    await f.sync();
    expect(f.read()).toBe("valuable local edit\n");
    expect(f.deletes).not.toContain("Synced/F.md");
    if (direction === "push-pull") expect(f.remoteText()).toBe("valuable local edit\n");
  });

  it("conflicts instead of overwriting a local edit saved while a remote write was deferred", async () => {
    f.editor.track("Synced/F.md");
    f.change({ "F.md": "remote v2\n" });
    await f.sync();
    expect(f.store.getSettings().lastSync.m.pendingOps?.[0].content).toBe("remote v2\n");
    await f.restart();
    f.local("new local work\n");
    f.editor.untrack("Synced/F.md");
    const out = await f.sync();
    expect(out[0].status).toBe("conflict");
    expect(f.read()).toBe("new local work\n");
    expect(f.remoteText()).toBe("remote v2\n");
  });

  it("preserves and publishes a local edit saved while a remote delete was deferred", async () => {
    f.editor.track("Synced/F.md");
    f.change({ "F.md": null });
    await f.sync();
    expect(f.store.getSettings().lastSync.m.pendingOps?.[0].kind).toBe("vault-delete");
    await f.restart();
    f.local("saved after remote deletion\n");
    f.editor.untrack("Synced/F.md");
    await f.sync();
    expect(f.read()).toBe("saved after remote deletion\n");
    expect(f.remoteText()).toBe("saved after remote deletion\n");
    expect(f.store.getSettings().lastSync.m.pendingOps).toEqual([]);
  });

  it.each(["write", "remove"] as const)("rejects a no-op clone %s before staging or overwriting vault bytes", async kind => {
    if (kind === "write") {
      f.local("valuable local edit\n");
      f.faults.noopCloneWrite = true;
    } else {
      f.local("valuable local edit\n");
      f.faults.noopCloneRemove = true;
      // A genuine local deletion of G leaves a live file in the clone.
      unlinkSync(join(f.vault, "F.md"));
    }
    const before = f.tip();
    const out = await f.sync();
    expect(out[0].status).toBe("skipped");
    expect(out[0].reason).toContain("could not be verified");
    expect(f.tip()).toBe(before);
    if (kind === "write") expect(f.read()).toBe("valuable local edit\n");
    expect(f.writes).toEqual([]);
  });

  it.each(["direction", "root", "scope", "legacy"] as const)("quarantines incompatible %s pending work without replay", async change => {
    f.editor.track("Synced/F.md");
    f.change({ "F.md": "remote v2\n" });
    await f.sync();
    f.editor.untrack("Synced/F.md");
    if (change === "direction") f.mapping.direction = "push-only";
    if (change === "scope") f.mapping.excludes = ["F.md"];
    if (change === "root") {
      f.mapping.localFolder = "Different";
      mkdirSync(join(f.root, "Different"));
      writeFileSync(join(f.root, "Different", "F.md"), "unrelated root bytes\n");
    }
    if (change === "legacy") {
      const state = f.store.getSettings().lastSync.m;
      f.store.setLastSync({ ...state, pendingOps: state.pendingOps!.map(({ fingerprint, ...op }) => op) });
    }
    const before = f.read();
    f.writes.length = 0;
    await f.sync();
    expect(f.read()).toBe(before);
    expect(f.writes.some(p => p.endsWith("/F.md"))).toBe(false);
    expect(f.store.getSettings().lastSync.m.pendingOps?.[0].state).toBe("failed");
    if (change === "root") expect(readFileSync(join(f.root, "Different", "F.md"), "utf8")).toBe("unrelated root bytes\n");
  });

  it("quarantines a legacy contentless pending write rather than interpreting it as empty text", async () => {
    const state = f.store.getSettings().lastSync.m;
    f.store.setLastSync({ ...state, pendingOps: [{
      opId: "legacy", kind: "vault-write", path: "F.md", state: "pending", createdAt: 0, attempts: 0,
    }] });
    await f.sync();
    expect(f.read()).toBe("base\n");
    expect(f.store.getSettings().lastSync.m.pendingOps?.[0].state).toBe("failed");
  });

  it.each(["write", "remove"] as const)("does not acknowledge a no-op vault %s", async kind => {
    const proof = f.store.getSettings().lastSync.m.correspondenceSha;
    if (kind === "write") { f.faults.noopWrite = true; f.change({ "F.md": "remote v2\n" }); }
    else { f.faults.noopRemove = true; f.change({ "F.md": null }); }
    await f.sync();
    expect(f.read()).toBe("base\n");
    expect(f.store.getSettings().lastSync.m.pendingOps?.length).toBeGreaterThan(0);
    expect(f.store.getSettings().lastSync.m.correspondenceSha).toBe(proof);
    await f.restart();
    f.clearFaults();
    await f.sync();
    if (kind === "write") expect(f.read()).toBe("remote v2\n");
    else expect(existsSync(join(f.vault, "F.md"))).toBe(false);
    expect(f.store.getSettings().lastSync.m.pendingOps).toEqual([]);
  });

  it("never treats an unreadable pending deletion as completed or absent", async () => {
    f.editor.track("Synced/F.md");
    f.change({ "F.md": null });
    await f.sync();
    f.editor.untrack("Synced/F.md");
    f.faults.read = true;
    await f.sync();
    expect(existsSync(join(f.vault, "F.md"))).toBe(true);
    expect(f.deletes).toEqual([]);
    expect(f.store.getSettings().lastSync.m.pendingOps?.length).toBeGreaterThan(0);
    f.clearFaults();
    await f.sync();
    expect(existsSync(join(f.vault, "F.md"))).toBe(false);
  });

  it("does not acknowledge a write whose post-write read fails", async () => {
    f.change({ "F.md": "remote v2\n" });
    f.faults.verifyRead = true;
    await f.sync();
    expect(f.store.getSettings().lastSync.m.pendingOps?.[0].lastError).toContain("not verified");
    f.clearFaults();
    await f.sync();
    expect(f.read()).toBe("remote v2\n");
    expect(f.store.getSettings().lastSync.m.pendingOps).toEqual([]);
  });

  it("automatically converges new remote files, new local files, and a local rename", async () => {
    f.change({ "remote-new.md": "from peer\n" });
    await f.sync();
    expect(f.read("remote-new.md")).toBe("from peer\n");
    f.local("new local\n", "local-new.md");
    renameSync(join(f.vault, "F.md"), join(f.vault, "renamed.md"));
    await f.sync();
    expect(f.remoteText("local-new.md")).toBe("new local\n");
    expect(f.remoteText("renamed.md")).toBe("base\n");
    expect(f.read("renamed.md")).toBe("base\n");
    expect(f.store.getSettings().lastSync.m.pendingOps).toEqual([]);
  });
});
