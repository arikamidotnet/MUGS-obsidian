import { describe, it, expect } from "vitest";
import type { Agent } from "../types";
import {
  MCP_SERVER_NAME,
  listAgentTools,
  resolveAgent,
  agentAuthorFor,
  isMugsTool,
} from "./server";

const agents = (): Agent[] => [
  { id: "agent-1", displayName: "Research Bot", ownerHuman: "Ada" },
  { id: "agent-2", displayName: "Indexing Bot" },
];

describe("MCP server contract", () => {
  it("advertises a stable, non-empty tool set under the MUGS agents name", () => {
    expect(MCP_SERVER_NAME).toBe("mugs-agents");
    const tools = listAgentTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("names the expected agent-facing tools", () => {
    const names = listAgentTools().map((t) => t.name);
    for (const n of ["mugs.list_agents", "mugs.register_agent", "mugs.create_worktree"]) {
      expect(names).toContain(n);
    }
  });

  it("flags only MUGS tools as such", () => {
    expect(isMugsTool("mugs.list_agents")).toBe(true);
    expect(isMugsTool("core.read")).toBe(false);
  });
});

describe("resolveAgent — registry lookup", () => {
  it("returns the matching agent by id", () => {
    expect(resolveAgent(agents(), "agent-2")?.displayName).toBe("Indexing Bot");
  });

  it("returns undefined for an unknown id", () => {
    expect(resolveAgent(agents(), "nope")).toBeUndefined();
  });
});

describe("agentAuthorFor — push attribution identity", () => {
  it("pins kind to agent and carries the owner", () => {
    const ref = agentAuthorFor({ id: "a", displayName: "Bot", ownerHuman: "Ada" });
    expect(ref).toMatchObject({ kind: "agent", agentId: "a", ownerHuman: "Ada" });
  });
});
