import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createUser } from "../src/server/auth/service";
import { createDb } from "../src/server/db/client";
import { loadEnv, requireEnv } from "./env";

/**
 * DEVELOPMENT ONLY: creates a staff user.
 *   npm run user:create -- --username partner.a --name "Partner A" --roles partner
 * The password is read from NEW_USER_PASSWORD or prompted. Refuses to run in production;
 * production bootstrap of partner accounts is Pre-Implementation Review P1-03.
 */
loadEnv();
if (process.env.NODE_ENV === "production") {
  console.error("user:create is for development only (see P1-03 for production bootstrap)");
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    username: { type: "string" },
    name: { type: "string" },
    roles: { type: "string" },
  },
});
if (!values.username || !values.name || !values.roles) {
  console.error(
    'Usage: npm run user:create -- --username <u> --name "<display name>" --roles partner,manager',
  );
  process.exit(1);
}

let password = process.env.NEW_USER_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Password (min 12 characters): ");
  rl.close();
}

const db = createDb({ connectionString: requireEnv("DATABASE_URL"), maxConnections: 2 });
try {
  const { userId } = await createUser(
    db,
    { kind: "system", name: "dev-cli" },
    {
      username: values.username,
      displayName: values.name,
      password,
      roles: values.roles.split(",").map((r) => r.trim()),
    },
  );
  console.log(`Created user ${values.username} (${userId})`);
} finally {
  await db.destroy();
}
