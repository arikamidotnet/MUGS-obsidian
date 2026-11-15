/** Opt-in live-state validation: proves the staged rollout gate fails closed
 *  against a REAL vault's saved settings. Skipped unless BOTH MUGS_FBR_CANARY=1
 *  and MUGS_FBR_DATA (the absolute path of the plugin data.json to inspect) are
 *  set — no operator path ships in the public source. Loads data.json through
 *  the real schema into MemoryIO — read-only, nothing is ever saved back, no
 *  credential is read, no clone or remote is touched. */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { MugsStore, MemoryIO } from "../store";
import { automaticMappings, recordCanary, rolloutFailure } from "../runtime/rollout";
import { mappingPreflight } from "../runtime/preflight";
import type { SyncOutcome } from "./driver";

const DATA = process.env.MUGS_FBR_DATA ?? "";

describe.skipIf(process.env.MUGS_FBR_CANARY !== "1" || !DATA)("real-vault staged rollout gate (read-only)", () => {
  it("loads the live settings through the real schema, starts staged mode at zero automatic mappings, and blocks every review-carrying mapping", async () => {
    const raw = JSON.parse(readFileSync(DATA, "utf8"));
    const store = new MugsStore(new MemoryIO(raw));
    const settings = await store.load();
    expect(store.loadError).toBeUndefined();

    // Live invariants this release must preserve: paused, untouched legacy
    // scheduling, no pending operations, and a nonempty review backlog to gate.
    expect(settings.sync.paused).toBe(true);
    expect(settings.sync.rollout).toBeUndefined(); // legacy mode, untouched
    expect(settings.mappings.length).toBeGreaterThan(0);
    const reviewByMapping = new Map(settings.mappings.map(m => [m.id,
      Object.keys(settings.lastSync[m.id]?.reconciliation?.review ?? {}).length]));
    expect([...reviewByMapping.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(settings.mappings.some(m => (settings.lastSync[m.id]?.pendingOps ?? []).length > 0)).toBe(false);

    // Entering staged mode (as Preflight does) starts with NOTHING automatic.
    const staged = { ...structuredClone(settings.sync), rollout: { mode: "staged" as const, enabledMappingIds: [] as string[], blocked: {} as Record<string, any>, lastResult: {} as Record<string, any> } };
    expect(automaticMappings({ ...settings, sync: staged })).toEqual([]);

    // Every mapping with a review backlog must fail canary preflight and stay
    // disabled — recorded review decisions are never auto-resolved by rollout.
    let withReview = 0;
    for (const mapping of settings.mappings) {
      const dir = settings.lastSync[mapping.id]?.cloneDir;
      let clonePresent = false;
      try { clonePresent = !!dir && statSync(dir).isDirectory() && existsSync(`${dir}/.git`); } catch { /* blocker */ }
      const evidence = mappingPreflight(settings, mapping.id, clonePresent);
      if ((reviewByMapping.get(mapping.id) ?? 0) > 0) {
        withReview++;
        expect(evidence.blockers.join("; ")).toMatch(/review/);
        const after = recordCanary(staged.rollout!, mapping.id, `canary not run — ${evidence.blockers.join("; ")}`);
        expect(after.enabledMappingIds).not.toContain(mapping.id);
      }
    }
    expect(withReview).toBeGreaterThan(0);

    // Even a hypothetical pass that reports "ok" is not a clean canary while
    // review entries remain in durable state — the gate reads state, not luck.
    const target = settings.mappings.find(m => (reviewByMapping.get(m.id) ?? 0) > 0)!;
    const okOutcome: SyncOutcome = { mappingId: target.id, label: target.label, status: "ok" };
    expect(rolloutFailure(okOutcome, settings)).toMatch(/review/);
  }, 30_000);
});
