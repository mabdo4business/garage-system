import type { Kysely } from "kysely";
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
  blocker: "not_in_progress" | "decision_pending" | "work_not_finished" | null;
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
    .executeTakeFirst();
  const blocker =
    ro.status !== "in_progress"
      ? "not_in_progress"
      : sent
        ? "decision_pending"
        : jobs.some((job) => !["done", "stopped_by_customer", "cancelled"].includes(job.execution_status))
          ? "work_not_finished"
          : null;
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
