import { describe, it, expect } from "vitest";
import {
  deriveKey,
  encryptBytes,
  decryptBytes,
  generateSalt,
  derivePassphraseKey,
  encryptAesGcm,
  decryptAesGcm,
  encryptWithPassphrase,
  decryptWithPassphrase,
  PASSPHRASE_PREFIX,
} from "./crypto";

describe("AES-GCM encryption at rest", () => {
  it("round-trips plaintext through encrypt/decrypt", async () => {
    const key = await deriveKey("my-hint");
    const cipher = await encryptBytes("glpat-SECRET1234", key);
    expect(cipher.startsWith("aesgcm:")).toBe(true);
    expect(await decryptBytes(cipher, key)).toBe("glpat-SECRET1234");
  });

  it("produces different ciphertext for identical plaintext (random IV)", async () => {
    const key = await deriveKey("my-hint");
    const a = await encryptBytes("same", key);
    const b = await encryptBytes("same", key);
    expect(a).not.toBe(b);
    // ...but both decrypt to the same value.
    expect(await decryptBytes(a, key)).toBe("same");
    expect(await decryptBytes(b, key)).toBe("same");
  });

  it("fails to decrypt with a different hint (wrong key)", async () => {
    const keyA = await deriveKey("hint-a");
    const keyB = await deriveKey("hint-b");
    const cipher = await encryptBytes("secret", keyA);
    await expect(decryptBytes(cipher, keyB)).rejects.toThrow();
  });

  it("handles empty and unicode plaintext", async () => {
    const key = await deriveKey("h");
    expect(await decryptBytes(await encryptBytes("", key), key)).toBe("");
    const poem = "café — naïve façade ✓\n第二言語";
    expect(await decryptBytes(await encryptBytes(poem, key), key)).toBe(poem);
  });

  it("rejects payloads without the aesgcm: prefix", async () => {
    const key = await deriveKey("h");
    await expect(decryptBytes("enc:nope", key)).rejects.toThrow();
  });
});

describe("passphrase KDF encryption (per-vault salt, never-persisted passphrase)", () => {
  it("round-trips plaintext via the passphrase scheme", async () => {
    const salt = generateSalt();
    const key = await derivePassphraseKey("correct horse", salt, 1000);
    const cipher = await encryptAesGcm("glpat-SECRET1234", key);
    expect(cipher.startsWith(PASSPHRASE_PREFIX)).toBe(true);
    expect(await decryptAesGcm(cipher, key)).toBe("glpat-SECRET1234");
  });

  it("round-trips through the convenience wrappers", async () => {
    const salt = generateSalt();
    const cipher = await encryptWithPassphrase("secret", "p", salt, 1000);
    expect(await decryptWithPassphrase(cipher, "p", salt, 1000)).toBe("secret");
  });

  it("fails to decrypt with a wrong passphrase (GCM auth)", async () => {
    const salt = generateSalt();
    const cipher = await encryptWithPassphrase("secret", "right", salt, 1000);
    await expect(decryptWithPassphrase(cipher, "wrong", salt, 1000)).rejects.toThrow();
  });

  it("derives a different key from a different salt (per-vault isolation)", async () => {
    const cipher = await encryptWithPassphrase("secret", "p", generateSalt(), 1000);
    await expect(decryptWithPassphrase(cipher, "p", generateSalt(), 1000)).rejects.toThrow();
  });

  it("generates a fresh random salt on every call", () => {
    const salts = new Set(Array.from({ length: 8 }, () => generateSalt()));
    expect(salts.size).toBe(8);
  });

  it("keeps the passphrase and legacy schemes mutually incompatible", async () => {
    const pwKey = await derivePassphraseKey("p", generateSalt(), 1000);
    const legacyKey = await deriveKey("p");
    const pw = await encryptAesGcm("secret", pwKey);
    const legacy = await encryptBytes("secret", legacyKey);
    await expect(decryptBytes(pw, legacyKey)).rejects.toThrow(); // legacy reader refuses pw payload
    await expect(decryptAesGcm(legacy, pwKey)).rejects.toThrow(); // pw reader refuses legacy payload
  });

  it("rejects iteration counts below 1", async () => {
    await expect(derivePassphraseKey("p", generateSalt(), 0)).rejects.toThrow();
  });
});
