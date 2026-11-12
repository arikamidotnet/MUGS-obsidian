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
    // Quarantined: __live_diag.test.ts targets the live company vault (real writes/pushes).
    // It is NEVER executed under default `npm test`. Run explicitly with MUGS_LIVE_DIAG=1.
    exclude: ["src/sync/__live_diag.test.ts"],
    // reporters left at default (which surfaces skipped tests in the summary).
    // A minimal explicit default here improves skip visibility in CI logs without
    // changing behavior or test files (qa-release owns skip annotations).
    reporters: ["default"],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
