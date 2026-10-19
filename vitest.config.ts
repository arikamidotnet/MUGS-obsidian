import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // The `obsidian` package ships only .d.ts (no runtime JS). Point it at a
    // minimal stub so DOM-dependent modules (e.g. settingsTab) can be unit-tested.
    alias: { obsidian: path.resolve(__dirname, "src/__obsidian_stub.ts") },
  },
  test: {
    environment: "node",
    // Benchmarks use vitest's `bench()` API, which only works under
    // `vitest bench`; keep them out of the normal test run.
    include: ["src/**/*.test.ts"],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
