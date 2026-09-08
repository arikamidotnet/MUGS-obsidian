import { describe, it, expect } from "vitest";
import { MugsStore, MemoryIO } from "./store";
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
    expect(onDisk.credentials[0].token).toMatch(/^enc:/);
    expect(onDisk.credentials[0].token).not.toContain("SECRETKEY");

    // Reload — the decrypted runtime token must equal the original secret.
    const store2 = new MugsStore(io);
    await store2.load();
    expect(store2.getToken("c1")).toBe("glpat-SECRETKEY");
  });
});
