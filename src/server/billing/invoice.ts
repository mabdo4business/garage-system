import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { divRoundHalfUp, Money, Qty } from "../core/money";
import { poolOut, type PoolState } from "../core/pool";
import { taxCodeRateOn, taxProfileOn } from "../catalog/tax";
import type { DB } from "../db/schema";
import { authorizedScope } from "../estimate/approval";
import { requirePermission, type Staff } from "../estimate/commands";
import { rateHundredths } from "../estimate/pricing";
import { allocateNumber } from "../numbering/numbering";
import { currentBusinessProfile } from "../settings/business-profile";

/**
 * Invoices (I1-09a). A draft lists the lines to bill; issuing turns it into an immutable invoice with a number from
 * the gap-free `invoice` series (OD-40), in one transaction that also: checks the cap (net billed ≤ authorized,
 * v0.2.1 §5) under the revision-line locks, checks P0-06 (part lines need the stock issued or bought for them),
 * determines tax on the invoice business date (v0.2.1 §4.4, OD-41), moves part cost from WIP to COGS (T-28) and
 * makes the repair order Ready (B1). Locks: repair order → revision lines → number series.
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

interface SourceLine {
  id: string;
  job_id: string;
  line_type: string;
  description_en: string;
  description_ar: string;
  unit: string | null;
  qty: string;
  unit_price: string;
  gross: string;
  discount: string;
  line_total: string;
  net: string;
  vat: string;
  tax_code: string;
  tax_rate: string;
}

/** T-29: authorized lines of done jobs whose live outcome is "done" and that are not yet billed. */
async function billableLines(db: Kysely<DB>, repairOrderId: string): Promise<SourceLine[]> {
  const jobs = await db
    .selectFrom("repair_job")
    .select("id")
    .where("repair_order_id", "=", repairOrderId)
    .where("removed_at", "is", null)
    .where("execution_status", "=", "done")
    .execute();
  const result: SourceLine[] = [];
  for (const job of jobs) {
    const scope = await authorizedScope(db, job.id);
    if (scope.length === 0) continue;
    const lines = await db
      .selectFrom("revision_line")
      .innerJoin("job_line_outcome", (join) =>
        join
          .onRef("job_line_outcome.revision_line_id", "=", "revision_line.id")
          .on("job_line_outcome.superseded_at", "is", null)
          .on("job_line_outcome.outcome", "=", "done"),
      )
      .leftJoin("revision_line_billing", "revision_line_billing.revision_line_id", "revision_line.id")
      .selectAll("revision_line")
      .where("revision_line.id", "in", scope)
      .where((eb) =>
        eb.or([
          eb("revision_line_billing.net_billed_qty", "is", null),
          eb("revision_line_billing.net_billed_qty", "<", eb.ref("revision_line.qty")),
        ]),
      )
      .orderBy("revision_line.created_at")
      .execute();
    for (const line of lines) result.push({ ...line, job_id: job.id });
  }
  return result;
}

async function lockQcPassed(ctx: CommandContext, repairOrderId: string) {
  await ctx.locks.acquire("repair_order", [repairOrderId]);
  const ro = await ctx.tx
    .selectFrom("repair_order")
    .select(["status", "customer_id"])
    .where("id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro) throw new NotFoundError("repair_order", repairOrderId);
  const latest = await ctx.tx
    .selectFrom("qc_record")
    .select("status")
    .where("repair_order_id", "=", repairOrderId)
    .orderBy("requested_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (ro.status !== "qc" || latest?.status !== "passed") {
    throw new ConflictError("qc_not_passed", "The invoice follows a QC pass", { reason: "qc_not_passed" });
  }
  return ro;
}

// --------------------------------------------------------------------------- drafts

export async function createInvoiceDraft(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ draftId: string }>> {
  requirePermission(staff, "invoice.issue");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const options = {
    name: "invoice.draft",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId } },
  };
  return runCommand(db, options, async (ctx) => {
    await lockQcPassed(ctx, repairOrderId);
    const lines = await billableLines(ctx.tx, repairOrderId);
    if (lines.length === 0)
      throw new ConflictError("nothing_to_invoice", "There is no done, unbilled work to invoice");
    const draft = await ctx.tx
      .insertInto("invoice_draft")
      .values({ repair_order_id: repairOrderId, created_by: staff.userId, closed_at: null, closed_by: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto("invoice_draft_line")
      .values(lines.map((line) => ({ draft_id: draft.id, revision_line_id: line.id })))
      .execute();
    await ctx.audit({
      action: "invoice.drafted",
      entityType: "repair_order",
      entityId: repairOrderId,
      after: { draftId: draft.id, lines: lines.map((line) => line.id) },
    });
    return { draftId: draft.id };
  });
}

async function draftHead(db: Kysely<DB>, draftId: string) {
  if (!isUuid(draftId)) throw new NotFoundError("invoice_draft", draftId);
  const draft = await db
    .selectFrom("invoice_draft")
    .select(["id", "repair_order_id", "status"])
    .where("id", "=", draftId)
    .executeTakeFirst();
  if (!draft) throw new NotFoundError("invoice_draft", draftId);
  return draft;
}

export async function discardInvoiceDraft(
  db: Kysely<DB>,
  staff: Staff,
  draftId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ draftId: string }>> {
  requirePermission(staff, "invoice.issue");
  const head = await draftHead(db, draftId);
  const options = {
    name: "invoice.discard_draft",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { draftId } },
  };
  return runCommand(db, options, async (ctx) => {
    await ctx.locks.acquire("repair_order", [head.repair_order_id]);
    const draft = await ctx.tx
      .selectFrom("invoice_draft")
      .select("status")
      .where("id", "=", draftId)
      .executeTakeFirstOrThrow();
    if (draft.status !== "draft") throw new ConflictError("draft_closed", "This draft is no longer open");
    await ctx.tx
      .updateTable("invoice_draft")
      .set({ status: "discarded", closed_by: staff.userId, closed_at: ctx.txTime })
      .where("id", "=", draftId)
      .execute();
    await ctx.audit({
      action: "invoice.draft_deleted", // PRD v0.2 §D1's name; the draft row is kept as discarded, never deleted

      entityType: "repair_order",
      entityId: head.repair_order_id,
      after: { draftId },
    });
    return { draftId };
  });
}

// --------------------------------------------------------------------------- amounts

export interface InvoiceLineAmounts {
  revisionLineId: string;
  jobId: string;
  lineType: string;
  descriptionEn: string;
  descriptionAr: string;
  unit: string | null;
  qty: string;
  unitPrice: string;
  /** T-31: net ÷ qty, half-up to the fil (excl. VAT, after discount); reference only, `net` is authoritative. */
  unitPriceNet: string;
  gross: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
  taxCode: string;
  taxCategory: string;
  taxRate: string;
  /** OD-41: true when the tax position differs from what the customer approved. */
  taxChanged: boolean;
}

export interface InvoiceAmounts {
  registrationStatus: "not_registered" | "registered";
  trn: string | null;
  lines: InvoiceLineAmounts[];
  gross: string;
  discount: string;
  net: string;
  vat: string;
  total: string;
  taxChanged: boolean;
}

/**
 * Tax per line on the invoice business date (v0.2.1 §4.4, OD-41): unchanged tax position → the quoted line exactly
 * (OD-18); changed → the approved net with VAT = net × rate, half-up. Not registered: no VAT (AC2-19).
 */
async function invoiceAmounts(
  db: Kysely<DB>,
  lines: SourceLine[],
  businessDate: string,
): Promise<InvoiceAmounts> {
  const profile = await taxProfileOn(db, businessDate);
  if (!profile) throw new ConflictError("no_tax_profile", "No tax profile is in force");
  const registered = profile.registrationStatus === "registered";
  const categories = new Map(
    (await db.selectFrom("tax_code").select(["code", "category"]).execute()).map((row) => [
      row.code,
      row.category,
    ]),
  );
  const result: InvoiceLineAmounts[] = [];
  let gross = Money.ZERO;
  let discount = Money.ZERO;
  let net = Money.ZERO;
  let vat = Money.ZERO;
  for (const line of lines) {
    let rate = "0.00";
    if (registered) {
      const current = await taxCodeRateOn(db, line.tax_code, businessDate);
      if (current === null) {
        throw new ConflictError("no_tax_rate", `Tax code ${line.tax_code} has no rate in force`, {
          taxCode: line.tax_code,
        });
      }
      rate = current;
    }
    const changed = rate !== line.tax_rate;
    const lineNet = Money.parse(line.net);
    const lineVat = changed
      ? Money.fromFils(divRoundHalfUp(lineNet.fils * rateHundredths(rate), 10000n))
      : Money.parse(line.vat);
    const total = lineNet.add(lineVat);
    result.push({
      revisionLineId: line.id,
      jobId: line.job_id,
      lineType: line.line_type,
      descriptionEn: line.description_en,
      descriptionAr: line.description_ar,
      unit: line.unit,
      qty: line.qty,
      unitPrice: line.unit_price,
      unitPriceNet: Money.fromFils(
        divRoundHalfUp(lineNet.fils * 1000n, Qty.parse(line.qty).milli),
      ).toString(),
      gross: line.gross,
      discount: line.discount,
      net: lineNet.toString(),
      vat: lineVat.toString(),
      total: total.toString(),
      taxCode: line.tax_code,
      taxCategory: registered ? (categories.get(line.tax_code) ?? "standard") : "not_registered",
      taxRate: rate,
      taxChanged: changed,
    });
    gross = gross.add(Money.parse(line.gross));
    discount = discount.add(Money.parse(line.discount));
    net = net.add(lineNet);
    vat = vat.add(lineVat);
  }
  return {
    registrationStatus: profile.registrationStatus,
    trn: registered ? profile.trn : null,
    lines: result,
    gross: gross.toString(),
    discount: discount.toString(),
    net: net.toString(),
    vat: vat.toString(),
    total: net.add(vat).toString(),
    taxChanged: result.some((line) => line.taxChanged),
  };
}

async function draftLines(db: Kysely<DB>, draftId: string): Promise<SourceLine[]> {
  const rows = await db
    .selectFrom("invoice_draft_line")
    .innerJoin("revision_line", "revision_line.id", "invoice_draft_line.revision_line_id")
    .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
    .selectAll("revision_line")
    .select("job_revision.job_id")
    .where("invoice_draft_line.draft_id", "=", draftId)
    .orderBy("revision_line.created_at")
    .execute();
  return rows;
}

/** The draft as it would be issued today (screen preview). */
export async function invoicePreview(
  db: Kysely<DB>,
  draftId: string,
  businessDate: string,
): Promise<InvoiceAmounts | null> {
  if (!isUuid(draftId)) return null;
  const lines = await draftLines(db, draftId);
  if (lines.length === 0) return null;
  return invoiceAmounts(db, lines, businessDate);
}

// --------------------------------------------------------------------------- issue

export async function issueInvoice(
  db: Kysely<DB>,
  staff: Staff,
  draftId: string,
  input: { taxChangeNotice?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ invoiceId: string; number: string }>> {
  requirePermission(staff, "invoice.issue");
  const head = await draftHead(db, draftId);
  const notice = typeof input.taxChangeNotice === "string" ? input.taxChangeNotice.trim() : "";
  if (notice.length > 1000) throw new ValidationError("The notice is too long", { field: "taxChangeNotice" });
  const options = {
    name: "invoice.issue",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { draftId, notice } },
  };
  return runCommand(db, options, async (ctx) => {
    const ro = await lockQcPassed(ctx, head.repair_order_id);
    const draft = await ctx.tx
      .selectFrom("invoice_draft")
      .select("status")
      .where("id", "=", draftId)
      .executeTakeFirstOrThrow();
    if (draft.status !== "draft") throw new ConflictError("draft_closed", "This draft is no longer open");
    const lines = await draftLines(ctx.tx, draftId);
    await ctx.locks.acquire(
      "revision_line",
      lines.map((line) => line.id),
    );

    // Re-check under the locks: still billable (done outcome, authorized), the cap (AC21-02/04), P0-06 (AT-12).
    const billable = new Set((await billableLines(ctx.tx, head.repair_order_id)).map((line) => line.id));
    for (const line of lines) {
      if (!billable.has(line.id)) {
        throw new ConflictError(
          "invoice_cap",
          `Line "${line.description_en}" is already billed or no longer billable`,
          {
            reason: "invoice_cap",
          },
        );
      }
      if (line.line_type === "part") {
        const wip = await ctx.tx
          .selectFrom("line_wip")
          .select("qty")
          .where("revision_line_id", "=", line.id)
          .executeTakeFirst();
        const costed = await ctx.tx
          .selectFrom("line_cost_movement")
          .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("qty"), eb.val("0")).as("qty"))
          .where("revision_line_id", "=", line.id)
          .executeTakeFirstOrThrow();
        if (Qty.parse(String(costed.qty)).compare(Qty.parse(line.qty)) < 0 || !wip) {
          throw new ConflictError(
            "parts_not_issued",
            `Issue the parts for "${line.description_en}" first (P0-06)`,
            {
              reason: "parts_not_issued",
            },
          );
        }
      }
    }

    const amounts = await invoiceAmounts(ctx.tx, lines, ctx.businessDate);
    if (amounts.taxChanged && !notice) {
      throw new ValidationError("Tax changed since the customer approved: record that they were told", {
        field: "taxChangeNotice",
        reason: "tax_change_notice_required",
      });
    }

    // OD-47: nothing is printed without the garage details; refused before a number is taken. The database records
    // the latest version on the invoice (OD-46) and refuses the same.
    if (!(await currentBusinessProfile(ctx.tx))) {
      throw new ConflictError("no_business_profile", "A partner must enter the business profile first");
    }

    const invoiceId = randomUUID();
    const number = await allocateNumber(ctx, "invoice", { type: "invoice", id: invoiceId });
    await ctx.tx
      .insertInto("invoice")
      .values({
        id: invoiceId,
        number: number.text,
        repair_order_id: head.repair_order_id,
        customer_id: ro.customer_id,
        draft_id: draftId,
        registration_status: amounts.registrationStatus,
        trn: amounts.trn,
        gross: amounts.gross,
        discount: amounts.discount,
        net: amounts.net,
        vat: amounts.vat,
        total: amounts.total,
        tax_change_notice: amounts.taxChanged ? notice : null,
        issued_by: staff.userId,
      })
      .execute();

    for (const [position, line] of amounts.lines.entries()) {
      // T-28: part cost moves from WIP to COGS at the pool basis (amendment §A.1).
      let cogs: string | null = null;
      let wipAfter: PoolState | null = null;
      if (line.lineType === "part") {
        const wip = await ctx.tx
          .selectFrom("line_wip")
          .selectAll()
          .where("revision_line_id", "=", line.revisionLineId)
          .executeTakeFirstOrThrow();
        const out = poolOut(
          {
            qty: Qty.parse(wip.qty),
            value: Money.parse(wip.value),
            basisQty: Qty.parse(wip.basis_qty),
            basisValue: Money.parse(wip.basis_value),
          },
          Qty.parse(line.qty),
        );
        cogs = out.amount.toString();
        wipAfter = out.pool;
      }
      const inserted = await ctx.tx
        .insertInto("invoice_line")
        .values({
          invoice_id: invoiceId,
          position,
          revision_line_id: line.revisionLineId,
          job_id: line.jobId,
          description_en: line.descriptionEn,
          description_ar: line.descriptionAr,
          line_type: line.lineType,
          unit: line.unit,
          qty: line.qty,
          unit_price: line.unitPrice,
          unit_price_net: line.unitPriceNet,
          gross: line.gross,
          discount: line.discount,
          net: line.net,
          vat: line.vat,
          total: line.total,
          tax_code: line.taxCode,
          tax_category: line.taxCategory,
          tax_rate: line.taxRate,
          cogs,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const billing = await ctx.tx
        .selectFrom("revision_line_billing")
        .selectAll()
        .where("revision_line_id", "=", line.revisionLineId)
        .executeTakeFirst();
      if (billing) {
        await ctx.tx
          .updateTable("revision_line_billing")
          .set({
            net_billed_qty: Qty.parse(billing.net_billed_qty).add(Qty.parse(line.qty)).toString(),
            net_billed_net: Money.parse(billing.net_billed_net).add(Money.parse(line.net)).toString(),
          })
          .where("revision_line_id", "=", line.revisionLineId)
          .execute();
      } else {
        await ctx.tx
          .insertInto("revision_line_billing")
          .values({
            revision_line_id: line.revisionLineId,
            net_billed_qty: line.qty,
            net_billed_net: line.net,
          })
          .execute();
      }
      if (cogs !== null && wipAfter) {
        await ctx.tx
          .updateTable("line_wip")
          .set({
            qty: wipAfter.qty.toString(),
            value: wipAfter.value.toString(),
            basis_qty: wipAfter.basisQty.toString(),
            basis_value: wipAfter.basisValue.toString(),
          })
          .where("revision_line_id", "=", line.revisionLineId)
          .execute();
        await ctx.tx
          .insertInto("line_cogs_movement")
          .values({
            revision_line_id: line.revisionLineId,
            invoice_line_id: inserted.id,
            qty: line.qty,
            value: cogs,
          })
          .execute();
      }
    }

    await ctx.tx
      .updateTable("invoice_draft")
      .set({ status: "issued", closed_by: staff.userId, closed_at: ctx.txTime })
      .where("id", "=", draftId)
      .execute();
    await ctx.tx
      .updateTable("repair_order")
      .set({ status: "ready" })
      .where("id", "=", head.repair_order_id)
      .execute();
    await ctx.audit({
      action: "invoice.issued",
      entityType: "invoice",
      entityId: invoiceId,
      after: {
        number: number.text,
        repairOrderId: head.repair_order_id,
        total: amounts.total,
        vat: amounts.vat,
        registrationStatus: amounts.registrationStatus,
        taxChangeNotice: amounts.taxChanged ? notice : null,
        lines: amounts.lines.map((line) => line.revisionLineId),
      },
    });
    await ctx.audit({
      action: "ro.ready",
      entityType: "repair_order",
      entityId: head.repair_order_id,
      before: { status: "qc" },
      after: { status: "ready", invoice: number.text },
    });
    return { invoiceId, number: number.text };
  });
}
