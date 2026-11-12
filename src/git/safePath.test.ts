/**
 * Exhaustive adversarial unit tests for src/git/safePath.ts (S05).
 * Pure tests — no FS, no git, no network. The symlink-ancestor check uses a
 * fully injected fake PathFs.
 */
import { describe, it, expect } from "vitest";
import {
  checkRelPath,
  isSafeRelPath,
  checkRootDir,
  segmentsOf,
  isInside,
  joinUnderRoot,
  checkRefName,
  checkRepoSlug,
  ensureNoSymlinkAncestors,
  type PathFs,
} from "./safePath";

const reasonOf = (p: string) => {
  const r = checkRelPath(p);
  return r.ok ? null : r.reason;
};

describe("checkRelPath — accepts legitimate mapping-relative paths", () => {
  it("accepts plain files and nested dirs", () => {
    expect(isSafeRelPath("Notes/a.md")).toBe(true);
    expect(isSafeRelPath("a/b/c/d.md")).toBe(true);
    expect(isSafeRelPath("single")).toBe(true);
    expect(isSafeRelPath(".obsidian/config.json")).toBe(true); // dotfiles allowed, dot-SEGMENTS are not
    expect(isSafeRelPath("file.name.with.dots.md")).toBe(true);
    expect(isSafeRelPath("ünïcodé.md")).toBe(true); // NFC-stable unicode ok
    expect(isSafeRelPath("repo-1_folder.v2/x.md")).toBe(true);
  });
});

describe("checkRelPath — rejects traversal and absolutes", () => {
  it("rejects every traversal shape", () => {
    expect(reasonOf("..")).toBe("traversal");
    expect(reasonOf("../x")).toBe("traversal");
    expect(reasonOf("x/..")).toBe("traversal");
    expect(reasonOf("x/../../y")).toBe("traversal");
    expect(reasonOf("a/../..")).toBe("traversal");
  });
  it("rejects absolute forms (POSIX, Windows drive, UNC)", () => {
    expect(reasonOf("/etc/passwd")).toBe("absolute");
    expect(reasonOf("/")).toBe("absolute");
    expect(reasonOf("C:\\Users\\x")).toBe("absolute");
    expect(reasonOf("C:/Users/x")).toBe("absolute");
    expect(reasonOf("c:x")).toBe("absolute");
    expect(reasonOf("\\\\server\\share")).toBe("absolute");
    expect(reasonOf("//server/share")).toBe("absolute");
  });
  it("rejects backslash smuggling", () => {
    expect(reasonOf("a\\b")).toBe("backslash");
    expect(reasonOf("dir\\..\\..\\x")).toBe("backslash");
    expect(reasonOf("..\\x")).toBe("backslash");
  });
  it("rejects dot/empty segments", () => {
    expect(reasonOf("a/./b")).toBe("dot-segment");
    expect(reasonOf("./a")).toBe("dot-segment");
    expect(reasonOf("a//b")).toBe("dot-segment");
    expect(reasonOf("a/")).toBe("dot-segment");
    expect(reasonOf(".")).toBe("dot-segment");
  });
  it("rejects NUL and control characters", () => {
    expect(reasonOf("a\0b")).toBe("nul");
    expect(reasonOf("a\u0001b")).toBe("control");
    expect(reasonOf("a\u007fb")).toBe("control");
  });
  it("rejects encoded/normalization confusables", () => {
    expect(reasonOf("a%2eb")).toBe("encoded");
    expect(reasonOf("%2e%2e/x")).toBe("encoded");
    expect(reasonOf("50%off.md")).toBe("encoded"); // any % rejected: decode-confusable
    // NFD form of é (e + combining acute) — not NFC/NFD-stable as-is
    expect(reasonOf("cafe\u0301.md")).toBe("normalization");
  });
  it("rejects windows-reserved device names (case-insensitive, with extension)", () => {
    expect(reasonOf("con")).toBe("windows-reserved");
    expect(reasonOf("CON.txt")).toBe("windows-reserved");
    expect(reasonOf("Nul.MD")).toBe("windows-reserved");
    expect(reasonOf("x/com1")).toBe("windows-reserved");
    expect(reasonOf("lpt9/x")).toBe("windows-reserved");
    expect(isSafeRelPath("const.md")).toBe(true); // not reserved
  });
  it("rejects whitespace-padded segments and empties", () => {
    expect(reasonOf("a /b")).toBe("whitespace");
    expect(reasonOf(" /a")).toBe("whitespace");
    expect(reasonOf("")).toBe("empty");
    expect(reasonOf("   ")).toBe("empty");
  });
  it("rejects over-long paths and segments", () => {
    expect(reasonOf("a".repeat(4100))).toBe("too-long");
    expect(reasonOf(`${"a".repeat(300)}/x`)).toBe("too-long");
  });
});

describe("segment-wise containment (isInside / segmentsOf / joinUnderRoot)", () => {
  it("isInside uses segments, not string prefixes", () => {
    expect(isInside("Notes", "Notes/a.md")).toBe(true);
    expect(isInside("Notes", "NotesBackup/a.md")).toBe(false); // naive prefix bug
    expect(isInside("Notes/sub", "Notes/a.md")).toBe(false);
    expect(isInside("Notes/sub", "Notes/sub/x.md")).toBe(true);
    expect(isInside("Notes", "Other/x.md")).toBe(false);
  });
  it("isInside never considers hostile targets contained", () => {
    expect(isInside("Notes", "../Notes/a.md")).toBe(false);
    expect(isInside("Notes", "/Notes/a.md")).toBe(false);
    expect(isInside("Notes", "Notes/../../x")).toBe(false);
  });
  it("joinUnderRoot joins only safe combinations", () => {
    expect(joinUnderRoot("/vault/.mugs-clones/repo", "Notes/a.md")).toEqual({ ok: true, value: "/vault/.mugs-clones/repo/Notes/a.md" });
    expect(joinUnderRoot("/repo/", "a.md").ok).toBe(true);
    const bad = joinUnderRoot("/repo", "../escape.md");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("traversal");
    expect(joinUnderRoot("/repo", "/abs.md").ok).toBe(false);
    expect(joinUnderRoot("C:\\hostile\\..", "x").ok).toBe(false); // traversal in root rejected
  });
  it("segmentsOf ignores stray slashes", () => {
    expect(segmentsOf("a/b/c")).toEqual(["a", "b", "c"]);
  });
});

describe("checkRootDir", () => {
  it("allows absolute real roots", () => {
    expect(checkRootDir("/home/u/vault/.mugs-clones/r").ok).toBe(true);
    expect(checkRootDir("relative/clone").ok).toBe(true);
  });
  it("rejects traversal, NUL, reserved names in roots", () => {
    expect(checkRootDir("/a/../b").ok).toBe(false);
    expect(checkRootDir("/a\0b").ok).toBe(false);
    expect(checkRootDir("").ok).toBe(false);
    expect(checkRootDir("/x/con").ok).toBe(false);
  });
});

describe("checkRefName (git-check-ref-format)", () => {
  it("accepts normal branch names", () => {
    for (const good of ["main", "feature/x", "release-1.2", "v1.0.0", "user/feature/thing", "pr-42"]) {
      expect(checkRefName(good).ok, good).toBe(true);
    }
  });
  it("rejects option-injection and traversal", () => {
    expect(checkRefName("--upload-pack=evil").ok).toBe(false);
    expect(checkRefName("-x").ok).toBe(false);
    expect(checkRefName("main..evil").ok).toBe(false);
  });
  it("rejects control characters and forbidden punctuation", () => {
    expect(checkRefName("a b").ok).toBe(false);
    expect(checkRefName("a~b").ok).toBe(false);
    expect(checkRefName("a^b").ok).toBe(false);
    expect(checkRefName("a:b").ok).toBe(false);
    expect(checkRefName("a?b").ok).toBe(false);
    expect(checkRefName("a*b").ok).toBe(false);
    expect(checkRefName("a[b").ok).toBe(false);
    expect(checkRefName("a\\\\b").ok).toBe(false);
    expect(checkRefName("a\0b").ok).toBe(false);
  });
  it("rejects structural violations", () => {
    expect(checkRefName("@{").ok).toBe(false);
    expect(checkRefName("@").ok).toBe(false);
    expect(checkRefName("/main").ok).toBe(false);
    expect(checkRefName("main/").ok).toBe(false);
    expect(checkRefName("a//b").ok).toBe(false);
    expect(checkRefName(".hidden").ok).toBe(false);
    expect(checkRefName("a/.hidden").ok).toBe(false);
    expect(checkRefName("a.lock").ok).toBe(false);
    expect(checkRefName("a/.lock").ok).toBe(false);
    expect(checkRefName("main.").ok).toBe(false);
  });
});

describe("checkRepoSlug", () => {
  it("accepts provider-realistic slugs", () => {
    for (const good of ["owner/repo", "acme/notes", "group/sub/project", "a-b_c.d/e-f_g.h", "O/1"]) {
      expect(checkRepoSlug(good).ok, good).toBe(true);
    }
  });
  it("rejects traversal, empties, and bad shapes", () => {
    expect(checkRepoSlug("..").ok).toBe(false);
    expect(checkRepoSlug("a/../b").ok).toBe(false);
    expect(checkRepoSlug("onlyone").ok).toBe(false); // needs owner/repo
    expect(checkRepoSlug("/leading").ok).toBe(false);
    expect(checkRepoSlug("trailing/").ok).toBe(false);
    expect(checkRepoSlug("a//b").ok).toBe(false);
    expect(checkRepoSlug("a b/c").ok).toBe(false);
    expect(checkRepoSlug("a/b%2ec").ok).toBe(false);
    expect(checkRepoSlug("owner/repo\n").ok).toBe(false);
  });
});

describe("ensureNoSymlinkAncestors (injectable FS)", () => {
  function fakeFs(entries: Record<string, { symlink?: boolean }>): PathFs & { probed: string[] } {
    const probed: string[] = [];
    return {
      probed,
      async lstat(p: string) {
        probed.push(p);
        const e = entries[p];
        if (!e) return null;
        return { isSymbolicLink: () => !!e.symlink };
      },
    };
  }

  it("passes when all ancestors are real dirs (or absent)", async () => {
    const fs = fakeFs({ "/repo": {}, "/repo/Notes": {} });
    const r = await ensureNoSymlinkAncestors("/repo", "Notes/a.md", fs);
    expect(r.ok).toBe(true);
    // probed root, root/Notes, root/Notes/a.md
    expect(fs.probed).toEqual(["/repo", "/repo/Notes", "/repo/Notes/a.md"]);
  });

  it("rejects when ANY ancestor (including root) is a symlink", async () => {
    const fs = fakeFs({ "/repo": {}, "/repo/Notes": { symlink: true } });
    const r = await ensureNoSymlinkAncestors("/repo", "Notes/a.md", fs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.at).toBe("/repo/Notes");

    const fs2 = fakeFs({ "/repo": { symlink: true } });
    const r2 = await ensureNoSymlinkAncestors("/repo", "a.md", fs2);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.at).toBe("/repo");
  });

  it("rejects when the FINAL target is a symlink", async () => {
    const fs = fakeFs({ "/repo": {}, "/repo/a.md": { symlink: true } });
    const r = await ensureNoSymlinkAncestors("/repo", "a.md", fs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.at).toBe("/repo/a.md");
  });

  it("rejects on lstat errors instead of silently proceeding", async () => {
    const fs: PathFs = {
      async lstat() {
        throw new Error("EACCES");
      },
    };
    const r = await ensureNoSymlinkAncestors("/repo", "a.md", fs);
    expect(r.ok).toBe(false);
  });

  it("rejects hostile rel paths without touching the FS", async () => {
    const fs = fakeFs({});
    const r = await ensureNoSymlinkAncestors("/repo", "../escape", fs);
    expect(r.ok).toBe(false);
    expect(fs.probed).toEqual([]); // no FS probe for invalid input
  });
});
