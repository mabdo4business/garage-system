import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/server/command/runner";
import { allocateNumber, findNumberGaps, type Series } from "../src/server/numbering/numbering";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";

describe("S6 — document numbering", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const allocate = (series: Series, beforeCommit?: () => void) =>
    runCommand(
      db.app,
      {
        name: "test.allocate",
        actor: { kind: "anonymous" },
        hooks: beforeCommit ? { beforeCommit } : undefined,
      },
      async (ctx) => {
        const number = await allocateNumber(ctx, series, { type: "test", id: randomUUID() });
        await ctx.audit({ action: "test.number_allocated", entityType: "number", entityId: number.text });
        return { value: number.value, text: number.text };
      },
    );

  it("AT-01: a rollback after allocation consumes no number; the next issue receives it", async () => {
    await expect(
      allocate("service_record", () => {
        throw new Error("fault injected before commit");
      }),
    ).rejects.toThrow("fault injected before commit");
    const next = await allocate("service_record");
    expect(next.result).toEqual({ value: "1", text: "SR-000001" });
    expect(await findNumberGaps(db.app, "service_record")).toEqual([]);
  });

  it("50 concurrent allocations on one series give 1…50 with no gaps or duplicates", async () => {
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => allocate("release_note")));
    const values = outcomes.map((o) => Number(o.result.value)).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(await findNumberGaps(db.app, "release_note")).toEqual([]);
  });

  it("series are independent of each other", async () => {
    const credit = await allocate("credit_note");
    const invoice = await allocate("invoice");
    expect(credit.result.text).toBe("CN-000001");
    expect(invoice.result.text).toBe("INV-000001");
  });

  it("the database rejects a duplicate number in a series", async () => {
    const error = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO issued_number (series, value, number_text, document_type, document_id, business_date)
       VALUES ('invoice', 1, 'INV-000001-dup', 'test', gen_random_uuid(), current_date)`,
    );
    expect(error?.code).toBe("23505");
  });

  it("the gap report finds a number with no document", async () => {
    // Only possible by tampering outside the application (owner role): advance the counter.
    await db.owner
      .updateTable("number_series")
      .set({ next_value: "3" })
      .where("series", "=", "test_document")
      .execute();
    expect(await findNumberGaps(db.app, "test_document")).toEqual(["1", "2"]);
  });
});
