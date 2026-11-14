import { describe, it, expect, vi } from "vitest";
import { analyzeReview, decideReviewBatch, reviewConfig, type BulkDecisionDeps } from "./reconciliationBulk";
import { DEFAULT_SETTINGS, type MugsSettings } from "../types";
import { gitBlobId } from "../sync/reconciliation";
import type { ReconciliationReviewRow } from "../ui/reconciliationReview";
import type { SaveResult } from "../store";

const row = (path = "old.md", content = "same", length = 40): ReconciliationReviewRow => ({
  mappingId: "m", mappingLabel: "Notes", path, ref: "a".repeat(40),
  blob: gitBlobId(content, length), fingerprint: "f".repeat(64), direction: "push-only",
});
const fixture = () => {
  const settings: MugsSettings = structuredClone(DEFAULT_SETTINGS);
  settings.mappings = [{ id: "m", label: "Notes", localFolder: "Notes", remotePath: "", providerId: "p", direction: "push-only" }];
  const rows = [row(), row("second.md", "two"), row("third.md", "three")];
  settings.lastSync.m = { mappingId: "m", status: "ok", reconciliation: {
    version: 1, fingerprint: rows[0].fingerprint, proven: {}, decisions: {},
    review: Object.fromEntries(rows.map(r => [r.path, { ref: r.ref, blob: r.blob }])),
  } };
  let busy = false;
  const release = vi.fn(() => { busy = false; });
  const deps: BulkDecisionDeps = {
    getSettings: () => structuredClone(settings),
    setLastSync: vi.fn(state => { settings.lastSync[state.mappingId] = state; }),
    save: vi.fn(async (): Promise<SaveResult> => ({ ok: true })),
    acquire: vi.fn(() => {
      if (busy) throw new Error("busy");
      busy = true;
      return release;
    }),
    sync: vi.fn(async () => true),
    verify: vi.fn(async (rows: ReconciliationReviewRow[]) => new Set(rows.map(row => row.path))),
  };
  const config = reviewConfig(settings, "m");
  return { settings, rows, deps, config, release, run: (action: "delete" | "recover" = "delete") => decideReviewBatch(deps, rows, action, config) };
};

describe("read-only bulk analysis", () => {
  it("hashes each file once, detects renamed exact bytes and separates names from identity", async () => {
    const content: Record<string, string> = { "new/name.md": "same", "elsewhere/second.md": "different", "unicode.md": "é\n" };
    const read = vi.fn(async (path: string) => content[path]);
    const rows = [row(), row("second.md", "two"), row("missing.md"), row("unicode-old.md", "é\n", 64)];
    // missing.md has identical bytes too despite its unrelated name.
    const result = await analyzeReview(rows, Object.entries(content).map(([path, text]) => ({ path, size: Buffer.byteLength(text) })), read);
    expect(result.entries.map(e => e.category)).toEqual(["exact", "filename", "exact", "exact"]);
    expect(result.entries[0].matches).toEqual(["new/name.md"]);
    expect(result.entries[1].matches).toEqual(["elsewhere/second.md"]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(rows[0]).not.toHaveProperty("category");
    expect((await analyzeReview([row("absent.md", "unique")], [], read)).entries[0].category).toBe("unmatched");
  });

  it("does not normalize newlines or Unicode and reports incomplete scans conservatively", async () => {
    const read = vi.fn(async () => "same\r\n");
    const result = await analyzeReview([row("other.md", "same\n")], [{ path: "local.md", size: 6 }], read);
    expect(result.entries[0].category).toBe("unmatched");
    const failed = await analyzeReview([row()], [{ path: "broken.md", size: 10 }], async () => { throw new Error("unreadable"); });
    expect(failed.entries[0].category).toBe("inconclusive");
    expect(failed.skipped).toBe(1);
  });

  it("caps reads and bytes, ignores unsafe/hidden/binary content, bounds displayed matches", async () => {
    const files = [
      { path: "../unsafe", size: 1 }, { path: ".secrets/config", size: 1 },
      { path: "huge.md", size: 100 }, { path: "null.md", size: 1 }, { path: "ok.md", size: 1 },
    ];
    const read = vi.fn(async (path: string) => path === "null.md" ? "\0" : "same");
    const result = await analyzeReview([row()], files, read, undefined, { files: 2, fileBytes: 10, totalBytes: 10 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.entries[0].category).toBe("exact");
    expect(result.skipped).toBe(4);
    const many = await analyzeReview([row()], Array.from({ length: 25 }, (_, i) => ({ path: `${i}.md`, size: 4 })), async () => "same");
    expect(many.entries[0].matches).toHaveLength(20);
    expect(many.entries[0].matchCount).toBe(25);
  });

  it("cancels without returning a partial actionable analysis", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => { controller.abort(); return "same"; });
    await expect(analyzeReview([row()], [{ path: "file.md", size: 4 }], read, controller.signal)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("bulk decision transaction", () => {
  it("records all rows once, syncs only the chosen mapping once and reports partial outcomes", async () => {
    const f = fixture();
    f.deps.sync = vi.fn(async id => {
      expect(id).toBe("m");
      const state = f.settings.lastSync.m.reconciliation!;
      expect(Object.keys(state.decisions)).toHaveLength(3);
      delete state.decisions["old.md"];
      delete state.review["old.md"];
      delete state.decisions["second.md"];
      return true;
    });
    const result = await f.run();
    expect(result.rows.map(r => r.status)).toEqual(["applied", "requeued", "pending"]);
    expect(f.deps.save).toHaveBeenCalledTimes(1);
    expect(f.deps.sync).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["ref", "blob", "fingerprint", "direction", "mappingId", "path"] as const)("rejects stale/unsafe %s before saving", async field => {
    const f = fixture();
    f.rows[1] = { ...f.rows[1], [field]: field === "path" ? "../unsafe" : "changed" };
    await expect(f.run()).rejects.toThrow("review changed");
    expect(f.deps.save).not.toHaveBeenCalled();
    expect(f.deps.sync).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(["mapping", "policy", "provider"])("rejects a changed %s even before the engine refreshes its fingerprint", async kind => {
    const f = fixture();
    f.settings.credentials.push({ id: "p", label: "local", kind: "local", token: "", baseUrl: "file:///repo" });
    const config = reviewConfig(f.settings, "m");
    if (kind === "mapping") f.settings.mappings[0].localFolder = "Elsewhere";
    if (kind === "policy") f.settings.sync.obsidianConfig.enabled = true;
    if (kind === "provider") f.settings.credentials[0].baseUrl = "file:///different";
    await expect(decideReviewBatch(f.deps, f.rows, "delete", config)).rejects.toThrow("connection changed");
    expect(f.deps.save).not.toHaveBeenCalled();
  });

  it.each(["refused", "thrown"])("rolls back intent after a %s save; a later operation cannot apply it", async kind => {
    const f = fixture();
    f.deps.save = vi.fn(async (): Promise<SaveResult> => {
      if (kind === "thrown") throw new Error("disk failure");
      return { ok: false, reason: "load-error" };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.settings.lastSync.m.reconciliation!.decisions).toEqual({});
    expect(f.deps.sync).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("blocks concurrent operations while saving, then releases on failure", async () => {
    const f = fixture();
    let finish!: () => void;
    f.deps.save = vi.fn(() => new Promise<SaveResult>(resolve => { finish = () => resolve({ ok: false, reason: "load-error" }); }));
    const first = f.run();
    await expect(f.run()).rejects.toThrow("busy");
    finish();
    await expect(first).rejects.toThrow("persist");
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it("retains durable decisions and discloses final persistence failure", async () => {
    const f = fixture();
    f.deps.sync = vi.fn(async () => false);
    expect((await f.run()).persisted).toBe(false);
    expect(Object.keys(f.settings.lastSync.m.reconciliation!.decisions)).toHaveLength(3);
    await expect(f.run()).rejects.toThrow("pending decisions");
  });

  it("does not call dropped or disappeared queue entries applied without verified effects", async () => {
    const f = fixture();
    f.deps.sync = vi.fn(async () => {
      f.settings.lastSync.m.reconciliation!.review = {};
      f.settings.lastSync.m.reconciliation!.decisions = {};
      return true;
    });
    f.deps.verify = vi.fn(async () => new Set<string>());
    expect((await f.run()).rows.every(row => row.status === "pending")).toBe(true);
  });

  it("blocks duplicate rows, empty/oversized batches and pull-only deletion but permits recovery", async () => {
    const f = fixture();
    for (const rows of [[], [f.rows[0], f.rows[0]], Array.from({ length: 501 }, () => f.rows[0])]) {
      await expect(decideReviewBatch(f.deps, rows, "delete", f.config)).rejects.toThrow();
    }
    f.settings.mappings[0].direction = "pull-only";
    f.rows.forEach(row => { row.direction = "pull-only"; });
    const config = reviewConfig(f.settings, "m");
    await expect(decideReviewBatch(f.deps, f.rows, "delete", config)).rejects.toThrow("Download only");
    await expect(decideReviewBatch(f.deps, f.rows, "recover", config)).resolves.toMatchObject({ persisted: true });
  });
});
