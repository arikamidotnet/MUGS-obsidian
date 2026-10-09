/**
 * MUGS — agent MCP server contract (pure).
 *
 * Defines the tool surface an agent sub-user calls over the Model Context Protocol and
 * the resolution helpers the transport dispatches against. There is NO network/IO here:
 * `main.ts` hosts a real transport that reads {@link listAgentTools} to advertise the
 * tools and routes each call through {@link resolveAgent} / {@link agentAuthorFor}. This
 * keeps the contract unit-testable without a running server.
 */
import type { Agent } from "../types";
import { authorRefForAgent } from "../sync/attribution";

/** Name advertised to MCP clients as the MUGS agents server. */
export const MCP_SERVER_NAME = "mugs-agents";

/** A minimal MCP tool descriptor (name + human description + JSON-schema input). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools exposed to agent sub-users over MCP. */
export function listAgentTools(): McpTool[] {
  return [
    {
      name: "mugs.list_agents",
      description: "List the registered agent sub-users for this vault.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mugs.register_agent",
      description: "Register or update an agent sub-user identity (name, owner, committer).",
      inputSchema: {
        type: "object",
        required: ["id", "displayName"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string" },
          ownerHuman: { type: "string" },
          committerName: { type: "string" },
          committerEmail: { type: "string" },
          mcpEndpoint: { type: "string", format: "uri" },
        },
      },
    },
    {
      name: "mugs.create_worktree",
      description: "Create an isolated worktree + branch for this agent.",
      inputSchema: {
        type: "object",
        required: ["agentId"],
        properties: { agentId: { type: "string" } },
      },
    },
  ];
}

/** Resolve a registered agent by id (returns undefined when unknown). */
export function resolveAgent(agents: Agent[], agentId: string): Agent | undefined {
  return agents.find((a) => a.id === agentId);
}

/** The {@link AuthorRef} an agent will be attributed as when it pushes. */
export function agentAuthorFor(agent: Agent) {
  return authorRefForAgent(agent);
}

/** True when the given MCP tool name is one MUGS exposes to agents. */
export function isMugsTool(name: string): boolean {
  return listAgentTools().some((t) => t.name === name);
}
