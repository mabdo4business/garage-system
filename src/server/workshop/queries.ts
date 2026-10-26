import type { Kysely } from "kysely";
import { isUuid } from "../core/ids";
import type { DB, Emirate, FindingSeverity, JobExecutionStatus, RepairOrderStatus } from "../db/schema";
import { authorizedScope } from "../estimate/approval";
import { qcBlockerOf, type QcBlocker } from "../quality/queries";

/**
 * Workshop reads (I1-06). None of them returns a price, cost or customer contact (AC2-30, AC-07.3): every view is
 * built from an explicit list of fields. Callers check permission and job access first.
 */

const OPEN_STATUSES: RepairOrderStatus[] = [
  "checked_in",
  "diagnosing",
  "awaiting_approval",
  "in_progress",
  "qc",
  "release_check",
  "ready",
];

type Plate = { emirate: Emirate; code: string; number: string } | null;

export interface BoardJob {
  id: string;
  title: string;
  status: JobExecutionStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  bay: string | null;
}

export interface BoardRepairOrder {
  id: string;
  number: string;
  status: RepairOrderStatus;
  plate: Plate;
  make: string;
  model: string;
  year: number;
  promisedAt: Date | null;
  checkedInAt: Date;
  /** When the estimate version awaiting the customer was sent (null when nothing is awaiting a decision). */
  decisionSentAt: Date | null;
  /** In progress: what still stops a QC request (null: it can be requested). Other statuses: null. */
  qcBlocker: QcBlocker | null;
  jobs: BoardJob[];
  flags: { awaitingDecision: boolean; paused: boolean; workDone: boolean; anotherOpen: boolean };
}

/** US-07.1: every open repair order with its jobs, assignee, bay, promised time and flags. */
export async function workshopBoard(db: Kysely<DB>): Promise<BoardRepairOrder[]> {
  const orders = await db
    .selectFrom("repair_order")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_order.id",
      "repair_order.number",
      "repair_order.status",
      "repair_order.vehicle_id",
      "repair_order.promised_at",
      "repair_order.checked_in_at",
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("repair_order.status", "in", OPEN_STATUSES)
    .orderBy("repair_order.checked_in_at")
    .execute();
  if (orders.length === 0) return [];
  const ids = orders.map((order) => order.id);
  const jobs = await db
    .selectFrom("repair_job")
    .leftJoin("job_assignment", (join) =>
      join.onRef("job_assignment.job_id", "=", "repair_job.id").on("job_assignment.ended_at", "is", null),
    )
    .leftJoin("app_user", "app_user.id", "job_assignment.assignee_id")
    .select([
      "repair_job.id",
      "repair_job.repair_order_id",
      "repair_job.title",
      "repair_job.execution_status",
      "job_assignment.assignee_id",
      "job_assignment.bay",
      "app_user.display_name",
    ])
    .where("repair_job.repair_order_id", "in", ids)
    .where("repair_job.removed_at", "is", null)
    .where("repair_job.execution_status", "<>", "not_authorized")
    .orderBy("repair_job.created_at")
    .execute();
  const sent = await db
    .selectFrom("estimate_version")
    .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
    .select(["estimate.repair_order_id", "estimate_version.sent_at"])
    .where("estimate.repair_order_id", "in", ids)
    .where("estimate_version.status", "=", "sent")
    .execute();
  const awaiting = new Map(sent.map((row) => [row.repair_order_id, row.sent_at]));
  const vehicles = new Map<string, number>();
  for (const order of orders) vehicles.set(order.vehicle_id, (vehicles.get(order.vehicle_id) ?? 0) + 1);

  return orders.map((order) => {
    const own = jobs.filter((job) => job.repair_order_id === order.id);
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      plate:
        order.emirate && order.code !== null && order.plate_number !== null
          ? { emirate: order.emirate, code: order.code, number: order.plate_number }
          : null,
      make: order.make,
      model: order.model,
      year: order.year,
      promisedAt: order.promised_at,
      checkedInAt: order.checked_in_at,
      decisionSentAt: awaiting.get(order.id) ?? null,
      qcBlocker:
        order.status === "in_progress"
          ? qcBlockerOf(
              order.status,
              awaiting.has(order.id),
              own.map((job) => job.execution_status),
            )
          : null,
      jobs: own.map((job) => ({
        id: job.id,
        title: job.title,
        status: job.execution_status,
        assigneeId: job.assignee_id,
        assigneeName: job.display_name,
        bay: job.bay,
      })),
      flags: {
        awaitingDecision: awaiting.has(order.id),
        paused: own.some((job) => job.execution_status === "paused"),
        workDone: own.length > 0 && own.every((job) => job.execution_status === "done"),
        anotherOpen: (vehicles.get(order.vehicle_id) ?? 0) > 1, // OQ-1
      },
    };
  });
}

export interface MyJob {
  id: string;
  title: string;
  status: JobExecutionStatus;
  bay: string | null;
  repairOrderNumber: string;
  plate: Plate;
  make: string;
  model: string;
}

/** US-07.3: the jobs assigned to this person that are still to do. */
export async function myJobs(db: Kysely<DB>, userId: string): Promise<MyJob[]> {
  const rows = await db
    .selectFrom("job_assignment")
    .innerJoin("repair_job", "repair_job.id", "job_assignment.job_id")
    .innerJoin("repair_order", "repair_order.id", "repair_job.repair_order_id")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_job.id",
      "repair_job.title",
      "repair_job.execution_status",
      "job_assignment.bay",
      "repair_order.number",
      "vehicle.make",
      "vehicle.model",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("job_assignment.assignee_id", "=", userId)
    .where("job_assignment.ended_at", "is", null)
    .where("repair_job.execution_status", "in", ["authorized", "waiting_parts", "in_progress", "paused"])
    .orderBy("job_assignment.assigned_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.execution_status,
    bay: row.bay,
    repairOrderNumber: row.number,
    plate:
      row.emirate && row.code !== null && row.plate_number !== null
        ? { emirate: row.emirate, code: row.code, number: row.plate_number }
        : null,
    make: row.make,
    model: row.model,
  }));
}

export interface JobCard {
  id: string;
  title: string;
  status: JobExecutionStatus;
  reason: string | null;
  repairOrderId: string;
  repairOrderNumber: string;
  repairOrderStatus: RepairOrderStatus;
  vehicle: { make: string; model: string; year: number; plate: Plate; odometerKm: number };
  concerns: string;
  warningLights: string | null;
  finding: {
    title: string;
    severity: FindingSeverity;
    customerNote: string | null;
    internalNote: string | null;
  } | null;
  assigneeId: string | null;
  assigneeName: string | null;
  bay: string | null;
  /** The authorized lines only (US-07.3 "only approved work"): what to do, never what it costs. */
  lines: {
    id: string;
    descriptionEn: string;
    descriptionAr: string;
    qty: string;
    unit: string | null;
    lineType: string;
    /** Part lines: quantity issued or received for the line so far (never its cost, AC2-30). */
    partsQty: string | null;
    outcome: "done" | "not_performed" | null;
    reason: string | null;
  }[];
  history: { from: string; to: string; reason: string | null; actorName: string | null; at: Date }[];
}

export async function jobCard(db: Kysely<DB>, jobId: string): Promise<JobCard | null> {
  if (!isUuid(jobId)) return null;
  const row = await db
    .selectFrom("repair_job")
    .innerJoin("repair_order", "repair_order.id", "repair_job.repair_order_id")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .leftJoin("finding", "finding.id", "repair_job.finding_id")
    .leftJoin("job_assignment", (join) =>
      join.onRef("job_assignment.job_id", "=", "repair_job.id").on("job_assignment.ended_at", "is", null),
    )
    .leftJoin("app_user", "app_user.id", "job_assignment.assignee_id")
    .select([
      "repair_job.id",
      "repair_job.title",
      "repair_job.execution_status",
      "repair_job.execution_reason",
      "repair_job.removed_at",
      "repair_order.id as repair_order_id",
      "repair_order.number",
      "repair_order.status as ro_status",
      "repair_order.odometer_km",
      "repair_order.concerns",
      "repair_order.warning_lights",
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
      "finding.title as finding_title",
      "finding.severity",
      "finding.customer_note",
      "finding.internal_note",
      "job_assignment.assignee_id",
      "job_assignment.bay",
      "app_user.display_name",
    ])
    .where("repair_job.id", "=", jobId)
    .executeTakeFirst();
  if (!row || row.removed_at) return null;

  const scope = await authorizedScope(db, jobId);
  const lines =
    scope.length === 0
      ? []
      : await db
          .selectFrom("revision_line")
          .leftJoin("job_line_outcome", (join) =>
            join
              .onRef("job_line_outcome.revision_line_id", "=", "revision_line.id")
              .on("job_line_outcome.superseded_at", "is", null),
          )
          .leftJoin("line_wip", "line_wip.revision_line_id", "revision_line.id")
          .select([
            "revision_line.id",
            "revision_line.description_en",
            "revision_line.description_ar",
            "revision_line.qty",
            "revision_line.unit",
            "revision_line.line_type",
            "line_wip.qty as parts_qty",
            "job_line_outcome.outcome",
            "job_line_outcome.reason",
          ])
          .where("revision_line.id", "in", scope)
          .orderBy("revision_line.created_at")
          .execute();
  const history = await db
    .selectFrom("job_status_event")
    .leftJoin("app_user", "app_user.id", "job_status_event.actor_id")
    .select([
      "job_status_event.from_status",
      "job_status_event.to_status",
      "job_status_event.reason",
      "job_status_event.occurred_at",
      "app_user.display_name",
    ])
    .where("job_status_event.job_id", "=", jobId)
    .orderBy("job_status_event.occurred_at")
    .execute();

  return {
    id: row.id,
    title: row.title,
    status: row.execution_status,
    reason: row.execution_reason,
    repairOrderId: row.repair_order_id,
    repairOrderNumber: row.number,
    repairOrderStatus: row.ro_status,
    vehicle: {
      make: row.make,
      model: row.model,
      year: row.year,
      odometerKm: row.odometer_km,
      plate:
        row.emirate && row.code !== null && row.plate_number !== null
          ? { emirate: row.emirate, code: row.code, number: row.plate_number }
          : null,
    },
    concerns: row.concerns,
    warningLights: row.warning_lights,
    finding:
      row.finding_title && row.severity
        ? {
            title: row.finding_title,
            severity: row.severity,
            customerNote: row.customer_note,
            internalNote: row.internal_note,
          }
        : null,
    assigneeId: row.assignee_id,
    assigneeName: row.display_name,
    bay: row.bay,
    lines: lines.map((line) => ({
      id: line.id,
      descriptionEn: line.description_en,
      descriptionAr: line.description_ar,
      qty: line.qty,
      unit: line.unit,
      lineType: line.line_type,
      partsQty: line.line_type === "part" ? (line.parts_qty ?? "0.000") : null,
      outcome: line.outcome,
      reason: line.reason,
    })),
    history: history.map((event) => ({
      from: event.from_status,
      to: event.to_status,
      reason: event.reason,
      actorName: event.display_name,
      at: event.occurred_at,
    })),
  };
}

/** People a job can be assigned to (OD-27): active technicians, managers and partners. */
export async function assignableStaff(
  db: Kysely<DB>,
): Promise<{ id: string; displayName: string; role: string }[]> {
  const rows = await db
    .selectFrom("app_user")
    .innerJoin("user_role", "user_role.user_id", "app_user.id")
    .select(["app_user.id", "app_user.display_name", "user_role.role"])
    .where("app_user.status", "=", "active")
    .where("user_role.role", "in", ["technician", "manager", "partner"])
    .orderBy("user_role.role", "desc")
    .orderBy("app_user.display_name")
    .execute();
  const seen = new Set<string>();
  return rows
    .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
    .map((row) => ({ id: row.id, displayName: row.display_name, role: row.role }));
}
