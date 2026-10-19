import { describe, it, expect } from "vitest";
import {
  shouldSyncObsidianPath,
  classifyObsidianEntry,
  effectiveObsidianEntries,
  isUnderObsidianRoot,
  obsidianTopLevel,
  DEFAULT_OBSIDIAN_ENTRIES,
} from "./obsidianScope";
import type { ObsidianConfigPolicy } from "../types";

const config = (over: Partial<ObsidianConfigPolicy> = {}): ObsidianConfigPolicy => ({
  enabled: false,
  entries: [],
  ...over,
});

describe("shouldSyncObsidianPath — gating", () => {
  it("syncs nothing under .obsidian/ when the feature is disabled", () => {
    const c = config({ enabled: false });
    expect(shouldSyncObsidianPath(".obsidian/themes/x.css", c)).toBe(false);
    expect(shouldSyncObsidianPath(".obsidian/global.css", c)).toBe(false);
  });

  it("only considers paths under the .obsidian root when enabled", () => {
    const c = config({ enabled: true });
    expect(shouldSyncObsidianPath("notes/notes/.obsidian/x", c)).toBe(false);
    expect(shouldSyncObsidianPath("other/.obsidian/global.css", c)).toBe(false);
  });
});

describe("shouldSyncObsidianPath — default classification (enabled)", () => {
  const c = config({ enabled: true });

  it("syncs vault-wide entries (themes, snippets, templates, global.css)", () => {
    expect(shouldSyncObsidianPath(".obsidian/themes/mytheme/style.css", c)).toBe(true);
    expect(shouldSyncObsidianPath(".obsidian/snippets/foo.css", c)).toBe(true);
    expect(shouldSyncObsidianPath(".obsidian/templates/t.md", c)).toBe(true);
    expect(shouldSyncObsidianPath(".obsidian/global.css", c)).toBe(true);
  });

  it("keeps personal entries local-only (settings/core/workspace/recent-files/keymaps)", () => {
    for (const top of ["settings.json", "core.json", "workspace.json", "recent-files.json", "keymaps.json"]) {
      expect(shouldSyncObsidianPath(`.obsidian/${top}`, c)).toBe(false);
    }
  });

  it("shares plugins/ but excludes each plugin's own data.json", () => {
    expect(shouldSyncObsidianPath(".obsidian/plugins/theme/main.js", c)).toBe(true);
    expect(shouldSyncObsidianPath(".obsidian/plugins/theme/data.json", c)).toBe(false);
    expect(shouldSyncObsidianPath(".obsidian/plugins/sub/deep/data.json", c)).toBe(false);
  });

  it("defaults unknown top-level entries to personal (local-only)", () => {
    expect(shouldSyncObsidianPath(".obsidian/customthing/x", c)).toBe(false);
  });
});

describe("shouldSyncObsidianPath — user overrides", () => {
  it("lets a user reclassify a vault-wide entry as personal", () => {
    const c = config({
      enabled: true,
      entries: [{ path: "themes", scope: "personal" }],
    });
    expect(shouldSyncObsidianPath(".obsidian/themes/mytheme/style.css", c)).toBe(false);
  });

  it("lets a user exclude a specific file from a vault-wide entry", () => {
    const c = config({
      enabled: true,
      entries: [{ path: "snippets", scope: "vault-wide", excludes: ["legacy/*.css"] }],
    });
    expect(shouldSyncObsidianPath(".obsidian/snippets/modern.css", c)).toBe(true);
    expect(shouldSyncObsidianPath(".obsidian/snippets/legacy/old.css", c)).toBe(false);
  });

  it("lets a user restrict a vault-wide entry to specific includes", () => {
    const c = config({
      enabled: true,
      entries: [{ path: "templates", scope: "vault-wide", includes: ["shared/*.md"] }],
    });
    expect(shouldSyncObsidianPath(".obsidian/templates/shared/heading.md", c)).toBe(true);
    expect(shouldSyncObsidianPath(".obsidian/templates/personal/note.md", c)).toBe(false);
  });
});

describe("effectiveObsidianEntries — defaults overlaid by config", () => {
  it("preserves defaults and lets user entries win for the same top-level path", () => {
    const effective = effectiveObsidianEntries(config({
      enabled: true,
      entries: [{ path: "themes", scope: "personal" }],
    }));
    expect(effective.get("settings.json")?.scope).toBe("personal");
    expect(effective.get("themes")?.scope).toBe("personal"); // user override wins
    expect(effective.has("snippets")).toBe(true); // default still present
  });

  it("mirrors the shipped DEFAULT_SYNC_POLICY.obsidianConfig classification", () => {
    const names = DEFAULT_OBSIDIAN_ENTRIES.map((e) => e.path);
    expect(names).toContain("themes");
    expect(names).toContain("settings.json");
    expect(DEFAULT_OBSIDIAN_ENTRIES.find((e) => e.path === "plugins")?.scope).toBe("vault-wide");
  });

  it("round-trips a per-entry scope edit through effectiveObsidianEntries", () => {
    const base = config({ enabled: true, entries: [{ path: "themes", scope: "personal" }] });
    expect(shouldSyncObsidianPath(".obsidian/themes/x.css", base)).toBe(false); // personal -> local
    const editedMap = effectiveObsidianEntries(base);
    const themes = structuredClone(editedMap.get("themes")!);
    themes.scope = "vault-wide";
    editedMap.set("themes", themes);
    const edited = { enabled: true, entries: Array.from(editedMap.values()) } as ObsidianConfigPolicy;
    expect(shouldSyncObsidianPath(".obsidian/themes/x.css", edited)).toBe(true); // now shared
  });
});

describe("path helpers", () => {
  it("detects the .obsidian root and its top-level child", () => {
    expect(isUnderObsidianRoot(".obsidian")).toBe(true);
    expect(isUnderObsidianRoot(".obsidian/a/b")).toBe(true);
    expect(isUnderObsidianRoot("a/.obsidian/b")).toBe(false);
    expect(obsidianTopLevel(".obsidian/plugins/theme/x")).toBe("plugins");
    expect(obsidianTopLevel(".obsidian/settings.json")).toBe("settings.json");
  });

  it("classifies known vs unknown top-level entries", () => {
    const c = config({ enabled: true });
    expect(classifyObsidianEntry("themes", c)).toBe("vault-wide");
    expect(classifyObsidianEntry("settings.json", c)).toBe("personal");
    expect(classifyObsidianEntry("mystery", c)).toBe("personal");
  });
});
