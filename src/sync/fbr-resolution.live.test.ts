/**
 * Opt-in LIVE resolution suite (mutates the target folder of a real vault and
 * its connected test repository). Skipped unless ALL of:
 *   MUGS_FBR_CANARY=1, MUGS_FBR_RESOLVE=1, MUGS_FBR_VAULT=<vault path>,
 *   MUGS_FBR_DATA=<plugin data.json path>   (MUGS_FBR_TARGET defaults to
 *   "07 publish"). No operator path or credential ships in the public source.
 *
 * What it proves, against the REAL vault + repo, through the production engine:
 * 1. Leftovers from an earlier interrupted run are removed from BOTH sides via
 *    a dedicated raw clone BEFORE any engine pass (so no stale divergence can
 *    pollute the convergence pass).
 * 2. A repository-only review entry is recovered via the real decideReviewBatch
 *    flow — copied into the vault with blob-verified bytes (skipped when every
 *    entry was already recovered by an earlier run).
 * 3. A genuine same-region conflict (local edit vs remote edit of one file)
 *    surfaces with BOTH sides intact — nothing clobbered, nothing published.
 * 4. One-click-style resolution (resolved evidence + chosen content) publishes
 *    and converges vault and repository on the resolved bytes.
 * 5. Deletion propagation removes the test file from the repository.
 *
 * Live-vault notes: the conflict file uses a `.log` extension — a running
 * Obsidian with note-editing plugins (e.g. update-time-on-edit) rewrites `.md`
 * files asynchronously, which reshapes three-way merges; `.log` files are not
 * notes and stay untouched. Raw git operations (remote edit, cleanup) run in a
 * dedicated TEMP clone, separate from the engine's own temp clone; the running
 * plugin's clones are never touched. The live data.json is never written (its
 * mtime is asserted unchanged); tokens are used for auth only, never printed.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncAllMappings, storeConflictAccessor, storeWritableAccessor } from "./driver";
import type { VaultMirror, WorkingTreeWriter } from "./cloneManager";
import { decideReviewBatch, reviewConfig } from "../runtime/reconciliationBulk";
import { buildProvider } from "../providers/factory";
import { MugsStore, MemoryIO } from "../store";
import { ChildProcessRunner } from "../git/runner";
import { GitClient, type GitAuth } from "../git/client";
import { gitBlobId } from "./reconciliation";
import { repoToVaultPath } from "./mirror";
import type { Credential, FolderMapping } from "../types";

const VAULT = process.env.MUGS_FBR_VAULT ?? "";
const DATA = process.env.MUGS_FBR_DATA ?? "";
const TARGET = process.env.MUGS_FBR_TARGET ?? "07 publish";
/** Files this suite (or an interrupted earlier run) may create and clean up. */
const TEST_FILE = /^MUGS-live-resolution-test-.*\.(md|log)$/;

/** Same binary-extension set the plugin's mirror uses (src/main.ts). */
const BINARY = new Set(["png","jpg","jpeg","gif","bmp","webp","ico","svgz","pdf","zip","gz","7z","tar","rar","mp3","mp4","mov","avi","mkv","wav","ogg","flac","ttf","otf","woff","woff2","docx","xlsx","pptx","bin","exe","sqlite","db","onnx","pt","apk","drawing"]);

const listable = (rel: string): boolean => {
  const segs = rel.split("/");
  if (segs.some(s => s.startsWith("."))) return false;
  const last = segs[segs.length - 1];
  const ext = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).toLowerCase() : "";
  return !BINARY.has(ext);
};

const walk = (folder: string): string[] => {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) { if (!name.startsWith(".")) rec(abs); continue; }
      const r = abs.slice(folder.length + 1).split("\\").join("/");
      if (listable(r)) out.push(r);
    }
  };
  rec(folder);
  return out;
};

describe.skipIf(!(process.env.MUGS_FBR_CANARY === "1" && process.env.MUGS_FBR_RESOLVE === "1" && VAULT && DATA))("real-vault live resolution suite", () => {
  it("cleans earlier leftovers, recovers a review item, surfaces and resolves a genuine conflict, propagates a deletion — without touching plugin state", async () => {
    const dataMtimeBefore = statSync(DATA).mtimeMs; // the live plugin file must never be written by this test
    const base = mkdtempSync(join(tmpdir(), "mugs-live-resolve-"));
    const cloneRoot = join(base, "clones"); // the ENGINE's clones
    try {
      // --- copied state + real mapping --------------------------------------
      const store = new MugsStore(new MemoryIO(JSON.parse(readFileSync(DATA, "utf8"))));
      const settings = await store.load();
      expect(store.loadError).toBeUndefined();
      const mapping = settings.mappings.find(m => m.label === TARGET) as FolderMapping;
      expect(mapping).toBeDefined();
      const credential = settings.credentials.find(c => c.id === mapping.providerId) as Credential;
      expect(credential).toBeDefined();
      const token = store.getToken(credential.id);
      expect(token).toBeTruthy(); // auth available, never printed
      const auth: GitAuth = { username: credential.username ?? "oauth2", token: token! };

      const folder = join(VAULT, mapping.localFolder);
      const mirror: VaultMirror = {
        list: async () => walk(folder),
        read: async (_f, rel) => readFileSync(join(folder, rel), "utf8"),
        write: async (_f, rel, content) => { const p = join(folder, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); },
        remove: async (_f, rel) => { unlinkSync(join(folder, rel)); },
        exists: async (_f, rel) => existsSync(join(folder, rel)),
        mtime: async (_f, rel) => (existsSync(join(folder, rel)) ? statSync(join(folder, rel)).mtimeMs : undefined),
        stat: async (_f, rel) => (existsSync(join(folder, rel)) ? { mtime: statSync(join(folder, rel)).mtimeMs, size: statSync(join(folder, rel)).size } : undefined),
        listable,
      };
      const writer: WorkingTreeWriter = {
        writeFile: async (abs, content) => { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); },
        readFile: async abs => (existsSync(abs) ? readFileSync(abs, "utf8") : undefined),
        deleteFile: async abs => { if (existsSync(abs)) unlinkSync(abs); },
      };
      const sync = async () => syncAllMappings({
        mappings: [mapping], credentials: [credential], getToken: id => store.getToken(id),
        buildProvider, cloneRoot, runner: new ChildProcessRunner(),
        workingTree: writer, vaultMirror: mirror,
        lastSync: storeWritableAccessor(store), conflicts: storeConflictAccessor(store),
        policy: settings.sync, obsidianConfig: settings.sync.obsidianConfig,
        firstSyncDirection: settings.sync.firstSyncDirection,
      });
      const vaultFile = (rel: string) => join(folder, rel);

      // --- dedicated RAW clone for direct git operations ---------------------
      const provider = buildProvider({ kind: credential.kind, baseUrl: credential.baseUrl, token: token!, allowedRepos: credential.repos }, { actingUsername: credential.username });
      const repos = await provider.listRepos();
      const repo = repos.find(r => r.id === (mapping.repoRef ?? mapping.id));
      expect(repo).toBeDefined();
      const rawDir = join(base, "rawclone");
      const raw = new GitClient(new ChildProcessRunner()).withAuth(auth);
      await raw.clone(repo!.httpUrlToRepo, rawDir, { filter: "blob:none" });
      const rawAt = raw.at(rawDir);
      const branchResult = await rawAt.run(["rev-parse", "--abbrev-ref", "HEAD"]);
      expect(branchResult.code).toBe(0);
      const branch = branchResult.stdout.trim();
      expect(branch).toBeTruthy();
      const scopePrefix = mapping.remotePath ? `${mapping.remotePath.replace(/^\/+|\/+$/g, "")}/` : "";
      const remoteTree = async (): Promise<Set<string>> => {
        await rawAt.fetch(); // the ENGINE pushes from its own clone — refresh before reading
        const ls = await rawAt.run(["ls-tree", "-r", "--name-only", "-z", "--full-tree", `origin/${branch}`, "--"]);
        expect(ls.code).toBe(0);
        return new Set(ls.stdout.split("\0").filter(Boolean));
      };
      const logOutcome = (label: string, outcome: { status: string; kind?: string; reason?: string; newRemoteSha?: string; counts?: unknown }) =>
        console.log(`[live] ${label}: ${JSON.stringify(outcome)}`);

      // --- 1. remove earlier leftovers from BOTH sides (before any pass) -----
      const vaultLeftovers = walk(folder).filter(rel => TEST_FILE.test(rel));
      for (const rel of vaultLeftovers) unlinkSync(vaultFile(rel));
      const tree = await remoteTree();
      const remoteLeftovers = [...tree].filter(p => TEST_FILE.test(p.slice(scopePrefix.length)) && p.startsWith(scopePrefix));
      if (remoteLeftovers.length > 0) {
        for (const p of remoteLeftovers) {
          const local = join(rawDir, p);
          if (existsSync(local)) unlinkSync(local);
          await rawAt.add([p]); // stages the removal
        }
        await rawAt.commit("MUGS live test: remove earlier test leftovers", undefined, { name: "MUGS Live Test", email: "mugs-live-test@example.invalid" });
        await rawAt.push("origin", branch);
      }
      const afterCleanup = await remoteTree();
      expect([...afterCleanup].some(p => p.startsWith(scopePrefix) && TEST_FILE.test(p.slice(scopePrefix.length)))).toBe(false);
      expect(walk(folder).some(rel => TEST_FILE.test(rel))).toBe(false);

      // --- 2. converge through the engine ------------------------------------
      const converged = await sync();
      logOutcome("converge", converged[0]);
      expect(converged[0].status).toBe("ok");

      // --- 3. review recovery via the production batch flow (conditional) ----
      const state = store.getSettings().lastSync[mapping.id]?.reconciliation;
      const recoverable = state
        ? Object.entries(state.review).filter(([path]) => {
            const rel = repoToVaultPath(mapping, path);
            return rel !== null && !existsSync(vaultFile(rel));
          })
        : [];
      if (recoverable.length > 0) {
        const [recoverPath, entry] = recoverable[0];
        const row = {
          mappingId: mapping.id, mappingLabel: mapping.label, path: recoverPath,
          ref: entry.ref, blob: entry.blob, fingerprint: state!.fingerprint,
          direction: mapping.direction, reason: entry.reason,
        };
        const recoveredRel = repoToVaultPath(mapping, recoverPath)!;
        const result = await decideReviewBatch({
          getSettings: () => store.getSettings(),
          setLastSync: s => store.setLastSync(s),
          save: async () => ({ ok: true }), // MemoryIO copy: nothing durable to write
          acquire: () => () => undefined,
          sync: async () => (await sync())[0].status === "ok",
          verify: async rows => {
            const m = store.getSettings().mappings.find(x => x.id === mapping.id)!;
            const rel = repoToVaultPath(m, rows[0].path)!;
            const verified = new Set<string>();
            try {
              if (gitBlobId(await mirror.read(m.localFolder, rel), rows[0].blob.length) === rows[0].blob) verified.add(rows[0].path);
            } catch { /* not applied */ }
            return verified;
          },
        }, [row], "recover", reviewConfig(store.getSettings(), mapping.id));
        expect(result.rows[0].status).toBe("applied");
        const recoveredBytes = readFileSync(vaultFile(recoveredRel), "utf8");
        expect(gitBlobId(recoveredBytes, entry.blob.length)).toBe(entry.blob); // blob-verified recovery
        expect(store.getSettings().lastSync[mapping.id]?.reconciliation?.review[recoverPath]).toBeUndefined();
      }

      // --- 4. engineer a genuine same-region conflict ------------------------
      // A .log file: Obsidian and note plugins (update-time-on-edit) rewrite
      // .md files asynchronously, which would reshape the three-way merge.
      const testRel = `MUGS-live-resolution-test-${process.pid}.log`;
      const testRepoPath = `${scopePrefix}${testRel}`;
      const V1 = "alpha\nbravo\ncharlie\n";
      const V_REMOTE = "alpha\nbravo-REMOTE\ncharlie\n";
      const V_LOCAL = "alpha\nbravo-LOCAL\ncharlie\n";
      const V_RESOLVED = "alpha\nbravo-REMOTE\nbravo-LOCAL\ncharlie\n";
      writeFileSync(vaultFile(testRel), V1);
      const published = await sync();
      logOutcome("publish v1", published[0]);
      expect(published[0].status).toBe("ok"); // publishes v1
      expect((await remoteTree()).has(testRepoPath)).toBe(true);

      // Remote edit from the RAW clone (the engine's and the plugin's clones
      // untouched). First fast-forward the raw clone to the tip the engine just
      // published — its local branch still sits on the clone-time tip.
      await rawAt.fetch();
      const ff = await rawAt.run(["reset", "--hard", `origin/${branch}`]);
      expect(ff.code).toBe(0);
      writeFileSync(join(rawDir, testRepoPath), V_REMOTE);
      await rawAt.add([testRepoPath]);
      await rawAt.commit("MUGS live test: remote edit", undefined, { name: "MUGS Live Test", email: "mugs-live-test@example.invalid" });
      await rawAt.push("origin", branch);
      const remoteNow = await rawAt.run(["show", `origin/${branch}:${testRepoPath}`]);
      expect(remoteNow.code).toBe(0);
      expect(remoteNow.stdout).toBe(V_REMOTE); // the remote edit really landed

      // Local edit of the same region: the next pass must surface a conflict.
      writeFileSync(vaultFile(testRel), V_LOCAL);
      const conflicted = await sync();
      logOutcome("conflict pass", conflicted[0]);
      expect(conflicted[0].status).toBe("conflict");
      const recorded = conflicted[0].conflicts?.find(c => c.path === testRepoPath);
      expect(recorded).toBeDefined();
      expect(recorded!.ours).toBe(V_LOCAL);
      expect(recorded!.theirs).toBe(V_REMOTE);
      expect(readFileSync(vaultFile(testRel), "utf8")).toBe(V_LOCAL); // nothing clobbered

      // --- 5. resolve (one-click flow: resolved evidence + chosen content) ----
      writeFileSync(vaultFile(testRel), V_RESOLVED);
      store.setConflicts(mapping.id, store.getConflicts(mapping.id)
        .map(c => c.path === testRepoPath ? { ...c, resolved: true, resolvedContent: V_RESOLVED } : c));
      const resolved = await sync();
      logOutcome("resolve pass", resolved[0]);
      expect(resolved[0].status).toBe("ok");
      expect(readFileSync(vaultFile(testRel), "utf8")).toBe(V_RESOLVED);
      await rawAt.fetch(); // the engine's resolve pass just pushed — refresh before reading
      const head = await rawAt.run(["show", `origin/${branch}:${testRepoPath}`]);
      expect(head.code).toBe(0);
      expect(head.stdout).toBe(V_RESOLVED); // repository converged on the resolved bytes
      expect(store.getConflicts(mapping.id).length).toBe(0); // cleared by the clean pass

      // --- 6. deletion propagation -------------------------------------------
      unlinkSync(vaultFile(testRel));
      const deleted = await sync();
      logOutcome("delete pass", deleted[0]);
      expect(deleted[0].status).toBe("ok");
      const finalTree = await remoteTree();
      expect(finalTree.has(testRepoPath)).toBe(false);
      expect(existsSync(vaultFile(testRel))).toBe(false);

      // --- live plugin state was never written by this test -------------------
      expect(statSync(DATA).mtimeMs).toBe(dataMtimeBefore);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 900_000);
});
