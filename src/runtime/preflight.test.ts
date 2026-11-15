import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../types";
import { mappingPreflight } from "./preflight";

const fixture = () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.mappings = [{ id: "one", label: "One", providerId: "account", localFolder: "notes", remotePath: "notes", direction: "push-pull" }];
  return settings;
};

describe("local preflight evidence", () => {
  it("does not approve a mapping without a clone and proven baseline", () => {
    expect(mappingPreflight(fixture(), "one", false).blockers).toHaveLength(2);
  });

  it("reports review, pending operations, conflict and blocked rollout separately", () => {
    const settings = fixture();
    settings.lastSync.one = {
      mappingId: "one", status: "ok", cloneDir: "/tmp/clone", baseSha: "sha",
      pendingOps: [{ opId: "op", path: "file.md", kind: "vault-write", state: "pending", createdAt: 1, attempts: 0 }],
      reconciliation: { version: 1, fingerprint: "f", proven: {}, decisions: {}, review: { "unknown.md": { ref: "r", blob: "b" } } },
    };
    settings.conflicts.one = [{ path: "file.md", ours: "a", theirs: "b" }];
    settings.sync.rollout = { mode: "staged", enabledMappingIds: [], blocked: { one: { reason: "previous failure", at: 1 } }, lastResult: {} };
    const result = mappingPreflight(settings, "one", true);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "1 repository files need review", "1 unresolved conflicts", "1 pending operations", "previous failure",
    ]));
  });
});
