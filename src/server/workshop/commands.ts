import type { Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { DB, JobExecutionStatus } from "../db/schema";
import { requirePermission, type Staff } from "../estimate/commands";
import { authorizedScope } from "../estimate/approval";
import { denyAsNotFound } from "../inspection/access";

/**
 * Workshop execution (I1-06): assignment (US-07.2, OD-26) and the job's execution statuses (PRD v0.2 B2, v0.2.1
 * §3.3): Authorized → In progress ↔ Paused (reason) → Done (every authorized line done or not performed with a
 * reason). Only the assignee changes a job's status (OD-27). Every command locks the repair order first; the
 * database repeats each rule (migration 0013).
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

function optionalText(value: unknown, field: string, max: number): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length > max) throw new ValidationError(`${field} is too long`, { field });
  return trimmed || null;
}

function requiredText(value: unknown, field: string, max: number): string {
  const trimmed = optionalText(value, field, max);
  if (!trimmed) throw new ValidationError(`${field} is required`, { field });
  return trimmed;
}

async function jobHead(db: Kysely<DB>, jobId: string) {
  if (!isUuid(jobId)) return null;
  return (
    (await db
      .selectFrom("repair_job")
      .select(["id", "repair_order_id", "execution_status", "removed_at"])
      .where("id", "=", jobId)
      .executeTakeFirst()) ?? null
  );
}

/** The live assignee of a job, if any. */
/** Jobs that can be assigned or reassigned (OD-26); the board offers the form only for these. */
export const ASSIGNABLE_JOB_STATUSES: readonly JobExecutionStatus[] = [
  "authorized",
  "waiting_parts",
  "in_progress",
  "paused",
];

export async function liveAssignee(db: Kysely<DB>, jobId: string): Promise<string | null> {
  const row = await db
    .selectFrom("job_assignment")
    .select("assignee_id")
    .where("job_id", "=", jobId)
    .where("ended_at", "is", null)
    .executeTakeFirst();
  return row?.assignee_id ?? null;
}

/**
 * AC2-30: staff with the workshop board see every job; anyone else only jobs assigned to them. Others get
 * "not found", and the attempt is audited.
 */
export async function requireJobAccess(db: Kysely<DB>, staff: Staff, jobId: string): Promise<void> {
  const job = await jobHead(db, jobId);
  if (job && !job.removed_at) {
    if (hasPermission(staff.roles, "workshop.board")) return;
    if ((await liveAssignee(db, jobId)) === staff.userId) return;
  }
  await denyAsNotFound(db, staff, "repair_job", jobId);
}

// --------------------------------------------------------------------------- assignment

export async function assignJob(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  input: { assigneeId?: unknown; bay?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ jobId: string; assigneeId: string }>> {
  requirePermission(staff, "workshop.assign");
  const job = await jobHead(db, jobId);
  if (!job || job.removed_at) throw new NotFoundError("repair_job", jobId);
  const assigneeId = typeof input.assigneeId === "string" ? input.assigneeId : "";
  if (!isUuid(assigneeId)) throw new ValidationError("Choose who does the job", { field: "assigneeId" });
  const bay = optionalText(input.bay, "bay", 20);
  const options = {
    name: "workshop.assign_job",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { jobId, assigneeId, bay } },
  };
  return runCommand(db, options, async (ctx) => {
    await ctx.locks.acquire("repair_order", [job.repair_order_id]);
    const current = await ctx.tx
      .selectFrom("repair_job")
      .select(["execution_status"])
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    if (!ASSIGNABLE_JOB_STATUSES.includes(current.execution_status)) {
      throw new ConflictError("job_not_assignable", `Job is ${current.execution_status}`, {
        status: current.execution_status,
      });
    }
    const person = await ctx.tx
      .selectFrom("app_user")
      .innerJoin("user_role", "user_role.user_id", "app_user.id")
      .select(["app_user.id", "app_user.display_name"])
      .where("app_user.id", "=", assigneeId)
      .where("app_user.status", "=", "active")
      .where("user_role.role", "in", ["technician", "manager", "partner"])
      .executeTakeFirst();
    if (!person)
      throw new ValidationError("Choose an active technician, manager or partner", { field: "assigneeId" });

    const live = await ctx.tx
      .selectFrom("job_assignment")
      .select(["id", "assignee_id", "bay"])
      .where("job_id", "=", jobId)
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (live && live.assignee_id === assigneeId && live.bay === bay) {
      throw new ConflictError("already_assigned", "This person is already assigned");
    }
    if (live) {
      await ctx.tx
        .updateTable("job_assignment")
        .set({ ended_at: ctx.txTime, ended_by: staff.userId })
        .where("id", "=", live.id)
        .execute();
    }
    await ctx.tx
      .insertInto("job_assignment")
      .values({
        job_id: jobId,
        assignee_id: assigneeId,
        bay,
        assigned_by: staff.userId,
        ended_at: null,
        ended_by: null,
      })
      .execute();
    await ctx.audit({
      action: live ? "job.reassigned" : "job.assigned",
      entityType: "repair_job",
      entityId: jobId,
      before: live ? { assigneeId: live.assignee_id, bay: live.bay } : null,
      after: { assigneeId, assigneeName: person.display_name, bay },
    });
    return { jobId, assigneeId };
  });
}

// --------------------------------------------------------------------------- execution

type Transition = "start" | "pause" | "resume" | "complete";

const FROM: Record<Transition, JobExecutionStatus> = {
  start: "authorized",
  pause: "in_progress",
  resume: "paused",
  complete: "in_progress",
};
const TO: Record<Transition, JobExecutionStatus> = {
  start: "in_progress",
  pause: "paused",
  resume: "in_progress",
  complete: "done",
};

/**
 * Checks access before the transaction. A job that is not authorized (pending or declined, AC2-01) is refused
 * and the refusal is audited in its own transaction, so the log survives the rejection.
 */
async function precheck(db: Kysely<DB>, staff: Staff, jobId: string, transition: Transition) {
  requirePermission(staff, "workshop.my_jobs");
  await requireJobAccess(db, staff, jobId);
  const job = (await jobHead(db, jobId))!;
  if (job.execution_status === "not_authorized") {
    await runCommand(db, { name: "workshop.refuse_unauthorized", actor: actorOf(staff) }, async (ctx) => {
      await ctx.audit({
        action: "job.start_refused",
        entityType: "repair_job",
        entityId: jobId,
        details: { transition, reason: "not_authorized" },
      });
      return { refused: true };
    });
    throw new ConflictError(
      "job_not_authorized",
      "This job is not approved by the customer; it cannot start (AC2-01)",
    );
  }
  return job;
}

/** Locks the repair order and checks the job's state and the actor (OD-27). */
async function lockForTransition(
  ctx: CommandContext,
  staff: Staff,
  repairOrderId: string,
  jobId: string,
  transition: Transition,
) {
  await ctx.locks.acquire("repair_order", [repairOrderId]);
  const ro = await ctx.tx
    .selectFrom("repair_order")
    .select("status")
    .where("id", "=", repairOrderId)
    .executeTakeFirstOrThrow();
  if (ro.status !== "in_progress") {
    throw new ConflictError("repair_order_not_in_progress", `Repair order is ${ro.status}`, {
      status: ro.status,
    });
  }
  if ((await liveAssignee(ctx.tx, jobId)) !== staff.userId) {
    throw new ConflictError("not_assignee", "Only the person assigned changes this job (OD-27)");
  }
  const job = await ctx.tx
    .selectFrom("repair_job")
    .select(["execution_status", "execution_reason"])
    .where("id", "=", jobId)
    .executeTakeFirstOrThrow();
  if (job.execution_status !== FROM[transition]) {
    throw new ConflictError("job_status_changed", `Job is ${job.execution_status}`, {
      reason: job.execution_status,
    });
  }
  return job;
}

async function moveJob(
  ctx: CommandContext,
  staff: Staff,
  jobId: string,
  transition: Transition,
  reason: string | null,
  before: { execution_status: JobExecutionStatus },
) {
  await ctx.tx
    .updateTable("repair_job")
    .set({ execution_status: TO[transition], execution_reason: reason, updated_by: staff.userId })
    .where("id", "=", jobId)
    .execute();
  await ctx.audit({
    action: `job.${transition === "complete" ? "done" : transition === "start" ? "started" : transition === "pause" ? "paused" : "resumed"}`,
    entityType: "repair_job",
    entityId: jobId,
    before: { status: before.execution_status },
    after: { status: TO[transition], reason },
  });
}

async function simpleTransition(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  transition: "start" | "pause" | "resume",
  reason: string | null,
  idempotencyKey: string,
): Promise<CommandOutcome<{ jobId: string; status: JobExecutionStatus }>> {
  const job = await precheck(db, staff, jobId, transition);
  const options = {
    name: `workshop.${transition}_job`,
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { jobId, reason } },
  };
  return runCommand(db, options, async (ctx) => {
    const before = await lockForTransition(ctx, staff, job.repair_order_id, jobId, transition);
    await moveJob(ctx, staff, jobId, transition, reason, before);
    return { jobId, status: TO[transition] };
  });
}

export async function startJob(db: Kysely<DB>, staff: Staff, jobId: string, idempotencyKey: string) {
  return simpleTransition(db, staff, jobId, "start", null, idempotencyKey);
}

/** In progress → Paused; the reason is required (v0.2.1 §3.3), e.g. "awaiting customer decision". */
export async function pauseJob(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  input: { reason?: unknown },
  idempotencyKey: string,
) {
  const reason = requiredText(input.reason, "pauseReason", 500);
  return simpleTransition(db, staff, jobId, "pause", reason, idempotencyKey);
}

export async function resumeJob(db: Kysely<DB>, staff: Staff, jobId: string, idempotencyKey: string) {
  return simpleTransition(db, staff, jobId, "resume", null, idempotencyKey);
}

export interface LineOutcomeInput {
  lineId: unknown;
  outcome: unknown;
  reason?: unknown;
}

/** In progress → Done: an outcome for every authorized line (done, or not performed with a reason) and a completion note (OD-31). */
export async function completeJob(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  input: { lines?: unknown; note?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ jobId: string; status: JobExecutionStatus }>> {
  if (!Array.isArray(input.lines))
    throw new ValidationError("Mark every item done or not performed", { field: "lines" });
  const lines = (input.lines as LineOutcomeInput[]).map((entry) => {
    const lineId = typeof entry?.lineId === "string" ? entry.lineId : "";
    const outcome = entry?.outcome;
    if (!isUuid(lineId) || (outcome !== "done" && outcome !== "not_performed")) {
      throw new ValidationError("Mark every item done or not performed", { field: "lines" });
    }
    const reason = outcome === "not_performed" ? requiredText(entry.reason, "notPerformedReason", 500) : null;
    return { lineId, outcome, reason } as {
      lineId: string;
      outcome: "done" | "not_performed";
      reason: string | null;
    };
  });
  // PRD v0.2 B2: Done carries a completion note (OD-31).
  const note = requiredText(input.note, "completionNote", 500);
  const job = await precheck(db, staff, jobId, "complete");
  const options = {
    name: "workshop.complete_job",
    actor: actorOf(staff),
    idempotency: {
      key: idempotencyKey,
      payload: {
        jobId,
        note,
        lines: [...lines]
          .sort((a, b) => (a.lineId < b.lineId ? -1 : 1))
          .map((line) => ({ lineId: line.lineId, outcome: line.outcome, reason: line.reason })),
      },
    },
  };
  return runCommand(db, options, async (ctx) => {
    const before = await lockForTransition(ctx, staff, job.repair_order_id, jobId, "complete");
    const scope = await authorizedScope(ctx.tx, jobId);
    const given = new Set(lines.map((line) => line.lineId));
    if (given.size !== lines.length || scope.length !== lines.length || scope.some((id) => !given.has(id))) {
      throw new ValidationError("Mark every item done or not performed", { field: "lines" });
    }
    for (const line of lines) {
      await ctx.tx
        .insertInto("job_line_outcome")
        .values({
          job_id: jobId,
          revision_line_id: line.lineId,
          outcome: line.outcome,
          reason: line.reason,
          recorded_by: staff.userId,
        })
        .execute();
    }
    await moveJob(ctx, staff, jobId, "complete", note, before);
    await ctx.audit({
      action: "job.line_outcomes_recorded",
      entityType: "repair_job",
      entityId: jobId,
      after: { lines },
    });
    return { jobId, status: "done" as const };
  });
}
