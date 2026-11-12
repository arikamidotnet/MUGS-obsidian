import { describe, it, expect } from "vitest";
import { MugsStore, MemoryIO } from "./store";
import { deriveKey, encryptBytes } from "./crypto";

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

    // A locked session adds a credential, then saves: the new plaintext must
    // not reach disk, and the existing ciphertext must be untouched.
    const store2 = new MugsStore(io);
    await store2.load();
    store2.upsertCredential({ id: "c2", label: "personal", kind: "github", token: "ghp-BRANDNEW" });
    await store2.save();
    const onDisk = (await io.read()) as { credentials: Array<{ id: string; token: string }> };
    const c2 = onDisk.credentials.find((c) => c.id === "c2");
    expect(c2?.token).not.toContain("BRANDNEW");
    const c1 = onDisk.credentials.find((c) => c.id === "c1");
    expect(c1?.token).toMatch(/^aesgcm-pw:/);

    // The right passphrase still recovers c1 after that locked save.
    const store3 = new MugsStore(io);
    await store3.load();
    expect(await store3.unlock(PASS)).toBe(true);
    expect(store3.getToken("c1")).toBe(SECRET);
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
