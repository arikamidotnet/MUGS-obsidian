/**
 * MUGS — provider-agnostic contract (the "data plane" for backend adapters).
 *
 * These Zod schemas are the single source of truth for what a git backend must
 * expose to MUGS. A provider adapter is considered correct when its parsed
 * output satisfies these schemas, not when it merely appears to work — this is
 * what keeps GitLab/GitHub/Forgejo/Gitea/Bitbucket interchangeable behind one
 * contract (see the ADL section of the design plan).
 *
 * Shapes are host-agnostic: adapters map their native JSON (e.g. GitLab's
 * snake_case) into these camelCase contracts, then parse with the schemas here.
 */
import { z } from "zod";

/** Effective collaborator access role, normalized across backends. */
export const memberRoleSchema = z.enum(["owner", "maintainer", "developer", "guest"]);

/** A repository as surfaced to MUGS (from the backend's repo/list endpoint). */
export const repoSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Namespaced/encoded path used in URLs, e.g. "group/project". */
  pathWithNamespace: z.string(),
  /** HTTPS clone URL. */
  httpUrlToRepo: z.string().url(),
  /** Repository default branch (HEAD). */
  defaultBranch: z.string(),
  description: z.string().optional(),
  visibility: z.enum(["private", "internal", "public"]).optional(),
});

/** A branch as seen by MUGS, including the rights needed to sync into it. */
export const branchSummarySchema = z.object({
  /** Branch name without the refs/heads/ prefix. */
  name: z.string(),
  protected: z.boolean(),
  default: z.boolean(),
  /** Whether the acting user may push to this branch. */
  canPush: z.boolean(),
});

/** A collaborator on a repo, for the local membership (visibility) view. */
export const memberSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional(),
  role: memberRoleSchema,
  avatarUrl: z.string().url().optional(),
});

/** Derived types — keep in sync with src/providers/types.ts by construction. */
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type RepoSummary = z.infer<typeof repoSummarySchema>;
export type BranchSummary = z.infer<typeof branchSummarySchema>;
export type Member = z.infer<typeof memberSchema>;
