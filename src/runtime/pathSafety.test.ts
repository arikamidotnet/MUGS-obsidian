import { describe, it, expect } from "vitest";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeAdapterPath } from "./pathSafety";

describe("production adapter containment", () => {
  it("rejects symlink ancestors and target symlinks without touching their destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "mugs-path-"));
    try {
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), join(root, "linked"), "dir");
      await expect(assertSafeAdapterPath(root, "linked/note.md")).rejects.toThrow("unsafe");
      await expect(assertSafeAdapterPath(root, "linked")).rejects.toThrow("unsafe");
      await expect(assertSafeAdapterPath(root, "../escape")).rejects.toThrow("unsafe");
      await expect(assertSafeAdapterPath(root, "safe/new.md")).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
