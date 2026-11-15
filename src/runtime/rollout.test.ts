import { describe, expect, it } from "vitest";
import { parseSettings } from "../schema";
import { DEFAULT_SETTINGS, type MugsSettings } from "../types";
import { automaticMappings, recordCanary, recordRollout, rolloutFailure } from "./rollout";
import type { SyncOutcome } from "../sync/driver";

const fixture = (): MugsSettings => {
  const state = structuredClone(DEFAULT_SETTINGS);
  state.mappings = ["a", "b"].map(id => ({
    id, label: id, providerId: "c", localFolder: id, remotePath: id, direction: "push-only" as const,
  }));
  state.sync.rollout = { mode: "staged", enabledMappingIds: ["a"], blocked: {}, lastResult: {} };
  return state;
};

describe("staged rollout gate", () => {
  it("keeps legacy settings working; a new staged mode starts with no automatic mappings", () => {
    const old = parseSettings({ mappings: fixture().mappings });
    expect(old.sync.rollout).toBeUndefined();
    expect(automaticMappings(old).map(m => m.id)).toEqual(["a", "b"]);
    const state = fixture();
    state.sync.rollout!.enabledMappingIds = [];
    expect(automaticMappings(state)).toEqual([]);
  });

  it("filters automatic work and disables only a failed mapping with durable reason", () => {
    const state = fixture();
    expect(automaticMappings(state).map(m => m.id)).toEqual(["a"]);
    const failure: SyncOutcome = { mappingId: "a", label: "a", status: "blocked", reason: "clone locked" };
    state.sync.rollout = recordRollout(state.sync, [failure], state)!;
    expect(state.sync.rollout.blocked.a.reason).toBe("clone locked");
    expect(automaticMappings(state)).toEqual([]);
    const roundtrip = parseSettings(state);
    expect(roundtrip.sync.rollout?.blocked.a.reason).toBe("clone locked");
  });

  it("never calls review, pending work or partial results a successful canary", () => {
    const state = fixture();
    state.lastSync.a = { mappingId: "a", status: "ok", reconciliation: {
      version: 1, fingerprint: "f", proven: {}, review: { "unknown.md": { ref: "r", blob: "b" } }, decisions: {},
    } };
    const outcome: SyncOutcome = { mappingId: "a", label: "a", status: "ok" };
    expect(rolloutFailure(outcome, state)).toMatch(/review/);
    state.sync.rollout = recordRollout(state.sync, [outcome], state)!;
    expect(state.sync.rollout.lastResult.a.status).toBe("blocked");
  });

  it("a clean pass is recorded without enabling any other mapping", () => {
    const state = fixture();
    const outcome: SyncOutcome = { mappingId: "a", label: "a", status: "ok" };
    const result = recordRollout(state.sync, [outcome], state)!;
    expect(result.enabledMappingIds).toEqual(["a"]);
    expect(result.lastResult.a.status).toBe("ok");
    expect(automaticMappings({ ...state, sync: { ...state.sync, rollout: result } }).map(m => m.id)).toEqual(["a"]);
  });
});

describe("one-shot canary result", () => {
  it("a clean canary enables exactly that mapping, clears its prior block and persists", () => {
    const state = fixture();
    state.sync.rollout!.enabledMappingIds = [];
    state.sync.rollout!.blocked.b = { reason: "clone locked", at: 1 };
    const result = recordCanary(state.sync.rollout!, "b");
    expect(result.enabledMappingIds).toEqual(["b"]);
    expect(result.blocked.b).toBeUndefined();
    expect(result.lastResult.b.status).toBe("ok");
    expect(automaticMappings({ ...state, sync: { ...state.sync, rollout: result } }).map(m => m.id)).toEqual(["b"]);
    state.sync.rollout = result; // the caller persists the returned policy
    const roundtrip = parseSettings(state);
    expect(roundtrip.sync.rollout?.enabledMappingIds).toEqual(["b"]);
  });

  it("a failed canary never enables and records the reason without blocking retries", () => {
    const state = fixture();
    state.sync.rollout!.enabledMappingIds = ["a"];
    const result = recordCanary(state.sync.rollout!, "a", "2 changes deferred");
    expect(result.enabledMappingIds).toEqual([]);
    expect(result.blocked.a).toBeUndefined();
    expect(result.lastResult.a).toMatchObject({ status: "blocked", reason: "2 changes deferred" });
    expect(automaticMappings({ ...state, sync: { ...state.sync, rollout: result } })).toEqual([]);
  });

  it("a user-disabled mapping stays re-enablable: disable intent is not a block", () => {
    const state = fixture();
    state.sync.rollout!.enabledMappingIds = [];
    state.sync.rollout!.lastResult.a = { status: "blocked", at: 1, reason: "disabled by user" };
    // No blocked entry → preflight has no rollout blocker → a later canary may run.
    expect(state.sync.rollout!.blocked.a).toBeUndefined();
    const result = recordCanary(state.sync.rollout!, "a");
    expect(result.enabledMappingIds).toEqual(["a"]);
  });
});
