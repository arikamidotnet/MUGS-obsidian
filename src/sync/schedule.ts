/**
 * MUGS — scheduling policy (pure).
 *
 * Decides WHEN an automatic sync is allowed to run, so main.ts stays thin glue.
 * Three independent, unit-tested concerns:
 *  - {@link decideRun}: the "pause gate" for every automatic path (poll/event/auto).
 *    Honors the global pause flag, window-hidden state, and a minimum interval
 *    between runs. Manual actions (ribbon/command) bypass this gate by design.
 *  - {@link applyScheduleEvent}: a visibility/pause state reducer — hiding the app
 *    pauses; becoming visible resumes; the user toggle flips the pause flag.
 *  - {@link debounceFireTimes}: coalesces a burst of file-change events into one
 *    sync fire per quiet window, so rapid edits don't spam the backend.
 *
 * No timers, no DOM, no Obsidian import — every branch is pinned by tests.
 */

/** Outcome of a run gate decision. */
export interface RunDecision {
  allow: boolean;
  /** Why the run was allowed or rejected (drives status-bar text). */
  reason: "interval" | "too-soon" | "paused-user" | "hidden";
}

/**
 * Decide whether an automatic sync may run at `now`.
 *
 * Order matters: a user pause and a hidden window both veto regardless of the
 * interval; otherwise the first run is always allowed and subsequent runs must be
 * at least `intervalMs` after the last one.
 */
export function decideRun(opts: {
  now: number;
  intervalMs: number;
  lastRunAt?: number;
  pausedByUser: boolean;
  hidden: boolean;
}): RunDecision {
  if (opts.pausedByUser) return { allow: false, reason: "paused-user" };
  if (opts.hidden) return { allow: false, reason: "hidden" };
  const { lastRunAt, now, intervalMs } = opts;
  if (lastRunAt === undefined) return { allow: true, reason: "interval" };
  if (now - lastRunAt < intervalMs) return { allow: false, reason: "too-soon" };
  return { allow: true, reason: "interval" };
}

/** Pause/visibility state the scheduler tracks between ticks. */
export interface ScheduleState {
  /** Set by the user's "Pause vault sync" toggle. */
  pausedByUser: boolean;
  /** True while the app/window is hidden (tab switch, minimized, etc.). */
  hidden: boolean;
}

/** Initial scheduler state: running and visible. */
export const initialScheduleState: ScheduleState = { pausedByUser: false, hidden: false };

/** A state transition fed by main.ts as it observes UI + visibility events. */
export type ScheduleEvent =
  | { type: "userPause"; value: boolean }
  | { type: "visibility"; visible: boolean };

/** Apply one pause/visibility event, returning the next scheduler state. */
export function applyScheduleEvent(state: ScheduleState, event: ScheduleEvent): ScheduleState {
  if (event.type === "userPause") return { ...state, pausedByUser: event.value };
  return { ...state, hidden: !event.visible };
}

/**
 * Coalesce a burst of event timestamps into the single fire time per quiet window.
 * Consecutive events closer than `windowMs` merge into one fire (at the last event
 * of the burst); a gap of at least `windowMs` starts a new burst. Sorted defensively
 * so call order does not matter. Empty input yields no fires.
 */
export function debounceFireTimes(events: number[], windowMs: number): number[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a - b);
  const fires: number[] = [];
  let last = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - last >= windowMs) {
      fires.push(last);
      last = sorted[i];
    } else {
      last = sorted[i];
    }
  }
  fires.push(last);
  return fires;
}
