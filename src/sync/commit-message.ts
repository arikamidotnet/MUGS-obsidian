/**
 * MUGS — deterministic sync commit-message formatting.
 *
 * Every sync operation (push/pull/rebase) is recorded with a stable, greppable
 * commit message so history stays legible and the op log can be parsed. Pure
 * string logic, fully unit-tested.
 */

/** The kind of sync operation that produced a commit. */
export type SyncOp = "push" | "pull" | "rebase";

/** Metadata used to build a sync commit message. */
export interface CommitMeta {
  op: SyncOp;
  /** Human label of the mapping (optional, for context). */
  label?: string;
  /** Remote path inside the repo that changed (optional). */
  remotePath?: string;
  /** Acting author name/email (optional). */
  author?: string;
}

/** Build a deterministic sync commit message. */
export function formatCommitMessage(m: CommitMeta): string {
  const subject = buildSubject(m);
  const body = buildBody(m);
  return body ? `${subject}\n\n${body}` : subject;
}

function buildSubject(m: CommitMeta): string {
  const parts = ["mugs", m.op];
  if (m.label) parts.push(`(${m.label})`);
  if (m.remotePath) parts.push(m.remotePath);
  return parts.join(" ");
}

function buildBody(m: CommitMeta): string {
  const lines: string[] = [];
  if (m.remotePath) lines.push(`Remote path: ${m.remotePath}`);
  if (m.author) lines.push(`Author: ${m.author}`);
  return lines.join("\n");
}
