import { sql, type Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { Money, Qty } from "../core/money";
import { EMPTY_POOL, poolIn, poolOut, type PoolState } from "../core/pool";
import type { DB } from "../db/schema";
import { requirePermission, type Staff } from "../estimate/commands";
import { liveAssignee } from "../workshop/commands";

/**
 * Parts for a job (I1-07). Stock pool per stock-tracked part and WIP pool per job line, both under the pool
 * rule (Amendment v0.2.2 §A.1, `src/server/core/pool.ts`):
 *  - goods receipt: stock in (OD-28);
 *  - issue from stock: stock out at the pool basis → line WIP in (no negative stock, AC2-13/14);
 *  - receive-and-issue: a special-order part or a non-stock item's actual cost straight into line WIP (T-23,
 *    OD-30).
 * Costs are entered excluding VAT, as totals for the quantity (OD-32). Locks: repair order → revision line →
 * stock balance. The database re-checks every guard and that pools equal their movements (migration 0014).
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });
const MAX_AMOUNT = Money.parse("999999999999.99");
const MAX_QTY = Qty.parse("100000");

function text(value: unknown, field: string, max: number, required: boolean): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max || (required && !trimmed)) {
    throw new ValidationError(`${field} is required`, { field });
  }
  return trimmed || null;
}

function parseQty(value: unknown): Qty {
  try {
    const qty = Qty.parse(typeof value === "string" ? value.trim() : value);
    if (!qty.isPositive() || qty.compare(MAX_QTY) > 0) throw new Error("range");
    return qty;
  } catch {
    throw new ValidationError("Enter a quantity like 1 or 2.5", { field: "qty" });
  }
}

function parseAmount(value: unknown): Money {
  try {
    const amount = Money.parse(typeof value === "string" ? value.trim() : value);
    if (amount.isNegative() || amount.compare(MAX_AMOUNT) > 0) throw new Error("range");
    return amount;
  } catch {
    throw new ValidationError("Enter the cost like 120 or 120.50", { field: "amount" });
  }
}

function poolOfRow(row: { qty: string; value: string; basis_qty: string; basis_value: string }): PoolState {
  return {
    qty: Qty.parse(row.qty),
    value: Money.parse(row.value),
    basisQty: Qty.parse(row.basis_qty),
    basisValue: Money.parse(row.basis_value),
  };
}

const poolColumns = (pool: PoolState) => ({
  qty: pool.qty.toString(),
  value: pool.value.toString(),
  basis_qty: pool.basisQty.toString(),
  basis_value: pool.basisValue.toString(),
});

// --------------------------------------------------------------------------- receipt

export async function receiveStock(
  db: Kysely<DB>,
  staff: Staff,
  itemId: string,
  input: { qty?: unknown; amount?: unknown; supplierName?: unknown; supplierRef?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ movementId: string }>> {
  requirePermission(staff, "stock.receive");
  if (!isUuid(itemId)) throw new NotFoundError("catalogue_item", itemId);
  const qty = parseQty(input.qty);
  const amount = parseAmount(input.amount);
  const supplierName = text(input.supplierName, "supplierName", 200, true)!;
  const supplierRef = text(input.supplierRef, "supplierRef", 100, true)!;
  const options = {
    name: "stock.receive",
    actor: actorOf(staff),
    idempotency: {
      key: idempotencyKey,
      payload: { itemId, qty: qty.toString(), amount: amount.toString(), supplierName, supplierRef },
    },
  };
  return runCommand(db, options, async (ctx) => {
    const item = await ctx.tx
      .selectFrom("catalogue_item")
      .select(["stock_tracked", "active"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item) throw new NotFoundError("catalogue_item", itemId);
    if (!item.stock_tracked) {
      throw new ConflictError("not_stock_tracked", "Only stock-tracked parts are received into stock", {
        reason: "not_stock_tracked",
      });
    }
    await ctx.locks.acquire("stock_balance", [itemId]);
    const balance = await ctx.tx
      .selectFrom("stock_balance")
      .selectAll()
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    const before = poolOfRow(balance);
    const after = poolIn(before, qty, amount);
    await ctx.tx.updateTable("stock_balance").set(poolColumns(after)).where("item_id", "=", itemId).execute();
    const movement = await ctx.tx
      .insertInto("stock_movement")
      .values({
        item_id: itemId,
        kind: "receipt",
        qty: qty.toString(),
        value: amount.toString(),
        supplier_name: supplierName,
        supplier_ref: supplierRef,
        revision_line_id: null,
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.audit({
      action: "stock.received",
      entityType: "catalogue_item",
      entityId: itemId,
      before: { qty: before.qty.toString(), value: before.value.toString() },
      after: { qty: after.qty.toString(), value: after.value.toString() },
      details: {
        movementId: movement.id,
        receivedQty: qty.toString(),
        amount: amount.toString(),
        supplierName,
        supplierRef,
      },
    });
    return { movementId: movement.id };
  });
}

// --------------------------------------------------------------------------- to a job line

/** The line with its job, repair order and part (unlocked read; callers lock and re-check). */
async function lineHead(db: Kysely<DB>, lineId: string) {
  if (!isUuid(lineId)) throw new NotFoundError("revision_line", lineId);
  const row = await db
    .selectFrom("revision_line")
    .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
    .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
    .select([
      "revision_line.id",
      "revision_line.catalogue_item_id",
      "repair_job.id as job_id",
      "repair_job.repair_order_id",
    ])
    .where("revision_line.id", "=", lineId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("revision_line", lineId);
  return row;
}

/** Locks repair order → line, and checks the line may receive parts (v0.2.1 §3.3 guard). */
async function lockLine(ctx: CommandContext, head: Awaited<ReturnType<typeof lineHead>>) {
  await ctx.locks.acquire("repair_order", [head.repair_order_id]);
  await ctx.locks.acquire("revision_line", [head.id]);
  const accepts = await sql<{ ok: boolean }>`SELECT line_accepts_parts(${head.id}::uuid) AS ok`.execute(
    ctx.tx,
  );
  if (!accepts.rows[0]?.ok) {
    throw new ConflictError(
      "line_not_issuable",
      "Parts go only to an approved, unchanged part line of running work",
      { reason: "line_not_issuable" },
    );
  }
  const line = await ctx.tx
    .selectFrom("revision_line")
    .select(["qty", "catalogue_item_id"])
    .where("id", "=", head.id)
    .executeTakeFirstOrThrow();
  const costed = await ctx.tx
    .selectFrom("line_cost_movement")
    .select(sql<string>`COALESCE(SUM(qty), 0)::text`.as("qty"))
    .where("revision_line_id", "=", head.id)
    .executeTakeFirstOrThrow();
  const wip = await ctx.tx
    .selectFrom("line_wip")
    .selectAll()
    .where("revision_line_id", "=", head.id)
    .executeTakeFirst();
  return {
    authorized: Qty.parse(line.qty),
    costed: Qty.parse(costed.qty),
    wip: wip ? poolOfRow(wip) : EMPTY_POOL,
    hasWip: Boolean(wip),
  };
}

/** v0.2.1 §3.3: more than the line authorizes is allowed only with a reason. */
function overReason(state: { authorized: Qty; costed: Qty }, qty: Qty, reason: string | null): string | null {
  if (state.costed.add(qty).compare(state.authorized) > 0 && !reason) {
    throw new ValidationError("More than the approved quantity needs a reason", { field: "overReason" });
  }
  return state.costed.add(qty).compare(state.authorized) > 0 ? reason : null;
}

async function addToLine(
  ctx: CommandContext,
  lineId: string,
  state: { wip: PoolState; hasWip: boolean },
  qty: Qty,
  value: Money,
): Promise<PoolState> {
  const after = poolIn(state.wip, qty, value);
  if (state.hasWip) {
    await ctx.tx
      .updateTable("line_wip")
      .set(poolColumns(after))
      .where("revision_line_id", "=", lineId)
      .execute();
  } else {
    await ctx.tx
      .insertInto("line_wip")
      .values({ revision_line_id: lineId, ...poolColumns(after) })
      .execute();
  }
  return after;
}

/** B2: Waiting parts → Approved when parts are received for the job. */
async function partsArrived(ctx: CommandContext, staff: Staff, jobId: string) {
  const job = await ctx.tx
    .selectFrom("repair_job")
    .select("execution_status")
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow();
  if (job.execution_status !== "waiting_parts") return;
  await ctx.tx
    .updateTable("repair_job")
    .set({ execution_status: "authorized", execution_reason: null, updated_by: staff.userId })
    .where("id", "=", jobId)
    .execute();
  await ctx.audit({
    action: "job.parts_arrived",
    entityType: "repair_job",
    entityId: jobId,
    before: { status: "waiting_parts" },
    after: { status: "authorized" },
  });
}

export async function issueFromStock(
  db: Kysely<DB>,
  staff: Staff,
  lineId: string,
  input: { qty?: unknown; overReason?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ movementId: string; cost: string }>> {
  requirePermission(staff, "stock.issue");
  const head = await lineHead(db, lineId);
  const qty = parseQty(input.qty);
  const reason = text(input.overReason, "overReason", 500, false);
  const options = {
    name: "stock.issue_to_line",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { lineId, qty: qty.toString(), reason } },
  };
  return runCommand(db, options, async (ctx) => {
    const state = await lockLine(ctx, head);
    const itemId = head.catalogue_item_id;
    const item = itemId
      ? await ctx.tx
          .selectFrom("catalogue_item")
          .select("stock_tracked")
          .where("id", "=", itemId)
          .executeTakeFirst()
      : undefined;
    if (!itemId || !item?.stock_tracked) {
      throw new ConflictError("not_stock_tracked", "This item is not kept in stock; use receive-and-issue", {
        reason: "not_stock_tracked",
      });
    }
    const why = overReason(state, qty, reason);
    await ctx.locks.acquire("stock_balance", [itemId]);
    const balance = await ctx.tx
      .selectFrom("stock_balance")
      .selectAll()
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    const stock = poolOfRow(balance);
    // PRD v0.2 §F: no negative stock; the user is offered Waiting parts or Receive-and-issue (AC2-13, AC2-14).
    if (qty.compare(stock.qty) > 0) {
      throw new ConflictError("insufficient_stock", `Only ${stock.qty.toString()} in stock`, {
        reason: "insufficient_stock",
      });
    }
    const out = poolOut(stock, qty);
    await ctx.tx
      .updateTable("stock_balance")
      .set(poolColumns(out.pool))
      .where("item_id", "=", itemId)
      .execute();
    const movement = await ctx.tx
      .insertInto("stock_movement")
      .values({
        item_id: itemId,
        kind: "issue",
        qty: qty.toString(),
        value: out.amount.toString(),
        supplier_name: null,
        supplier_ref: null,
        revision_line_id: lineId,
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto("line_cost_movement")
      .values({
        revision_line_id: lineId,
        kind: "stock_issue",
        qty: qty.toString(),
        value: out.amount.toString(),
        stock_movement_id: movement.id,
        supplier_name: null,
        supplier_ref: null,
        over_reason: why,
        created_by: staff.userId,
      })
      .execute();
    const wip = await addToLine(ctx, lineId, state, qty, out.amount);
    await ctx.audit({
      action: "stock.issued",
      entityType: "revision_line",
      entityId: lineId,
      after: {
        movementId: movement.id,
        itemId,
        qty: qty.toString(),
        cost: out.amount.toString(),
        stockAfter: { qty: out.pool.qty.toString(), value: out.pool.value.toString() },
        lineWip: { qty: wip.qty.toString(), value: wip.value.toString() },
        overReason: why,
      },
    });
    await partsArrived(ctx, staff, head.job_id);
    return { movementId: movement.id, cost: out.amount.toString() };
  });
}

/** Special-order part or non-stock item: supplier cost straight to the line (T-23, OD-30); stock unchanged. */
export async function receiveAndIssue(
  db: Kysely<DB>,
  staff: Staff,
  lineId: string,
  input: {
    qty?: unknown;
    amount?: unknown;
    supplierName?: unknown;
    supplierRef?: unknown;
    overReason?: unknown;
  },
  idempotencyKey: string,
): Promise<CommandOutcome<{ movementId: string }>> {
  requirePermission(staff, "stock.issue");
  const head = await lineHead(db, lineId);
  const qty = parseQty(input.qty);
  const amount = parseAmount(input.amount);
  const supplierName = text(input.supplierName, "supplierName", 200, true)!;
  const supplierRef = text(input.supplierRef, "supplierRef", 100, true)!;
  const reason = text(input.overReason, "overReason", 500, false);
  const options = {
    name: "stock.receive_and_issue",
    actor: actorOf(staff),
    idempotency: {
      key: idempotencyKey,
      payload: { lineId, qty: qty.toString(), amount: amount.toString(), supplierName, supplierRef, reason },
    },
  };
  return runCommand(db, options, async (ctx) => {
    const state = await lockLine(ctx, head);
    const why = overReason(state, qty, reason);
    const movement = await ctx.tx
      .insertInto("line_cost_movement")
      .values({
        revision_line_id: lineId,
        kind: "purchase",
        qty: qty.toString(),
        value: amount.toString(),
        stock_movement_id: null,
        supplier_name: supplierName,
        supplier_ref: supplierRef,
        over_reason: why,
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const wip = await addToLine(ctx, lineId, state, qty, amount);
    await ctx.audit({
      action: "stock.received_and_issued",
      entityType: "revision_line",
      entityId: lineId,
      after: {
        movementId: movement.id,
        qty: qty.toString(),
        amount: amount.toString(),
        supplierName,
        supplierRef,
        lineWip: { qty: wip.qty.toString(), value: wip.value.toString() },
        overReason: why,
      },
    });
    await partsArrived(ctx, staff, head.job_id);
    return { movementId: movement.id };
  });
}

// --------------------------------------------------------------------------- waiting parts

/** B2: Approved ↔ Waiting parts, by staff who handle parts (OD-29) or the job's assignee. */
async function waitingParts(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  to: "waiting_parts" | "authorized",
  idempotencyKey: string,
): Promise<CommandOutcome<{ jobId: string }>> {
  if (!isUuid(jobId)) throw new NotFoundError("repair_job", jobId);
  const job = await db
    .selectFrom("repair_job")
    .select(["repair_order_id"])
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!job) throw new NotFoundError("repair_job", jobId);
  if (!hasPermission(staff.roles, "stock.issue") && (await liveAssignee(db, jobId)) !== staff.userId) {
    throw new ForbiddenError("stock.issue");
  }
  const from = to === "waiting_parts" ? "authorized" : "waiting_parts";
  const options = {
    name: to === "waiting_parts" ? "job.mark_waiting_parts" : "job.clear_waiting_parts",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { jobId } },
  };
  return runCommand(db, options, async (ctx) => {
    await ctx.locks.acquire("repair_order", [job.repair_order_id]);
    const current = await ctx.tx
      .selectFrom("repair_job")
      .select("execution_status")
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    if (current.execution_status !== from) {
      throw new ConflictError("job_status_changed", `Job is ${current.execution_status}`, {
        reason: current.execution_status,
      });
    }
    await ctx.tx
      .updateTable("repair_job")
      .set({ execution_status: to, execution_reason: null, updated_by: staff.userId })
      .where("id", "=", jobId)
      .execute();
    await ctx.audit({
      action: to === "waiting_parts" ? "job.waiting_parts" : "job.parts_arrived",
      entityType: "repair_job",
      entityId: jobId,
      before: { status: from },
      after: { status: to },
    });
    return { jobId };
  });
}

export function markWaitingParts(db: Kysely<DB>, staff: Staff, jobId: string, idempotencyKey: string) {
  return waitingParts(db, staff, jobId, "waiting_parts", idempotencyKey);
}

export function clearWaitingParts(db: Kysely<DB>, staff: Staff, jobId: string, idempotencyKey: string) {
  return waitingParts(db, staff, jobId, "authorized", idempotencyKey);
}
