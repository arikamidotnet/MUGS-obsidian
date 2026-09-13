import { describe, it, expect, afterEach } from "vitest";
import { setMugsContext, getMugsContext, __resetMugsContextForTests, type MugsContext } from "./dataSources";

const ctx: MugsContext = {
  map: { getRows: async () => [] },
  diff: { getDiff: async () => ({ diffText: "", authorsByFile: {} }) },
};

describe("MugsContext seam", () => {
  afterEach(() => __resetMugsContextForTests());

  it("throws before the plugin has initialized context", () => {
    __resetMugsContextForTests();
    expect(() => getMugsContext()).toThrow(/not initialized/);
  });

  it("returns exactly what was installed after setMugsContext", () => {
    setMugsContext(ctx);
    expect(getMugsContext()).toBe(ctx);
  });

  it("can be cleared so the next read throws again", () => {
    setMugsContext(ctx);
    __resetMugsContextForTests();
    expect(() => getMugsContext()).toThrow(/not initialized/);
  });
});
