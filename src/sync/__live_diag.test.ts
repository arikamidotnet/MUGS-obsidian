/**
 * LIVE DIAGNOSTIC — never part of the normal suite (skipped unless MUGS_LIVE_DIAG=1).
 *
 * Replicates exactly what MugsPlugin.runSync() does for the FBR-WRK vault: the real
 * clone root, a Node-fs VaultMirror/WorkingTreeWriter over the real vault folders,
 * the real provider (token read from the vault's data.json at runtime, never
 * printed), and real git child processes. Prints each mapping's outcome — status,
 * skip reason, conflict count — so a silent per-mapping failure in the plugin can
 * be reproduced and pinpointed outside Obsidian.
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
    "runs the real sync for the never-synced mappings and prints each outcome",
    async () => {
      if (!existsSync(DATA)) throw new Error(`no vault data at ${DATA}`);
      const settings: MugsSettings = JSON.parse(readFileSync(DATA, "utf8"));

      // Only the mappings with no baseline (the ones the plugin keeps skipping).
      const targets: FolderMapping[] = settings.mappings.filter((m) => !settings.lastSync[m.id]?.lastRemoteSha);
      console.log(`\n[live-diag] ${targets.length} no-baseline mappings:`,
        targets.map((m) => m.label).join(", "));

      // Read-only view of the persisted state; records are printed, NOT written back
      // (the plugin owns data.json and self-heals the baseline once the remote advances).
      const lastSync: LastSyncAccessor = {
        lastRemoteSha: (id) => settings.lastSync[id]?.lastRemoteSha,
        recordPull: (id, sha) => console.log(`[record] pull  ${id.slice(0, 8)} -> ${sha.slice(0, 8)}`),
        recordPush: (id, sha) => console.log(`[record] push  ${id.slice(0, 8)} -> ${sha.slice(0, 8)}`),
        recordConflict: (id) => console.log(`[record] conflict ${id.slice(0, 8)}`),
        vaultPopulated: (id) => settings.lastSync[id]?.vaultPopulated,
        recordVaultSync: (id) => console.log(`[record] vault-populated ${id.slice(0, 8)}`),
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
    },
    600_000,
  );
});
