/**
 * MUGS — Multi-User Git Sync
 * Data-plane schema (the "ADL": a declarative data definition for the whole
 * persisted settings object). This Zod schema is the single source of truth:
 * every other module validates against it, and TS types are derived from it.
 */
import { z } from "zod";
import { DEFAULT_SYNC_POLICY } from "./types";
import type {
  MugsSettings,
  Credential,
  FolderMapping,
  LastSyncState,
  ProviderKind,
  SyncDirection,
  SyncStatus,
} from "./types";

export const providerKindSchema = z.enum(["github", "gitlab", "bitbucket", "gitea", "forgejo", "local"]);
export const syncDirectionSchema = z.enum(["push-pull", "pull-only", "push-only"]);
export const syncStatusSchema = z.enum(["ok", "conflict", "error", "up-to-date", "pending"]);

/** A repository path as `owner/repo` (GitLab nested groups allowed: `group/sub/repo`). */
const repoPathSchema = z.string().trim().regex(
  /^[^/\s]+(?:\/[^/\s]+)+$/,
  "expected a repository path like owner/repo",
);

export const credentialSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: providerKindSchema,
  username: z.string().optional(),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
  /** Explicit allowed repos; when set, MUGS skips global enumeration. */
  repos: z.array(repoPathSchema).optional(),
});

export const folderMappingSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  remotePath: z.string(), // "" means whole repo
  localFolder: z.string(),
  providerId: z.string().min(1),
  branch: z.string().optional(),
  /** Optional pinned agent sub-user id (Area 10); absent -> normal sync attribution. */
  agentId: z.string().optional(),
  direction: syncDirectionSchema.default("push-pull"),
  includes: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
});

export const lastSyncStateSchema = z.object({
  mappingId: z.string().min(1),
  lastPushAt: z.number().int().positive().optional(),
  lastPullAt: z.number().int().positive().optional(),
  lastLocalSha: z.string().optional(),
  lastRemoteSha: z.string().optional(),
  baseSha: z.string().optional(),
  opId: z.number().int().positive().optional(),
  status: syncStatusSchema.default("pending"),
});

export const conflictSchema = z.object({
  path: z.string().min(1),
  base: z.string().optional(),
  ours: z.string(),
  theirs: z.string(),
  oursAbsent: z.boolean().optional(),
  theirsAbsent: z.boolean().optional(),
  oursSavedAt: z.number().int().positive().optional(),
  theirsModifiedAt: z.number().int().positive().optional(),
  resolved: z.boolean().optional(),
  resolvedContent: z.string().optional(),
});

export const securitySchema = z.object({
  encryptCredentials: z.boolean().default(false),
  encryptionKeyHint: z.string().optional(),
});

export const obsidianEntrySchema = z.object({
  path: z.string().min(1),
  scope: z.enum(["vault-wide", "personal"]),
  includes: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
});

export const obsidianConfigSchema = z.object({
  enabled: z.boolean().default(false),
  entries: z.array(obsidianEntrySchema).default([]),
});

export const syncPolicySchema = z.object({
  autoMerge: z.boolean().default(true),
  defaultResolution: z.enum(["both", "theirs", "ours"]).default("both"),
  sameChangeAccept: z.boolean().default(true),
  recencyWins: z.boolean().default(true),
  paused: z.boolean().default(false),
  intervalSeconds: z.number().int().positive().default(300),
  obsidianConfig: obsidianConfigSchema.default(() => structuredClone(DEFAULT_SYNC_POLICY.obsidianConfig)),
});

export const agentSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  ownerHuman: z.string().optional(),
  committerName: z.string().optional(),
  committerEmail: z.string().optional(),
  mcpEndpoint: z.string().url().optional(),
});

export const stagedChangeSchema = z.object({
  mappingId: z.string().min(1),
  path: z.string().min(1),
  state: z.enum(["unstaged", "staged", "held"]),
});

/** Clone the shared default so parsed settings never alias DEFAULT_SYNC_POLICY. */
const cloneSyncPolicy = () => structuredClone(DEFAULT_SYNC_POLICY);

export const mugsSettingsSchema = z.object({
  version: z.number().int().positive().default(1),
  credentials: z.array(credentialSchema).default([]),
  mappings: z.array(folderMappingSchema).default([]),
  lastSync: z.record(z.string(), lastSyncStateSchema).default({}),
  conflicts: z.record(z.string(), z.array(conflictSchema)).default({}),
  sync: syncPolicySchema.default(cloneSyncPolicy),
  agents: z.array(agentSchema).default([]),
  staging: z.record(z.string(), z.array(stagedChangeSchema)).default({}),
  security: securitySchema.default({ encryptCredentials: false }),
});

/** Derived types — keep in sync with src/types.ts by construction. */
export type Settings = z.infer<typeof mugsSettingsSchema>;
export type CredentialType = z.infer<typeof credentialSchema>;
export type MappingType = z.infer<typeof folderMappingSchema>;
export type LastSyncType = z.infer<typeof lastSyncStateSchema>;
export type ConflictType = z.infer<typeof conflictSchema>;
export type SyncPolicyType = z.infer<typeof syncPolicySchema>;
export type ObsidianConfigType = z.infer<typeof obsidianConfigSchema>;
export type AgentType = z.infer<typeof agentSchema>;
export type StagedChangeType = z.infer<typeof stagedChangeSchema>;

/**
 * Parse arbitrary persisted JSON into a validated MugsSettings, applying
 * defaults for missing fields so old/partial data loads cleanly.
 */
export function parseSettings(raw: unknown): Settings {
  // Coerce null/undefined to an empty object so defaults fill in the rest.
  return mugsSettingsSchema.parse(raw ?? {});
}

/** Coerce an unknown settings blob to the domain interface (best-effort). */
export function toDomain(raw: unknown): MugsSettings {
  return parseSettings(raw) as unknown as MugsSettings;
}

/** Return a copy of a credential with its token redacted for display. */
export function redactCredential(c: Credential): Omit<Credential, "token"> & { token: string } {
  return { ...c, token: redactToken(c.token) };
}

/** Mask a token so only the last 4 chars are visible (if long enough). */
export function redactToken(token: string): string {
  if (!token) return "";
  if (token.length <= 6) return "•".repeat(token.length);
  return "•".repeat(token.length - 4) + token.slice(-4);
}

/** True when the given vault folder lives inside the Obsidian config dir.
 *  Blocks `.obsidian` wherever it appears as a path segment (e.g. `a/.obsidian/x`). */
export function isBlockedFolder(vaultFolder: string): boolean {
  return normalizeVaultPath(vaultFolder)
    .split("/")
    .includes(".obsidian");
}

/** Normalize a vault path to forward slashes with no leading/trailing slash. */
export function normalizeVaultPath(p: string): string {
  return p.split("\\").join("/").replace(/^\/+|\/+$/g, "");
}
