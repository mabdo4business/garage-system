import { join } from "node:path";
import { existsSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { bootstrapDatabase, withCredentials } from "../src/server/db/bootstrap";
import { runMigrations } from "../src/server/db/migrate";
import { loadEnv } from "./env";

/**
 * Local development database: an embedded PostgreSQL kept in .data/pg (git-ignored).
 * Development only. Prints the connection URLs to put in .env, then runs until Ctrl-C.
 */
loadEnv();
if (process.env.NODE_ENV === "production") {
  console.error("db:dev is for development only");
  process.exit(1);
}

const port = 54329;
const superPassword = process.env.DEV_DB_SUPERUSER_PASSWORD ?? "postgres";
const ownerPassword = process.env.DB_OWNER_PASSWORD ?? "dev_owner_password";
const appPassword = process.env.DB_APP_PASSWORD ?? "dev_app_password";
const databaseDir = join(process.cwd(), ".data", "pg");
const database = "garage";

const server = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password: superPassword,
  port,
  persistent: true,
  onLog: () => {},
});
if (!existsSync(join(databaseDir, "PG_VERSION"))) {
  await server.initialise();
}
await server.start();

const adminUrl = `postgres://postgres:${encodeURIComponent(superPassword)}@localhost:${port}/postgres`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${database}`);
await admin.end();

await bootstrapDatabase({
  adminUrl: withCredentials(adminUrl, "postgres", superPassword, database),
  database,
  ownerPassword,
  appPassword,
});
const ownerUrl = withCredentials(adminUrl, "garage_owner", ownerPassword, database);
const result = await runMigrations(ownerUrl);

console.log(`Development PostgreSQL running on port ${port}. Migrations applied: ${result.applied.length}`);
console.log(`DATABASE_URL=${withCredentials(adminUrl, "garage_app", appPassword, database)}`);
console.log(`DATABASE_OWNER_URL=${ownerUrl}`);
console.log("Press Ctrl-C to stop.");

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
