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

/** An author aggregated over a log range: commit count + latest author timestamp. */
export interface AuthorActivity {
  name: string;
  /** Git author email, when known. */
  email?: string;
  /** Number of commits authored in the queried range. */
  commitCount: number;
  /** Latest author timestamp (epoch seconds) in the range, if any. */
  lastActivityAt?: number;
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

  /**
   * Recent committers for a ref range, aggregated by author name. Parses
   * `git log --format=%an%x1f%ae%x1f%at%x1e` — unit separators keep names/emails
   * containing spaces or commas intact. Commit count and latest timestamp are
   * summed/per-author so the result feeds the membership view's activity signal.
   * Sorted newest-first; `limit` caps total commits scanned.
   */
  async recentAuthors(range: string, limit = 100): Promise<AuthorActivity[]> {
    const fmt = "%an%x1f%ae%x1f%at";
    const r = await this.run(["log", `--limit=${limit}`, `--format=${fmt}`, range]);
    if (r.code !== 0) throw new Error(`git log ${range} failed (${r.code}): ${r.stderr.trim()}`);
    const byName = new Map<string, AuthorActivity>();
    for (const rec of r.stdout.split("\u001e").filter((l) => l.length > 0)) {
      const [name, email, ts] = rec.split("\u001f");
      if (!name) continue;
      const epoch = ts ? Number.parseInt(ts, 10) : NaN;
      const prev = byName.get(name);
      if (prev) {
        prev.commitCount += 1;
        if (!Number.isNaN(epoch) && (prev.lastActivityAt ?? 0) < epoch) prev.lastActivityAt = epoch;
      } else {
        byName.set(name, {
          name,
          email: email || undefined,
          commitCount: 1,
          lastActivityAt: Number.isNaN(epoch) ? undefined : epoch,
        });
      }
    }
    return [...byName.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }

  /**
   * Read file content at a ref (`REF:PATH`). Resolves undefined when the path is
   * absent at that ref (deleted, or never existed) so callers can treat it as a
   * deletion in a 3-way merge.
   */
  async show(ref: string, path: string): Promise<string | undefined> {
    const r = await this.run(["show", `${ref}:${path}`]);
    if (r.code !== 0) return undefined;
    return r.stdout;
  }

  /** Lowest common ancestor SHA of two refs (`git merge-base`). */
  async mergeBase(a: string, b: string): Promise<string> {
    const r = await this.run(["merge-base", a, b]);
    if (r.code !== 0) throw new Error(`merge-base ${a} ${b} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.trim();
  }

  /** Paths with uncommitted changes vs HEAD (staged + unstaged), one per line. Used
   *  to stage only in-scope working-tree changes on push. */
  async workingTreePaths(): Promise<string[]> {
    const r = await this.run(["diff", "--name-only", "HEAD"]);
    if (r.code !== 0) throw new Error(`git diff --name-only HEAD failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** Paths changed across a `base...HEAD`-style range, one per line. */
  async changedPaths(range: string): Promise<string[]> {
    const r = await this.run(["diff", "--name-only", range]);
    if (r.code !== 0) throw new Error(`git diff --name-only ${range} failed (${r.code}): ${r.stderr.trim()}`);
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
