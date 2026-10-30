import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { resetPassword } from "../src/server/auth/service";
import { createDb } from "../src/server/db/client";
import { loadEnv, requireEnv } from "./env";

/**
 * DEVELOPMENT ONLY: sets a new password for an existing staff user and signs them out everywhere.
 *   npm run user:password -- --username partner.a
 * The password is read from NEW_USER_PASSWORD or prompted, and never printed. Refuses to run in production;
 * production password management is Pre-Implementation Review P1-03 (I5-03).
 */
loadEnv();
if (process.env.NODE_ENV === "production") {
  console.error("user:password is for development only (see P1-03 for production accounts)");
  process.exit(1);
}

const { values } = parseArgs({ options: { username: { type: "string" } } });
if (!values.username) {
  console.error("Usage: npm run user:password -- --username <u>");
  process.exit(1);
}

let password = process.env.NEW_USER_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("New password (min 12 characters): ");
  rl.close();
}

const db = createDb({ connectionString: requireEnv("DATABASE_URL"), maxConnections: 2 });
try {
  const { sessionsRevoked } = await resetPassword(
    db,
    { kind: "system", name: "dev-cli" },
    { username: values.username, password },
  );
  console.log(`Password changed for ${values.username}; ${sessionsRevoked} session(s) signed out`);
} finally {
  await db.destroy();
}
