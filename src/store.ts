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
import type { MugsSettings, FolderMapping, Credential } from "./types";

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
    this.settings = DEFAULT_SETTINGS;
  }

  async load(): Promise<MugsSettings> {
    const raw = await this.io.read();
    const parsed: Settings = parseSettings(raw ?? null);
    this.settings = parsed as unknown as MugsSettings;
    // Restore runtime tokens from disk. When encryption is on the stored token
    // is ciphertext and must be decrypted before it can be used for auth.
    this.runtimeTokens.clear();
    const encrypted = this.settings.security.encryptCredentials;
    for (const c of this.settings.credentials) {
      if (!c.token || isMasked(c.token)) continue;
      const real = encrypted ? decrypt(c.token, keyHint(this.settings)) : c.token;
      this.runtimeTokens.set(c.id, real);
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

  /** Add or replace a folder mapping, rejecting any that target .obsidian/. */
  upsertMapping(mapping: FolderMapping): FolderMapping {
    assertMappingAllowed(this.settings.mappings, mapping.localFolder);
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

  setSecurity(partial: Partial<MugsSettings["security"]>): void {
    this.settings.security = { ...this.settings.security, ...partial };
  }

  /** Persist current settings. Tokens are encrypted at rest when enabled. */
  async save(): Promise<void> {
    const toWrite = structuredClone(this.settings);
    if (toWrite.security.encryptCredentials) {
      for (const c of toWrite.credentials) {
        const real = this.runtimeTokens.get(c.id) ?? c.token;
        c.token = encrypt(real, keyHint(toWrite));
      }
    }
    await this.io.write(toWrite);
  }

  /** Resolve the live token for a credential id (runtime secret). */
  getToken(id: string): string | undefined {
    return this.runtimeTokens.get(id) ?? this.settings.credentials.find((c) => c.id === id)?.token;
  }
}

/** Throw if adding `mapping` would sync a blocked folder. */
export function assertMappingAllowed(
  existing: FolderMapping[],
  localFolder: string,
): void {
  if (isBlockedFolder(localFolder)) {
    throw new Error(
      `Refusing to create mapping for "${localFolder}" — folders under .obsidian/ cannot be synced.`,
    );
  }
}

/** True when a stored token looks masked rather than a real secret. */
function isMasked(token: string): boolean {
  if (!token) return true;
  return /^•+$/.test(token);
}

/**
 * Derive an encryption key material from the user-provided hint. This is a
 * placeholder KDF — Phase 2 will swap in WebCrypto AES-GCM with PBKDF2/HKDF.
 */
function keyHint(s: MugsSettings): string {
  return s.security.encryptionKeyHint ?? "mugs-default-hint-v1";
}

/**
 * Deterministic, reversible obfuscation used while encryption is enabled.
 * NOT real cryptography — replaced by AES-GCM in a later phase. Kept simple so
 * it is unit-testable and dependency-free today.
 */
function encrypt(plaintext: string, key: string): string {
  const seed = xorFold(key);
  return "enc:" + Array.from(plaintext)
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

/** Reversible counterpart to `encrypt` — used when loading encrypted settings. */
function decrypt(cipher: string, key: string): string {
  if (!cipher.startsWith("enc:")) return cipher; // already plaintext / migration
  const seed = xorFold(key);
  const body = cipher.slice(4);
  return Array.from(body)
    .map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ seed[i % seed.length]))
    .join("");
}
