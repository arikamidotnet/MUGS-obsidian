/**
 * MUGS — status reporting tests (contract §7): counts-only messages, distinct
 * terminal kinds, refused-save is an error, no note contents ever.
 */
import { describe, it, expect } from "vitest";
import { buildStatusReport, classifySkipReason } from "./statusReport";
import type { SyncOutcome } from "../sync/driver";

const ok = (id: string, push = false): SyncOutcome => ({
  mappingId: id, label: id, status: "ok",
  ...(push ? { push: true } : {}), ...(push ? {} : { pull: {} as never }),
});

describe("status reporting", () => {
  it("all-ok pass reports 'synced' with counts", () => {
    const r = buildStatusReport({ outcomes: [ok("a", true), ok("b")] });
    expect(r.kind).toBe("synced");
    expect(r.counts.publish).toBe(1);
    expect(r.counts.applied).toBe(1); // only "b" pulled ("a" pushed)
    expect(r.message).toContain("synced");
    expect(r.message).toContain("pushed 1");
  });

  it("conflicts report a distinct 'conflict' kind with file counts (no contents)", () => {
    const outcomes: SyncOutcome[] = [
      { mappingId: "a", label: "a", status: "conflict", conflicts: [{ path: "x.md", base: "SECRET BASE CONTENT", ours: "o", theirs: "t" }] },
    ];
    const r = buildStatusReport({ outcomes });
    expect(r.kind).toBe("conflict");
    expect(r.counts.conflicted).toBe(1);
    expect(r.message).not.toContain("SECRET BASE CONTENT");
    expect(r.message).toContain("1 file");
  });

  it("offline skips get their OWN kind — distinct from auth", () => {
    const outcomes: SyncOutcome[] = [
      { mappingId: "a", label: "a", status: "skipped", reason: "could not reach provider" },
    ];
    const r = buildStatusReport({ outcomes });
    expect(r.kind).toBe("offline");
    expect(r.message).toContain("unreachable");
    expect(r.message).toContain("will retry");
  });

  it("auth skips (missing token) get their OWN kind with unlock guidance", () => {
    const outcomes: SyncOutcome[] = [
      { mappingId: "a", label: "a", status: "skipped", reason: "missing token" },
    ];
    const r = buildStatusReport({ outcomes });
    expect(r.kind).toBe("auth");
    expect(r.message).toContain("unlock");
  });

  it("a refused save is an ERROR — never reported as synced", () => {
    const r = buildStatusReport({
      outcomes: [ok("a", true)],
      saveResult: { ok: false, reason: "load-error" },
    });
    expect(r.kind).toBe("error");
    expect(r.message).toContain("could not be persisted");
  });

  it("a thrown sync is an error", () => {
    const r = buildStatusReport({ outcomes: [], thrown: new Error("boom") });
    expect(r.kind).toBe("error");
    expect(r.message).toContain("boom");
  });

  it("pendingOps surface in counts", () => {
    const r = buildStatusReport({
      outcomes: [ok("a")],
      pendingOps: [{ opId: "op1", kind: "vault-write", path: "p", state: "failed", createdAt: 1, attempts: 1 }],
    });
    expect(r.counts.pending).toBe(1);
    expect(r.message).toContain("pending 1");
  });

  it("skip reasons classify conservatively", () => {
    expect(classifySkipReason("could not reach provider")).toBe("offline");
    expect(classifySkipReason("missing token")).toBe("auth");
    expect(classifySkipReason("no credential")).toBe("auth");
    expect(classifySkipReason("repo not found or not accessible")).toBe("skipped");
    expect(classifySkipReason(undefined)).toBe("skipped");
  });
});
