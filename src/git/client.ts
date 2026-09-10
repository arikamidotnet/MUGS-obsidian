/**
 * MUGS — thin git client.
 *
 * Wraps a small set of git operations the sync engine needs. Every call goes
 * through the injected GitRunner (see types.ts), so tests can assert on the exact
 * args and canned output without touching a repository or the filesystem.
 */
import type { GitResult, GitRunner } from "./types";

export type PullMode = "ff" | "rebase" | "merge";

export interface Author {
  name: string;
  email: string;
}

export class GitClient {
  constructor(private runner: GitRunner, private cwd?: string) {}

  private opts() {
    return this.cwd ? { cwd: this.cwd } : undefined;
  }

  /** Run a command that must succeed; throws with git's stderr otherwise. */
  private async must(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
    const r = await this.runner.run(args, opts ?? this.opts());
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r;
  }

  /** Run a command and return the raw result (for introspecting exit codes). */
  run(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
    return this.runner.run(args, opts ?? this.opts());
  }

  async init(): Promise<GitResult> {
    return this.must(["init"]);
  }

  async clone(url: string, dir: string): Promise<GitResult> {
    return this.must(["clone", url, dir]);
  }

  async fetch(remote = "origin"): Promise<GitResult> {
    return this.must(["fetch", remote]);
  }

  async pull(remote: string, branch: string, mode: PullMode = "rebase"): Promise<GitResult> {
    const args =
      mode === "ff" ? ["pull", "--ff-only", remote, branch] : mode === "merge" ? ["pull", remote, branch] : ["pull", "--rebase", remote, branch];
    return this.must(args);
  }

  async checkout(branch: string): Promise<GitResult> {
    return this.must(["checkout", branch]);
  }

  async add(paths?: string[]): Promise<GitResult> {
    return this.must(paths && paths.length > 0 ? ["add", ...paths] : ["add", "."]);
  }

  async commit(message: string, author?: Author): Promise<GitResult> {
    const args = ["commit", "--message", message];
    if (author) args.push("--author", `${author.name} <${author.email}>`);
    return this.must(args);
  }

  async push(remote = "origin", branch?: string): Promise<GitResult> {
    return this.must(branch ? ["push", remote, branch] : ["push", remote]);
  }

  /** Resolve a ref to its full SHA. */
  async revParse(ref: string): Promise<string> {
    const r = await this.run(["rev-parse", ref]);
    if (r.code !== 0) throw new Error(`rev-parse ${ref} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.trim();
  }

  async currentHead(): Promise<string> {
    return this.revParse("HEAD");
  }

  /** True when `ancestor` is an ancestor of any SHA in `descendants`. */
  async isAncestor(ancestor: string, descendants: string[]): Promise<boolean> {
    for (const d of descendants) {
      const r = await this.run(["merge-base", "--is-ancestor", ancestor, d]);
      if (r.code === 0) return true;
    }
    return false;
  }

  /** Oneline commit subjects for a ref range (e.g. "base..HEAD"), newest last. */
  async logLines(range: string): Promise<string[]> {
    const r = await this.run(["log", "--oneline", range]);
    if (r.code !== 0) throw new Error(`git log ${range} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** Unified diff between two refs (empty string when identical). */
  async diff(from: string, to: string): Promise<string> {
    const r = await this.run(["diff", `${from}...${to}`]);
    if (r.code !== 0) throw new Error(`git diff ${from}...${to} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** `git status --porcelain` lines. */
  async porcelain(): Promise<string[]> {
    const r = await this.run(["status", "--porcelain"]);
    if (r.code !== 0) throw new Error(`git status failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }
}
