/**
 * MUGS — encryption at rest for stored tokens.
 *
 * Two schemes live here:
 *
 * 1. LEGACY (hint-derived): AES-256-GCM with a key derived from the stored
 *    `security.encryptionKeyHint` via PBKDF2-SHA-256 and a fixed application
 *    salt, serialized as `aesgcm:` + base64(iv || ciphertext). This protects
 *    nothing (the hint ships in the same data.json) — it is kept ONLY so data
 *    written by older versions still loads and can be migrated.
 *
 * 2. PASSPHRASE (current): AES-256-GCM with a key derived from a user-chosen
 *    passphrase that is NEVER persisted, a random per-vault salt and the
 *    PBKDF2 iteration count (both stored in `security.kdf`), serialized as
 *    `aesgcm-pw:` + base64(iv || ciphertext). Only ciphertext, salt and
 *    iteration count ever reach disk.
 *
 * Both use WebCrypto (`crypto.subtle`), available in Obsidian's Electron
 * runtime and Node >= 18. Base64 uses Buffer when present (Node) and falls
 * back to the browser globals otherwise.
 */

const LEGACY_PREFIX = "aesgcm:";
const PBKDF2_ITERATIONS = 250_000;
const AES_NAME = "AES-GCM";
const KEY_LENGTH = 256;
const IV_BYTES = 12;
// Fixed application salt for the LEGACY hint scheme. Per-message IV provides
// uniqueness; the key is derived solely from the hint so a reload with the
// same hint reproduces the same key. The passphrase scheme uses a per-vault
// random salt instead (see generateSalt).
const APP_SALT = new TextEncoder().encode("mugs-aesgcm-v1");

/** Payload prefix for passphrase-encrypted tokens (current scheme). */
export const PASSPHRASE_PREFIX = "aesgcm-pw:";
/** KDF algorithm identifier persisted in `security.kdf.algorithm`. */
export const DEFAULT_KDF_ALGORITHM = "PBKDF2-SHA-256";
/** PBKDF2 iteration count used for new passphrase keys (OWASP-recommended range). */
export const DEFAULT_KDF_ITERATIONS = 310_000;
/** Size of the random per-vault salt, in bytes. */
export const KDF_SALT_BYTES = 16;

function assertCrypto(): Crypto {
  const c = globalThis.crypto as Crypto | undefined;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is not available in this environment");
  }
  return c;
}

/**
 * Shared PBKDF2-SHA-256 → AES-256-GCM key derivation. `deriveKey` (legacy
 * hint scheme) and `derivePassphraseKey` (current scheme) differ only in
 * their salt and iteration parameters.
 */
async function pbkdf2AesKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const crypto = assertCrypto();
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`PBKDF2 iteration count must be a positive integer, got ${iterations}`);
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: AES_NAME, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/** LEGACY: derive a reusable AES-256-GCM key from the (stored) hint. Kept so
 *  old data still loads; new encryption must use the passphrase scheme. */
export async function deriveKey(hint: string): Promise<CryptoKey> {
  return pbkdf2AesKey(hint, APP_SALT, PBKDF2_ITERATIONS);
}

/** Derive the AES-256-GCM key for the passphrase scheme: passphrase (never
 *  persisted) + per-vault base64 salt + iteration count (both persisted). */
export async function derivePassphraseKey(
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<CryptoKey> {
  return pbkdf2AesKey(passphrase, fromBase64(saltB64), iterations);
}

/** Generate a fresh random per-vault salt as base64. */
export function generateSalt(): string {
  const crypto = assertCrypto();
  return toBase64(crypto.getRandomValues(new Uint8Array(KDF_SALT_BYTES)));
}

/** Encrypt a UTF-8 string under `prefix`; returns prefix + base64(iv || ciphertext). */
async function seal(prefix: string, plaintext: string, key: CryptoKey): Promise<string> {
  const crypto = assertCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: AES_NAME, iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return prefix + toBase64(combined);
}

/** Decrypt a prefix-tagged payload produced by {@link seal}. */
async function open(prefix: string, payload: string, key: CryptoKey): Promise<string> {
  const crypto = assertCrypto();
  if (!payload.startsWith(prefix)) {
    throw new Error(`open: not a ${prefix} payload`);
  }
  const combined = fromBase64(payload.slice(prefix.length));
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: AES_NAME, iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// --- LEGACY scheme (hint-derived key) ---------------------------------------

/** LEGACY: Encrypt a UTF-8 string; returns the `aesgcm:`-prefixed serialized payload. */
export async function encryptBytes(plaintext: string, key: CryptoKey): Promise<string> {
  return seal(LEGACY_PREFIX, plaintext, key);
}

/** LEGACY: Decrypt an `aesgcm:`-prefixed payload produced by {@link encryptBytes}. */
export async function decryptBytes(ciphertext: string, key: CryptoKey): Promise<string> {
  return open(LEGACY_PREFIX, ciphertext, key);
}

// --- CURRENT scheme (passphrase-derived key, per-vault salt) ------------------

/** Encrypt with a ready passphrase-derived key; `aesgcm-pw:`-prefixed payload. */
export async function encryptAesGcm(plaintext: string, key: CryptoKey): Promise<string> {
  return seal(PASSPHRASE_PREFIX, plaintext, key);
}

/** Decrypt an `aesgcm-pw:`-prefixed payload with a ready passphrase-derived key. */
export async function decryptAesGcm(payload: string, key: CryptoKey): Promise<string> {
  return open(PASSPHRASE_PREFIX, payload, key);
}

/** Convenience: derive the passphrase key, then encrypt. */
export async function encryptWithPassphrase(
  plaintext: string,
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  return encryptAesGcm(plaintext, await derivePassphraseKey(passphrase, saltB64, iterations));
}

/** Convenience: derive the passphrase key, then decrypt. */
export async function decryptWithPassphrase(
  payload: string,
  passphrase: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  return decryptAesGcm(payload, await derivePassphraseKey(passphrase, saltB64, iterations));
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
