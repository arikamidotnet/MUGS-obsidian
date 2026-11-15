import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { GitClient } from "./client";
import { ChildProcessRunner } from "./runner";

describe("typed missing-path reads with deterministic HTTP-like SHA digits", () => {
  it.each(["401", "403"])("treats an absent path at a real %s-containing SHA as absent, not auth", async (digits) => {
    const dir = mkdtempSync(join(tmpdir(), "mugs-show-hash-"));
    const git = (args: string[], input?: string) => execFileSync("git", args, {
      cwd: dir, input, encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_DEFAULT_HASH: "sha1" },
    }).trim();
    try {
      git(["init", "-q"]);
      const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"], "");
      let commit = "", sha = "";
      // Hash candidates in memory, then store just the chosen immutable object.
      for (let seed = 0; seed < 100_000; seed++) {
        commit = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture ${seed}\n`;
        sha = createHash("sha1").update(`commit ${Buffer.byteLength(commit)}\0`).update(commit).digest("hex");
        if (sha.includes(digits)) break;
      }
      expect(sha).toContain(digits);
      expect(git(["hash-object", "-t", "commit", "-w", "--stdin"], commit)).toBe(sha);
      const client = new GitClient(new ChildProcessRunner()).at(dir);
      expect(await client.showTyped(sha, `new-${digits}.md`)).toEqual({ kind: "absent" });
      expect(await client.showTyped(sha, `renamed-${digits}.md`)).toEqual({ kind: "absent" });
      expect(await client.showTyped(sha, `status code: ${digits}.md`)).toEqual({ kind: "absent" });
      expect(await client.showTyped(sha, "authentication failed.md")).toEqual({ kind: "absent" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
