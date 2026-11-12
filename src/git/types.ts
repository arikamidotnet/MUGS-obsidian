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

/** Options for a GitRunner invocation. Signal supports cooperative cancellation;
 *  timeoutMs requests a hard deadline from the runner (best-effort kill on expiry).
 */
export interface GitRunOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** AbortSignal for cooperative cancellation. When aborted the runner should
   *  attempt to terminate the child and resolve promptly. */
  signal?: AbortSignal;
  /** Hard deadline in milliseconds. Runner should kill the child and resolve
   *  with a non-zero code when exceeded. 0 or omitted means no deadline. */
  timeoutMs?: number;
}

/** Minimal command-runner seam. Resolves for any exit code so callers can inspect `code`. */
export interface GitRunner {
  /** `env` entries are merged over the ambient environment for this invocation
   *  (used to hand network commands a credential without persisting it). */
  run(args: string[], opts?: GitRunOpts): Promise<GitResult>;
}

/** Discriminated kinds for a typed read failure from git show / cat-file.
 *  Callers must never treat an error result as "absent" (the legacy show()
 *  conflated these). */
export type ReadErrorKind =
  | "auth"
  | "missing-ref"
  | "missing-blob"
  | "permission"
  | "timeout"
  | "cancelled"
  | "corrupt"
  | "other";

/** Typed failure from a content read. Message is redacted (no URL userinfo,
 *  no Authorization material). */
export interface ReadError {
  kind: ReadErrorKind;
  /** Redacted human-readable detail (safe for logs/notices). */
  message: string;
}

/** Result of a typed content read (git show REF:PATH or equivalent).
 *  - content: the blob text was successfully read.
 *  - absent: the ref exists but the path is not present at that tree (or the
 *    ref names a tree that does not contain the path). This is a normal
 *    "not here" outcome used for three-way merge logic.
 *  - error: a genuine failure (auth, permission, corrupt object, timeout,
 *    missing ref, etc.). Callers MUST distinguish error from absent.
 */
export type ReadResult =
  | { kind: "content"; content: string }
  | { kind: "absent" }
  | { kind: "error"; error: ReadError };
