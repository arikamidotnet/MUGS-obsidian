import { describe, it, expect } from "vitest";
import { deriveKey, encryptBytes, decryptBytes } from "./crypto";

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
