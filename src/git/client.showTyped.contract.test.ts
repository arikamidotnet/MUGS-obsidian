/**
 * Contract / integration tests for showTyped (S02).
 * These prove:
 * - success yields {kind:"content"}
 * - a missing path at a present ref yields {kind:"absent"} (never an error)
 * - a missing ref yields an error (never conflated with absent)
 * - auth/permission/corrupt failures are surfaced as errors
 *
 * The fake-runner tests validate the API shape and that the client
 * passes the right args. A small real-git test proves end-to-end
 * distinction between absent vs error.
 */
import { describe, it, expect } from "vitest";
import { GitClient } from "./client";
import type { GitResult, GitRunner } from "./types";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ChildProcessRunner } from "./runner";

class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; opts?: { cwd?: string; env?: Record<string, string> } }[] = [];
  constructor(private responder: (args: string[]) => GitResult) {}
  async run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult> {
    this.calls.push({ args, opts });
    return this.responder(args);
  }
}

const last = (r: FakeRunner) => r.calls[r.calls.length - 1];

function client(runner: FakeRunner) {
  return new GitClient(runner);
}

describe("GitClient.showTyped (S02) — contract with fake runner", () => {
  it("returns content on exit 0", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "hello\n", stderr: "" }));
    const res = await client(r).showTyped("HEAD", "notes/a.md");
    expect(res).toEqual({ kind: "content", content: "hello\n" });
    expect(last(r).args).toEqual(["show", "HEAD:notes/a.md"]);
  });

  it("maps a missing-blob classification to absent (not error)", async () => {
    const r = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: pathspec 'x.md' did not match any file(s) known to git" }));
    const res = await client(r).showTyped("HEAD", "x.md");
    expect(res).toEqual({ kind: "absent" });
  });

  it("surfaces missing-ref as an error (never absent)", async () => {
    const r = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: bad revision 'origin/nope'" }));
    const res = await client(r).showTyped("origin/nope", "any.md");
    if (res.kind !== "error") throw new Error("expected error");
    expect(res.error.kind).toBe("missing-ref");
  });

  it("surfaces auth/permission/corrupt as errors", async () => {
    const auth = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: Authentication failed" }));
    const a = await client(auth).showTyped("HEAD", "f");
    if (a.kind !== "error") throw new Error("expected error");
    expect(a.error.kind).toBe("auth");

    const perm = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: Permission denied" }));
    const p = await client(perm).showTyped("HEAD", "f");
    if (p.kind !== "error") throw new Error("expected error");
    expect(p.error.kind).toBe("permission");

    const bad = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "error: corrupt loose object" }));
    const b = await client(bad).showTyped("HEAD", "f");
    if (b.kind !== "error") throw new Error("expected error");
    expect(b.error.kind).toBe("corrupt");
  });
});

describe("GitClient.showTyped (S02) — real git distinction", () => {
  function makeRepo(): string {
    const d = mkdtempSync(join(tmpdir(), "mugs-showtyped-"));
    execSync("git init -q -b main .", { cwd: d });
    writeFileSync(join(d, "present.md"), "# present\n");
    execSync("git add present.md && git -c user.name=t -c user.email=t@l commit -q -m init", { cwd: d });
    return d;
  }
  function cleanup(d: string) { try { rmSync(d, { recursive: true, force: true }); } catch {} }

  it("returns absent for a path that does not exist at a valid ref", async () => {
    const dir = makeRepo();
    try {
      const c = new GitClient(new ChildProcessRunner()).at(dir);
      const res = await c.showTyped("HEAD", "absent.md");
      expect(res).toEqual({ kind: "absent" });
    } finally {
      cleanup(dir);
    }
  });

  it("returns content for a path that does exist", async () => {
    const dir = makeRepo();
    try {
      const c = new GitClient(new ChildProcessRunner()).at(dir);
      const res = await c.showTyped("HEAD", "present.md");
      if (res.kind !== "content") throw new Error("expected content");
      expect(res.content).toContain("present");
    } finally {
      cleanup(dir);
    }
  });

  it("returns a missing-ref error (never absent) for a nonexistent ref", async () => {
    const dir = makeRepo();
    try {
      const c = new GitClient(new ChildProcessRunner()).at(dir);
      const res = await c.showTyped("no-such-ref", "present.md");
      if (res.kind !== "error") throw new Error("expected error");
      // Diagnostic: surface the actual classification and message so we can
      // tighten the regex in classifyShowError if needed.
      // (Do not treat this as a contract assertion; the kind assertion below is the contract.)
      // eslint-disable-next-line no-console
      console.log("[S02-DIAG] missing-ref test got kind=", res.error.kind, "message=", JSON.stringify(res.error.message));
      expect(res.error.kind).toBe("missing-ref");
    } finally {
      cleanup(dir);
    }
  });
});
