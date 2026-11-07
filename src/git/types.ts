/**
 * MUGS — git client.
 *
 * A thin wrapper around the system `git` binary. All command execution goes
 * through an injectable GitRunner seam so the client is unit-testable without a
 * real repository: tests supply a fake runner that records args and returns
 * canned output, while production uses ChildProcessRunner (see runner.ts).
 */

/** Result of running a git command: exit code plus captured streams. */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Minimal command-runner seam. Resolves for any exit code so callers can inspect `code`. */
export interface GitRunner {
  /** `env` entries are merged over the ambient environment for this invocation
   *  (used to hand network commands a credential without persisting it). */
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult>;
}
