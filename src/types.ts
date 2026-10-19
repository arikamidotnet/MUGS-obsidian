/**
 * MUGS — Multi-User Git Sync
 * Core domain types.
 *
 * The Zod schema in `schema.ts` is the single source of truth for the data
 * plane; these interfaces are derived from it (see `export type ... = z.infer`).
 * DEFAULT_SETTINGS lives here because it is plain runtime data, not a spec.
 */

/** Supported git backends. All are git-native; GitLab gets first-class REST support. */
export type ProviderKind = "github" | "gitlab" | "bitbucket" | "gitea" | "forgejo" | "local";

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
  /**
   * Explicit list of repositories this credential is scoped to, as `owner/repo`
   * paths (GitLab nested groups allowed: `group/sub/repo`). When non-empty, MUGS
   * treats these as the authoritative repo set and never calls a global
   * enumeration endpoint (`/projects`, `/user/repos`) — so it works with fine-
   * grained tokens that lack the user-level "list all projects" permission but
   * DO have project access. Absent/empty means "enumerate as usual".
   */
  repos?: string[];
}

/** A fine-grained folder mapping between a remote path and a vault folder. */
export interface FolderMapping {
  id: string;
  label: string;
  /** Path on the remote repo root ("" means the whole repository). */
  remotePath: string;
  /** Obsidian vault folder this maps to (must NOT live under .obsidian/ unless
   *  sync.obsidianConfig.enabled and this is a dedicated .obsidian scope). */
  localFolder: string;
  /** Id of the credential/provider used for this mapping. */
  providerId: string;
  /** Optional per-mapping branch override. Defaults to the remote HEAD branch. */
  branch?: string;
  /** Optional pinned agent sub-user id (Area 10). When set, pushes for this mapping are
   *  attributed to that agent with an "On-behalf-of" owner trailer so remote blame maps back.
   *  Absent -> normal sync attribution (unchanged). */
  agentId?: string;
  direction: SyncDirection;
  /** gitignore-style globs of paths WITHIN the scope that should sync.
   *  Empty or absent means "everything in scope". Composes with {@link excludes}. */
  includes?: string[];
  /** gitignore-style globs of paths within the scope to EXCLUDE from sync.
   *  Takes precedence over {@link includes}. */
  excludes?: string[];
  /** When false, the vault `.trash/` folder is excluded from this mapping's sync
   *  (opt-out; defaults to true). Only meaningful for whole-vault mappings. */
  syncTrashFolder?: boolean;
}

/** Deterministic tie-break for hunks a 3-way merge cannot resolve cleanly. */
export type DefaultResolution = "both" | "theirs" | "ours";

/** How a single top-level .obsidian/ entry is shared across the team. */
export type ObsidianScope = "vault-wide" | "personal";

/** Per-entry classification of one top-level .obsidian/ child (Area 9). */
export interface ObsidianEntryPolicy {
  /** Vault-relative path under .obsidian/ (e.g. "settings.json", "themes", "plugins"). */
  path: string;
  /** Whether this entry is shared across users or kept local to each user. */
  scope: ObsidianScope;
  /** Fine-grained gitignore globs included within this entry (optional). */
  includes?: string[];
  /** Fine-grained gitignore globs excluded within this entry (optional). */
  excludes?: string[];
}

/** Configuration for opt-in syncing of Obsidian's own .obsidian/ config. */
export interface ObsidianConfigPolicy {
  /** When false, .obsidian/ is rejected entirely (default). */
  enabled: boolean;
  /** Classification of each top-level .obsidian/ entry. */
  entries: ObsidianEntryPolicy[];
}

/** Automatic-first, git-reversible sync policy (Area 2 + operational flags). */
export interface SyncPolicy {
  /** When true (default), sync performs a 3-way merge on every divergence and
   *  applies clean results without prompting. */
  autoMerge: boolean;
  /** Tie-break for hunks the 3-way merge cannot resolve. Default "both".
   *  "ours"/"theirs" give last-write-wins if preferred. */
  defaultResolution: DefaultResolution;
  /** jj's same-change rule: identical changes on both sides auto-resolve. */
  sameChangeAccept: boolean;
  /** Auto-resolve genuine conflicts to the more-recently-saved side when both
   *  carry timestamps; falls back to {@link defaultResolution} otherwise. */
  recencyWins: boolean;
  /** Global maintenance pause (Area 8). While true, poll/event/auto-push/pull are suppressed. */
  paused: boolean;
  /** Adaptive remote-drift poll interval in seconds (~300 default; UI presets refine it). */
  intervalSeconds: number;
  /** Opt-in syncing of Obsidian's own config directory. */
  obsidianConfig: ObsidianConfigPolicy;
}

/** A human-and-agent-first contributor identity (Area 10). */
export interface Agent {
  /** Stable unique id within the vault's agent registry. */
  id: string;
  /** Human-friendly display name. */
  displayName: string;
  /** The person who authorizes this agent — used for remote attribution via an
   *  "On-behalf-of" trailer so remote blame maps back to a person. */
  ownerHuman?: string;
  /** Optional custom committer name (defaults to displayName). */
  committerName?: string;
  /** Optional custom committer email. */
  committerEmail?: string;
  /** Optional MCP endpoint for remote/external agents. */
  mcpEndpoint?: string;
}

/** Lifecycle state of a local change in the cleanup/review queue (Area 8). */
export type ChangeState = "unstaged" | "staged" | "held";

/** One curated change awaiting review/approval, keyed by mapping. */
export interface StagedChange {
  /** Mapping this change belongs to. */
  mappingId: string;
  /** Repo-relative path of the changed file. */
  path: string;
  /** Whether it is pending review (unstaged), selected for push (staged) or held back. */
  state: ChangeState;
}

/** One diverged file awaiting (or having undergone) resolution. Persisted per mapping so conflicts survive across sessions. */
export interface FileConflict {
  /** Repo-relative path of the conflicting file. */
  path: string;
  /** Last-synced baseline content, or undefined when new since last sync. */
  base?: string;
  /** Current local ("ours") content. */
  ours: string;
  /** Current remote ("theirs") content. */
  theirs: string;
  /** True when the local side is a deletion (jj `None`), distinct from an empty file. */
  oursAbsent?: boolean;
  /** True when the remote side is a deletion (jj `None`). */
  theirsAbsent?: boolean;
  /** Local save time (ms epoch) for recency-wins resolution, when known. */
  oursSavedAt?: number;
  /** Remote modification/commit time (ms epoch) for recency-wins, when known. */
  theirsModifiedAt?: number;
  /** True once the user has resolved this file. */
  resolved?: boolean;
  /** Resolved content written back to the working tree once `resolved`. */
  resolvedContent?: string;
}

/** Top-level persisted settings (the MUGS data plane). */
export interface MugsSettings {
  version: number;
  credentials: Credential[];
  mappings: FolderMapping[];
  /** Keyed by mappingId. */
  lastSync: Record<string, LastSyncState>;
  /** Per-mapping file-level conflicts awaiting resolution, keyed by mappingId. */
  conflicts: Record<string, FileConflict[]>;
  /** Automatic-first, git-reversible sync policy + operational flags (Area 2/5/8/9). */
  sync: SyncPolicy;
  /** Registered agents / sub-users (Area 10). Purely opt-in; empty by default. */
  agents: Agent[];
  /** Curated cleanup/review queue, keyed by mappingId (Area 8). Empty by default. */
  staging: Record<string, StagedChange[]>;
  security: {
    /** When true, token field is encrypted at rest in data.json. */
    encryptCredentials: boolean;
    /** Placeholder for a future KDF-derived key input (not used yet). */
    encryptionKeyHint?: string;
  };
}

/** The default sync policy — single source of truth shared by schema defaults. */
export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  autoMerge: true,
  defaultResolution: "both",
  sameChangeAccept: true,
  recencyWins: true,
  paused: false,
  intervalSeconds: 300,
  obsidianConfig: {
    enabled: false,
    entries: [
      { path: "settings.json", scope: "personal" },
      { path: "core.json", scope: "personal" },
      { path: "workspace.json", scope: "personal" },
      { path: "recent-files.json", scope: "personal" },
      { path: "keymaps.json", scope: "personal" },
      { path: "global.css", scope: "vault-wide" },
      { path: "plugins", scope: "vault-wide", excludes: ["*/data.json"] },
      { path: "themes", scope: "vault-wide" },
      { path: "snippets", scope: "vault-wide" },
      { path: "templates", scope: "vault-wide" },
    ],
  },
};

export const DEFAULT_SETTINGS: MugsSettings = {
  version: 1,
  credentials: [],
  mappings: [],
  lastSync: {},
  conflicts: {},
  sync: DEFAULT_SYNC_POLICY,
  agents: [],
  staging: {},
  security: {
    encryptCredentials: false,
  },
};

/** Last-sync bookkeeping for a single mapping, keyed by mapping id. */
export interface LastSyncState {
  mappingId: string;
  lastPushAt?: number;
  lastPullAt?: number;
  lastLocalSha?: string;
  lastRemoteSha?: string;
  /** Git base SHA this mapping's last sync was keyed on — the deterministic resume point
   *  so an offline session resumes cleanly and a reconnect reconciles forward. */
  baseSha?: string;
  /** Monotonic operation id for the last sync pass (increments per pull/push). */
  opId?: number;
  status: SyncStatus;
}
