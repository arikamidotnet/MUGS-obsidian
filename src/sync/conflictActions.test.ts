import { describe, expect, it } from "vitest";
import { describeConflictActions } from "./conflictActions";

describe("describeConflictActions", () => {
  it("labels a modified side and unchanged side", () => {
    const actions = describeConflictActions({
      path: "a.md",
      base: "x\ny\nz\n",
      ours: "x\nY\nz\n",
      theirs: "x\ny\nz\n",
    });
    expect(actions.ours).toMatchObject({ side: "ours", verb: "modified", detail: "modified (added 1, removed 1)" });
    expect(actions.theirs).toMatchObject({ side: "theirs", verb: "unchanged", detail: "no change vs base" });
  });

  it("labels an added side", () => {
    const actions = describeConflictActions({
      path: "a.md",
      base: "",
      ours: "brand new\ncontent\n",
      theirs: "brand new\ncontent\n",
    });
    expect(actions.ours).toMatchObject({ verb: "added", detail: "added 2 lines" });
  });

  it("labels a deleted side via absent flag", () => {
    const actions = describeConflictActions({
      path: "gone.md",
      base: "was here\n",
      ours: "",
      theirs: "was here\n",
      oursAbsent: true,
    });
    expect(actions.ours).toMatchObject({ side: "ours", verb: "deleted", detail: "deleted the file" });
  });

  it("handles singular line counts without an 's'", () => {
    const actions = describeConflictActions({
      path: "a.md",
      base: "one\ntwo\n",
      ours: "ONE\ntwo\n",
      theirs: "one\ntwo\n",
    });
    expect(actions.ours.detail).toBe("modified (added 1, removed 1)");
  });

  it("is deterministic for the same conflict", () => {
    const c = { path: "a.md", base: "a\nb\n", ours: "a\nB\n", theirs: "a\nb\n" };
    expect(describeConflictActions(c)).toEqual(describeConflictActions(c));
  });
});
