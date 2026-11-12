import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MugsStore, MemoryIO } from "../store";
import { StoreDiffDataSource } from "./defaultDataSources";
import { parseUnifiedDiff } from "./diffModel";

describe("Diff history with real temporary git repositories", () => {
  it("compares completed sync or older history to HEAD, never reverses additions, and excludes working edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "mugs-diff-history-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Diff Test");
      git("config", "user.email", "diff@example.invalid");
      mkdirSync(join(root, "notes"));
      writeFileSync(join(root, "notes/a.md"), "before\n");
      writeFileSync(join(root, "outside.md"), "outside before\n");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(root, "notes/a.md"), "after\n");
      writeFileSync(join(root, "notes/b.md"), "new file\n");
      writeFileSync(join(root, "outside.md"), "outside after\n");
      git("add", ".");
      git("commit", "-qm", "current");
      const head = git("rev-parse", "HEAD");
      writeFileSync(join(root, "notes/a.md"), "UNSYNCED\n");
      const store = new MugsStore(new MemoryIO());
      store.upsertMapping({ id: "m", label: "Notes", providerId: "c", localFolder: ".", remotePath: "notes", direction: "push-pull" });
      store.setLastSync({ mappingId: "m", correspondenceSha: head, lastRemoteSha: base, cloneDir: root, status: "ok" });
      const ds = new StoreDiffDataSource(store, root);
      expect((await ds.getDiff({ mappingId: "m", mode: "since-sync" })).outcome).toBe("identical");
      for (const query of [{ mode: "previous" as const }, { mode: "custom" as const, olderRef: base }]) {
        const result = await ds.getDiff({ mappingId: "m", ...query });
        expect(result.outcome).toBe("changed");
        expect(result.toLabel).toBe("HEAD (committed snapshot)");
        expect(result.diffText).toContain("+after");
        expect(result.diffText).toContain("-before");
        expect(result.diffText).not.toContain("UNSYNCED");
        expect(result.diffText).not.toContain("outside.md");
        expect(parseUnifiedDiff(result.diffText).files.map((f) => f.name)).toEqual(["notes/a.md", "notes/b.md"]);
      }
      const legacy = await ds.getDiff({ mappingId: "m", ref: base });
      expect(legacy.toLabel).toBe(`${base} (committed snapshot)`);
      expect(legacy.diffText).toContain("+before");
      expect((await ds.getDiff({ mappingId: "m", mode: "custom", olderRef: "missing-ref" })).outcome).toBe("git-error");
      store.setLastSync({ mappingId: "m", cloneDir: root, lastRemoteSha: base, status: "ok" });
      expect((await ds.getDiff({ mappingId: "m", mode: "since-sync" })).outcome).toBe("no-baseline");
      expect((await ds.getDiff({ mappingId: "m", mode: "previous" })).outcome).toBe("changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
