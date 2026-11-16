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
 *  256MB comfortably covers file reads while keeping a runaway command bounded.
 *  Smaller per-operation caps (64MB default, 16MB blob) were proposed but never
 *  enforced; every operation retains this single accepted PER STREAM limit. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Copy into bounded blocks once, then join once at completion (not per event).
 * Fixed blocks also bound metadata if a process dribbles one byte per event.
 * Exported for boundary tests without allocating hundreds of megabytes. */
export class BoundedOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  private tailSize = 0;

  constructor(private readonly cap: number) {}

  append(chunk: Buffer): boolean {
    const remaining = this.cap - this.size;
    const accepted = Math.min(chunk.length, remaining);
    let offset = 0;
    while (offset < accepted) {
      let tail = this.chunks[this.chunks.length - 1];
      if (!tail || this.tailSize === tail.length) {
        tail = Buffer.allocUnsafe(Math.min(64 * 1024, this.cap - this.size));
        this.chunks.push(tail);
        this.tailSize = 0;
      }
      const bytes = Math.min(accepted - offset, tail.length - this.tailSize);
      chunk.copy(tail, this.tailSize, offset, offset + bytes);
      this.tailSize += bytes;
      this.size += bytes;
      offset += bytes;
    }
    return chunk.length <= remaining;
  }

  text(): string {
    const content = Buffer.concat(this.chunks, this.size).toString("utf8");
    this.chunks = [];
    this.size = 0;
    this.tailSize = 0;
    return content;
  }
}

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
    // Cancellation is also a no-side-effects gate: do not start an already
    // cancelled clone/commit/process and then try to race its termination.
    if (opts.signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "[cancelled]" });
    return new Promise<GitResult>((resolve) => {
      const env = opts.env ? { ...process.env, ...opts.env } : undefined;
      const spawnOpts: any = {
        cwd: opts.cwd,
        env,
        // detached allows killing the whole tree via negative pid on POSIX.
        detached: process.platform !== "win32",
        // We handle output ourselves to enforce per-invocation caps and to
        // be able to abort promptly on signal/timeout.
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      };

      let cp: ChildProcess;
      try {
        cp = spawn(this.bin, args, spawnOpts);
      } catch (e: any) {
        // Binary not found or not executable at spawn time.
        return resolve({ code: 127, stdout: "", stderr: `${this.bin} could not run: ${e?.message ?? String(e)}` });
      }

      const stdout = new BoundedOutput(MAX_OUTPUT_BYTES);
      const stderr = new BoundedOutput(MAX_OUTPUT_BYTES);
      let finished = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;

      function finish(code: number, message = "") {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        opts.signal?.removeEventListener("abort", cancel);
        cp.stdout?.removeAllListeners("data");
        cp.stderr?.removeAllListeners("data");
        try { cp?.stdout?.destroy(); } catch {}
        try { cp?.stderr?.destroy(); } catch {}
        resolve({ code, stdout: stdout.text(), stderr: stderr.text() + message });
      }

      function onData(which: "out" | "err", chunk: Buffer) {
        if (finished) return;
        const target = which === "out" ? stdout : stderr;
        if (!target.append(chunk)) {
          // Enforce cap: treat as a hard truncation + non-zero to surface boundedness.
          killTree(cp);
          finish(1, "\n[truncated: output cap exceeded]");
        }
      }

      function cancel() {
        if (!finished) {
          killTree(cp);
          finish(1, "[cancelled]");
        }
      }

      cp.stdout?.on("data", (c: Buffer) => onData("out", c));
      cp.stderr?.on("data", (c: Buffer) => onData("err", c));
      if (opts.input !== undefined) {
        // Git may exit before consuming stdin; EPIPE must not escape as an
        // unhandled stream error. The child's exit/result remains authoritative.
        cp.stdin?.on("error", () => {});
        cp.stdin?.end(opts.input);
      }

      cp.on("error", (e: any) => {
        // Spawn-level or subsequent I/O error.
        const msg = `${this.bin} could not run: ${e?.message ?? String(e)}`;
        if (!finished) finish(127, msg);
      });

      cp.on("close", (code: number | null) => {
        if (!finished) finish(code ?? 1);
      });

      // Hard deadline. Declared BEFORE the signal wiring below: an already-aborted
      // AbortSignal calls finish() synchronously, and finish() clears this timer —
      // touching an uninitialized const there would throw (temporal dead zone) and
      // reject the promise instead of resolving with a cancelled result.
      const to = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 0;
      deadline = to
        ? setTimeout(() => {
            if (!finished) {
              killTree(cp);
              finish(1, "[timeout]");
            }
          }, to)
        : undefined;

      // Wire cooperative cancellation via AbortSignal.
      if (opts.signal) {
        opts.signal.addEventListener("abort", cancel, { once: true });
        // Cover cancellation during spawn/setup as well as before entry.
        if (opts.signal.aborted) {
          cancel();
        }
      }
    });
  }
}
