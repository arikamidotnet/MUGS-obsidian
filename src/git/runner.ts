/**
 * MUGS — default GitRunner backed by the system `git` binary.
 *
 * Uses child_process.spawn (not shell) so args are passed as an argv array
 * with no shell interpolation. Always resolves with a GitResult — including
 * non-zero exit codes — so callers can inspect `code`. Supports cooperative
 * cancellation via AbortSignal and hard per-invocation deadlines via timeoutMs.
 * On cancel or timeout the runner attempts to terminate the child process tree.
 * Only spawn-level failures (missing binary) produce a 127 result.
 */
import { spawn, ChildProcess } from "node:child_process";
import type { GitResult, GitRunner, GitRunOpts } from "./types";

/** Captured-output cap per git invocation. Node's 1MB default kills the child
 *  mid-command once stdout/stderr crosses it — e.g. `git show` of a large file or
 *  a diff over a big tree — which surfaces as a phantom "could not run" failure.
 *  256MB comfortably covers file reads while keeping a runaway command bounded. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Per-op sensible caps (documented for callers/tests to rely on).
 *  Clone (first network or local pack) is given a generous cap.
 *  Blob reads and small queries use a tighter cap to surface runaway reads fast. */
export const OP_CAPS = {
  clone: MAX_OUTPUT_BYTES,
  default: 64 * 1024 * 1024, // 64MB for typical log/diff/status
  blob: 16 * 1024 * 1024, // 16MB for individual blob reads (show)
} as const;

function killTree(cp: ChildProcess): void {
  const pid = cp.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // /T kills the whole tree; /F force.
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Negative pid kills the process group when spawned with { detached: true }.
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {
    // best effort
  }
}

export class ChildProcessRunner implements GitRunner {
  constructor(private bin = "git") {}

  run(args: string[], opts: GitRunOpts = {}): Promise<GitResult> {
    return new Promise<GitResult>((resolve) => {
      const env = opts.env ? { ...process.env, ...opts.env } : undefined;
      const spawnOpts: any = {
        cwd: opts.cwd,
        env,
        // detached allows killing the whole tree via negative pid on POSIX.
        detached: process.platform !== "win32",
        // We handle output ourselves to enforce per-invocation caps and to
        // be able to abort promptly on signal/timeout.
        stdio: ["ignore", "pipe", "pipe"],
      };

      let cp: ChildProcess;
      try {
        cp = spawn(this.bin, args, spawnOpts);
      } catch (e: any) {
        // Binary not found or not executable at spawn time.
        return resolve({ code: 127, stdout: "", stderr: `${this.bin} could not run: ${e?.message ?? String(e)}` });
      }

      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let finished = false;
      let timedOut = false;

      const cap = MAX_OUTPUT_BYTES;

      function finish(code: number, out: Buffer, err: Buffer) {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        try { cp?.stdout?.destroy(); } catch {}
        try { cp?.stderr?.destroy(); } catch {}
        resolve({ code, stdout: out.toString("utf8"), stderr: err.toString("utf8") });
      }

      function onData(which: "out" | "err", chunk: Buffer) {
        const target = which === "out" ? stdoutBuf : stderrBuf;
        const next = Buffer.concat([target, chunk]);
        if (next.length > cap) {
          // Enforce cap: treat as a hard truncation + non-zero to surface boundedness.
          killTree(cp);
          finish(1, next.slice(0, cap), Buffer.concat([stderrBuf, Buffer.from("\n[truncated: output cap exceeded]")] ));
        } else if (which === "out") {
          stdoutBuf = next;
        } else {
          stderrBuf = next;
        }
      }

      cp.stdout?.on("data", (c: Buffer) => onData("out", c));
      cp.stderr?.on("data", (c: Buffer) => onData("err", c));

      cp.on("error", (e: any) => {
        // Spawn-level or subsequent I/O error.
        const msg = `${this.bin} could not run: ${e?.message ?? String(e)}`;
        if (!finished) finish(127, stdoutBuf, Buffer.concat([stderrBuf, Buffer.from(msg)]));
      });

      cp.on("close", (code: number | null) => {
        if (!finished) finish(code ?? 1, stdoutBuf, stderrBuf);
      });

      // Hard deadline. Declared BEFORE the signal wiring below: an already-aborted
      // AbortSignal calls finish() synchronously, and finish() clears this timer —
      // touching an uninitialized const there would throw (temporal dead zone) and
      // reject the promise instead of resolving with a cancelled result.
      const to = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
      const deadline = to
        ? setTimeout(() => {
            if (!finished) {
              timedOut = true;
              killTree(cp);
              finish(1, stdoutBuf, Buffer.concat([stderrBuf, Buffer.from("[timeout]")]));
            }
          }, to)
        : undefined;

      // Wire cooperative cancellation via AbortSignal.
      if (opts.signal) {
        if (opts.signal.aborted) {
          killTree(cp);
          finish(1, stdoutBuf, Buffer.concat([stderrBuf, Buffer.from("[cancelled]")]));
        } else {
          opts.signal.addEventListener("abort", () => {
            if (!finished) {
              killTree(cp);
              finish(1, stdoutBuf, Buffer.concat([stderrBuf, Buffer.from("[cancelled]")]));
            }
          }, { once: true });
        }
      }
    });
  }
}
