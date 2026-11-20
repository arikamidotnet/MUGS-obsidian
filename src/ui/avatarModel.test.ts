import { describe, it, expect } from "vitest";
import { initialsFor, colorFor, rosterAvatarIndex, resolveAvatar } from "./avatarModel";

describe("initialsFor", () => {
  it("takes the first two initials from a spaced name", () => {
    expect(initialsFor("Ada Lovelace")).toBe("AL");
  });

  it("handles separators (dot, underscore, at)", () => {
    expect(initialsFor("ada.lovelace")).toBe("AL");
    expect(initialsFor("ada_lovelace")).toBe("AL");
    expect(initialsFor("ada@example.com")).toBe("AE");
  });

  it("uses up to two characters for a single token", () => {
    expect(initialsFor("Ada")).toBe("AD");
  });

  it("falls back to ? for an empty name", () => {
    expect(initialsFor("   ")).toBe("?");
  });
});

describe("colorFor", () => {
  it("is deterministic and name-specific", () => {
    expect(colorFor("Ada")).toBe(colorFor("Ada"));
    expect(colorFor("Ada")).not.toBe(colorFor("Grace"));
  });
});

describe("rosterAvatarIndex + resolveAvatar", () => {
  it("resolves a roster avatar by display name, case-insensitively", () => {
    const roster = rosterAvatarIndex([{ username: "ada", displayName: "Ada Lovelace", avatarUrl: "https://x/a.png" }]);
    expect(resolveAvatar({ name: "ada lovelace" }, roster).url).toBe("https://x/a.png");
  });

  it("resolves by username through the email local-part", () => {
    const roster = rosterAvatarIndex([{ username: "ada", avatarUrl: "https://x/a.png" }]);
    expect(resolveAvatar({ name: "someone else", email: "ada@example.com" }, roster).url).toBe("https://x/a.png");
  });

  it("falls back to initials + color when no URL is resolvable", () => {
    const a = resolveAvatar({ name: "Grace Hopper" });
    expect(a.url).toBeUndefined();
    expect(a.initials).toBe("GH");
    expect(a.color).toBe(colorFor("Grace Hopper"));
  });

  it("prefers an explicit avatarUrl over the roster", () => {
    const roster = rosterAvatarIndex([{ username: "ada", avatarUrl: "https://x/roster.png" }]);
    expect(resolveAvatar({ name: "ada", avatarUrl: "https://x/explicit.png" }, roster).url).toBe("https://x/explicit.png");
  });

  it("never returns a broken/empty avatar for a nameless identity", () => {
    const a = resolveAvatar({ name: "" });
    expect(a.name).toBe("Unknown");
    expect(a.initials).toBe("UN"); // deterministic and renderable, never empty
    expect(initialsFor("")).toBe("?"); // the raw helper still flags an empty name
  });
});
