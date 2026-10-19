/**
 * MUGS — `.obsidian/` config categorization (pure).
 *
 * Buckets top-level `.obsidian/` entries into Obsidian-Sync-style named groups so
 * the settings UI can render grouped toggle rows ("Main settings", "Themes &
 * snippets", …). Unknown entries fall under an "Other" group. This module only does
 * bucketing; scope (vault-wide vs personal) is applied by the caller via
 * effectiveObsidianEntries at render time. No Obsidian imports — fully unit-tested.
 */

import type { ObsidianEntryPolicy } from "../types";

/** A named settings category with its member top-level `.obsidian/` paths. */
export interface ObsidianCategory {
  id: string;
  title: string;
  description: string;
  /** Top-level entries belonging to this group (sorted). */
  paths: string[];
}

/** Known top-level path → category definition (Obsidian-Sync-style groups). */
const CATEGORY_BY_PATH: Record<string, Omit<ObsidianCategory, "paths">> = {
  "settings.json": { id: "main", title: "Main settings", description: "Editor, files & links, and general settings." },
  "core.json": { id: "main", title: "Main settings", description: "Core editor and interface defaults." },
  "workspace.json": { id: "personal", title: "Personal state", description: "Open files and windows (local to each user)." },
  "recent-files.json": { id: "personal", title: "Personal state", description: "Recently opened files (local to each user)." },
  "keymaps.json": { id: "hotkeys", title: "Hotkeys", description: "Custom hotkey mappings." },
  "appearance.json": { id: "appearance", title: "Appearance settings", description: "Dark mode, theme, and font options." },
  "global.css": { id: "appearance", title: "Appearance settings", description: "Global custom CSS." },
  "themes": { id: "themes", title: "Themes and snippets", description: "Downloaded themes and CSS snippets." },
  "snippets": { id: "themes", title: "Themes and snippets", description: "CSS snippets applied to the vault." },
  "templates": { id: "content", title: "Templates", description: "Note templates and template folders." },
  "plugins": { id: "plugins", title: "Plugins", description: "Installed plugins (each plugin's data.json stays local)." },
};

const OTHER_CATEGORY: Omit<ObsidianCategory, "paths"> = {
  id: "other",
  title: "Other settings",
  description: "Additional .obsidian/ configuration.",
};

/** Known category ids in display order (used to order groups deterministically). */
const KNOWN_ORDER = Object.values(CATEGORY_BY_PATH).map((c) => c.id);

/**
 * Bucket `.obsidian/` entries into named categories. Entries not in the known map
 * fall under "Other". Group order is fixed: known groups in table order, then Other;
 * within a group paths are sorted. Only the path list matters here — scope is applied
 * by the caller via effectiveObsidianEntries.
 */
export function categorizeObsidianEntries(entries: ObsidianEntryPolicy[]): ObsidianCategory[] {
  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  const bucketId = (path: string): string => CATEGORY_BY_PATH[path]?.id ?? OTHER_CATEGORY.id;
  const ensure = (id: string): void => {
    if (!buckets.has(id)) {
      buckets.set(id, []);
      order.push(id);
    }
  };
  for (const e of entries) {
    const id = bucketId(e.path);
    ensure(id);
    const list = buckets.get(id)!;
    if (!list.includes(e.path)) list.push(e.path);
  }
  // Deterministic group order: known groups in table order, Other last.
  order.sort((a, b) => {
    const ka = KNOWN_ORDER.indexOf(a) === -1 ? Number.MAX_SAFE_INTEGER : KNOWN_ORDER.indexOf(a);
    const kb = KNOWN_ORDER.indexOf(b) === -1 ? Number.MAX_SAFE_INTEGER : KNOWN_ORDER.indexOf(b);
    return ka - kb || a.localeCompare(b);
  });
  return order.map((id) => {
    const def = Object.values(CATEGORY_BY_PATH).find((c) => c.id === id) ?? OTHER_CATEGORY;
    return { ...def, paths: [...buckets.get(id)!].sort((x, y) => x.localeCompare(y)) };
  });
}
