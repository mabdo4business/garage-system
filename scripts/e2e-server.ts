import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createUser } from "../src/server/auth/service";
import { bootstrapDatabase, withCredentials } from "../src/server/db/bootstrap";
import { createDb } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrate";
import { E2E_PASSWORD, E2E_PORT, E2E_USERS } from "../tests/e2e/users";

/**
 * Browser-test server (Playwright webServer): a throwaway embedded PostgreSQL in a temp dir, fully
 * migrated, with one user per test role, and the Next.js app on E2E_PORT pointed at it.
 *
 * Never touches .data/. This script reads no .env file itself; `next dev` still loads the
 * project's .env files as usual, but DATABASE_URL is always overridden with the throwaway
 * database, so the tests never reach the development data. Everything is removed on exit.
 */
const dbPort = 54339;
const superPassword = "e2e_super";
const ownerPassword = "e2e_owner";
const appPassword = "e2e_app";
const database = "garage_e2e";

// Per-checkout prefix: a leftover sweep never touches another checkout's live run.
const prefix = `garage-e2e-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8)}-`;
for (const name of readdirSync(tmpdir())) {
  if (name.startsWith(prefix)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}
const databaseDir = mkdtempSync(join(tmpdir(), prefix));

const server = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: superPassword,
  port: dbPort,
  persistent: false,
  onLog: () => {},
});

let next: ChildProcess | undefined;
let shutdown: Promise<void> | undefined;

/**
 * Playwright's SIGTERM reaches both this script and `next dev`, so stop() is entered twice (signal
 * and child exit). Every caller waits for the one shutdown before exiting.
 */
async function stop(code: number): Promise<never> {
  shutdown ??= (async () => {
    if (next && next.exitCode === null && next.signalCode === null) {
      const exited = new Promise((resolve) => next!.once("exit", resolve));
      next.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
      if (next.exitCode === null && next.signalCode === null) next.kill("SIGKILL");
    }
    await server.stop().catch(() => {});
    rmSync(databaseDir, { recursive: true, force: true });
  })();
  await shutdown;
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  await server.initialise();
  await server.start();

  const adminUrl = `postgres://postgres:${superPassword}@localhost:${dbPort}/postgres`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();

  await bootstrapDatabase({
    adminUrl: withCredentials(adminUrl, "postgres", superPassword, database),
    database,
    ownerPassword,
    appPassword,
  });
  await runMigrations(withCredentials(adminUrl, "garage_owner", ownerPassword, database));

  const appUrl = withCredentials(adminUrl, "garage_app", appPassword, database);
  const db = createDb({ connectionString: appUrl, maxConnections: 2 });
  for (const user of Object.values(E2E_USERS)) {
    await createUser(
      db,
      { kind: "system", name: "e2e-setup" },
      { username: user.username, displayName: user.displayName, password: E2E_PASSWORD, roles: [user.role] },
    );
  }
  await db.destroy();

  // The next binary directly (not through npx), so SIGTERM reaches the dev server itself.
  next = spawn(join("node_modules", ".bin", "next"), ["dev", "-p", String(E2E_PORT)], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: appUrl, NODE_ENV: "development", NEXT_DIST_DIR: ".next-e2e" },
  });
  next.on("exit", (code) => void stop(code ?? 0));
} catch (error) {
  console.error("e2e server setup failed:", error);
  await stop(1);
}
