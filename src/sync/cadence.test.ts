import { describe, it, expect } from "vitest";
import {
  INTERVAL_PRESETS,
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_SECONDS,
  resolveIntervalSeconds,
  clampSeconds,
  presetForSeconds,
  presetIdForSeconds,
} from "./cadence";

describe("INTERVAL_PRESETS", () => {
  it("exposes efficient / balanced / near-realtime presets in ascending frequency order", () => {
    expect(INTERVAL_PRESETS.map((p) => p.id)).toEqual(["efficient", "balanced", "near-realtime"]);
    // More frequent polling == smaller interval.
    for (let i = 1; i < INTERVAL_PRESETS.length; i++) {
      expect(INTERVAL_PRESETS[i].seconds).toBeLessThan(INTERVAL_PRESETS[i - 1].seconds);
    }
  });

  it("defaults to balanced", () => {
    expect(DEFAULT_PRESET_ID).toBe("balanced");
    expect(DEFAULT_PRESET_SECONDS).toBe(300);
  });
});

describe("resolveIntervalSeconds — preset id or raw seconds → clamped interval", () => {
  it("returns the default when input is missing/blank", () => {
    expect(resolveIntervalSeconds(undefined)).toBe(300);
    expect(resolveIntervalSeconds(null)).toBe(300);
    expect(resolveIntervalSeconds("")).toBe(300);
  });

  it("resolves a preset id string to its interval", () => {
    expect(resolveIntervalSeconds("efficient")).toBe(3600);
    expect(resolveIntervalSeconds("balanced")).toBe(300);
    expect(resolveIntervalSeconds("near-realtime")).toBe(30);
  });

  it("treats a numeric input as raw clamped seconds", () => {
    expect(resolveIntervalSeconds(0)).toBe(1);
    expect(resolveIntervalSeconds(-50)).toBe(1);
    expect(resolveIntervalSeconds(999_999)).toBe(86_400);
    expect(resolveIntervalSeconds(120)).toBe(120);
  });

  it("accepts a raw seconds value as a string", () => {
    expect(resolveIntervalSeconds("120")).toBe(120);
    expect(resolveIntervalSeconds("900")).toBe(900);
  });

  it("falls back to the default for an unknown preset id", () => {
    expect(resolveIntervalSeconds("does-not-exist")).toBe(300);
    expect(resolveIntervalSeconds("NaN-ish")).toBe(300);
  });

  it("clamps out-of-range raw seconds (string form) into [1, 86400]", () => {
    expect(resolveIntervalSeconds("0")).toBe(1);
    expect(resolveIntervalSeconds("-50")).toBe(1);
    expect(resolveIntervalSeconds("999999")).toBe(86400);
  });
});

describe("clampSeconds", () => {
  it("floors and clamps", () => {
    expect(clampSeconds(30.9)).toBe(30);
    expect(clampSeconds(0)).toBe(1);
    expect(clampSeconds(-1)).toBe(1);
    expect(clampSeconds(1e9)).toBe(86400);
    expect(clampSeconds(Number.NaN)).toBe(DEFAULT_PRESET_SECONDS);
  });
});

describe("preset lookups", () => {
  it("finds the preset for a matching interval and id", () => {
    expect(presetForSeconds(30)?.id).toBe("near-realtime");
    expect(presetIdForSeconds(3600)).toBe("efficient");
  });

  it("falls back to default when no preset matches an arbitrary interval", () => {
    expect(presetForSeconds(123)).toBeUndefined();
    expect(presetIdForSeconds(123)).toBe(DEFAULT_PRESET_ID);
  });
});
