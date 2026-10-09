/**
 * MUGS — agent commit drafts (pure).
 *
 * An agent sub-user proposes a change through the MCP server rather than committing
 * directly. This module composes that proposal into a {@link CommitDraft} record and,
 * once approved, into the final on-behalf-of commit message + author identity. Pure
 * string/identity logic pinned by contract tests; the transport lives in `server.ts`.
 */
import type { Agent } from "../types";
import { authorRefForAgent, onBehalfOfTrailer } from "../sync/attribution";

/** A proposed commit an agent sub-user wants to publish through MUGS. */
export interface CommitDraft {
  /** Id of the acting agent (must match a registered agent). */
  agentId: string;
  /** Free-form subject the agent chose for the change. */
  subject: string;
  /** Optional body the agent appended (trimmed before composition). */
  body?: string;
}

/** The final author identity recorded for a drafted commit. */
export interface DraftAuthor {
  name: string;
  email?: string;
}

/**
 * Compose the full commit message from an agent draft, appending the git-native
 * "On-behalf-of" trailer when the acting agent has an owner. The subject is always
 * present; the body (when non-empty) sits between blank lines above the trailer.
 */
export function formatDraftMessage(draft: CommitDraft, agent: Agent): string {
  const subject = draft.subject.trim();
  const body = draft.body?.trim();
  const core = body ? `${subject}\n\n${body}` : subject;
  // onBehalfOfTrailer already carries its own leading blank line.
  return `${core}${onBehalfOfTrailer(agent.ownerHuman)}`;
}

/** The author identity that will be recorded for a drafted commit. */
export function draftAuthor(draft: CommitDraft, agent: Agent): DraftAuthor {
  const ref = authorRefForAgent(agent);
  // A draft authored by an agent without a committer email has no "<...>" to attach.
  return ref.email ? { name: ref.name, email: ref.email } : { name: ref.name };
}

/** True when a draft names the given agent id (used by server-side validation). */
export function draftTargetsAgent(draft: CommitDraft, agentId: string): boolean {
  return draft.agentId === agentId;
}
