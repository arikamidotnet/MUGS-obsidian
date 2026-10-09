/**
 * MUGS — agent/human author attribution (pure).
 *
 * When an agent sub-user pushes, the commit must attribute to that agent while still
 * mapping back to the human who authorized it. This module composes those identities:
 *   - {@link authorRefForAgent} builds the AuthorRef shown in the Diff view and history.
 *   - {@link authorString} forms the git `--author` string for the committer identity.
 *   - {@link onBehalfOfTrailer} appends a git-native "On-behalf-of" trailer so remote
 *     blame maps an agent commit back to a person (see git's own on-behalf-of convention).
 *
 * NO Obsidian/git imports — string/identity math pinned by contract tests. `main.ts`
 * wires the result into the push path via {@link formatCommitMessage}.
 */
import type { Agent } from "../types";
import type { AuthorRef } from "../ui/diffModel";

/**
 * Build the {@link AuthorRef} that identifies an agent sub-user in diffs/history. The
 * committer name/email default to the agent's display name when unset, so a bare agent
 * still attributes cleanly. `kind` is pinned to `"agent"` and the owner (if any) is
 * carried for remote "On-behalf-of" attribution.
 */
export function authorRefForAgent(agent: Agent): AuthorRef {
  return {
    name: agent.committerName ?? agent.displayName,
    email: agent.committerEmail,
    kind: "agent",
    agentId: agent.id,
    ownerHuman: agent.ownerHuman,
  };
}

/** The git author string ("Name <email>") for an agent's committer identity. */
export function authorString(agent: Agent): string {
  const name = agent.committerName ?? agent.displayName;
  return agent.committerEmail ? `${name} <${agent.committerEmail}>` : name;
}

/**
 * The "On-behalf-of" trailer that maps an agent commit back to the human who authorized
 * it. Returns `""` when there is no owner, so plain sync commits are unaffected and the
 * trailer only appears for genuine agent-authored pushes. Pure — appended by
 * {@link formatCommitMessage} when an agent authored a push.
 */
export function onBehalfOfTrailer(ownerHuman?: string): string {
  return ownerHuman && ownerHuman.trim() ? `\n\nOn-behalf-of: ${ownerHuman.trim()}` : "";
}
