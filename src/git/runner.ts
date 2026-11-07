/**
 * MUGS — default GitRunner backed by the system `git` binary.
 *
 * Uses child_process.execFile (not shell) so args are passed as an argv array
 * with no shell interpolation. Always resolves with a GitResult — including
 * non-zero exit codes — so callers can inspect `code` (e.g. `git merge-base
 * --is-ancestor` exits 1 when the ancestry claim is false). Only spawn-level
 * failures (missing binary) reject.
 */
import { execFile } from "node:child_process";
import type { GitResult, GitRunner } from "./types";

/** Captured-output cap per git invocation. Node's 1MB default kills the child
 *  mid-command once stdout/stderr crosses it — e.g. `git show` of a large file or
 *  a diff over a big tree — which surfaces as a phantom "could not run" failure.
 *  256MB comfortably covers file reads while keeping a runaway command bounded. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export class ChildProcessRunner implements GitRunner {
  constructor(private bin = "git") {}

  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      // Merge any injected env over the ambient one so PATH etc. still resolve;
      // this is how a per-invocation credential reaches git without touching argv.
      // maxBuffer is always applied so large outputs cannot kill the child.
      const execOpts: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer: number } = { maxBuffer: MAX_OUTPUT_BYTES };
      if (opts?.cwd) execOpts.cwd = opts.cwd;
      if (opts?.env) execOpts.env = { ...process.env, ...opts.env };
      execFile(
        this.bin,
        args,
        execOpts,
        (err, stdout, stderr) => {
          const out = stdout.toString();
          const errText = stderr.toString();
          if (err) {
            // A real non-zero exit carries a numeric code AND populated streams; preserve
            // them so callers can inspect `code` and output (e.g. git merge-base --is-ancestor
            // exits 1 when the ancestry claim is false). Discarding stdout/stderr here was a
            // latent bug: any command that emits output before exiting non-zero lost it.
            if (typeof err.code === "number") {
              resolve({ code: err.code, stdout: out, stderr: errText });
              return;
            }
            // Spawn-level failure (binary missing/unexecutable): no output was produced.
            return resolve({ code: 127, stdout: "", stderr: `${this.bin} could not run: ${err.message}` });
          }
          resolve({ code: 0, stdout: out, stderr: errText });
        },
      );
    });
  }
}
