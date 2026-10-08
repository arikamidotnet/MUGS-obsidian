import { describe, it, expect } from "vitest";
import { resumeKey } from "./resume";

describe("resumeKey — deterministic offline resume point", () => {
  it("combines base SHA and op id with an unambiguous separator", () => {
    expect(resumeKey({ baseSha: "abc123", opId: 4 })).toBe("abc123\u00004");
  });

  it("omits a missing op id but keeps the base SHA", () => {
    expect(resumeKey({ baseSha: "abc123" })).toBe("abc123\u0000");
  });

  it("is undefined when there is no base SHA (never synced / nothing to resume from)", () => {
    expect(resumeKey({})).toBeUndefined();
    expect(resumeKey({ opId: 1 })).toBeUndefined();
  });

  it("changes deterministically as the op id advances (same base)", () => {
    const a = resumeKey({ baseSha: "s", opId: 1 });
    const b = resumeKey({ baseSha: "s", opId: 2 });
    expect(a).not.toBe(b);
  });
});
