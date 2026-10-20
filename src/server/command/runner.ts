import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { AuditMissingError, IdempotencyConflictError, TryAgainError, ValidationError } from "../core/errors";
import { canonicalJson, sha256Hex, type JsonValue } from "../core/json";
import { logger } from "../core/logger";
import type { DB } from "../db/schema";
import { LockSet } from "./locks";

/**
 * Command runner — the only way state changes reach the database.
 *
 * Every command runs in ONE transaction that contains its writes, its audit events, its
 * outbox messages, any number allocation and its idempotency record (P0-01, F-07).
 * External side effects happen only after commit, via the outbox.
 *
 * Transient conflicts (deadlock, serialization failure, lock timeout) roll everything back and
 * the command is re-run once automatically (P0-03). A second failure surfaces TryAgainError.
 */

export type Actor =
  { kind: "user"; userId: string } | { kind: "system"; name: string } | { kind: "anonymous" };

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  before?: JsonValue | null;
  after?: JsonValue | null;
  details?: JsonValue | null;
}

export interface CommandContext {
  readonly tx: Transaction<DB>;
  readonly commandName: string;
  readonly commandId: string;
  readonly actor: Actor;
  /** Transaction timestamp (PostgreSQL now()). */
  readonly txTime: Date;
  /** Asia/Dubai calendar date of the transaction timestamp, 'YYYY-MM-DD' (P1-07). */
  readonly businessDate: string;
  /** 1 for the first attempt, 2 for the automatic retry. */
  readonly attempt: number;
  readonly locks: LockSet;
  audit(event: AuditInput): Promise<void>;
  enqueue(topic: string, payload: JsonValue): Promise<void>;
}

export interface IdempotencyInput {
  /** Client-generated UUID, one per form instance. */
  key: string;
  /** The request body; hashed together with the actor to detect key reuse. */
  payload: JsonValue;
}

export interface RunCommandOptions {
  name: string;
  actor: Actor;
  idempotency?: IdempotencyInput;
  /** Automatic retries after a transient conflict. Default 1. */
  maxRetries?: number;
  /** Test-only fault injection points. */
  hooks?: {
    beforeCommit?: (ctx: CommandContext) => Promise<void> | void;
    afterCommit?: () => Promise<void> | void;
  };
}

export interface CommandOutcome<R> {
  result: R;
  /** True when the result was returned from an earlier execution with the same idempotency key. */
  replayed: boolean;
  commandId: string;
  attempts: number;
}

const RETRYABLE_SQLSTATES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "55P03", // lock_not_available (lock_timeout)
]);

export function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_SQLSTATES.has(code);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Plain read: true when `commandName` already committed with this idempotency key. Callers that
 * show a warning before running a command (e.g. duplicate checks) use it to skip the warning on
 * a retry, so runCommand replays the original result instead of the warning hiding it.
 */
export async function idempotencyKeyUsed(db: Kysely<DB>, commandName: string, key: string): Promise<boolean> {
  if (!UUID_PATTERN.test(key)) return false;
  const row = await db
    .selectFrom("idempotency_key")
    .select("key")
    .where("command_name", "=", commandName)
    .where("key", "=", key)
    .executeTakeFirst();
  return row !== undefined;
}

/** Thrown inside the transaction to leave it (rolling back nothing written) and return a stored result. */
class ReplaySignal {
  constructor(readonly result: unknown) {}
}

function actorUserId(actor: Actor): string | null {
  return actor.kind === "user" ? actor.userId : null;
}

function actorLabel(actor: Actor): string {
  if (actor.kind === "user") return "user";
  if (actor.kind === "system") return `system:${actor.name}`;
  return "anonymous";
}

export async function runCommand<R extends JsonValue>(
  db: Kysely<DB>,
  options: RunCommandOptions,
  fn: (ctx: CommandContext) => Promise<R>,
): Promise<CommandOutcome<R>> {
  const maxRetries = options.maxRetries ?? 1;
  const commandId = randomUUID();
  let requestHash: string | undefined;

  if (options.idempotency) {
    if (!UUID_PATTERN.test(options.idempotency.key)) {
      throw new ValidationError("Idempotency key must be a UUID");
    }
    requestHash = sha256Hex(
      canonicalJson({ actor: actorUserId(options.actor), payload: options.idempotency.payload }),
    );
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await db
        .transaction()
        .setIsolationLevel("read committed")
        .execute(async (tx) => {
          await sql`SET LOCAL lock_timeout = '10s'`.execute(tx);
          const clock = await sql<{ tx_time: Date; business_date: string }>`
            SELECT now() AS tx_time, business_date_of(now())::text AS business_date`.execute(tx);
          const { tx_time: txTime, business_date: businessDate } = clock.rows[0]!;

          // F-07: the idempotency record is the first write. A concurrent duplicate blocks here
          // until the first transaction commits (→ replay) or rolls back (→ proceeds as new).
          if (options.idempotency && requestHash) {
            const inserted = await tx
              .insertInto("idempotency_key")
              .values({
                command_name: options.name,
                key: options.idempotency.key,
                request_hash: requestHash,
                actor_user_id: actorUserId(options.actor),
              })
              .onConflict((oc) => oc.columns(["command_name", "key"]).doNothing())
              .returning("key")
              .executeTakeFirst();
            if (!inserted) {
              const existing = await tx
                .selectFrom("idempotency_key")
                .select(["request_hash", "result"])
                .where("command_name", "=", options.name)
                .where("key", "=", options.idempotency.key)
                .executeTakeFirstOrThrow();
              if (existing.request_hash !== requestHash) {
                throw new IdempotencyConflictError(options.name);
              }
              throw new ReplaySignal(existing.result);
            }
          }

          let auditCount = 0;
          const ctx: CommandContext = {
            tx,
            commandName: options.name,
            commandId,
            actor: options.actor,
            txTime,
            businessDate,
            attempt,
            locks: new LockSet(tx),
            async audit(event) {
              await tx
                .insertInto("audit_event")
                .values({
                  business_date: businessDate,
                  command_name: options.name,
                  command_id: commandId,
                  actor_user_id: actorUserId(options.actor),
                  actor_label: actorLabel(options.actor),
                  action: event.action,
                  entity_type: event.entityType,
                  entity_id: event.entityId,
                  before_state: event.before == null ? null : JSON.stringify(event.before),
                  after_state: event.after == null ? null : JSON.stringify(event.after),
                  details: event.details == null ? null : JSON.stringify(event.details),
                })
                .execute();
              auditCount++;
            },
            async enqueue(topic, payload) {
              await tx
                .insertInto("outbox_message")
                .values({ topic, payload: JSON.stringify(payload), command_id: commandId })
                .execute();
            },
          };

          const output = await fn(ctx);

          if (auditCount === 0) {
            throw new AuditMissingError(options.name);
          }
          if (options.idempotency) {
            await tx
              .updateTable("idempotency_key")
              .set({ result: JSON.stringify(output) })
              .where("command_name", "=", options.name)
              .where("key", "=", options.idempotency.key)
              .execute();
          }
          await options.hooks?.beforeCommit?.(ctx);
          return output;
        });

      await options.hooks?.afterCommit?.();
      return { result, replayed: false, commandId, attempts: attempt };
    } catch (error) {
      if (error instanceof ReplaySignal) {
        return { result: error.result as R, replayed: true, commandId, attempts: attempt };
      }
      if (isRetryable(error)) {
        if (attempt <= maxRetries) {
          logger.warn("command.retry", {
            command: options.name,
            commandId,
            attempt,
            sqlstate: (error as { code: string }).code,
          });
          continue;
        }
        throw new TryAgainError(options.name, error);
      }
      throw error;
    }
  }
}
