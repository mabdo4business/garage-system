import { createDb } from "../src/server/db/client";
import { logger } from "../src/server/core/logger";
import { createWorker } from "../src/server/worker/worker";
import { loadEnv, requireEnv } from "./env";

/**
 * The background worker (I2-09): processes the outbox and expires overdue estimates. Run it beside the app:
 *   npm run worker
 * Stops cleanly on Ctrl-C or SIGTERM, after the tick in progress.
 */
loadEnv();
const db = createDb({ connectionString: requireEnv("DATABASE_URL"), maxConnections: 2 });
const worker = createWorker(db);
worker.start();
logger.info("worker.started", {});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("worker.stopping", { signal });
  await worker.stop();
  await db.destroy();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
