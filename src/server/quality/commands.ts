import type { Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { DB, OldPartsDisposition } from "../db/schema";
import { requirePermission, type Staff } from "../estimate/commands";
import { denyAsNotFound } from "../inspection/access";

/**
 * Quality check (I1-08, PRD v0.2 §B1 and §G). In progress → QC on request (every approved job done, no estimate
 * awaiting a decision — AC2-25 — nothing waiting for parts); a manager or partner (OD-36) then passes it with the
 * full checklist, or fails it with notes and the jobs to rework (T-26). With `qc.different_person` on (OD-37, D-8)
 * nobody assigned to the work may pass it (AC2-26). Every command locks the repair order first; the database repeats
 * each rule (migration 0016).
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });
export const DISPOSITIONS: readonly OldPartsDisposition[] = [
  "returned_to_customer",
  "disposed",
  "kept_for_claim",
  "none_replaced",
];

function text(value: unknown, field: string, max: number): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`, { field });
  return trimmed || null;
}

async function lockRepairOrder(ctx: CommandContext, repairOrderId: string) {
  await ctx.locks.acquire("repair_order", [repairOrderId]);
  const ro = await ctx.tx
    .selectFrom("repair_order")
    .select(["id", "status", "odometer_km"])
    .where("id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro) throw new NotFoundError("repair_order", repairOrderId);
  return ro;
}

async function hasJobOn(db: Kysely<DB>, userId: string, repairOrderId: string): Promise<boolean> {
  const row = await db
    .selectFrom("job_assignment")
    .innerJoin("repair_job", "repair_job.id", "job_assignment.job_id")
    .select("job_assignment.id")
    .where("repair_job.repair_order_id", "=", repairOrderId)
    .where("job_assignment.assignee_id", "=", userId)
    .where("job_assignment.ended_at", "is", null)
    .executeTakeFirst();
  return Boolean(row);
}

// --------------------------------------------------------------------------- request

export async function requestQc(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ qcRecordId: string }>> {
  requirePermission(staff, "qc.request");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  // OD-36: a technician requests QC only on a repair order where they hold a job (AC2-30 otherwise).
  if (!hasPermission(staff.roles, "qc.decide") && !(await hasJobOn(db, staff.userId, repairOrderId))) {
    await denyAsNotFound(db, staff, "repair_order", repairOrderId);
  }
  const options = {
    name: "qc.request",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId } },
  };
  return runCommand(db, options, async (ctx) => {
    const ro = await lockRepairOrder(ctx, repairOrderId);
    if (ro.status !== "in_progress") {
      throw new ConflictError("repair_order_not_in_progress", `Repair order is ${ro.status}`, {
        status: ro.status,
      });
    }
    // AC2-25: no estimate version awaiting the customer's decision.
    const sent = await ctx.tx
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .select("estimate_version.version_no")
      .where("estimate.repair_order_id", "=", repairOrderId)
      .where("estimate_version.status", "=", "sent")
      .executeTakeFirst();
    if (sent) {
      throw new ConflictError(
        "decision_pending",
        `Customer decision pending on v${sent.version_no} — withdraw or wait`,
        {
          reason: "decision_pending",
          version: String(sent.version_no),
        },
      );
    }
    const unfinished = await ctx.tx
      .selectFrom("repair_job")
      .select(["id", "title", "execution_status"])
      .where("repair_order_id", "=", repairOrderId)
      .where("removed_at", "is", null)
      // B1: "Done or Cancelled by customer"; jobs never approved do not count.
      .where("execution_status", "not in", ["done", "not_authorized", "stopped_by_customer"])
      .execute();
    if (unfinished.length > 0) {
      throw new ConflictError("work_not_finished", "Every approved job must be done before QC", {
        reason: "work_not_finished",
      });
    }
    await ctx.tx.updateTable("repair_order").set({ status: "qc" }).where("id", "=", repairOrderId).execute();
    const record = await ctx.tx
      .insertInto("qc_record")
      .values({ repair_order_id: repairOrderId, requested_by: staff.userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.audit({
      action: "ro.qc_requested",
      entityType: "repair_order",
      entityId: repairOrderId,
      before: { status: "in_progress" },
      after: { status: "qc", qcRecordId: record.id },
    });
    return { qcRecordId: record.id };
  });
}

// --------------------------------------------------------------------------- decide

async function pendingRecord(ctx: CommandContext, repairOrderId: string) {
  const record = await ctx.tx
    .selectFrom("qc_record")
    .select("id")
    .where("repair_order_id", "=", repairOrderId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!record) throw new ConflictError("qc_not_pending", "There is no QC waiting for a decision");
  return record.id;
}

export interface QcChecklist {
  noNewWarningLights?: unknown;
  roadTest?: unknown;
  roadTestReason?: unknown;
  odometerOutKm?: unknown;
  odometerReason?: unknown;
  fluidsOk?: unknown;
  cleanlinessOk?: unknown;
  belongingsOk?: unknown;
  oldParts?: unknown;
  notes?: unknown;
}

const yes = (value: unknown) => value === true || value === "on" || value === "true";

export async function passQc(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: QcChecklist,
  idempotencyKey: string,
): Promise<CommandOutcome<{ qcRecordId: string }>> {
  requirePermission(staff, "qc.decide");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  for (const [field, value] of [
    ["noNewWarningLights", input.noNewWarningLights],
    ["fluidsOk", input.fluidsOk],
    ["cleanlinessOk", input.cleanlinessOk],
    ["belongingsOk", input.belongingsOk],
  ] as const) {
    if (!yes(value)) throw new ValidationError("Confirm every QC check before passing", { field });
  }
  const roadTest = input.roadTest;
  if (roadTest !== "done" && roadTest !== "not_applicable") {
    throw new ValidationError("Record the road test", { field: "roadTest" });
  }
  const roadTestReason = text(input.roadTestReason, "roadTestReason", 500);
  if (roadTest === "not_applicable" && !roadTestReason) {
    throw new ValidationError("Say why no road test was needed", { field: "roadTestReason" });
  }
  const raw = input.odometerOutKm;
  const odometerText = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  // A distance, not money; the same 0–2,000,000 km range as check-in.
  const odometerOutKm = /^\d{1,7}$/.test(odometerText) ? Number.parseInt(odometerText, 10) : -1;
  if (odometerOutKm < 0 || odometerOutKm > 2_000_000) {
    throw new ValidationError("Enter the odometer reading", { field: "odometerOutKm" });
  }
  const odometerReason = text(input.odometerReason, "odometerReason", 500);
  const oldParts = input.oldParts as OldPartsDisposition;
  if (!DISPOSITIONS.includes(oldParts))
    throw new ValidationError("Record what happened to the old parts", { field: "oldParts" });
  const notes = text(input.notes, "notes", 2000);

  const payload = { repairOrderId, roadTest, roadTestReason, odometerOutKm, odometerReason, oldParts, notes };
  const options = { name: "qc.pass", actor: actorOf(staff), idempotency: { key: idempotencyKey, payload } };
  return runCommand(db, options, async (ctx) => {
    const ro = await lockRepairOrder(ctx, repairOrderId);
    const recordId = await pendingRecord(ctx, repairOrderId);
    // GAP-48: odometer out may not be lower than at check-in without a reason.
    if (odometerOutKm < ro.odometer_km && !odometerReason) {
      throw new ValidationError("The odometer is lower than at check-in; give a reason", {
        field: "odometerReason",
      });
    }
    // AC2-26 / OD-37: not by someone who did the work, while the setting is on.
    const setting = await ctx.tx
      .selectFrom("app_setting")
      .select("value")
      .where("key", "=", "qc.different_person")
      .executeTakeFirst();
    if (setting?.value === true) {
      const worked = await ctx.tx
        .selectFrom("job_assignment")
        .innerJoin("repair_job", "repair_job.id", "job_assignment.job_id")
        .select("job_assignment.id")
        .where("repair_job.repair_order_id", "=", repairOrderId)
        .where("job_assignment.assignee_id", "=", staff.userId)
        .executeTakeFirst();
      if (worked) {
        throw new ConflictError(
          "qc_self_check",
          "Someone other than who did the work must pass QC (AC2-26)",
          {
            reason: "qc_self_check",
          },
        );
      }
    }
    await ctx.tx
      .updateTable("qc_record")
      .set({
        status: "passed",
        no_new_warning_lights: true,
        road_test: roadTest,
        road_test_reason: roadTestReason,
        odometer_out_km: odometerOutKm,
        odometer_reason: odometerReason,
        fluids_ok: true,
        cleanliness_ok: true,
        belongings_ok: true,
        old_parts: oldParts,
        notes,
        decided_by: staff.userId,
        decided_at: ctx.txTime,
      })
      .where("id", "=", recordId)
      .execute();
    await ctx.audit({
      action: "qc.passed",
      entityType: "repair_order",
      entityId: repairOrderId,
      after: { qcRecordId: recordId, roadTest, odometerOutKm, odometerReason, oldParts, notes },
    });
    return { qcRecordId: recordId };
  });
}

/**
 * QC failed: notes; the job(s) chosen for rework, if any, go Done → Approved (T-26, OD-39). The repair order returns
 * to In progress either way, so non-job problems (cleanliness, belongings) are fixed and QC is requested again.
 */
export async function failQc(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: { notes?: unknown; jobIds?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ qcRecordId: string }>> {
  requirePermission(staff, "qc.decide");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const notes = text(input.notes, "notes", 2000);
  if (!notes) throw new ValidationError("Say what failed", { field: "notes" });
  const jobIds = Array.isArray(input.jobIds)
    ? [...new Set(input.jobIds.filter((id): id is string => typeof id === "string"))]
    : [];
  if (jobIds.some((id) => !isUuid(id)))
    throw new ValidationError("Choose jobs of this repair order", { field: "jobIds" });
  jobIds.sort();
  const options = {
    name: "qc.fail",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId, notes, jobIds } },
  };
  return runCommand(db, options, async (ctx) => {
    await lockRepairOrder(ctx, repairOrderId);
    const recordId = await pendingRecord(ctx, repairOrderId);
    const jobs =
      jobIds.length === 0
        ? []
        : await ctx.tx
            .selectFrom("repair_job")
            .select(["id", "title"])
            .where("repair_order_id", "=", repairOrderId)
            .where("id", "in", jobIds)
            .where("execution_status", "=", "done")
            .execute();
    if (jobs.length !== jobIds.length)
      throw new ValidationError("Choose done jobs of this repair order", { field: "jobIds" });

    await ctx.tx
      .updateTable("qc_record")
      .set({ status: "failed", notes, decided_by: staff.userId, decided_at: ctx.txTime })
      .where("id", "=", recordId)
      .execute();
    await ctx.tx
      .updateTable("repair_order")
      .set({ status: "in_progress" })
      .where("id", "=", repairOrderId)
      .execute();
    for (const job of jobs) {
      await ctx.tx
        .updateTable("job_line_outcome")
        .set({ superseded_at: ctx.txTime })
        .where("job_id", "=", job.id)
        .where("superseded_at", "is", null)
        .execute();
      await ctx.tx
        .updateTable("repair_job")
        .set({ execution_status: "authorized", execution_reason: notes, updated_by: staff.userId })
        .where("id", "=", job.id)
        .execute();
    }
    await ctx.audit({
      action: "qc.failed",
      entityType: "repair_order",
      entityId: repairOrderId,
      after: {
        qcRecordId: recordId,
        notes,
        returnedJobs: jobs.map((job) => ({ id: job.id, title: job.title })),
      },
    });
    await ctx.audit({
      action: "ro.qc_failed",
      entityType: "repair_order",
      entityId: repairOrderId,
      before: { status: "qc" },
      after: { status: "in_progress" },
    });
    return { qcRecordId: recordId };
  });
}
