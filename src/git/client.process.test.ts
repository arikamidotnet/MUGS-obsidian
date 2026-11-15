import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GitClient } from "./client";
import { ChildProcessRunner } from "./runner";

/** A real hung process, never a network request or a production repository. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mugs-client-process-"));
  const marker = join(root, "started");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000);`;
  const client = new GitClient(new ChildProcessRunner(process.execPath));
  const pid = () => existsSync(marker) ? Number(readFileSync(marker, "utf8")) : undefined;
  return {
    root, marker, script, client, pid,
    cleanup() {
      const child = pid();
      if (child) { try { process.kill(child, "SIGKILL"); } catch {} }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitUntil(check: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("temporary child process did not reach expected state");
    await delay(10);
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("GitClient to ChildProcessRunner real hung-process bounds", () => {
  it("propagates an inherited deadline to terminate a genuinely hung child", async () => {
    const f = fixture();
    try {
      const started = Date.now();
      const result = await f.client.withRunOptions({ timeoutMs: 1000 }).at(f.root).withAuth(undefined).run(["-e", f.script]);
      expect(f.pid()).toBeDefined();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("[timeout]");
      expect(Date.now() - started).toBeLessThan(5000);
      await waitUntil(() => !alive(f.pid()!));
    } finally { f.cleanup(); }
  }, 8000);

  it("cancels an already-running child after signal survives cwd/auth rebinding", async () => {
    const f = fixture();
    try {
      const ac = new AbortController();
      const task = f.client.withRunOptions({ signal: ac.signal, timeoutMs: 5000 }).at(f.root).withAuth(undefined).run(["-e", f.script]);
      await waitUntil(() => existsSync(f.marker));
      ac.abort();
      const result = await task;
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("[cancelled]");
      await waitUntil(() => !alive(f.pid()!));
    } finally { f.cleanup(); }
  }, 8000);

  it("does not create a child or marker when the inherited signal is already aborted", async () => {
    const f = fixture();
    try {
      const ac = new AbortController();
      ac.abort();
      const result = await f.client.withRunOptions({ signal: ac.signal }).at(f.root).run(["-e", f.script]);
      expect(result.stderr).toBe("[cancelled]");
      expect(existsSync(f.marker)).toBe(false);
    } finally { f.cleanup(); }
  });
});
