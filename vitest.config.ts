import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests compile JSX with the React automatic runtime, matching Next.js.
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globalSetup: ["tests/setup/global-db.ts"],
    // Each test file gets its own database cloned from a migrated template,
    // so files can run in parallel without sharing state.
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
