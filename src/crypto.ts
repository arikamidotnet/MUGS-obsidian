/**
 * MUGS — encryption at rest for stored tokens.
 *
 * Real cryptography (not the XOR placeholder): AES-256-GCM with a key derived
 * from the user-provided hint via PBKDF2-SHA-256. Each ciphertext carries a
 * random 96-bit IV so identical plaintexts encrypt differently, and is
 * serialized as `aesgcm:` + base64(iv || ciphertext).
 *
 * Uses WebCrypto (`crypto.subtle`), available in Obsidian's Electron runtime and
 * Node >= 18. Base64 uses Buffer when present (Node) and falls back to the
 * browser globals otherwise.
 */

const PBKDF2_ITERATIONS = 250_000;
const AES_NAME = "AES-GCM";
const KEY_LENGTH = 256;
const IV_BYTES = 12;
// Fixed application salt. Per-message IV provides uniqueness; the key is derived
// solely from the hint so a reload with the same hint reproduces the same key.
const APP_SALT = new TextEncoder().encode("mugs-aesgcm-v1");

function assertCrypto(): Crypto {
  const c = globalThis.crypto as Crypto | undefined;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto (crypto.subtle) is not available in this environment");
  }
  return c;
}

/** Derive a reusable AES-256-GCM key from the hint. Cache-friendly: derive once per save/load. */
export async function deriveKey(hint: string): Promise<CryptoKey> {
  const crypto = assertCrypto();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hint),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: APP_SALT, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: AES_NAME, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a UTF-8 string; returns the `aesgcm:`-prefixed serialized payload. */
export async function encryptBytes(plaintext: string, key: CryptoKey): Promise<string> {
  const crypto = assertCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: AES_NAME, iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.length);
  return "aesgcm:" + toBase64(combined);
}

/** Decrypt an `aesgcm:`-prefixed payload produced by {@link encryptBytes}. */
export async function decryptBytes(ciphertext: string, key: CryptoKey): Promise<string> {
  const crypto = assertCrypto();
  if (!ciphertext.startsWith("aesgcm:")) {
    throw new Error("decryptBytes: not an aesgcm payload");
  }
  const combined = fromBase64(ciphertext.slice("aesgcm:".length));
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: AES_NAME, iv }, key, ct);
  return new TextDecoder().decode(pt);
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
