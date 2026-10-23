import type { Kysely } from "kysely";
import { Money, Qty } from "../core/money";
import { poolUnitCost } from "../core/pool";
import type { DB, Emirate, JobExecutionStatus } from "../db/schema";
import { authorizedScope } from "../estimate/approval";

/**
 * Stock and parts-for-jobs reads (I1-07). They contain costs, so callers check stock.read first (T-24): never
 * technicians, never customer-facing.
 */

export interface StockRow {
  itemId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  unit: string | null;
  active: boolean;
  qty: string;
  value: string;
  /** Pool basis per unit at 6 decimals, or null when empty. */
  unitCost: string | null;
}

export async function stockList(db: Kysely<DB>): Promise<StockRow[]> {
  const rows = await db
    .selectFrom("stock_balance")
    .innerJoin("catalogue_item", "catalogue_item.id", "stock_balance.item_id")
    .select([
      "catalogue_item.id",
      "catalogue_item.code",
      "catalogue_item.name_en",
      "catalogue_item.name_ar",
      "catalogue_item.unit",
      "catalogue_item.active",
      "stock_balance.qty",
      "stock_balance.value",
      "stock_balance.basis_qty",
      "stock_balance.basis_value",
    ])
    .orderBy("catalogue_item.code")
    .execute();
  return rows.map((row) => ({
    itemId: row.id,
    code: row.code,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    unit: row.unit,
    active: row.active,
    qty: row.qty,
    value: row.value,
    unitCost: poolUnitCost({
      qty: Qty.parse(row.qty),
      value: Money.parse(row.value),
      basisQty: Qty.parse(row.basis_qty),
      basisValue: Money.parse(row.basis_value),
    }),
  }));
}

export interface PartLine {
  lineId: string;
  descriptionEn: string;
  descriptionAr: string;
  itemCode: string | null;
  stockTracked: boolean;
  unit: string | null;
  /** Approved quantity and what has been costed to the line so far (issued or received for it). */
  approvedQty: string;
  costedQty: string;
  cost: string;
  onHand: string | null;
  jobId: string;
  jobTitle: string;
  jobStatus: JobExecutionStatus;
  repairOrderId: string;
  repairOrderNumber: string;
  plate: { emirate: Emirate; code: string; number: string } | null;
}

/** Approved part lines of jobs on repair orders in progress — the store keeper's to-do list. */
export async function partsForOpenJobs(db: Kysely<DB>): Promise<PartLine[]> {
  const jobs = await db
    .selectFrom("repair_job")
    .innerJoin("repair_order", "repair_order.id", "repair_job.repair_order_id")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_job.id",
      "repair_job.title",
      "repair_job.execution_status",
      "repair_order.id as repair_order_id",
      "repair_order.number",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("repair_order.status", "=", "in_progress")
    .where("repair_job.removed_at", "is", null)
    .where("repair_job.execution_status", "in", ["authorized", "waiting_parts", "in_progress", "paused"])
    .orderBy("repair_order.checked_in_at")
    .orderBy("repair_job.created_at")
    .execute();
  const result: PartLine[] = [];
  for (const job of jobs) {
    const scope = await authorizedScope(db, job.id);
    if (scope.length === 0) continue;
    const lines = await db
      .selectFrom("revision_line")
      .leftJoin("catalogue_item", "catalogue_item.id", "revision_line.catalogue_item_id")
      .leftJoin("stock_balance", "stock_balance.item_id", "revision_line.catalogue_item_id")
      .leftJoin("line_wip", "line_wip.revision_line_id", "revision_line.id")
      .select([
        "revision_line.id",
        "revision_line.description_en",
        "revision_line.description_ar",
        "revision_line.unit",
        "revision_line.qty",
        "catalogue_item.code",
        "catalogue_item.stock_tracked",
        "stock_balance.qty as on_hand",
        "line_wip.qty as costed_qty",
        "line_wip.value as cost",
      ])
      .where("revision_line.id", "in", scope)
      .where("revision_line.line_type", "=", "part")
      .orderBy("revision_line.created_at")
      .execute();
    for (const line of lines) {
      result.push({
        lineId: line.id,
        descriptionEn: line.description_en,
        descriptionAr: line.description_ar,
        itemCode: line.code,
        stockTracked: Boolean(line.stock_tracked),
        unit: line.unit,
        approvedQty: line.qty,
        costedQty: line.costed_qty ?? "0.000",
        cost: line.cost ?? "0.00",
        onHand: line.on_hand,
        jobId: job.id,
        jobTitle: job.title,
        jobStatus: job.execution_status,
        repairOrderId: job.repair_order_id,
        repairOrderNumber: job.number,
        plate:
          job.emirate && job.code !== null && job.plate_number !== null
            ? { emirate: job.emirate, code: job.code, number: job.plate_number }
            : null,
      });
    }
  }
  return result;
}
