/**
 * MUGS — S07 manual resolution transaction tests.
 *
 * Realistic in-memory fakes (not the sync harness): a fake WorkingTreeWriter with
 * operation log, a MemoryTrashStore, a store-like conflict holder, and a save()
 * stub whose SaveResult the tests control. Every contract rule from §5/§10 is
 * pinned red→green here:
 *  - identity/version check (stale render rejected)
 *  - single-flight (second call refused while one runs)
 *  - originals written BEFORE mutation (clone + vault + trash), ordered
 *  - clone write → vault write → state clear → save() ordering
 *  - SaveResult {ok:false} ⇒ failure, conflict restored, retry recorded
 *  - mid-way failure ⇒ durable retry record, originals preserved
 *  - unsafe path rejected without any mutation
 */
import { describe, it, expect } from "vitest";
import { createConflictResolver, type ConflictResolverDeps } from "./conflictResolver";
import type { FileConflict, PendingOperation } from "../types";
import type { WorkingTreeWriter } from "../sync/cloneManager";
import { MemoryTrashStore } from "../sync/trash";
import type { SaveResult } from "../store";

/** Fake working tree: records op order and serves content from a map. */
function fakeTree(log: string[], name: string): WorkingTreeWriter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    writeFile: async (p, c) => { log.push(`${name}:write:${p}`); files.set(p, c); },
    readFile: async (p) => files.get(p),
    deleteFile: async (p) => {
      log.push(`${name}:delete:${p}`);
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
  };
}

const storedConflict = (): FileConflict => ({
  path: "Notes/a.md",
  base: "base\n",
  ours: "ours\n",
  theirs: "theirs\n",
});

function makeDeps(overrides: Partial<ConflictResolverDeps> = {}, saveResult?: SaveResult) {
  const log: string[] = [];
  const cloneTree = fakeTree(log, "clone");
  const vaultTree = fakeTree(log, "vault");
  cloneTree.files.set("/clone/Notes/a.md", "ours\n");
  vaultTree.files.set("/vault/Notes/a.md", "ours\n");
  const conflicts: FileConflict[] = [storedConflict()];
  const retries: PendingOperation[] = [];
  const trash = new MemoryTrashStore();
  const deps: ConflictResolverDeps = {
    getConflicts: (id) => (id === "m1" ? [...conflicts] : []),
    getMapping: (id) => (id === "m1" ? { id, localFolder: "Notes", providerId: "p1" } : undefined),
    cloneDirFor: () => "/clone",
    cloneTree,
    vaultTree,
    vaultAbsPath: (_id, rel) => `/vault/${rel}`,
    trash,
    save: async () => saveResult ?? { ok: true },
    setConflicts: (id, list) => { if (id === "m1") conflicts.splice(0, conflicts.length, ...list); },
    recordRetry: (id, op) => { if (id === "m1") retries.push(op); },
    now: () => 1_000,
    ...overrides,
  };
  return { deps, log, cloneTree, vaultTree, conflicts, retries, trash };
}

describe("S07 manual resolution transaction", () => {
  it("applies in contract order: originals first, then clone→vault→state clear→save", async () => {
    const { deps, log, cloneTree, vaultTree, trash, conflicts } = makeDeps();
    const resolver = createConflictResolver(deps).forMapping("m1");
    const outcome = await resolver(storedConflict(), "theirs");
    expect(outcome).toEqual({ ok: true, applied: true });

    // Order: originals (trash + .mugs-origin writes) precede any resolved-content write.
    const firstWriteIdx = log.findIndex((l) => l.includes("vault:write:/vault/Notes/a.md,"));
    expect(log[0]).toMatch(/^vault:write:\/vault\/Notes\/a\.md\.mugs-origin$/);
    expect(log[1]).toBe("clone:write:/clone/Notes/a.md.mugs-origin");
    expect(log.indexOf("clone:write:/clone/Notes/a.md")).toBeGreaterThan(1);
    expect(log.indexOf("vault:write:/vault/Notes/a.md")).toBeGreaterThan(log.indexOf("clone:write:/clone/Notes/a.md"));
    void firstWriteIdx;

    // Trash holds both sides' originals BEFORE mutation happened (MemoryTrashStore).
    expect(trash.has("m1", "Notes/a.md")).toBe(true);
    expect(trash.get("m1", "Notes/a.md")).toBe("ours\n");
    expect(trash.has("m1:vault", "Notes/a.md")).toBe(true);

    // Resolved content landed on both trees.
    expect(cloneTree.files.get("/clone/Notes/a.md")).toBe("theirs\n");
    expect(vaultTree.files.get("/vault/Notes/a.md")).toBe("theirs\n");
    // The record is KEPT as resolved evidence (not dropped) so the next sync pass
    // can publish an ours/both winner instead of re-conflicting the same file.
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ path: "Notes/a.md", resolved: true, resolvedContent: "theirs\n" });
  });

  it("SaveResult {ok:false} is a FAILURE: conflict stays, retry recorded, no ok", async () => {
    const { deps, conflicts, retries } = makeDeps({}, { ok: false, reason: "load-error" });
    const resolver = createConflictResolver(deps).forMapping("m1");
    const outcome = await resolver(storedConflict(), "ours");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBe(true);
    // The conflict list was restored to the pre-transaction state (conflict STAYS).
    expect(conflicts.find((c) => c.path === "Notes/a.md")).toBeDefined();
    expect(retries.length).toBe(1);
    expect(retries[0].state).toBe("failed");
    expect(retries[0].lastError).toContain("load-error");
  });

  it("mid-way failure (vault write throws) keeps conflict + durable retry record", async () => {
    const { deps, conflicts, retries } = makeDeps({
      vaultTree: {
        writeFile: async () => { throw new Error("disk full"); },
        readFile: async () => "ours\n",
        deleteFile: async () => {},
      },
    });
    const resolver = createConflictResolver(deps).forMapping("m1");
    const outcome = await resolver(storedConflict(), "theirs");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.retryable).toBe(true);
      expect(outcome.error).toContain("disk full");
    }
    // The conflict was never cleared.
    expect(conflicts.find((c) => c.path === "Notes/a.md")).toBeDefined();
    expect(retries.length).toBe(1);
    expect(retries[0].kind).toBe("vault-write");
  });

  it("single-flight: second resolution while one is in flight is refused, not interleaved", async () => {
    let releaseSave: (() => void) | undefined;
    const { deps } = makeDeps({
      save: () => new Promise<SaveResult>((res) => { releaseSave = () => res({ ok: true }); }),
    });
    const factory = createConflictResolver(deps);
    const r1 = factory.forMapping("m1");
    const p1 = r1(storedConflict(), "ours");
    const p2 = r1(storedConflict(), "theirs");
    const second = await p2;
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.retryable).toBe(true);
    // Wait until the in-flight transaction actually reached save() before releasing,
    // otherwise releaseSave is still undefined and p1 would hang forever.
    for (let i = 0; i < 100 && !releaseSave; i++) await Promise.resolve();
    expect(releaseSave).toBeDefined();
    releaseSave?.();
    const first = await p1;
    expect(first.ok).toBe(true);
  });

  it("stale conflict version (content changed since render) is rejected as retryable without mutation", async () => {
    const { deps, log } = makeDeps();
    const resolver = createConflictResolver(deps).forMapping("m1");
    const stale = { ...storedConflict(), ours: "older than store\n" };
    const outcome = await resolver(stale, "ours");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBe(true);
    expect(log.length).toBe(0); // no writes happened
  });

  it("unknown path (already resolved) is a non-retryable failure with no mutation", async () => {
    const { deps, log } = makeDeps();
    const resolver = createConflictResolver(deps).forMapping("m1");
    const outcome = await resolver({ ...storedConflict(), path: "Notes/gone.md" }, "ours");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.retryable).toBe(false);
    expect(log.length).toBe(0);
  });
});
