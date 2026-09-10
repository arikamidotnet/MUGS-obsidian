import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, attributeHunks, authorsByFileFromLog } from "./diffModel";

const US = "\u001f"; // field separator (git %x1f)
const RS = "\u001e"; // record separator (git %x1e)

describe("parseUnifiedDiff", () => {
  it("parses files, hunks, and +/-/context lines with counts and section headers", () => {
    const text = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,4 @@ export function foo() {",
      " context line",
      "-old line",
      "+new line A",
      "+new line B",
      "@@ -10,2 +12,0 @@ another section",
      "-removed only",
    ].join("\n");

    const parsed = parseUnifiedDiff(text);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file.name).toBe("src/foo.ts"); // a/ and b/ prefixes stripped
    expect(file.hunks).toHaveLength(2);

    const h1 = file.hunks[0];
    expect(h1.oldStart).toBe(1);
    expect(h1.oldCount).toBe(3);
    expect(h1.newStart).toBe(1);
    expect(h1.newCount).toBe(4);
    expect(h1.section).toBe("export function foo() {");
    expect(h1.lines.map((l) => `${l.type}:${l.content}`)).toEqual([
      "context:context line",
      "removed:old line",
      "added:new line A",
      "added:new line B",
    ]);

    const h2 = file.hunks[1];
    expect(h2.oldStart).toBe(10);
    expect(h2.newCount).toBe(0);
    expect(h2.lines).toEqual([{ type: "removed", content: "removed only" }]);
  });

  it("parses multiple files and new-file diffs (/dev/null)", () => {
    const text = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");

    const parsed = parseUnifiedDiff(text);
    expect(parsed.files.map((f) => f.name)).toEqual(["src/foo.ts", "new.txt"]);
    const created = parsed.files[1];
    expect(created.hunks[0].lines).toEqual([
      { type: "added", content: "line one" },
      { type: "added", content: "line two" },
    ]);
  });

  it("returns no files for empty or malformed input", () => {
    expect(parseUnifiedDiff("").files).toEqual([]);
    expect(parseUnifiedDiff("garbage with no structure").files).toEqual([]);
  });
});

describe("attributeHunks", () => {
  it("tags hunks of a known file with its most recent author and leaves others unattributed", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
    ].join("\n"));

    const attributed = attributeHunks(parsed, {
      "src/foo.ts": [{ name: "Ada Lovelace", email: "ada@example.com" }],
    });

    expect(attributed.files[0].hunks[0]).toMatchObject({ author: "Ada Lovelace", email: "ada@example.com" });
  });

  it("falls back to basename when only the base name is keyed", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
    ].join("\n"));

    const attributed = attributeHunks(parsed, { "foo.ts": [{ name: "Grace" }] });
    expect(attributed.files[0].hunks[0].author).toBe("Grace");
  });

  it("leaves hunks unattributed when no authors are supplied", () => {
    const parsed = parseUnifiedDiff([
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
    ].join("\n"));
    expect(attributeHunks(parsed).files[0].hunks[0].author).toBeUndefined();
  });
});

describe("authorsByFileFromLog", () => {
  it("maps each file to its most recent author (newest commit first)", () => {
    // Newest record touches foo.ts and bar.ts; older record also touched foo.ts.
    const text =
      `Ada${US}ada@example.com\nsrc/foo.ts\nsrc/bar.ts` + RS +
      `Bob${US}bob@example.com\nsrc/foo.ts`;

    const byFile = authorsByFileFromLog(text);
    expect(byFile).toEqual({
      "src/foo.ts": [{ name: "Ada", email: "ada@example.com" }], // newest wins, not overwritten by Bob
      "src/bar.ts": [{ name: "Ada", email: "ada@example.com" }],
    });
  });

  it("handles authors without an email and ignores blank lines", () => {
    // git's --format=%an%x1f%ae always emits the US separator, even with an
    // empty email; represent that faithfully here.
    const text = `Grace${US}\n\nnotes/todo.md` + RS;
    expect(authorsByFileFromLog(text)).toEqual({ "notes/todo.md": [{ name: "Grace" }] });
  });

  it("returns an empty map for empty input", () => {
    expect(authorsByFileFromLog("")).toEqual({});
  });
});
