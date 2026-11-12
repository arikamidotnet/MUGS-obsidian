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

  constructor(private io: SettingsIO = new MemoryIO()) {
    // Clone the shared default so each store has its own mutable settings
    // (assigning by reference would let stores clobber one another's lastSync).
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  /** Why the last load failed, when it did (corrupt/unreadable data.json). */
  get loadError(): string | undefined {
    return this.loadErrorMessage;
  }

  async load(): Promise<MugsSettings> {
    const raw = await this.io.read();
    this.unreadableTokens.clear();
    this.loadErrorMessage = undefined;
    try {
      this.settings = parseSettings(raw ?? null) as unknown as MugsSettings;
    } catch (err) {
      // A corrupted or partial data.json must not brick the plugin: start from
      // defaults, record the failure, and refuse to save (below) so the corrupt
      // file is never silently overwritten with empty settings.
      this.loadErrorMessage = err instanceof Error ? err.message : String(err);
      console.error("MUGS: data.json could not be parsed — starting from defaults", err);
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
   * Never throws; never persists the passphrase.
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
      const trialKey = await derivePassphraseKey(passphrase, sec.kdf.salt, sec.kdf.iterations);
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

    const key = await derivePassphraseKey(passphrase, sec.kdf.salt, sec.kdf.iterations);
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
   * Re-passing a masked or already-cipher form (e.g., to change label) is allowed.
   */  upsertCredential(input: Omit<Credential, "token"> & { token: string }): Credential {
    const isRealSecret = !isMasked(input.token) && !isStoredCipher(input.token);
    if (isRealSecret && this.isLocked()) {
      throw new Error("MUGS: cannot add or replace a real credential secret while the store is locked");
    }
    const cred = { ...input };
    this.settings.credentials = this.settings.credentials.filter((c) => c.id !== cred.id);
    this.settings.credentials.push(cred);
    this.runtimeTokens.set(cred.id, cred.token);
    this.unreadableTokens.delete(cred.id); // a fresh token supersedes an undecryptable one
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
    const stored = this.settings.credentials.find((c) => c.id === id)?.token;
    if (stored === undefined || isMasked(stored) || isStoredCipher(stored)) return undefined;
    return stored;
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
