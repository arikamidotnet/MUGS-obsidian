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
  type KdfParams,
} from "./schema";
import {
  DEFAULT_KDF_ALGORITHM,
  DEFAULT_KDF_ITERATIONS,
  PASSPHRASE_PREFIX,
  deriveKey,
  derivePassphraseKey,
  encryptBytes,
  decryptBytes,
  encryptAesGcm,
  decryptAesGcm,
  generateSalt,
} from "./crypto";
import type {
  MugsSettings,
  LastSyncState,
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

/** The persisted security block. `kdf` is written by this module; the hand-written
 *  interface in types.ts is updated by the lead's integration pass, so it is
 *  accessed through this widened type until then. */
type SecuritySettings = MugsSettings["security"] & { kdf?: KdfParams };

/**
 * Minimal secret-storage seam — mirrors Obsidian's `app.secretStorage`
 * (SecretStorage, 1.11.4+): a device-local, OS-keychain-backed key/value store.
 * Tokens live here (never in data.json) when it is available; the store keeps
 * only a `secretId` reference on the credential.
 */
export interface SecretStore {
  /** False when the host has no usable secret storage (older Obsidian/mobile). */
  available(): boolean;
  get(id: string): string | null;
  set(id: string, value: string): void;
  /** Best-effort removal of a stored secret. Optional: hosts without a delete
   *  API omit it, and callers must tolerate that (never rely on it). */
  delete?(id: string): void;
}

/** Live usability of a credential, as reported by {@link MugsStore.getCredentialStatus}.
 *  - "ready": the token (or local repo URL) resolves and is usable for auth now.
 *  - "missing-keychain": the credential references a keychain secret THIS device
 *    does not have (data.json synced from another machine, or a reset keyring).
 *  - "locked": the stored token is passphrase-encrypted and the vault is locked.
 *  - "missing": no usable token, keychain reference, or local repo URL at all. */
export type CredentialStatus = "ready" | "missing-keychain" | "locked" | "missing";

/** In-memory SecretStore for tests and non-Obsidian hosts. */
export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();
  constructor(private readonly enabled = true) {}
  available(): boolean { return this.enabled; }
  get(id: string): string | null { return this.secrets.get(id) ?? null; }
  set(id: string, value: string): void { this.secrets.set(id, value); }
  delete(id: string): void { this.secrets.delete(id); }
}

/** Derive a valid SecretStorage id for a credential. Obsidian requires lowercase
 *  alphanumeric with optional dashes (≤64 chars); credential ids are uuids, but
 *  the value is sanitized defensively and namespaced to avoid collisions. */
export function secretIdFor(credentialId: string): string {
  return `mugs-${credentialId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);
}

export class MugsStore {
  private settings: MugsSettings;
  /** Runtime tokens, keyed by credential id. Never persisted in plaintext unless encryption is off. */
  private runtimeTokens = new Map<string, string>();
  /** Credential ids whose stored token could not be decrypted (locked, wrong
   *  passphrase or corrupted): kept in storage for recovery, but never used for auth. */
  private unreadableTokens = new Set<string>();
  /** Set when data.json could not be parsed: saves are refused (see save) so the
   *  corrupt file is never silently overwritten with fresh defaults. */
  private loadErrorMessage?: string;
  /** Session key derived from the passphrase. NEVER persisted — lives only in
   *  memory until unlock()/setEncryptionPassphrase() provides the passphrase. */
  private passphraseKey?: CryptoKey;
  /** True once the current passphrase-derived key is available in memory. */
  private unlockedFlag = false;

  constructor(private io: SettingsIO = new MemoryIO(), private secrets?: SecretStore) {
    // Clone the shared default so each store has its own mutable settings
    // (assigning by reference would let stores clobber one another's lastSync).
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  /** Why the last load failed, when it did (corrupt/unreadable data.json). */
  get loadError(): string | undefined {
    return this.loadErrorMessage;
  }

  async load(): Promise<MugsSettings> {
    this.unreadableTokens.clear();
    this.loadErrorMessage = undefined;
    try {
      // The read AND the parse are both guarded: in real Obsidian, loadData()
      // JSON.parses data.json and THROWS on corrupt JSON, so a corrupt file makes
      // io.read() reject — not just parseSettings. Either failure must degrade to
      // defaults, never brick the plugin.
      const raw = await this.io.read();
      this.settings = parseSettings(raw ?? null) as unknown as MugsSettings;
    } catch (err) {
      // A corrupted or partial data.json must not brick the plugin: start from
      // defaults, record the failure, and refuse to save (below) so the corrupt
      // file is never silently overwritten with empty settings.
      this.loadErrorMessage = err instanceof Error ? err.message : String(err);
      console.error("MUGS: data.json could not be read/parsed — starting from defaults", err);
      this.settings = structuredClone(DEFAULT_SETTINGS);
      this.runtimeTokens.clear();
      return this.getSettings();
    }
    // Restore runtime tokens from disk. When encryption is on the stored token
    // is ciphertext and must be decrypted before it can be used for auth. A failed
    // decrypt (locked, wrong passphrase, corrupted) degrades that credential to
    // "missing token" instead of throwing the whole load away; the stored
    // ciphertext is kept so the right passphrase can still recover it.
    this.runtimeTokens.clear();
    this.passphraseKey = undefined;
    this.unlockedFlag = false;
    const sec = this.security();
    if (!sec.encryptCredentials) return this.getSettings();
    if (sec.kdf) {
      // Passphrase scheme: tokens stay unreadable (locked) until unlock() supplies
      // the passphrase. Load NEVER throws and NEVER needs the passphrase.
      let legacyKey: CryptoKey | undefined;
      const legacy = async (): Promise<CryptoKey> => (legacyKey ??= await deriveKey(keyHint(this.settings)));
      for (const c of this.settings.credentials) {
        if (!c.token || isMasked(c.token)) continue;
        if (c.token.startsWith(PASSPHRASE_PREFIX)) {
          // Expected while locked — not an error, so no console noise.
          this.unreadableTokens.add(c.id);
          continue;
        }
        try {
          this.runtimeTokens.set(c.id, await decryptStoredToken(c.token, undefined, legacy));
          this.unreadableTokens.delete(c.id);
        } catch (err) {
          console.error("MUGS: could not decrypt the stored token for", c.label, err);
          this.unreadableTokens.add(c.id);
        }
      }
      return this.getSettings();
    }
    // Legacy hint scheme (no kdf): unchanged pre-migration behavior. Derive the
    // key once — PBKDF2 is deliberately expensive (see crypto.ts).
    const key = await deriveKey(keyHint(this.settings));
    for (const c of this.settings.credentials) {
      if (!c.token || isMasked(c.token)) continue;
      try {
        this.runtimeTokens.set(c.id, await decryptToken(c.token, key));
      } catch (err) {
        console.error("MUGS: could not decrypt the stored token for", c.label, err);
        this.unreadableTokens.add(c.id);
      }
    }
    return this.getSettings();
  }

  /** Widened view of the security block (includes the passphrase-KDF params). */
  private security(): SecuritySettings {
    return this.settings.security as SecuritySettings;
  }

  /** True when tokens on disk are passphrase-encrypted and no passphrase has
   *  been supplied yet this session. While locked, every credential resolves
   *  to the visible "missing token" state instead of its secret. */
  isLocked(): boolean {
    const sec = this.security();
    return !!sec.encryptCredentials && !!sec.kdf && !this.unlockedFlag;
  }

  /**
   * Unlock credential decryption for this session with the vault passphrase.
   * - Legacy vaults (old `encryptionKeyHint` scheme, no `kdf`): the supplied
   *   passphrase BECOMES the new passphrase — every readable token is
   *   re-encrypted under the passphrase scheme, the KDF params are created and
   *   the hint field is dropped. Persist with `save()` (Apply) to keep it.
   * - Passphrase vaults: the correct passphrase decrypts every locked token
   *   (true returned). A wrong passphrase leaves those credentials in the
   *   visible "missing token" state (false returned) — nothing throws, and a
   *   later unlock with the right passphrase recovers them.
   * Never throws (corrupt persisted KDF parameters resolve to false); never persists
   * the passphrase.
   */
  async unlock(passphrase: string): Promise<boolean> {
    const sec = this.security();
    if (!sec.encryptCredentials) return true; // encryption off — nothing is locked
    if (!sec.kdf) return this.migrateToPassphrase(passphrase);
    if (!passphrase) return false;

    // If already unlocked this session, treat a subsequent call as a verification attempt.
    // A wrong passphrase must not clobber runtime tokens or flip state.
    if (this.unlockedFlag) {
      // Verify by deriving a trial key and checking it can decrypt at least one
      // pw-cipher stored token whose plaintext we already know via runtime.
      let trialKey: CryptoKey;
      try {
        trialKey = await derivePassphraseKey(passphrase, sec.kdf.salt, sec.kdf.iterations);
      } catch {
        // Corrupt persisted KDF params (e.g. an invalid salt) — treat like a wrong
        // passphrase instead of throwing out of a method documented "never throws".
        return false;
      }
      for (const c of this.settings.credentials) {
        if (!c.token || !c.token.startsWith(PASSPHRASE_PREFIX)) continue;
        const known = this.runtimeTokens.get(c.id);
        if (known === undefined) continue;
        try {
          const pt = await decryptAesGcm(c.token, trialKey);
          if (pt === known) return true; // same effective key, no-op re-unlock
        } catch {
          // trial key cannot open a known-good token → wrong passphrase
          return false;
        }
      }
      // No probe possible (no pw-cipher with known runtime) — conservatively accept as no-op.
      return true;
    }

    let key: CryptoKey;
    try {
      key = await derivePassphraseKey(passphrase, sec.kdf.salt, sec.kdf.iterations);
    } catch {
      // Corrupt persisted KDF params — tokens stay locked; never throw.
      return false;
    }
    let legacyKey: CryptoKey | undefined;
    const legacy = async (): Promise<CryptoKey> => (legacyKey ??= await deriveKey(keyHint(this.settings)));
    let failures = 0;
    for (const c of this.settings.credentials) {
      if (!c.token || isMasked(c.token)) continue;
      if (this.runtimeTokens.has(c.id)) continue; // already readable this session
      try {
        const pt = await decryptStoredToken(c.token, key, legacy);
        this.runtimeTokens.set(c.id, pt);
        this.unreadableTokens.delete(c.id);
      } catch (err) {
        console.error("MUGS: stored token for", c.label, "could not be decrypted with this passphrase");
        this.unreadableTokens.add(c.id);
        failures++;
      }
    }
    if (failures === 0) {
      this.passphraseKey = key;
      this.unlockedFlag = true;
    }
    // Treat any remaining unreadable passphrase-scheme tokens as a failure for the
    // "full unlock" contract: unlock returns true only when every locked token is readable.
    const remainingPwUnreadable = this.settings.credentials.some(
      (c) => c.token && c.token.startsWith(PASSPHRASE_PREFIX) && this.unreadableTokens.has(c.id)
    );
    const allGood = failures === 0 && !remainingPwUnreadable;
    if (allGood) {
      this.passphraseKey = key;
      this.unlockedFlag = true;
    }
    return allGood;
  }

  /**
   * Explicit decrypt-all transaction to disable encryption.
   * Preconditions:
   * - must be fully unlocked (passphrase scheme, no unreadable tokens this session).
   * On success: every credential token is rewritten to its plaintext in-memory value,
   * security.encryptCredentials is set false, kdf removed (hint already absent for pw scheme).
   * On any per-item failure (cannot obtain plaintext for a credential): return {ok:false, failures:[ids]},
   * and the previous durable state (encrypted) remains valid; caller must not save a half-disabled state.
   * The result is observable so callers (next wave) can surface the outcome.
   */
  async disableEncryption(): Promise<{ ok: boolean; failures: string[] }> {
    const sec = this.security();
    if (!sec.encryptCredentials) {
      return { ok: true, failures: [] };
    }
    if (sec.kdf && !this.unlockedFlag) {
      // Not fully unlocked — cannot guarantee we can emit plaintext for everything.
      // Surface a failure without mutating durable state.
      const stillBad = this.settings.credentials
        .filter((c) => c.token && !isMasked(c.token) && isStoredCipher(c.token) && !this.runtimeTokens.has(c.id))
        .map((c) => c.id);
      return { ok: false, failures: stillBad.length ? stillBad : ["*"] };
    }
    const failures: string[] = [];
    for (const c of this.settings.credentials) {
      if (!c.token || isMasked(c.token)) continue;
      if (isStoredCipher(c.token)) {
        const pt = this.runtimeTokens.get(c.id);
        if (pt === undefined) {
          failures.push(c.id);
          continue;
        }
        c.token = pt;
      }
      // plaintext or already plaintext passes through
    }
    if (failures.length > 0) {
      // Do not flip the durable security flag; previous encrypted state stays valid.
      return { ok: false, failures };
    }
    // Full success — commit disable
    this.settings.security = { ...sec, encryptCredentials: false };
    // Remove kdf and any stale hint for cleanliness (additive, minimal)
    const s2 = this.security();
    delete (s2 as any).kdf;
    delete (s2 as any).encryptionKeyHint;
    this.unlockedFlag = false;
    this.passphraseKey = undefined;
    return { ok: true, failures: [] };
  }

  /**
   * First-time enable / change of the vault passphrase: re-encrypts every
   * readable token under a fresh per-vault salt and stores only the KDF
   * params (never the passphrase). The passphrase argument is forgotten as
   * soon as the key is derived. Persist with `save()` (Apply) to keep it.
   *
   * Throws only when misused: empty passphrase, or changing the passphrase
   * while the store is still locked with credentials present (unlock first —
   * otherwise still-locked tokens could not be carried over to the new key).
   */
  async setEncryptionPassphrase(passphrase: string): Promise<void> {
    if (!passphrase) throw new Error("MUGS: the encryption passphrase must not be empty.");
    const sec = this.security();
    if (sec.kdf && this.isLocked() && this.settings.credentials.length > 0) {
      throw new Error("MUGS: unlock with the current passphrase before changing it.");
    }
    const salt = generateSalt();
    const iterations = DEFAULT_KDF_ITERATIONS;
    const key = await derivePassphraseKey(passphrase, salt, iterations);
    for (const c of this.settings.credentials) {
      // Undecryptable stored tokens are left untouched (their old ciphertext
      // may still be recoverable from a backup); nothing is lost by skipping.
      if (this.unreadableTokens.has(c.id)) continue;
      const real = this.runtimeTokens.get(c.id) ?? c.token;
      if (!real || isMasked(real)) continue;
      // Already-ciphertext tokens without a newer runtime plaintext are left as-is;
      // PLAINTEXT stored tokens are (re-)encrypted even when unchanged — enabling
      // encryption from plaintext mode must always encrypt.
      if (real === c.token && isStoredCipher(c.token)) continue;
      c.token = await encryptAesGcm(real, key);
    }
    const next: SecuritySettings = {
      ...sec,
      encryptCredentials: true,
      kdf: { algorithm: DEFAULT_KDF_ALGORITHM, salt, iterations },
    };
    delete next.encryptionKeyHint; // migration: the hint scheme is replaced, not kept alongside
    this.settings.security = next;
    this.passphraseKey = key;
    this.unlockedFlag = true;
  }

  /**
   * One-time migration off the legacy `encryptionKeyHint` scheme: decrypt every
   * stored token with the hint key (or XOR / plaintext paths), re-encrypt under
   * the supplied passphrase with a fresh per-vault salt, drop the hint field
   * and store the KDF params. The supplied passphrase becomes the vault
   * passphrase. Called by `unlock` on the first unlock of a legacy vault.
   *
   * ATOMICITY: only when ALL candidate tokens are recoverable do we replace
   * the durable security block (install kdf, delete hint) and rewrite tokens
   * under the new scheme. On any failure we leave the previous durable
   * document fully valid (legacy ciphertext + hint intact) so that a later
   * complete recovery can still succeed. Successfully decrypted tokens are
   * made available via runtime for this session without mutating storage.
   * Retries are idempotent: no double-encryption occurs because we only
   * rewrite on a full-success commit.
   */
  private async migrateToPassphrase(passphrase: string): Promise<boolean> {
    if (!passphrase) return false;
    const sec = this.security();
    const legacyKey = await deriveKey(keyHint(this.settings));
    // First pass: attempt to obtain plaintext for every candidate without
    // mutating stored tokens or security metadata. Track failures.
    const work: Array<{ c: any; pt: string }> = [];
    let failures = 0;
    for (const c of this.settings.credentials) {
      if (!c.token || isMasked(c.token)) continue;
      // If already in target scheme in memory (should not happen pre-commit), leave it.
      if (c.token.startsWith(PASSPHRASE_PREFIX)) continue;
      try {
        const pt = await decryptToken(c.token, legacyKey);
        work.push({ c, pt });
      } catch (err) {
        this.unreadableTokens.add(c.id);
        failures++;
        console.error("MUGS: could not migrate the stored token for", c.label, err);
      }
    }
    if (failures > 0) {
      // Partial failure: do not install KDF, do not delete hint, do not rewrite
      // any stored token to the new scheme. Durable document remains the
      // previous valid legacy state. Make readable ones usable this session.
      for (const { c, pt } of work) {
        this.runtimeTokens.set(c.id, pt);
        this.unreadableTokens.delete(c.id);
      }
      this.passphraseKey = undefined;
      this.unlockedFlag = false;
      return false;
    }
    // Full success path: now safe to commit migration atomically.
    const salt = generateSalt();
    const iterations = DEFAULT_KDF_ITERATIONS;
    const key = await derivePassphraseKey(passphrase, salt, iterations);
    for (const { c, pt } of work) {
      c.token = await encryptAesGcm(pt, key);
      this.runtimeTokens.set(c.id, pt);
      this.unreadableTokens.delete(c.id);
    }
    const next: SecuritySettings = {
      ...sec,
      encryptCredentials: true,
      kdf: { algorithm: DEFAULT_KDF_ALGORITHM, salt, iterations },
    };
    delete next.encryptionKeyHint;
    this.settings.security = next;
    this.passphraseKey = key;
    this.unlockedFlag = true;
    return true;
  }

  getSettings(): MugsSettings {
    return structuredClone(this.settings);
  }

  /** Scheduling needs configuration, never persisted note/conflict payloads. */
  getAutomaticSettings(): Pick<MugsSettings, "sync" | "mappings"> {
    return structuredClone({ sync: this.settings.sync, mappings: this.settings.mappings });
  }

  getLastSync(mappingId: string): LastSyncState | undefined {
    return structuredClone(this.settings.lastSync[mappingId]);
  }

  /** Settings with all tokens masked — safe to hand to the UI. */
  getDisplaySettings(): MugsSettings {
    const s = this.getSettings();
    s.credentials = s.credentials.map((c) => ({ ...c, token: redactToken(c.token) }));
    return s;
  }

  /** Add or replace a credential. Returns the stored (masked for display) copy.
   *
   * While the store is locked (passphrase scheme active and no successful unlock
   * this session), supplying a *real secret* (neither masked nor stored-cipher)
   * is rejected. This prevents creating runtime-only credentials that cannot be
   * durably persisted, and prevents persisting an unusable LOCKED_PERSIST_MASK
   * for a brand-new token.
   *
   * METADATA-ONLY EDITS: re-passing the credential's masked display form (the UI
   * only ever sees masked tokens) or its already-cipher stored form updates ONLY
   * the metadata (label/kind/baseUrl) — the DURABLE token is preserved verbatim
   * and the runtime plaintext map + any unreadable marker are untouched. A
   * display mask keeps its last 4 characters, so isMasked (all-bullets) alone
   * cannot recognize it: a re-supply equal to redactToken(stored) also counts.
   * Without this, a label rename would poison the token map (sync would hand
   * the mask/cipher to git as if it were the secret).
   */
  upsertCredential(input: Omit<Credential, "token"> & { token: string }): Credential {
    const prior = this.settings.credentials.find((c) => c.id === input.id);
    const isStoredRedaction = prior !== undefined && input.token === redactToken(prior.token);
    const isMetadataOnly =
      prior !== undefined && (isMasked(input.token) || isStoredCipher(input.token) || isStoredRedaction);
    if (!isMetadataOnly && this.isLocked()) {
      throw new Error("MUGS: cannot add or replace a real credential secret while the store is locked");
    }
    // Metadata-only: keep the prior durable token AND its keychain reference;
    // only the metadata fields change. (A caller that omitted secretId must not
    // orphan the keychain entry the prior credential pointed at.)
    const cred = isMetadataOnly && prior ? { ...input, token: prior.token, secretId: prior.secretId } : { ...input };
    this.settings.credentials = this.settings.credentials.filter((c) => c.id !== cred.id);
    this.settings.credentials.push(cred);
    if (!isMetadataOnly) {
      // A real secret supersedes the runtime plaintext and clears an undecryptable marker.
      this.runtimeTokens.set(cred.id, cred.token);
      this.unreadableTokens.delete(cred.id);
      // Prefer the OS keychain — but only a VERIFIED write may blank the durable
      // token. If the keychain silently drops the secret (Linux without a running
      // keyring daemon) or rejects the write, the token stays in data.json (or
      // encrypted under the passphrase) and any stale secretId is cleared so the
      // credential never points at a keychain entry that does not hold the secret.
      if (cred.token && !isMasked(cred.token)) {
        const sid = secretIdFor(cred.id);
        if (this.tryStoreInKeychain(sid, cred.token)) {
          cred.secretId = sid;
          cred.token = "";
        } else {
          delete cred.secretId;
        }
      }
    }
    return { ...cred, token: redactToken(cred.token) };
  }

  removeCredential(id: string): void {
    this.settings.credentials = this.settings.credentials.filter((c) => c.id !== id);
    this.runtimeTokens.delete(id);
    this.unreadableTokens.delete(id);
  }

  /** Add or replace a folder mapping, rejecting any that target .obsidian/ unless
   *  obsidian config sync is enabled (Area 9), in which case a dedicated `.obsidian`
   *  scope mapping is allowed and per-path classification decides what is shared. */
  upsertMapping(mapping: FolderMapping): FolderMapping {
    assertMappingAllowed(
      mapping.localFolder,
      this.settings.sync.obsidianConfig.enabled,
    );
    this.settings.mappings = this.settings.mappings.filter((m) => m.id !== mapping.id);
    this.settings.mappings.push(mapping);
    return structuredClone(mapping);
  }

  removeMapping(id: string): void {
    this.settings.mappings = this.settings.mappings.filter((m) => m.id !== id);
    // Prune the mapping's keyed records so megabytes of stale conflict content
    // don't linger (and grow data.json) forever after a mapping is deleted.
    delete this.settings.lastSync[id];
    delete this.settings.conflicts[id];
    delete this.settings.staging[id];
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

  // The chain value is never read — only ordering matters — so its type is irrelevant.
  private saveChain: Promise<unknown> = Promise.resolve({ ok: true });

  /** Persist current settings. Tokens are encrypted at rest when enabled.
   *  Refused while data.json is unreadable so a corrupt file is never overwritten
   *  with fresh defaults (the user is told to fix or restore it first).
   *
   *  Returns an observable SaveResult. Calls are serialized.
   */
  async save(): Promise<SaveResult> {
    // Enqueue: the actual work runs after the previous save completes.
    // Clone happens *inside* the slot so later mutations are seen by later saves.
    const myTurn = this.saveChain.then(async (): Promise<SaveResult> => {
      if (this.loadErrorMessage) {
        console.warn("MUGS: refusing to save over unreadable data.json — fix or restore it, then reload the plugin.");
        return { ok: false, reason: "load-error" };
      }
      const toWrite = structuredClone(this.settings);
      const sec = toWrite.security as SecuritySettings;
      if (sec.encryptCredentials && sec.kdf) {
        if (this.unlockedFlag && this.passphraseKey) {
          // Unlocked: (re-)encrypt every readable token under the passphrase key.
          // Undecryptable stored tokens are left untouched (the right passphrase
          // on a later unlock can still recover them).
          for (const c of toWrite.credentials) {
            if (c.secretId) { c.token = ""; continue; } // secret lives in the OS keychain
            if (this.unreadableTokens.has(c.id)) continue;
            const real = this.runtimeTokens.get(c.id) ?? c.token;
            if (!real || isMasked(real)) continue;
            if (real === c.token && isStoredCipher(c.token)) continue;
            c.token = await encryptAesGcm(real, this.passphraseKey);
          }
        } else {
          // Locked: no passphrase key in memory, so nothing new can be encrypted.
          // Existing ciphertext/masks pass through unchanged; a plaintext token
          // (e.g. a credential added while locked) is replaced with an all-bullet
          // mask (isMasked-recognizable on the next load) instead of being leaked.
          for (const c of toWrite.credentials) {
            if (c.secretId) { c.token = ""; continue; } // secret lives in the OS keychain
            if (!isStoredCipher(c.token) && !isMasked(c.token)) {
              c.token = LOCKED_PERSIST_MASK;
            }
          }
        }
      } else if (sec.encryptCredentials) {
        // Legacy hint scheme (no kdf yet) — unchanged pre-migration behavior.
        // Derive once and reuse across credentials. Undecryptable stored tokens are
        // left untouched (the right key hint can still recover them).
        const key = await deriveKey(keyHint(toWrite));
        for (const c of toWrite.credentials) {
          if (c.secretId) { c.token = ""; continue; } // secret lives in the OS keychain
          if (this.unreadableTokens.has(c.id)) continue;
          const real = this.runtimeTokens.get(c.id) ?? c.token;
          c.token = await encryptBytes(real, key);
        }
      }
      await this.io.write(toWrite);
      return { ok: true };
    });
    // Keep the chain alive even when a write rejects: a rejected chained promise
    // would otherwise make every later save() no-op into that same rejection
    // instead of retrying. The caller still observes myTurn's own result.
    this.saveChain = myTurn.then(
      () => undefined,
      () => undefined,
    );
    return myTurn;
  }

  /** Resolve the live token for a credential id (runtime secret). Undecryptable
   *  or locked stored tokens resolve to undefined so sync reports "missing token"
   *  clearly; stored ciphertext/masks are never handed out as if they were secrets. */
  getToken(id: string): string | undefined {
    if (this.unreadableTokens.has(id)) return undefined;
    const runtime = this.runtimeTokens.get(id);
    if (runtime !== undefined) return runtime;
    const cred = this.settings.credentials.find((c) => c.id === id);
    // Prefer the OS keychain (SecretStorage) reference when the credential has one.
    if (cred?.secretId && this.secrets?.available()) {
      const secret = this.secrets.get(cred.secretId);
      if (secret) return secret;
    }
    const stored = cred?.token;
    if (stored === undefined || isMasked(stored) || isStoredCipher(stored)) return undefined;
    return stored;
  }

  /** Why a credential is (not) usable for auth right now. Pure state inspection —
   *  never throws, never writes. Lets the UI tell "locked" apart from "the token
   *  simply is not on this device" instead of lumping both into missing-token. */
  getCredentialStatus(id: string): CredentialStatus {
    const cred = this.settings.credentials.find((c) => c.id === id);
    if (!cred) return "missing";
    // A local repo needs no secret: it is ready iff it points at a repo path.
    if (cred.kind === "local") return cred.baseUrl?.trim() ? "ready" : "missing";
    if (this.getToken(id)) return "ready";
    if (
      this.unreadableTokens.has(id) ||
      (this.isLocked() && cred.token && isStoredCipher(cred.token))
    ) {
      return "locked";
    }
    // Keychain-referenced with nothing durable in data.json and nothing readable
    // in the keychain: the reference is orphaned on this device.
    if (cred.secretId && !cred.token) return "missing-keychain";
    return "missing";
  }

  /** Attempt a VERIFIED keychain write: the secret only counts as stored when an
   *  immediate read-back returns exactly what was written. Obsidian's
   *  SecretStorage can silently drop writes (Linux without a running keyring
   *  daemon, e.g. COSMIC/Hyprland/Sway) or throw outright — both must resolve to
   *  `false` so the caller keeps the token in data.json instead of wiping it and
   *  losing the credential after the next reload. Never throws; warns once per
   *  failed attempt. */
  private tryStoreInKeychain(sid: string, secret: string): boolean {
    if (!this.secrets?.available() || !secret || isMasked(secret)) return false;
    try {
      this.secrets.set(sid, secret);
      if (this.secrets.get(sid) === secret) return true;
      console.warn(
        "MUGS: the OS keychain did not retain the secret on read-back — keeping the token in data.json instead.",
      );
      return false;
    } catch (err) {
      console.warn(
        "MUGS: the OS keychain rejected the secret write — keeping the token in data.json instead.",
        err,
      );
      return false;
    }
  }

  /**
   * Move every stored plaintext/ciphertext token into SecretStorage (the OS
   * keychain) and blank the durable field so data.json never holds a secret.
   * Idempotent and lossless: the durable token is dropped ONLY after a verified
   * round-trip write (set + immediate read-back equality); on any failure the
   * stored form is kept for a retry. Locked vaults migrate nothing naturally —
   * their tokens have no readable plaintext — while unlocked passphrase-encrypted
   * tokens keep migrating (keychain precedence when it is actually usable).
   * Returns the number of credentials migrated. No-op without a SecretStore.
   */
  async migrateTokensToSecretStorage(): Promise<number> {
    if (!this.secrets?.available()) return 0;
    let migrated = 0;
    for (const c of this.settings.credentials) {
      if (c.secretId) continue;
      // Prefer the live plaintext (plaintext or unlocked vaults); never move a
      // stored ciphertext/mask as if it were the secret.
      const real = this.runtimeTokens.get(c.id) ?? (isStoredCipher(c.token) || isMasked(c.token) ? undefined : c.token);
      if (!real) continue;
      const sid = secretIdFor(c.id);
      if (!this.tryStoreInKeychain(sid, real)) {
        continue; // keep the stored form; retry on the next load
      }
      c.secretId = sid;
      c.token = "";
      this.runtimeTokens.set(c.id, real);
      migrated++;
    }
    return migrated;
  }
}

/**
 * Result of a save attempt. Observable to callers so that sync (next wave)
 * can never report success on a silent non-save.
 *
 * Contract (for Wave B):
 * - { ok: true } — persisted (encryption applied per current runtime state).
 * - { ok: false, reason: 'load-error' } — refused because a prior load of data.json failed;
 *   the corrupt file was not overwritten. Callers must surface the loadError to the user.
 *
 * Saves are serialized (queued). A snapshot is cloned inside the execution slot
 * (not at call time), so a later save cannot be overwritten by a stale earlier snapshot.
 */
export type SaveResult =
  | { ok: true }
  | { ok: false; reason: "load-error" };

/** Throw if adding a mapping would sync a blocked `.obsidian/` folder. A dedicated
 *  `.obsidian/` scope is permitted only when obsidian config sync is enabled. */
export function assertMappingAllowed(
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

/** All-bullet placeholder persisted for a credential whose plaintext token
 *  could not be encrypted (added while locked). Recognized by isMasked on the
 *  next load, so it is never handed out as if it were a real secret. */
const LOCKED_PERSIST_MASK = "••••••••";

/** True when a stored token looks masked rather than a real secret. */
function isMasked(token: string): boolean {
  if (!token) return true;
  return /^•+$/.test(token);
}

/** True when a stored token is serialized ciphertext from any known scheme
 *  (passphrase AES-GCM, legacy hint AES-GCM, or legacy XOR) rather than a
 *  plaintext secret. */
function isStoredCipher(token: string): boolean {
  return (
    token.startsWith(PASSPHRASE_PREFIX) ||
    token.startsWith("aesgcm:") ||
    token.startsWith("enc:")
  );
}

/**
 * Decrypt a stored token, dispatching on its format:
 *  - `aesgcm-pw:` → passphrase-scheme AES-256-GCM (needs the passphrase key).
 *  - `aesgcm:`    → legacy hint-derived AES-256-GCM (needs the hint key).
 *  - `enc:`       → legacy XOR obfuscation (keyless).
 *  - otherwise    → already plaintext / masked; return as-is.
 * `passphraseKey` decrypts only the passphrase scheme; `legacyKey()` is derived
 * lazily so plaintext/`enc:` tokens never pay for a PBKDF2 run.
 */
async function decryptStoredToken(
  token: string,
  passphraseKey: CryptoKey | undefined,
  legacyKey: () => Promise<CryptoKey>,
): Promise<string> {
  if (token.startsWith(PASSPHRASE_PREFIX)) {
    if (!passphraseKey) throw new Error("store is locked — no passphrase key in memory");
    return decryptAesGcm(token, passphraseKey);
  }
  if (token.startsWith("enc:")) return legacyXorDecrypt(token);
  if (token.startsWith("aesgcm:")) return decryptBytes(token, await legacyKey());
  return token;
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
