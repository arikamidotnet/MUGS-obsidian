import { defineConfig } from "vitest/config";

export default defineConfig({
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
