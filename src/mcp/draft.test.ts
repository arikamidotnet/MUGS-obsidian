import { describe, it, expect } from "vitest";
import type { Agent } from "../types";
import { formatDraftMessage, draftAuthor, draftTargetsAgent, type CommitDraft } from "./draft";

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "agent-1",
  displayName: "Research Bot",
  committerEmail: "bot@local",
  ...over,
});

const draft = (over: Partial<CommitDraft> = {}): CommitDraft => ({
  agentId: "agent-1",
  subject: "Summarize today's notes",
  ...over,
});

describe("formatDraftMessage — on-behalf-of composition", () => {
  it("emits just the subject for a bare agent (no owner)", () => {
    expect(formatDraftMessage(draft(), agent())).toBe("Summarize today's notes");
  });

  it("appends the on-behalf-of trailer when the agent has an owner", () => {
    expect(formatDraftMessage(draft(), agent({ ownerHuman: "Ada" }))).toBe(
      "Summarize today's notes\n\nOn-behalf-of: Ada",
    );
  });

  it("places a non-empty body between subject and trailer, trimmed", () => {
    const msg = formatDraftMessage(draft({ body: "  details here  " }), agent({ ownerHuman: "Ada" }));
    expect(msg).toBe("Summarize today's notes\n\ndetails here\n\nOn-behalf-of: Ada");
  });

  it("ignores a blank/whitespace body", () => {
    expect(formatDraftMessage(draft({ body: "   " }), agent())).toBe("Summarize today's notes");
  });
});

describe("draftAuthor — recorded author identity", () => {
  it("includes the committer email when present", () => {
    expect(draftAuthor(draft(), agent())).toEqual({ name: "Research Bot", email: "bot@local" });
  });

  it("drops the email when the agent has no committer email", () => {
    expect(draftAuthor(draft(), agent({ committerEmail: undefined }))).toEqual({ name: "Research Bot" });
  });
});

describe("draftTargetsAgent — acting-agent match", () => {
  it("matches only the named agent id", () => {
    expect(draftTargetsAgent(draft(), "agent-1")).toBe(true);
    expect(draftTargetsAgent(draft({ agentId: "other" }), "agent-1")).toBe(false);
  });
});
