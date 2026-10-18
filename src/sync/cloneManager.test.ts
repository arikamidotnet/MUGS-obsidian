import { describe, it, expect } from "vitest";
import { planSync, cloneDir, resolveSyncBranch, type PlanInput } from "./cloneManager";

/** Build an ancestry oracle from explicit (ancestor -> descendant) edges. */
const oracleFrom = (edges: [string, string][]): ((anc: string, desc: string[]) => boolean) => {
  const set = new Set<string>(edges.flatMap(([a, d]) => [`${a}>${d}`]));
  return (anc, desc) => desc.some((d) => set.has(`${anc}>${d}`));
};

const baseInput = (o: Partial<PlanInput>): PlanInput => ({
  direction: "push-pull",
  base: "",
  localSha: "",
  remoteSha: "",
  isAncestor: () => false,
  localHasUnpushed: false,
  ...o,
});

describe("planSync — pull decision (reuses decideSyncAction)", () => {
  it("none when local and remote are identical", () => {
    expect(planSync(baseInput({ localSha: "X", remoteSha: "X" })).pull).toBe("none");
  });

  it("fast-forward when local is an ancestor of remote", () => {
    const d = planSync(
      baseInput({ base: "BASE", localSha: "BASE", remoteSha: "REMOTE", isAncestor: oracleFrom([["BASE", "REMOTE"]]) }),
    );
    expect(d.pull).toBe("fast-forward");
  });

  it("rebase when histories have diverged", () => {
    expect(planSync(baseInput({ localSha: "LOCAL", remoteSha: "REMOTE" })).pull).toBe("rebase");
  });
});

describe("planSync — push flag depends on direction + unpushed state", () => {
  it("pushes when push-pull has unpushed local work and nothing to pull", () => {
    const d = planSync(baseInput({ localSha: "SAME", remoteSha: "SAME", localHasUnpushed: true }));
    expect(d).toEqual({ pull: "none", push: true, needsConflictResolution: false });
  });

  it("never pushes for a pull-only mapping even with unpushed work", () => {
    const d = planSync(
      baseInput({ direction: "pull-only", localSha: "LOCAL", remoteSha: "REMOTE", localHasUnpushed: true }),
    );
    expect(d.pull).toBe("rebase");
    expect(d.push).toBe(false);
  });

  it("pushes for a push-only mapping with unpushed work", () => {
    const d = planSync(baseInput({ direction: "push-only", localSha: "SAME", remoteSha: "SAME", localHasUnpushed: true }));
    expect(d.push).toBe(true);
  });

  it("does not push when there is no unpushed work", () => {
    const d = planSync(baseInput({ direction: "push-pull", localSha: "LOCAL", remoteSha: "REMOTE", localHasUnpushed: false }));
    expect(d.push).toBe(false);
  });
});

describe("planSync — needsConflictResolution", () => {
  it("is true on a diverged pull on top of unpushed local work", () => {
    const d = planSync(
      baseInput({ direction: "push-pull", localSha: "LOCAL", remoteSha: "REMOTE", localHasUnpushed: true }),
    );
    expect(d.needsConflictResolution).toBe(true);
  });

  it("is false on a diverged pull with no unpushed work (clean rebase)", () => {
    const d = planSync(
      baseInput({ direction: "push-pull", localSha: "LOCAL", remoteSha: "REMOTE", localHasUnpushed: false }),
    );
    expect(d.needsConflictResolution).toBe(false);
  });
});

// --- cloneDir --------------------------------------------------------------

describe("cloneDir", () => {
  it("slugs provider and id into a nested path under the clone root", () => {
    expect(cloneDir({ root: ".mugs-clones" }, "github", "my/repo")).toBe(".mugs-clones/github/my_repo");
  });

  it("replaces non-slug characters with underscores", () => {
    expect(cloneDir({ root: "c" }, "git hub!", "a b")).toBe("c/git_hub_/a_b");
  });

  it("honors a custom slug function from the layout", () => {
    expect(cloneDir({ root: "c", slug: (s) => s.toUpperCase() }, "GitLab", "Proj")).toBe("c/GITLAB/PROJ");
  });
});

describe("resolveSyncBranch", () => {
  it("prefers an explicit mapping branch", () => {
    expect(resolveSyncBranch({ branch: "dev" }, { defaultBranch: "main" })).toBe("dev");
  });

  it("falls back to the repo default branch", () => {
    expect(resolveSyncBranch({}, { defaultBranch: "main" })).toBe("main");
  });

  it("falls back to HEAD when neither is known (synthesized allowed repo)", () => {
    expect(resolveSyncBranch({}, { defaultBranch: "" })).toBe("HEAD");
  });
});
