import { mkdir, open, readFile, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** A pid is "plausible" as a lock owner only if it is a positive safe integer
 * below this bound. Linux pids wrap at `pid_max` (default 2^22 = 4194304); a
 * value at or above it was never a real pid, so its lock is unowned evidence,
 * never a live owner. */
const PLAUSIBLE_PID_MAX = 2 ** 22;

/** Bounded reclaim attempts. A pathological race (two reclaimers, or a lock
 * that keeps reappearing under a dead pid) re-enters the EEXIST path; after a
 * few rounds we stop and report the lock as held rather than spin. */
const MAX_RECLAIM_ATTEMPTS = 3;

/** Classify the owner recorded in an existing lock file.
 * - "live": the pid exists — `kill(pid,0)` succeeds, or EPERM (alive but not
 *   ours). Never steal.
 * - "dead": the pid is plausible and provably gone (ESRCH). Its owner was
 *   killed or crashed mid-sync, so its release `finally` never ran; the lock
 *   is stale and reclaimable.
 * - "unknown": unreadable, unparseable, or implausible. Treat as owned, never
 *   steal — age is not a signal and PID reuse is possible. */
function classifyOwner(text: string): "live" | "dead" | "unknown" {
  const pid = Number(text.split(":")[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid >= PLAUSIBLE_PID_MAX) return "unknown";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "live";
  }
}

/** Acquire the advisory clone lock at `path`.
 *
 * The lock is a `pid:timestamp:uuid` file created with O_EXCL. A lock whose
 * owner pid is provably dead (ESRCH) is stale — its owner was killed or
 * crashed mid-sync, so the release `finally` never ran — and is reclaimed
 * automatically: the clone working tree is MUGS-owned scratch re-derived from
 * the vault + remote on the next pass, and unpushed commits are detected and
 * pushed by the sync planner, so reclaiming loses nothing. A live, uncertain
 * (EPERM), or unparseable/implausible owner is NEVER stolen: only a
 * provably-gone pid is reclaimed, and the exclusive open is retried after each
 * reclaim so a racing reclaimer or a new owner is re-classified, not raced.
 */
export async function acquireCloneLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = "unknown";
      let stale = false;
      try {
        const text = await readFile(path, "utf8");
        const pid = Number(text.split(":")[0]);
        const state = classifyOwner(text);
        if (state === "dead") {
          owner = `dead pid ${pid}`;
          stale = true;
        } else if (state === "live") {
          owner = `pid ${pid} (live or uncertain)`;
        }
      } catch { /* An unreadable lock remains owned, never absent. */ }
      if (!stale || attempt >= MAX_RECLAIM_ATTEMPTS) {
        throw new Error(`clone is locked by ${owner}`);
      }
      // Stale: the owner is provably gone. Remove its evidence and retry the
      // exclusive open; if another reclaimer (or a new owner) wins the race,
      // the open fails EEXIST again and we re-classify on the next round.
      try { await unlink(path); } catch { /* lost the race to another reclaimer */ }
      continue;
    }
    try {
      await handle.writeFile(`${process.pid}:${Date.now()}:${randomUUID()}`);
      const identity = await handle.stat();
      return async () => {
        try {
          const current = await lstat(path);
          if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
        } finally {
          await handle.close();
        }
      };
    } catch (error) {
      await handle.close();
      // Leave failed initialization evidence intact, rather than race another owner.
      throw error;
    }
  }
}
