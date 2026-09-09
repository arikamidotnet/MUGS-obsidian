/**
 * MUGS — per-mapping path exclusion (gitignore-style glob matcher).
 *
 * Carried forward from Easy-Git's exclusion logic. A mapping may declare an
 * allowlist (`includes`) and a denylist (`excludes`). `excludes` follow
 * gitignore semantics: patterns are evaluated in order, a leading `!` negates
 * (re-includes), and `*`/`**`/`?` wildcards match path segments. This is pure
 * string logic with no dependency on the git CLI, so it is fully unit-tested as
 * part of the sync contract.
 */

/** Normalize a path to forward slashes with no leading "./" or trailing "/". */
export function normalizePath(p: string): string {
  return p.split("\\").join("/").replace(/^\.{1,2}\//, "").replace(/\/+$/, "");
}

/** Escape a literal string for safe embedding in a RegExp. */
function escapeLiteral(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a single gitignore glob into an anchored RegExp.
 * A pattern with no "/" matches at any depth; otherwise it is anchored to the
 * repo root. A trailing `**` becomes `.*` (any characters, including
 * separators); a middle `**` spans whole segments; `*` and `?` stay within a
 * single segment (`[^/]*`, `[^/]`). A trailing slash marks a directory pattern
 * that also matches its subtree.
 */
export function globToRegExp(glob: string): RegExp {
  // Anchoring is decided on the original pattern (a trailing slash still counts).
  const anchored = glob.includes("/");
  glob = glob.replace(/\/+$/, ""); // "docs/" matches the dir and its subtree
  let body = "";
  const segs = glob.split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    let token: string;
    if (seg === "**") {
      // A trailing ** matches anything remaining; a middle ** spans only whole
      // segments (so "a/**/b" does not match "a/x/cb").
      token = i === segs.length - 1 ? ".*" : "(?:.*/)?";
    } else {
      token = "";
      for (const ch of seg) {
        if (ch === "*") token += "[^/]*";
        else if (ch === "?") token += "[^/]";
        else token += escapeLiteral(ch);
      }
    }
    // Insert a separator before this segment unless it is the first segment or
    // preceded by "**" (whose ".*" already spans any following segments).
    if (i !== 0 && segs[i - 1] !== "**") body += "/";
    body += token;
  }
  const prefix = anchored ? "" : "(?:.*/)?";
  return new RegExp(`^${prefix}${body}(?:/.*)?$`);
}

/** A single compiled gitignore pattern (regex + whether it negates). */
interface CompiledPattern {
  re: RegExp;
  negate: boolean;
}

/**
 * Ordered gitignore matcher. `isExcluded` returns the result of the last
 * matching pattern (a bare match excludes; a `!` match re-includes); an
 * unmatched path is considered included (not excluded).
 */
export class GitignoreMatcher {
  private readonly patterns: CompiledPattern[];

  constructor(patterns: Iterable<string>) {
    const compiled: CompiledPattern[] = [];
    for (let raw of patterns) {
      raw = raw.trim();
      if (!raw || raw.startsWith("#")) continue; // blank line or comment
      let negate = false;
      if (raw.startsWith("!")) {
        negate = true;
        raw = raw.slice(1);
      }
      const dirOnly = raw.endsWith("/");
      const glob = dirOnly ? raw.replace(/\/$/, "") : raw;
      compiled.push({ re: globToRegExp(glob), negate });
    }
    this.patterns = compiled;
  }

  /** True when the path is excluded by the last matching pattern. */
  isExcluded(path: string): boolean {
    let excluded = false;
    const norm = normalizePath(path);
    for (const { re, negate } of this.patterns) {
      if (re.test(norm)) excluded = !negate;
    }
    return excluded;
  }
}

/** Per-mapping include/exclude rules. */
export interface ExclusionRules {
  /** Allowlist globs; empty means "no allowlist" (everything not excluded is synced). */
  includes: string[];
  /** Denylist globs, gitignore-style (`!` negates). */
  excludes: string[];
}

/** True when `path` matches at least one include glob. */
export function matchesAnyInclude(path: string, includes: string[]): boolean {
  if (includes.length === 0) return true;
  const norm = normalizePath(path);
  return includes.some((g) => globToRegExp(g).test(norm));
}

/**
 * Decide whether a file should be synced for a mapping. A path is synced when
 * it is in the allowlist (if any) and not excluded by the denylist.
 */
export function shouldSync(path: string, rules: ExclusionRules): boolean {
  if (!matchesAnyInclude(path, rules.includes)) return false;
  return !new GitignoreMatcher(rules.excludes).isExcluded(path);
}
