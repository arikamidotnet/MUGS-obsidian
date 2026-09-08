/**
 * MUGS — Multi-User Git Sync
 * Benchmark scaffold. Measures per-sync-path overhead (settings parse, credential
 * redaction, mapping validation) so we can watch for regressions as the sync
 * engine grows. These run without git/network, keeping them CI-friendly.
 *
 * Run with: npm run bench   (i.e. `vitest run bench/`)
 */
import { bench, describe } from "vitest";
import { parseSettings, redactToken, isBlockedFolder } from "../src/schema";

const VALID_SETTINGS = {
  version: 1,
  credentials: Array.from({ length: 5 }, (_, i) => ({
    id: `c${i}`,
    label: `account ${i}`,
    kind: "gitlab",
    token: `glpat-${"x".repeat(20)}${i}`,
  })),
  mappings: Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    label: `Mapping ${i}`,
    remotePath: `notes/path/${i}`,
    localFolder: `Notes/path/${i}`,
    providerId: `c${i % 5}`,
    direction: "push-pull" as const,
  })),
  lastSync: {},
  security: { encryptCredentials: false },
};

describe("sync-path performance", () => {
  bench("parse full settings (10 creds, 10 mappings)", () => {
    parseSettings(VALID_SETTINGS);
  });

  bench("redact all credentials", () => {
    for (const c of VALID_SETTINGS.credentials) redactToken(c.token);
  });

  bench("validate all mapping folders", () => {
    for (const m of VALID_SETTINGS.mappings) isBlockedFolder(m.localFolder);
  });
});
