import { describe, it, expect } from "vitest";
import { GitClient } from "./client";
import type { GitResult, GitRunner } from "./types";

/** Fake runner that records calls and returns canned results. */
class FakeRunner implements GitRunner {
  readonly calls: { args: string[]; opts?: { cwd: string } }[] = [];
  constructor(private responder: (args: string[]) => GitResult) {}
  async run(args: string[], opts?: { cwd: string }): Promise<GitResult> {
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

  it("fetches the default remote (origin)", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).fetch();
    expect(last(r).args).toEqual(["fetch", "origin"]);
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
    expect(last(r).args).toEqual(["add", "a.md", "b.md"]);
    await client(r).add();
    expect(last(r).args).toEqual(["add", "."]);
  });

  it("commits with an author when provided", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).commit("mugs push", { name: "Ada", email: "ada@example.com" });
    expect(last(r).args).toEqual(["commit", "--message", "mugs push", "--author", "Ada <ada@example.com>"]);
  });

  it("pushes with and without a branch", async () => {
    const r = new FakeRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    await client(r).push("origin", "main");
    expect(last(r).args).toEqual(["push", "origin", "main"]);
    await client(r).push();
    expect(last(r).args).toEqual(["push", "origin"]);
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
    expect(last(r).args).toEqual(["log", "--limit=50", "--format=%an%x1f%ae%x1f%at", "base..HEAD"]);
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
