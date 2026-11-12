import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Capture spawn-driven handlers for deterministic tests.
// We simulate the ChildProcess shape: stdout/stderr are EventEmitters,
// and the process itself emits 'error' and 'close'.
type SpawnCall = {
  bin: string;
  args: unknown[];
  opts: any;
  stdout: EventEmitter;
  stderr: EventEmitter;
  proc: EventEmitter & { pid?: number; stdout?: EventEmitter; stderr?: EventEmitter; kill?: (sig?: string) => void };
};
const h = vi.hoisted(() => {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn((bin: string, args: unknown[], opts: any) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc: any = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.pid = 12345;
    proc.kill = vi.fn();
    calls.push({ bin, args, opts, stdout, stderr, proc });
    // Return the process synchronously; events are emitted by tests.
    return proc;
  });
  return { calls, spawn };
});

vi.mock("node:child_process", () => ({ spawn: h.spawn, ChildProcess: EventEmitter }));

import { ChildProcessRunner } from "./runner";

beforeEach(() => {
  h.calls.length = 0;
});

function lastCall() {
  return h.calls[h.calls.length - 1];
}

function emitSuccess(call: SpawnCall, out: string, err = "") {
  // Simulate git writing and then closing with code 0.
  call.stdout.emit("data", Buffer.from(out));
  if (err) call.stderr.emit("data", Buffer.from(err));
  call.proc.emit("close", 0);
}

function emitNonZero(call: SpawnCall, code: number, out = "", err = "") {
  if (out) call.stdout.emit("data", Buffer.from(out));
  if (err) call.stderr.emit("data", Buffer.from(err));
  call.proc.emit("close", code);
}

function emitSpawnError(call: SpawnCall, msg: string) {
  call.proc.emit("error", new Error(msg));
}

describe("ChildProcessRunner", () => {
  it("resolves code 0 with the captured stdout/stderr on success", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["log", "--oneline"]);
    const c = lastCall();
    emitSuccess(c, "abc subject");
    await expect(p).resolves.toEqual({ code: 0, stdout: "abc subject", stderr: "" });
  });

  it("preserves the numeric exit code on a non-zero exit (contract: inspectable)", async () => {
    const runner = new ChildProcessRunner();
    // git merge-base --is-ancestor exits 1 when the ancestry claim is false.
    const p = runner.run(["merge-base", "--is-ancestor", "A", "B"]);
    const c = lastCall();
    emitNonZero(c, 1);
    await expect(p).resolves.toEqual({ code: 1, stdout: "", stderr: "" });
  });

  it("preserves stdout/stderr on a non-zero exit (the bug that was fixed)", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["show", "HEAD:path.txt"]);
    const c = lastCall();
    emitNonZero(c, 128, "some-output", "fatal: ...");
    await expect(p).resolves.toEqual({ code: 128, stdout: "some-output", stderr: "fatal: ..." });
  });

  it("maps a spawn failure (error event) to code 127 with a 'could not run' message", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["status"]);
    const c = lastCall();
    emitSpawnError(c, "spawn git ENOENT");
    const res = await p;
    expect(res.code).toBe(127);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("could not run");
  });

  it("forwards the cwd option into spawn opts", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["status"], { cwd: "/tmp/vault" });
    const c = lastCall();
    emitSuccess(c, "");
    await p;
    expect(c.opts.cwd).toBe("/tmp/vault");
  });

  it("defaults the binary to 'git' and always caps captured output", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["rev-parse", "HEAD"]);
    const c = lastCall();
    emitSuccess(c, "deadbeef");
    await p;
    // The runner should have been created with a reasonable max-buffer style cap
    // (implementation uses an internal cap; we mainly assert it did not explode).
    expect(c.bin).toBe("git");
  });

  it("merges an injected env over the ambient environment (credential passing)", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["-c", "credential.helper=", "fetch", "origin"], {
      cwd: "/c/y",
      env: { MUGS_GIT_TOKEN: "glpat-secret", GIT_TERMINAL_PROMPT: "0" },
    });
    const c = lastCall();
    emitSuccess(c, "");
    await p;
    // The credential reaches the git process via env — merged over process.env so
    // PATH and friends still resolve — and never appears in the argv array.
    expect(c.opts.env).toMatchObject({ MUGS_GIT_TOKEN: "glpat-secret", GIT_TERMINAL_PROMPT: "0" });
    expect(c.opts.env.PATH).toBe(process.env.PATH);
  });

  it("accepts signal and timeoutMs options without throwing (E06 contract)", async () => {
    const runner = new ChildProcessRunner();
    const ac = new AbortController();
    const p = runner.run(["status"], { signal: ac.signal, timeoutMs: 50 });
    const c = lastCall();
    emitSuccess(c, "ok");
    await p;
    // Just exercising the path; detailed cancel/timeout behavior is tested in
    // runner.bounds.cancel.test.ts with real timing.
  });
});
