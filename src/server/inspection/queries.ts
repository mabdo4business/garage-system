import type { Kysely } from "kysely";
import { isUuid } from "../core/ids";
import type { DB, Emirate, FindingSeverity } from "../db/schema";
import { assignedTechnician } from "./access";

/**
 * Plain reads for the inspection screens. Callers check access first (requireRepairOrderAccess).
 * Staff views include internal notes; customerFindingsView never does (AC-05.3, AC2-31).
 */

export interface FindingPhotoView {
  id: string;
  visibility: "internal" | "customer";
}

export interface FindingView {
  id: string;
  templateItemId: string | null;
  title: string;
  severity: FindingSeverity;
  faultCodes: string[];
  customerNote: string | null;
  internalNote: string | null;
  status: "active" | "withdrawn";
  withdrawnReason: string | null;
  recordedAt: Date;
  recordedByName: string | null;
  photos: FindingPhotoView[];
}

export interface ChecklistTemplateView {
  code: string;
  nameEn: string;
  nameAr: string;
  items: { id: string; labelEn: string; labelAr: string }[];
}

export interface InspectionView {
  repairOrderId: string;
  number: string;
  status: string;
  make: string;
  model: string;
  year: number;
  plate: { emirate: Emirate; code: string; number: string } | null;
  concerns: string;
  warningLights: string | null;
  technician: { userId: string; displayName: string } | null;
  findings: FindingView[];
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { urgent: 0, soon: 1, ok: 2 };

async function findingRows(db: Kysely<DB>, repairOrderId: string) {
  const findings = await db
    .selectFrom("finding")
    .leftJoin("app_user", "app_user.id", "finding.recorded_by")
    .selectAll("finding")
    .select("app_user.display_name")
    .where("finding.repair_order_id", "=", repairOrderId)
    .orderBy("finding.recorded_at")
    .execute();
  const photos =
    findings.length === 0
      ? []
      : await db
          .selectFrom("media_asset")
          .select(["id", "finding_id", "visibility"])
          .where(
            "finding_id",
            "in",
            findings.map((finding) => finding.id),
          )
          .where("discarded_at", "is", null)
          .orderBy("uploaded_at")
          .execute();
  return findings.map((row): FindingView => ({
    id: row.id,
    templateItemId: row.template_item_id,
    title: row.title,
    severity: row.severity,
    faultCodes: row.fault_codes,
    customerNote: row.customer_note,
    internalNote: row.internal_note,
    status: row.status,
    withdrawnReason: row.withdrawn_reason,
    recordedAt: row.recorded_at,
    recordedByName: row.display_name,
    photos: photos
      .filter((photo) => photo.finding_id === row.id)
      .map((photo) => ({ id: photo.id, visibility: photo.visibility })),
  }));
}

/** Staff view of a repair order's inspection (no contact details: technicians use it too). */
export async function getInspection(db: Kysely<DB>, repairOrderId: string): Promise<InspectionView | null> {
  if (!isUuid(repairOrderId)) return null;
  const ro = await db
    .selectFrom("repair_order")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_order.id",
      "repair_order.number",
      "repair_order.status",
      "repair_order.concerns",
      "repair_order.warning_lights",
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("repair_order.id", "=", repairOrderId)
    .executeTakeFirst();
  if (!ro) return null;
  return {
    repairOrderId: ro.id,
    number: ro.number,
    status: ro.status,
    make: ro.make,
    model: ro.model,
    year: ro.year,
    plate:
      ro.emirate && ro.code && ro.plate_number
        ? { emirate: ro.emirate, code: ro.code, number: ro.plate_number }
        : null,
    concerns: ro.concerns,
    warningLights: ro.warning_lights,
    technician: await assignedTechnician(db, repairOrderId),
    findings: await findingRows(db, repairOrderId),
  };
}

export async function listChecklistTemplates(db: Kysely<DB>): Promise<ChecklistTemplateView[]> {
  const templates = await db.selectFrom("checklist_template").selectAll().orderBy("position").execute();
  const items = await db.selectFrom("checklist_template_item").selectAll().orderBy("position").execute();
  return templates.map((template) => ({
    code: template.code,
    nameEn: template.name_en,
    nameAr: template.name_ar,
    items: items
      .filter((item) => item.template_code === template.code)
      .map((item) => ({ id: item.id, labelEn: item.label_en, labelAr: item.label_ar })),
  }));
}

/** Active technicians, for the assign form. */
export async function listTechnicians(db: Kysely<DB>): Promise<{ userId: string; displayName: string }[]> {
  const rows = await db
    .selectFrom("app_user")
    .innerJoin("user_role", "user_role.user_id", "app_user.id")
    .select(["app_user.id", "app_user.display_name"])
    .where("user_role.role", "=", "technician")
    .where("app_user.status", "=", "active")
    .orderBy("app_user.display_name")
    .execute();
  return rows.map((row) => ({ userId: row.id, displayName: row.display_name }));
}

export interface MyInspectionItem {
  repairOrderId: string;
  number: string;
  make: string;
  model: string;
  plate: { emirate: Emirate; code: string; number: string } | null;
  concerns: string;
  assignedAt: Date;
}

/** The technician's assigned, still-open inspections — no contact details, no prices. */
export async function myInspections(db: Kysely<DB>, technicianUserId: string): Promise<MyInspectionItem[]> {
  const rows = await db
    .selectFrom("inspection_assignment")
    .innerJoin("repair_order", "repair_order.id", "inspection_assignment.repair_order_id")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_order.id",
      "repair_order.number",
      "repair_order.concerns",
      "inspection_assignment.assigned_at",
      "vehicle.make",
      "vehicle.model",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("inspection_assignment.technician_user_id", "=", technicianUserId)
    .where("inspection_assignment.ended_at", "is", null)
    .where("repair_order.status", "in", ["checked_in", "diagnosing"])
    .orderBy("inspection_assignment.assigned_at", "desc")
    .execute();
  return rows.map((row) => ({
    repairOrderId: row.id,
    number: row.number,
    make: row.make,
    model: row.model,
    plate:
      row.emirate && row.code && row.plate_number
        ? { emirate: row.emirate, code: row.code, number: row.plate_number }
        : null,
    concerns: row.concerns,
    assignedAt: row.assigned_at,
  }));
}

/** For the estimate builder (I1-05, AC-05.2): active findings, urgent first. */
export async function findingsForEstimate(db: Kysely<DB>, repairOrderId: string): Promise<FindingView[]> {
  return (await findingRows(db, repairOrderId))
    .filter((finding) => finding.status === "active")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export interface CustomerFinding {
  title: string;
  severity: FindingSeverity;
  faultCodes: string[];
  note: string | null;
  photoIds: string[];
}

/**
 * The only finding data customer-facing output may use (approval page, status page, estimate PDF):
 * no internal note, no staff names, no withdrawn findings, customer-ticked photos only (AC2-31,
 * OD-11). It is built from a fixed list of fields, so new internal columns never leak by default.
 */
export async function customerFindingsView(
  db: Kysely<DB>,
  repairOrderId: string,
): Promise<CustomerFinding[]> {
  return (await findingsForEstimate(db, repairOrderId)).map((finding) => ({
    title: finding.title,
    severity: finding.severity,
    faultCodes: finding.faultCodes,
    note: finding.customerNote,
    photoIds: finding.photos.filter((photo) => photo.visibility === "customer").map((photo) => photo.id),
  }));
}
