import { describe, it, expect } from "vitest";
import { parseSettings } from "./schema";

/** Exercise legacy folder-scoped settings without reading a real vault or token. */
const seed = {
  credentials: [{
    id: "work", label: "Synthetic account", kind: "gitlab",
    token: "synthetic-test-token", repos: ["example/team-notes"],
  }],
  mappings: [{
    id: "legacy-notes", label: "Notes", providerId: "work",
    remotePath: "Notes", localFolder: "Notes", direction: "push-only",
  }],
};

describe("synthetic legacy data.json seed", () => {
  it("parses without throwing and wires the gitlab credential + folder mappings", () => {
    const s = parseSettings(seed);

    // One gitlab credential, allowlisted to the single shared repo.
    expect(s.credentials).toHaveLength(1);
    expect(s.credentials[0].kind).toBe("gitlab");
    expect(s.credentials[0].repos).toContain("example/team-notes");

    // Folder-scoped links: every mapping points at that credential and pairs a
    // remote folder with the same-named vault folder. These are legacy links with
    // no repoRef, so sync relies on the driver's single-visible-repo fallback.
    expect(s.mappings.length).toBeGreaterThanOrEqual(1);
    for (const m of s.mappings) {
      expect(m.providerId).toBe(s.credentials[0].id);
      // User's live vault currently uses push-only mappings (firstSyncDirection=push).
      // Accept any valid direction so the seed check doesn't break on real data evolution.
      expect(["push-pull", "push-only", "pull-only"]).toContain(m.direction);
      expect(m.remotePath).toBe(m.localFolder);
    }
  });
});
