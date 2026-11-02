import { sql, type Kysely } from "kysely";
import type { DB } from "../db/schema";

/** Retention for idempotency keys (Amendment v0.2.2 §A.3). */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

/** Deletes idempotency keys older than the retention period. Returns the number deleted. */
export async function purgeIdempotencyKeys(
  db: Kysely<DB>,
  retentionDays: number = IDEMPOTENCY_RETENTION_DAYS,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new RangeError("retentionDays must be a positive integer");
  }
  const result = await db
    .deleteFrom("idempotency_key")
    .where("created_at", "<", sql<Date>`now() - make_interval(days => ${retentionDays})`)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}
