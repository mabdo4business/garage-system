import { sql, type Kysely } from "kysely";
import { NotFoundError } from "../core/errors";
import type { CommandContext } from "../command/runner";
import type { DB } from "../db/schema";

/**
 * Document numbering (S6). One counter row per series, incremented inside the issuing
 * transaction while the row is locked, so a rollback returns the number unused (AT-01).
 *
 * Separate series exist for invoices, credit notes, release notes and service records (F-09).
 * Whether gap-free numbering, separate series, a prefix format or a yearly reset is legally
 * required is subject to UAE tax-agent verification (V-2); format is configuration in
 * number_series, so answers do not require code changes.
 */
export type Series =
  | "invoice"
  | "credit_note"
  | "release_note"
  | "service_record"
  | "repair_order" // I1-02 (OD-3): reference number, not a tax document
  | "test_document";

export interface AllocatedNumber {
  series: Series;
  value: string;
  text: string;
}

export async function allocateNumber(
  ctx: CommandContext,
  series: Series,
  document: { type: string; id: string },
): Promise<AllocatedNumber> {
  // Number sequences are always locked last (canonical order).
  await ctx.locks.acquire("number_series", [series]);

  const row = await ctx.tx
    .updateTable("number_series")
    .set({ next_value: sql`next_value + 1` })
    .where("series", "=", series)
    .returning(["prefix", "pad_width", sql<string>`(next_value - 1)::text`.as("value")])
    .executeTakeFirst();
  if (!row) {
    throw new NotFoundError("number_series", series);
  }

  const text = `${row.prefix}${row.value.padStart(row.pad_width, "0")}`;
  await ctx.tx
    .insertInto("issued_number")
    .values({
      series,
      value: row.value,
      number_text: text,
      document_type: document.type,
      document_id: document.id,
      business_date: ctx.businessDate,
    })
    .execute();

  return { series, value: row.value, text };
}

/** Numbers between 1 and the last allocated value that have no issued document. */
export async function findNumberGaps(db: Kysely<DB>, series: Series): Promise<string[]> {
  const result = await sql<{ value: string }>`
    SELECT g.value::text AS value
    FROM number_series s
    CROSS JOIN LATERAL generate_series(1, s.next_value - 1) AS g(value)
    WHERE s.series = ${series}
      AND NOT EXISTS (
        SELECT 1 FROM issued_number i WHERE i.series = s.series AND i.value = g.value
      )
    ORDER BY g.value`.execute(db);
  return result.rows.map((r) => r.value);
}
