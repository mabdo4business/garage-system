import { sql, type Kysely } from "kysely";
import { runCommand, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { taxCodeRateOn, taxProfileOn } from "../catalog/tax";
import type { DB } from "../db/schema";
import { inspectImage } from "../media/image";
import type { MediaStorage } from "../media/storage";
import { lockDraft, requirePermission, type Staff } from "./commands";
import { buildSnapshot, hashSnapshot } from "./snapshot";
import { expireIfDue } from "./versions";

/**
 * Sending an estimate and recording the customer's in-person decision (I1-05b).
 *
 * Send (v0.2.1 §3.1 Draft → Sent): freezes the canonical snapshot and its hash (P0-11), moves the draft
 * revisions to Pending and the repair order to Awaiting approval. In person (L3, OD-20): the customer decides
 * whole jobs (approve / decline), signs, and the decision is recorded as one ApprovalEvent with one
 * RevisionDecision per job. Both lock the repair order first (Amendment A.4 / F-11).
 */

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

/** Largest signature image accepted; a finger-drawn PNG is a few tens of kilobytes. */
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

// --------------------------------------------------------------------------- send

export async function sendVersion(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ versionId: string; contentHash: string }>> {
  requirePermission(staff, "estimate.send");
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const options = {
    name: "estimate.send",
    actor: actorOf(staff),
    idempotency: { key: idempotencyKey, payload: { repairOrderId } },
  };
  return runCommand(db, options, async (ctx) => {
    const { versionId } = await lockDraft(ctx, repairOrderId);
    const ro = await ctx.tx
      .selectFrom("repair_order")
      .select("status")
      .where("id", "=", repairOrderId)
      .executeTakeFirstOrThrow();

    const jobs = await ctx.tx
      .selectFrom("repair_job")
      .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
      .select(["repair_job.id", "job_revision.id as revision_id"])
      .where("job_revision.proposed_in_version_id", "=", versionId)
      .where("job_revision.status", "=", "draft")
      .where("repair_job.removed_at", "is", null)
      .execute();
    if (jobs.length === 0) throw new ConflictError("estimate_empty", "Add at least one job before sending");
    const lines = await ctx.tx
      .selectFrom("revision_line")
      .select(["id", "revision_id", "tax_code", "tax_rate"])
      .where(
        "revision_id",
        "in",
        jobs.map((job) => job.revision_id),
      )
      .where("removed_at", "is", null)
      .execute();
    if (jobs.some((job) => !lines.some((line) => line.revision_id === job.revision_id))) {
      throw new ConflictError("job_without_lines", "Every job needs at least one item before sending");
    }

    // AC-05.2, in every version (OD-58): each active urgent finding is in this version, was decided by the
    // customer earlier, or is left out with a reason recorded for this version. A job that only lapsed does not count.
    const openUrgent = await ctx.tx
      .selectFrom("finding")
      .select("id")
      .where("repair_order_id", "=", repairOrderId)
      .where("status", "=", "active")
      .where("severity", "=", "urgent")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("repair_job")
              .innerJoin("job_revision", "job_revision.job_id", "repair_job.id")
              .select("repair_job.id")
              .whereRef("repair_job.finding_id", "=", "finding.id")
              .where("repair_job.removed_at", "is", null)
              .where((eb) =>
                eb.or([
                  eb.and([
                    eb("job_revision.proposed_in_version_id", "=", versionId),
                    eb("job_revision.status", "=", "draft"),
                  ]),
                  eb("job_revision.status", "in", ["approved", "declined"]),
                ]),
              ),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("urgent_finding_exclusion")
              .select("urgent_finding_exclusion.id")
              .whereRef("urgent_finding_exclusion.finding_id", "=", "finding.id")
              .where("urgent_finding_exclusion.estimate_version_id", "=", versionId)
              .where("urgent_finding_exclusion.cleared_at", "is", null),
          ),
        ),
      )
      .execute();
    if (openUrgent.length > 0) {
      throw new ConflictError(
        "urgent_finding_open",
        "Include or leave out every urgent finding before sending",
      );
    }

    // T-21: the VAT rate on every line is the one in force today.
    const profile = await taxProfileOn(ctx.tx, ctx.businessDate);
    if (!profile) throw new ConflictError("no_tax_profile", "No tax profile is in force");
    for (const line of lines) {
      const expected =
        profile.registrationStatus === "registered"
          ? await taxCodeRateOn(ctx.tx, line.tax_code, ctx.businessDate)
          : "0.00";
      if (expected !== line.tax_rate) {
        throw new ConflictError(
          "tax_rate_changed",
          "A VAT rate changed since an item was added; add it again",
        );
      }
    }

    // The latest terms text per language (none until the owners supply it, OD-20).
    const latestTerms = async (language: "ar" | "en") =>
      (
        await ctx.tx
          .selectFrom("terms_text")
          .select("id")
          .where("kind", "=", "estimate")
          .where("language", "=", language)
          .orderBy("version_no", "desc")
          .executeTakeFirst()
      )?.id ?? null;
    const terms = { ar: await latestTerms("ar"), en: await latestTerms("en") };

    // OD-21: validity from the setting; millisecond precision so the snapshot and the column agree.
    const setting = await ctx.tx
      .selectFrom("app_setting")
      .select("value")
      .where("key", "=", "estimate.validity_days")
      .executeTakeFirstOrThrow();
    const days = String(setting.value);
    if (!/^[1-9][0-9]{0,2}$/.test(days)) throw new Error(`Invalid estimate.validity_days ${days}`);
    const expiry = await sql<{ expires_at: Date }>`
      SELECT date_trunc('milliseconds', now() + make_interval(days => ${Number.parseInt(days, 10)})) AS expires_at`.execute(
      ctx.tx,
    );
    const expiresAt = expiry.rows[0]!.expires_at;

    const snapshot = await buildSnapshot(ctx.tx, versionId, { expiresAt, terms });
    const contentHash = hashSnapshot(snapshot);
    await ctx.tx
      .updateTable("estimate_version")
      .set({
        status: "sent",
        sent_by: staff.userId,
        expires_at: expiresAt,
        snapshot: JSON.stringify(snapshot),
        content_hash: contentHash,
        terms_ar_id: terms.ar,
        terms_en_id: terms.en,
      })
      .where("id", "=", versionId)
      .execute();
    await ctx.tx
      .updateTable("job_revision")
      .set({ status: "pending" })
      .where(
        "id",
        "in",
        jobs.map((job) => job.revision_id),
      )
      .execute();
    // v0.2 §5: the first version moves the car to Awaiting approval; a later one leaves it where it is
    // (Awaiting approval, or In progress while approved work continues, §3.2).
    const firstSend = ro.status === "checked_in" || ro.status === "diagnosing";
    if (firstSend) {
      await ctx.tx
        .updateTable("repair_order")
        .set({ status: "awaiting_approval" })
        .where("id", "=", repairOrderId)
        .execute();
    }

    await ctx.audit({
      action: "estimate.sent",
      entityType: "estimate_version",
      entityId: versionId,
      after: {
        repairOrderId,
        contentHash,
        expiresAt: expiresAt.toISOString(),
        total: snapshot.totals.total,
        jobs: jobs.length,
        versionNo: snapshot.versionNo,
        terms,
      },
    });
    if (firstSend) {
      await ctx.audit({
        action: "ro.awaiting_approval",
        entityType: "repair_order",
        entityId: repairOrderId,
        before: { status: ro.status },
        after: { status: "awaiting_approval" },
      });
    }
    return { versionId, contentHash };
  });
}

// --------------------------------------------------------------------------- in-person approval

export interface InPersonApprovalInput {
  versionId: unknown;
  contentHash: unknown;
  language: unknown;
  approverName: unknown;
  decisions: unknown;
  signature: Uint8Array;
}

type ApprovalResult =
  { kind: "expired"; approvalEventId: null } | { kind: "recorded"; approvalEventId: string };

interface Decision {
  revisionId: string;
  decision: "approved" | "declined";
}

function parseDecisions(value: unknown): Decision[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("Choose approve or decline for at least one job", { field: "decisions" });
  }
  const decisions = value.map((entry: unknown) => {
    const { revisionId, decision } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof revisionId !== "string" ||
      !isUuid(revisionId) ||
      (decision !== "approved" && decision !== "declined")
    ) {
      throw new ValidationError("Choose approve or decline for each job", { field: "decisions" });
    }
    return { revisionId, decision } as Decision;
  });
  if (new Set(decisions.map((d) => d.revisionId)).size !== decisions.length) {
    throw new ValidationError("Each job is decided once", { field: "decisions" });
  }
  return decisions.sort((a, b) => (a.revisionId < b.revisionId ? -1 : 1));
}

/**
 * Records the customer's decisions on whole jobs (the revision is the unit; there is no line-level approval)
 * with their signature. The signature bytes are stored first (rule 3); a failure afterwards leaves only an
 * unreferenced file.
 */
export async function recordInPersonApproval(
  db: Kysely<DB>,
  storage: MediaStorage,
  staff: Staff,
  input: InPersonApprovalInput,
  idempotencyKey: string,
): Promise<CommandOutcome<{ approvalEventId: string; repairOrderId: string }>> {
  requirePermission(staff, "estimate.record_approval");
  const versionId = typeof input.versionId === "string" ? input.versionId : "";
  if (!isUuid(versionId)) throw new NotFoundError("estimate_version", versionId);
  const contentHash = typeof input.contentHash === "string" ? input.contentHash : "";
  if (!/^[0-9a-f]{64}$/.test(contentHash))
    throw new ValidationError("Unknown estimate", { field: "contentHash" });
  const language = input.language;
  if (language !== "ar" && language !== "en")
    throw new ValidationError("Choose a language", { field: "language" });
  const approverName = typeof input.approverName === "string" ? input.approverName.trim() : "";
  if (approverName.length < 1 || approverName.length > 200) {
    throw new ValidationError("The customer's name is required", { field: "approverName" });
  }
  const decisions = parseDecisions(input.decisions);
  if (input.signature.byteLength > MAX_SIGNATURE_BYTES) {
    throw new ValidationError("The signature image is too large", {
      field: "signature",
      reason: "too_large",
    });
  }
  const image = inspectImage(input.signature);
  if (!image)
    throw new ValidationError("A signature is required", { field: "signature", reason: "not_image" });

  const owner = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select("estimate.repair_order_id")
    .where("estimate_version.id", "=", versionId)
    .executeTakeFirst();
  if (!owner) throw new NotFoundError("estimate_version", versionId);
  const repairOrderId = owner.repair_order_id;

  // Evidence lives apart from photos, so a clean-up of unreferenced photos can never reach it.
  const extension =
    image.contentType === "image/png" ? "png" : image.contentType === "image/jpeg" ? "jpg" : "webp";
  const storageKey = `signatures/${image.sha256.slice(0, 2)}/${image.sha256}.${extension}`;
  await storage.put(storageKey, input.signature);

  const options = {
    name: "estimate.record_in_person_approval",
    actor: actorOf(staff),
    idempotency: {
      key: idempotencyKey,
      payload: {
        versionId,
        contentHash,
        language,
        approverName,
        decisions: decisions.map((d) => ({ revisionId: d.revisionId, decision: d.decision })),
        signature: image.sha256,
      },
    },
  };
  const outcome = await runCommand(db, options, async (ctx): Promise<ApprovalResult> => {
    await ctx.locks.acquire("repair_order", [repairOrderId]);
    // §5 / AC21-07: an overdue version expires now, scheduler or not. The expiry must commit, so the refusal is
    // returned as a result and thrown after the transaction.
    const expired = await expireIfDue(ctx, repairOrderId, "submission");
    if (expired?.versionId === versionId) return { kind: "expired", approvalEventId: null } as ApprovalResult;
    const version = await ctx.tx
      .selectFrom("estimate_version")
      .select(["status", "content_hash", "expires_at", "terms_ar_id", "terms_en_id"])
      .where("id", "=", versionId)
      .executeTakeFirstOrThrow();
    if (version.status === "expired") {
      throw new ConflictError("estimate_expired", "This estimate has expired");
    }
    if (version.status === "draft") {
      throw new ConflictError("estimate_not_sent", "This estimate is not awaiting a decision", {
        status: version.status,
      });
    }
    if (version.status !== "sent") {
      // AC21-05: withdrawn (or fully decided) before this submission got the lock.
      throw new ConflictError("estimate_updated", "This estimate has been updated", {
        status: version.status,
      });
    }
    if (version.content_hash !== contentHash) {
      throw new ConflictError("estimate_changed", "The estimate shown is not the one that was sent");
    }

    const pending = await ctx.tx
      .selectFrom("job_revision")
      .innerJoin("repair_job", "repair_job.id", "job_revision.job_id")
      .leftJoin("finding", "finding.id", "repair_job.finding_id")
      .select(["job_revision.id", "job_revision.job_id", "repair_job.title", "finding.severity"])
      .where("job_revision.proposed_in_version_id", "=", versionId)
      .where("job_revision.status", "=", "pending")
      .execute();
    const byRevision = new Map(pending.map((row) => [row.id, row]));
    if (decisions.some((d) => !byRevision.has(d.revisionId))) {
      throw new ConflictError("revision_not_pending", "A job was already decided or is not in this estimate");
    }

    const ro = await ctx.tx
      .selectFrom("repair_order")
      .select(["status", "contact_name", "contact_mobile"])
      .where("id", "=", repairOrderId)
      .executeTakeFirstOrThrow();
    if (ro.status !== "awaiting_approval" && ro.status !== "in_progress") {
      throw new ConflictError("estimate_closed", `Repair order is ${ro.status}`, { status: ro.status });
    }
    const event = await ctx.tx
      .insertInto("approval_event")
      .values({
        estimate_version_id: versionId,
        method: "in_person_signature",
        verification_level: "in_person",
        approver_name: approverName,
        signature_sha256: image.sha256,
        signature_storage_key: storageKey,
        signature_content_type: image.contentType,
        contact_name: ro.contact_name,
        contact_mobile: ro.contact_mobile,
        displayed_language: language,
        terms_ar_id: version.terms_ar_id,
        terms_en_id: version.terms_en_id,
        content_hash: contentHash,
        idempotency_key: idempotencyKey,
        recorded_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const recorded = [];
    for (const { revisionId, decision } of decisions) {
      const revision = byRevision.get(revisionId)!;
      const urgentAckPending = decision === "declined" && revision.severity === "urgent";
      await ctx.tx
        .insertInto("revision_decision")
        .values({
          approval_event_id: event.id,
          revision_id: revisionId,
          decision,
          urgent_ack_pending: urgentAckPending,
        })
        .execute();
      await ctx.tx
        .updateTable("job_revision")
        .set({ status: decision })
        .where("id", "=", revisionId)
        .execute();
      if (decision === "approved") {
        // v0.2.1 §3.3: Not authorized → Authorized when the job's first revision is approved.
        await ctx.tx
          .updateTable("repair_job")
          .set({ execution_status: "authorized", updated_by: staff.userId })
          .where("id", "=", revision.job_id)
          .where("execution_status", "=", "not_authorized")
          .execute();
      }
      recorded.push({ jobId: revision.job_id, revisionId, decision, urgentAckPending });
    }

    const stillPending = pending.length - decisions.length;
    if (stillPending === 0) {
      await ctx.tx
        .updateTable("estimate_version")
        .set({ status: "closed" })
        .where("id", "=", versionId)
        .execute();
    }
    await ctx.audit({
      action: "estimate.approval_recorded",
      entityType: "approval_event",
      entityId: event.id,
      after: {
        versionId,
        method: "in_person_signature",
        approverName,
        language,
        contentHash,
        decisions: recorded,
        versionClosed: stillPending === 0,
      },
    });

    // v0.2 §5: Awaiting approval → In progress when a job is approved (T-22).
    if (ro.status === "awaiting_approval" && decisions.some((d) => d.decision === "approved")) {
      await ctx.tx
        .updateTable("repair_order")
        .set({ status: "in_progress" })
        .where("id", "=", repairOrderId)
        .execute();
      await ctx.audit({
        action: "ro.work_authorized",
        entityType: "repair_order",
        entityId: repairOrderId,
        before: { status: "awaiting_approval" },
        after: { status: "in_progress" },
      });
    }
    return { kind: "recorded", approvalEventId: event.id } as ApprovalResult;
  });
  if (outcome.result.kind === "expired") {
    throw new ConflictError("estimate_expired", "This estimate has expired");
  }
  return { ...outcome, result: { approvalEventId: outcome.result.approvalEventId, repairOrderId } };
}

// --------------------------------------------------------------------------- authorized scope

/**
 * Authorized scope of a job (v0.2.1 §2.1 #7): lines of its Approved revisions, minus lines superseded by a
 * line in another Approved revision. I1-06 (start work) and I1-07 (issue parts) build on this.
 */
export async function authorizedScope(db: Kysely<DB>, jobId: string): Promise<string[]> {
  if (!isUuid(jobId)) return [];
  const lines = await db
    .selectFrom("revision_line")
    .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
    .select(["revision_line.id", "revision_line.supersedes_line_id"])
    .where("job_revision.job_id", "=", jobId)
    .where("job_revision.status", "=", "approved")
    .where("revision_line.removed_at", "is", null)
    .orderBy("revision_line.created_at")
    .execute();
  const superseded = new Set(lines.map((line) => line.supersedes_line_id).filter((id) => id !== null));
  return lines.filter((line) => !superseded.has(line.id)).map((line) => line.id);
}

/** AC2-01: work may start only on a job with an approved revision. */
export async function isJobAuthorized(db: Kysely<DB>, jobId: string): Promise<boolean> {
  return (await authorizedScope(db, jobId)).length > 0;
}
