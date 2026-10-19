import { describe, it, expect } from "vitest";
import { formatCommitMessage, type CommitMeta } from "./commit-message";
import { onBehalfOfTrailer, authorString, authorRefForAgent } from "./attribution";
import type { Agent } from "../types";

const meta = (over: Partial<CommitMeta> = {}): CommitMeta => ({ op: "push", ...over });

describe("formatCommitMessage — subject", () => {
  it("bare op with no extras", () => {
    expect(formatCommitMessage(meta({ op: "push" }))).toBe("mugs push");
  });

  it("includes the mapping label in parentheses", () => {
    expect(formatCommitMessage(meta({ op: "pull", label: "Notes" }))).toBe("mugs pull (Notes)");
  });

  it("appends the remote path after the label", () => {
    expect(formatCommitMessage(meta({ op: "rebase", label: "Docs", remotePath: "docs" }))).toBe("mugs rebase (Docs) docs\n\nRemote path: docs");
  });

  it("includes remote path without a label", () => {
    expect(formatCommitMessage(meta({ op: "push", remotePath: "src" }))).toBe("mugs push src\n\nRemote path: src");
  });

  it("is deterministic for identical input", () => {
    const m = meta({ op: "pull", label: "Notes", remotePath: "notes" });
    expect(formatCommitMessage(m)).toBe(formatCommitMessage({ ...m }));
  });
});

describe("formatCommitMessage — body", () => {
  it("omits the body when no remote path or author is given", () => {
    expect(formatCommitMessage(meta({ op: "push" }))).not.toContain("\n");
  });

  it("adds a Remote path line for remotePath", () => {
    const msg = formatCommitMessage(meta({ op: "pull", remotePath: "docs" }));
    expect(msg).toBe("mugs pull docs\n\nRemote path: docs");
  });

  it("adds an Author line when author is given", () => {
    const msg = formatCommitMessage(meta({ op: "push", author: "Ada <ada@example.com>" }));
    expect(msg).toContain("\n\nAuthor: Ada <ada@example.com>");
  });

  it("orders Remote path before Author", () => {
    const msg = formatCommitMessage(meta({ op: "rebase", remotePath: "docs", author: "Ada" }));
    const body = msg.split("\n\n")[1];
    expect(body.indexOf("Remote path: docs")).toBeLessThan(body.indexOf("Author: Ada"));
  });
});

describe("formatCommitMessage — on-behalf-of trailer", () => {
  it("appends the trailer when ownerHuman is present", () => {
    const msg = formatCommitMessage(meta({ op: "push", ownerHuman: "Grace" }));
    expect(msg).toBe("mugs push\n\nOn-behalf-of: Grace");
  });

  it("trims surrounding whitespace on the owner", () => {
    const msg = formatCommitMessage(meta({ op: "push", ownerHuman: "  Grace Hopper  " }));
    expect(msg).toContain("\n\nOn-behalf-of: Grace Hopper");
    expect(msg.endsWith("On-behalf-of: Grace Hopper")).toBe(true);
  });

  it("omits the trailer when ownerHuman is empty or whitespace", () => {
    expect(formatCommitMessage(meta({ op: "push", ownerHuman: "" }))).toBe("mugs push");
    expect(formatCommitMessage(meta({ op: "push", ownerHuman: "   " }))).toBe("mugs push");
  });

  it("places the trailer after the body when both exist", () => {
    const msg = formatCommitMessage(meta({ op: "pull", remotePath: "docs", ownerHuman: "Grace" }));
    expect(msg).toBe("mugs pull docs\n\nRemote path: docs\n\nOn-behalf-of: Grace");
  });
});

describe("attribution helpers (used by commit-message)", () => {
  const agent: Agent = { id: "a1", displayName: "Ada Agent", ownerHuman: "Grace" };

  it("onBehalfOfTrailer returns empty string with no owner", () => {
    expect(onBehalfOfTrailer()).toBe("");
    expect(onBehalfOfTrailer("")).toBe("");
  });

  it("authorString omits the email bracket when there is no email", () => {
    const noEmail: Agent = { ...agent, committerEmail: undefined };
    expect(authorString(noEmail)).toBe("Ada Agent");
  });

  it("authorString includes Name <email> when an email is set", () => {
    const withEmail: Agent = { ...agent, committerEmail: "ada@example.com" };
    expect(authorString(withEmail)).toBe("Ada Agent <ada@example.com>");
  });

  it("authorString defaults the name to displayName when committerName is unset", () => {
    const noName: Agent = { ...agent, committerName: undefined };
    expect(authorString(noName)).toBe("Ada Agent");
  });

  it("authorRefForAgent pins kind=agent and carries the owner", () => {
    const ref = authorRefForAgent(agent);
    expect(ref.kind).toBe("agent");
    expect(ref.agentId).toBe("a1");
    expect(ref.ownerHuman).toBe("Grace");
    expect(ref.name).toBe("Ada Agent");
  });
});
