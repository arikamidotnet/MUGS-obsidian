/**
 * MUGS — sync cadence helpers (pure).
 *
 * Maps between human-facing "cadence presets" (efficient / balanced /
 * near-realtime) and concrete poll intervals in seconds. Shared by the settings
 * UI (Phase E, which shows the presets) and the scheduler (Phase H, which honors
 * a concrete interval). No Obsidian/git imports — fully unit-tested.
 */

/** A named cadence preset shown in the settings UI. `seconds` is its poll interval. */
export interface CadencePreset {
  /** Stable machine id, e.g. "balanced". */
  id: string;
  /** Human label, e.g. "Balanced". */
  label: string;
  /** Poll interval in seconds. */
  seconds: number;
}

/** The built-in cadence presets, ordered from least to most frequent polling. */
export const INTERVAL_PRESETS: CadencePreset[] = [
  { id: "efficient", label: "Efficient (power-saving)", seconds: 3600 },
  { id: "balanced", label: "Balanced", seconds: 300 },
  { id: "near-realtime", label: "Near real-time", seconds: 30 },
];

/** Default preset id when the user has not chosen one. */
export const DEFAULT_PRESET_ID = "balanced";

const MIN_SECONDS = 1;
const MAX_SECONDS = 86_400; // cap at one day so a stray value can't wedge the poll loop.

/**
 * Normalize an input into a concrete, clamped positive interval in seconds.
 *
 * A string that exactly matches a preset id ("efficient"/"balanced"/
 * "near-realtime") maps to that preset's interval. Any other input is treated as
 * raw seconds and clamped into [MIN, MAX]. Missing/null falls back to the default
 * preset's interval.
 */
export function resolveIntervalSeconds(input: string | number | undefined | null): number {
  if (input === undefined || input === null) return DEFAULT_PRESET_SECONDS;

  // An exact preset-id string maps directly to its interval.
  const byId = INTERVAL_PRESETS.find((p) => p.id === input);
  if (byId) return byId.seconds;

  // Otherwise treat as raw seconds and clamp. A non-numeric string has no known
  // preset, so fall back to the default rather than guessing.
  const asNumber = typeof input === "number" ? input : Number.parseInt(input, 10);
  if (!Number.isFinite(asNumber)) return DEFAULT_PRESET_SECONDS;
  return clampSeconds(asNumber);
}

/** Clamp an arbitrary seconds value into the valid [MIN, MAX] integer range. */
export function clampSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_PRESET_SECONDS;
  const n = Math.floor(seconds);
  if (n < MIN_SECONDS) return MIN_SECONDS;
  if (n > MAX_SECONDS) return MAX_SECONDS;
  return n;
}

/** The concrete interval for the default preset. */
export const DEFAULT_PRESET_SECONDS = INTERVAL_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)?.seconds ?? 300;

/** Find the preset matching a concrete interval, or undefined when none matches. */
export function presetForSeconds(seconds: number): CadencePreset | undefined {
  return INTERVAL_PRESETS.find((p) => p.seconds === clampSeconds(seconds));
}

/** The preset id for a concrete interval (falls back to default when unmatched). */
export function presetIdForSeconds(seconds: number): string {
  return presetForSeconds(seconds)?.id ?? DEFAULT_PRESET_ID;
}
