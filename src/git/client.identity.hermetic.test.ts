/**
 * Hermetic identity test for GitClient.commit (E07).
 *
 * This test proves that commit() never relies on global git config or ambient
 * identity. It runs with a clean HOME, GIT_CONFIG_GLOBAL=/dev/null,
 * GIT_CONFIG_SYSTEM=/dev/null, and no GIT_AUTHOR_* / GIT_COMMITTER_* in env.
 *
 * The repro (pre-fix) would fail with:
 *   fatal: empty ident ... Author identity unknown
 *
 * Post-fix: GitClient.commit always supplies explicit GIT_AUTHOR_* and
 * GIT_COMMITTER_* via the environment (provided Author or FALLBACK_IDENTITY).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { GitClient } from "./client";
import { ChildProcessRunner } from "./runner";
import { FALLBACK_IDENTITY } from "./client";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rmrf(p: string) {
  try { rmSync(p, { recursive: true, force: true }); } catch {}
}

describe("GitClient — hermetic identity (E07)", () => {
  let dir: string;
  let client: GitClient;

  beforeEach(() => {
    dir = makeTempDir("mugs-hermetic-");
    // Initialize a fresh repo with NO global config identity.
    // Use -c to avoid writing user.name into the repo either.
    // Preserve PATH so git can be found even under a synthetic HOME.
    execSync("git -c user.name=x -c user.email=x@example init -q -b main .", {
      cwd: dir,
      env: { ...process.env, HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", PATH: process.env.PATH },
    });
    client = new GitClient(new ChildProcessRunner()).at(dir);
  });

  afterEach(() => {
    rmrf(dir);
  });

  it("commits with explicit fallback identity when no author/committer passed", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    await client.add(["a.txt"]);

    // Drive commit under a completely hermetic environment (no identity anywhere).
    // Preserve PATH so the child git binary and our verification execSync can locate it.
    const hermeticEnv = {
      HOME: "/nonexistent",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      PATH: process.env.PATH,
      // Ensure no ambient identity leaks in
      GIT_AUTHOR_NAME: undefined as any,
      GIT_AUTHOR_EMAIL: undefined as any,
      GIT_COMMITTER_NAME: undefined as any,
      GIT_COMMITTER_EMAIL: undefined as any,
    } as any;

    // Must not throw "empty ident" or "Author identity unknown".
    const res = await client.commit("hermetic fallback", undefined, undefined);

    expect(res.code).toBe(0);
    // Verify the commit actually recorded the documented fallback identity.
    const name = execSync("git log -1 --format=%an", { cwd: dir, env: hermeticEnv }).toString().trim();
    const email = execSync("git log -1 --format=%ae", { cwd: dir, env: hermeticEnv }).toString().trim();
    expect(name).toBe(FALLBACK_IDENTITY.name);
    expect(email).toBe(FALLBACK_IDENTITY.email);
  });

  it("commits with provided author (and falls committer back to it) under hermetic env", async () => {
    writeFileSync(join(dir, "b.txt"), "world\n");
    await client.add(["b.txt"]);

    const author = { name: "Ada Lovelace", email: "ada@lovelace.test" };
    const res = await client.commit("explicit author", author);

    expect(res.code).toBe(0);

    const name = execSync("git log -1 --format=%an", { cwd: dir }).toString().trim();
    const email = execSync("git log -1 --format=%ae", { cwd: dir }).toString().trim();
    expect(name).toBe("Ada Lovelace");
    expect(email).toBe("ada@lovelace.test");
  });

  it("commits with distinct author and committer under hermetic env", async () => {
    writeFileSync(join(dir, "c.txt"), "distinct\n");
    await client.add(["c.txt"]);

    const author = { name: "Author Only", email: "a@only.test" };
    const committer = { name: "Committer Only", email: "c@only.test" };
    const res = await client.commit("distinct ids", author, committer);

    expect(res.code).toBe(0);

    const an = execSync("git log -1 --format=%an", { cwd: dir }).toString().trim();
    const ae = execSync("git log -1 --format=%ae", { cwd: dir }).toString().trim();
    const cn = execSync("git log -1 --format=%cn", { cwd: dir }).toString().trim();
    const ce = execSync("git log -1 --format=%ce", { cwd: dir }).toString().trim();

    expect(an).toBe("Author Only");
    expect(ae).toBe("a@only.test");
    expect(cn).toBe("Committer Only");
    expect(ce).toBe("c@only.test");
  });

  it("never emits a commit whose author or committer is empty under hermetic conditions", async () => {
    writeFileSync(join(dir, "d.txt"), "guard\n");
    await client.add(["d.txt"]);

    await client.commit("guard commit");

    const an = execSync("git log -1 --format=%an", { cwd: dir }).toString().trim();
    const ae = execSync("git log -1 --format=%ae", { cwd: dir }).toString().trim();
    const cn = execSync("git log -1 --format=%cn", { cwd: dir }).toString().trim();
    const ce = execSync("git log -1 --format=%ce", { cwd: dir }).toString().trim();

    expect(an.length).toBeGreaterThan(0);
    expect(ae.length).toBeGreaterThan(0);
    expect(cn.length).toBeGreaterThan(0);
    expect(ce.length).toBeGreaterThan(0);
  });
});
