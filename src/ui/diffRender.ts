/**
 * MUGS — shared diff/conflict renderer (DOM glue, no Obsidian import).
 *
 * Renders the two surfaces Phase G adds: the attributed inline diff (full-tab
 * `mugs-diff` view) and the per-conflict rows shown there and in the right-sidebar
 * panel. It only touches DOM inside functions (`createDiv`, `createEl`, … are the
 * Obsidian HTMLElement extensions), so it never imports "obsidian" and stays safe
 * to build-check under a node test env — like diffView.ts, it is not run by vitest.
 *
 * Attribution colors come from assignAuthorColors (stable per name) so the full-tab
 * view and the sidebar panel tint the same author identically. Folding + action
 * labels are pure presentation built on describeConflictActions / attributeHunks.
 */
import { parseUnifiedDiff, attributeHunks, authorAccent, assignAuthorColors, type ParsedDiff } from "./diffModel";
import { describeConflictActions, type ConflictAction } from "../sync/conflictActions";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

/** Derive a pale background tint ("hsl(h,s%,l%)") → "hsla(h,s%,l%,0.12)". */
function paleTint(hsl: string): string {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(hsl);
  if (!m) return hsl;
  return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, 0.14)`;
}

/** Render one unresolved conflict as a labeled row with resolution buttons.
 * `onResolve` receives the conflict and the chosen winner so callers can persist it. */
export function renderConflictRow(
  container: HTMLElement,
  c: FileConflict,
  onResolve: (c: FileConflict, choice: ResolveChoice) => void,
): void {
  const { ours, theirs } = describeConflictActions(c);

  const row = container.createDiv({ cls: "mugs-conflict-row" });
  row.createSpan({ text: c.path, cls: "mugs-conflict-path" });

  const labels = row.createDiv({ cls: "mugs-conflict-actions" });
  renderActionLabel(labels, ours);
  renderActionLabel(labels, theirs);

  new ConflictButtons(row, c, onResolve).mount();
}

/** A single "ours/theirs did X" chip. */
function renderActionLabel(host: HTMLElement, a: ConflictAction): void {
  const chip = host.createSpan({ cls: `mugs-conflict-action mugs-conflict-action-${a.side}` });
  chip.createSpan({ text: `${a.side === "ours" ? "Ours" : "Theirs"}:`, cls: "mugs-conflict-action-side" });
  chip.createSpan({ text: a.detail, cls: "mugs-conflict-action-detail" });
}

/** The Take ours / theirs / Merge both buttons for one conflict. */
class ConflictButtons {
  constructor(
    private host: HTMLElement,
    private c: FileConflict,
    private onResolve: (c: FileConflict, choice: ResolveChoice) => void,
  ) {}

  mount(): void {
    const wrap = this.host.createDiv({ cls: "mugs-conflict-buttons" });
    this.button(wrap, "Take ours", "ours");
    this.button(wrap, "Take theirs", "theirs");
    this.button(wrap, "Merge both", "both");
  }

  private button(wrap: HTMLElement, text: string, choice: ResolveChoice): void {
    wrap.createEl("button", {
      type: "button",
      text,
      cls: `mugs-conflict-btn mugs-conflict-btn-${choice}`,
    }).addEventListener("click", () => this.onResolve(this.c, choice));
  }
}

/** Render unresolved conflicts with a summary title above the diff. */
export function renderConflicts(
  conflicts: FileConflict[],
  host: HTMLElement,
  onResolve: (c: FileConflict, choice: ResolveChoice) => void,
): void {
  if (conflicts.length === 0) return;
  const box = host.createDiv({ cls: "mugs-conflicts" });
  box.createEl("h3", {
    text: `MUGS — ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} need manual resolution`,
    cls: "mugs-conflicts-title",
  });
  // Each row binds its own conflict via ConflictButtons, so the same resolver works
  // for every row.
  for (const c of conflicts) renderConflictRow(box, c, onResolve);
}

/**
 * Render an attributed inline diff with per-author tints and collapsible hunks.
 * `colors` maps author name → accent color; when omitted a default palette is built
 * from the authors present in the parsed diff.
 */
export function renderDiff(parsed: ParsedDiff, host: HTMLElement, colors?: Map<string, string>): void {
  if (parsed.files.length === 0) {
    host.createEl("p", { text: "Nothing changed in this range.", cls: "mugs-muted" });
    return;
  }

  const palette = colors ?? assignAuthorColors(parsed.files.flatMap((f) => f.hunks.map((h) => h.author).filter(Boolean) as string[]));

  for (const file of parsed.files) {
    const block = host.createDiv({ cls: "mugs-diff-file" });
    block.createEl("h4", { text: file.name, cls: "mugs-diff-filename" });

    let lineNo = 0;
    for (const hunk of file.hunks) {
      const authorColor = hunk.author ? palette.get(hunk.author) ?? authorAccent(hunk.author) : undefined;
      // The header and its body table are toggled as one unit; renderDiff appends
      // the actual lines to the returned body.
      const body = renderHunkHeader(block, hunk, authorColor);
      for (const line of hunk.lines) {
        lineNo++;
        const row = body.insertRow();
        if (line.type !== "context") row.addClass(`mugs-diff-row-${line.type}`);
        row.insertCell().createSpan({ text: String(lineNo), cls: "mugs-diff-lineno" });
        const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
        const signEl = row.insertCell().createSpan({ text: sign, cls: `mugs-diff-sign mugs-diff-${line.type}` });
        const contentEl = row.insertCell().createSpan({ text: line.content || " ", cls: "mugs-diff-content" });
        if (authorColor && line.type !== "context") {
          signEl.style.borderLeftColor = authorColor;
          contentEl.style.backgroundColor = paleTint(authorColor);
        }
      }
    }
  }
}

/** A collapsible hunk header: section title + line range, toggling the body below. Returns the body table so callers can append lines. */
function renderHunkHeader(
  block: HTMLElement,
  hunk: ParsedDiff["files"][number]["hunks"][number],
  authorColor?: string,
): HTMLTableElement {
  const header = block.createDiv({ cls: "mugs-diff-hunk-header" });
  if (authorColor) header.style.borderLeftColor = authorColor;
  const chevron = header.createSpan({ text: "▸", cls: "mugs-diff-chevron" });

  let label = hunk.section || `hunk ${hunk.oldStart}–${hunk.newStart}`;
  if (hunk.author) label += ` · by ${hunk.author}`;
  header.createSpan({ text: label, cls: "mugs-diff-hunk-label" });

  const body = block.createEl("table", { cls: "mugs-diff-hunk mugs-diff-hunk-body" });
  header.addEventListener("click", () => {
    const open = header.classList.toggle("mugs-diff-hunk-open");
    chevron.textContent = open ? "▾" : "▸";
    body.style.display = open ? "" : "none";
  });
  return body;
}

/** Parse + attribute a raw diff string, then render it into `host`. Convenience for views. */
export function renderDiffText(
  diffText: string,
  host: HTMLElement,
  authorsByFile: Record<string, { name: string; email?: string }[]> = {},
): void {
  const parsed = attributeHunks(parseUnifiedDiff(diffText), authorsByFile);
  renderDiff(parsed, host);
}
