/**
 * MUGS — agent worktree/branch lifecycle (pure).
 *
 * Each agent sub-user gets its own git branch so concurrent edits never clobber one
 * another's unpushed work. This module is the deterministic core of that: it derives
 * a safe, unique branch name per agent and checks that a prospective worktree does not
 * collide with an existing one on either its backing branch or its absolute path (git
 * cannot have two checked-out trees on the same branch, and two paths must differ).
 *
 * NO Obsidian/git imports — all logic is string/ref math pinned by contract tests.
 */

/** A worktree: a git branch plus the working-tree path checked out from it. */
export interface Worktree {
  /** Stable id within the vault's worktree registry. */
  id: string;
  /** Human label for the worktree (e.g. "research agent"). */
  name: string;
  /** Git branch backing this worktree. */
  branch: string;
  /** Absolute working-tree path checked out from {@link branch}. */
  path: string;
}

/** Prefix under which every agent sub-user's branch lives (`mugs-agent/<slug>`). */
export const AGENT_BRANCH_PREFIX = "mugs-agent";

/** Maximum length of a single git ref segment. */
const MAX_REF_SEGMENT = 63;

/**
 * Sanitize an arbitrary id/label into a single valid git ref segment: lowercased,
 * runs of invalid characters collapsed to one dash, leading/trailing dots and dashes
 * trimmed, capped at the git limit. Falls back to "agent" when nothing survives — so
 * `slugForRef("Agent!!") === "agent"` and `slugForRef("  ") === "agent"`.
 */
export function slugForRef(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, MAX_REF_SEGMENT);
  return slug || "agent";
}

/** Deterministic branch name for an agent id: `mugs-agent/<slug>`. */
export function agentBranch(agentId: string): string {
  return `${AGENT_BRANCH_PREFIX}/${slugForRef(agentId)}`;
}

/** True when a branch name is one of MUGS's agent branches (`mugs-agent/...`). */
export function isAgentBranch(branch: string): boolean {
  return branch.startsWith(`${AGENT_BRANCH_PREFIX}/`);
}

/** The kind of isolation conflict between a candidate and an existing worktree. */
export type WorktreeConflict = "branch" | "path";

/** Result of checking a prospective worktree against the existing set. */
export interface WorktreeResolution {
  /** Which isolation rule collided, when any. */
  conflict?: WorktreeConflict;
  /** The existing worktree that collided (present when {@link conflict} is set). */
  existing?: Worktree;
}

/**
 * Isolation check for a prospective worktree against existing ones. A collision is
 * reported when another worktree shares the candidate's backing branch OR its absolute
 * path — never both at once, so callers can surface a precise reason. Returns `{}`
 * when the candidate is free to create.
 */
export function resolveWorktree(
  existing: Worktree[],
  candidate: Pick<Worktree, "branch" | "path">,
): WorktreeResolution {
  for (const w of existing) {
    if (w.branch === candidate.branch) return { conflict: "branch", existing: w };
    if (w.path === candidate.path) return { conflict: "path", existing: w };
  }
  return {};
}

/**
 * Produce a branch name that does not collide with any taken agent branch, appending
 * `-2`, `-3`, … when the canonical {@link agentBranch} is already in use. Pure — used
 * by the UI to pick a unique worktree branch before creating it locally.
 */
export function uniqueAgentBranch(agentId: string, taken: Iterable<string>): string {
  const base = agentBranch(agentId);
  const takenSet = new Set(taken);
  if (!takenSet.has(base)) return base;
  let n = 2;
  for (;;) {
    const candidate = `${base}-${n}`;
    if (!takenSet.has(candidate)) return candidate;
    n++;
  }
}
