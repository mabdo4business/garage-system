import { createDb } from "../src/server/db/client";
import { getMediaStorage } from "../src/server/media/storage";
import { DEMO_USERS, seedDemo } from "./demo-scenario";
import { loadEnv, requireEnv } from "./env";

/**
 * DEVELOPMENT ONLY: fills the development database with sample repair orders at every workshop stage
 * (scripts/demo-scenario.ts). The demo accounts' password comes from DEMO_PASSWORD (at least 12 characters) and is
 * never printed. Run `npm run db:dev` first. Refuses to run in production.
 *   DEMO_PASSWORD='…' npm run db:demo
 */
loadEnv();
if (process.env.NODE_ENV === "production") {
  console.error("db:demo is for development only");
  process.exit(1);
}
const password = requireEnv("DEMO_PASSWORD");
const connectionString = requireEnv("DATABASE_URL");
// It creates partner accounts, a tax profile and a business profile: only ever on the local db:dev database.
const target = new URL(connectionString);
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.port !== "54329") {
  console.error("db:demo runs only against the local development database (npm run db:dev, port 54329)");
  process.exit(1);
}
const db = createDb({ connectionString, maxConnections: 2 });
try {
  const { repairOrders } = await seedDemo(db, getMediaStorage(), password);
  console.log(`Created ${Object.keys(repairOrders).length} demo repair orders.`);
  console.log(`Sign in as: ${DEMO_USERS.map(([username]) => username).join(", ")} (password: DEMO_PASSWORD)`);
} finally {
  await db.destroy();
}
