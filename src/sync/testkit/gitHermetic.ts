/**
 * Test-only helpers for hermetic real-git tests.
 *
 * Goals:
 * - Never depend on machine global git config.
 * - Provide stable identity for commits that the SUT performs via local
 *   providers (until the production identity seam is hardened).
 * - Supply helpers so every manual `git` operation in tests is hermetic.
 *
 * Usage (in a test file):
 *   import { installHermeticGitIdentity, hermeticExecSync, HERMETIC_GIT_ENV } from "./testkit";
 *   installHermeticGitIdentity(); // at module scope or beforeAll
 *
 * The env vars are what `git` falls back to when neither --author nor
 * GIT_COMMITTER_* are passed on a given invocation. ChildProcessRunner
 * inherits process.env for calls that do not override env.
 */
import { execSync, type ExecSyncOptions } from "node:child_process";

export const HERMETIC_GIT_ENV = {
  GIT_AUTHOR_NAME: "Mugs Test",
  GIT_AUTHOR_EMAIL: "test@mugs.local",
  GIT_COMMITTER_NAME: "Mugs Test",
  GIT_COMMITTER_EMAIL: "test@mugs.local",
} as const;

/**
 * Install (or ensure) hermetic identity into the current process.env.
 * Safe to call multiple times; does not overwrite if already set by caller.
 * Call once at the top of any real-git e2e/harness that must run without
 * a global ~/.gitconfig.
 */
export function installHermeticGitIdentity(): void {
  const e = process.env;
  e.GIT_AUTHOR_NAME = e.GIT_AUTHOR_NAME || HERMETIC_GIT_ENV.GIT_AUTHOR_NAME;
  e.GIT_AUTHOR_EMAIL = e.GIT_AUTHOR_EMAIL || HERMETIC_GIT_ENV.GIT_AUTHOR_EMAIL;
  e.GIT_COMMITTER_NAME = e.GIT_COMMITTER_NAME || HERMETIC_GIT_ENV.GIT_COMMITTER_NAME;
  e.GIT_COMMITTER_EMAIL = e.GIT_COMMITTER_EMAIL || HERMETIC_GIT_ENV.GIT_COMMITTER_EMAIL;
}

/**
 * execSync that forces the hermetic identity env for this command only.
 * Use for all manual setup commits, clones, pushes inside tests.
 */
export function hermeticExecSync(command: string, options: ExecSyncOptions = {}): Buffer {
  const out = execSync(command, {
    ...options,
    env: {
      ...process.env,
      ...HERMETIC_GIT_ENV,
      ...(options.env || {}),
    },
    // Keep output quiet unless the caller asked for it; errors still throw.
    stdio: options.stdio ?? "pipe",
  });
  return Buffer.from(out as any);
}

/**
 * Convenience: return a fresh env block you can spread into ChildProcessRunner
 * call sites or execFile if you want to be explicit for a single git invocation.
 */
export function hermeticEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...(base || process.env), ...HERMETIC_GIT_ENV };
}
