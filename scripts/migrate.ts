import { runMigrations } from "../src/server/db/migrate";
import { loadEnv, requireEnv } from "./env";

loadEnv();
const result = await runMigrations(requireEnv("DATABASE_OWNER_URL"));
console.log(
  `Migrations applied: ${result.applied.length ? result.applied.join(", ") : "none"}; ` +
    `already applied: ${result.alreadyApplied.length}`,
);
