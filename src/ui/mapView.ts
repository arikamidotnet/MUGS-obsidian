/**
 * MUGS — Map view (`mugs-map`).
 *
 * Obsidian glue only: it asks the injected {@link MapDataSource} for rows, turns
 * them into a graph with the pure {@link buildMapGraph}, and renders that graph.
 * All logic lives in mapModel.ts (unit-tested); this file never runs under vitest
 * because it imports the Obsidian DOM API (like settingsTab.ts). It uses native
 * SVG DOM (createElementNS/setAttribute) rather than a fluent builder so it does
 * not depend on any Obsidian-only typings.
 */
import { ItemView, Notice } from "obsidian";
import { buildMapGraph, type MapContext, type MapEdge, type MapGraph, type MapNode } from "./mapModel";
import { getMugsContext } from "./dataSources";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 168;
const NODE_H = 44;
const ROW_H = 72;
const PAD_TOP = 28;
const PAD_LEFT = 24;
const LEFT_X = 96; // folder node center x
const RIGHT_X = 360; // repo node center x

/** Direction glyph shown on the edge between the two nodes. */
const DIRECTION_GLYPH: Record<string, string> = {
  "push-pull": "⇄",
  "pull-only": "↓",
  "push-only": "↑",
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Create an SVG child element (namespaced) and append it to `parent`. */
function svgChild(parent: Node, tag: string): Element {
  const el = document.createElementNS(SVG_NS, tag);
  parent.appendChild(el);
  return el;
}

function setAttrs(el: Element, attrs: Record<string, string | number>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
}

export class MapView extends ItemView {
  getViewType(): string {
    return "mugs-map";
  }

  getDisplayText(): string {
    return "MUGS Map";
  }

  getIcon(): string {
    return "map";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("mugs-maps-view");
    this.addAction("refresh", "Refresh map", () => void this.refresh());
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await getMugsContext().map.getRows();
      const context: Record<string, MapContext> = {};
      for (const r of rows) context[r.mapping.id] = { owner: r.owner, status: r.status };
      const graph = buildMapGraph(rows.map((r) => r.mapping), context);
      this.render(graph, rows.length);
    } catch (err) {
      this.contentEl.empty();
      new Notice(`MUGS: could not load map — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private render(graph: MapGraph, rowCount: number): void {
    this.renderLegend();

    if (rowCount === 0) {
      this.contentEl.createEl("p", { text: "No folder mappings yet. Add one in the MUGS settings." });
      return;
    }

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const svg = this.contentEl.createSvg("svg");
    svg.addClass("mugs-map-svg");
    svg.setAttribute("height", String(PAD_TOP * 2 + graph.edges.length * ROW_H));

    for (let i = 0; i < graph.edges.length; i++) {
      this.renderLane(svg, graph.edges[i], byId, i);
    }
  }

  private renderLane(svg: SVGElement, edge: MapEdge, byId: Map<string, MapNode>, index: number): void {
    const folder = byId.get(edge.from);
    const repo = byId.get(edge.to);
    if (!folder || !repo) return;

    const y = PAD_TOP + index * ROW_H;
    const accent = edge.status === "conflict" ? "#e45b3d" : edge.status === "error" ? "#f85149" : "#58a6ff";

    // Connecting edge (colored by status) with a direction glyph.
    setAttrs(svgChild(svg, "line"), {
      x1: String(PAD_LEFT + NODE_W / 2 + 8),
      y1: String(y + NODE_H / 2),
      x2: String(RIGHT_X + NODE_W / 2),
      y2: String(y + NODE_H / 2),
      stroke: accent,
      "stroke-width": "2",
    });

    const glyph = svgChild(svg, "text");
    setAttrs(glyph, {
      x: String((LEFT_X + RIGHT_X) / 2),
      y: String(y + NODE_H / 2 - 4),
      "text-anchor": "middle",
      "font-size": "16",
      fill: "#8b949e",
    });
    glyph.textContent = DIRECTION_GLYPH[edge.direction] ?? "↔";

    this.renderNode(svg, folder, LEFT_X, y, accent);
    this.renderNode(svg, repo, RIGHT_X, y, accent);
  }

  private renderNode(svg: SVGElement, node: MapNode, centerX: number, y: number, accent: string): void {
    const x = centerX - NODE_W / 2;
    setAttrs(svgChild(svg, "rect"), {
      x: String(x),
      y: String(y),
      width: String(NODE_W),
      height: String(NODE_H),
      rx: "8",
      fill: "#161b22",
      stroke: node.kind === "repo" ? accent : "#30363d",
      "stroke-width": "1.5",
    });

    const title = svgChild(svg, "text");
    setAttrs(title, {
      x: String(centerX),
      y: String(y + 18),
      "text-anchor": "middle",
      "font-weight": "600",
      fill: "#e6edf3",
    });
    title.textContent = truncate(node.label, 20);

    const detail = node.owner ? `${node.owner} · ${truncate(node.detail, 18)}` : truncate(node.detail, 24);
    const sub = svgChild(svg, "text");
    setAttrs(sub, {
      x: String(centerX),
      y: String(y + 35),
      "text-anchor": "middle",
      "font-size": "11",
      fill: node.owner ? "#8b949e" : "#6e7681",
    });
    sub.textContent = truncate(detail, 26);
  }

  private renderLegend(): void {
    const legend = this.contentEl.createDiv({ cls: "mugs-map-legend" });
    legend.createEl("span", { text: "Status:", cls: "mugs-map-legend-label" });
    for (const [status, label] of [
      ["ok", "In sync"],
      ["pending", "Pending"],
      ["conflict", "Conflict"],
      ["error", "Error"],
    ] as const) {
      const chip = legend.createDiv({ cls: "mugs-map-legend-item" });
      chip.createSpan({ cls: "mugs-map-legend-swatch", attr: { style: `background:${statusColor(status)}` } });
      chip.createSpan({ text: label });
    }
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "conflict":
      return "#e45b3d";
    case "error":
      return "#f85149";
    case "pending":
      return "#d29922";
    default:
      return "#3fb950";
  }
}
