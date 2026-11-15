import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { ChildProcessRunner } from "../git/runner";
import type { GitRunner } from "../git/types";
import { MemoryIO, MugsStore } from "../store";
import { syncAllMappings, storeWritableAccessor, storeConflictAccessor } from "./driver";
import type { FolderMapping } from "../types";
import { HERMETIC_GIT_ENV } from "./testkit/gitHermetic";

const sizes = (process.env.MUGS_BENCH_SIZES ?? "300").split(",").map(Number);
const baseline = process.env.MUGS_BENCH_BASELINE === "1";

describe("single remote edit work amplification", () => {
  it.each(sizes)("preserves bytes and bounds work across %i notes", async size => {
    const root = mkdtempSync(join(tmpdir(), "mugs-remote-cost-"));
    const peer = join(root, "peer"), remote = join(root, "remote.git");
    mkdirSync(peer);
    const env = { ...process.env, ...HERMETIC_GIT_ENV,
      GIT_AUTHOR_DATE: "1700000078 +0000", GIT_COMMITTER_DATE: "1700000078 +0000" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: peer, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
    try {
      git(["init", "-q", "-b", "main"]);
      for (let n = 0; n < size; n++) writeFileSync(join(peer, `note-${n}.md`), `note ${n}\n`);
      git(["add", "-A"]); git(["commit", "-qm", "fixture"]);
      git(["clone", "-q", "--bare", peer, remote]); git(["remote", "add", "origin", remote]);
      const store = new MugsStore(new MemoryIO());
      const notes = new Map<string, string>();
      let calls = 0, shows = 0, reads = 0, writes = 0, bytesRead = 0;
      const real = new ChildProcessRunner();
      const runner: GitRunner = { run: async (args, opts) => {
        calls++;
        if (args[0] === "show") shows++;
        return real.run(args, { ...opts, env: { ...env, ...opts?.env } });
      } };
      const mapping: FolderMapping = { id: "m", label: "Fixture", providerId: "c", remotePath: "", localFolder: "Notes", direction: "push-pull" };
      const deps = {
        mappings: [mapping], credentials: [{ id: "c", label: "Fixture", kind: "local" as const, token: "", baseUrl: `file://${remote}` }],
        getToken: () => undefined, buildProvider: () => { throw new Error("no network provider"); },
        cloneRoot: join(root, "clones"), runner,
        lastSync: storeWritableAccessor(store), conflicts: storeConflictAccessor(store),
        vaultMirror: {
          list: async () => [...notes.keys()],
          exists: async (_: string, path: string) => notes.has(path),
          read: async (_: string, path: string) => {
            reads++; const content = notes.get(path);
            if (content === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
            bytesRead += Buffer.byteLength(content);
            return content;
          },
          write: async (_: string, path: string, content: string) => { writes++; notes.set(path, content); },
          remove: async (_: string, path: string) => { notes.delete(path); },
          stat: async (_: string, path: string) => notes.has(path) ? { mtime: 1, size: Buffer.byteLength(notes.get(path)!) } : undefined,
        },
        workingTree: {
          readFile: async (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined,
          writeFile: async (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
          deleteFile: async (path: string) => { if (existsSync(path)) unlinkSync(path); },
        },
        rmDir: (dir: string) => rmSync(dir, { recursive: true, force: true }),
      };
      const run = async (phase: string, uncertain = false) => {
        calls = shows = reads = writes = bytesRead = 0;
        const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
        const start = performance.now();
        const outcomes = await syncAllMappings({ ...deps, watcherUncertain: uncertain });
        const syncMs = performance.now() - start;
        const saveStart = performance.now();
        expect((await store.save()).ok).toBe(true);
        const saveMs = performance.now() - saveStart;
        lag.disable();
        expect(outcomes[0].status, outcomes[0].reason).toBe("ok");
        const metrics = { phase, size, syncMs: Math.round(syncMs), saveMs: Math.round(saveMs), calls, shows, reads, writes, bytesRead,
          rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), loopP95Ms: Math.round(lag.percentile(95) / 1e6) };
        console.log("MUGS_BENCH", JSON.stringify(metrics));
        return metrics;
      };
      await run("cold");
      await run("warm");
      const idle = await run("idle");
      expect(idle.reads).toBe(0);
      expect(idle.writes).toBe(0);
      expect(idle.shows).toBe(0);
      writeFileSync(join(peer, "note-0.md"), "remote replacement\n");
      git(["add", "-A"]); git(["commit", "-qm", "one remote edit"]); git(["push", "-q", "origin", "main"]);
      const changed = await run("remote-edit");
      expect(notes.get("note-0.md")).toBe("remote replacement\n");
      expect(notes.size).toBe(size);
      if (!baseline) {
        expect(changed.calls).toBeLessThan(30);
        expect(changed.reads).toBeLessThan(10);
        expect(changed.writes).toBe(1);
      }
      // Same-stat replacement is never trusted once watcher evidence is uncertain.
      notes.set("note-1.md", "hidden\n");
      await run("uncertain", true);
      expect(git(["--git-dir", remote, "show", "main:note-1.md"])).toBe("hidden\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 300_000);
});
