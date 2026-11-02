import type { Kysely } from "kysely";
import { logger } from "../core/logger";
import type { DB } from "../db/schema";
import { expireDueEstimates } from "../estimate/versions";
import { OUTBOX_HANDLERS } from "../outbox/handlers";
import { processOutbox, type OutboxHandler } from "../outbox/outbox";

/**
 * The background worker (I2-09, implementation plan §2.3: same codebase, separate process). Each tick processes the
 * outbox — only topics with a handler — and, at most once a minute, expires estimates past their date (T-37), so a
 * version no longer waits for someone to act on it before it is recorded as expired.
 */

export interface WorkerOptions {
  handlers?: Readonly<Record<string, OutboxHandler>>;
  /** Pause between ticks. Default 5 seconds. */
  intervalMs?: number;
  /** Least time between two expiry sweeps. Default one minute. */
  expiryEveryMs?: number;
}

export interface TickResult {
  processed: number;
  failed: number;
  /** Estimate versions expired by this tick, or null when the sweep was not due. */
  expired: string[] | null;
}

export function createWorker(db: Kysely<DB>, options: WorkerOptions = {}) {
  const handlers = options.handlers ?? OUTBOX_HANDLERS;
  const intervalMs = options.intervalMs ?? 5_000;
  const expiryEveryMs = options.expiryEveryMs ?? 60_000;
  let lastExpiry = Number.NEGATIVE_INFINITY;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  /** One pass. Failures are logged and the next tick tries again; nothing here holds a transaction open. */
  async function tick(now = Date.now()): Promise<TickResult> {
    const outbox = await processOutbox(db, { handlers: { ...handlers }, topics: Object.keys(handlers) });
    let expired: string[] | null = null;
    if (now - lastExpiry >= expiryEveryMs) {
      lastExpiry = now;
      expired = await expireDueEstimates(db);
      if (expired.length > 0) logger.info("worker.estimates_expired", { count: expired.length });
    }
    return { ...outbox, expired };
  }

  function schedule() {
    if (stopping) return;
    timer = setTimeout(() => {
      running = tick()
        .then(() => undefined)
        .catch((error: unknown) => logger.error("worker.tick_failed", { error }))
        .finally(() => {
          running = null;
          schedule();
        });
    }, intervalMs);
  }

  return {
    tick,
    start() {
      stopping = false;
      schedule();
    },
    /** Stops after the tick in progress, if any, has finished. */
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
