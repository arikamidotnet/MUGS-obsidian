import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_SYNC_POLICY } from "./types";

/**
 * Sanity guard on the persisted settings shape. These defaults are written to
 * data.json on first run and merged into user settings; a drift here means new
 * keys silently vanish or old ones leak through unmerged. Kept tiny but explicit:
 * every top-level key must exist with its documented default.
 */
describe("DEFAULT_SETTINGS — shape & defaults", () => {
  it("has the current schema version and empty collections", () => {
    expect(DEFAULT_SETTINGS.version).toBe(1);
    expect(DEFAULT_SETTINGS.credentials).toEqual([]);
    expect(DEFAULT_SETTINGS.mappings).toEqual([]);
    expect(DEFAULT_SETTINGS.agents).toEqual([]);
    expect(DEFAULT_SETTINGS.lastSync).toEqual({});
    expect(DEFAULT_SETTINGS.conflicts).toEqual({});
    expect(DEFAULT_SETTINGS.staging).toEqual({});
  });

  it("defaults the sync policy to automatic-first, reversible behaviour", () => {
    const s = DEFAULT_SETTINGS.sync;
    expect(s.autoMerge).toBe(true);
    expect(s.defaultResolution).toBe("both");
    expect(s.sameChangeAccept).toBe(true);
    expect(s.recencyWins).toBe(true);
    expect(s.paused).toBe(false);
    expect(s.intervalSeconds).toBe(300);
  });

  it("defaults .obsidian/ config sync off with the documented entry bucket", () => {
    const obs = DEFAULT_SETTINGS.sync.obsidianConfig;
    expect(obs.enabled).toBe(false);
    // global.css is vault-wide (shared), settings.json is personal (local) — the
    // canonical split the UI relies on.
    const byPath = new Map(obs.entries.map((e) => [e.path, e.scope]));
    expect(byPath.get("settings.json")).toBe("personal");
    expect(byPath.get("global.css")).toBe("vault-wide");
    expect(byPath.get("plugins")).toBe("vault-wide");
  });

  it("defaults credential encryption off", () => {
    expect(DEFAULT_SETTINGS.security.encryptCredentials).toBe(false);
    expect(DEFAULT_SETTINGS.security.encryptionKeyHint).toBeUndefined();
  });

  it("DEFAULT_SYNC_POLICY is the exact object referenced by DEFAULT_SETTINGS.sync", () => {
    expect(DEFAULT_SETTINGS.sync).toBe(DEFAULT_SYNC_POLICY);
  });
});
