import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./tests/e2e/users";

/**
 * Browser tests (I1-11): key flows in Arabic and English at desktop and tablet widths. Runs against
 * a throwaway database started by scripts/e2e-server.ts. `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // The dev server compiles each route on first use; a cold compile can take several seconds on a busy machine.
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: "npx tsx scripts/e2e-server.ts",
    url: `http://localhost:${E2E_PORT}/en/login`,
    reuseExistingServer: false,
    timeout: 180_000,
    // SIGTERM (not the default SIGKILL) so the server stops PostgreSQL and removes its temp dir.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
