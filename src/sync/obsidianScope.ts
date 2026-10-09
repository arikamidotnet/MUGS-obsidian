/**
 * MUGS — `.obsidian/` config sync scoping (pure).
 *
 * When `sync.obsidianConfig.enabled`, the vault's own configuration directory
 * becomes syncable, but only its *vault-wide* entries are shared; user-specific
 * state stays local. Classification reuses the gitignore matcher from exclusion.ts
 * so per-entry include/exclude globs compose naturally. No Obsidian/git imports —
 * fully unit-tested.
 */

import { GitignoreMatcher, matchesAnyInclude, normalizePath } from "./exclusion";
import type { ObsidianConfigPolicy, ObsidianEntryPolicy } from "../types";

/**
 * Default personal / vault-wide classification for each top-level `.obsidian/`
 * entry. Personal entries are user-specific state that should never leak into
 * shared history; vault-wide entries are the things a team wants to share. These
 * are tunable in settings and overlaid by any user-provided `config.entries`.
 */
export const DEFAULT_OBSIDIAN_ENTRIES: ObsidianEntryPolicy[] = [
  { path: "settings.json", scope: "personal" },
  { path: "core.json", scope: "personal" },
  { path: "workspace.json", scope: "personal" },
  { path: "recent-files.json", scope: "personal" },
  { path: "keymaps.json", scope: "personal" },
  { path: "global.css", scope: "vault-wide" },
  { path: "themes", scope: "vault-wide" },
  { path: "snippets", scope: "vault-wide" },
  { path: "templates", scope: "vault-wide" },
  // Per-plugin manifests are shared; each plugin's own data.json (any depth) stays local.
  { path: "plugins", scope: "vault-wide", excludes: ["**/data.json"] },
];

/** The classification returned when a top-level entry has no explicit policy. */
export type ObsidianScope = "vault-wide" | "personal";

/**
 * Build the effective top-level → entry map: defaults overlaid by user config, so
 * a user entry replaces (or adds to) the default for that top-level path.
 */
export function effectiveObsidianEntries(
  config: ObsidianConfigPolicy,
): Map<string, ObsidianEntryPolicy> {
  const map = new Map<string, ObsidianEntryPolicy>();
  for (const e of DEFAULT_OBSIDIAN_ENTRIES) map.set(e.path, structuredClone(e));
  for (const e of config.entries) map.set(e.path, structuredClone(e));
  return map;
}

/** True when `vaultPath` is the `.obsidian` root or a descendant of it. */
export function isUnderObsidianRoot(vaultPath: string): boolean {
  const norm = normalizePath(vaultPath);
  return norm === ".obsidian" || norm.startsWith(".obsidian/");
}

/** The top-level `.obsidian/` child that `vaultPath` lives under (or itself). */
export function obsidianTopLevel(vaultPath: string): string {
  const norm = normalizePath(vaultPath);
  const rest = norm.startsWith(".obsidian/") ? norm.slice(".obsidian/".length) : norm;
  return rest.split("/")[0];
}

/**
 * Classify a single top-level `.obsidian/` entry as vault-wide (shared) or personal
 * (local-only). Unknown entries default to personal so uncategorized files never
 * leak into shared history.
 */
export function classifyObsidianEntry(
  topLevel: string,
  config: ObsidianConfigPolicy,
): ObsidianScope {
  return effectiveObsidianEntries(config).get(topLevel)?.scope ?? "personal";
}

/**
 * Decide whether a vault path under `.obsidian/` should be synced. A path syncs
 * when the feature is enabled, it lives under `.obsidian/`, its top-level entry is
 * vault-wide, and it is not excluded by that entry's gitignore rules (personal
 * entries and user-excluded paths are local-only). When disabled, nothing under
 * `.obsidian/` syncs — preserving the historical "reject .obsidian" behavior.
 */
export function shouldSyncObsidianPath(vaultPath: string, config: ObsidianConfigPolicy): boolean {
  if (!config.enabled) return false;
  const norm = normalizePath(vaultPath);
  if (norm !== ".obsidian" && !norm.startsWith(".obsidian/")) return false;

  const rest = norm.startsWith(".obsidian/") ? norm.slice(".obsidian/".length) : norm;
  if (!rest) return false;

  const topLevel = rest.split("/")[0];
  const entry = effectiveObsidianEntries(config).get(topLevel);
  if (!entry) return false; // unknown top-level → personal/local-only by default
  if (entry.scope !== "vault-wide") return false;

  // Gitignore globs apply within the entry's subtree.
  const subpath = rest.slice(topLevel.length).replace(/^\//, "");
  const excludes = entry.excludes ?? [];
  if (new GitignoreMatcher(excludes).isExcluded(subpath || topLevel)) return false;
  const includes = entry.includes ?? [];
  if (includes.length > 0 && !matchesAnyInclude(subpath || ".", includes)) {
    return false;
  }
  return true;
}
