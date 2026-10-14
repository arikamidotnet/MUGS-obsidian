import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSettings } from "./schema";

describe("vault data.json seed (test env)", () => {
  it("parses without throwing and wires the local credential + mapping", () => {
    const raw = JSON.parse(
      readFileSync("/home/arikami/Documents/FBR-WRK copy/.obsidian/data.json", "utf8"),
    );
    const s = parseSettings(raw["mugs-obsidian"]);

    expect(s.credentials).toHaveLength(1);
    expect(s.credentials[0].kind).toBe("local");
    expect(s.credentials[0].baseUrl).toContain("shared.git");

    expect(s.mappings).toHaveLength(1);
    expect(s.mappings[0].localFolder).toBe("Synced");
    expect(s.mappings[0].direction).toBe("push-pull");

    expect(s.staging["map-synced-notes"]).toEqual([
      { mappingId: "map-synced-notes", path: "Notes/diary.md", state: "unstaged" },
    ]);
  });
});
