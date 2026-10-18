import { describe, it, expect } from "vitest";
import { MugsStore, MemoryIO } from "./store";

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
