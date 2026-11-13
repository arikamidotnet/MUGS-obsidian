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
import { parseUnifiedDiff, attributeHunks, authorAccent, assignAuthorColors, type ParsedDiff, type AuthorsByFile, type DiffLine } from "./diffModel";
import { describeConflictActions, type ConflictAction } from "../sync/conflictActions";
import type { FileConflict, ResolveChoice } from "../sync/conflict";

/** Derive a pale background tint ("hsl(h,s%,l%)") → "hsla(h,s%,l%,0.12)". */
function paleTint(hsl: string): string {
  const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(hsl);
  if (!m) return hsl;
  return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, 0.14)`;
}

/** Bounded comparison of the captured conflict snapshots, never live or guessed bytes.
 * Common prefix/suffix stay context; the divergent region is shown in full so a
 * choice cannot be mistaken for an automatic line-level merge. */
export function renderConflictComparison(host: HTMLElement, conflict: FileConflict): void {
  host.createEl("p", { cls: "mugs-page-description", text: "This device → Repository. These are the versions captured when sync found overlapping edits." });
  const before = conflict.oursAbsent ? [] : conflict.ours.split("\n");
  const after = conflict.theirsAbsent ? [] : conflict.theirs.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3);
  const lines: DiffLine[] = [
    ...before.slice(start, prefix).map((content) => ({ type: "context" as const, content })),
    ...before.slice(prefix, before.length - suffix).map((content) => ({ type: "removed" as const, content })),
    ...after.slice(prefix, after.length - suffix).map((content) => ({ type: "added" as const, content })),
    ...before.slice(before.length - suffix, before.length - suffix + Math.min(suffix, 3)).map((content) => ({ type: "context" as const, content })),
  ];
  if (lines.length > 2000 || conflict.ours.length + conflict.theirs.length > 256 * 1024) {
    host.createEl("p", { cls: "mugs-note", text: "This file is too large for an inline comparison. Open both copies and review the complete file before choosing a version." });
    return;
  }
  if (conflict.oursAbsent || conflict.theirsAbsent) {
    host.createEl("p", { cls: "mugs-note", text: `${conflict.oursAbsent ? "This device" : "Repository"} deleted this file. Choosing that side deletes both copies.` });
  }
  renderDiff({ files: [{ name: conflict.path, hunks: [{
    file: conflict.path, oldStart: start + 1, newStart: start + 1,
    oldCount: lines.filter((line) => line.type !== "added").length,
    newCount: lines.filter((line) => line.type !== "removed").length,
    lines,
  }] }] }, host);
}

function lineCounts(file: ParsedDiff["files"][number]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) for (const line of hunk.lines) {
    if (line.type === "added") added++;
    if (line.type === "removed") removed++;
  }
  return { added, removed };
}

function renderCounts(host: HTMLElement, counts: { added: number; removed: number }): void {
  const summary = host.createSpan({ cls: "mugs-diff-summary" });
  summary.createSpan({ text: `+${counts.added}`, cls: "mugs-diff-count mugs-diff-count-added" });
  summary.createSpan({ text: `-${counts.removed}`, cls: "mugs-diff-count mugs-diff-count-removed" });
}

/** Render one unresolved conflict as a labeled row with resolution buttons.
 * `onResolve` receives the conflict and the chosen winner so callers can persist it.
 * Returns the row element so callers can attach per-row notes (e.g. a failed
 * resolution's error message) directly under it. */
export function renderConflictRow(
  container: HTMLElement,
  c: FileConflict,
  onResolve: (c: FileConflict, choice: ResolveChoice) => void,
  busyPaths?: Set<string>,
): HTMLElement {
  const { ours, theirs } = describeConflictActions(c);

  const row = container.createDiv({ cls: "mugs-conflict-row" });
  const pathEl = row.createSpan({ text: c.path, cls: "mugs-conflict-path" });
  if (c.oursSavedAt || c.theirsModifiedAt) {
    let when = "";
    if (c.oursSavedAt) when += `saved ${relativeTime(Date.now() - c.oursSavedAt)}`;
    if (c.theirsModifiedAt && c.oursSavedAt) when += " · ";
    if (c.theirsModifiedAt) when += `remote ${relativeTime(Date.now() - c.theirsModifiedAt * 1000)}`;
    pathEl.setAttr("title", when);
  }

  const labels = row.createDiv({ cls: "mugs-conflict-actions" });
  renderActionLabel(labels, ours);
  renderActionLabel(labels, theirs);

  const disabled = !!busyPaths?.has(c.path);
  new ConflictButtons(row, c, onResolve, disabled).mount();
  return row;
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
  chip.createSpan({ text: `${a.side === "ours" ? "This device" : "Repository"}: `, cls: "mugs-conflict-action-side" });
  chip.createSpan({ text: a.detail, cls: "mugs-conflict-action-detail" });
}

/** The Take ours / theirs / Merge both buttons for one conflict. */
class ConflictButtons {
  constructor(
    private host: HTMLElement,
    private c: FileConflict,
    private onResolve: (c: FileConflict, choice: ResolveChoice) => void,
    private disabled = false,
  ) {}

  mount(): void {
    const wrap = this.host.createDiv({ cls: "mugs-conflict-buttons" });
    // Honest labels: when a side deleted the file, choosing it DELETES the file on
    // both sides (vault and clone) — the button and its tooltip must say so,
    // not imply a content pick.
    const deletion = "Delete this file on both sides — your vault copy and the synced repository copy.";
    this.button(
      wrap,
      this.c.oursAbsent ? "Delete both copies (this device)" : "Keep this device",
      "ours",
      this.c.oursAbsent ? deletion : "Use the version on this device",
    );
    this.button(
      wrap,
      this.c.theirsAbsent ? "Delete both copies (repository)" : "Keep repository",
      "theirs",
      this.c.theirsAbsent ? deletion : "Use the repository version of this file",
    );
    this.button(wrap, "Combine both", "both", "Combine both versions where possible");
  }

  private button(wrap: HTMLElement, text: string, choice: ResolveChoice, title: string): void {
    const btn = wrap.createEl("button", {
      type: "button",
      text,
      cls: `mugs-conflict-btn mugs-conflict-btn-${choice}`,
    });
    // Native title tooltip for hover accessibility.
    btn.setAttribute("title", title);
    btn.disabled = this.disabled;
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

/** Select one changed file without rerunning git or hiding unresolved conflicts. */
export function renderFileBrowser(parsed: ParsedDiff, host: HTMLElement, authorsByFile: AuthorsByFile = {}): void {
  if (!parsed.files.length) {
    renderDiff(parsed, host);
    return;
  }
  const totals = parsed.files.reduce((sum, file) => {
    const counts = lineCounts(file);
    return { added: sum.added + counts.added, removed: sum.removed + counts.removed };
  }, { added: 0, removed: 0 });
  const overview = host.createDiv({ cls: "mugs-diff-overview" });
  overview.createSpan({ text: `${parsed.files.length} changed file${parsed.files.length === 1 ? "" : "s"}` });
  renderCounts(overview, totals);
  const browser = host.createDiv({ cls: "mugs-diff-browser" });
  const list = browser.createDiv({ cls: "mugs-diff-file-list" });
  list.setAttribute("aria-label", "Changed files");
  const focused = browser.createDiv({ cls: "mugs-diff-focused" });
  const palette = assignAuthorColors(parsed.files.flatMap((f) => f.hunks.flatMap((h) => h.author ? [h.author] : [])));
  const buttons: HTMLButtonElement[] = [];
  const authors = (name: string) => [...new Set((authorsByFile[name] ?? []).map((author) => author.name).filter(Boolean))];
  const select = (index: number): void => {
    focused.empty();
    buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
    const names = authors(parsed.files[index].name);
    renderDiff({ ...parsed, files: [parsed.files[index]] }, focused, palette);
    if (names.length) {
      focused.createEl("p", {
        text: `Authors: ${names.join(", ")}`,
        cls: "mugs-diff-file-authors",
        attr: { title: "Git authors for this file in the selected range, not line-by-line attribution." },
      });
    }
  };
  parsed.files.forEach((file, index) => {
    const names = authors(file.name);
    const counts = lineCounts(file);
    const button = list.createEl("button", { cls: "mugs-diff-file-choice", type: "button" });
    button.setAttribute("title", `${file.name}${names.length ? ` · ${names.join(", ")}` : ""}`);
    button.setAttribute("aria-label", `${file.name}, ${counts.added} added, ${counts.removed} removed`);
    button.createSpan({ text: file.name, cls: "mugs-diff-file-path" });
    renderCounts(button, counts);
    buttons.push(button);
    button.addEventListener("click", () => select(index));
  });
  if (parsed.files.length) select(0);
}

/** An inline per-row error for a failed resolution, shown in addition to the Notice.
 *  Rendered directly under the conflict's path so the affected row is unambiguous. */
export function renderRowError(row: HTMLElement, message: string): void {
  row.createEl("p", { text: message, cls: "mugs-conflict-row-error" });
}

/** Render unresolved conflicts with a summary title above the diff. */
export function renderConflicts(
  conflicts: FileConflict[],
  host: HTMLElement,
  onResolve: (c: FileConflict, choice: ResolveChoice) => void,
  busyPaths?: Set<string>,
): void {
  if (conflicts.length === 0) return;
  const box = host.createDiv({ cls: "mugs-conflicts" });
  box.createEl("h3", {
    text: `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} need${conflicts.length === 1 ? "s" : ""} your review`,
    cls: "mugs-conflicts-title",
  });
  for (const c of conflicts) renderConflictRow(box, c, onResolve, busyPaths);
}

/**
 * Render an attributed inline diff with per-author tints and collapsible hunks.
 * `colors` maps author name → accent color; when omitted a default palette is built
 * from the authors present in the parsed diff.
 */
export function renderDiff(parsed: ParsedDiff, host: HTMLElement, colors?: Map<string, string>): void {
  if (parsed.files.length === 0) {
    // Render a contained empty state (styled via .mugs-diff-output .mugs-empty-state)
    // so it matches the other "in sync" / "no baseline" cards in the Diff view.
    const card = host.createDiv({ cls: "mugs-empty-state" });
    card.createEl("h3", { text: "No changes in this range" });
    card.createEl("p", {
      text: "Choose an older commit to see earlier changes.",
      cls: "mugs-muted",
    });
    return;
  }

  const palette = colors ?? assignAuthorColors(parsed.files.flatMap((f) => f.hunks.map((h) => h.author).filter(Boolean) as string[]));

  for (const file of parsed.files) {
    renderFileBlock(file, host, palette);
  }
}

/** Render one file's diff block with a collapsible header and +/- counts. */
function renderFileBlock(file: ParsedDiff["files"][number], host: HTMLElement, palette: Map<string, string>): void {
  const block = host.createDiv({ cls: "mugs-diff-file" });

  // File summary row — always visible even when hunks are collapsed.
  const counts = lineCounts(file);

  const header = block.createDiv({ cls: "mugs-diff-file-header" });
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "true");
  header.setAttribute("aria-label", `Toggle changes for ${file.name}`);
  const chevron = header.createSpan({ text: "▾", cls: "mugs-diff-chevron" });
  header.createEl("span", { text: file.name, cls: "mugs-diff-filename" });
  header.setAttribute("title", file.name);
  renderCounts(header, counts);

  // File-level collapse toggle.
  let fileOpen = true;
  const body = block.createDiv({ cls: "mugs-diff-file-body" });
  if (file.binary) body.createEl("p", { text: "Binary file changed. No text preview.", cls: "mugs-muted" });
  if (file.renamedFrom) body.createEl("p", { text: `Renamed from ${file.renamedFrom}`, cls: "mugs-muted" });
  if (!file.binary && !file.renamedFrom && file.hunks.length === 0) body.createEl("p", { text: "File details changed. No text changes.", cls: "mugs-muted" });
  body.style.display = "";

  // Click the file header to collapse/expand all hunks.
  const toggleFile = (e: Event) => {
    e.stopPropagation();
    fileOpen = !fileOpen;
    header.setAttribute("aria-expanded", String(fileOpen));
    chevron.textContent = fileOpen ? "▾" : "▸";
    body.style.display = fileOpen ? "" : "none";
  };
  header.addEventListener("click", toggleFile);
  header.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggleFile(e);
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
  const header = block.createDiv({ cls: "mugs-diff-hunk-header" });
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "true");
  header.setAttribute("aria-label", `Toggle changes starting at line ${hunk.newStart}`);
  if (authorColor) header.style.borderLeftColor = authorColor;

  const chevron = header.createSpan({ text: "▾", cls: "mugs-diff-chevron" });

  const label = header.createSpan({ cls: "mugs-diff-hunk-label" });
  const start = hunk.newCount === 0 ? hunk.oldStart : hunk.newStart;
  const count = hunk.newCount === 0 ? hunk.oldCount : hunk.newCount;
  label.createSpan({
    text: count > 1 ? `Lines ${start}–${start + count - 1}` : `Line ${start}`,
    cls: "mugs-diff-hunk-range",
    attr: { title: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@` },
  });
  if (hunk.section) label.createSpan({ text: hunk.section, cls: "mugs-diff-hunk-section" });
  // Each hunk scrolls independently; its gutters never stretch to fill the panel.
  const scroller = block.createDiv({ cls: "mugs-diff-code-scroll" });
  const body = scroller.createEl("table", { cls: "mugs-diff-hunk mugs-diff-hunk-body" });
  let open = true;
  const setOpen = (e?: Event) => {
    e?.stopPropagation(); // don't trigger file-level collapse
    open = !open;
    header.setAttribute("aria-expanded", String(open));
    chevron.textContent = open ? "▾" : "▸";
    header.classList.toggle("mugs-diff-hunk-open", open);
    body.style.display = open ? "" : "none";
  };

  header.addEventListener("click", setOpen);
  header.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setOpen(e);
  });

  // Render lines with proper old/new line numbers.
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const line of hunk.lines) {
    const row = body.insertRow();
    if (line.type !== "context") row.addClass(`mugs-diff-row-${line.type}`);

    // Old-side line number (for removed/context lines).
    const oldCell = row.insertCell();
    oldCell.addClass("mugs-diff-gutter");
    oldCell.createSpan({ text: String(line.type === "added" ? "" : oldNo), cls: "mugs-diff-lineno mugs-diff-lineno-old" });

    // New-side line number (for added/context lines).
    const newCell = row.insertCell();
    newCell.addClass("mugs-diff-gutter");
    newCell.createSpan({ text: String(line.type === "removed" ? "" : newNo), cls: "mugs-diff-lineno mugs-diff-lineno-new" });

    // Sign column.
    const signCell = row.insertCell();
    signCell.addClass("mugs-diff-sign-cell");
    const signEl = signCell.createSpan({ text: line.type === "added" ? "+" : line.type === "removed" ? "-" : " ", cls: `mugs-diff-sign mugs-diff-${line.type}` });

    // Content with author tint for changed lines.
    // Align class on the TD (CSS rules target td.mugs-diff-content) while keeping span for text+tint.
    const contentCell = row.insertCell();
    contentCell.addClass("mugs-diff-content");
    const contentEl = contentCell.createSpan({ text: line.content || " ", cls: "mugs-diff-content" });
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
