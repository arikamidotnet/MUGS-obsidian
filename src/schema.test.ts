import { describe, it, expect } from "vitest";
import {
  parseSettings,
  redactToken,
  isBlockedFolder,
  normalizeVaultPath,
  mugsSettingsSchema,
} from "./schema";

describe("data-plane schema (contract)", () => {
  it("applies defaults for a partial/empty settings blob", () => {
    const s = parseSettings(null);
    expect(s.credentials).toEqual([]);
    expect(s.mappings).toEqual([]);
    expect(s.lastSync).toEqual({});
    expect(s.security.encryptCredentials).toBe(false);
    expect(s.version).toBe(1);
  });

  it("fills in default direction and status on nested objects", () => {
    const s = parseSettings({
      version: 2,
      credentials: [],
      mappings: [{ id: "m1", label: "Diary", remotePath: "d", localFolder: "notes", providerId: "c1" }],
      lastSync: {},
      security: { encryptCredentials: true },
    });
    expect(s.mappings[0].direction).toBe("push-pull");
  });

  it("rejects an unknown provider kind", () => {
    expect(() => parseSettings({ version: 1, credentials: [{ id: "x", label: "y", kind: "svn" }] })).toThrow();
  });

  it("rejects a mapping missing required fields", () => {
    expect(() => parseSettings({ version: 1, mappings: [{ id: "m1" }] })).toThrow();
  });

  it("accepts a valid full settings object", () => {
    expect(() =>
      parseSettings({
        version: 1,
        credentials: [{ id: "c1", label: "work", kind: "gitlab", token: "glpat-xxxx" }],
        mappings: [
          { id: "m1", label: "Diary", remotePath: "diary", localFolder: "Notes/diary", providerId: "c1", direction: "pull-only" },
        ],
        lastSync: { m1: { mappingId: "m1", status: "ok" } },
        security: { encryptCredentials: true },
      }),
    ).not.toThrow();
  });

  it("accepts and preserves an allowed-repos list on a credential", () => {
    const s = parseSettings({ version: 1, credentials: [{ id: "c1", label: "work", kind: "gitlab", token: "glpat-xxxx", repos: ["a/b", "group/c/d"] }] });
    expect(s.credentials[0].repos).toEqual(["a/b", "group/c/d"]);
  });

  it("rejects malformed repo paths (missing slash or containing whitespace)", () => {
    expect(() => parseSettings({ version: 1, credentials: [{ id: "c1", label: "w", kind: "gitlab", token: "t", repos: ["noslash"] }] })).toThrow();
    expect(() => parseSettings({ version: 1, credentials: [{ id: "c1", label: "w", kind: "gitlab", token: "t", repos: ["a b/c"] }] })).toThrow();
  });

  it("defaults a whole-vault mapping's syncTrashFolder to true (opt-out trash gate)", () => {
    const s = parseSettings({ version: 1, mappings: [{ id: "m1", label: "L", remotePath: "", localFolder: ".", providerId: "c1" }] });
    expect(s.mappings[0].syncTrashFolder).toBe(true);
  });

  it("preserves an explicit syncTrashFolder=false on a mapping", () => {
    const s = parseSettings({ version: 1, mappings: [{ id: "m1", label: "L", remotePath: "", localFolder: ".", providerId: "c1", syncTrashFolder: false }] });
    expect(s.mappings[0].syncTrashFolder).toBe(false);
  });

  it("preserves a scoped link's repoRef through parse (else links lose their shared clone)", () => {
    // Regression: repoRef was missing from the schema, so Zod stripped it on load and
    // scoped links silently degraded to the legacy id-based repo match on reload.
    const s = parseSettings({ version: 1, mappings: [{ id: "m1", label: "L", remotePath: "d", localFolder: "notes", providerId: "c1", repoRef: "42" }] });
    expect(s.mappings[0].repoRef).toBe("42");
  });

  it("accepts and preserves a security.kdf block (passphrase scheme)", () => {
    const s = parseSettings({
      version: 1,
      security: { encryptCredentials: true, kdf: { salt: "abc123", iterations: 310000 } },
    });
    expect(s.security.kdf).toEqual({ algorithm: "PBKDF2-SHA-256", salt: "abc123", iterations: 310000 });
  });

  it("treats kdf as optional (legacy vaults without it still parse)", () => {
    const s = parseSettings({ version: 1, security: { encryptCredentials: true, encryptionKeyHint: "hint" } });
    expect(s.security.kdf).toBeUndefined();
    expect(s.security.encryptionKeyHint).toBe("hint");
  });

  it("rejects a kdf block with a non-positive iteration count", () => {
    expect(() =>
      parseSettings({ version: 1, security: { encryptCredentials: true, kdf: { salt: "abc", iterations: 0 } } }),
    ).toThrow();
    expect(() =>
      parseSettings({ version: 1, security: { encryptCredentials: true, kdf: { salt: "abc", iterations: -5 } } }),
    ).toThrow();
  });

  it("rejects a kdf block without a salt", () => {
    expect(() =>
      parseSettings({ version: 1, security: { encryptCredentials: true, kdf: { iterations: 1000 } } }),
    ).toThrow();
  });
});

describe("credential redaction invariant", () => {
  const SECRET = "glpat-0123456789abcdef";

  it("never returns the raw token from redactToken", () => {
    expect(redactToken(SECRET)).not.toContain("0123");
    expect(redactToken(SECRET)).toContain("cdef"); // last 4 visible
  });

  it("masks short tokens entirely", () => {
    expect(redactToken("abc")).toBe("•••");
  });

  it("handles empty token", () => {
    expect(redactToken("")).toBe("");
  });
});

describe("blocked-folder validation", () => {
  it("blocks the .obsidian dir and any subpath", () => {
    expect(isBlockedFolder(".obsidian")).toBe(true);
    expect(isBlockedFolder(".obsidian/plugins")).toBe(true);
    expect(isBlockedFolder("a/.obsidian/x")).toBe(true);
  });

  it("allows ordinary vault folders", () => {
    expect(isBlockedFolder("Notes")).toBe(false);
    expect(isBlockedFolder("Notes/diary")).toBe(false);
    expect(isBlockedFolder("")).toBe(false);
  });

  it("normalizes backslashes and edge slashes", () => {
    expect(normalizeVaultPath("\\Notes\\diary\\")).toBe("Notes/diary");
  });
});
