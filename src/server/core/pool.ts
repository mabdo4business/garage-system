import { Money, Qty, divRoundHalfUp, unitCost6 } from "./money";

/**
 * The pool rule — Specification Amendment v0.2.2 §A.1.
 *
 * A pool holds a quantity and a value. Its basis unit is value ÷ quantity, kept as an exact
 * fraction (basisValue / basisQty), which is at least as precise as the 6-decimal unit cost.
 *
 *  1. The basis is recalculated only when units ENTER the pool.
 *  2. Units LEAVING the pool take round-half-up(basis × qty) to 2 decimals.
 *  3. The movement that takes the pool's quantity to zero takes the entire remaining value.
 *  4. Quantity and value can never go negative; an outbound amount is capped at the value left.
 *
 * Used for stock (per part), job-line WIP, line COGS and invoice-line amounts for credit notes.
 */
export interface PoolState {
  readonly qty: Qty;
  readonly value: Money;
  readonly basisQty: Qty;
  readonly basisValue: Money;
}

export class PoolError extends Error {
  readonly code = "pool_violation";
}

export const EMPTY_POOL: PoolState = {
  qty: Qty.ZERO,
  value: Money.ZERO,
  basisQty: Qty.ZERO,
  basisValue: Money.ZERO,
};

/** Units enter the pool; the basis becomes the new totals. */
export function poolIn(pool: PoolState, qty: Qty, value: Money): PoolState {
  if (!qty.isPositive()) {
    throw new PoolError("Inbound quantity must be positive");
  }
  if (value.isNegative()) {
    throw new PoolError("Inbound value cannot be negative");
  }
  const newQty = pool.qty.add(qty);
  const newValue = pool.value.add(value);
  return { qty: newQty, value: newValue, basisQty: newQty, basisValue: newValue };
}

/** Creates a pool with a fixed basis, e.g. an invoice line (qty 3, net 10.00). */
export function poolOf(qty: Qty, value: Money): PoolState {
  return poolIn(EMPTY_POOL, qty, value);
}

export interface PoolOutResult {
  readonly amount: Money;
  readonly pool: PoolState;
}

/** Units leave the pool. The basis does not change. */
export function poolOut(pool: PoolState, qty: Qty): PoolOutResult {
  if (!qty.isPositive()) {
    throw new PoolError("Outbound quantity must be positive");
  }
  if (qty.compare(pool.qty) > 0) {
    throw new PoolError(`Cannot remove ${qty} from a pool holding ${pool.qty}`);
  }
  let amount: Money;
  if (qty.equals(pool.qty)) {
    amount = pool.value; // rule 3: exhausting movement takes the remainder
  } else {
    const proportional = Money.fromFils(
      divRoundHalfUp(pool.basisValue.fils * qty.milli, pool.basisQty.milli),
    );
    amount = proportional.min(pool.value); // rule 4: never below zero
  }
  const remainingQty = pool.qty.sub(qty);
  const remainingValue = pool.value.sub(amount);
  return {
    amount,
    pool: {
      qty: remainingQty,
      value: remainingValue,
      basisQty: remainingQty.isZero() ? Qty.ZERO : pool.basisQty,
      basisValue: remainingQty.isZero() ? Money.ZERO : pool.basisValue,
    },
  };
}

/** Basis unit cost at 6 decimals, or null for an empty pool. */
export function poolUnitCost(pool: PoolState): string | null {
  return pool.basisQty.isPositive() ? unitCost6(pool.basisValue, pool.basisQty) : null;
}
