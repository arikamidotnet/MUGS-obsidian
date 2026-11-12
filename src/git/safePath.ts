/**
 * MUGS — pure path-safety primitives (S05).
 *
 * Everything here is pure: no filesystem, no process, no I/O. The only optional
 * side-effectful piece (symlink-ancestor checking) is injected via the `PathFs`
 * interface so callers (and tests) fully control it.
 *
 * Threat model: mapping-relative paths and provider-supplied names flow into
 * `git` commands and into vault/clone filesystem writes. A hostile repo (or a
 * corrupted index) must not be able to escape the mapping root (path traversal),
 * smuggle separators that mean different things on different platforms
 * (backslash), or confuse downstream consumers with encodings/normalization.
 *
 * Design rule: REJECT, don't sanitize. If a path needs rewriting to be safe,
 * it is not safe — the caller surfaces a typed error instead.
 */

/** Rejection reasons, stable strings usable in UI copy and logs. */
export type UnsafePathReason =
  | "empty" // "" or whitespace-only
  | "nul" // contains U+0000
  | "control" // other C0 control characters
  | "absolute" // POSIX absolute (/x), Windows drive (C: x), or UNC (//x, \\x)
  | "backslash" // contains '\' (ambiguous separator: '/' on POSIX, '\' on Windows)
  | "traversal" // any ".." path segment
  | "dot-segment" // "." or empty segment ("a//b", "a/", "./a")
  | "encoded" // contains percent-escape sequences (e.g. %2e) — decoding confusables
  | "normalization" // not simultaneously NFC- and NFD-stable (Unicode confusables)
  | "windows-reserved" // CON, PRN, AUX, NUL, COM1-9, LPT1-9 (case-insensitive)
  | "whitespace" // leading/trailing whitespace inside a segment
  | "too-long" // path > 4096 chars or any segment > 255 chars
  | "invalid-ref" // ref name violates git-check-ref-format rules
  | "invalid-slug" // repo slug has bad characters or shape
  | "symlink"; // (FS check only) an ancestor is a symlink

/** The result of any pure safety check. */
export type SafeCheck =
  | { ok: true; value: string }
  | { ok: false; reason: UnsafePathReason; value: string; detail?: string };

const OK = (value: string): SafeCheck => ({ ok: true, value });
const BAD = (reason: UnsafePathReason, value: string, detail?: string): SafeCheck => ({
  ok: false,
  reason,
  value,
  detail,
});

/** Maximum accepted path length (matches most filesystem limits with headroom). */
export const MAX_PATH_LENGTH = 4096;
/** Maximum accepted single-segment length (classic NAME_MAX). */
export const MAX_SEGMENT_LENGTH = 255;

// --- Character-level primitives ---------------------------------------------

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true; // handled as "nul" by caller ordering
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function isWindowsReserved(segment: string): boolean {
  // Device names match up to an optional extension: CON, con.txt, Nul.MD
  const base = segment.split(".")[0].toUpperCase();
  if (["CON", "PRN", "AUX", "NUL"].includes(base)) return true;
  if (/^COM[1-9]$/.test(base) || /^LPT[1-9]$/.test(base)) return true;
  return false;
}

/**
 * Validate + normalize a mapping-relative path. Returns the unchanged input on
 * success (paths needing rewriting are rejected, not sanitized). Pure.
 */
export function checkRelPath(p: string): SafeCheck {
  if (p === "" || p.trim() === "") return BAD("empty", p);
  if (p.includes("\0")) return BAD("nul", p);
  if (hasControlChars(p)) return BAD("control", p);
  if (p.length > MAX_PATH_LENGTH) return BAD("too-long", p, `length ${p.length} > ${MAX_PATH_LENGTH}`);

  // Absolute forms: POSIX leading '/', Windows drive letter, UNC. Checked on the
  // RAW string (before backslash rejection) so C:\x reports "absolute" (the
  // more precise reason) rather than "backslash".
  if (p.startsWith("/")) return BAD("absolute", p, "POSIX absolute path");
  if (/^[a-zA-Z]:/.test(p)) return BAD("absolute", p, "Windows drive-relative/absolute path");
  if (p.startsWith("\\\\") || p.startsWith("//")) return BAD("absolute", p, "UNC path");

  if (p.includes("\\")) return BAD("backslash", p);
  if (/%[0-9a-fA-F]{2}/.test(p) || p.includes("%")) return BAD("encoded", p, "percent-escape present");

  // Unicode confusables: require NFC stability, so a decomposed (NFD) path that
  // renders identically but decodes/compares differently is rejected.
  if (p.normalize("NFC") !== p) return BAD("normalization", p);

  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "") return BAD("dot-segment", p, "empty segment (//, leading or trailing slash)");
    if (seg === ".") return BAD("dot-segment", p, '"." segment');
    if (seg === "..") return BAD("traversal", p, '".." segment');
    if (seg.length > MAX_SEGMENT_LENGTH) return BAD("too-long", p, `segment length ${seg.length} > ${MAX_SEGMENT_LENGTH}`);
    if (seg !== seg.trim()) return BAD("whitespace", p, "leading/trailing whitespace in segment");
    if (isWindowsReserved(seg)) return BAD("windows-reserved", p, seg);
  }
  return OK(p);
}

/** Boolean convenience wrapper around checkRelPath. */
export function isSafeRelPath(p: string): boolean {
  return checkRelPath(p).ok;
}

/**
 * Validate a ROOT directory for use as a containment base (unlike mapping
 * paths, roots MAY be absolute — clones live at real filesystem locations).
 * Everything else (traversal, NUL, backslash, encodings) is still rejected.
 */
export function checkRootDir(root: string): SafeCheck {
  if (root === "" || root.trim() === "") return BAD("empty", root);
  if (root.includes("\0")) return BAD("nul", root);
  if (hasControlChars(root)) return BAD("control", root);
  if (root.length > MAX_PATH_LENGTH) return BAD("too-long", root);
  const segments = root.split(/[/\\]/).filter((s) => s !== "");
  for (const seg of segments) {
    if (seg === "..") return BAD("traversal", root, '".." segment in root');
    if (seg.length > MAX_SEGMENT_LENGTH) return BAD("too-long", root);
    if (isWindowsReserved(seg)) return BAD("windows-reserved", root, seg);
  }
  return OK(root);
}

/**
 * Split a validated relative path into segments. Segment-wise containment is
 * built on this — NEVER on string prefixes ("a/bc".startsWith("a/b") is the
 * classic containment bug this avoids).
 */
export function segmentsOf(p: string): string[] {
  return p.split("/").filter((s) => s !== "");
}

/**
 * Segment-wise containment test: is `target` (a validated relative path) inside
 * `rootRel` (a validated relative mapping root)? Pure, prefix-bug-free.
 */
export function isInside(rootRel: string, target: string): boolean {
  const r = checkRelPath(rootRel);
  const t = checkRelPath(target);
  if (!r.ok || !t.ok) return false;
  const rs = segmentsOf(r.value);
  const ts = segmentsOf(t.value);
  if (rs.length === 0) return true; // root "." contains everything valid
  if (ts.length < rs.length) return false;
  for (let i = 0; i < rs.length; i++) if (ts[i] !== rs[i]) return false;
  return true;
}

/**
 * Join a validated root (possibly absolute) with a validated mapping-relative
 * path. Containment is guaranteed BY CONSTRUCTION: `rel` was already rejected
 * if it contained "..", absolute markers, or separators other than '/', so the
 * segment-concatenation cannot escape the root.
 */
export function joinUnderRoot(root: string, rel: string): SafeCheck {
  const r = checkRootDir(root);
  if (!r.ok) return r;
  const v = checkRelPath(rel);
  if (!v.ok) return v;
  const trimmedRoot = root.replace(/[/\\]+$/, "");
  return OK(`${trimmedRoot}/${v.value}`);
}

// --- Ref / slug validation ---------------------------------------------------

/**
 * Validate a git branch/tag/ref name per git-check-ref-format(1) rules:
 * no leading '-', no "..", no ASCII control/space/~ ^ : ? * [ \, no "@{",
 * not exactly "@", no component starting with '.', no component ending
 * ".lock", no leading/trailing/doubled slash, no trailing '.'.
 */
export function checkRefName(name: string): SafeCheck {
  if (name === "") return BAD("empty", name);
  if (name.includes("\0")) return BAD("nul", name);
  if (hasControlChars(name)) return BAD("control", name, "ref names reject control characters");
  if (name.startsWith("-")) return BAD("invalid-ref", name, "ref may not start with '-' (option injection)");
  if (name.includes("..")) return BAD("invalid-ref", name, '".." in ref');
  if (name.includes("@{")) return BAD("invalid-ref", name, '"@{" in ref');
  if (name === "@") return BAD("invalid-ref", name, 'ref may not be "@"');
  if (/[\s~^:?*\[\\]/.test(name)) return BAD("invalid-ref", name, "rejected character in ref");
  if (name.startsWith("/") || name.endsWith("/")) return BAD("invalid-ref", name, "leading/trailing slash");
  if (name.includes("//")) return BAD("invalid-ref", name, "doubled slash");
  if (name.endsWith(".") || name.endsWith("/")) return BAD("invalid-ref", name, "trailing '.' or '/'");
  for (const seg of name.split("/")) {
    if (seg.startsWith(".")) return BAD("invalid-ref", name, "component starts with '.'");
    if (seg.endsWith(".lock")) return BAD("invalid-ref", name, "component ends with '.lock'");
  }
  return OK(name);
}

/**
 * Validate a repository slug ("owner/repo"; GitLab-style nested
 * "group/sub/project" also accepted). Segments: alphanumerics plus . _ -
 * (matching what GitHub/GitLab/Gitea/Bitbucket accept), no "..", no dots-only,
 * no leading/trailing dots or hyphens in a segment.
 */
export function checkRepoSlug(slug: string): SafeCheck {
  if (slug === "" || slug.trim() === "") return BAD("empty", slug);
  if (slug.includes("\0")) return BAD("nul", slug);
  if (hasControlChars(slug)) return BAD("control", slug);
  if (slug.includes("\\") || slug.startsWith("/") || slug.endsWith("/") || slug.includes("//"))
    return BAD("invalid-slug", slug, "bad slash usage");
  if (/%/.test(slug)) return BAD("encoded", slug, "percent-escape in slug");
  if (slug.normalize("NFC") !== slug) return BAD("normalization", slug); // NFC-stability only (decomposed forms rejected)
  const parts = slug.split("/");
  if (parts.length < 2) return BAD("invalid-slug", slug, 'expected "owner/repo"');
  for (const part of parts) {
    if (part === "." || part === "..") return BAD("invalid-slug", slug, part);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part)) return BAD("invalid-slug", slug, part);
    if (part.length > MAX_SEGMENT_LENGTH) return BAD("too-long", slug);
  }
  return OK(slug);
}

// --- Injectable FS check (symlink ancestors) ---------------------------------

/** Minimal FS surface needed for symlink-ancestor checking; fully injectable. */
export interface PathFs {
  /** Like fs/promises lstat: must NOT follow the final symlink. Return null if absent. */
  lstat(p: string): Promise<{ isSymbolicLink(): boolean } | null>;
}

export type SymlinkCheckResult =
  | { ok: true }
  | { ok: false; reason: "symlink"; at: string };

/**
 * Verify no ancestor of `<root>/<rel>` — including root itself and the full
 * target — is a symlink. Every prefix that exists must be a real directory.
 * Call BEFORE writing into a clone. The FS is injected; this function itself
 * stays I/O-delegative (pure given a pure PathFs).
 */
export async function ensureNoSymlinkAncestors(root: string, rel: string, fs: PathFs): Promise<SymlinkCheckResult> {
  const j = joinUnderRoot(root, rel);
  if (!j.ok) return { ok: false, reason: "symlink", at: rel }; // invalid path: surface as unsafe
  const relSegs = segmentsOf(rel);
  // Check every prefix: root itself, root/a, root/a/b, ... the full target.
  const prefixes: string[] = [root.replace(/[/\\]+$/, "")];
  let acc = prefixes[0];
  for (const seg of relSegs) {
    acc = `${acc}/${seg}`;
    prefixes.push(acc);
  }
  for (const p of prefixes) {
    try {
      const st = await fs.lstat(p);
      if (st && st.isSymbolicLink()) return { ok: false, reason: "symlink", at: p };
    } catch {
      // lstat throwing (e.g. EACCES) — treat as unsafe rather than silently writing.
      return { ok: false, reason: "symlink", at: p };
    }
  }
  return { ok: true };
}
