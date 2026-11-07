import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseSettings } from "./schema";

/** The live vault where MUGS is installed; scratch validation of the real seed.
 *  Skips (rather than fails) on machines without this vault. */
const VAULT_DATA = "/home/arikami/Documents/FBR-WRK/.obsidian/plugins/mugs-obsidian/data.json";

describe.skipIf(!existsSync(VAULT_DATA))("vault data.json seed (test env)", () => {
  it("parses without throwing and wires the gitlab credential + folder mappings", () => {
    const s = parseSettings(JSON.parse(readFileSync(VAULT_DATA, "utf8")));

    // One gitlab credential, allowlisted to the single shared repo.
    expect(s.credentials).toHaveLength(1);
    expect(s.credentials[0].kind).toBe("gitlab");
    expect(s.credentials[0].repos).toContain("fbr-rom/FBR-WRK");

    // Folder-scoped links: every mapping points at that credential and pairs a
    // remote folder with the same-named vault folder. These are legacy links with
    // no repoRef, so sync relies on the driver's single-visible-repo fallback.
    expect(s.mappings.length).toBeGreaterThanOrEqual(1);
    for (const m of s.mappings) {
      expect(m.providerId).toBe(s.credentials[0].id);
      expect(m.direction).toBe("push-pull");
      expect(m.remotePath).toBe(m.localFolder);
    }
  });
});
