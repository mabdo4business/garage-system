import { sql, type Kysely } from "kysely";
import { logger } from "../core/logger";
import type { DB } from "../db/schema";

/**
 * Outbox processor (S7, P0-01). Messages are written by commands inside their transaction
 * (CommandContext.enqueue) and processed here only after that transaction committed.
 *
 * Delivery is at-least-once: if the process stops after a handler ran but before the message
 * was marked processed, the message is delivered again. Handlers must therefore be idempotent,
 * using message.id as their de-duplication key (for example, a PDF stored under a key derived
 * from the document id is simply overwritten with identical content).
 */

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

export type OutboxHandler = (message: OutboxMessage) => Promise<void>;

export interface ProcessOutboxOptions {
  handlers: Record<string, OutboxHandler>;
  /** Maximum messages per call. Default 50. */
  limit?: number;
  /** Delay before retrying a failed message. Default: 2^attempts seconds, capped at 5 minutes. */
  backoffSeconds?: (attempts: number) => number;
  /** Test-only: runs after the handler succeeded and before the message is marked processed. */
  afterHandler?: (message: OutboxMessage) => Promise<void> | void;
}

export interface ProcessOutboxResult {
  processed: number;
  failed: number;
}

const defaultBackoff = (attempts: number) => Math.min(2 ** attempts, 300);

export async function processOutbox(
  db: Kysely<DB>,
  options: ProcessOutboxOptions,
): Promise<ProcessOutboxResult> {
  const limit = options.limit ?? 50;
  const backoff = options.backoffSeconds ?? defaultBackoff;
  const stats: ProcessOutboxResult = { processed: 0, failed: 0 };
  // A message that fails is not picked up again in the same call, whatever its backoff.
  const attempted: string[] = [];

  for (let i = 0; i < limit; i++) {
    const outcome = await db.transaction().execute(async (tx) => {
      let query = tx
        .selectFrom("outbox_message")
        .select(["id", "topic", "payload", "attempts"])
        .where("processed_at", "is", null)
        .where("available_at", "<=", sql<Date>`now()`);
      if (attempted.length > 0) {
        query = query.where("id", "not in", attempted);
      }
      const row = await query
        .orderBy("created_at")
        .orderBy("id")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) {
        return "empty" as const;
      }
      attempted.push(row.id);
      const message: OutboxMessage = {
        id: row.id,
        topic: row.topic,
        payload: row.payload,
        attempts: row.attempts,
      };
      const handler = options.handlers[row.topic];
      try {
        if (!handler) {
          throw new Error(`No outbox handler for topic ${row.topic}`);
        }
        await handler(message);
      } catch (error) {
        const attempts = row.attempts + 1;
        await tx
          .updateTable("outbox_message")
          .set({
            attempts,
            last_error: (error as Error).message.slice(0, 1000),
            available_at: sql<Date>`now() + make_interval(secs => ${backoff(attempts)})`,
          })
          .where("id", "=", row.id)
          .execute();
        logger.warn("outbox.handler_failed", { topic: row.topic, messageId: row.id, attempts });
        return "failed" as const;
      }
      await options.afterHandler?.(message);
      await tx
        .updateTable("outbox_message")
        .set({ processed_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .execute();
      return "processed" as const;
    });

    if (outcome === "empty") break;
    stats[outcome]++;
  }
  return stats;
}
