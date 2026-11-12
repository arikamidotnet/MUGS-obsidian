/**
 * QUARANTINED LIVE DIAGNOSTIC — NEVER RUN UNDER DEFAULT `npm test`.
 *
 * WHY QUARANTINED (qa-release, Wave A):
 *   - This file performs real writes and pushes against the live company vault
 *     (FBR-WRK) using the real token from its data.json.
 *   - It is intentionally excluded from normal test discovery via vitest.config.ts
 *     (see: exclude: ["src/sync/__live_diag.test.ts"]).
 *   - The only supported way to run it is: MUGS_LIVE_DIAG=1 npx vitest run src/sync/__live_diag.test.ts
 *
 * DO NOT REMOVE THE QUARANTINE without explicit cross-wave sign-off.
 * If you need to run it locally for diagnostics, set the env var.
 *
 * Original purpose preserved below for reference.
 *
 * --- original header (lightly edited) ---
 * Replicates exactly what MugsPlugin.runSync() does for the FBR-WRK vault: the real
 * clone root, a Node-fs VaultMirror/WorkingTreeWriter over the real vault folders,
 * the real provider (token read from the vault's data.json at runtime, never
 * printed), and real git child processes. Prints each mapping's outcome — status,
 * skip reason, conflict count — so a silent per-mapping failure in the plugin can
 * be reproduced and pinpointed outside Obsidian.
 *
 * RC MODE: runs EVERY mapping (not just never-synced ones), feeds the sync engine
 * the new snapshot seams, and finishes with a state verification pass (baselines
 * resolve in the clone, no junk directories, no stored conflicts). Records are
 * kept in memory and printed — data.json is NEVER written here; the running
 * plugin remains the owner of persisted state.
 *
 * Run: env MUGS_LIVE_DIAG=1 npx vitest run src/sync/__live_diag.test.ts
 */
import { describe, it } from "vitest";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { syncAllMappings } from "./driver";
import { ChildProcessRunner } from "../git/runner";
import { buildProvider } from "../providers/factory";
import type { MugsSettings, FolderMapping } from "../types";
import type { VaultMirror, WorkingTreeWriter, LastSyncAccessor, ConflictStore } from "./cloneManager";

const VAULT = "/home/arikami/Documents/FBR-WRK";
const DATA = `${VAULT}/.obsidian/plugins/mugs-obsidian/data.json`;
const CLONE_ROOT = `${VAULT}/.mugs-clones`;

/** Same binary-extension skip the plugin's mirror applies (main.ts). */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "svgz", "pdf", "zip", "gz", "7z", "tar",
  "rar", "mp3", "mp4", "mov", "avi", "mkv", "wav", "ogg", "flac", "ttf", "otf", "woff", "woff2",
  "docx", "xlsx", "pptx", "bin", "exe", "sqlite", "db", "onnx", "pt", "Drawing",
]);

/** Recursive walk matching Obsidian's getFiles(): skips dot entries, returns vault-relative paths. */
function walk(absDir: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const abs = join(absDir, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(abs, rel));
    else if (st.isFile()) {
      const ext = e.includes(".") ? e.slice(e.lastIndexOf(".") + 1).toLowerCase() : "";
      if (!BINARY_EXTENSIONS.has(ext)) out.push(rel);
    }
  }
  return out;
}

const rootOf = (folder: string): string => (folder === "." ? "" : folder);

const vaultMirror: VaultMirror = {
  list: async (folder) => {
    const root = rootOf(folder);
    return walk(join(VAULT, root));
  },
  read: async (folder, rel) => readFileSync(join(VAULT, rootOf(folder), rel), "utf8"),
  write: async (folder, rel, content) => {
    const p = join(VAULT, rootOf(folder), rel);
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    writeFileSync(p, content);
  },
  remove: async (folder, rel) => {
    try { unlinkSync(join(VAULT, rootOf(folder), rel)); } catch { /* absent */ }
  },
  mtime: async (folder, rel) => {
    try { return statSync(join(VAULT, rootOf(folder), rel)).mtimeMs; } catch { return undefined; }
  },
  stat: async (folder, rel) => {
    try {
      const st = statSync(join(VAULT, rootOf(folder), rel));
      return { mtime: st.mtimeMs, size: st.size };
    } catch {
      return undefined;
    }
  },
};

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

describe.skipIf(process.env.MUGS_LIVE_DIAG !== "1")("MUGS live diagnostic (FBR-WRK)", () => {
  it(
    "runs the real sync for EVERY mapping (RC mode) and verifies the resulting state",
    async () => {
      if (!existsSync(DATA)) throw new Error(`no vault data at ${DATA}`);
      const settings: MugsSettings = JSON.parse(readFileSync(DATA, "utf8"));

      // RC mode: every mapping, every pass phase — fetch, merge, push, mirror.
      const targets: FolderMapping[] = settings.mappings;
      console.log(`\n[live-diag] ${targets.length} mappings:`, targets.map((m) => `${m.label}(${m.direction})`).join(", "));

      // In-memory view of the persisted state; records update the in-memory copy
      // (so later phases in one session see them) but are NEVER written back to
      // data.json — the running plugin owns that file.
      const record = (id: string, patch: Record<string, unknown>): void => {
        const cur = settings.lastSync[id] ?? { mappingId: id, status: "pending" as const };
        settings.lastSync[id] = { ...cur, mappingId: id, ...patch } as (typeof settings.lastSync)[string];
      };
      const lastSync: LastSyncAccessor = {
        lastRemoteSha: (id) => settings.lastSync[id]?.lastRemoteSha,
        recordPull: (id, sha) => {
          console.log(`[record] pull  ${id.slice(0, 8)} -> ${sha.slice(0, 8)}`);
          record(id, { lastRemoteSha: sha, lastPullAt: Date.now(), status: "ok" });
        },
        recordPush: (id, sha) => {
          console.log(`[record] push  ${id.slice(0, 8)} -> ${sha.slice(0, 8)}`);
          record(id, { lastRemoteSha: sha, lastPushAt: Date.now(), status: "ok" });
        },
        recordConflict: (id) => console.log(`[record] conflict ${id.slice(0, 8)}`),
        vaultPopulated: (id) => settings.lastSync[id]?.vaultPopulated,
        recordVaultSync: (id) => {
          console.log(`[record] vault-populated ${id.slice(0, 8)}`);
          record(id, { vaultPopulated: true });
        },
        lastCompletedAt: (id) => {
          const s = settings.lastSync[id];
          const at = Math.max(s?.lastPullAt ?? 0, s?.lastPushAt ?? 0);
          return at > 0 ? at : undefined;
        },
        contentSnapshot: (id) => settings.lastSync[id]?.contentSnapshot,
        recordContentSnapshot: (id, snap) => record(id, { contentSnapshot: snap }),
      };
      const conflicts: ConflictStore = {
        getConflicts: (id) => settings.conflicts[id] ?? [],
        setConflicts: (id, list) => console.log(`[record] conflicts cleared ${id.slice(0, 8)} (${list.length} left)`),
      };

      const started = Date.now();
      const outcomes = await syncAllMappings({
        mappings: targets,
        credentials: settings.credentials,
        getToken: (id) => settings.credentials.find((c) => c.id === id)?.token,
        buildProvider,
        cloneRoot: CLONE_ROOT,
        runner: new ChildProcessRunner(),
        lastSync,
        workingTree,
        conflicts,
        policy: settings.sync,
        obsidianConfig: settings.sync.obsidianConfig,
        vaultMirror,
        rmDir: (dir) => { console.log(`[rmDir] ${dir}`); rmSync(dir, { recursive: true, force: true }); },
        firstSyncDirection: "push",
        onStatus: (m) => console.log(`[status] ${m}`),
      });

      console.log(`\n[live-diag] pass finished in ${((Date.now() - started) / 1000).toFixed(1)}s — outcomes:`);
      for (const o of outcomes) {
        console.log(`  ${o.label.padEnd(24)} ${o.status.toUpperCase()}${o.reason ? ` — ${o.reason}` : ""}${o.conflicts?.length ? ` (${o.conflicts.length} conflicts)` : ""}`);
      }
      const bad = outcomes.filter((o) => o.status !== "ok");
      if (bad.length > 0) {
        console.log("\n[live-diag] FAILURES (full reasons above) — investigate before go-live.");
      }

      // --- RC state verification --------------------------------------------
      // 1. Every mapping's recorded baseline must resolve to a real commit in its
      //    clone (the Diff view's exact check).
      // 2. No junk directories inside the vault (the old adapter-path bug grew
      //    <vault>/home/... — its return would mean a regression).
      // 3. No stored unresolved conflicts after clean passes.
      const { execFileSync } = await import("node:child_process");
      const junk = readdirSync(VAULT).filter((e) => e === "home");
      console.log(`[verify] junk dirs (must be empty): ${JSON.stringify(junk)}`);
      let problems = junk.length > 0 ? 1 : 0;
      for (const m of targets) {
        const ls = settings.lastSync[m.id];
        const base = ls?.lastRemoteSha;
        if (!base) {
          console.log(`[verify] ${m.label}: NO BASELINE — first sync never completed`);
          problems++;
          continue;
        }
        // The engine since 0.3.28 keys clones by resolved identity and records the
        // dir in lastSync (main.ts cloneDirFor uses the same record); recomputing the
        // legacy slug layout here verifies the abandoned clone instead of the live one.
        const slug = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
        const dir = ls?.cloneDir ?? `${CLONE_ROOT}/${slug(m.providerId)}/${slug(m.repoRef ?? m.id)}`;
        try {
          execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: dir });
          console.log(`[verify] ${m.label}: baseline ${base.slice(0, 8)} resolves in clone - status=${ls.status}`);
        } catch {
          console.log(`[verify] ${m.label}: baseline ${base.slice(0, 8)} MISSING from clone — Diff would fall back`);
          problems++;
        }
        const stored = settings.conflicts[m.id] ?? [];
        if (stored.some((c) => !c.resolved)) {
          console.log(`[verify] ${m.label}: UNRESOLVED CONFLICTS stored (${stored.length})`);
          problems++;
        }
      }
      if (problems > 0) throw new Error(`[live-diag] state verification FAILED (${problems} problem(s))`);
      console.log("\n[live-diag] state verification PASSED — baselines resolve, no junk dirs, no stored conflicts.");
    },
    600_000,
  );
});
