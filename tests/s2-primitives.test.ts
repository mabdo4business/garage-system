import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/server/command/runner";
import { DecimalInputError, Money, Qty, divRoundHalfUp, unitCost6 } from "../src/server/core/money";
import {
  EMPTY_POOL,
  PoolError,
  poolIn,
  poolOf,
  poolOut,
  poolUnitCost,
  type PoolState,
} from "../src/server/core/pool";
import { dubaiDate } from "../src/i18n/format";
import { createTestDatabase, type TestDatabase } from "./helpers/db";

const m = (s: string) => Money.parse(s);
const q = (s: string) => Qty.parse(s);

/** Removes `count` single units from a pool and returns each amount as a string. */
function drainOneByOne(pool: PoolState, count: number): { amounts: string[]; pool: PoolState } {
  const amounts: string[] = [];
  let current = pool;
  for (let i = 0; i < count; i++) {
    const out = poolOut(current, q("1"));
    amounts.push(out.amount.toString());
    current = out.pool;
  }
  return { amounts, pool: current };
}

describe("S2 — money and quantity types", () => {
  it("parses and formats exact decimals", () => {
    expect(m("10.5").toString()).toBe("10.50");
    expect(m("0").toString()).toBe("0.00");
    expect(m("-3.1").toString()).toBe("-3.10");
    expect(q("4.5").toString()).toBe("4.500");
    expect(m("0.10").add(m("0.20")).toString()).toBe("0.30");
  });

  it("rejects JavaScript numbers (floats) at the boundary", () => {
    expect(() => Money.parse(10.5)).toThrow(DecimalInputError);
    expect(() => Money.parse(10)).toThrow(DecimalInputError);
    expect(() => Qty.parse(1)).toThrow(DecimalInputError);
  });

  it("rejects malformed values and excess precision", () => {
    expect(() => m("1.234")).toThrow(DecimalInputError);
    expect(() => m("abc")).toThrow(DecimalInputError);
    expect(() => m("1e3")).toThrow(DecimalInputError);
    expect(() => q("1.2345")).toThrow(DecimalInputError);
  });

  it("rounds half away from zero", () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
  });

  it("gives unit cost at 6 decimals", () => {
    expect(unitCost6(m("10.00"), q("3"))).toBe("3.333333");
    expect(unitCost6(m("8.50"), q("1"))).toBe("8.500000");
  });
});

describe("S2 — pool rule (Amendment v0.2.2 §A.1)", () => {
  it("T-02 / AT-17: receive 3 for 10.00, issue one at a time → 3.33, 3.33, 3.34", () => {
    const stock = poolIn(EMPTY_POOL, q("3"), m("10.00"));
    const { amounts, pool } = drainOneByOne(stock, 3);
    expect(amounts).toEqual(["3.33", "3.33", "3.34"]);
    expect(pool.qty.toString()).toBe("0.000");
    expect(pool.value.toString()).toBe("0.00");
  });

  it("T-01 / AT-13: issues at 8.00 and 9.00, return one, bill one", () => {
    let line = poolIn(EMPTY_POOL, q("1"), m("8.00"));
    line = poolIn(line, q("1"), m("9.00"));
    expect(line.value.toString()).toBe("17.00");
    expect(poolUnitCost(line)).toBe("8.500000");

    const returned = poolOut(line, q("1"));
    expect(returned.amount.toString()).toBe("8.50"); // value added back to stock
    expect(returned.pool.value.toString()).toBe("8.50");

    const billed = poolOut(returned.pool, q("1"));
    expect(billed.amount.toString()).toBe("8.50"); // COGS
    expect(billed.pool.value.toString()).toBe("0.00"); // WIP
  });

  it("T-03 / AT-16: credit a 3-unit line one unit at a time", () => {
    const net = drainOneByOne(poolOf(q("3"), m("10.00")), 3);
    const tax = drainOneByOne(poolOf(q("3"), m("0.50")), 3);
    expect(net.amounts).toEqual(["3.33", "3.33", "3.34"]);
    expect(tax.amounts).toEqual(["0.17", "0.17", "0.16"]);
  });

  it("recalculates the basis only on inbound movements", () => {
    let stock = poolIn(EMPTY_POOL, q("3"), m("10.00"));
    stock = poolOut(stock, q("1")).pool; // 2 left, 6.67, basis still 10/3
    expect(poolOut(stock, q("1")).amount.toString()).toBe("3.33");
    stock = poolIn(stock, q("1"), m("4.00")); // basis becomes 10.67 / 3
    expect(poolUnitCost(stock)).toBe("3.556667");
  });

  it("never lets value go negative (rule 4)", () => {
    const { amounts, pool } = drainOneByOne(poolOf(q("10"), m("0.05")), 10);
    expect(amounts.slice(0, 5)).toEqual(["0.01", "0.01", "0.01", "0.01", "0.01"]);
    expect(amounts.slice(5)).toEqual(["0.00", "0.00", "0.00", "0.00", "0.00"]);
    expect(pool.value.toString()).toBe("0.00");
  });

  it("rejects removing more than the pool holds", () => {
    expect(() => poolOut(poolOf(q("1"), m("5.00")), q("2"))).toThrow(PoolError);
    expect(() => poolOut(EMPTY_POOL, q("1"))).toThrow(PoolError);
  });

  it("supports fractional quantities", () => {
    const oil = poolIn(EMPTY_POOL, q("4.5"), m("90.00"));
    expect(poolOut(oil, q("1.5")).amount.toString()).toBe("30.00");
  });
});

describe("S2 — business date (P1-07)", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  it("is the Asia/Dubai date: 19:59:59 UTC is day D, 20:00:00 UTC is day D+1", async () => {
    const { rows } = await sql<{ before: string; after: string }>`
      SELECT business_date_of('2026-10-15T19:59:59Z')::text AS before,
             business_date_of('2026-10-15T20:00:00Z')::text AS after`.execute(db.app);
    expect(rows[0]).toEqual({ before: "2026-10-15", after: "2026-10-16" });
    expect(dubaiDate(new Date("2026-10-15T19:59:59Z"))).toBe("2026-10-15");
    expect(dubaiDate(new Date("2026-10-15T20:00:00Z"))).toBe("2026-10-16");
  });

  it("commands take it from the database transaction timestamp", async () => {
    const outcome = await runCommand(
      db.app,
      { name: "test.business_date", actor: { kind: "anonymous" } },
      async (ctx) => {
        const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(ctx.tx);
        await ctx.audit({ action: "test.business_date", entityType: "test", entityId: "1" });
        return {
          businessDate: ctx.businessDate,
          txTime: ctx.txTime.toISOString(),
          now: rows[0]!.now.toISOString(),
        };
      },
    );
    expect(outcome.result.txTime).toBe(outcome.result.now);
    expect(outcome.result.businessDate).toBe(dubaiDate(new Date(outcome.result.txTime)));
  });
});
