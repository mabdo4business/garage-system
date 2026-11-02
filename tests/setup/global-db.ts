import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { bootstrapDatabase, withCredentials } from "../../src/server/db/bootstrap";
import { runMigrations } from "../../src/server/db/migrate";

/**
 * Starts one PostgreSQL for the whole test run and builds a migrated template database.
 * Each test file clones the template (tests/helpers/db.ts), so files run in parallel without
 * sharing state.
 *
 *  - Default: embedded PostgreSQL in a child process (no Docker needed); see embedded-pg.mjs.
 *  - TEST_DATABASE_ADMIN_URL set: use that server instead (e.g. Docker on your Mac). It must be
 *    a superuser connection; the run creates and drops databases prefixed garage_t_.
 */

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
    pgOwnerPassword: string;
    pgAppPassword: string;
  }
}

const OWNER_PASSWORD = "test_owner_password";
const APP_PASSWORD = "test_app_password";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
    });
  });
}

async function startEmbedded(dataDir: string, port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "tests", "setup", "embedded-pg.mjs"), dataDir, String(port)],
    {
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (line.includes('"ready":true')) resolve();
    });
    child.once("exit", (code) => reject(new Error(`Embedded PostgreSQL exited early with code ${code}`)));
  });
  return child;
}

export default async function setup(project: TestProject) {
  let child: ChildProcess | undefined;
  let dataDir: string | undefined;
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;

  if (!adminUrl) {
    dataDir = mkdtempSync(join(tmpdir(), "garage-test-pg-"));
    const port = await freePort();
    child = await startEmbedded(dataDir, port);
    adminUrl = `postgres://postgres:postgres@localhost:${port}/postgres`;
  }

  const template = `garage_t_template_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${template}`);
  await admin.end();

  const adminUser = new URL(adminUrl).username;
  const adminPassword = decodeURIComponent(new URL(adminUrl).password);
  await bootstrapDatabase({
    adminUrl: withCredentials(adminUrl, adminUser, adminPassword, template),
    database: template,
    ownerPassword: OWNER_PASSWORD,
    appPassword: APP_PASSWORD,
  });
  await runMigrations(withCredentials(adminUrl, "garage_owner", OWNER_PASSWORD, template));

  project.provide("pgAdminUrl", adminUrl);
  project.provide("pgTemplate", template);
  project.provide("pgOwnerPassword", OWNER_PASSWORD);
  project.provide("pgAppPassword", APP_PASSWORD);

  return async () => {
    const cleanup = new pg.Client({ connectionString: adminUrl });
    await cleanup.connect();
    const { rows } = await cleanup.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'garage\\_t\\_%'",
    );
    for (const { datname } of rows) {
      await cleanup.query(`DROP DATABASE IF EXISTS ${cleanup.escapeIdentifier(datname)} WITH (FORCE)`);
    }
    await cleanup.end();
    if (child) {
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child.stdin?.end();
      await exited;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  };
}
