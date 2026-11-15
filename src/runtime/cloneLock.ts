import { mkdir, open, readFile, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Never steal an existing lock based on age or PID reuse. Dead-owner locks
 * require explicit operator recovery after preserving dirty/unpushed work. */
export async function acquireCloneLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let owner = "unknown";
    try {
      const text = await readFile(path, "utf8");
      const pid = Number(text.split(":")[0]);
      if (Number.isSafeInteger(pid) && pid > 0) {
        owner = `pid ${pid} (live or uncertain)`;
        try { process.kill(pid, 0); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") owner = `dead pid ${pid}; preserve clone work and explicitly recover its lock`;
        }
      }
    } catch { /* An unreadable lock remains owned, never absent. */ }
    throw new Error(`clone is locked by ${owner}`);
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
