/**
 * MUGS — thin git client.
 *
 * Wraps a small set of git operations the sync engine needs. Every call goes
 * through the injected GitRunner (see types.ts), so tests can assert on the exact
 * args and canned output without touching a repository or the filesystem.
 */
import type { GitResult, GitRunner } from "./types";

export type PullMode = "ff" | "rebase" | "merge";

/** HTTP(S) credentials for network git commands (clone/fetch/pull/push). */
export interface GitAuth {
  /** Git username for HTTP basic auth (any non-empty value works for token auth;
   *  `oauth2` is the conventional GitLab value). */
  username: string;
  /** The token, used as the HTTP password. Never written to argv or disk. */
  token: string;
}

/** Environment variable carrying the git username to the credential helper. */
const AUTH_USER_ENV = "MUGS_GIT_USER";
/** Environment variable carrying the token to the credential helper. */
const AUTH_TOKEN_ENV = "MUGS_GIT_TOKEN";

/** The credential helper shell snippet: echoes username/password from the environment. */
const AUTH_HELPER = `!f() { echo username=$${AUTH_USER_ENV}; echo password=$${AUTH_TOKEN_ENV}; }; f`;

/** Options for {@link GitClient.clone}. */
export interface CloneOpts {
  /** Fetch a partial (blobless) clone — commit/tree history without file blobs,
   *  so a first sync downloads refs + the checked-out snapshot instead of the
   *  full pack history (missing blobs lazy-fetch on demand, authenticated). */
  filter?: "blob:none";
  /** Skip the working-tree checkout (implies the caller stages content itself,
   *  e.g. a push-first init that writes vault content before committing). */
  noCheckout?: boolean;
}

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
  constructor(private runner: GitRunner, private cwd?: string, private auth?: GitAuth) {}

  /** Return a client bound to a different working directory, reusing this runner + auth. */
  at(cwd: string): GitClient {
    return new GitClient(this.runner, cwd, this.auth);
  }

  /** Return a client bound to an HTTP(S) credential, reusing this runner + cwd. */
  withAuth(auth: GitAuth | undefined): GitClient {
    return new GitClient(this.runner, this.cwd, auth);
  }

  /**
   * Global git options supplying HTTP credentials without persisting them. The
   * first `-c credential.helper=` clears every inherited helper (e.g. a global
   * `glab`/GCM helper that has no token and answers with an empty password — the
   * exact "HTTP Basic: Access denied" failure), and the second registers ours,
   * which reads username/token from environment variables so the secret never
   * reaches argv, `.git/config`, or error output.
   */
  private authArgs(): string[] {
    if (!this.auth) return [];
    return ["-c", "credential.helper=", "-c", `credential.helper=${AUTH_HELPER}`];
  }

  /** Environment carrying the credentials for {@link AUTH_HELPER}. */
  private authEnv(): Record<string, string> | undefined {
    if (!this.auth) return undefined;
    // GIT_TERMINAL_PROMPT=0 makes failed auth fail fast instead of hanging on an
    // unanswerable prompt (Obsidian cannot service an interactive git prompt).
    return {
      [AUTH_USER_ENV]: this.auth.username || "oauth2",
      [AUTH_TOKEN_ENV]: this.auth.token,
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  /** Prepend the credential-helper config to every command of an authed client.
   *  Attaching auth to ALL commands (not just clone/fetch/push) matters for
   *  partial (blobless) clones: any command touching a missing blob — show, diff,
   *  log — triggers a lazy background fetch that must authenticate, and without
   *  the helper it would fall back to the machine's empty glab/GCM helper. */
  private fullArgs(args: string[]): string[] {
    return this.auth ? [...this.authArgs(), ...args] : args;
  }

  /** Merge caller opts with the credential environment (and cwd when bound). */
  private execOpts(opts?: { cwd?: string; env?: Record<string, string> }): { cwd?: string; env?: Record<string, string> } | undefined {
    const authEnv = this.authEnv();
    const merged = { ...opts };
    if (this.cwd && merged.cwd === undefined) merged.cwd = this.cwd;
    if (authEnv) merged.env = { ...authEnv, ...opts?.env };
    return merged.cwd || merged.env ? merged : undefined;
  }

  /** Run a command that must succeed; throws with git's stderr otherwise. The
   *  thrown message quotes the command WITHOUT the credential-helper -c prefix
   *  so Notices stay readable and never contain the helper string. */
  private async must(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult> {
    const r = await this.runner.run(this.fullArgs(args), this.execOpts(opts));
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r;
  }

  /** Run a command and return the raw result (for introspecting exit codes). */
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult> {
    return this.runner.run(this.fullArgs(args), this.execOpts(opts));
  }

  async init(): Promise<GitResult> {
    return this.must(["init"]);
  }

  async clone(url: string, dir: string, opts?: CloneOpts): Promise<GitResult> {
    const args = ["clone"];
    // Partial-clone flags only apply to real http(s) remotes: local file:///path
    // servers reject --filter unless uploadpack.allowFilter is configured.
    const isHttp = /^https?:\/\//i.test(url);
    if (isHttp && opts?.filter) args.push(`--filter=${opts.filter}`);
    if (opts?.noCheckout) args.push("--no-checkout");
    args.push(url, dir);
    // Credentials ride along via the per-invocation helper, so the URL stays clean
    // and nothing is persisted in the fresh clone's .git/config.
    return this.must(args);
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

  /** Tracked files (index), one per line — the clone-side file list for mirroring. */
  async lsFiles(): Promise<string[]> {
    const r = await this.must(["ls-files"]);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** Paths deleted between two refs (`git diff --name-only --diff-filter=D`).
   *  Tree-level comparison only — safe on blobless clones (no lazy blob fetch). */
  async deletedPaths(range: string): Promise<string[]> {
    const r = await this.must(["diff", "--name-only", "--diff-filter=D", range]);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** Mixed-reset the branch to `ref`: moves HEAD and the index, keeps the working
   *  tree. Used after a clean file-level divergence merge so the merged content is
   *  committed on the remote tip and the push fast-forwards. */
  async reset(ref: string): Promise<GitResult> {
    return this.must(["reset", ref]);
  }

  /** Resolve a ref to its full SHA. */
  async revParse(ref: string): Promise<string> {
    const r = await this.run(["rev-parse", ref]);
    if (r.code !== 0) throw new Error(`rev-parse ${ref} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.trim();
  }

  /** HEAD's SHA, or "" when HEAD is unborn (fresh clone of an empty repo) —
   *  first-init topology treats unborn as "no local history yet". */
  async currentHead(): Promise<string> {
    const r = await this.run(["rev-parse", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : "";
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
    const r = await this.run(["log", `--max-count=${limit}`, `--format=${fmt}`, range]);
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

  /** Paths with working-tree changes vs HEAD (staged + unstaged + untracked), one per
   *  line. Used to stage in-scope working-tree changes on push. Untracked entries are
   *  included so locally-added files — e.g. after a divergence merge re-points the
   *  branch at the remote tip, leaving local-only adds untracked — are never stranded. */
  async workingTreePaths(): Promise<string[]> {
    // -c core.quotePath=false keeps non-ASCII paths unquoted in porcelain output.
    const r = await this.run(["-c", "core.quotePath=false", "status", "--porcelain"]);
    if (r.code !== 0) throw new Error(`git status --porcelain failed (${r.code}): ${r.stderr.trim()}`);
    const out: string[] = [];
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      // Porcelain v1: "XY <path>" (either status char may be a space). Renames render
      // as "R  old -> new" — take the destination so the moved path is staged.
      const path = line.slice(3);
      out.push(path.includes(" -> ") ? path.split(" -> ").pop()! : path);
    }
    return out;
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
