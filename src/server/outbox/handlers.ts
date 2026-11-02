import type { OutboxHandler } from "./outbox";

/**
 * The outbox handlers the worker runs (I2-09). Topics written by commands but not listed here wait in the outbox
 * until their handler exists — e.g. `alert.release_override` (I1-10, AC2-27) is sent once messaging arrives (I6-06).
 * Handlers must be idempotent: delivery is at-least-once (see processOutbox).
 */
export const OUTBOX_HANDLERS: Readonly<Record<string, OutboxHandler>> = {};
