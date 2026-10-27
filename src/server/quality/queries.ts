import { sql, type Kysely } from "kysely";
import { isUuid } from "../core/ids";
import type { DB, JobExecutionStatus, OldPartsDisposition, QcStatus, RepairOrderStatus } from "../db/schema";

/** QC reads (I1-08). Staff only; no prices. Callers check access first. */

export interface QcRecordView {
  id: string;
  status: QcStatus;
  requestedAt: Date;
  requestedByName: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  roadTest: "done" | "not_applicable" | null;
  roadTestReason: string | null;
  odometerOutKm: number | null;
  odometerReason: string | null;
  oldParts: OldPartsDisposition | null;
  notes: string | null;
}

export interface QcView {
  repairOrderId: string;
  number: string;
  status: RepairOrderStatus;
  odometerInKm: number;
  /** Approved jobs, for the "return for rework" choice on a failed QC. */
  jobs: { id: string; title: string; status: JobExecutionStatus; assigneeName: string | null }[];
  records: QcRecordView[];
  /** What still stops a QC request, if anything (B1 / AC2-25). */
  blocker: QcBlocker | null;
}

export type QcBlocker = "not_in_progress" | "decision_pending" | "draft_open" | "work_not_finished";

/** Why QC cannot be requested yet (null: it can). Jobs are the repair order's authorized, not removed jobs. */
export function qcBlockerOf(
  status: RepairOrderStatus,
  decisionPending: boolean,
  jobStatuses: readonly JobExecutionStatus[],
  draftOpen = false,
): QcBlocker | null {
  if (status !== "in_progress") return "not_in_progress";
  if (decisionPending) return "decision_pending";
  // OD-59: an unsent later version is sent or discarded first, never stranded by QC.
  if (draftOpen) return "draft_open";
  // Same finished set as requestQc and the database guard (migration 0016): done or stopped by the customer.
  if (jobStatuses.some((job) => !["done", "stopped_by_customer"].includes(job))) {
    return "work_not_finished";
  }
  return null;
}

export async function qcView(db: Kysely<DB>, repairOrderId: string): Promise<QcView | null> {
  if (!isUuid(repairOrderId)) return null;
  const ro = await db
    .selectFrom("repair_order")
    .select(["id", "number", "status", "odometer_km"])
    .where("id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro) return null;
  const jobs = await db
    .selectFrom("repair_job")
    .leftJoin("job_assignment", (join) =>
      join.onRef("job_assignment.job_id", "=", "repair_job.id").on("job_assignment.ended_at", "is", null),
    )
    .leftJoin("app_user", "app_user.id", "job_assignment.assignee_id")
    .select(["repair_job.id", "repair_job.title", "repair_job.execution_status", "app_user.display_name"])
    .where("repair_job.repair_order_id", "=", repairOrderId)
    .where("repair_job.removed_at", "is", null)
    .where("repair_job.execution_status", "<>", "not_authorized")
    .orderBy("repair_job.created_at")
    .execute();
  const records = await db
    .selectFrom("qc_record")
    .leftJoin("app_user as requester", "requester.id", "qc_record.requested_by")
    .leftJoin("app_user as checker", "checker.id", "qc_record.decided_by")
    .selectAll("qc_record")
    .select(["requester.display_name as requested_by_name", "checker.display_name as decided_by_name"])
    .where("qc_record.repair_order_id", "=", repairOrderId)
    .orderBy("qc_record.requested_at", "desc")
    .execute();
  const sent = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select("estimate_version.id")
    .where("estimate.repair_order_id", "=", repairOrderId)
    .where("estimate_version.status", "=", "sent")
    // An overdue version no longer blocks: requesting QC records its expiry (I2-01).
    .where("estimate_version.expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  const draft = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select("estimate_version.id")
    .where("estimate.repair_order_id", "=", repairOrderId)
    .where("estimate_version.status", "=", "draft")
    .executeTakeFirst();
  const blocker = qcBlockerOf(
    ro.status,
    Boolean(sent),
    jobs.map((job) => job.execution_status),
    Boolean(draft),
  );
  return {
    repairOrderId: ro.id,
    number: ro.number,
    status: ro.status,
    odometerInKm: ro.odometer_km,
    jobs: jobs.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.execution_status,
      assigneeName: job.display_name,
    })),
    records: records.map((row) => ({
      id: row.id,
      status: row.status,
      requestedAt: row.requested_at,
      requestedByName: row.requested_by_name,
      decidedAt: row.decided_at,
      decidedByName: row.decided_by_name,
      roadTest: row.road_test,
      roadTestReason: row.road_test_reason,
      odometerOutKm: row.odometer_out_km,
      odometerReason: row.odometer_reason,
      oldParts: row.old_parts,
      notes: row.notes,
    })),
    blocker,
  };
}
