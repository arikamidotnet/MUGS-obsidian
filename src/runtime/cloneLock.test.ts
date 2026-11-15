import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireCloneLock } from "./cloneLock";

describe("exclusive clone lock", () => {
  it("admits exactly one concurrent owner and releases for the next", async () => {
    const root = await mkdtemp(join(tmpdir(), "mugs-lock-"));
    try {
      const path = join(root, "lock");
      const results = await Promise.allSettled([acquireCloneLock(path), acquireCloneLock(path)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "fulfilled") await r.value();
      await (await acquireCloneLock(path))();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["unknown-owner", `${process.pid}:0`, "2147483647:0"])("never steals existing evidence %s", async text => {
    const root = await mkdtemp(join(tmpdir(), "mugs-lock-"));
    try {
      const path = join(root, "lock");
      await writeFile(path, text);
      await expect(acquireCloneLock(path)).rejects.toThrow("locked");
      expect(await readFile(path, "utf8")).toBe(text);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
