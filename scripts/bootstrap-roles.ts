import pg from "pg";
import { bootstrapDatabase } from "../src/server/db/bootstrap";
import { loadEnv, requireEnv } from "./env";

/**
 * Creates the application database (if missing) and the garage_owner / garage_app roles.
 * Run once by whoever holds the superuser credentials (see owner decision B-04).
 */
loadEnv();
const adminUrl = requireEnv("DATABASE_ADMIN_URL");
const database = new URL(requireEnv("DATABASE_URL")).pathname.slice(1);

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(database)}`);
  console.log(`Created database ${database}`);
}
await admin.end();

const dbAdminUrl = new URL(adminUrl);
dbAdminUrl.pathname = `/${database}`;
await bootstrapDatabase({
  adminUrl: dbAdminUrl.toString(),
  database,
  ownerPassword: requireEnv("DB_OWNER_PASSWORD"),
  appPassword: requireEnv("DB_APP_PASSWORD"),
});
console.log(`Roles garage_owner and garage_app are ready for database ${database}`);
