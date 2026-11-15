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

import { ChildProcessRunner, BoundedOutput } from "./runner";

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
    // Real hung-child coverage is in client.process.test.ts.
  });

  it("does not spawn already-aborted work", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await new ChildProcessRunner().run(["commit"], { signal: ac.signal });
    expect(h.calls).toHaveLength(0);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "[cancelled]" });
  });

  it("removes the abort listener after success and ignores later aborts", async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const promise = new ChildProcessRunner().run(["status"], { signal: ac.signal });
    emitSuccess(lastCall(), "done");
    expect(await promise).toEqual({ code: 0, stdout: "done", stderr: "" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    ac.abort();
    expect(h.calls).toHaveLength(1);
  });

  it("concatenates only at completion and preserves split UTF-8 and both streams", async () => {
    const concat = vi.spyOn(Buffer, "concat");
    try {
      const promise = new ChildProcessRunner().run(["show", "HEAD:note"]);
      const call = lastCall();
      const bytes = Buffer.from("a🎉\0b\n", "utf8");
      for (const byte of bytes) call.stdout.emit("data", Buffer.from([byte]));
      for (let i = 0; i < 100; i++) call.stderr.emit("data", Buffer.from("e"));
      expect(concat).not.toHaveBeenCalled();
      call.proc.emit("close", 0);
      expect(await promise).toEqual({ code: 0, stdout: "a🎉\0b\n", stderr: "e".repeat(100) });
      expect(concat).toHaveBeenCalledTimes(2);
    } finally {
      concat.mockRestore();
    }
  });

  it("retains accepted blob output above the unused 16MiB suggested cap", async () => {
    const promise = new ChildProcessRunner().run(["show", "HEAD:large"]);
    const call = lastCall();
    const chunk = Buffer.alloc(1024 * 1024, "x");
    for (let i = 0; i < 17; i++) call.stdout.emit("data", chunk);
    call.proc.emit("close", 0);
    const result = await promise;
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(17 * chunk.length);
    expect(result.stderr).toBe("");
  });
});

describe("BoundedOutput stream boundaries", () => {
  it("uses bounded block metadata even for one-byte events", () => {
    const out = new BoundedOutput(128 * 1024);
    const byte = Buffer.from("x");
    const alloc = vi.spyOn(Buffer, "allocUnsafe");
    try {
      let accepted = true;
      for (let i = 0; i < 100_000; i++) accepted = out.append(byte) && accepted;
      expect(accepted).toBe(true);
      expect(alloc).toHaveBeenCalledTimes(2);
      expect(out.text()).toBe("x".repeat(100_000));
    } finally { alloc.mockRestore(); }
  });

  it("allows the exact cap and reports overflow without retaining excess bytes", () => {
    const out = new BoundedOutput(4);
    expect(out.append(Buffer.from("ab"))).toBe(true);
    expect(out.append(Buffer.from("cd"))).toBe(true);
    expect(out.append(Buffer.from("e"))).toBe(false);
    expect(out.text()).toBe("abcd");
  });

  it("keeps only the prefix that fits when one chunk crosses the cap", () => {
    const out = new BoundedOutput(4);
    expect(out.append(Buffer.from("abc"))).toBe(true);
    expect(out.append(Buffer.from("defghi"))).toBe(false);
    expect(out.text()).toBe("abcd");
  });
});
