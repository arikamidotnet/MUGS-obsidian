/**
 * MUGS — Multi-User Git Sync
 * Data-plane schema (the "ADL": a declarative data definition for the whole
 * persisted settings object). This Zod schema is the single source of truth:
 * every other module validates against it, and TS types are derived from it.
 */
import { z } from "zod";
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

export const credentialSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: providerKindSchema,
  username: z.string().optional(),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

export const folderMappingSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  remotePath: z.string(), // "" means whole repo
  localFolder: z.string(),
  providerId: z.string().min(1),
  branch: z.string().optional(),
  direction: syncDirectionSchema.default("push-pull"),
});

export const lastSyncStateSchema = z.object({
  mappingId: z.string().min(1),
  lastPushAt: z.number().int().positive().optional(),
  lastPullAt: z.number().int().positive().optional(),
  lastLocalSha: z.string().optional(),
  lastRemoteSha: z.string().optional(),
  status: syncStatusSchema.default("pending"),
});

export const conflictSchema = z.object({
  path: z.string().min(1),
  base: z.string().optional(),
  ours: z.string(),
  theirs: z.string(),
  resolved: z.boolean().optional(),
  resolvedContent: z.string().optional(),
});

export const securitySchema = z.object({
  encryptCredentials: z.boolean().default(false),
  encryptionKeyHint: z.string().optional(),
});

export const mugsSettingsSchema = z.object({
  version: z.number().int().positive().default(1),
  credentials: z.array(credentialSchema).default([]),
  mappings: z.array(folderMappingSchema).default([]),
  lastSync: z.record(z.string(), lastSyncStateSchema).default({}),
  conflicts: z.record(z.string(), z.array(conflictSchema)).default({}),
  security: securitySchema.default({ encryptCredentials: false }),
});

/** Derived types — keep in sync with src/types.ts by construction. */
export type Settings = z.infer<typeof mugsSettingsSchema>;
export type CredentialType = z.infer<typeof credentialSchema>;
export type MappingType = z.infer<typeof folderMappingSchema>;
export type LastSyncType = z.infer<typeof lastSyncStateSchema>;
export type ConflictType = z.infer<typeof conflictSchema>;

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
