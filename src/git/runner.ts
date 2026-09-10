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
          if (err) {
            // Spawn failure (e.g. git not installed): surface a non-zero code.
            const code = typeof err.code === "number" ? err.code : 127;
            return resolve({ code, stdout: "", stderr: `${this.bin} could not run: ${err.message}` });
          }
          resolve({ code: 0, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    });
  }
}
