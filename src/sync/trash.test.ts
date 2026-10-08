import { describe, it, expect } from "vitest";
import { MemoryTrashStore, trashPath } from "./trash";

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

  it("overwrites existing content for the same mapping + path", () => {
    const t = new MemoryTrashStore();
    t.trash("m1", "a.md", "first");
    t.trash("m1", "a.md", "second");
    expect(t.get("m1", "a.md")).toBe("second");
    expect(t.size).toBe(1);
  });
});
