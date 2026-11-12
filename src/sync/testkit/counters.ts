/**
 * Reusable git-runner wrapper that counts invocations by verb.
 * Used for regression tests that measure git cost (e.g., idle probe).
 *
 * Usage:
 *   import { CountingRunner, totalGitInvocations, gitShowCount } from "./testkit";
 *   const runner = new CountingRunner();
 *   // pass to sync driver
 *   const git = totalGitInvocations(runner);
 *   const shows = gitShowCount(runner);
 */
import type { GitRunner, GitResult } from "../../git/types";
import { ChildProcessRunner } from "../../git/runner";

export class CountingRunner implements GitRunner {
  counts: Record<string, number> = {};
  private inner = new ChildProcessRunner();

  run(args: string[], opts?: any): Promise<GitResult> {
    const verb = args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? args[0];
    this.counts[verb] = (this.counts[verb] ?? 0) + 1;
    return this.inner.run(args, opts);
  }

  reset(): void {
    this.counts = {};
  }
}

/** Total number of git invocations recorded. */
export function totalGitInvocations(runner: CountingRunner): number {
  return Object.values(runner.counts).reduce((a, b) => a + b, 0);
}

/**
 * Count of `git show` calls.
 * In the git client, `git show REF:PATH` is reported with verb "show".
 */
export function gitShowCount(runner: CountingRunner): number {
  return runner.counts["show"] ?? 0;
}
