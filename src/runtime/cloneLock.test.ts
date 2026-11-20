import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireCloneLock } from "./cloneLock";

/** Linux pids wrap at `pid_max` (default 2^22); a pid at or above it was never
 * real. Probe just below that bound for a pid that is provably gone
 * (kill(pid,0) → ESRCH) — high pids are almost always free, so this finds one
 * in a few syscalls. No spawning (which hangs under the vitest worker in some
 * sandboxes) and no timers: it reads the current pid table, stable over the
 * test's microsecond window. */
function findDeadPid(): number {
  const PLAUSIBLE_PID_MAX = 2 ** 22;
  for (let pid = PLAUSIBLE_PID_MAX - 1; pid > PLAUSIBLE_PID_MAX - 4096; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not find a provably-dead pid for the test");
}

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

  it("reclaims a lock orphaned by a provably-dead owner (crash/reload)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mugs-lock-"));
    try {
      const path = join(root, "lock");
      const deadPid = findDeadPid();
      await writeFile(path, `${deadPid}:123:stale-uuid`);
      const release = await acquireCloneLock(path);
      // The stale evidence was replaced by the new owner's record.
      expect((await readFile(path, "utf8")).startsWith(`${process.pid}:`)).toBe(true);
      await release();
      // Released: the lock file is gone.
      await expect(readFile(path, "utf8")).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("still blocks while a live owner holds the lock, then admits after release", async () => {
    const root = await mkdtemp(join(tmpdir(), "mugs-lock-"));
    try {
      const path = join(root, "lock");
      const release = await acquireCloneLock(path);
      await expect(acquireCloneLock(path)).rejects.toThrow("locked");
      await release();
      await (await acquireCloneLock(path))();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
