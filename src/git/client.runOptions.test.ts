import { describe, it, expect } from "vitest";
import { GitClient, DEFAULT_GIT_TIMEOUT_MS } from "./client";
import type { GitRunOpts, GitRunner } from "./types";

function capture() {
  const calls: { args: string[]; opts?: GitRunOpts }[] = [];
  const runner: GitRunner = {
    async run(args, opts) {
      calls.push({ args, opts });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { calls, client: new GitClient(runner) };
}

describe("GitClient inherited run options", () => {
  it("preserves signal/deadline through cwd and auth bindings for every operation", async () => {
    const { calls, client } = capture();
    const signal = new AbortController().signal;
    const bound = client.withRunOptions({ signal, timeoutMs: 3210 }).at("/clone").withAuth({ username: "fixture", token: "fixture" });
    await bound.clone("/tmp/fixture-remote", "/tmp/fixture-clone");
    await bound.fetch();
    await bound.push();
    await bound.showTyped("HEAD", "note.md");
    await bound.currentHead();
    await bound.commit("fixture");
    await bound.run(["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: "/tmp/fixture-index" } });
    for (const call of calls) {
      expect(call.opts).toMatchObject({ signal, timeoutMs: 3210, cwd: "/clone" });
    }
    expect(calls.at(-1)?.opts?.env).toMatchObject({ GIT_INDEX_FILE: "/tmp/fixture-index", MUGS_GIT_USER: "fixture" });
    await client.run(["--version"]);
    expect(calls.at(-1)?.opts?.signal).toBeUndefined();
  });

  it("merges default env without mutation and allows per-call deadline overrides including zero", async () => {
    const { calls, client } = capture();
    const env = { FIXTURE_DEFAULT: "first" };
    const c = client.at("/first").withRunOptions({ timeoutMs: 2000, env }).withRunOptions({ env: { FIXTURE_NEXT: "next" } }).at("/second");
    env.FIXTURE_DEFAULT = "changed outside";
    await c.run(["--version"], { timeoutMs: 0, env: { FIXTURE_NEXT: "override" } });
    expect(calls[0].opts).toMatchObject({
      cwd: "/second", timeoutMs: 0,
      env: { FIXTURE_DEFAULT: "first", FIXTURE_NEXT: "override" },
    });
    await c.run(["--version"], { timeoutMs: 50 });
    expect(calls[1].opts?.timeoutMs).toBe(50);
  });

  it("assigns generous defaults to metadata, network and potentially lazy content reads", async () => {
    const { calls, client } = capture();
    await client.currentHead();
    expect(calls.at(-1)?.opts?.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS.local);
    await client.fetch();
    expect(calls.at(-1)?.opts?.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS.network);
    await client.clone("/fixture.git", "/fixture");
    expect(calls.at(-1)?.opts?.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS.network);
    await client.showTyped("HEAD", "fixture.md");
    expect(calls.at(-1)?.opts?.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS.network);
    await client.withAuth({ username: "fixture", token: "fixture" }).currentHead();
    expect(calls.at(-1)?.opts?.timeoutMs).toBe(DEFAULT_GIT_TIMEOUT_MS.network);
  });
});
