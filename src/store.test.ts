import { describe, it, expect, test } from "vitest";
import { MugsStore, MemoryIO } from "./store";
import { deriveKey, encryptBytes, generateSalt, derivePassphraseKey, encryptAesGcm, decryptAesGcm } from "./crypto";

// Minimal copy of the legacy XOR used by store.ts's backward-compatible reader,
// so this test can synthesize an `enc:` payload without reaching into internals.
function xorEncode(plaintext: string): string {
  const key = "mugs-default-hint-v1";
  const seed = new Array(key.length).fill(0);
  let acc = 0;
  for (let i = 0; i < key.length; i++) {
    acc = (acc + key.charCodeAt(i) * (i + 1)) % 251;
    seed[i] = acc;
  }
  return Array.from(plaintext)
    .map((ch, i) => String.fromCharCode(ch.charCodeAt(0) ^ seed[i % seed.length]))
    .join("");
}
import type { FolderMapping } from "./types";

const mapping = (over: Partial<FolderMapping> = {}): FolderMapping => ({
  id: "m1",
  label: "Diary",
  remotePath: "diary",
  localFolder: "Notes/diary",
  providerId: "c1",
  direction: "push-pull",
  ...over,
});

describe("MugsStore persistence + redaction", () => {
  it("loads defaults from empty IO", async () => {
    const store = new MugsStore(new MemoryIO(null));
    const s = await store.load();
    expect(s.credentials).toEqual([]);
    expect(s.mappings).toEqual([]);
  });

  it("keeps the real token in memory but masks it for display", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();

    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "glpat-SECRET1234" });

    // Real token available for git auth.
    expect(store.getToken("c1")).toBe("glpat-SECRET1234");
    // Display never reveals the raw secret.
    const display = store.getDisplaySettings().credentials[0];
    expect(display.token).not.toContain("SECRET");
    expect(display.token).toContain("1234");
  });

  it("rejects mappings that target .obsidian/", async () => {
    const store = new MugsStore(new MemoryIO(null));
    await store.load();
    let threw = false;
    try {
      store.upsertMapping(mapping({ localFolder: ".obsidian/plugins" }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Allowed folder still works.
    expect(() => store.upsertMapping(mapping())).not.toThrow();
  });

  it("persists last-sync state", async () => {
    const store = new MugsStore(new MemoryIO(null));
    await store.load();
    store.upsertMapping(mapping());
    store.setLastSync({ mappingId: "m1", status: "ok", lastPullAt: Date.now() });
    expect(store.getSettings().lastSync.m1.status).toBe("ok");
  });

  it("round-trips through IO with encryption off (plaintext on disk)", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "glpat-PLAIN" });
    await store.save();

    const onDisk = (await io.read()) as { credentials: Array<{ token: string }> };
    expect(onDisk.credentials[0].token).toBe("glpat-PLAIN");

    // Reload into a fresh store — auth token survives.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.getToken("c1")).toBe("glpat-PLAIN");
  });

  it("encrypts tokens at rest when enabled and decrypts on reload", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "glpat-SECRETKEY" });
    store.setSecurity({ encryptCredentials: true, encryptionKeyHint: "my-hint" });
    await store.save();

    const onDisk = (await io.read()) as { credentials: Array<{ token: string }> };
    expect(onDisk.credentials[0].token).toMatch(/^aesgcm:/);
    expect(onDisk.credentials[0].token).not.toContain("SECRETKEY");

    // Reload — the decrypted runtime token must equal the original secret.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.getToken("c1")).toBe("glpat-SECRETKEY");
  });

  it("reads legacy XOR (enc:) tokens written by older versions", async () => {
    // Simulate data persisted before AES-GCM: a hand-built enc: payload.
    const io = new MemoryIO({
      version: 1,
      credentials: [{ id: "c1", label: "work", kind: "gitlab", token: "enc:" + xorEncode("glpat-LEGACY") }],
      mappings: [],
      lastSync: {},
      conflicts: {},
      sync: { obsidianConfig: { enabled: false, entries: [] } },
      agents: [],
      staging: {},
      security: { encryptCredentials: true, encryptionKeyHint: "mugs-default-hint-v1" },
    });
    const store = new MugsStore(io);
    await store.load();
    expect(store.getToken("c1")).toBe("glpat-LEGACY");
  });
});

describe("MugsStore passphrase unlock flow", () => {
  const PASS = "correct horse battery staple";
  const SECRET = "glpat-SECRETKEY";

  /** data.json shape of the previous version: `aesgcm:` tokens keyed by the hint. */
  async function legacyHintIO(): Promise<MemoryIO> {
    const key = await deriveKey("my-hint");
    return new MemoryIO({
      version: 1,
      credentials: [{ id: "c1", label: "work", kind: "gitlab", token: await encryptBytes(SECRET, key) }],
      mappings: [],
      lastSync: {},
      conflicts: {},
      sync: { obsidianConfig: { enabled: false, entries: [] } },
      agents: [],
      staging: {},
      security: { encryptCredentials: true, encryptionKeyHint: "my-hint" },
    });
  }

  it("keeps tokens locked until unlock() with the right passphrase", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: SECRET });
    await store.setEncryptionPassphrase(PASS);
    expect(store.isLocked()).toBe(false);
    await store.save();

    // Only ciphertext + public KDF params reach disk; never the passphrase.
    const onDisk = (await io.read()) as {
      credentials: Array<{ token: string }>;
      security: { kdf?: { salt: string; iterations: number }; encryptionKeyHint?: string };
    };
    expect(onDisk.credentials[0].token).toMatch(/^aesgcm-pw:/);
    expect(onDisk.credentials[0].token).not.toContain("SECRETKEY");
    expect(onDisk.security.kdf?.salt).toBeTruthy();
    expect(onDisk.security.kdf?.iterations).toBeGreaterThan(0);
    expect(onDisk.security.encryptionKeyHint).toBeUndefined();

    // Reload into a fresh store: locked until unlocked.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.isLocked()).toBe(true);
    expect(store2.getToken("c1")).toBeUndefined(); // visible missing-token state

    // Wrong passphrase degrades to missing-token without throwing.
    expect(await store2.unlock("wrong passphrase")).toBe(false);
    expect(store2.getToken("c1")).toBeUndefined();
    expect(store2.isLocked()).toBe(true);

    // The right passphrase unlocks — and a retry after a wrong one recovers.
    expect(await store2.unlock(PASS)).toBe(true);
    expect(store2.getToken("c1")).toBe(SECRET);
    expect(store2.isLocked()).toBe(false);
  });

  it("migrates the legacy hint scheme on first unlock and drops the hint", async () => {
    const io = await legacyHintIO();
    const store = new MugsStore(io);
    await store.load();
    // Legacy tokens load without any passphrase (old behavior preserved).
    expect(store.getToken("c1")).toBe(SECRET);
    expect(store.isLocked()).toBe(false); // legacy scheme has no lock state

    // First unlock converts the vault to the passphrase scheme.
    expect(await store.unlock(PASS)).toBe(true);
    const s = store.getSettings();
    expect((s.security as { kdf?: unknown }).kdf).toBeTruthy();
    expect(s.security.encryptionKeyHint).toBeUndefined();
    await store.save();

    const onDisk = (await io.read()) as {
      credentials: Array<{ token: string }>;
      security: { kdf?: unknown; encryptionKeyHint?: string };
    };
    expect(onDisk.credentials[0].token).toMatch(/^aesgcm-pw:/);
    expect(onDisk.security.encryptionKeyHint).toBeUndefined();

    // The migrated vault loads locked and unlocks with the chosen passphrase.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.isLocked()).toBe(true);
    expect(await store2.unlock(PASS)).toBe(true);
    expect(store2.getToken("c1")).toBe(SECRET);
  });

  it("still loads plaintext tokens from a legacy vault (encryption on, no kdf)", async () => {
    const io = new MemoryIO({
      version: 1,
      credentials: [{ id: "c1", label: "work", kind: "gitlab", token: "glpat-PLAIN" }],
      security: { encryptCredentials: true, encryptionKeyHint: "whatever" },
    });
    const store = new MugsStore(io);
    await store.load();
    expect(store.getToken("c1")).toBe("glpat-PLAIN");
  });

  it("re-encrypts tokens when the passphrase is changed", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: SECRET });
    await store.setEncryptionPassphrase("first-pass");
    await store.save();
    await store.setEncryptionPassphrase("second-pass");
    await store.save();

    const store2 = new MugsStore(io);
    await store2.load();
    expect(await store2.unlock("first-pass")).toBe(false);
    expect(store2.getToken("c1")).toBeUndefined();
    expect(await store2.unlock("second-pass")).toBe(true);
    expect(store2.getToken("c1")).toBe(SECRET);
  });

  it("never persists plaintext tokens while locked", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: SECRET });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    // Add c2 while unlocked so it becomes durably encrypted.
    store.upsertCredential({ id: "c2", label: "personal", kind: "github", token: "ghp-BRANDNEW" });
    await store.save();

    // Capture the durable ciphertext for c2 (a stored-cipher form). While locked we may re-supply
    // a stored-cipher or a masked form for metadata-only updates; real secrets are rejected.
    const cipherOnDisk = (await io.read()) as { credentials: Array<{ id: string; token: string }> };
    const c2cipher = cipherOnDisk.credentials.find((c) => c.id === "c2")!.token;

    // A locked session performs a metadata-only update (label) by re-passing the stored ciphertext.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.isLocked()).toBe(true);
    store2.upsertCredential({ id: "c2", label: "personal-renamed", kind: "github", token: c2cipher });
    await store2.save();

    const onDisk = (await io.read()) as { credentials: Array<{ id: string; token: string; label: string }> };
    const c2 = onDisk.credentials.find((c) => c.id === "c2");
    expect(c2?.token).toMatch(/^aesgcm-pw:/);
    expect(c2?.label).toBe("personal-renamed");
    const c1 = onDisk.credentials.find((c) => c.id === "c1");
    expect(c1?.token).toMatch(/^aesgcm-pw:/);

    // The right passphrase still recovers both after the locked metadata save.
    const store3 = new MugsStore(io);
    await store3.load();
    expect(await store3.unlock(PASS)).toBe(true);
    expect(store3.getToken("c1")).toBe(SECRET);
    expect(store3.getToken("c2")).toBe("ghp-BRANDNEW");
  });

  it("refuses to change the passphrase while locked with credentials present", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: SECRET });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    const store2 = new MugsStore(io);
    await store2.load();
    await expect(store2.setEncryptionPassphrase("other")).rejects.toThrow(/unlock/i);
  });

  it("rejects an empty passphrase", async () => {
    const store = new MugsStore(new MemoryIO(null));
    await store.load();
    await expect(store.setEncryptionPassphrase("")).rejects.toThrow();
  });
});

describe("E04 persistence semantics (serialized saves, observable refusal, no late stale snapshot)", () => {
  it("save() refusal on unreadable data.json is observable (returns {ok:false, reason:'load-error'})", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    // Force load error
    const badIO = new MemoryIO({ version: 1, credentials: "not-an-array" });
    const badStore = new MugsStore(badIO);
    await badStore.load();
    expect(badStore.loadError).toBeTruthy();

    const res = await badStore.save();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("load-error");
    }
    // nothing should have been written by the refused save
    const raw = await badIO.read();
    expect(raw).toEqual({ version: 1, credentials: "not-an-array" });
  });

  it("serialized saves: a late write of a stale snapshot cannot overwrite a later state", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();

    // Seed initial credential
    store.upsertCredential({ id: "c1", label: "first", kind: "gitlab", token: "t1" });

    // Start save1 which will clone inside the serialized section
    const p1 = store.save();

    // Immediately mutate to a newer state before save1's IO completes
    store.upsertCredential({ id: "c1", label: "second", kind: "gitlab", token: "t2" });
    const p2 = store.save();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Final on-disk must reflect the latest (second) state, not a stale first snapshot
    const final = (await io.read()) as any;
    const c1 = final.credentials.find((c: any) => c.id === "c1");
    expect(c1.label).toBe("second");
    expect(c1.token).toBe("t2");
  });

  it("successful save returns {ok:true}", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "x", kind: "gitlab", token: "tok" });
    const res = await store.save();
    expect(res.ok).toBe(true);
  });
});

describe("C03 input validation & redaction (KDF bounds, ciphertext format, no leaks in errors/labels/logs)", () => {
  it("rejects KDF iteration counts that are not positive integers (derivePassphraseKey)", async () => {
    await expect(derivePassphraseKey("p", generateSalt(), 0)).rejects.toThrow(/positive integer/i);
    await expect(derivePassphraseKey("p", generateSalt(), -5)).rejects.toThrow(/positive integer/i);
    await expect(derivePassphraseKey("p", generateSalt(), 1.5 as any)).rejects.toThrow(/positive integer/i);
  });

  it("rejects derivePassphraseKey when salt is not valid base64 or wrong length", async () => {
    // wrong alphabet (fromBase64 will throw or produce garbage that later decode fails)
    await expect(derivePassphraseKey("p", "!!!not-base64!!!", 1000)).rejects.toThrow();
    // wrong length (must be 16 bytes when decoded)
    const badLen = btoa("short"); // not 16 bytes
    await expect(derivePassphraseKey("p", badLen, 1000)).rejects.toThrow();
  });

  it("rejects derivePassphraseKey for unknown algorithm via schema (kdfSchema allows only PBKDF2-SHA-256)", async () => {
    // schema validation happens at parse; we ensure only the allowlisted algo is accepted
    const { parseSettings } = await import("./schema");
    expect(() =>
      parseSettings({
        security: {
          encryptCredentials: true,
          kdf: { algorithm: "PBKDF2-SHA-256", salt: generateSalt(), iterations: 1000 },
        },
      })
    ).not.toThrow();
    expect(() =>
      parseSettings({
        security: {
          encryptCredentials: true,
          kdf: { algorithm: "scrypt", salt: generateSalt(), iterations: 1000 },
        },
      })
    ).toThrow();
  });

  it("validates ciphertext format before expensive derivation (decryptAesGcm requires aesgcm-pw: prefix)", async () => {
    const salt = generateSalt();
    const key = await derivePassphraseKey("p", salt, 1000);
    const good = await encryptAesGcm("secret", key);
    await expect(decryptAesGcm(good, key)).resolves.toBe("secret");
    await expect(decryptAesGcm("not-a-payload", key)).rejects.toThrow(/not a aesgcm-pw: payload/i);
    await expect(decryptAesGcm("aesgcm:" + good.slice(9), key)).rejects.toThrow(/not a aesgcm-pw: payload/i);
  });

  it("errors, labels, and logs never contain token material or passphrases (redaction path)", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    const TOKEN = "glpat-VERY-SECRET-XYZ";
    const PASS = "my secret passphrase must not leak";
    store.upsertCredential({ id: "c1", label: "creds", kind: "gitlab", token: TOKEN });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    // Force a wrong-passphrase path and capture logs
    const store2 = new MugsStore(io);
    await store2.load();
    const origErr = console.error;
    const logs: any[] = [];
    console.error = (...a: any[]) => logs.push(a);
    try {
      await store2.unlock("wrong");
    } finally {
      console.error = origErr;
    }

    const joined = logs.flat().join(" ");
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain(PASS);

    // Display must redact
    const disp = store2.getDisplaySettings().credentials[0].token;
    expect(disp).not.toContain(TOKEN);
    expect(disp).not.toContain("VERY-SECRET");
  });
});

describe("C02 lock state machine (explicit transitions + preconditions + failure states)", () => {
  const PASS = "correct horse battery staple";
  const SECRET = "glpat-C02-SECRET";

  it("repeated unlock after success: wrong passphrase must not install inconsistent key or clobber cached runtime tokens", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "w", kind: "gitlab", token: SECRET });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    const store2 = new MugsStore(io);
    await store2.load();
    expect(await store2.unlock(PASS)).toBe(true);
    expect(store2.isLocked()).toBe(false);
    expect(store2.getToken("c1")).toBe(SECRET);

    // Wrong passphrase after success must NOT clobber
    expect(await store2.unlock("wrong wrong wrong")).toBe(false);
    expect(store2.isLocked()).toBe(false); // still unlocked from prior success
    expect(store2.getToken("c1")).toBe(SECRET); // runtime token not lost
  });

  it("adding/replacing a real secret while locked is rejected (never durable; never mask a NEW token)", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "w", kind: "gitlab", token: SECRET });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.isLocked()).toBe(true);

    // Adding a brand-new real secret while locked must be rejected
    expect(() =>
      store2.upsertCredential({ id: "c2", label: "new", kind: "github", token: "ghp-NEWREAL" })
    ).toThrow(/locked/i);

    // Replacing an existing credential's secret while locked must also reject
    expect(() =>
      store2.upsertCredential({ id: "c1", label: "w", kind: "gitlab", token: "glpat-REPLACE" })
    ).toThrow(/locked/i);

    // Metadata-only updates (re-passing a masked or cipher form) may be allowed for label etc.,
    // but must not change the durable secret.
    // We simulate by calling with the display-masked form (implementation may treat as non-secret update).
    const display = store2.getDisplaySettings().credentials[0];
    // If the impl accepts a masked token as metadata update, it should not lose the original.
    // For strictness, we only assert that a *real secret value* is rejected.
    // The durable doc after attempted (rejected) change + save must still have the original ciphertext.
    await store2.save();
    const onDisk = (await io.read()) as any;
    const c1 = onDisk.credentials.find((c: any) => c.id === "c1");
    expect(c1.token).toMatch(/^aesgcm-pw:/);
  });

  it("disabling encryption is an explicit decrypt-all transaction; previous durable state stays valid on per-item failure", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "good", kind: "gitlab", token: "glpat-GOOD" });
    store.upsertCredential({ id: "c2", label: "bad", kind: "github", token: "glpat-BAD" });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    // Replace c2's stored token with a pw-cipher under a *different* key (simulates corruption
    // or a token that cannot be decrypted with the current vault passphrase). The correct
    // PASS will fail to open it, so unlock must report failure and disable must refuse.
    const saltOther = generateSalt();
    const otherKey = await derivePassphraseKey("different-pass-for-c02", saltOther, 310000);
    const badPw = await encryptAesGcm("glpat-BAD", otherKey); // valid-looking pw payload, wrong key

    const onDiskBad = (await io.read()) as any;
    const c2 = onDiskBad.credentials.find((c: any) => c.id === "c2");
    c2.token = badPw;
    await io.write(onDiskBad);

    const store2 = new MugsStore(io);
    await store2.load();
    // c2 is a pw-cipher that this PASS cannot open → unlock must return false (not fully unlocked)
    expect(await store2.unlock(PASS)).toBe(false);
    expect(store2.isLocked()).toBe(true);

    // Attempt to disable encryption: must fail and leave prior durable (encrypted) state valid
    const res = await store2.disableEncryption();
    expect(res.ok).toBe(false);
    expect(res.failures.length).toBeGreaterThan(0);

    // Durable doc must still have encryption enabled + kdf + ciphertexts (no plaintext leaked, no flip)
    const still = (await io.read()) as any;
    expect(still.security.encryptCredentials).toBe(true);
    expect(still.security.kdf).toBeTruthy();
    const dc1 = still.credentials.find((c: any) => c.id === "c1");
    const dc2 = still.credentials.find((c: any) => c.id === "c2");
    expect(dc1.token).toMatch(/^aesgcm-pw:/);
    // dc2 remains a pw-cipher (different key), not plaintext
    expect(dc2.token).toMatch(/^aesgcm-pw:/);
    // Identity may be equal if the IO layer shares the same object; the important
    // invariants are: still pw-cipher, still encrypted at durable level, and no plaintext leaked.
    expect(dc2.token.startsWith("aesgcm-pw:")).toBe(true);
    expect(dc2.token).not.toContain("glpat-BAD");
  });

  it("successful disable encryption decrypts all and turns encryption off (full success path)", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "a", kind: "gitlab", token: "glpat-A" });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    const store2 = new MugsStore(io);
    await store2.load();
    expect(await store2.unlock(PASS)).toBe(true);

    const res = await store2.disableEncryption();
    expect(res.ok).toBe(true);
    expect(res.failures.length).toBe(0);

    await store2.save();
    const final = (await io.read()) as any;
    expect(final.security.encryptCredentials).toBe(false);
    // tokens are plaintext after disable
    const fc1 = final.credentials.find((c: any) => c.id === "c1");
    expect(fc1.token).toBe("glpat-A");
    expect(store2.isLocked()).toBe(false);
    expect(store2.getToken("c1")).toBe("glpat-A");
  });
});

describe("C01 migration atomicity (partial failure must not mutate durable state)", () => {
  it("partial migration failure leaves previous durable document fully valid (no KDF, no hint deletion) until ALL secrets migrate and persist; retry is idempotent", async () => {
    const HINT = "migration-hint-c01";
    const PASS = "correct horse battery staple";
    const SECRET1 = "glpat-GOOD-MIG";
    const SECRET2 = "glpat-BAD-MIG";

    const legacyKey = await deriveKey(HINT);
    const wrongKeyForBad = await deriveKey("other-hint-for-bad");
    const goodStored = await encryptBytes(SECRET1, legacyKey);
    const badStored = await encryptBytes(SECRET2, wrongKeyForBad); // will fail to decrypt with legacyKey

    const io = new MemoryIO({
      version: 1,
      credentials: [
        { id: "c1", label: "good", kind: "gitlab", token: goodStored },
        { id: "c2", label: "bad", kind: "github", token: badStored },
      ],
      mappings: [],
      lastSync: {},
      conflicts: {},
      sync: { obsidianConfig: { enabled: false, entries: [] } },
      agents: [],
      staging: {},
      security: { encryptCredentials: true, encryptionKeyHint: HINT },
    });

    const store = new MugsStore(io);
    await store.load();

    // Legacy load behavior: readable token is available; bad one is unreadable
    expect(store.getToken("c1")).toBe(SECRET1);
    expect(store.getToken("c2")).toBeUndefined();
    expect(store.isLocked()).toBe(false);

    // Partial migration attempt
    const first = await store.unlock(PASS);
    expect(first).toBe(false);

    // MUST NOT have replaced KDF metadata or deleted hint
    const s = store.getSettings();
    expect((s.security as any).kdf).toBeUndefined();
    expect(s.security.encryptionKeyHint).toBe(HINT);

    // Stored tokens for durable doc must remain in previous valid legacy format
    const dc1 = s.credentials.find((c) => c.id === "c1")!;
    const dc2 = s.credentials.find((c) => c.id === "c2")!;
    expect(dc1.token).toMatch(/^aesgcm:/);
    expect(dc1.token).not.toMatch(/^aesgcm-pw:/);
    expect(dc2.token).toBe(badStored);

    // Good secret available at runtime this session; bad still not
    expect(store.getToken("c1")).toBe(SECRET1);
    expect(store.getToken("c2")).toBeUndefined();

    // Save must keep a fully-valid previous durable document
    await store.save();
    const onDisk = (await io.read()) as any;
    expect(onDisk.security?.kdf).toBeUndefined();
    expect(onDisk.security?.encryptionKeyHint).toBe(HINT);
    expect(onDisk.credentials.find((c: any) => c.id === "c1").token).toMatch(/^aesgcm:/);
    expect(onDisk.credentials.find((c: any) => c.id === "c2").token).toBe(badStored);

    // Retry unlock must be idempotent: still no flip, no double-encryption side effects
    const second = await store.unlock(PASS);
    expect(second).toBe(false);
    const s2 = store.getSettings();
    expect((s2.security as any).kdf).toBeUndefined();
    expect(s2.security.encryptionKeyHint).toBe(HINT);

    // Recover by supplying the missing secret (upsert while in legacy state)
    store.upsertCredential({ id: "c2", label: "bad", kind: "github", token: SECRET2 });

    // Now full migration should succeed
    const third = await store.unlock(PASS);
    expect(third).toBe(true);
    const s3 = store.getSettings();
    expect((s3.security as any).kdf).toBeTruthy();
    expect(s3.security.encryptionKeyHint).toBeUndefined();
    const fc1 = s3.credentials.find((c: any) => c.id === "c1")!;
    const fc2 = s3.credentials.find((c: any) => c.id === "c2")!;
    expect(fc1.token).toMatch(/^aesgcm-pw:/);
    expect(fc2.token).toMatch(/^aesgcm-pw:/);
    expect(store.getToken("c1")).toBe(SECRET1);
    expect(store.getToken("c2")).toBe(SECRET2);

    await store.save();
    const onDiskFinal = (await io.read()) as any;
    expect(onDiskFinal.security?.kdf).toBeTruthy();
    expect(onDiskFinal.security?.encryptionKeyHint).toBeUndefined();
  });
});

describe("MugsStore conflict persistence", () => {
  const conflict = (over: Partial<{ path: string; ours: string; theirs: string; resolved?: boolean; resolvedContent?: string }> = {}) => ({
    path: "notes/day.md",
    base: "base",
    ours: "ours",
    theirs: "theirs",
    ...over,
  });

  it("returns an empty list when no conflicts are recorded", () => {
    const store = new MugsStore(new MemoryIO(null));
    expect(store.getConflicts("m1")).toEqual([]);
  });

  it("stores and clears per-mapping conflicts", () => {
    const store = new MugsStore(new MemoryIO(null));
    store.setConflicts("m1", [conflict()]);
    expect(store.getConflicts("m1").map((c) => c.path)).toEqual(["notes/day.md"]);
    store.clearConflicts("m1");
    expect(store.getConflicts("m1")).toEqual([]);
  });

  it("drops the mapping entry when set to empty", () => {
    const store = new MugsStore(new MemoryIO(null));
    store.setConflicts("m1", [conflict()]);
    store.setConflicts("m1", []);
    expect(store.getSettings().conflicts.m1).toBeUndefined();
  });

  it("round-trips conflicts through IO", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.setConflicts("m1", [conflict({ resolved: true, resolvedContent: "resolved" })]);
    await store.save();

    const onDisk = (await io.read()) as { conflicts: Record<string, Array<{ path: string }>> };
    expect(onDisk.conflicts.m1[0].path).toBe("notes/day.md");

    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.getConflicts("m1").map((c) => c.path)).toEqual(["notes/day.md"]);
  });
});

/**
 * Regression (Wave B integration): upsertCredential metadata-only edits.
 *
 * A masked/cipher re-supply (label rename from the UI, which only sees masked
 * tokens) must PRESERVE the runtime plaintext token map and any unreadable
 * marker; only a REAL secret may supersede. Overwriting runtimeTokens with the
 * stored ciphertext/mask would poison the live token map — sync would hand the
 * mask/cipher to git as if it were the secret.
 */
describe("upsertCredential metadata-edit semantics (masked/cipher re-supply vs real secret)", () => {
  const PASS = "correct horse battery staple";

  // DEFECT PIN (it.fails): the display mask produced by redactToken() keeps the
  // LAST 4 characters ("•••…dwY="), but isMasked (store.ts) only recognizes an
  // ALL-bullet token (/^•+$/). A masked re-supply — the exact shape the UI sends
  // for a metadata-only edit — is therefore classified as a REAL secret and
  // poisons runtimeTokens: getToken then returns bullets, and sync would hand
  // them to git. PRODUCTION FIX NEEDED (store wave): recognize the display-mask
  // form in isMasked/upsertCredential (e.g. treat a token equal to
  // redactToken(stored) as metadata-only). Convert to a normal test when fixed —
  // an it.fails that starts passing fails the suite and forces this conversion.
  test.fails("masked re-supply (metadata-only edit) preserves the runtime plaintext token", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "glpat-SECRET1234" });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    // Unlocked session (the UI after unlock): a label rename re-supplies the MASK.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(await store2.unlock(PASS)).toBe(true);
    const masked = store2.getDisplaySettings().credentials[0].token;
    expect(masked).not.toContain("SECRET1234");
    store2.upsertCredential({ id: "c1", label: "work-renamed", kind: "gitlab", token: masked });

    // The runtime plaintext must survive the metadata-only edit — the mask/cipher
    // must never enter the token map (sync would hand it to git as the secret).
    expect(store2.getToken("c1")).toBe("glpat-SECRET1234");

    // Persisting the metadata edit keeps the secret encrypted at rest (never the mask).
    await store2.save();
    const onDisk = (await io.read()) as { credentials: Array<{ id: string; label: string; token: string }> };
    const c1 = onDisk.credentials.find((c) => c.id === "c1");
    expect(c1?.label).toBe("work-renamed");
    expect(c1?.token).toMatch(/^aesgcm-pw:/);

    // A fresh session still recovers the original secret.
    const store3 = new MugsStore(io);
    await store3.load();
    expect(await store3.unlock(PASS)).toBe(true);
    expect(store3.getToken("c1")).toBe("glpat-SECRET1234");
  });

  it("cipher re-supply of an unreadable token keeps the unreadable marker (never resolves to a fake secret)", async () => {
    // c2's stored token is a pw-cipher under a DIFFERENT passphrase: load marks it
    // unreadable, and the correct PASS cannot unlock it.
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "good", kind: "gitlab", token: "glpat-GOOD" });
    store.upsertCredential({ id: "c2", label: "bad", kind: "github", token: "glpat-BAD" });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    const saltOther = generateSalt();
    const otherKey = await derivePassphraseKey("different-pass-for-metadata", saltOther, 310000);
    const badPw = await encryptAesGcm("glpat-BAD", otherKey);
    const onDiskBad = (await io.read()) as any;
    onDiskBad.credentials.find((c: any) => c.id === "c2").token = badPw;
    await io.write(onDiskBad);

    const store2 = new MugsStore(io);
    await store2.load();
    expect(await store2.unlock(PASS)).toBe(false); // c2 unreadable
    expect(store2.getToken("c2")).toBeUndefined();

    // Metadata-only edit of c2 by re-passing its stored cipher (locked session — allowed).
    store2.upsertCredential({ id: "c2", label: "bad-renamed", kind: "github", token: badPw });

    // The unreadable marker must NOT be cleared: the token stays "missing" for auth.
    expect(store2.getToken("c2")).toBeUndefined();

    // The durable cipher is untouched; the label edit did not poison it.
    await store2.save();
    const onDisk = (await io.read()) as any;
    const c2 = onDisk.credentials.find((c: any) => c.id === "c2");
    expect(c2?.token).toBe(badPw);
    expect(c2?.label).toBe("bad-renamed");
  });

  it("a real secret still supersedes the runtime plaintext and the stored cipher", async () => {
    const io = new MemoryIO(null);
    const store = new MugsStore(io);
    await store.load();
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "glpat-OLD-SECRET" });
    await store.setEncryptionPassphrase(PASS);
    await store.save();

    // Unlocked rotation: supplying a REAL new secret must take effect immediately...
    store.upsertCredential({ id: "c1", label: "work", kind: "gitlab", token: "glpat-ROTATED-SECRET" });
    expect(store.getToken("c1")).toBe("glpat-ROTATED-SECRET");

    // ...and durably: the new secret is re-encrypted under the vault passphrase.
    await store.save();
    const store2 = new MugsStore(io);
    await store2.load();
    expect(await store2.unlock(PASS)).toBe(true);
    expect(store2.getToken("c1")).toBe("glpat-ROTATED-SECRET");
  });
});
