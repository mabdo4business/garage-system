import type { Kysely } from "kysely";
import { isUuid } from "../core/ids";
import { canReadContact } from "../customer/service";
import type {
  CheckInStatus,
  ContactRelationship,
  DB,
  Emirate,
  PhotoSlot,
  RepairOrderStatus,
} from "../db/schema";

/**
 * Plain reads for the check-in and repair-order screens (rule 1: reads are fine outside a command).
 * The authorized contact's mobile is shown only to roles with customer.read_contact, as in I1-01.
 */

export interface PhotoView {
  id: string;
  slot: PhotoSlot;
  width: number;
  height: number;
  uploadedAt: Date;
  excluded: { at: Date; reason: string } | null;
}

interface VehicleSummary {
  vehicleId: string;
  make: string;
  model: string;
  year: number;
  plate: { emirate: Emirate; code: string; number: string } | null;
  customerId: string;
  customerName: string | null;
}

export interface ArrivalDetails {
  contactName: string | null;
  /** Null when the viewer may not read contact details. */
  contactMobile: string | null;
  contactRelationship: ContactRelationship | null;
  odometerKm: number | null;
  fuelEighths: number | null;
  warningLights: string | null;
  concerns: string | null;
  belongings: string | null;
  keysReceived: number | null;
  keyTag: string | null;
  promisedAt: Date | null;
  photoShortfallReason: string | null;
}

export interface CheckInView extends VehicleSummary, ArrivalDetails {
  id: string;
  status: CheckInStatus;
  repairOrderId: string | null;
  photos: PhotoView[];
}

export interface RepairOrderView extends VehicleSummary, ArrivalDetails {
  id: string;
  number: string;
  status: RepairOrderStatus;
  checkedInAt: Date;
  checkedInByName: string | null;
  photos: PhotoView[];
}

async function vehicleSummary(
  db: Kysely<DB>,
  vehicleId: string,
  customerId: string,
): Promise<VehicleSummary> {
  const vehicle = await db
    .selectFrom("vehicle")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number",
    ])
    .where("vehicle.id", "=", vehicleId)
    .executeTakeFirstOrThrow();
  const customer = await db
    .selectFrom("customer")
    .select(["name_en", "name_ar"])
    .where("id", "=", customerId)
    .executeTakeFirstOrThrow();
  return {
    vehicleId,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    plate:
      vehicle.emirate && vehicle.code && vehicle.number
        ? { emirate: vehicle.emirate, code: vehicle.code, number: vehicle.number }
        : null,
    customerId,
    customerName: customer.name_en ?? customer.name_ar,
  };
}

async function photos(db: Kysely<DB>, where: { checkInId: string }): Promise<PhotoView[]> {
  const rows = await db
    .selectFrom("media_asset")
    .select(["id", "slot", "width", "height", "uploaded_at", "excluded_at", "excluded_reason"])
    .where("check_in_id", "=", where.checkInId)
    .where("discarded_at", "is", null)
    .orderBy("uploaded_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    slot: row.slot,
    width: row.width,
    height: row.height,
    uploadedAt: row.uploaded_at,
    excluded:
      row.excluded_at && row.excluded_reason ? { at: row.excluded_at, reason: row.excluded_reason } : null,
  }));
}

function arrival(
  row: {
    contact_name: string | null;
    contact_mobile: string | null;
    contact_relationship: ContactRelationship | null;
    odometer_km: number | null;
    fuel_eighths: number | null;
    warning_lights: string | null;
    concerns: string | null;
    belongings: string | null;
    keys_received: number | null;
    key_tag: string | null;
    promised_at: Date | null;
    photo_shortfall_reason: string | null;
  },
  viewerRoles: readonly string[],
): ArrivalDetails {
  return {
    contactName: row.contact_name,
    contactMobile: canReadContact(viewerRoles) ? row.contact_mobile : null,
    contactRelationship: row.contact_relationship,
    odometerKm: row.odometer_km,
    fuelEighths: row.fuel_eighths,
    warningLights: row.warning_lights,
    concerns: row.concerns,
    belongings: row.belongings,
    keysReceived: row.keys_received,
    keyTag: row.key_tag,
    promisedAt: row.promised_at,
    photoShortfallReason: row.photo_shortfall_reason,
  };
}

export async function getCheckIn(
  db: Kysely<DB>,
  viewerRoles: readonly string[],
  id: string,
): Promise<CheckInView | null> {
  if (!isUuid(id)) return null;
  const row = await db.selectFrom("check_in").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return null;
  const repairOrder = await db
    .selectFrom("repair_order")
    .select("id")
    .where("check_in_id", "=", id)
    .executeTakeFirst();
  return {
    id: row.id,
    status: row.status,
    repairOrderId: repairOrder?.id ?? null,
    ...(await vehicleSummary(db, row.vehicle_id, row.customer_id)),
    ...arrival(row, viewerRoles),
    photos: await photos(db, { checkInId: row.id }),
  };
}

export async function getRepairOrder(
  db: Kysely<DB>,
  viewerRoles: readonly string[],
  id: string,
): Promise<RepairOrderView | null> {
  if (!isUuid(id)) return null;
  const row = await db
    .selectFrom("repair_order")
    .leftJoin("app_user", "app_user.id", "repair_order.checked_in_by")
    .selectAll("repair_order")
    .select("app_user.display_name")
    .where("repair_order.id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    checkedInAt: row.checked_in_at,
    checkedInByName: row.display_name,
    ...(await vehicleSummary(db, row.vehicle_id, row.customer_id)),
    ...arrival(row, viewerRoles),
    photos: await photos(db, { checkInId: row.check_in_id }),
  };
}

export interface RepairOrderListItem {
  id: string;
  number: string;
  status: RepairOrderStatus;
  checkedInAt: Date;
  make: string;
  model: string;
  plate: { emirate: Emirate; code: string; number: string } | null;
  customerName: string | null;
}

export interface CheckInListItem {
  id: string;
  startedAt: Date;
  make: string;
  model: string;
  plate: { emirate: Emirate; code: string; number: string } | null;
}

const OPEN_STATUSES: RepairOrderStatus[] = [
  "checked_in",
  "diagnosing",
  "awaiting_approval",
  "in_progress",
  "qc",
  "release_check",
  "ready",
];

/** The Repair orders screen: open repair orders, newest first, and check-ins still in progress. */
export async function listOpenWork(
  db: Kysely<DB>,
): Promise<{ repairOrders: RepairOrderListItem[]; checkIns: CheckInListItem[] }> {
  const repairOrders = await db
    .selectFrom("repair_order")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .innerJoin("customer", "customer.id", "repair_order.customer_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_order.id",
      "repair_order.number",
      "repair_order.status",
      "repair_order.checked_in_at",
      "vehicle.make",
      "vehicle.model",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
      "customer.name_en",
      "customer.name_ar",
    ])
    .where("repair_order.status", "in", OPEN_STATUSES)
    .orderBy("repair_order.checked_in_at", "desc")
    .limit(100)
    .execute();
  const checkIns = await db
    .selectFrom("check_in")
    .innerJoin("vehicle", "vehicle.id", "check_in.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "check_in.id",
      "check_in.created_at",
      "vehicle.make",
      "vehicle.model",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number",
    ])
    .where("check_in.status", "=", "in_progress")
    .orderBy("check_in.created_at", "desc")
    .execute();
  const plate = (emirate: Emirate | null, code: string | null, number: string | null) =>
    emirate && code && number ? { emirate, code, number } : null;
  return {
    repairOrders: repairOrders.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      checkedInAt: row.checked_in_at,
      make: row.make,
      model: row.model,
      plate: plate(row.emirate, row.code, row.plate_number),
      customerName: row.name_en ?? row.name_ar,
    })),
    checkIns: checkIns.map((row) => ({
      id: row.id,
      startedAt: row.created_at,
      make: row.make,
      model: row.model,
      plate: plate(row.emirate, row.code, row.number),
    })),
  };
}

/** For GET /api/media/:id — the caller has already authorized the viewer. */
export async function getPhotoFile(
  db: Kysely<DB>,
  mediaId: string,
): Promise<{ storageKey: string; contentType: string } | null> {
  if (!isUuid(mediaId)) return null;
  const row = await db
    .selectFrom("media_asset")
    .select(["storage_key", "content_type"])
    .where("id", "=", mediaId)
    .executeTakeFirst();
  return row ? { storageKey: row.storage_key, contentType: row.content_type } : null;
}
