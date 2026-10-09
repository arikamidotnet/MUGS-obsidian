import { describe, it, expect } from "vitest";
import type { Agent } from "../types";
import { authorRefForAgent, authorString, onBehalfOfTrailer } from "./attribution";

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "agent-1",
  displayName: "Research Bot",
  ...over,
});

describe("authorRefForAgent — agent AuthorRef", () => {
  it("pins kind to agent and carries the owner for remote attribution", () => {
    const ref = authorRefForAgent(agent({ ownerHuman: "Ada" }));
    expect(ref).toMatchObject({ kind: "agent", agentId: "agent-1", ownerHuman: "Ada" });
  });

  it("defaults the committer name to the display name when unset", () => {
    const ref = authorRefForAgent(agent());
    expect(ref.name).toBe("Research Bot");
    expect(ref.email).toBeUndefined();
  });

  it("honors a custom committer identity", () => {
    const ref = authorRefForAgent(agent({ committerName: "Custom", committerEmail: "c@x.io" }));
    expect(ref.name).toBe("Custom");
    expect(ref.email).toBe("c@x.io");
  });
});

describe("authorString — git --author form", () => {
  it("wraps the email when present", () => {
    expect(authorString(agent({ committerEmail: "a@b.io" }))).toBe("Research Bot <a@b.io>");
  });

  it("omits angle brackets when there is no email", () => {
    expect(authorString(agent())).toBe("Research Bot");
  });
});

describe("onBehalfOfTrailer — on-behalf-of suffix", () => {
  it("returns empty for a bare agent (no owner)", () => {
    expect(onBehalfOfTrailer()).toBe("");
    expect(onBehalfOfTrailer("")).toBe("");
  });

  it("appends the trailer with the owner name, trimmed", () => {
    expect(onBehalfOfTrailer("  Ada Lovelace ")).toBe("\n\nOn-behalf-of: Ada Lovelace");
  });
});
