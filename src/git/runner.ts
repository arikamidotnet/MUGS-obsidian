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

export class ChildProcessRunner implements GitRunner {
  constructor(private bin = "git") {}

  run(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
    return new Promise<GitResult>((resolve, reject) => {
      execFile(
        this.bin,
        args,
        opts?.cwd ? { cwd: opts.cwd } : undefined,
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
