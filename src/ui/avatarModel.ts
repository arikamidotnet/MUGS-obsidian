/**
 * MUGS — avatar model (pure).
 *
 * Turns an author identity (a git author, a sync actor, a roster member) into a
 * render-ready avatar: a remote image URL when one can be resolved from the
 * provider roster, otherwise deterministic initials + an accent color so the UI
 * never shows a broken image. No Obsidian/git imports — unit-tested in isolation.
 *
 * Deliberately NO Gravatar (or any email-hash) lookup: the email may be absent,
 * local, or private, and hashing it would leak it to a third party.
 */
import { authorAccent } from "./diffModel";

/** The identity an avatar is derived from. */
export interface AvatarIdentity {
  /** Display name (git author name, roster display name, or username). */
  name: string;
  /** Optional email (used only to look up a roster avatar; never hashed/sent). */
  email?: string;
  /** Explicit avatar URL when the caller already has one (e.g. a roster member). */
  avatarUrl?: string;
}

/** A render-ready avatar: a URL when resolvable, else initials + color. */
export interface Avatar {
  name: string;
  /** Remote avatar image URL, when one could be resolved. */
  url?: string;
  /** 1–2 uppercase initials derived from the name. */
  initials: string;
  /** Deterministic accent color for the initials chip. */
  color: string;
}

/** One roster entry the avatar resolver can index (subset of MemberView). */
export interface RosterAvatar {
  username?: string;
  displayName?: string;
  avatarUrl?: string;
}

/** Normalize a name/key for case-insensitive matching. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Up-to-two uppercase initials from a display name. Splits on whitespace and
 * common separators (`._-@`), so "ada.lovelace", "ada_lovelace" and
 * "Ada Lovelace" all yield "AL". Falls back to the first character, then "?".
 */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/[\s._\-@]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Deterministic accent color for a name (stable across every view). */
export function colorFor(name: string): string {
  return authorAccent(name.trim() || "?");
}

/**
 * Build a normalized name/username → avatarUrl index from a provider roster.
 * Both the username and the display name are indexed so a git author name that
 * matches either resolves. Entries without an avatarUrl are skipped.
 */
export function rosterAvatarIndex(roster: readonly RosterAvatar[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const member of roster) {
    if (!member.avatarUrl) continue;
    for (const key of [member.username, member.displayName]) {
      if (key) index.set(norm(key), member.avatarUrl);
    }
  }
  return index;
}

/**
 * Resolve an avatar for an identity. Prefers an explicit `avatarUrl`, then a
 * roster match on the display name or the email local-part; otherwise falls back
 * to initials + color.
 */
export function resolveAvatar(identity: AvatarIdentity, roster?: Map<string, string>): Avatar {
  const name = identity.name.trim() || identity.email?.trim() || "Unknown";
  let url = identity.avatarUrl?.trim() || undefined;
  if (!url && roster && roster.size > 0) {
    url = roster.get(norm(name));
    if (!url && identity.email) {
      const local = identity.email.split("@")[0];
      if (local) url = roster.get(norm(local));
    }
  }
  return { name, url, initials: initialsFor(name), color: colorFor(name) };
}
