/**
 * MUGS — diff model (pure).
 *
 * Parses a unified diff into per-file hunks and attributes each hunk to the
 * author who most recently changed its file, for the Diff view (`mugs-diff`).
 * NO Obsidian or git imports: parsing/attribution is deterministic and pinned by
 * contract tests; the view only renders what these functions produce.
 *
 * Attribution granularity is per-file (the committing author of the file), which
 * is a clean, testable approximation of "who changed this hunk". Full per-hunk
 * blame lives in a later phase; `attributeHunks` already accepts whatever
 * authors-by-file map the runtime supplies.
 */

export interface AuthorRef {
  name: string;
  email?: string;
  /** "human" (backed by git user.name/email) or "agent" (a sub-user with its own
   *  committer identity). Defaults to "human" when unset for backward compatibility. */
  kind?: "human" | "agent";
  /** Stable agent id when {@link kind} is "agent". */
  agentId?: string;
  /** The human who authorized this agent — used for remote "On-behalf-of" attribution. */
  ownerHuman?: string;
}

/** filename (repo-relative) -> committing authors, newest first. */
export type AuthorsByFile = Record<string, AuthorRef[]>;

export type DiffLineType = "context" | "removed" | "added";

export interface DiffLine {
  type: DiffLineType;
  /** Content without the +/-/space marker. */
  content: string;
}

export interface DiffHunk {
  file: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Optional hunk section header (after the third space in the `@@` line). */
  section?: string;
  lines: DiffLine[];
  /** Filled by {@link attributeHunks}: committing author of this file, if known. */
  author?: string;
  email?: string;
}

export interface DiffFile {
  name: string;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
}

const DIFF_HEADER = /^diff --git a(.*) b(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?(?: @@ ?(.*))?$/;

/**
 * Strip the leading `a/` or `b/` path prefix git adds to diff headers, or a
 * lone leading slash (which the greedy header capture can leave behind). Paths
 * with no such prefix are returned unchanged.
 */
function stripPrefix(p: string): string {
  return p.replace(/^(?:[ab]\/|\/)/, "");
}

/** Parse a unified diff into files and hunks. Malformed input degrades gracefully. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  // Holder object (not a narrowed let) so reads stay typed across the loop.
  const state = { file: null as DiffFile | null, hunk: null as DiffHunk | null };

  for (const rawLine of text.split("\n")) {
    const header = rawLine.match(DIFF_HEADER);
    if (header) {
      state.hunk = null;
      const name = stripPrefix(header[2]);
      if (!state.file || state.file.name !== name) {
        state.file = { name, hunks: [] };
        files.push(state.file);
      }
      continue;
    }

    const hunk = rawLine.match(HUNK_HEADER);
    if (hunk) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] !== undefined ? Number(hunk[2]) : 1;
      const newStart = Number(hunk[3]);
      const newCount = hunk[4] !== undefined ? Number(hunk[4]) : 1;
      state.hunk = {
        file: state.file?.name ?? "",
        oldStart,
        oldCount,
        newStart,
        newCount,
        section: hunk[5] || undefined,
        lines: [],
      };
      state.file?.hunks.push(state.hunk);
      continue;
    }

    if (state.hunk) {
      if (rawLine.startsWith("+")) {
        state.hunk.lines.push({ type: "added", content: rawLine.slice(1) });
      } else if (rawLine.startsWith("-")) {
        state.hunk.lines.push({ type: "removed", content: rawLine.slice(1) });
      } else if (rawLine.startsWith(" ")) {
        state.hunk.lines.push({ type: "context", content: rawLine.slice(1) });
      } else if (rawLine.length === 0 || !rawLine.startsWith("\\")) {
        // Unmarked line ends the hunk body (blank line or next header region).
        state.hunk = null;
      }
      // \"\" markers (\"No newline at end of file\") are ignored.
      continue;
    }
    // Everything else (index/---/+++/mode/rename) is a header we skip.
  }

  return { files };
}

/** Tag each hunk with the most recent committing author of its file, when known. */
export function attributeHunks(parsed: ParsedDiff, authorsByFile: AuthorsByFile = {}): ParsedDiff {
  const lookup = (file: string): AuthorRef | undefined => {
    const list = authorsByFile[file] ?? authorsByFile[basename(file)] ?? [];
    return list[0];
  };

  return {
    files: parsed.files.map((f) => ({
      name: f.name,
      hunks: f.hunks.map((h) => {
        const author = lookup(h.file);
        return author ? { ...h, author: author.name, email: author.email } : h;
      }),
    })),
  };
}

/**
 * Deterministic accent color for a single author name (Manyana-style tint). The same
 * name always yields the same hue; views use it to tint that author's changed lines so
 * "who did what" reads at a glance. Pure — no DOM/Obsidian dependency.
 */
export function authorAccent(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 58%, 52%)`;
}

/**
 * Assign well-separated, stable accent colors to a set of author names so every view
 * (full-tab diff + right-sidebar panel) tints the same author identically. Names are
 * sorted for determinism and hues distributed by the golden angle (~137.5°). Pure.
 */
export function assignAuthorColors(authors: Iterable<string>): Map<string, string> {
  const unique = Array.from(new Set(Array.from(authors).filter((n) => n && n.length > 0)))
    .sort((a, b) => a.localeCompare(b));
  const colors = new Map<string, string>();
  unique.forEach((name, i) => {
    colors.set(name, `hsl(${Math.round((i * 137.5) % 360)}, 62%, 54%)`);
  });
  return colors;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Parse `git log --name-only -n <limit> --format=%an%x1f%ae%x1e` output into a
 * file → latest-author map. Git prints newest first, so the first author seen
 * for a file is its most recent committer. Fields are separated by US (\x1f)
 * and records by RS (\x1e), matching the git client's format choices.
 */
export function authorsByFileFromLog(text: string): AuthorsByFile {
  const out: AuthorsByFile = {};
  const US = "\u001f";
  const RS = "\u001e";

  for (const record of text.split(RS)) {
    const lines = record.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const [authorLine, ...changed] = lines;
    const sep = authorLine.indexOf(US);
    if (sep === -1) continue;
    const name = authorLine.slice(0, sep);
    const email = authorLine.slice(sep + 1) || undefined;
    for (const path of changed) {
      const file = stripPrefix(path.trim());
      if (!file || out[file]) continue; // newest first: keep the first assignment
      out[file] = [{ name, email }];
    }
  }

  return out;
}
