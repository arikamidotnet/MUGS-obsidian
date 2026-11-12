import { describe, it, expect } from "vitest";
import { GitClient } from "./client";
import type { GitResult, GitRunner } from "./types";

/** Fake runner that records calls and returns canned results. */
class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; opts?: { cwd?: string; env?: Record<string, string> } }[] = [];
  constructor(private responder: (args: string[]) => GitResult) {}
  async run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult> {
    this.calls.push({ args, opts });
    return this.responder(args);
  }
}

function client(runner: FakeRunner, cwd?: string) {
  return new GitClient(runner, cwd);
}

const last = (r: FakeRunner) => r.calls[r.calls.length - 1];

describe("GitClient — command construction", () => {
  it("passes the working directory to every command", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r, "/clones/notes").clone("https://gitlab.com/x/notes.git", "/clones/notes");
    expect(last(r).opts).toEqual({ cwd: "/clones/notes" });
  });

  it("clones with url and dir", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).clone("https://host/repo.git", "/clones/repo");
    expect(last(r).args).toEqual(["clone", "https://host/repo.git", "/clones/repo"]);
  });

  it("fetches the default remote (origin) with stall detection", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).fetch();
    expect(last(r).args).toEqual(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "fetch", "--prune", "origin"]);
  });

  it("pulls in each mode with the right flags", async () => {
    for (const [mode, expected] of [
      ["rebase", ["pull", "--rebase", "origin", "main"]],
      ["ff", ["pull", "--ff-only", "origin", "main"]],
      ["merge", ["pull", "origin", "main"]],
    ] as const) {
      const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
      await client(r).pull("origin", "main", mode);
      expect(last(r).args).toEqual(expected);
    }
  });

  it("adds given paths or everything when none are given", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).add(["a.md", "b.md"]);
    expect(last(r).args).toEqual(["-c", "core.autocrlf=false", "add", "--", "a.md", "b.md"]);
    await client(r).add();
    expect(last(r).args).toEqual(["add", "."]);
  });

  it("commits with an author when provided", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).commit("mugs push", { name: "Ada", email: "ada@example.com" });
    expect(last(r).args).toEqual(["commit", "--message", "mugs push", "--author", "Ada <ada@example.com>"]);
  });

  it("pushes with and without a branch, with stall detection", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).push("origin", "main");
    expect(last(r).args).toEqual(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "push", "origin", "main"]);
    await client(r).push();
    expect(last(r).args).toEqual(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "push", "origin"]);
  });

  it("mixed-resets to a ref", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).reset("origin/main");
    expect(last(r).args).toEqual(["reset", "origin/main"]);
  });
});

describe("GitClient — HTTP(S) credentials", () => {
  const HELPER_ARGS = ["-c", "credential.helper=", "-c", "credential.helper=!f() { echo username=$MUGS_GIT_USER; echo password=$MUGS_GIT_TOKEN; }; f"];

  it("attaches a per-invocation credential helper to clone without touching the URL", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).withAuth({ username: "oauth2", token: "glpat-secret" }).clone("https://gitlab.com/x/y.git", "/c/y");
    const call = last(r);
    // The URL in argv stays clean — no embedded token anywhere in the args…
    expect(call.args).toContain("https://gitlab.com/x/y.git");
    for (const a of call.args) expect(a).not.toContain("glpat-secret");
    // …the inherited helpers are cleared and ours (env-fed) is registered instead…
    expect(call.args.slice(0, 5)).toEqual([...HELPER_ARGS, "clone"]);
    // …and the secret reaches git only through the environment.
    expect(call.opts?.env).toMatchObject({ MUGS_GIT_USER: "oauth2", MUGS_GIT_TOKEN: "glpat-secret", GIT_TERMINAL_PROMPT: "0" });
    // No remote surgery: nothing is ever written into .git/config.
    expect(r.calls.some((c) => c.args.includes("set-url"))).toBe(false);
  });

  it("attaches the same helper to fetch and push, keeping the named remote", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const c = client(r, "/c/y").withAuth({ username: "u", token: "t" });
    const STALL = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60"];
    await c.fetch();
    expect(last(r).args).toEqual([...HELPER_ARGS, ...STALL, "fetch", "--prune", "origin"]);
    expect(last(r).opts?.env).toMatchObject({ MUGS_GIT_TOKEN: "t" });
    await c.push("origin", "main");
    expect(last(r).args).toEqual([...HELPER_ARGS, ...STALL, "push", "origin", "main"]);
  });

  it("leaves network commands untouched when no auth is set (local provider)", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).fetch();
    expect(last(r).args).toEqual(["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "fetch", "--prune", "origin"]);
    expect(last(r).opts?.env).toBeUndefined();
  });

  it("carries the helper on every command of an authed client (blobless lazy fetches need creds)", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const bound = client(r).withAuth({ username: "u", token: "t" }).at("/c/y");
    await bound.push("origin", "main");
    expect(last(r).args).toEqual([...HELPER_ARGS, "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=60", "push", "origin", "main"]);
    expect(last(r).opts).toMatchObject({ cwd: "/c/y", env: { MUGS_GIT_TOKEN: "t" } });
    // Even a local read like rev-parse carries the helper: on a blobless clone a
    // lazy blob fetch can trigger from any content-touching command.
    await bound.revParse("HEAD");
    expect(last(r).args).toEqual([...HELPER_ARGS, "rev-parse", "HEAD"]);
    expect(last(r).opts?.env).toMatchObject({ MUGS_GIT_TOKEN: "t" });
    // An unauthed client stays completely bare.
    const plain = client(r).at("/c/y");
    await plain.revParse("HEAD");
    expect(last(r).args).toEqual(["rev-parse", "HEAD"]);
    expect(last(r).opts).toEqual({ cwd: "/c/y" });
  });

  it("throws readable errors that omit the credential-helper prefix", async () => {
    const r = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: bad" }));
    await expect(client(r).withAuth({ username: "u", token: "t" }).fetch()).rejects.toThrow(
      "git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --prune origin failed (128): fatal: bad",
    );
  });
});

describe("GitClient — clone options", () => {
  it("adds blobless + no-checkout flags for http(s) clones", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).clone("https://gitlab.com/x/y.git", "/c/y", { filter: "blob:none", noCheckout: true });
    expect(last(r).args).toEqual(["clone", "--filter=blob:none", "--no-checkout", "https://gitlab.com/x/y.git", "/c/y"]);
  });

  it("adds only the filter for a blobless checkout clone", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).clone("https://gitlab.com/x/y.git", "/c/y", { filter: "blob:none" });
    expect(last(r).args).toEqual(["clone", "--filter=blob:none", "https://gitlab.com/x/y.git", "/c/y"]);
  });

  it("skips the filter for local path remotes (server may not allow it)", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).clone("/srv/shared.git", "/c/y", { filter: "blob:none", noCheckout: true });
    expect(last(r).args).toEqual(["clone", "--no-checkout", "/srv/shared.git", "/c/y"]);
  });
});

describe("GitClient — first-init topology helpers", () => {
  it("currentHead resolves '' for an unborn HEAD instead of throwing", async () => {
    const unborn = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: bad revision" }));
    expect(await client(unborn).currentHead()).toBe("");
    const born = new FakeRunner(() => ({ code: 0, stdout: "abc123\n", stderr: "" }));
    expect(await client(born).currentHead()).toBe("abc123");
  });

  it("lsFiles lists tracked paths", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "a.md\nsub/b.md\n", stderr: "" }));
    expect(await client(r).lsFiles()).toEqual(["a.md", "sub/b.md"]);
    expect(last(r).args).toEqual(["-c", "core.quotePath=false", "ls-files"]);
  });

  it("deletedPaths asks git for the deleted-only diff of a range", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "gone.md\n", stderr: "" }));
    expect(await client(r).deletedPaths("OLD..HEAD")).toEqual(["gone.md"]);
    expect(last(r).args).toEqual(["-c", "core.quotePath=false", "diff", "--name-only", "--diff-filter=D", "OLD..HEAD"]);
  });

  it("lastModifiedAt parses the last commit time of a path at a ref", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "1789032181\n", stderr: "" }));
    expect(await client(r).lastModifiedAt("origin/main", "notes/todo.md")).toBe(1789032181);
    expect(last(r).args).toEqual(["log", "-1", "--format=%ct", "origin/main", "--", "notes/todo.md"]);
  });

  it("commitExists proves the commit object is present, unlike rev-parse --verify", async () => {
    const ok = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    expect(await client(ok).commitExists("abc123")).toBe(true);
    expect(last(ok).args).toEqual(["cat-file", "-e", "abc123^{commit}"]);
    // A re-clone can lose the recorded baseline object entirely — this must read false.
    const missing = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "" }));
    expect(await client(missing).commitExists("deadbeef")).toBe(false);
  });

  it("lastModifiedAt yields undefined for a path the ref never saw", async () => {
    // git log prints nothing for a path absent from history — exit code still 0.
    const empty = new FakeRunner(() => ({ code: 0, stdout: "\n", stderr: "" }));
    expect(await client(empty).lastModifiedAt("origin/main", "brand-new.md")).toBeUndefined();
    const failed = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "" }));
    expect(await client(failed).lastModifiedAt("origin/main", "brand-new.md")).toBeUndefined();
  });
});

describe("GitClient — query parsing and errors", () => {
  it("rev-parse trims stdout and throws on failure", async () => {
    const ok = new FakeRunner(() => ({ code: 0, stdout: "abc123\n", stderr: "" }));
    expect(await client(ok).revParse("HEAD")).toBe("abc123");

    const bad = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: bad revision" }));
    await expect(client(bad).revParse("nope")).rejects.toThrow(/bad revision/);
  });

  it("isAncestor returns true on exit code 0 with correct args", async () => {
    const r = new FakeRunner((args) => ({ code: args.includes("REMOTE") ? 1 : 0, stdout: "", stderr: "" }));
    expect(await client(r).isAncestor("BASE", ["REMOTE"])).toBe(false);
  });

  it("logLines splits on newlines and drops empties", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "c3\nc2\n\nc1\n", stderr: "" }));
    expect(await client(r).logLines("base..HEAD")).toEqual(["c3", "c2", "c1"]);
  });

  it("must() throws with git's stderr on non-zero exit", async () => {
    const r = new FakeRunner(() => ({ code: 1, stdout: "", stderr: "error: cannot rebase" }));
    await expect(client(r).commit("msg")).rejects.toThrow("cannot rebase");
  });

  it("diff uses a three-dot range", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "diff --git...", stderr: "" }));
    expect(await client(r).diff("base", "HEAD")).toBe("diff --git...");
    expect(last(r).args).toEqual(["diff", "base...HEAD"]);
  });

  it("workingTreePaths lists modified and untracked paths, resolving renames", async () => {
    const out = [" M notes/a.md", "?? notes/new.md", "R  notes/old.md -> notes/moved.md"].join("\n");
    const r = new FakeRunner(() => ({ code: 0, stdout: out, stderr: "" }));
    expect(await client(r).workingTreePaths()).toEqual(["notes/a.md", "notes/new.md", "notes/moved.md"]);
    expect(last(r).args).toEqual(["-c", "core.quotePath=false", "status", "--porcelain"]);
  });
});

describe("GitClient — recentAuthors", () => {
  const US = "\u001f"; // field separator (git %x1f)
  const RS = "\u001e"; // record separator (git %x1e)

  it("logs with the limit, format, and range, then aggregates by author name", async () => {
    const out = [
      ["Grace Hopper", "grace@example.com", "1000"],
      ["Ada Lovelace", "ada@example.com", "2000"],
      ["Grace Hopper", "grace@work.example", "3000"], // same name -> count 2, latest ts 3000
      ["Bob", "bob@example.com", "1500"],
    ]
      .map((f) => f.join(US))
      .join(RS);
    const r = new FakeRunner(() => ({ code: 0, stdout: out, stderr: "" }));
    const authors = await client(r).recentAuthors("base..HEAD", 50);
    expect(last(r).args).toEqual(["log", "--max-count=50", "--format=%an%x1f%ae%x1f%at", "base..HEAD"]);
    expect(authors).toEqual([
      { name: "Grace Hopper", email: "grace@example.com", commitCount: 2, lastActivityAt: 3000 },
      { name: "Ada Lovelace", email: "ada@example.com", commitCount: 1, lastActivityAt: 2000 },
      { name: "Bob", email: "bob@example.com", commitCount: 1, lastActivityAt: 1500 },
    ]);
  });

  it("returns an empty list for an empty range and throws on failure", async () => {
    const empty = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    expect(await client(empty).recentAuthors("nope..HEAD")).toEqual([]);

    const bad = new FakeRunner(() => ({ code: 128, stdout: "", stderr: "fatal: bad revision" }));
    await expect(client(bad).recentAuthors("bad")).rejects.toThrow(/bad revision/);
  });
});
