import { describe, it, expect } from "vitest";
import type { FolderMapping } from "../types";
import { buildMapGraph, describeMapRow, directionHint, type MapContext } from "./mapModel";

function mapping(over: Partial<FolderMapping>): FolderMapping {
  return {
    id: "m1",
    label: "Notes",
    remotePath: "",
    localFolder: "notes",
    providerId: "p1",
    direction: "push-pull",
    ...over,
  };
}

describe("buildMapGraph — nodes", () => {
  it("emits one folder node and one repo node per mapping with stable ids", () => {
    const { nodes } = buildMapGraph([mapping({ id: "m1" })]);
    expect(nodes).toHaveLength(2);

    const folder = nodes.find((n) => n.id === "folder:m1")!;
    expect(folder.kind).toBe("folder");
    expect(folder.label).toBe("notes");
    expect(folder.detail).toBe("Notes");

    const repo = nodes.find((n) => n.id === "repo:m1")!;
    expect(repo.kind).toBe("repo");
    expect(repo.label).toBe("Notes");
    expect(repo.detail).toBe("whole repository @ HEAD");
  });

  it("renders branch and remotePath in the repo node detail", () => {
    const { nodes } = buildMapGraph([mapping({ remotePath: "docs", branch: "main" })]);
    const repo = nodes.find((n) => n.kind === "repo")!;
    expect(repo.detail).toBe("docs @ main");
  });

  it("defaults the folder label when localFolder is empty", () => {
    const { nodes } = buildMapGraph([mapping({ localFolder: "" })]);
    expect(nodes.find((n) => n.kind === "folder")?.label).toBe("(vault root)");
  });

  it("carries owner and status-derived color through to the graph", () => {
    const ctx: Record<string, MapContext> = {
      m1: { owner: "ada", status: "conflict" },
    };
    const { nodes, edges } = buildMapGraph([mapping({ id: "m1" })], ctx);

    for (const n of nodes) expect(n.owner).toBe("ada");
    // conflict color wins over the push-pull direction color.
    expect(nodes.find((n) => n.kind === "repo")?.color).toBe("#e45b3d");
    expect(edges[0].status).toBe("conflict");
  });
});

describe("buildMapGraph — edges", () => {
  it("joins the folder node to the repo node with direction and status", () => {
    const { edges } = buildMapGraph([mapping({ id: "m1", direction: "pull-only" })]);
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.from).toBe("folder:m1");
    expect(e.to).toBe("repo:m1");
    expect(e.direction).toBe("pull-only");
    expect(e.status).toBe("pending"); // no context override -> pending default
  });

  it("defaults status to pending when the mapping has no last-sync state", () => {
    const { edges } = buildMapGraph([mapping({ id: "m1" })]);
    expect(edges[0].status).toBe("pending");
  });
});

describe("describeMapRow — honest status vocabulary", () => {
  it("maps ok/up-to-date to \"in sync\" regardless of direction", () => {
    for (const status of ["ok", "up-to-date"] as const) {
      expect(describeMapRow({ status, direction: "push-pull" }).label).toBe("in sync");
    }
  });

  it("says a conflict mapping \"needs review\" with the file count in the hover reason", () => {
    const d = describeMapRow({ status: "conflict", direction: "push-pull", conflictCount: 2 });
    expect(d.label).toBe("needs review");
    expect(d.tone).toBe("error");
    expect(d.reason).toContain("2 files need your review");
  });

  it("a conflict mapping without a count still points at the Conflicts", () => {
    const d = describeMapRow({ status: "conflict", direction: "push-pull" });
    expect(d.reason).toContain("Conflicts");
  });

  it("renders an error mapping as \"failed\" with a retry hint", () => {
    const d = describeMapRow({ status: "error", direction: "push-pull" });
    expect(d.label).toBe("failed");
    expect(d.reason).toContain("last sync failed");
  });

  it("a skip reason wins over the recorded status — \"skipped\" with the reason on hover", () => {
    // A mapping whose credential was deleted still says "ok" in lastSync; the row
    // must not pretend sync is running fine when it can never run at all.
    const d = describeMapRow({ status: "ok", direction: "push-pull", skipReason: "no credential" });
    expect(d.label).toBe("skipped");
    expect(d.reason).toBe("no credential");
    expect(d.tone).toBe("warning");
  });

  it("an unknown/pending status reads as \"pending\" with a sync hint", () => {
    const d = describeMapRow({ status: "pending", direction: "push-pull" });
    expect(d.label).toBe("pending");
    expect(d.reason).toContain("not synced yet");
  });

  it("an in-sync push-only mapping carries the never-pulls hint", () => {
    const d = describeMapRow({ status: "ok", direction: "push-only" });
    expect(d.label).toBe("in sync");
    expect(d.reason).toContain("never downloaded");
    expect(describeMapRow({ status: "ok", direction: "pull-only" }).reason).toBeUndefined();
  });
});

describe("directionHint — what the arrow does NOT do", () => {
  it("push-only says remote changes are never downloaded", () => {
    expect(directionHint("push-only")).toContain("never downloaded");
  });

  it("pull-only says local changes are never uploaded", () => {
    expect(directionHint("pull-only")).toContain("never uploaded");
  });

  it("push-pull says Both ways", () => {
    expect(directionHint("push-pull")).toContain("Both ways");
  });
});

describe("buildMapGraph — determinism & ordering", () => {
  it("sorts nodes by kind then label and keeps edges in mapping order", () => {
    const { nodes, edges } = buildMapGraph([
      mapping({ id: "b", localFolder: "zzz", label: "Beta" }),
      mapping({ id: "a", localFolder: "aaa", label: "Alpha" }),
    ]);

    // repo nodes (r) sort before folder nodes? kind compare: "folder" < "repo".
    const kinds = nodes.map((n) => n.kind);
    expect(kinds).toEqual([...kinds].sort());

    const folderOrder = nodes.filter((n) => n.kind === "folder").map((n) => n.label);
    expect(folderOrder).toEqual(["aaa", "zzz"]); // sorted by label
    expect(edges.map((e) => e.mappingId)).toEqual(["b", "a"]); // input order preserved
  });

  it("is deterministic for identical input", () => {
    const a = buildMapGraph([mapping({ id: "m1" })]);
    const b = buildMapGraph([mapping({ id: "m1" })]);
    expect(a).toEqual(b);
  });

  it("returns an empty graph for no mappings", () => {
    expect(buildMapGraph([])).toEqual({ nodes: [], edges: [] });
  });
});
