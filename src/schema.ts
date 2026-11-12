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
  PendingOpKind,
  PendingOperation,
  SyncPlanKind,
  PlannedAction,
  SyncPlan,
  RepoIdentity,
} from "./types";
// Wave-B contract types (additive copy from WAVE-B-CONTRACTS.md):
// PendingOperation, SyncPlan*, RepoIdentity, ResolveOutcome, ConflictResolver, DiffEndpoint, LastSyncState additions.
// Zod schemas added below for the serializable subset (pendingOps in lastSync, etc.). Runtime-only types (ResolveOutcome etc.) are re-declared or typed from src/types.

export const providerKindSchema = z.enum(["github", "gitlab", "bitbucket", "gitea", "forgejo", "local"]);
export const syncDirectionSchema = z.enum(["push-pull", "pull-only", "push-only"]);
export const syncStatusSchema = z.enum(["ok", "conflict", "error", "up-to-date", "pending"]);

export const pendingOpKindSchema = z.enum(["vault-write", "vault-delete", "clone-commit", "remote-push"]);
export const pendingOperationSchema = z.object({
  opId: z.string().min(1),
  kind: pendingOpKindSchema,
  path: z.string().min(1),
  content: z.string().optional(),
  refSha: z.string().optional(),
  state: z.enum(["pending", "applied-unverified", "failed"]),
  createdAt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
});

export const syncPlanKindSchema = z.enum(["idle", "publish-local", "apply-remote", "merge-clean", "conflict", "blocked", "retry-pending"]);
export const plannedActionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["vault-write", "vault-delete", "stage", "commit", "push"]),
  directionPermitted: z.boolean(),
  requiresEditorCheck: z.boolean(),
});
export const syncPlanSchema = z.object({
  mappingId: z.string().min(1),
  kind: syncPlanKindSchema,
  actions: z.array(plannedActionSchema),
  counts: z.object({
    publish: z.number().int().nonnegative(),
    apply: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
  }),
});

export type SyncPlanType = z.infer<typeof syncPlanSchema>;

export const repoIdentitySchema = z.object({
  providerId: z.string().min(1),
  repoId: z.string().min(1),
  branch: z.string().min(1),
  canonicalRemote: z.string().min(1),
});

export type RepoIdentityType = z.infer<typeof repoIdentitySchema>;

// DiffEndpoint for truthful labeling (U01/U02). Not directly persisted in lastSync but part of the frozen contract surface.
export const diffEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("baseline"), sha: z.string().min(1) }),
  z.object({ kind: z.literal("head") }),
  z.object({ kind: z.literal("remote-ref"), ref: z.string().min(1) }),
  z.object({ kind: z.literal("explicit"), ref: z.string().min(1) }),
]);
export type DiffEndpointType = z.infer<typeof diffEndpointSchema>;

// ResolveOutcome / ConflictResolver are runtime Promise contracts (see src/types.ts).
// No Zod schema for the function type; the error shape is documented for UI keying.
export const resolveOutcomeOkSchema = z.object({ ok: z.literal(true), applied: z.boolean() });
export const resolveOutcomeErrSchema = z.object({ ok: z.literal(false), error: z.string(), retryable: z.boolean() });

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
  /** Optional repo reference for scoped links sharing one clone per repo. Must be
   *  declared here or Zod strips it on load, silently degrading scoped links to the
   *  legacy id-based repo match (which never hits for random mapping ids). */
  repoRef: z.string().optional(),
  direction: syncDirectionSchema.default("push-pull"),
  includes: z.array(z.string()).default([]),
  excludes: z.array(z.string()).default([]),
  /** Opt-out gate for the vault `.trash/` folder in this mapping (defaults on). */
  syncTrashFolder: z.boolean().default(true),
});

export const lastSyncStateSchema = z.object({
  mappingId: z.string().min(1),
  lastPushAt: z.number().int().positive().optional(),
  lastPullAt: z.number().int().positive().optional(),
  lastLocalSha: z.string().optional(),
  lastRemoteSha: z.string().optional(),
  baseSha: z.string().optional(),
  opId: z.number().int().positive().optional(),
  /** Set once a mirror-pull has populated the vault folder (deletion-safety gate). */
  vaultPopulated: z.boolean().optional(),
  /** Per-file (mtimeMs, size) fingerprints from the last completed push-only pass —
 *  the steady-state shortcut's change detector (mtime alone is not trusted). */
  contentSnapshot: z.record(z.string(), z.tuple([z.number(), z.number()])).optional(),
  status: syncStatusSchema.default("pending"),
  /** PROVEN vault↔repo correspondence. Advances ONLY after every planned vault
   *  application completed AND state persisted. Distinct from lastRemoteSha
   *  (fetched tip) and lastLocalSha (clone HEAD), which may run ahead. */
  correspondenceSha: z.string().optional(),
  /** Hash of (direction, remotePath, localFolder, branch, includes, excludes, syncTrashFolder).
   *  Any change invalidates contentSnapshot shortcuts and replans from scratch. */
  configFingerprint: z.string().optional(),
  /** Durable operations not yet fully applied+verified. Non-empty list BLOCKS
   *  correspondence advance and forces replan/verify before any new reconciliation. */
  pendingOps: z.array(pendingOperationSchema).optional(),
  /** Resolved identity clone dir recorded at the last pass (UI/test resolution). */
  cloneDir: z.string().optional(),
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

/** Key-derivation parameters for passphrase encryption. The passphrase itself
 *  is NEVER persisted — data.json only ever carries these public parameters. */
export const kdfSchema = z.object({
  algorithm: z.enum(["PBKDF2-SHA-256"]).default("PBKDF2-SHA-256"),
  /** Random per-vault salt, base64. Makes rainbow/precomputation attacks vault-specific. */
  salt: z.string().min(1),
  iterations: z.number().int().positive(),
});
export type KdfParams = z.infer<typeof kdfSchema>;

export const securitySchema = z.object({
  encryptCredentials: z.boolean().default(false),
  /** LEGACY: a stored hint from which the old encryption key was derived.
   *  Kept so old data.json files still load; dropped on migration to the
   *  passphrase KDF (`kdf`) because a persisted key input protects nothing. */
  encryptionKeyHint: z.string().optional(),
  /** Passphrase-KDF parameters. Presence marks the vault as using the
   *  passphrase scheme; absent + encryptCredentials means the legacy hint
   *  scheme (migrated on first unlock). */
  kdf: kdfSchema.optional(),
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
  /** Which side wins a mapping's first initialization; "pull" = remote populates
   *  the vault (historic default), "push" = vault uploads without downloading history. */
  firstSyncDirection: z.enum(["pull", "push"]).default("pull"),
  obsidianConfig: obsidianConfigSchema.prefault(() => structuredClone(DEFAULT_SYNC_POLICY.obsidianConfig)),
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
  sync: syncPolicySchema.prefault(cloneSyncPolicy),
  agents: z.array(agentSchema).default([]),
  staging: z.record(z.string(), z.array(stagedChangeSchema)).default({}),
  security: securitySchema.default({ encryptCredentials: false }),
});

/** Derived types — keep in sync with src/types.ts by construction. */
export type Settings = z.infer<typeof mugsSettingsSchema>;
export type SecurityType = z.infer<typeof securitySchema>;
export type KdfType = z.infer<typeof kdfSchema>;
export type CredentialType = z.infer<typeof credentialSchema>;
export type MappingType = z.infer<typeof folderMappingSchema>;
export type LastSyncType = z.infer<typeof lastSyncStateSchema>;
export type ConflictType = z.infer<typeof conflictSchema>;
export type SyncPolicyType = z.infer<typeof syncPolicySchema>;
export type ObsidianConfigType = z.infer<typeof obsidianConfigSchema>;
export type AgentType = z.infer<typeof agentSchema>;
export type StagedChangeType = z.infer<typeof stagedChangeSchema>;

/** Wave B contract additive derived types (verbatim signatures from contract). */
export type PendingOpKindSchemaType = z.infer<typeof pendingOpKindSchema>;
export type PendingOperationSchemaType = z.infer<typeof pendingOperationSchema>;

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
