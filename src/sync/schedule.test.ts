import { describe, expect, it } from "vitest";
import {
  applyScheduleEvent,
  debounceFireTimes,
  decideRun,
  initialScheduleState,
  type ScheduleState,
} from "./schedule";

describe("decideRun — the automatic-sync pause gate", () => {
  it("allows the very first run (no lastRunAt) when running and visible", () => {
    expect(decideRun({ now: 0, intervalMs: 300_000, pausedByUser: false, hidden: false })).toEqual({
      allow: true,
      reason: "interval",
    });
  });

  it("allows a run once the interval has elapsed", () => {
    expect(decideRun({ now: 300_000, intervalMs: 300_000, lastRunAt: 0, pausedByUser: false, hidden: false })).toEqual({
      allow: true,
      reason: "interval",
    });
  });

  it("rejects a run before the interval elapses", () => {
    expect(decideRun({ now: 10_000, intervalMs: 300_000, lastRunAt: 0, pausedByUser: false, hidden: false })).toEqual({
      allow: false,
      reason: "too-soon",
    });
  });

  it("vetoed by a user pause regardless of interval", () => {
    expect(
      decideRun({ now: 999_999, intervalMs: 1000, lastRunAt: 0, pausedByUser: true, hidden: false }),
    ).toEqual({ allow: false, reason: "paused-user" });
  });

  it("vetoed while the window is hidden regardless of interval", () => {
    expect(
      decideRun({ now: 999_999, intervalMs: 1000, lastRunAt: 0, pausedByUser: false, hidden: true }),
    ).toEqual({ allow: false, reason: "hidden" });
  });

  it("a user pause beats a visible window", () => {
    expect(
      decideRun({ now: 999_999, intervalMs: 1000, lastRunAt: 0, pausedByUser: true, hidden: true }),
    ).toEqual({ allow: false, reason: "paused-user" });
  });
});

describe("applyScheduleEvent — visibility/pause reducer", () => {
  it("starts running and visible", () => {
    expect(initialScheduleState).toEqual({ pausedByUser: false, hidden: false });
  });

  it("pauses when the window hides and resumes when it becomes visible", () => {
    let s: ScheduleState = initialScheduleState;
    s = applyScheduleEvent(s, { type: "visibility", visible: false });
    expect(s).toEqual({ pausedByUser: false, hidden: true });
    s = applyScheduleEvent(s, { type: "visibility", visible: true });
    expect(s).toEqual({ pausedByUser: false, hidden: false });
  });

  it("the user toggle flips only the pause flag and leaves visibility intact", () => {
    let s: ScheduleState = { pausedByUser: false, hidden: true };
    s = applyScheduleEvent(s, { type: "userPause", value: true });
    expect(s).toEqual({ pausedByUser: true, hidden: true });
    s = applyScheduleEvent(s, { type: "userPause", value: false });
    expect(s).toEqual({ pausedByUser: false, hidden: true });
  });
});

describe("debounceFireTimes — coalesce a burst into one fire per window", () => {
  it("returns no fires for empty input", () => {
    expect(debounceFireTimes([], 5000)).toEqual([]);
  });

  it("coalesces a tight burst of events into a single fire", () => {
    // Five edits within 2s, window 30s → one fire at the last event.
    expect(debounceFireTimes([1000, 1500, 2000, 2500, 3000], 30_000)).toEqual([3000]);
  });

  it("fires once per burst separated by a gap >= window", () => {
    expect(debounceFireTimes([0, 1000, 40_000, 41_000], 30_000)).toEqual([1000, 41_000]);
  });

  it("is order-independent (sorts defensively)", () => {
    expect(debounceFireTimes([40_000, 1000, 0, 41_000], 30_000)).toEqual(debounceFireTimes([0, 1000, 40_000, 41_000], 30_000));
  });

  it("treats a gap exactly equal to the window as a new burst", () => {
    expect(debounceFireTimes([0, 30_000], 30_000)).toEqual([0, 30_000]);
  });
});
