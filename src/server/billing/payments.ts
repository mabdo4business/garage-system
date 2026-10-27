import type { Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import {
  runCommand,
  type CommandContext,
  type CommandOutcome,
  type RunCommandOptions,
} from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { Money } from "../core/money";
import type { DB, PaymentMethod, RepairOrderStatus } from "../db/schema";
import { requirePermission, type Staff } from "../estimate/commands";

/**
 * Payments and handover (I1-10). PRD v0.2 §D2: a payment is recorded against the issued invoice, 0 < amount ≤
 * balance due (AC2-21, no rounding OD-52), card and transfer need their reference and never a card number (AC2-22,
 * OD-51), one per idempotency key (AC2-20, AT-03). §B1: Ready → Delivered with balance 0, or with a partner's release
 * override and a reason (AC2-27, OD-53) that alerts the partners; Delivered → Closed once the balance is 0.
 * Balance due = invoice total − payments until credit notes, refunds and reversals arrive (I3). Locks: the repair order —
 * every command that changes an invoice's balance (payments here; credit notes, refunds and reversals in I3) takes it
 * first, so the balance read under it holds. The invoice row itself is insert-only (rule 6) and cannot be row-locked by
 * the app role. The database guards (migration 0019) check the same rules again.
 */

export const PAYMENT_METHODS = ["cash", "card", "transfer"] as const satisfies readonly PaymentMethod[];
/** AC2-20: a same-amount payment on the same invoice within this window under a new key needs confirming. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

export interface PaymentInput {
  amount?: unknown;
  method?: unknown;
  reference?: unknown;
  /** The user saw the "possible duplicate" warning and confirmed (AC2-20). */
  confirmDuplicate?: unknown;
}

function parsePayment(input: PaymentInput): {
  amount: Money;
  method: PaymentMethod;
  reference: string | null;
  confirmDuplicate: boolean;
} {
  let amount: Money;
  try {
    amount = Money.parse(input.amount);
  } catch {
    throw new ValidationError("Enter the amount", { field: "amount" });
  }
  if (amount.compare(Money.ZERO) <= 0) throw new ValidationError("Enter the amount", { field: "amount" });
  const method = input.method;
  if (typeof method !== "string" || !(PAYMENT_METHODS as readonly string[]).includes(method)) {
    throw new ValidationError("Choose the payment method", { field: "method" });
  }
  const raw = typeof input.reference === "string" ? input.reference.trim() : "";
  let reference: string | null = null;
  if (method === "card") {
    // AC2-22: no approval code, no card payment. T-36: 4–12 letters or digits (never a card number).
    if (!/^[A-Za-z0-9]{4,12}$/.test(raw))
      throw new ValidationError("Enter the approval code", { field: "approvalCode" });
    reference = raw.toUpperCase();
  } else if (method === "transfer") {
    if (raw.length < 3 || raw.length > 40) {
      throw new ValidationError("Enter the transfer reference", { field: "transferReference" });
    }
    reference = raw;
  }
  return {
    amount,
    method: method as PaymentMethod,
    reference,
    confirmDuplicate: input.confirmDuplicate === true,
  };
}

interface LockedSettlement {
  repairOrderId: string;
  number: string;
  status: RepairOrderStatus;
  invoiceId: string;
  invoiceNumber: string;
  total: Money;
  balance: Money;
}

/**
 * Locks the repair order and reads the balance of its invoice under that lock — the given invoice when there is one
 * (a payment is checked against the invoice it is recorded on). One invoice per repair order until I3-02.
 */
async function lockSettlement(
  ctx: CommandContext,
  repairOrderId: string,
  invoiceId?: string,
): Promise<LockedSettlement> {
  await ctx.locks.acquire("repair_order", [repairOrderId]);
  const ro = await ctx.tx
    .selectFrom("repair_order")
    .select(["status", "number"])
    .where("id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro) throw new NotFoundError("repair_order", repairOrderId);
  let query = ctx.tx
    .selectFrom("invoice")
    .select(["id", "number", "total"])
    .where("repair_order_id", "=", repairOrderId);
  if (invoiceId) query = query.where("id", "=", invoiceId);
  const invoices = await query.execute();
  if (invoices.length > 1) throw new Error("More than one invoice per repair order arrives with I3-02");
  const invoice = invoices[0];
  if (!invoice) {
    if (invoiceId) throw new NotFoundError("invoice", invoiceId);
    throw new ConflictError("no_invoice", "This repair order has no issued invoice");
  }
  const total = Money.parse(invoice.total);
  return {
    repairOrderId,
    number: ro.number,
    status: ro.status,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    total,
    balance: total.sub(await paidOn(ctx.tx, invoice.id)),
  };
}

async function paidOn(db: Kysely<DB>, invoiceId: string): Promise<Money> {
  const rows = await db.selectFrom("payment").select("amount").where("invoice_id", "=", invoiceId).execute();
  return rows.reduce((sum, row) => sum.add(Money.parse(row.amount)), Money.ZERO);
}

async function closeIfPaid(ctx: CommandContext, settled: LockedSettlement, balance: Money): Promise<boolean> {
  if (!balance.isZero()) return false;
  await ctx.tx
    .updateTable("repair_order")
    .set({ status: "closed" })
    .where("id", "=", settled.repairOrderId)
    .execute();
  await ctx.audit({
    action: "ro.closed",
    entityType: "repair_order",
    entityId: settled.repairOrderId,
    before: { status: "delivered" },
    after: { status: "closed" },
  });
  return true;
}

// --------------------------------------------------------------------------- payments

export async function recordPayment(
  db: Kysely<DB>,
  staff: Staff,
  invoiceId: string,
  input: PaymentInput,
  idempotencyKey: string,
  /** Test-only fault injection. */
  hooks?: RunCommandOptions["hooks"],
): Promise<CommandOutcome<{ paymentId: string; balance: string; closed: boolean }>> {
  requirePermission(staff, "payment.record");
  if (!isUuid(invoiceId)) throw new NotFoundError("invoice", invoiceId);
  if (!isUuid(idempotencyKey))
    throw new ValidationError("Missing form key — reload the page", { field: "idempotencyKey" });
  const payment = parsePayment(input);
  const head = await db
    .selectFrom("invoice")
    .select("repair_order_id")
    .where("id", "=", invoiceId)
    .executeTakeFirst();
  if (!head) throw new NotFoundError("invoice", invoiceId);
  const options = {
    name: "billing.record_payment",
    actor: actorOf(staff),
    idempotency: {
      key: idempotencyKey,
      payload: {
        invoiceId,
        amount: payment.amount.toString(),
        method: payment.method,
        reference: payment.reference,
        confirmDuplicate: payment.confirmDuplicate,
      },
    },
    hooks,
  };
  return runCommand(db, options, async (ctx) => {
    const settled = await lockSettlement(ctx, head.repair_order_id, invoiceId);
    if (settled.status !== "ready" && settled.status !== "delivered") {
      throw new ConflictError("not_payable", "Payments are taken once the repair order is Ready");
    }
    // AC2-21: no overpayment.
    if (payment.amount.compare(settled.balance) > 0) {
      throw new ConflictError("amount_exceeds_balance", `Amount exceeds balance due (${settled.balance})`, {
        balance: settled.balance.toString(),
      });
    }
    // AC2-20: a second payment of the same amount within two minutes under another key asks for confirmation.
    if (!payment.confirmDuplicate) {
      const recent = await ctx.tx
        .selectFrom("payment")
        .select("id")
        .where("invoice_id", "=", invoiceId)
        .where("amount", "=", payment.amount.toString())
        .where("recorded_at", ">", new Date(ctx.txTime.getTime() - DUPLICATE_WINDOW_MS))
        .executeTakeFirst();
      if (recent) {
        throw new ConflictError("possible_duplicate", "A payment of this amount was just recorded", {
          amount: payment.amount.toString(),
        });
      }
    }
    const inserted = await ctx.tx
      .insertInto("payment")
      .values({
        invoice_id: invoiceId,
        repair_order_id: settled.repairOrderId,
        amount: payment.amount.toString(),
        method: payment.method,
        reference: payment.reference,
        idempotency_key: idempotencyKey,
        recorded_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const balance = settled.balance.sub(payment.amount);
    await ctx.audit({
      action: "payment.recorded",
      entityType: "payment",
      entityId: inserted.id,
      after: {
        invoice: settled.invoiceNumber,
        amount: payment.amount.toString(),
        method: payment.method,
        reference: payment.reference,
        balance: balance.toString(),
      },
    });
    const closed = settled.status === "delivered" ? await closeIfPaid(ctx, settled, balance) : false;
    return { paymentId: inserted.id, balance: balance.toString(), closed };
  });
}

// --------------------------------------------------------------------------- delivery

export interface DeliveryInput {
  keysReturned?: unknown;
  belongingsReturned?: unknown;
  overrideReason?: unknown;
}

export async function deliverVehicle(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: DeliveryInput,
  idempotencyKey: string,
  /** Test-only fault injection. */
  hooks?: RunCommandOptions["hooks"],
): Promise<CommandOutcome<{ status: "delivered" | "closed"; balance: string; override: boolean }>> {
  requirePermission(staff, "repair_order.deliver");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  // OD-54: keys and belongings handed back.
  if (input.keysReturned !== true) throw new ValidationError("Confirm the keys", { field: "keysReturned" });
  if (input.belongingsReturned !== true) {
    throw new ValidationError("Confirm the belongings", { field: "belongingsReturned" });
  }
  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim() : "";
  if (reason.length > 500) throw new ValidationError("The reason is too long", { field: "overrideReason" });
  const options = {
    name: "repair_order.deliver",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId, reason } },
    hooks,
  };
  return runCommand(db, options, async (ctx) => {
    const settled = await lockSettlement(ctx, repairOrderId);
    if (settled.status !== "ready")
      throw new ConflictError("not_ready", "Only a Ready vehicle is handed over");
    const override = !settled.balance.isZero();
    if (override) {
      // AC2-27 / OD-53: a balance due blocks delivery unless a partner releases it with a reason.
      if (!hasPermission(staff.roles, "repair_order.release_with_balance")) {
        throw new ConflictError("balance_due", `Balance due (${settled.balance})`, {
          balance: settled.balance.toString(),
        });
      }
      if (!reason)
        throw new ValidationError("Give the reason for releasing with a balance", {
          field: "overrideReason",
        });
    }
    await ctx.tx
      .insertInto("vehicle_delivery")
      .values({
        repair_order_id: repairOrderId,
        keys_returned: true,
        belongings_returned: true,
        override_reason: override ? reason : null,
        delivered_by: staff.userId,
      })
      .execute();
    await ctx.tx
      .updateTable("repair_order")
      .set({ status: "delivered" })
      .where("id", "=", repairOrderId)
      .execute();
    await ctx.audit({
      action: "ro.delivered",
      entityType: "repair_order",
      entityId: repairOrderId,
      before: { status: "ready" },
      after: { status: "delivered", balance: settled.balance.toString() },
    });
    if (override) {
      await ctx.audit({
        action: "ro.release_override",
        entityType: "repair_order",
        entityId: repairOrderId,
        after: { balance: settled.balance.toString(), reason, invoice: settled.invoiceNumber },
      });
      // AC2-27: both partners are alerted. Sent by the outbox worker (I2-09) through messaging (I6-06); until then
      // partners see it on the dashboard.
      await ctx.enqueue("alert.release_override", {
        repairOrderId,
        number: settled.number,
        invoice: settled.invoiceNumber,
        balance: settled.balance.toString(),
        releasedBy: staff.userId,
      });
      return { status: "delivered" as const, balance: settled.balance.toString(), override };
    }
    await closeIfPaid(ctx, settled, settled.balance);
    return { status: "closed" as const, balance: settled.balance.toString(), override };
  });
}

// --------------------------------------------------------------------------- reads

export interface PaymentRow {
  id: string;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  recordedByName: string | null;
  recordedAt: Date;
}

export interface Settlement {
  invoice: { id: string; number: string; total: string };
  paid: string;
  balance: string;
  payments: PaymentRow[];
  delivery: {
    deliveredAt: Date;
    deliveredByName: string | null;
    balanceDue: string;
    overrideReason: string | null;
  } | null;
}

/** The repair order's invoice, payments, balance and handover; null before an invoice is issued. */
export async function settlementOf(db: Kysely<DB>, repairOrderId: string): Promise<Settlement | null> {
  if (!isUuid(repairOrderId)) return null;
  const invoice = await db
    .selectFrom("invoice")
    .select(["id", "number", "total"])
    .where("repair_order_id", "=", repairOrderId)
    .executeTakeFirst();
  if (!invoice) return null;
  const payments = await db
    .selectFrom("payment")
    .leftJoin("app_user", "app_user.id", "payment.recorded_by")
    .select([
      "payment.id",
      "payment.amount",
      "payment.method",
      "payment.reference",
      "payment.recorded_at",
      "app_user.display_name",
    ])
    .where("payment.invoice_id", "=", invoice.id)
    .orderBy("payment.recorded_at")
    .orderBy("payment.id")
    .execute();
  const paid = payments.reduce((sum, row) => sum.add(Money.parse(row.amount)), Money.ZERO);
  const delivery = await db
    .selectFrom("vehicle_delivery")
    .leftJoin("app_user", "app_user.id", "vehicle_delivery.delivered_by")
    .select([
      "vehicle_delivery.delivered_at",
      "vehicle_delivery.balance_due",
      "vehicle_delivery.override_reason",
      "app_user.display_name",
    ])
    .where("vehicle_delivery.repair_order_id", "=", repairOrderId)
    .executeTakeFirst();
  return {
    invoice: { id: invoice.id, number: invoice.number, total: invoice.total },
    paid: paid.toString(),
    balance: Money.parse(invoice.total).sub(paid).toString(),
    payments: payments.map((row) => ({
      id: row.id,
      amount: row.amount,
      method: row.method,
      reference: row.reference,
      recordedByName: row.display_name,
      recordedAt: row.recorded_at,
    })),
    delivery: delivery
      ? {
          deliveredAt: delivery.delivered_at,
          deliveredByName: delivery.display_name,
          balanceDue: delivery.balance_due,
          overrideReason: delivery.override_reason,
        }
      : null,
  };
}

/** Balance due per repair order (orders without an invoice are absent). */
export async function balancesFor(db: Kysely<DB>, repairOrderIds: string[]): Promise<Map<string, string>> {
  const ids = repairOrderIds.filter(isUuid);
  if (ids.length === 0) return new Map();
  const invoices = await db
    .selectFrom("invoice")
    .select(["id", "repair_order_id", "total"])
    .where("repair_order_id", "in", ids)
    .execute();
  const paid = invoices.length
    ? await db
        .selectFrom("payment")
        .select(["invoice_id", "amount"])
        .where(
          "invoice_id",
          "in",
          invoices.map((row) => row.id),
        )
        .execute()
    : [];
  return new Map(
    invoices.map((row) => [
      row.repair_order_id,
      paid
        .filter((payment) => payment.invoice_id === row.id)
        .reduce((balance, payment) => balance.sub(Money.parse(payment.amount)), Money.parse(row.total))
        .toString(),
    ]),
  );
}

export interface ReleaseOverride {
  repairOrderId: string;
  number: string;
  balanceAtDelivery: string;
  /** What is still due now (payments after delivery reduce it). */
  balanceNow: string;
  reason: string;
  deliveredByName: string | null;
  deliveredAt: Date;
  businessDate: string;
}

/** Releases with a balance due between two business dates, inclusive (AC2-27 weekly exceptions list). */
export async function releaseOverrides(db: Kysely<DB>, from: string, to: string): Promise<ReleaseOverride[]> {
  const rows = await db
    .selectFrom("vehicle_delivery")
    .innerJoin("repair_order", "repair_order.id", "vehicle_delivery.repair_order_id")
    .leftJoin("app_user", "app_user.id", "vehicle_delivery.delivered_by")
    .select([
      "vehicle_delivery.repair_order_id",
      "repair_order.number",
      "vehicle_delivery.balance_due",
      "vehicle_delivery.override_reason",
      "vehicle_delivery.delivered_at",
      "vehicle_delivery.business_date",
      "app_user.display_name",
    ])
    .where("vehicle_delivery.override_reason", "is not", null)
    .where("vehicle_delivery.business_date", ">=", from)
    .where("vehicle_delivery.business_date", "<=", to)
    .orderBy("vehicle_delivery.delivered_at")
    .execute();
  const balances = await balancesFor(
    db,
    rows.map((row) => row.repair_order_id),
  );
  return rows.map((row) => ({
    repairOrderId: row.repair_order_id,
    number: row.number,
    balanceAtDelivery: row.balance_due,
    balanceNow: balances.get(row.repair_order_id) ?? "0.00",
    reason: row.override_reason!,
    deliveredByName: row.display_name,
    deliveredAt: row.delivered_at,
    businessDate: row.business_date,
  }));
}
