/**
 * Unit tests for the pure classifyShowError classifier (S02).
 * These do not touch the filesystem or git; they validate redaction and
 * discrimination of error kinds. An error must never be interpreted as
 * "absent" by callers.
 */
import { describe, it, expect } from "vitest";
import { classifyShowError } from "./client";

describe("classifyShowError (S02)", () => {
  it("classifies authentication failures", () => {
    const r = classifyShowError("fatal: Authentication failed for 'https://user:secret@host/repo.git/'");
    expect(r.kind).toBe("auth");
    expect(r.message).not.toMatch(/secret/);
    expect(r.message).not.toMatch(/user@/);
  });

  it("classifies missing-ref errors", () => {
    const r = classifyShowError("fatal: bad revision 'origin/nope'");
    expect(r.kind).toBe("missing-ref");
  });

  it("classifies missing-blob/path as a distinct kind", () => {
    const r = classifyShowError("fatal: pathspec 'Notes/missing.md' did not match any file(s) known to git");
    expect(r.kind).toBe("missing-blob");
  });

  it("redacts URL userinfo and auth tokens", () => {
    const raw = "fatal: could not read Username for 'https://glpat-ABC123@gitlab.com/org/repo.git': terminal prompts disabled";
    const r = classifyShowError(raw);
    expect(r.message).not.toMatch(/glpat-ABC123/);
    expect(r.message).not.toContain("glpat");
  });

  it("classifies permission and corrupt object errors distinctly", () => {
    expect(classifyShowError("fatal: unable to read tree ... Permission denied").kind).toBe("permission");
    expect(classifyShowError("error: corrupt loose object ...").kind).toBe("corrupt");
  });

  it("falls back to 'other' for unrecognized failures", () => {
    const r = classifyShowError("some random git complaint");
    expect(r.kind).toBe("other");
    expect(r.message.length).toBeGreaterThan(0);
  });
});
