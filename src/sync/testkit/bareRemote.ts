/**
 * Bare-remote + seeded-repo builders for hermetic real-git regression tests.
 *
 * All builders:
 *  - Create a unique temp root.
 *  - Initialize a bare remote on main (or the requested branch).
 *  - Support a rich set of filename characteristics used across the matrix:
 *      unicode, spaces, quotes, leading dash, CRLF, binary-ish content,
 *      empty files, same-size-same-mtime replacements.
 *  - Return cleanup() that removes the entire tree.
 *
 * The builders are intentionally filesystem-only (no Obsidian adapter).
 * They seed a bare repo + optional working copy for manual setup, and
 * provide a VaultMirror + WorkingTreeWriter over a "vault" dir when needed.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticExecSync } from "./gitHermetic";

export interface BareRemoteSeedOptions {
  /** Branch name for the initial commit (default "main"). */
  branch?: string;
  /** Extra files to seed at remote init time (repo-relative). */
  files?: Record<string, string>;
}

export interface BareRemoteSeedResult {
  base: string;          // temp root (rm on cleanup)
  remotePlain: string;   // file path to bare repo
  cleanup: () => void;
}

/** Create an empty bare repo on the given branch and return its path. */
export function createBareRemote(opts: BareRemoteSeedOptions = {}): BareRemoteSeedResult {
  const base = mkdtempSync(join(tmpdir(), "mugs-seed-"));
  const remotePlain = join(base, "remote.git");
  const branch = opts.branch ?? "main";
  const work = join(base, "work");
  rmSync(base, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  hermeticExecSync(`git init -q -b ${branch} "${work}"`);
  if (opts.files) {
    for (const [p, c] of Object.entries(opts.files)) {
      const abs = join(work, p);
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, c);
    }
  }
  hermeticExecSync(`git -C "${work}" config user.name T && git -C "${work}" config user.email t@l`);
  hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m init`);
  hermeticExecSync(`git clone -q --bare "${work}" "${remotePlain}"`);
  rmSync(work, { recursive: true, force: true });
  return {
    base,
    remotePlain,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Common filename edge cases used in the regression matrix. */
export const EDGE_FILENAMES = [
  "Notes/naïve.md",                 // unicode
  "Notes/with space.md",            // space
  'Notes/quote"file.md',            // quote
  "Notes/-leading-dash.md",         // leading dash (pathspec hazard)
] as const;

/** Binary-ish and CRLF examples (contents only; extension still .md for text handling). */
export const SPECIAL_CONTENTS: Record<string, string> = {
  "Notes/crlf.md": "line1\r\nline2\r\n",
  "Notes/empty.md": "",
  "Notes/emoji.md": "🎉 multi-byte and emoji\n",
  "Notes/binary.bin": "\x00\x01\x02\xFF\xFE\x00data\n",
};

/**
 * Seed a bare remote with a representative set of tricky names + contents.
 * Returns the remote path and a cleanup.
 */
export function seedTrickyBareRemote(): { remotePlain: string; cleanup: () => void } {
  const { base, remotePlain, cleanup } = createBareRemote({
    files: {
      "Notes/diary.md": "# Diary\n\nbase\n",
      "Notes/keep.md": "keep\n",
      ...Object.fromEntries(EDGE_FILENAMES.map((p) => [p, `# ${p}\ncontent\n`])),
      ...SPECIAL_CONTENTS,
    },
  });
  return { remotePlain, cleanup };
}

/**
 * Create a same-size same-mtime replacement scenario inside a workdir.
 * Caller is responsible for committing the change if desired.
 */
export function writeSameSizeSameMtime(targetPath: string, content: string): void {
  // Write then backdate mtime to simulate a "restored" file with unchanged size/mtime.
  writeFileSync(targetPath, content);
  // Touch to a fixed past time; callers that need stat comparison will see same size/mtime.
  const past = new Date(Date.now() - 3_600_000);
  // We only control mtime here; tests that need the pair will combine with size.
  const { utimesSync } = require("node:fs");
  utimesSync(targetPath, past, past);
}

/** Multi-branch seed helper: create bare + two branches with divergent content. */
export function seedMultiBranchBare(): { remotePlain: string; cleanup: () => void; branchA: string; branchB: string } {
  const { base, remotePlain, cleanup: baseCleanup } = createBareRemote({ branch: "main", files: { "f.md": "main\n" } });
  const work = join(base, "work2");
  hermeticExecSync(`git clone -q "${remotePlain}" "${work}"`);
  hermeticExecSync(`git -C "${work}" checkout -q -b a`);
  writeFileSync(join(work, "a.md"), "A\n");
  hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m a`);
  hermeticExecSync(`git -C "${work}" checkout -q -b b`);
  writeFileSync(join(work, "b.md"), "B\n");
  hermeticExecSync(`git -C "${work}" add -A && git -C "${work}" commit -q -m b`);
  hermeticExecSync(`git -C "${work}" push -q origin a b`);
  rmSync(work, { recursive: true, force: true });
  return { remotePlain, cleanup: baseCleanup, branchA: "a", branchB: "b" };
}
