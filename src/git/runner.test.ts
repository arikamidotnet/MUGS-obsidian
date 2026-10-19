import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the execFile callbacks so tests can drive each outcome deterministically.
type Cb = (err: unknown, stdout: string, stderr: string) => void;
const h = vi.hoisted(() => {
  const handlers: Cb[] = [];
  const execFile = vi.fn((_bin: string, _args: unknown[], _opts: unknown, cb: Cb): void => {
    handlers.push(cb);
  });
  return { handlers, execFile };
});

vi.mock("node:child_process", () => ({ execFile: h.execFile }));

import { ChildProcessRunner } from "./runner";

beforeEach(() => {
  h.handlers.length = 0;
});

describe("ChildProcessRunner", () => {
  it("resolves code 0 with the captured stdout/stderr on success", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["log", "--oneline"]);
    h.handlers[0](null, "abc subject", "");
    await expect(p).resolves.toEqual({ code: 0, stdout: "abc subject", stderr: "" });
  });

  it("preserves the numeric exit code on a non-zero exit (contract: inspectable)", async () => {
    const runner = new ChildProcessRunner();
    // git merge-base --is-ancestor exits 1 when the ancestry claim is false.
    const p = runner.run(["merge-base", "--is-ancestor", "A", "B"]);
    h.handlers[0]({ code: 1, message: "command failed" }, "", "");
    await expect(p).resolves.toEqual({ code: 1, stdout: "", stderr: "" });
  });

  it("preserves stdout/stderr on a non-zero exit (the bug that was fixed)", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["show", "HEAD:path.txt"]);
    h.handlers[0]({ code: 128, message: "fatal: bad" }, "some-output", "fatal: ...");
    await expect(p).resolves.toEqual({ code: 128, stdout: "some-output", stderr: "fatal: ..." });
  });

  it("maps a spawn failure (non-numeric code) to code 127 with a 'could not run' message", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["status"]);
    h.handlers[0]({ code: "ENOENT", message: "spawn git ENOENT" }, "", "");
    await expect(p).resolves.toEqual({
      code: 127,
      stdout: "",
      stderr: expect.stringContaining("could not run"),
    });
  });

  it("maps a spawn failure with no code at all to code 127", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["status"]);
    h.handlers[0]({ message: "boom" }, "", "");
    await expect(p).resolves.toEqual({ code: 127, stdout: "", stderr: expect.stringContaining("could not run") });
  });

  it("forwards the cwd option to execFile", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["status"], { cwd: "/tmp/vault" });
    h.handlers[0](null, "", "");
    await p;
    expect(h.execFile).toHaveBeenCalledWith("git", ["status"], { cwd: "/tmp/vault" }, expect.any(Function));
  });

  it("defaults the binary to 'git'", async () => {
    const runner = new ChildProcessRunner();
    const p = runner.run(["rev-parse", "HEAD"]);
    h.handlers[0](null, "deadbeef", "");
    await p;
    expect(h.execFile).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], undefined, expect.any(Function));
  });
});
