/**
 * MUGS — repository identity + shared-clone isolation (S03, contract §3).
 *
 * Clones are keyed by the RESOLVED RepoIdentity (provider + repo + branch), never by
 * display slugs: two mappings pointing at the same repo+branch share one clone dir,
 * and two branches get independent worktrees. Operations on one identity serialize
 * through an in-process keyed mutex; an advisory lock file (pid+timestamp) inside the
 * clone dir guards cross-process contention (a test process must never compete with
 * the running plugin).
 */
import { createHash } from "node:crypto";
import type { RepoIdentity } from "../types";
import { checkRefName } from "../git/safePath";

/** Stable identity key: canonical remote + resolved branch (+ provider/repo ids). */
export function identityKey(id: RepoIdentity): string {
  return [id.providerId, id.repoId, id.branch, id.canonicalRemote].join("|");
}

/** Deterministic short hash (first 12 hex of SHA-256) of the identity key. */
export function shortHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

/** Normalize a remote URL: strip credentials, lowercase host handling, drop a
 *  trailing "index.html"-style noise, remove the trailing slash and ".git" so
 *  https://host/Owner/Repo.git and https://host/Owner/Repo collide intentionally. */
export function canonicalizeRemote(url: string): string {
  let u = url.trim();
  // Strip embedded userinfo (user:token@) — never persist or hash secrets.
  u = u.replace(/^(https?:\/\/)([^/@:]+):([^/@]+)@/i, "$1");
  u = u.replace(/^(https?:\/\/)([^/@]+)@/i, "$1");
  while (u.endsWith("/")) u = u.slice(0, -1);
  if (u.toLowerCase().endsWith(".git")) u = u.slice(0, -4);
  return u;
}

/** Filesystem-safe directory name for a RESOLVED branch. A branch that fails
 *  checkRefName is rejected (never sanitized) — callers surface the reason. */
export function sanitizeBranch(branch: string): string {
  const v = checkRefName(branch);
  if (!v.ok) throw new Error(`unsafe branch name for clone layout: ${v.reason}`);
  return branch.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * Contract §3 clone layout: `<cloneRoot>/<shortHash(identity)>/<sanitized-branch>`.
 * Throws on an unsafe branch name (callers surface a blocked outcome).
 */
export function identityCloneDir(root: string, id: RepoIdentity): string {
  const trimmed = root.replace(/[/\\]+$/, "");
  return `${trimmed}/${shortHash(identityKey(id))}/${sanitizeBranch(id.branch)}`;
}

// --- In-process keyed mutex ----------------------------------------------------

const locks = new Map<string, Promise<void>>();

/** Serialize an async operation per identity key within this process. A failing
 *  holder never poisons the chain: the next waiter still gets its turn. */
export async function withIdentityLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const gate = (locks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let release!: () => void;
  const ticket = new Promise<void>((resolve) => (release = resolve));
  locks.set(key, ticket); // later callers chain behind THIS ticket (sync, no race)
  await gate;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === ticket) locks.delete(key); // no newer waiter chained
  }
}
