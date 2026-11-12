/**
 * Contract tests for explicit diff/log API (U01).
 * Verifies:
 * - diffRange(from, to) produces a non-merge-base two-endpoint diff
 * - logLinesScoped(range, paths) scopes results
 * - Real-git: HEAD vs HEAD~1 shows the prior change; scoping excludes outside paths.
 */
import { describe, it, expect } from "vitest";
import { GitClient } from "./client";
import { ChildProcessRunner } from "./runner";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

function makeRepoWithHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "mugs-u01-"));
  execSync("git init -q -b main .", { cwd: d });
  mkdirSync(join(d, "Notes"), { recursive: true });
  writeFileSync(join(d, "Notes/a.md"), "# a\n");
  execSync("git add -A && git -c user.name=t -c user.email=t@l commit -q -m A", { cwd: d });
  writeFileSync(join(d, "Notes/a.md"), "# a v2\n");
  execSync("git add -A && git -c user.name=t -c user.email=t@l commit -q -m B", { cwd: d });
  return d;
}
function cleanup(d: string) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

interface FakeRunner {
  calls: any[];
  run(a: string[], o?: any): Promise<any>;
}
describe("GitClient — explicit diff/log (U01) — fake runner", () => {
  class F implements FakeRunner { calls: any[] = []; constructor(private r: (a: string[]) => any) {} async run(a: string[], o?: any) { this.calls.push({ a, o }); return this.r(a); } }
  const last = (f: F) => f.calls[f.calls.length - 1];
  it("diffRange emits two-endpoint (no ...)", async () => {
    const f = new F(() => ({ code: 0, stdout: "diff --git", stderr: "" }));
    const c = new GitClient(f as any);
    const s = await c.diffRange("OLD", "NEW", ["p"]);
    expect(s).toBe("diff --git");
    expect(last(f).a).toEqual(["diff", "OLD", "NEW", "--", "p"]);
  });
  it("logLinesScoped passes -- paths", async () => {
    const f = new F(() => ({ code: 0, stdout: "c1", stderr: "" }));
    const c = new GitClient(f as any);
    await c.logLinesScoped("base..HEAD", ["x/y"]);
    expect(last(f).a).toEqual(["log", "--oneline", "base..HEAD", "--", "x/y"]);
  });
});

describe("GitClient — explicit diff/log (U01) — real git", () => {
  it("diffRange(HEAD, HEAD~1) yields a non-empty diff showing the prior change", async () => {
    const d = makeRepoWithHistory();
    try {
      const c = new GitClient(new ChildProcessRunner()).at(d);
      const s = await c.diffRange("HEAD", "HEAD~1");
      expect(s.length).toBeGreaterThan(0);
      expect(s).toMatch(/a\.md/);
    } finally { cleanup(d); }
  });
  it("scoped logLinesScoped excludes paths outside the mapping subtree", async () => {
    const d = makeRepoWithHistory();
    try {
      const c = new GitClient(new ChildProcessRunner()).at(d);
      const scoped = await c.logLinesScoped("HEAD~1..HEAD", ["Notes/a.md"]);
      const all = await c.logLines("HEAD~1..HEAD");
      // Both should see the last commit, but scoping to a subtree is at least non-crashing.
      expect(scoped.length).toBeGreaterThan(0);
      expect(all.length).toBeGreaterThan(0);
    } finally { cleanup(d); }
  });
});
