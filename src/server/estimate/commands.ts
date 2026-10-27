import type { Kysely } from "kysely";
import { hasPermission, type Permission } from "../auth/permissions";
import type { SessionUser } from "../auth/session";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { Money, Qty } from "../core/money";
import { priceInForce } from "../catalog/items";
import { taxCodeRateOn, taxProfileOn } from "../catalog/tax";
import type { DB, RevisionLineType } from "../db/schema";
import { computeLine, parseDiscount, parseQty } from "./pricing";

/**
 * Estimate drafts (I1-05a): jobs, their original revisions and lines (v0.2.1 §2), totals (AC-06.1).
 * Every command locks the repair order first (T-19), so all edits of one estimate are serialised, and
 * re-checks inside the transaction that the draft is still open. Sending and approval are I1-05b; later
 * versions, withdrawal and expiry are I2-01 (versions.ts).
 */

export type Staff = Pick<SessionUser, "userId" | "roles">;

/** Version 1 is started while the car is checked in or diagnosed. */
const OPEN_FOR_ESTIMATE = ["checked_in", "diagnosing"] as const;
/** A draft (version 2 onwards too, OD-56) is edited until QC: Awaiting approval and In progress as well. */
export const OPEN_FOR_DRAFT = ["checked_in", "diagnosing", "awaiting_approval", "in_progress"] as const;
const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

export function requirePermission(staff: Staff, permission: Permission): void {
  if (!hasPermission(staff.roles, permission)) throw new ForbiddenError(permission);
}

function requiredText(value: unknown, field: string, max: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length < 1 || trimmed.length > max)
    throw new ValidationError(`${field} is required`, { field });
  return trimmed;
}

/** Locks the repair order and checks it can still be estimated. */
export async function lockRepairOrder(
  ctx: CommandContext,
  repairOrderId: string,
  allowed: readonly string[] = OPEN_FOR_DRAFT,
) {
  await ctx.locks.acquire("repair_order", [repairOrderId]);
  const ro = await ctx.tx
    .selectFrom("repair_order")
    .select(["id", "status"])
    .where("id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro) throw new NotFoundError("repair_order", repairOrderId);
  if (!allowed.includes(ro.status)) {
    throw new ConflictError("estimate_closed", `Repair order is ${ro.status}`, { status: ro.status });
  }
  return ro;
}

/** The repair order's draft version, if it has one (callers hold the repair-order lock). */
export async function draftOf(ctx: CommandContext, repairOrderId: string) {
  return ctx.tx
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select(["estimate_version.id", "estimate.id as estimate_id"])
    .where("estimate.repair_order_id", "=", repairOrderId)
    .where("estimate_version.status", "=", "draft")
    .executeTakeFirst();
}

/** Locks the repair order and returns its open draft version. */
export async function lockDraft(ctx: CommandContext, repairOrderId: string) {
  await lockRepairOrder(ctx, repairOrderId);
  const draft = await draftOf(ctx, repairOrderId);
  if (!draft) throw new ConflictError("no_draft", "The estimate has no open draft");
  return { versionId: draft.id, estimateId: draft.estimate_id };
}

/** OD-22: only labour hours and parts sold by litre, kg or metre may be fractional. */
const FRACTIONAL_UNITS: readonly (string | null)[] = ["hour", "litre", "kg", "metre"];

export function requireAllowedQty(qty: Qty, unit: string | null): void {
  if (qty.milli % 1000n !== 0n && !FRACTIONAL_UNITS.includes(unit)) {
    throw new ValidationError("This item is counted in whole numbers", {
      field: "qty",
      reason: "whole_number",
    });
  }
}

/** The repair order a job belongs to (unlocked read; callers lock and re-read). */
export async function repairOrderOfJob(db: Kysely<DB>, jobId: string): Promise<string> {
  if (!isUuid(jobId)) throw new NotFoundError("repair_job", jobId);
  const row = await db
    .selectFrom("repair_job")
    .select("repair_order_id")
    .where("id", "=", jobId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("repair_job", jobId);
  return row.repair_order_id;
}

async function repairOrderOfLine(db: Kysely<DB>, lineId: string): Promise<string> {
  if (!isUuid(lineId)) throw new NotFoundError("revision_line", lineId);
  const row = await db
    .selectFrom("revision_line")
    .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
    .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
    .select("repair_job.repair_order_id")
    .where("revision_line.id", "=", lineId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("revision_line", lineId);
  return row.repair_order_id;
}

/** A live job of this draft with its draft revision. */
async function draftJob(ctx: CommandContext, jobId: string, versionId: string) {
  const job = await ctx.tx
    .selectFrom("repair_job")
    .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
    .select([
      "repair_job.id",
      "repair_job.title",
      "repair_job.finding_id",
      "repair_job.removed_at",
      "job_revision.id as revision_id",
      "job_revision.revision_no",
    ])
    .where("repair_job.id", "=", jobId)
    .where("job_revision.status", "=", "draft")
    .where("job_revision.proposed_in_version_id", "=", versionId)
    .executeTakeFirst();
  if (!job || job.removed_at) throw new NotFoundError("repair_job", jobId);
  return job;
}

/** Creates a job with its Original revision in the draft. */
async function insertJob(
  ctx: CommandContext,
  staff: Staff,
  input: { repairOrderId: string; versionId: string; title: string; findingId: string | null },
) {
  const job = await ctx.tx
    .insertInto("repair_job")
    .values({
      repair_order_id: input.repairOrderId,
      title: input.title,
      finding_id: input.findingId,
      created_by: staff.userId,
      updated_by: staff.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.tx
    .insertInto("job_revision")
    .values({
      job_id: job.id,
      revision_no: 1,
      kind: "original",
      proposed_in_version_id: input.versionId,
      lapse_reason: null,
      created_by: staff.userId,
    })
    .execute();
  return job.id;
}

// --------------------------------------------------------------------------- open

/**
 * Starts the estimate (version 1, draft). Refused while no tax profile is in force, because lines could
 * not be priced. Every active urgent finding becomes a job straight away: "pre-selected" (AC-05.2).
 */
export async function openEstimate(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ estimateId: string; versionId: string }>> {
  requirePermission(staff, "estimate.edit");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const options = {
    name: "estimate.open",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId } },
  };
  return runCommand(db, options, async (ctx) => {
    await lockRepairOrder(ctx, repairOrderId, OPEN_FOR_ESTIMATE);
    const existing = await ctx.tx
      .selectFrom("estimate")
      .select("id")
      .where("repair_order_id", "=", repairOrderId)
      .executeTakeFirst();
    if (existing) throw new ConflictError("estimate_exists", "This repair order already has an estimate");
    if (!(await taxProfileOn(ctx.tx, ctx.businessDate))) {
      throw new ConflictError("no_tax_profile", "No tax profile is in force; a partner must set it first");
    }

    const estimate = await ctx.tx
      .insertInto("estimate")
      .values({ repair_order_id: repairOrderId, created_by: staff.userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    const version = await ctx.tx
      .insertInto("estimate_version")
      .values({ estimate_id: estimate.id, version_no: 1, created_by: staff.userId })
      .returning("id")
      .executeTakeFirstOrThrow();

    const urgent = await ctx.tx
      .selectFrom("finding")
      .select(["id", "title"])
      .where("repair_order_id", "=", repairOrderId)
      .where("status", "=", "active")
      .where("severity", "=", "urgent")
      .orderBy("recorded_at")
      .execute();
    const jobs: { jobId: string; findingId: string }[] = [];
    for (const finding of urgent) {
      const jobId = await insertJob(ctx, staff, {
        repairOrderId,
        versionId: version.id,
        title: finding.title,
        findingId: finding.id,
      });
      jobs.push({ jobId, findingId: finding.id });
    }

    await ctx.audit({
      action: "estimate.opened",
      entityType: "repair_order",
      entityId: repairOrderId,
      after: { estimateId: estimate.id, versionId: version.id, versionNo: 1, preselectedUrgentJobs: jobs },
    });
    return { estimateId: estimate.id, versionId: version.id };
  });
}

// --------------------------------------------------------------------------- jobs

/** Adds a job, optionally addressing a finding of this repair order (clears its exclusion, if any). */
export async function addJob(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: { title?: unknown; findingId?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ jobId: string }>> {
  requirePermission(staff, "estimate.edit");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const findingId = typeof input.findingId === "string" && input.findingId !== "" ? input.findingId : null;
  if (findingId !== null && !isUuid(findingId))
    throw new ValidationError("Unknown finding", { field: "findingId" });
  const typedTitle = typeof input.title === "string" ? input.title.trim() : "";
  if (findingId === null) requiredText(typedTitle, "title", 200);
  if (typedTitle.length > 200) throw new ValidationError("title is too long", { field: "title" });

  return runCommand(
    db,
    {
      name: "estimate.add_job",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { repairOrderId, title: typedTitle, findingId } },
    },
    async (ctx) => {
      const { versionId } = await lockDraft(ctx, repairOrderId);
      let title = typedTitle;
      let cleared: { id: string; reason: string } | undefined;
      if (findingId !== null) {
        const finding = await ctx.tx
          .selectFrom("finding")
          .select(["title"])
          .where("id", "=", findingId)
          .where("repair_order_id", "=", repairOrderId)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!finding) throw new ValidationError("Unknown finding", { field: "findingId" });
        const taken = await ctx.tx
          .selectFrom("repair_job")
          .select("id")
          .where("finding_id", "=", findingId)
          .where("removed_at", "is", null)
          .executeTakeFirst();
        if (taken) throw new ConflictError("finding_already_included", "This finding already has a job");
        title ||= finding.title;
        cleared = await ctx.tx
          .updateTable("urgent_finding_exclusion")
          .set({ cleared_at: ctx.txTime, cleared_by: staff.userId })
          .where("estimate_version_id", "=", versionId)
          .where("finding_id", "=", findingId)
          .where("cleared_at", "is", null)
          .returning(["id", "reason"])
          .executeTakeFirst();
      }
      const jobId = await insertJob(ctx, staff, { repairOrderId, versionId, title, findingId });
      await ctx.audit({
        action: "estimate.job_added",
        entityType: "repair_job",
        entityId: jobId,
        after: { repairOrderId, versionId, title, findingId },
        details: cleared ? { clearedExclusion: { id: cleared.id, reason: cleared.reason } } : null,
      });
      return { jobId };
    },
  );
}

/**
 * OD-23: an urgent finding recorded (or raised to urgent) while a draft estimate is open joins it as a job,
 * "pre-selected" like the ones present when the estimate started (AC-05.2). Unless the finding already has
 * a job or a recorded exclusion. Runs inside the inspection command, which holds the repair-order lock.
 */
export async function preselectUrgentFinding(
  ctx: CommandContext,
  staff: Staff,
  repairOrderId: string,
  finding: { id: string; title: string },
): Promise<string | null> {
  const draft = await draftOf(ctx, repairOrderId);
  if (!draft) return null;
  const job = await ctx.tx
    .selectFrom("repair_job")
    .select("id")
    .where("finding_id", "=", finding.id)
    .where("removed_at", "is", null)
    .executeTakeFirst();
  const exclusion = await ctx.tx
    .selectFrom("urgent_finding_exclusion")
    .select("id")
    .where("estimate_version_id", "=", draft.id)
    .where("finding_id", "=", finding.id)
    .where("cleared_at", "is", null)
    .executeTakeFirst();
  if (job || exclusion) return null;
  const jobId = await insertJob(ctx, staff, {
    repairOrderId,
    versionId: draft.id,
    title: finding.title,
    findingId: finding.id,
  });
  await ctx.audit({
    action: "estimate.job_added",
    entityType: "repair_job",
    entityId: jobId,
    after: { repairOrderId, versionId: draft.id, title: finding.title, findingId: finding.id },
    details: { preselectedUrgentFinding: true },
  });
  return jobId;
}

/**
 * Removes a draft job (never deleted). Removing the job of an urgent finding needs a reason, recorded as
 * the finding's exclusion (AC-05.2). A job offered again (I2-01) keeps its history: only its draft revision
 * is taken out (Discarded).
 */
export async function removeJob(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  input: { reason?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ jobId: string }>> {
  requirePermission(staff, "estimate.edit");
  const repairOrderId = await repairOrderOfJob(db, jobId);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length > 500) throw new ValidationError("reason is too long", { field: "reason" });
  const options = {
    name: "estimate.remove_job",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { jobId, reason } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    const job = await draftJob(ctx, jobId, versionId);
    let excluded = false;
    if (job.finding_id) {
      const finding = await ctx.tx
        .selectFrom("finding")
        .select(["severity", "status"])
        .where("id", "=", job.finding_id)
        .executeTakeFirstOrThrow();
      if (finding.status === "active" && finding.severity === "urgent") {
        if (!reason) throw new ValidationError("Say why the urgent finding is left out", { field: "reason" });
        excluded = true;
      }
    }
    const reoffered = job.revision_no > 1;
    if (reoffered) {
      await ctx.tx
        .updateTable("job_revision")
        .set({ status: "discarded" })
        .where("id", "=", job.revision_id)
        .execute();
    } else {
      await ctx.tx
        .updateTable("repair_job")
        .set({ removed_at: ctx.txTime, removed_by: staff.userId, updated_by: staff.userId })
        .where("id", "=", jobId)
        .execute();
    }
    // A reason may already stand for this version (left out, then offered again): it is kept, not doubled.
    const standing =
      excluded &&
      (await ctx.tx
        .selectFrom("urgent_finding_exclusion")
        .select("id")
        .where("estimate_version_id", "=", versionId)
        .where("finding_id", "=", job.finding_id!)
        .where("cleared_at", "is", null)
        .executeTakeFirst());
    if (excluded && !standing) {
      await ctx.tx
        .insertInto("urgent_finding_exclusion")
        .values({
          estimate_version_id: versionId,
          finding_id: job.finding_id!,
          reason,
          created_by: staff.userId,
        })
        .execute();
    }
    await ctx.audit({
      action: "estimate.job_removed",
      entityType: "repair_job",
      entityId: jobId,
      before: { title: job.title, findingId: job.finding_id, revisionId: job.revision_id },
      details:
        reoffered || excluded
          ? {
              ...(reoffered ? { revisionDiscarded: job.revision_id } : {}),
              ...(excluded ? { urgentFindingExcluded: job.finding_id, reason } : {}),
            }
          : null,
    });
    return { jobId };
  });
}

/** Records why an urgent finding that has no job is left out of the estimate (AC-05.2). */
export async function excludeUrgentFinding(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: { findingId?: unknown; reason?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ findingId: string }>> {
  requirePermission(staff, "estimate.edit");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const findingId = typeof input.findingId === "string" ? input.findingId : "";
  if (!isUuid(findingId)) throw new ValidationError("Unknown finding", { field: "findingId" });
  const reason = requiredText(input.reason, "reason", 500);
  const options = {
    name: "estimate.exclude_urgent_finding",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId, findingId, reason } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    const finding = await ctx.tx
      .selectFrom("finding")
      .select("id")
      .where("id", "=", findingId)
      .where("repair_order_id", "=", repairOrderId)
      .where("status", "=", "active")
      .where("severity", "=", "urgent")
      .executeTakeFirst();
    if (!finding) throw new ValidationError("Unknown urgent finding", { field: "findingId" });
    // Addressed already: its job is in this draft, or the customer decided it. A job whose proposal only
    // lapsed leaves the finding open, so this version must include or exclude it again (OD-58).
    const included = await ctx.tx
      .selectFrom("repair_job")
      .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
      .select("repair_job.id")
      .where("repair_job.finding_id", "=", findingId)
      .where("repair_job.removed_at", "is", null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("job_revision.proposed_in_version_id", "=", versionId),
            eb("job_revision.status", "=", "draft"),
          ]),
          eb("job_revision.status", "in", ["approved", "declined"]),
        ]),
      )
      .executeTakeFirst();
    if (included) throw new ConflictError("finding_already_included", "Remove the finding's job instead");
    const live = await ctx.tx
      .selectFrom("urgent_finding_exclusion")
      .select("id")
      .where("estimate_version_id", "=", versionId)
      .where("finding_id", "=", findingId)
      .where("cleared_at", "is", null)
      .executeTakeFirst();
    if (live) throw new ConflictError("finding_already_excluded", "This finding is already left out");
    await ctx.tx
      .insertInto("urgent_finding_exclusion")
      .values({ estimate_version_id: versionId, finding_id: findingId, reason, created_by: staff.userId })
      .execute();
    await ctx.audit({
      action: "estimate.urgent_finding_excluded",
      entityType: "finding",
      entityId: findingId,
      after: { versionId, reason },
    });
    return { findingId };
  });
}

// --------------------------------------------------------------------------- lines

const LINE_TYPE_OF_KIND = { labor_rate: "labor", package: "package", part: "part" } as const;

/**
 * Adds a catalogue item to a job. The line takes the price row in force now and keeps its id and
 * values (T-18), so later price changes never alter it (AC2-12). The VAT rate is the tax code's rate on
 * today's business date, or 0 while the garage is not registered.
 */
export async function addLine(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  input: { itemId?: unknown; qty?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ lineId: string }>> {
  requirePermission(staff, "estimate.edit");
  const repairOrderId = await repairOrderOfJob(db, jobId);
  const itemId = typeof input.itemId === "string" ? input.itemId : "";
  if (!isUuid(itemId)) throw new ValidationError("Choose an item from the price list", { field: "itemId" });
  const qty = parseQty(input.qty);

  return runCommand(
    db,
    {
      name: "estimate.add_line",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { jobId, itemId, qty: qty.toString() } },
    },
    async (ctx) => {
      const { versionId } = await lockDraft(ctx, repairOrderId);
      const job = await draftJob(ctx, jobId, versionId);
      const priced = await priceCatalogueLine(ctx, itemId, qty);
      if (!priced.ok) {
        switch (priced.reason) {
          case "inactive":
            throw new ValidationError("Choose an active item from the price list", { field: "itemId" });
          case "no_price":
            throw new ValidationError("This item has no price yet", { field: "itemId" });
          case "fraction":
            requireAllowedQty(qty, priced.unit);
            throw new ValidationError("This item is counted in whole numbers", { field: "qty" });
          case "no_tax_rate":
            throw new ConflictError("no_tax_rate", `Tax code ${priced.taxCode} has no rate in force`, {
              taxCode: priced.taxCode,
            });
        }
      }
      const lineId = await insertPricedLine(ctx, staff, jobId, job.revision_id, priced.line);
      return { lineId };
    },
  );
}

export interface PricedLine {
  itemId: string;
  lineType: RevisionLineType;
  priceId: string;
  descriptionEn: string;
  descriptionAr: string;
  unit: string | null;
  qty: Qty;
  unitPrice: Money;
  amounts: ReturnType<typeof computeLine>;
  taxCode: string;
  rate: string;
}

type PriceRefusal =
  | { ok: false; reason: "inactive" | "no_price" }
  | { ok: false; reason: "fraction"; unit: string | null }
  | { ok: false; reason: "no_tax_rate"; taxCode: string };

/**
 * Prices a catalogue item for an estimate line: the price row in force now (T-18) and the VAT rate on today's
 * business date, or 0 while the garage is not registered. Says why an item cannot be priced instead of throwing,
 * so offering a job again (I2-01) can skip such items.
 */
export async function priceCatalogueLine(
  ctx: CommandContext,
  itemId: string,
  qty: Qty,
): Promise<{ ok: true; line: PricedLine } | PriceRefusal> {
  const item = await ctx.tx
    .selectFrom("catalogue_item")
    .select(["id", "kind", "name_en", "name_ar", "unit", "active"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!item?.active) return { ok: false, reason: "inactive" };
  const unit = item.kind === "labor_rate" ? "hour" : item.kind === "part" ? item.unit : null;
  if (qty.milli % 1000n !== 0n && !FRACTIONAL_UNITS.includes(unit))
    return { ok: false, reason: "fraction", unit };
  const price = await priceInForce(ctx.tx, itemId);
  if (!price) return { ok: false, reason: "no_price" };

  const profile = await taxProfileOn(ctx.tx, ctx.businessDate);
  if (!profile) throw new ConflictError("no_tax_profile", "No tax profile is in force");
  let rate = "0.00";
  if (profile.registrationStatus === "registered") {
    const codeRate = await taxCodeRateOn(ctx.tx, price.taxCode, ctx.businessDate);
    if (codeRate === null) return { ok: false, reason: "no_tax_rate", taxCode: price.taxCode };
    rate = codeRate;
  }
  const unitPrice = Money.parse(price.price);
  return {
    ok: true,
    line: {
      itemId: item.id,
      lineType: LINE_TYPE_OF_KIND[item.kind],
      priceId: price.priceId,
      descriptionEn: item.name_en,
      descriptionAr: item.name_ar,
      unit,
      qty,
      unitPrice,
      amounts: computeLine({ qty, unitPrice, discount: Money.ZERO, rate }),
      taxCode: price.taxCode,
      rate,
    },
  };
}

/** Inserts a priced line into a draft revision, with its audit event. */
export async function insertPricedLine(
  ctx: CommandContext,
  staff: Staff,
  jobId: string,
  revisionId: string,
  priced: PricedLine,
): Promise<string> {
  const line = await ctx.tx
    .insertInto("revision_line")
    .values({
      revision_id: revisionId,
      line_type: priced.lineType,
      catalogue_item_id: priced.itemId,
      catalogue_price_id: priced.priceId,
      description_en: priced.descriptionEn,
      description_ar: priced.descriptionAr,
      unit: priced.unit,
      qty: priced.qty.toString(),
      unit_price: priced.unitPrice.toString(),
      gross: priced.amounts.gross.toString(),
      discount: "0.00",
      line_total: priced.amounts.total.toString(),
      net: priced.amounts.net.toString(),
      vat: priced.amounts.vat.toString(),
      tax_code: priced.taxCode,
      tax_rate: priced.rate,
      supersedes_line_id: null,
      removed_at: null,
      created_by: staff.userId,
      updated_by: staff.userId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.audit({
    action: "estimate.line_added",
    entityType: "revision_line",
    entityId: line.id,
    after: {
      jobId,
      itemId: priced.itemId,
      priceId: priced.priceId,
      qty: priced.qty.toString(),
      unitPrice: priced.unitPrice.toString(),
      total: priced.amounts.total.toString(),
      taxCode: priced.taxCode,
      taxRate: priced.rate,
    },
  });
  return line.id;
}

/** Locks the draft and returns a live line of it. */
async function draftLine(ctx: CommandContext, lineId: string, repairOrderId: string) {
  const { versionId } = await lockDraft(ctx, repairOrderId);
  const line = await ctx.tx
    .selectFrom("revision_line")
    .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
    .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
    .selectAll("revision_line")
    .where("revision_line.id", "=", lineId)
    .where("job_revision.status", "=", "draft")
    .where("job_revision.proposed_in_version_id", "=", versionId)
    .where("repair_job.removed_at", "is", null)
    .executeTakeFirst();
  if (!line || line.removed_at) throw new NotFoundError("revision_line", lineId);
  return line;
}

async function updateAmounts(
  ctx: CommandContext,
  staff: Staff,
  line: { id: string; qty: string; unit_price: string; discount: string; tax_rate: string },
  change: { qty?: Qty; discount?: Money },
) {
  const qty = change.qty ?? Qty.parse(line.qty);
  const discount = change.discount ?? Money.parse(line.discount);
  const amounts = computeLine({
    qty,
    unitPrice: Money.parse(line.unit_price),
    discount,
    rate: line.tax_rate,
  });
  await ctx.tx
    .updateTable("revision_line")
    .set({
      qty: qty.toString(),
      gross: amounts.gross.toString(),
      discount: amounts.discount.toString(),
      line_total: amounts.total.toString(),
      net: amounts.net.toString(),
      vat: amounts.vat.toString(),
      updated_by: staff.userId,
    })
    .where("id", "=", line.id)
    .execute();
  return { qty, amounts };
}

export async function updateLineQty(
  db: Kysely<DB>,
  staff: Staff,
  lineId: string,
  input: { qty?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ lineId: string }>> {
  requirePermission(staff, "estimate.edit");
  const repairOrderId = await repairOrderOfLine(db, lineId);
  const qty = parseQty(input.qty);
  const options = {
    name: "estimate.update_line_qty",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { lineId, qty: qty.toString() } },
  };
  return runCommand(db, options, async (ctx) => {
    const line = await draftLine(ctx, lineId, repairOrderId);
    requireAllowedQty(qty, line.unit);
    const { amounts } = await updateAmounts(ctx, staff, line, { qty });
    await ctx.audit({
      action: "estimate.line_qty_changed",
      entityType: "revision_line",
      entityId: lineId,
      before: { qty: line.qty, total: line.line_total },
      after: { qty: qty.toString(), total: amounts.total.toString() },
    });
    return { lineId };
  });
}

/** Line discount (VAT-inclusive amount off the line). Managers and partners only until I3-06 (OD-19). */
export async function setLineDiscount(
  db: Kysely<DB>,
  staff: Staff,
  lineId: string,
  input: { discount?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ lineId: string }>> {
  requirePermission(staff, "estimate.discount");
  const repairOrderId = await repairOrderOfLine(db, lineId);
  const discount = parseDiscount(input.discount);
  return runCommand(
    db,
    {
      name: "estimate.set_line_discount",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { lineId, discount: discount.toString() } },
    },
    async (ctx) => {
      const line = await draftLine(ctx, lineId, repairOrderId);
      const { amounts } = await updateAmounts(ctx, staff, line, { discount });
      await ctx.audit({
        action: "estimate.line_discount_set",
        entityType: "revision_line",
        entityId: lineId,
        before: { discount: line.discount, total: line.line_total },
        after: { discount: amounts.discount.toString(), total: amounts.total.toString() },
      });
      return { lineId };
    },
  );
}

export async function removeLine(
  db: Kysely<DB>,
  staff: Staff,
  lineId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ lineId: string }>> {
  requirePermission(staff, "estimate.edit");
  const repairOrderId = await repairOrderOfLine(db, lineId);
  const options = {
    name: "estimate.remove_line",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { lineId } },
  };
  return runCommand(db, options, async (ctx) => {
    const line = await draftLine(ctx, lineId, repairOrderId);
    await ctx.tx
      .updateTable("revision_line")
      .set({ removed_at: ctx.txTime, removed_by: staff.userId, updated_by: staff.userId })
      .where("id", "=", lineId)
      .execute();
    await ctx.audit({
      action: "estimate.line_removed",
      entityType: "revision_line",
      entityId: lineId,
      before: { description: line.description_en, qty: line.qty, total: line.line_total },
    });
    return { lineId };
  });
}
