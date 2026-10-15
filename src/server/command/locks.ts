import { sql, type Transaction } from "kysely";
import { LockOrderViolationError, NotFoundError } from "../core/errors";
import type { DB } from "../db/schema";

/**
 * Canonical lock order — Pre-Implementation Review P0-03:
 *   repair order → invoice(s) ↑ → revision lines ↑ → stock balances ↑ → number sequence (last)
 *
 * Ranks are fixed. Within one kind, ids are locked in ascending order. Acquiring a lower-ranked
 * kind after a higher-ranked one, or a smaller id after a larger one of the same kind, throws
 * LockOrderViolationError: that is a programming error and must fail loudly in tests.
 *
 * Kinds without a table yet are listed so their rank is reserved; acquiring them throws until
 * the increment that creates the table registers it in LOCK_TARGETS.
 */
export const LOCK_RANK = {
  vehicle: 5, // I1-01: below repair_order so a future check-in can lock vehicle, then repair_order
  repair_order: 10,
  test_document: 15, // Increment 0 stub document; sits at document level
  invoice: 20,
  revision_line: 30,
  stock_balance: 40,
  number_series: 90,
} as const;

export type LockKind = keyof typeof LOCK_RANK;

const LOCK_TARGETS: Partial<Record<LockKind, { table: keyof DB; column: string }>> = {
  vehicle: { table: "vehicle", column: "id" },
  test_document: { table: "test_document", column: "id" },
  number_series: { table: "number_series", column: "series" },
};

export interface LockRecord {
  kind: LockKind;
  id: string;
}

export class LockSet {
  private readonly held = new Set<string>();
  private lastRank = 0;
  private lastIdOfRank: string | undefined;
  /** Order in which row locks were actually taken (for tests and diagnostics). */
  readonly acquired: LockRecord[] = [];

  constructor(private readonly tx: Transaction<DB>) {}

  /** Locks the given rows (SELECT … FOR UPDATE) in canonical order. Returns the sorted ids. */
  async acquire(kind: LockKind, ids: readonly string[]): Promise<string[]> {
    const target = LOCK_TARGETS[kind];
    if (!target) {
      throw new LockOrderViolationError(`Lock kind ${kind} has no table registered yet`);
    }
    const rank = LOCK_RANK[kind];
    const sorted = [...new Set(ids)].sort();
    const pending = sorted.filter((id) => !this.held.has(`${kind}:${id}`));
    if (pending.length === 0) {
      return sorted;
    }
    if (rank < this.lastRank) {
      throw new LockOrderViolationError(
        `Cannot lock ${kind} (rank ${rank}) after a lock of rank ${this.lastRank}`,
      );
    }
    const first = pending[0]!;
    if (rank === this.lastRank && this.lastIdOfRank !== undefined && first < this.lastIdOfRank) {
      throw new LockOrderViolationError(
        `Cannot lock ${kind} ${first} after ${this.lastIdOfRank}: ids must be locked in ascending order`,
      );
    }
    for (const id of pending) {
      const result = await sql<{ id: string }>`
        SELECT ${sql.ref(target.column)}::text AS id
        FROM ${sql.table(target.table)}
        WHERE ${sql.ref(target.column)} = ${id}
        FOR UPDATE`.execute(this.tx);
      if (result.rows.length === 0) {
        throw new NotFoundError(kind, id);
      }
      this.held.add(`${kind}:${id}`);
      this.acquired.push({ kind, id });
    }
    this.lastRank = rank;
    this.lastIdOfRank = pending[pending.length - 1];
    return sorted;
  }
}
