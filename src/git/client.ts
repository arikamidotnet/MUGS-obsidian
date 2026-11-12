/**
 * MUGS — thin git client.
 *
 * Wraps a small set of git operations the sync engine needs. Every call goes
 * through the injected GitRunner (see types.ts), so tests can assert on the exact
 * args and canned output without touching a repository or the filesystem.
 */
import type { GitResult, GitRunner, GitRunOpts, ReadResult, ReadError } from "./types";

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

/** Deterministic fallback identity used for both author and committer when no
 *  explicit identity is supplied by the caller (e.g. local provider with no
 *  configured agent via pickAgent, or no username on the credential). This is
 *  documented so higher layers and tests can rely on the exact shape.
 *  GitClient.commit *always* supplies explicit GIT_AUTHOR_* / GIT_COMMITTER_*
 *  via the environment and never consults global git config. */
export const FALLBACK_IDENTITY: Author = { name: "MUGS Sync", email: "mugs@local" };

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

  /** Merge caller opts (including GitRunOpts for signal/timeout) with credential env and cwd. */
  private execOpts(opts?: GitRunOpts): GitRunOpts | undefined {
    const authEnv = this.authEnv();
    const merged: GitRunOpts = { ...(opts ?? {}) };
    if (this.cwd && merged.cwd === undefined) merged.cwd = this.cwd;
    if (authEnv) merged.env = { ...authEnv, ...(opts?.env ?? {}) };
    return (merged.cwd || merged.env || merged.signal || merged.timeoutMs) ? merged : undefined;
  }

  /** Run a command that must succeed; throws with git's stderr otherwise. The
   *  thrown message quotes the command WITHOUT the credential-helper -c prefix
   *  so Notices stay readable and never contain the helper string. */
  private async must(args: string[], opts?: GitRunOpts): Promise<GitResult> {
    const r = await this.runner.run(this.fullArgs(args), this.execOpts(opts));
    if (r.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r;
  }

  /** Run a command and return the raw result (for introspecting exit codes). */
  run(args: string[], opts?: GitRunOpts): Promise<GitResult> {
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
    // --prune drops remote-tracking refs for branches deleted/renamed upstream,
    // so a removed branch can't keep syncing a ghost tip (or resurrect on push).
    // lowSpeed* aborts a stalled HTTPS transfer (<1KB/s for 60s) — without it a
    // dead connection hangs the sync pass (and the in-flight guard) forever.
    return this.must(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "fetch", "--prune", remote]);
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
    if (!paths || paths.length === 0) return this.must(["add", "."]);
    // Chunk pathspecs (a first sync can stage thousands of paths — one argv would
    // blow past OS limits, surfacing as a misleading "could not run") and pin
    // line endings so a Windows teammate with core.autocrlf=true cannot push a
    // whole-repo CRLF rewrite that everyone else then pulls.
    const CHUNK = 500;
    let last: GitResult = { code: 0, stdout: "", stderr: "" };
    for (let i = 0; i < paths.length; i += CHUNK) {
      last = await this.must(["-c", "core.autocrlf=false", "add", "--", ...paths.slice(i, i + CHUNK)]);
    }
    return last;
  }

  async commit(message: string, author?: Author, committer?: Author): Promise<GitResult> {
    const args = ["commit", "--message", message];
    // Always supply explicit identities for BOTH author and committer via environment
    // variables. This guarantees hermetic operation (no dependency on global git
    // config or ambient user.name). Callers may still pass Author objects (from
    // pickAgent or provider username); any missing role receives a deterministic
    // fallback (or the other provided identity for consistency).
    const effective = author ?? committer ?? FALLBACK_IDENTITY;
    const a = author ?? effective;
    const c = committer ?? effective;
    const env = {
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_COMMITTER_NAME: c.name,
      GIT_COMMITTER_EMAIL: c.email,
    };
    // Preserve the --author flag for explicit authors (observable in call args)
    // while the env guarantees the identity is always set even under hermetic
    // conditions (fresh HOME, GIT_CONFIG_GLOBAL=/dev/null, etc).
    if (author) args.push("--author", `${a.name} <${a.email}>`);
    return this.must(args, { env });
  }

  async push(remote = "origin", branch?: string): Promise<GitResult> {
    // lowSpeed* aborts a stalled HTTPS push (see fetch) so a dead connection
    // surfaces as a failed mapping instead of hanging the pass forever.
    const stall = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];
    return this.must(branch ? [...stall, "push", remote, branch] : [...stall, "push", remote]);
  }

  /** Tracked files (index), one per line — the clone-side file list for mirroring.
   *  quotePath=false keeps non-ASCII/emoji names unquoted: the default C-quoting
   *  would make them unmatchable against vault paths (phantom deletes / failed adds).
   *  Uses -z + -- for NUL-delimited safety (E06); parses newline output tolerantly. */
  async lsFiles(): Promise<string[]> {
    const r = await this.must(["-c", "core.quotePath=false", "ls-files", "-z", "--"]);
    return splitRecords(r.stdout);
  }

  /** Paths deleted between two refs (`git diff --name-only --diff-filter=D`).
   *  Tree-level comparison only — safe on blobless clones (no lazy blob fetch).
   *  Uses -z (E06). */
  async deletedPaths(range: string): Promise<string[]> {
    // NOTE: no `--` here — the range is a REVISION, not a pathspec. A `--` before it
    // makes git reinterpret the range as a path and silently diff nothing.
    const r = await this.must(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=D", "-z", range]);
    return splitRecords(r.stdout);
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
   *
   * Legacy behavior preserved for existing callers (sync engine migrates in a
   * later wave). New code should prefer {@link showTyped}.
   */
  async show(ref: string, path: string): Promise<string | undefined> {
    const r = await this.run(["show", `${ref}:${path}`]);
    if (r.code !== 0) return undefined;
    return r.stdout;
  }

  /**
   * Typed read of file content at a ref (`REF:PATH`).
   * Returns a discriminated union:
   * - { kind: "content", content }
   * - { kind: "absent" }
   * - { kind: "error", error: { kind, message } }
   *
   * Error kinds: auth | missing-ref | missing-blob | permission | timeout | cancelled | corrupt | other.
   * The message is redacted (no embedded URL userinfo or Authorization material).
   * Callers MUST treat "absent" distinctly from "error" (never conflate).
   */
  async showTyped(ref: string, path: string): Promise<ReadResult> {
    const r = await this.run(["show", `${ref}:${path}`]);
    if (r.code === 0) {
      return { kind: "content", content: r.stdout };
    }
    const err = classifyShowError(r.stderr || r.stdout);
    // A missing-blob classification from `git show REF:PATH` when the ref itself
    // is valid means the path simply is not present in that tree. This is the
    // normal "absent" outcome for merge logic (treated as a deletion on that side).
    // All other error kinds (auth, missing-ref, permission, corrupt, etc.) remain
    // errors; an error must never be interpreted as absence by callers.
    if (err.kind === "missing-blob") {
      return { kind: "absent" };
    }
    return { kind: "error", error: err };
  }

  /** Epoch seconds of the last commit that touched `path` at `ref`, or undefined
   *  when the path never existed there (git log prints nothing). Feeds the policy's
   *  recency-wins conflict resolution — commit metadata only, so a blobless
   *  partial clone never lazy-fetches a blob for this. */
  async lastModifiedAt(ref: string, path: string): Promise<number | undefined> {
    const r = await this.run(["log", "-1", "--format=%ct", ref, "--", path]);
    if (r.code !== 0) return undefined;
    const secs = Number.parseInt(r.stdout.trim(), 10);
    return Number.isNaN(secs) ? undefined : secs;
  }

  /** True when a commit object exists LOCALLY in this clone. `rev-parse --verify` is
   *  not enough: for a full 40-char SHA it happily echoes the string back even when
   *  the object is absent (a re-clone that lost the baseline commit), which made the
   *  Diff view compare against a phantom baseline. `cat-file -e <sha>^{commit}` proves
   *  the commit is actually present. */
  async commitExists(sha: string): Promise<boolean> {
    const r = await this.run(["cat-file", "-e", `${sha}^{commit}`]);
    return r.code === 0;
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
   *  branch at the remote tip, leaving local-only adds untracked — are never stranded.
   *  Uses -z (NUL) porcelain v1 (E06); renames are "XY NEW<NUL>ORIG<NUL>".
   *  Legacy newline output ("XY path", "R old -> new") is parsed tolerantly. */
  async workingTreePaths(): Promise<string[]> {
    const r = await this.run(["-c", "core.quotePath=false", "status", "--porcelain", "-z", "--"]);
    if (r.code !== 0) throw new Error(`git status --porcelain failed (${r.code}): ${r.stderr.trim()}`);
    const out: string[] = [];
    if (r.stdout.includes("\u0000")) {
      // Real git -z porcelain v1: records are "XY PATH<NUL>" and for renames/copies
      // "XY NEW_PATH<NUL>ORIG_PATH<NUL>" — the NEW path comes FIRST, then the original.
      const parts = r.stdout.split("\u0000").filter((s) => s.length > 0);
      for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        if (!rec) continue;
        const isRename = rec[0] === "R" || rec[1] === "R";
        const body = rec.slice(2).replace(/^\s+/, "");
        if (isRename && parts[i + 1] !== undefined) {
          out.push(body); // NEW path (the ORIG follows as its own NUL field — skip it)
          i += 1;
        } else {
          out.push(body);
        }
      }
    } else {
      // Legacy line format (older fake runners / unusual git builds): "XY path",
      // renames as "XY old -> new". Tolerant parsing keeps the old wire contract alive.
      for (const line of r.stdout.split("\n")) {
        if (!line.trim()) continue;
        if (line.includes(" -> ")) {
          out.push(line.split(" -> ").pop()!.trim());
        } else {
          out.push(line.slice(3).replace(/^\s+/, ""));
        }
      }
    }
    return out;
  }

  /** Paths changed across a `base...HEAD`-style range, one per line. Uses -z (E06).
    *  No `--` before the range — it is a revision, not a pathspec (see deletedPaths). */
  async changedPaths(range: string): Promise<string[]> {
    const r = await this.run(["-c", "core.quotePath=false", "diff", "--name-only", "-z", range]);
    if (r.code !== 0) throw new Error(`git diff --name-only ${range} failed (${r.code}): ${r.stderr.trim()}`);
    return splitRecords(r.stdout);
  }

  /**
   * Unified diff between two refs using git's three-dot (merge-base) comparison.
   * For an explicit two-endpoint diff (fromRef..toRef) use {@link diffRange}.
   */
  async diff(from: string, to: string): Promise<string> {
    const r = await this.run(["diff", `${from}...${to}`]);
    if (r.code !== 0) throw new Error(`git diff ${from}...${to} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  /**
   * Explicit two-endpoint tree diff: `git diff <fromRef> <toRef>` (no merge-base).
   * This produces the diff you expect for an ancestor like HEAD vs HEAD~1.
   * Optionally scoped to a set of pathspecs (passed after `--`).
   */
  async diffRange(fromRef: string, toRef: string, paths: string[] = []): Promise<string> {
    const base = ["diff", fromRef, toRef];
    const args = paths.length > 0 ? [...base, "--", ...paths] : base;
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`git diff ${fromRef} ${toRef} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  /**
   * Pathspec-scoped log lines (oneline). `git log --oneline <range> -- <paths...>`.
   * Keeps the merge-base range form for the first argument (e.g. "base..HEAD").
   */
  async logLinesScoped(range: string, paths: string[]): Promise<string[]> {
    if (!paths || paths.length === 0) return this.logLines(range);
    const r = await this.run(["log", "--oneline", range, "--", ...paths]);
    if (r.code !== 0) throw new Error(`git log ${range} failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** `git status --porcelain` lines. */
  async porcelain(): Promise<string[]> {
    const r = await this.run(["status", "--porcelain"]);
    if (r.code !== 0) throw new Error(`git status failed (${r.code}): ${r.stderr.trim()}`);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }
}

/**
 * Split command output into path records: NUL-delimited when -z output is present
 * (E06 wire format), otherwise newline-delimited (legacy fakes / exotic builds).
 * Drops empty trailing records from a final delimiter.
 */
function splitRecords(s: string): string[] {
  return (s.includes("\u0000") ? s.split("\u0000") : s.split("\n")).filter((l) => l.length > 0);
}

/**
 * Pure classification for a failed `git show` (or equivalent blob read).
 * Exported for unit testing the classifier in isolation.
 * Redacts URL-embedded credentials and Authorization-like tokens.
 */
export function classifyShowError(text: string): ReadError {
  const t = (text || "").toLowerCase();
  // Redact anything resembling credentials in the raw text for the message.
  const redacted = redactSensitive(text || "");

  // Auth / credential failures (exit 128 or 1 with credential wording).
  if (/authentication failed|access denied|http basic|could not read .*password|bad credentials|401|403/.test(t)) {
    return { kind: "auth", message: redacted.trim() || "authentication failed" };
  }

  // Missing ref (the commit/tree named by REF does not exist locally).
  if (/bad revision|not a valid object name|unknown revision|could not resolve reference|reference not found|missing commit|no such ref|ambiguous argument|not a tree object|invalid object name/.test(t)) {
    return { kind: "missing-ref", message: redacted.trim() || "missing ref" };
  }

  // Missing blob / path at a valid ref (this is the "absent" signal for callers
  // that still want to distinguish the failure mode). We map to missing-blob;
  // upper layers decide if this is logically "absent" or a hard error.
  if (/pathspec .* did not match|does not exist in|exists on disk, but not in|path .* does not exist|fatal: .* no such path|not found in/.test(t)) {
    return { kind: "missing-blob", message: redacted.trim() || "path not present at ref" };
  }

  // Permission denied on the object store / pack.
  if (/permission denied|read permission|access is not allowed/.test(t)) {
    return { kind: "permission", message: redacted.trim() || "permission denied" };
  }

  // Timeout / network stall hints (from lowSpeed or transport layer).
  if (/timeout|timed out|early eof|fetch-pack|index-pack.*stalled/.test(t)) {
    return { kind: "timeout", message: redacted.trim() || "read timed out" };
  }

  // Object corruption / pack issues.
  if (/corrupt|bad object|loose object|pack has bad|checksum mismatch|object database/.test(t)) {
    return { kind: "corrupt", message: redacted.trim() || "corrupt object" };
  }

  // Cancellation is typically surfaced by the runner (signal abort) rather than
  // git itself; we keep a distinct bucket for future-proofing.
  if (/cancel|aborted|interrupted/.test(t)) {
    return { kind: "cancelled", message: redacted.trim() || "cancelled" };
  }

  return { kind: "other", message: redacted.trim() || "git read failed" };
}

/** Redact URL-embedded credentials and Authorization-like material from messages. */
function redactSensitive(s: string): string {
  // user:pass@host or token@host
  let out = s.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\/\s@]+@([^\s]+)/g, "$1<redacted>@$2");
  // Authorization: ... headers or similar
  out = out.replace(/authorization[^\n]*/gi, "authorization: <redacted>");
  // Bare credential-ish tokens in URLs
  out = out.replace(/([?&](?:token|access_token|private_token|auth)=)[^&\s]+/gi, "$1<redacted>");
  return out;
}
