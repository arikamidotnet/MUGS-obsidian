/**
 * MUGS — Multi-User Git Sync
 * Core domain types.
 *
 * The Zod schema in `schema.ts` is the single source of truth for the data
 * plane; these interfaces are derived from it (see `export type ... = z.infer`).
 * DEFAULT_SETTINGS lives here because it is plain runtime data, not a spec.
 */

/** Supported git backends. All are git-native; GitLab gets first-class REST support. */
export type ProviderKind = "github" | "gitlab" | "bitbucket" | "local";

/** How a mapping interacts with the remote. */
export type SyncDirection = "push-pull" | "pull-only" | "push-only";

/** Per-mapping sync status, persisted in lastSync state. */
export type SyncStatus = "ok" | "conflict" | "error" | "up-to-date" | "pending";

/** A stored credential (token) scoped to a single backend/user. */
export interface Credential {
  /** Stable id unique within the vault's credential list. */
  id: string;
  /** Human-friendly label, e.g. "work account". Never treated as secret. */
  label: string;
  /** Which backend this token authenticates against. */
  kind: ProviderKind;
  /** Optional username (GitLab exposes the acting user via the API). */
  username?: string;
  /** The token itself — redacted on write, optionally encrypted at rest. */
  token: string;
  /** Base URL for self-hosted instances, e.g. https://gitlab.example.com/api/v4 */
  baseUrl?: string;
}

/** A fine-grained folder mapping between a remote path and a vault folder. */
export interface FolderMapping {
  id: string;
  label: string;
  /** Path on the remote repo root ("" means the whole repository). */
  remotePath: string;
  /** Obsidian vault folder this maps to (must NOT live under .obsidian/). */
  localFolder: string;
  /** Id of the credential/provider used for this mapping. */
  providerId: string;
  /** Optional per-mapping branch override. Defaults to the remote HEAD branch. */
  branch?: string;
  direction: SyncDirection;
}

/** Last-sync bookkeeping for a single mapping, keyed by mapping id. */
export interface LastSyncState {
  mappingId: string;
  lastPushAt?: number;
  lastPullAt?: number;
  lastLocalSha?: string;
  lastRemoteSha?: string;
  status: SyncStatus;
}

/** Top-level persisted settings (the MUGS data plane). */
export interface MugsSettings {
  version: number;
  credentials: Credential[];
  mappings: FolderMapping[];
  /** Keyed by mappingId. */
  lastSync: Record<string, LastSyncState>;
  security: {
    /** When true, token field is encrypted at rest in data.json. */
    encryptCredentials: boolean;
    /** Placeholder for a future KDF-derived key input (not used yet). */
    encryptionKeyHint?: string;
  };
}

export const DEFAULT_SETTINGS: MugsSettings = {
  version: 1,
  credentials: [],
  mappings: [],
  lastSync: {},
  security: {
    encryptCredentials: false,
  },
};
