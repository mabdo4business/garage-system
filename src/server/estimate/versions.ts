import { sql, type Kysely } from "kysely";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { logger } from "../core/logger";
import { Qty } from "../core/money";
import type { DB, WithdrawReasonCode } from "../db/schema";
import {
  insertPricedLine,
  lockDraft,
  lockRepairOrder,
  priceCatalogueLine,
  repairOrderOfJob,
  requirePermission,
  type Staff,
} from "./commands";

/**
 * Estimate versions (I2-01, v0.2.1 §3.1–3.2): a new version once the previous one has ended, withdrawal with a
 * reason (OD-57), expiry — by the system, or at the moment anyone acts on an overdue version (§5 "expiry at
 * submission time") — discarding a later draft, and offering a declined or lapsed job again (OD-55) as a new
 * revision in the new version (§2.1 #5). Every command locks the repair order first (T-19), which also settles
 * an approval racing a withdrawal (AC21-05): whichever locks first wins.
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

/** Later versions are drafted while the customer is deciding or the work runs (OD-56). */
const OPEN_FOR_NEW_VERSION = ["awaiting_approval", "in_progress"] as const;

const WITHDRAW_REASONS: readonly WithdrawReasonCode[] = ["no_response", "needs_changes", "other"];

export interface EndedVersion {
  versionId: string;
  versionNo: number;
  /** The jobs whose pending revision lapsed with the version. */
  lapsed: { jobId: string; revisionId: string }[];
}

/** Ends a sent version (its end row first, then the status, then the lapses, as the database guards require). */
async function endSentVersion(
  ctx: CommandContext,
  version: { id: string; versionNo: number },
  outcome: "withdrawn" | "expired",
  input: { endedBy: string | null; reasonCode?: WithdrawReasonCode; reason?: string | null },
): Promise<EndedVersion> {
  await ctx.tx
    .insertInto("estimate_version_end")
    .values({
      estimate_version_id: version.id,
      outcome,
      reason_code: input.reasonCode ?? null,
      reason: input.reason ?? null,
      ended_by: input.endedBy,
    })
    .execute();
  await ctx.tx
    .updateTable("estimate_version")
    .set({ status: outcome })
    .where("id", "=", version.id)
    .execute();
  const lapsed = await ctx.tx
    .updateTable("job_revision")
    .set({ status: "lapsed", lapse_reason: outcome })
    .where("proposed_in_version_id", "=", version.id)
    .where("status", "=", "pending")
    .returning(["id", "job_id"])
    .execute();
  return {
    versionId: version.id,
    versionNo: version.versionNo,
    lapsed: lapsed
      .map((row) => ({ jobId: row.job_id, revisionId: row.id }))
      .sort((a, b) => (a.revisionId < b.revisionId ? -1 : 1)),
  };
}

/**
 * Expires the repair order's sent version if its expiry has passed, even though no scheduler ran (AC21-07):
 * undecided revisions lapse (expired), decisions already recorded stay. The caller holds the repair-order lock
 * and must let the transaction commit for the expiry to stand. Returns null when nothing was due.
 */
export async function expireIfDue(
  ctx: CommandContext,
  repairOrderId: string,
  trigger: "submission" | "withdrawal" | "new_version" | "qc_request" | "scheduler",
): Promise<EndedVersion | null> {
  const due = await ctx.tx
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select(["estimate_version.id", "estimate_version.version_no"])
    .where("estimate.repair_order_id", "=", repairOrderId)
    .where("estimate_version.status", "=", "sent")
    // The database's own clock, as in the guards (now() is the transaction's start).
    .where("estimate_version.expires_at", "<=", sql<Date>`now()`)
    .executeTakeFirst();
  if (!due) return null;
  const ended = await endSentVersion(ctx, { id: due.id, versionNo: due.version_no }, "expired", {
    endedBy: null,
  });
  await ctx.audit({
    action: "estimate.expired",
    entityType: "estimate_version",
    entityId: due.id,
    before: { status: "sent" },
    after: { status: "expired", lapsed: ended.lapsed },
    details: { repairOrderId, trigger },
  });
  return ended;
}

/** The latest version of the repair order's estimate (callers hold the repair-order lock). */
async function latestVersion(ctx: CommandContext, repairOrderId: string) {
  return ctx.tx
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select([
      "estimate_version.id",
      "estimate_version.version_no",
      "estimate_version.status",
      "estimate.id as estimate_id",
    ])
    .where("estimate.repair_order_id", "=", repairOrderId)
    .orderBy("estimate_version.version_no", "desc")
    .executeTakeFirst();
}

// --------------------------------------------------------------------------- new version

/**
 * Starts version N+1 (§3.1 "(new) → Draft") once the latest version has ended — closed, withdrawn, expired or
 * discarded — while the repair order is Awaiting approval or In progress (OD-56). An overdue sent version is
 * expired first.
 */
export async function startVersion(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ versionId: string; versionNo: number }>> {
  requirePermission(staff, "estimate.edit");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const options = {
    name: "estimate.start_version",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId } },
  };
  return runCommand(db, options, async (ctx) => {
    await lockRepairOrder(ctx, repairOrderId, OPEN_FOR_NEW_VERSION);
    await expireIfDue(ctx, repairOrderId, "new_version");
    const latest = await latestVersion(ctx, repairOrderId);
    if (!latest) throw new ConflictError("no_estimate", "This repair order has no estimate yet");
    if (latest.status === "draft" || latest.status === "sent") {
      throw new ConflictError(
        "version_still_open",
        `Version ${latest.version_no} is still ${latest.status}; withdraw it first`,
        { version: String(latest.version_no), status: latest.status },
      );
    }
    const versionNo = latest.version_no + 1;
    const version = await ctx.tx
      .insertInto("estimate_version")
      .values({ estimate_id: latest.estimate_id, version_no: versionNo, created_by: staff.userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.audit({
      action: "estimate.version_started",
      entityType: "estimate_version",
      entityId: version.id,
      after: { repairOrderId, versionNo, previous: { versionNo: latest.version_no, status: latest.status } },
    });
    return { versionId: version.id, versionNo };
  });
}

// --------------------------------------------------------------------------- withdraw

export function parseWithdrawReason(input: { reasonCode?: unknown; reason?: unknown }): {
  reasonCode: WithdrawReasonCode;
  reason: string | null;
} {
  const reasonCode = input.reasonCode;
  if (typeof reasonCode !== "string" || !(WITHDRAW_REASONS as readonly string[]).includes(reasonCode)) {
    throw new ValidationError("Choose why the estimate is withdrawn", { field: "reasonCode" });
  }
  const text = typeof input.reason === "string" ? input.reason.trim() : "";
  if (text.length > 500) throw new ValidationError("reason is too long", { field: "reason" });
  if (reasonCode === "other" && text === "") {
    throw new ValidationError("Say why the estimate is withdrawn", { field: "reason" });
  }
  return { reasonCode: reasonCode as WithdrawReasonCode, reason: text === "" ? null : text };
}

/**
 * Withdraws the sent version (§3.1 Sent → Withdrawn) with a reason (OD-57): decisions already recorded stay,
 * undecided revisions lapse (withdrawn) and their work cannot start (AC21-06). If the version had already passed
 * its expiry it is recorded as expired instead, and the result says so. Its customer link stops working with it:
 * a link is valid only while its version is (T-40), so nothing is written to the link here.
 */
export async function withdrawVersion(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: { reasonCode?: unknown; reason?: unknown },
  idempotencyKey: string,
): Promise<CommandOutcome<{ versionId: string; outcome: "withdrawn" | "expired"; lapsedJobs: number }>> {
  requirePermission(staff, "estimate.send");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const { reasonCode, reason } = parseWithdrawReason(input);
  const options = {
    name: "estimate.withdraw",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId, reasonCode, reason } },
  };
  return runCommand(db, options, async (ctx) => {
    await lockRepairOrder(ctx, repairOrderId, OPEN_FOR_NEW_VERSION);
    const expired = await expireIfDue(ctx, repairOrderId, "withdrawal");
    if (expired) {
      return { versionId: expired.versionId, outcome: "expired" as const, lapsedJobs: expired.lapsed.length };
    }
    const sent = await latestVersion(ctx, repairOrderId);
    if (!sent || sent.status !== "sent") {
      throw new ConflictError("estimate_not_sent", "There is no estimate awaiting the customer's decision", {
        status: sent?.status ?? "none",
      });
    }
    const ended = await endSentVersion(ctx, { id: sent.id, versionNo: sent.version_no }, "withdrawn", {
      endedBy: staff.userId,
      reasonCode,
      reason,
    });
    await ctx.audit({
      action: "estimate.withdrawn",
      entityType: "estimate_version",
      entityId: sent.id,
      before: { status: "sent" },
      after: { status: "withdrawn", reasonCode, reason, lapsed: ended.lapsed },
      details: { repairOrderId, versionNo: sent.version_no },
    });
    return { versionId: sent.id, outcome: "withdrawn" as const, lapsedJobs: ended.lapsed.length };
  });
}

// --------------------------------------------------------------------------- discard

/**
 * Discards a draft of version 2 onwards (§3.1 Draft → Discarded): jobs new in it are removed, jobs it offered
 * again keep their history and only lose the draft revision. Version 1 is never discarded: its draft is the estimate.
 */
export async function discardDraft(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ versionId: string }>> {
  requirePermission(staff, "estimate.edit");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const options = {
    name: "estimate.discard_draft",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    const version = await ctx.tx
      .selectFrom("estimate_version")
      .select("version_no")
      .where("id", "=", versionId)
      .executeTakeFirstOrThrow();
    if (version.version_no < 2) {
      throw new ConflictError("first_version", "The first version is not discarded; remove its jobs instead");
    }
    const revisions = await ctx.tx
      .selectFrom("job_revision")
      .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
      .select(["job_revision.id", "job_revision.job_id", "job_revision.revision_no", "repair_job.removed_at"])
      .where("job_revision.proposed_in_version_id", "=", versionId)
      .where("job_revision.status", "=", "draft")
      .execute();
    const newJobs = revisions.filter((row) => row.revision_no === 1 && row.removed_at === null);
    if (newJobs.length > 0) {
      await ctx.tx
        .updateTable("repair_job")
        .set({ removed_at: ctx.txTime, removed_by: staff.userId, updated_by: staff.userId })
        .where(
          "id",
          "in",
          newJobs.map((row) => row.job_id),
        )
        .execute();
    }
    await ctx.tx
      .insertInto("estimate_version_end")
      .values({ estimate_version_id: versionId, outcome: "discarded", ended_by: staff.userId })
      .execute();
    await ctx.tx
      .updateTable("estimate_version")
      .set({ status: "discarded" })
      .where("id", "=", versionId)
      .execute();
    if (revisions.length > 0) {
      await ctx.tx
        .updateTable("job_revision")
        .set({ status: "discarded" })
        .where(
          "id",
          "in",
          revisions.map((row) => row.id),
        )
        .execute();
    }
    await ctx.audit({
      action: "estimate.draft_discarded",
      entityType: "estimate_version",
      entityId: versionId,
      before: { status: "draft" },
      after: {
        status: "discarded",
        removedJobs: newJobs.map((row) => row.job_id).sort(),
        discardedRevisions: revisions.map((row) => row.id).sort(),
      },
      details: { repairOrderId, versionNo: version.version_no },
    });
    return { versionId };
  });
}

// --------------------------------------------------------------------------- offer a job again

/**
 * Offers a declined or lapsed job again in the open draft (OD-55): a new revision, never a reuse of the old one
 * (§2.1 #5, AC21-06). Its lines are the latest proposal's items and quantities at today's prices (T-18); discounts
 * are not carried (OD-19). Items no longer active or priced are skipped and reported.
 */
export async function reproposeJob(
  db: Kysely<DB>,
  staff: Staff,
  jobId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ revisionId: string; skippedItems: string[] }>> {
  requirePermission(staff, "estimate.edit");
  const repairOrderId = await repairOrderOfJob(db, jobId);
  const options = {
    name: "estimate.repropose_job",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { jobId } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    const job = await ctx.tx
      .selectFrom("repair_job")
      .select(["id", "title", "removed_at", "finding_id"])
      .where("id", "=", jobId)
      .executeTakeFirstOrThrow();
    const revisions = await ctx.tx
      .selectFrom("job_revision")
      .select(["id", "revision_no", "status"])
      .where("job_id", "=", jobId)
      .orderBy("revision_no", "desc")
      .execute();
    // The latest decided-or-lapsed proposal (a discarded draft of a later version is skipped).
    const previous = revisions.find((row) => row.status === "declined" || row.status === "lapsed");
    if (
      job.removed_at !== null ||
      !previous ||
      revisions.some((row) => ["approved", "draft", "pending"].includes(row.status))
    ) {
      throw new ConflictError("not_reproposable", "Only a declined or lapsed job is offered again");
    }
    const revision = await ctx.tx
      .insertInto("job_revision")
      .values({
        job_id: jobId,
        revision_no: revisions[0]!.revision_no + 1,
        kind: "original",
        proposed_in_version_id: versionId,
        lapse_reason: null,
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    // Like including a finding (addJob): a reason recorded for leaving it out of this version no longer applies.
    const cleared =
      job.finding_id === null
        ? undefined
        : await ctx.tx
            .updateTable("urgent_finding_exclusion")
            .set({ cleared_at: ctx.txTime, cleared_by: staff.userId })
            .where("estimate_version_id", "=", versionId)
            .where("finding_id", "=", job.finding_id)
            .where("cleared_at", "is", null)
            .returning(["id", "reason"])
            .executeTakeFirst();

    const earlier = await ctx.tx
      .selectFrom("revision_line")
      .select(["catalogue_item_id", "qty", "description_en"])
      .where("revision_id", "=", previous.id)
      .where("removed_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const skippedItems: string[] = [];
    for (const line of earlier) {
      const priced =
        line.catalogue_item_id === null
          ? null
          : await priceCatalogueLine(ctx, line.catalogue_item_id, Qty.parse(line.qty));
      if (!priced?.ok) {
        skippedItems.push(line.description_en);
        continue;
      }
      await insertPricedLine(ctx, staff, jobId, revision.id, priced.line);
    }
    await ctx.audit({
      action: "estimate.job_reproposed",
      entityType: "repair_job",
      entityId: jobId,
      after: { versionId, revisionId: revision.id, previousRevisionId: previous.id, title: job.title },
      details:
        skippedItems.length > 0 || cleared
          ? {
              ...(skippedItems.length > 0 ? { skippedItems } : {}),
              ...(cleared ? { clearedExclusion: { id: cleared.id, reason: cleared.reason } } : {}),
            }
          : null,
    });
    return { revisionId: revision.id, skippedItems };
  });
}

// --------------------------------------------------------------------------- scheduler

/**
 * Expires every overdue sent version, each in its own transaction (§3.1 SYS). Called by the background worker
 * once it exists (I2-09); until then expiry happens when someone acts on the version. Returns the versions expired.
 */
export async function expireDueEstimates(db: Kysely<DB>): Promise<string[]> {
  const due = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select("estimate.repair_order_id")
    .where("estimate_version.status", "=", "sent")
    .where("estimate_version.expires_at", "<=", sql<Date>`now()`)
    .execute();
  const expired: string[] = [];
  for (const { repair_order_id: repairOrderId } of due) {
    // One repair order failing (it rolled back, nothing half-done) must not stop the others; logged for follow-up.
    const outcome = await runCommand(
      db,
      { name: "estimate.expire_due", actor: { kind: "system" as const, name: "estimate-expiry" } },
      async (ctx) => {
        await ctx.locks.acquire("repair_order", [repairOrderId]);
        const ended = await expireIfDue(ctx, repairOrderId, "scheduler");
        if (!ended) {
          // Decided or withdrawn meanwhile: record that the run looked (every command audits).
          await ctx.audit({
            action: "estimate.expiry_checked",
            entityType: "repair_order",
            entityId: repairOrderId,
            details: { expired: false },
          });
        }
        return { versionId: ended?.versionId ?? null };
      },
    ).catch((error: unknown) => {
      logger.warn("estimate.expiry_failed", { repairOrderId, error: (error as Error).message });
      return null;
    });
    if (outcome?.result.versionId) expired.push(outcome.result.versionId);
  }
  return expired;
}
