import type { SyncDirection } from "../types";

/** Display copy only: stored directions and command IDs remain stable. */
export function directionLabel(direction: SyncDirection): string {
  return direction === "push-only" ? "Upload only"
    : direction === "pull-only" ? "Download only"
    : "Both ways";
}

export function resolutionLabel(choice: "ours" | "theirs" | "both"): string {
  return choice === "ours" ? "this device" : choice === "theirs" ? "repository" : "both versions";
}
