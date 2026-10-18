/**
 * MUGS — Multi-User Git Sync
 * Persistence layer.
 *
 * Tokens are kept in memory for git auth but never shown to the user, and are
 * optionally encrypted at rest. Any mapping whose vault folder lives under
 * `.obsidian/` is rejected before it can be persisted (Obsidian config must
 * never be synced as if it were user content).
 *
 * IO is injected so this module is fully unit-testable without Obsidian.
 */
import { DEFAULT_SETTINGS } from "./types";
import {
  parseSettings,
  redactToken,
  isBlockedFolder,
  normalizeVaultPath,
  type Settings,
} from "./schema";
import { deriveKey, encryptBytes, decryptBytes } from "./crypto";
import type {
  MugsSettings,
  FolderMapping,
  Credential,
  FileConflict,
  SyncPolicy,
  Agent,
  StagedChange,
} from "./types";

/** Minimal IO seam — matches Obsidian's loadData/saveData shape. */
export interface SettingsIO {
  read(): Promise<unknown> | unknown;
  write(data: unknown): Promise<void> | void;
}

/** In-memory IO for tests and non-Obsidian hosts. */
export class MemoryIO implements SettingsIO {
  private data: unknown = null;
  constructor(initial?: unknown) {
    this.data = initial ?? null;
  }
  async read(): Promise<unknown> {
    return this.data;
  }
  async write(data: unknown): Promise<void> {
    this.data = data;
  }
}

export class MugsStore {
  private settings: MugsSettings;
  /** Runtime tokens, keyed by credential id. Never persisted in plaintext unless encryption is off. */
  private runtimeTokens = new Map<string, string>();

  constructor(private io: SettingsIO = new MemoryIO()) {
    // Clone the shared default so each store has its own mutable settings
    // (assigning by reference would let stores clobber one another's lastSync).
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  async load(): Promise<MugsSettings> {
    const raw = await this.io.read();
    const parsed: Settings = parseSettings(raw ?? null);
    this.settings = parsed as unknown as MugsSettings;
    // Restore runtime tokens from disk. When encryption is on the stored token
    // is ciphertext and must be decrypted before it can be used for auth.
    this.runtimeTokens.clear();
    if (!this.settings.security.encryptCredentials) return this.getSettings();
    // Derive the key once — PBKDF2 is deliberately expensive (see crypto.ts).
    const key = await deriveKey(keyHint(this.settings));
    for (const c of this.settings.credentials) {
      if (!c.token || isMasked(c.token)) continue;
      this.runtimeTokens.set(c.id, await decryptToken(c.token, key));
    }
    return this.getSettings();
  }

  getSettings(): MugsSettings {
    return structuredClone(this.settings);
  }

  /** Settings with all tokens masked — safe to hand to the UI. */
  getDisplaySettings(): MugsSettings {
    const s = this.getSettings();
    s.credentials = s.credentials.map((c) => ({ ...c, token: redactToken(c.token) }));
    return s;
  }

  /** Add or replace a credential. Returns the stored (masked for display) copy. */
  upsertCredential(input: Omit<Credential, "token"> & { token: string }): Credential {
    const cred = { ...input };
    this.settings.credentials = this.settings.credentials.filter((c) => c.id !== cred.id);
    this.settings.credentials.push(cred);
    this.runtimeTokens.set(cred.id, cred.token);
    return { ...cred, token: redactToken(cred.token) };
  }

  removeCredential(id: string): void {
    this.settings.credentials = this.settings.credentials.filter((c) => c.id !== id);
    this.runtimeTokens.delete(id);
  }

  /** Add or replace a folder mapping, rejecting any that target .obsidian/ unless
   *  obsidian config sync is enabled (Area 9), in which case a dedicated `.obsidian`
   *  scope mapping is allowed and per-path classification decides what is shared. */
  upsertMapping(mapping: FolderMapping): FolderMapping {
    assertMappingAllowed(
      this.settings.mappings,
      mapping.localFolder,
      this.settings.sync.obsidianConfig.enabled,
    );
    this.settings.mappings = this.settings.mappings.filter((m) => m.id !== mapping.id);
    this.settings.mappings.push(mapping);
    return structuredClone(mapping);
  }

  removeMapping(id: string): void {
    this.settings.mappings = this.settings.mappings.filter((m) => m.id !== id);
  }

  setLastSync(state: MugsSettings["lastSync"][string]): void {
    this.settings.lastSync[state.mappingId] = state;
  }

  /** Conflicts recorded for a mapping (empty list when none). */
  getConflicts(mappingId: string): FileConflict[] {
    return this.settings.conflicts[mappingId] ?? [];
  }

  /** Replace the conflict list for a mapping; drops the entry entirely when empty. */
  setConflicts(mappingId: string, conflicts: FileConflict[]): void {
    if (conflicts.length === 0) delete this.settings.conflicts[mappingId];
    else this.settings.conflicts[mappingId] = conflicts;
  }

  /** Drop all recorded conflicts for a mapping. */
  clearConflicts(mappingId: string): void {
    delete this.settings.conflicts[mappingId];
  }

  setSecurity(partial: Partial<MugsSettings["security"]>): void {
    this.settings.security = { ...this.settings.security, ...partial };
  }

  /** Merge a partial update into the top-level sync policy (Area 2/5). */
  setSync(partial: Partial<SyncPolicy>): void {
    this.settings.sync = { ...this.settings.sync, ...partial };
  }

  // --- Agents / sub-users (Area 10) --------------------------------------

  getAgents(): Agent[] {
    return structuredClone(this.settings.agents);
  }

  /** Add or replace an agent/sub-user. Returns the stored copy. */
  upsertAgent(agent: Agent): Agent {
    this.settings.agents = this.settings.agents.filter((a) => a.id !== agent.id);
    this.settings.agents.push(structuredClone(agent));
    return structuredClone(agent);
  }

  removeAgent(id: string): void {
    this.settings.agents = this.settings.agents.filter((a) => a.id !== id);
  }

  // --- Staged changes / review queue (Area 8) ----------------------------

  getStaging(mappingId: string): StagedChange[] {
    return structuredClone(this.settings.staging[mappingId] ?? []);
  }

  /** Replace the staged-change list for a mapping; drops the entry when empty. */
  setStaging(mappingId: string, changes: StagedChange[]): void {
    if (changes.length === 0) delete this.settings.staging[mappingId];
    else this.settings.staging[mappingId] = structuredClone(changes);
  }

  // --- Obsidian config sync (Area 9) -------------------------------------

  setObsidianConfig(config: MugsSettings["sync"]["obsidianConfig"]): void {
    this.settings.sync.obsidianConfig = { ...this.settings.sync.obsidianConfig, ...config };
  }

  /** Toggle the opt-in .obsidian/ sync scope on or off. */
  setObsidianConfigEnabled(enabled: boolean): void {
    this.settings.sync.obsidianConfig = { ...this.settings.sync.obsidianConfig, enabled };
  }

  /** Persist current settings. Tokens are encrypted at rest when enabled. */
  async save(): Promise<void> {
    const toWrite = structuredClone(this.settings);
    if (toWrite.security.encryptCredentials) {
      // Derive once and reuse across credentials.
      const key = await deriveKey(keyHint(toWrite));
      for (const c of toWrite.credentials) {
        const real = this.runtimeTokens.get(c.id) ?? c.token;
        c.token = await encryptBytes(real, key);
      }
    }
    await this.io.write(toWrite);
  }

  /** Resolve the live token for a credential id (runtime secret). */
  getToken(id: string): string | undefined {
    return this.runtimeTokens.get(id) ?? this.settings.credentials.find((c) => c.id === id)?.token;
  }
}

/** Throw if adding a mapping would sync a blocked `.obsidian/` folder. A dedicated
 *  `.obsidian/` scope is permitted only when obsidian config sync is enabled. */
export function assertMappingAllowed(
  existing: FolderMapping[],
  localFolder: string,
  obsidianEnabled = false,
): void {
  if (isBlockedFolder(localFolder)) {
    const norm = normalizeVaultPath(localFolder);
    if (!(obsidianEnabled && norm.startsWith(".obsidian"))) {
      throw new Error(
        `Refusing to create mapping for "${localFolder}" — folders under .obsidian/ cannot be synced.`,
      );
    }
  }
}

/** True when a stored token looks masked rather than a real secret. */
function isMasked(token: string): boolean {
  if (!token) return true;
  return /^•+$/.test(token);
}

/** Derive key material from the user-provided hint (default when unset). */
function keyHint(s: MugsSettings): string {
  return s.security.encryptionKeyHint ?? "mugs-default-hint-v1";
}

/**
 * Decrypt a stored token, dispatching on its format:
 *  - `aesgcm:` → real AES-256-GCM (current).
 *  - `enc:`    → legacy XOR obfuscation (backward-compatible read of old data).
 *  - otherwise → already plaintext / masked; return as-is.
 */
async function decryptToken(token: string, key: CryptoKey): Promise<string> {
  if (token.startsWith("aesgcm:")) return decryptBytes(token, key);
  if (token.startsWith("enc:")) return legacyXorDecrypt(token);
  return token;
}

/**
 * Reversible counterpart to the historical XOR obfuscation. Kept only so tokens
 * written by older versions can still be read after upgrade; new writes use
 * AES-GCM via crypto.ts.
 */
function legacyXorDecrypt(cipher: string): string {
  const seed = xorFold(keyHintPlaceholder());
  const body = cipher.slice("enc:".length);
  return Array.from(body)
    .map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ seed[i % seed.length]))
    .join("");
}

function xorFold(key: string): number[] {
  const out = new Array(key.length).fill(0);
  let acc = 0;
  for (let i = 0; i < key.length; i++) {
    acc = (acc + key.charCodeAt(i) * (i + 1)) % 251;
    out[i] = acc;
  }
  return out;
}

// Legacy XOR was seeded from the hint string itself. When decrypting old data we
// no longer have the original hint object handy, so fall back to the default hint.
function keyHintPlaceholder(): string {
  return "mugs-default-hint-v1";
}
