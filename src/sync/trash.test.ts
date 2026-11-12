import { describe, it, expect } from "vitest";
import { MemoryTrashStore, FileSystemTrashStore, trashPath } from "./trash";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("trashPath", () => {
  it("places trashed files under <clone>/.mugs-trash/<mapping>/<path>", () => {
    expect(trashPath("/c", "m1", "notes/a.md")).toBe("/c/.mugs-trash/m1/notes/a.md");
  });

  it("handles root-level paths without a trailing slash", () => {
    expect(trashPath("/c", "m1", "a.md")).toBe("/c/.mugs-trash/m1/a.md");
  });
});

describe("MemoryTrashStore", () => {
  it("records and retrieves trashed content by mapping + path", () => {
    const t = new MemoryTrashStore();
    t.trash("m1", "a.md", "hello");
    expect(t.has("m1", "a.md")).toBe(true);
    expect(t.get("m1", "a.md")).toBe("hello");
    expect(t.size).toBe(1);
  });

  it("treats undefined content as an empty record (recoverable)", () => {
    const t = new MemoryTrashStore();
    t.trash("m1", "empty.md", undefined);
    expect(t.get("m1", "empty.md")).toBe("");
  });

  it("keeps mappings isolated by id", () => {
    const t = new MemoryTrashStore();
    t.trash("m1", "a.md", "one");
    t.trash("m2", "a.md", "two");
    expect(t.get("m1", "a.md")).toBe("one");
    expect(t.get("m2", "a.md")).toBe("two");
  });

  it("clears a single mapping without touching others", () => {
    const t = new MemoryTrashStore();
    t.trash("m1", "a.md", "one");
    t.trash("m2", "a.md", "two");
    t.clearMapping("m1");
    expect(t.has("m1", "a.md")).toBe(false);
    expect(t.has("m2", "a.md")).toBe(true);
  });

  it("S06: a second deletion at the same path VERSIONS the record — the first recovery copy survives", () => {
    const t = new MemoryTrashStore();
    t.trash("m1", "a.md", "first");
    t.trash("m1", "a.md", "second");
    // Latest wins for a plain read (restore gets the most recent copy)…
    expect(t.get("m1", "a.md")).toBe("second");
    // …but the FIRST recovery copy is never overwritten.
    expect(t.versionsOf("m1", "a.md")).toEqual(["first", "second"]);
    expect(t.size).toBe(1); // distinct paths, not versions
  });
});

describe("FileSystemTrashStore (S06 versioning + safe restore)", () => {
  it("keeps both recovery copies when the same path is deleted twice, and restoreTo refuses to clobber a newer file without intent", () => {
    const base = mkdtempSync(join(tmpdir(), "mugs-trash-"));
    try {
      const store = new FileSystemTrashStore(join(base, "trash"));
      store.trash("m1", "notes/a.md", "first copy");
      store.trash("m1", "notes/a.md", "second copy");
      expect(store.restore("m1", "notes/a.md")).toBe("second copy");
      // versioned files on disk: both copies exist as separate files
      const dir = join(base, "trash", "m1", "notes");
      expect(existsSync(dir)).toBe(true);

      // restoreTo: safe by construction, refuses to clobber an existing file
      // (the destination is <vault>/<relPath> = vault/notes/a.md).
      const vault = join(base, "vault");
      mkdirSync(join(vault, "notes"), { recursive: true });
      writeFileSync(join(vault, "notes", "a.md"), "NEWER USER CONTENT");
      const blocked = store.restoreTo("m1", "notes/a.md", vault);
      expect(blocked).toEqual({ ok: false, reason: "target-exists" });
      expect(readFileSync(join(vault, "notes", "a.md"), "utf8")).toBe("NEWER USER CONTENT");

      // With explicit intent (overwrite: true) the restore proceeds.
      const forced = store.restoreTo("m1", "notes/a.md", vault, { overwrite: true });
      expect(forced).toMatchObject({ ok: true });
      expect(readFileSync(join(vault, "notes", "a.md"), "utf8")).toBe("second copy");

      // Containment: traversal paths are rejected, never sanitized.
      expect(store.restoreTo("m1", "../escape.md", vault)).toMatchObject({ ok: false, reason: "unsafe-path" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
