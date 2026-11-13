import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { syncAllMappings } from "./driver";
import { installHermeticGitIdentity } from "./testkit";

installHermeticGitIdentity();

describe("scoped first sync", () => {
  it.each([
    { direction: "pull-only" as const, fallback: false },
    { direction: "pull-only" as const, fallback: true },
    { direction: "push-pull" as const, fallback: false },
    { direction: "push-pull" as const, fallback: true },
  ])("imports exact subtree bytes ($direction, committed fallback=$fallback)", async ({ direction, fallback }) => {
    const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { execSync } = await import("node:child_process");
    const { MugsStore, MemoryIO } = await import("../store");
    const { storeWritableAccessor, storeConflictAccessor } = await import("./driver");
    const { ChildProcessRunner } = await import("../git/runner");
    const sh = (cmd: string) => execSync(cmd, { encoding: "utf8" });
    const base = mkdtempSync(join(tmpdir(), "mugs-scoped-"));
    const remote = join(base, "remote.git");
    const cloneRoot = join(base, "clones");
    const vaultRoot = join(base, "vault");
    const synced = join(vaultRoot, "Synced");
    mkdirSync(synced, { recursive: true });
    try {
      const work = join(base, "work");
      mkdirSync(join(work, "teamdir"), { recursive: true });
      writeFileSync(join(work, "teamdir", "shared.md"), "shared note\n");
      writeFileSync(join(work, "shared.md"), "outside mapping — never import\n");
      sh(`git -C ${JSON.stringify(work)} init -q -b main && git -C ${JSON.stringify(work)} config user.name T && git -C ${JSON.stringify(work)} config user.email t@l && git -C ${JSON.stringify(work)} add -A && git -C ${JSON.stringify(work)} commit -qm init && git clone -q --bare ${JSON.stringify(work)} ${JSON.stringify(remote)}`);
      const walk = (dir: string, p = ""): string[] => {
        const out: string[] = [];
        for (const e of readdirSync(dir)) {
          if (e.startsWith(".")) continue;
          const abs = join(dir, e);
          const rel = p ? `${p}/${e}` : e;
          if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
          else out.push(rel);
        }
        return out;
      };
      const fp = (rel: string) => join(synced, rel);
      const store = new MugsStore(new MemoryIO());
      const deps = {
        mappings: [{ id: "m1", label: "S", remotePath: "teamdir", localFolder: "Synced", providerId: "c1", direction, repoRef: "r" }],
        credentials: [{ id: "c1", label: "L", kind: "local" as const, token: "t", baseUrl: "file://" + remote }],
        getToken: () => "t",
        buildProvider: () => ({ kind: "local" as const, async listRepos() { return []; }, async getBranches() { return []; }, async getMembers() { return []; }, async listDirectories() { return []; } }),
        cloneRoot,
        runner: new ChildProcessRunner(),
        workingTree: {
          writeFile: (p: string, c: string) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, c); return Promise.resolve(); },
          readFile: (p: string) => Promise.resolve(!fallback && existsSync(p) ? readFileSync(p, "utf8") : undefined),
          deleteFile: (p: string) => { if (existsSync(p)) unlinkSync(p); return Promise.resolve(); },
        },
        vaultMirror: {
          list: async () => (existsSync(synced) ? walk(synced) : []),
          read: async (_f: string, rel: string) => readFileSync(fp(rel), "utf8"),
          write: async (_f: string, rel: string, content: string) => { mkdirSync(fp(rel).slice(0, fp(rel).lastIndexOf("/")), { recursive: true }); writeFileSync(fp(rel), content); },
          remove: async (_f: string, rel: string) => { if (existsSync(fp(rel))) unlinkSync(fp(rel)); },
          mtime: async (_f: string, rel: string) => (existsSync(fp(rel)) ? statSync(fp(rel)).mtimeMs : undefined),
          stat: async (_f: string, rel: string) => (existsSync(fp(rel)) ? { mtime: statSync(fp(rel)).mtimeMs, size: statSync(fp(rel)).size } : undefined),
        },
        rmDir: (d: string) => rmSync(d, { recursive: true, force: true }),
        lastSync: storeWritableAccessor(store),
        conflicts: storeConflictAccessor(store),
        policy: { autoMerge: true, defaultResolution: "both" as const, sameChangeAccept: true, recencyWins: true, paused: false, intervalSeconds: 300, firstSyncDirection: "pull" as const, obsidianConfig: { enabled: false, entries: [] } },
      };
      const out1 = await syncAllMappings(deps);
      expect(out1[0]?.status).toBe("ok");
      expect(readFileSync(join(synced, "shared.md"), "utf8")).toBe("shared note\n");
      const out2 = await syncAllMappings(deps);
      expect(out2[0]?.status).toBe("ok");
      const review = store.getSettings().lastSync["m1"]?.reconciliation?.review;
      expect(review).toEqual({});
      expect(readFileSync(join(synced, "shared.md"), "utf8")).toBe("shared note\n");
      expect(walk(synced)).toEqual(["shared.md"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
