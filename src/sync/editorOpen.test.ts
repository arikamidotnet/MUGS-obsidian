import { describe, it, expect } from "vitest";
import { isWriteSafe, EditorOpenGuard } from "./editorOpen";

describe("isWriteSafe — openEditors === 0 rule", () => {
  it("is safe when the path is not open with unsaved changes", () => {
    expect(isWriteSafe("a.md", new Set(["b.md"]))).toBe(true);
    expect(isWriteSafe("a.md", new Set())).toBe(true);
  });

  it("is unsafe when the path is open with unsaved changes", () => {
    expect(isWriteSafe("a.md", new Set(["a.md"]))).toBe(false);
  });
});

describe("EditorOpenGuard — per-path tracking", () => {
  it("constructs from an initial set of open paths", () => {
    const g = new EditorOpenGuard(["a.md", "b.md"]);
    expect(g.size).toBe(2);
    expect(g.isOpenWithUnsaved("a.md")).toBe(true);
    expect(g.isWriteSafe("c.md")).toBe(true);
  });

  it("tracks and untracks a path", () => {
    const g = new EditorOpenGuard();
    g.track("a.md");
    expect(g.isOpenWithUnsaved("a.md")).toBe(true);
    expect(g.isWriteSafe("a.md")).toBe(false);
    g.untrack("a.md");
    expect(g.isOpenWithUnsaved("a.md")).toBe(false);
    expect(g.isWriteSafe("a.md")).toBe(true);
    expect(g.size).toBe(0);
  });

  it("keeps paths independent", () => {
    const g = new EditorOpenGuard();
    g.track("a.md");
    expect(g.isWriteSafe("b.md")).toBe(true);
  });
});
