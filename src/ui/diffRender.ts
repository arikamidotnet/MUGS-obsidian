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
  const pathEl = row.createSpan({ text: c.path, cls: "mugs-conflict-path" });
  if (c.oursSavedAt || c.theirsModifiedAt) {
    // Show a small timestamp hint for recency-based conflicts.
    let when = "";
    if (c.oursSavedAt) when += `saved ${relativeTime(Date.now() - c.oursSavedAt)}`;
    if (c.theirsModifiedAt && c.oursSavedAt) when += " · ";
    if (c.theirsModifiedAt) when += `remote ${relativeTime(Date.now() - c.theirsModifiedAt * 1000)}`;
    pathEl.setAttr("title", when);
  }

  const labels = row.createDiv({ cls: "mugs-conflict-actions" });
  renderActionLabel(labels, ours);
  renderActionLabel(labels, theirs);

  new ConflictButtons(row, c, onResolve).mount();
}

/** Human-friendly relative time. */
function relativeTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
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
    const btn = wrap.createEl("button", {
      type: "button",
      text,
      cls: `mugs-conflict-btn mugs-conflict-btn-${choice}`,
    });
    // Native title tooltip for hover accessibility.
    btn.setAttribute("title", `${choice === "ours" ? "Keep our version of this file" : choice === "theirs" ? "Use their version of this file" : "Merge both versions where possible"}`);
    btn.addEventListener("click", () => {
      // Visual feedback: disable the clicked button briefly.
      btn.disabled = true;
      void Promise.resolve().then(() => {
        this.onResolve(this.c, choice);
        btn.disabled = false;
      });
    });
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
    renderFileBlock(file, host, palette);
  }
}

/** Render one file's diff block with a collapsible header showing +/- counts and author badges. */
function renderFileBlock(file: ParsedDiff["files"][number], host: HTMLElement, palette: Map<string, string>): void {
  const block = host.createDiv({ cls: "mugs-diff-file" });

  // File summary row — always visible even when hunks are collapsed.
  let added = 0;
  let removed = 0;
  const authors = new Set<string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "added") added++;
      else if (line.type === "removed") removed++;
    }
    if (hunk.author) authors.add(hunk.author);
  }

  const header = block.createDiv({ cls: "mugs-diff-file-header" });
  header.createEl("span", { text: file.name, cls: "mugs-diff-filename" });
  const summary = header.createSpan({ cls: "mugs-diff-summary" });
  summary.createSpan({ text: `+${added}`, cls: "mugs-diff-count mugs-diff-count-added" });
  summary.createSpan({ text: `-${removed}`, cls: "mugs-diff-count mugs-diff-count-removed" });
  for (const author of authors) {
    const color = palette.get(author) ?? authorAccent(author);
    const badge = header.createSpan({
      text: author,
      cls: "mugs-diff-author-badge",
      attr: { style: `background:${paleTint(color)};color:${color};border-color:${color}` },
    });
    if (author) badge.setAttr("title", `@ ${author}`);
  }

  // File-level collapse toggle.
  const chevron = header.createSpan({ text: "▾", cls: "mugs-diff-chevron" });
  let fileOpen = true;
  const body = block.createDiv({ cls: "mugs-diff-file-body" });
  body.style.display = "";

  // Click the file header to collapse/expand all hunks.
  header.addEventListener("click", (e) => {
    e.stopPropagation();
    fileOpen = !fileOpen;
    chevron.textContent = fileOpen ? "▾" : "▸";
    body.style.display = fileOpen ? "" : "none";
  });

  // Render hunks into the collapsible body.
  for (const hunk of file.hunks) {
    const authorColor = hunk.author ? palette.get(hunk.author) ?? authorAccent(hunk.author) : undefined;
    renderHunk(body, hunk, authorColor);
  }

  // The chevron rotation is handled by the header click. But we need to make sure
  // clicking a hunk header doesn't trigger file collapse — add stopPropagation there too.
}

/** A collapsible hunk: section title + line range, toggling the body below. Returns nothing (appends directly). */
function renderHunk(block: HTMLElement, hunk: ParsedDiff["files"][number]["hunks"][number], authorColor?: string): void {
  // Per-hunk +/- counts so a collapsed header still tells you the size.
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.type === "added") added++;
    else if (line.type === "removed") removed++;
  }

  const header = block.createDiv({ cls: "mugs-diff-hunk-header" });
  if (authorColor) header.style.borderLeftColor = authorColor;

  const chevron = header.createSpan({ text: "▾", cls: "mugs-diff-chevron" });

  const label = header.createSpan({ cls: "mugs-diff-hunk-label" });
  label.createSpan({ text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`, cls: "mugs-diff-hunk-range" });
  if (hunk.section) label.createSpan({ text: hunk.section, cls: "mugs-diff-hunk-section" });
  if (hunk.author) header.createSpan({ text: hunk.author, cls: "mugs-diff-author-badge" });

  const counts = header.createSpan({ cls: "mugs-diff-hunk-counts" });
  counts.createSpan({ text: `+${added}`, cls: "mugs-diff-count mugs-diff-count-added" });
  counts.createSpan({ text: `-${removed}`, cls: "mugs-diff-count mugs-diff-count-removed" });

  const body = block.createEl("table", { cls: "mugs-diff-hunk mugs-diff-hunk-body" });
  let open = true;
  const setOpen = (e?: Event) => {
    e?.stopPropagation(); // don't trigger file-level collapse
    open = !open;
    chevron.textContent = open ? "▾" : "▸";
    header.classList.toggle("mugs-diff-hunk-open", open);
    body.style.display = open ? "" : "none";
  };

  header.addEventListener("click", setOpen);

  // Render lines with proper old/new line numbers.
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const line of hunk.lines) {
    const row = body.insertRow();
    if (line.type !== "context") row.addClass(`mugs-diff-row-${line.type}`);

    // Old-side line number (for removed/context lines).
    const oldCell = row.insertCell();
    oldCell.createSpan({ text: String(line.type === "added" ? "" : oldNo), cls: "mugs-diff-lineno mugs-diff-lineno-old" });

    // New-side line number (for added/context lines).
    const newCell = row.insertCell();
    newCell.createSpan({ text: String(line.type === "removed" ? "" : newNo), cls: "mugs-diff-lineno mugs-diff-lineno-new" });

    // Sign column.
    const signEl = row.insertCell().createSpan({ text: line.type === "added" ? "+" : line.type === "removed" ? "-" : " ", cls: `mugs-diff-sign mugs-diff-${line.type}` });

    // Content with author tint for changed lines.
    const contentEl = row.insertCell().createSpan({ text: line.content || " ", cls: "mugs-diff-content" });
    if (authorColor && line.type !== "context") {
      signEl.style.borderLeftColor = authorColor;
      contentEl.style.backgroundColor = paleTint(authorColor);
    }

    // Advance the appropriate counter.
    if (line.type === "added") newNo++;
    else if (line.type === "removed") oldNo++;
    else { oldNo++; newNo++; }
  }
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
