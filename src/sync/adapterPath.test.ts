import { describe, it, expect } from "vitest";
import { toAdapterPath } from "./adapterPath";

describe("toAdapterPath", () => {
  it("converts an absolute path under the vault base to vault-relative", () => {
    expect(toAdapterPath("/home/arikami/Documents/FBR-WRK", "/home/arikami/Documents/FBR-WRK/.mugs-clones/c/repo/notes/a.md"))
      .toBe(".mugs-clones/c/repo/notes/a.md");
  });

  it("handles a base path with a trailing slash", () => {
    expect(toAdapterPath("/vault/", "/vault/.mugs-clones/c/repo/x.md")).toBe(".mugs-clones/c/repo/x.md");
  });

  it("passes paths outside the base through unchanged", () => {
    expect(toAdapterPath("/vault", "/tmp/elsewhere/x.md")).toBe("/tmp/elsewhere/x.md");
  });

  it("does not strip a same-prefix-but-different directory", () => {
    // /vault-other starts with the same characters as /vault but is NOT under it.
    expect(toAdapterPath("/vault", "/vault-other/.mugs-clones/x.md")).toBe("/vault-other/.mugs-clones/x.md");
  });

  it("passes through unchanged when no base path is known", () => {
    expect(toAdapterPath("", "/anything/at/all.md")).toBe("/anything/at/all.md");
  });
});
