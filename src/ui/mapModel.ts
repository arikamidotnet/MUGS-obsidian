/**
 * MUGS — mapping graph model (pure).
 *
 * Turns the persisted folder→repo mappings into a node/edge graph for the Map
 * view (`mugs-map`). This module has NO Obsidian or git imports so it stays
 * unit-testable in isolation; the view only renders what this produces.
 *
 * Each mapping yields exactly two nodes — one vault-folder node and one remote
 * (repo) node — joined by a single edge carrying the destination repo/branch/
 * path, the sync direction, and the last-known sync status. `context` supplies
 * optional per-mapping owner (a recent git author) and status overrides so the
 * runtime can enrich the graph without this module touching git itself.
 */
import type { FolderMapping, SyncDirection, SyncStatus } from "../types";

/** A node in the mapping graph: either a vault folder or a remote repo. */
export interface MapNode {
  /** Stable id: `folder:<mappingId>` or `repo:<mappingId>`. */
  id: string;
  kind: "folder" | "repo";
  /** Human-readable label (folder path, or mapping/remote label). */
  label: string;
  /** Secondary detail shown under the label (branch/path or folder). */
  detail: string;
  /** Owning user (recent git author) when known. */
  owner?: string;
  /** Hex color used by the view for this node. */
  color: string;
}

/** An edge joining a folder node to its remote repo node. */
export interface MapEdge {
  /** Stable id: `edge:<mappingId>`. */
  id: string;
  mappingId: string;
  from: string; // folder node id
  to: string; // repo node id
  direction: SyncDirection;
  branch?: string;
  /** Remote path ("" means the whole repository). */
  remotePath: string;
  status: SyncStatus;
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

/** Optional per-mapping enrichment supplied by the runtime. */
export interface MapContext {
  /** Owning user (recent git author) for this mapping, if known. */
  owner?: string;
  /** Last-known sync status for this mapping. */
  status?: SyncStatus;
}

/** Status-driven colors — take precedence over direction colors. */
const STATUS_COLOR: Record<SyncStatus, string> = {
  ok: "#3fb950", // green
  "up-to-date": "#3fb950",
  pending: "#d29922", // amber
  conflict: "#e45b3d", // red
  error: "#f85149", // pink-red
};

/** Direction-driven colors (used only when status is unknown). */
const DIRECTION_COLOR: Record<SyncDirection, string> = {
  "push-pull": "#58a6ff", // blue
  "pull-only": "#7c3aed", // purple
  "push-only": "#f0883e", // orange
};

function colorFor(status: SyncStatus | undefined, direction: SyncDirection): string {
  return status ? (STATUS_COLOR[status] ?? DIRECTION_COLOR[direction]) : DIRECTION_COLOR[direction];
}

/**
 * Build the mapping graph. `context` maps a mapping id to optional owner/status
 * overrides; unknown ids are treated as no override. Output is deterministic:
 * nodes sorted by kind then label, edges in mapping order.
 */
export function buildMapGraph(
  mappings: FolderMapping[],
  context: Record<string, MapContext> = {},
): MapGraph {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];

  for (const m of mappings) {
    const ctx = context[m.id] ?? {};
    const status = ctx.status ?? "pending";
    const folderId = `folder:${m.id}`;
    const repoId = `repo:${m.id}`;

    nodes.push({
      id: folderId,
      kind: "folder",
      label: m.localFolder || "(vault root)",
      detail: m.label || m.id,
      owner: ctx.owner,
      color: "#58a6ff",
    });

    nodes.push({
      id: repoId,
      kind: "repo",
      label: m.label || m.id,
      detail: `${m.remotePath || "whole repository"} @ ${m.branch ?? "HEAD"}`,
      owner: ctx.owner,
      color: colorFor(status, m.direction),
    });

    edges.push({
      id: `edge:${m.id}`,
      mappingId: m.id,
      from: folderId,
      to: repoId,
      direction: m.direction,
      branch: m.branch,
      remotePath: m.remotePath,
      status,
    });
  }

  nodes.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  return { nodes, edges };
}
