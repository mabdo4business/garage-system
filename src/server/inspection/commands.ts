import type { Kysely } from "kysely";
import type { SessionUser } from "../auth/session";
import { runCommand, type CommandContext, type CommandOutcome } from "../command/runner";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { DB, FindingSeverity } from "../db/schema";
import { inspectImage } from "../media/image";
import { photoKey, type MediaStorage } from "../media/storage";
import { getCheckInSettings } from "../repair-order/check-in";
import { canAccessRepairOrder } from "./access";

/**
 * Inspection (I1-03): assignment (OD-8), findings (US-05.2/05.3, OD-10) and finding photos (OD-11).
 * Every command locks the repair order, so work on one inspection is serialised. The caller's
 * permission is checked by the handler; these commands also re-check that a technician is the one
 * assigned (AC2-30), inside the transaction.
 */

export type Staff = Pick<SessionUser, "userId" | "roles">;

export const SEVERITIES: readonly FindingSeverity[] = ["ok", "soon", "urgent"];
const OPEN_FOR_INSPECTION = ["checked_in", "diagnosing"] as const;
const FAULT_CODE = /^[A-Z0-9-]{2,12}$/;

const actorOf = (staff: Staff) => ({ kind: "user" as const, userId: staff.userId });

/** Locks the repair order and checks it is open for inspection and visible to this person. */
async function lockInspection(ctx: CommandContext, staff: Staff, repairOrderId: string) {
  await ctx.locks.acquire("repair_order", [repairOrderId]);
  const ro = await ctx.tx
    .selectFrom("repair_order")
    .select(["id", "status"])
    .where("id", "=", repairOrderId)
    .executeTakeFirstOrThrow();
  if (!(await canAccessRepairOrder(ctx.tx, staff, repairOrderId))) {
    throw new NotFoundError("repair_order", repairOrderId);
  }
  if (!(OPEN_FOR_INSPECTION as readonly string[]).includes(ro.status)) {
    throw new ConflictError("inspection_closed", `Repair order is ${ro.status}`, { status: ro.status });
  }
  return ro;
}

// --------------------------------------------------------------------------- assignment

export async function assignInspection(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  technicianUserId: string,
): Promise<CommandOutcome<{ repairOrderId: string }>> {
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  if (!isUuid(technicianUserId)) {
    throw new ValidationError("Choose a technician", { field: "technicianUserId" });
  }
  return runCommand(db, { name: "inspection.assign", actor: actorOf(staff) }, async (ctx) => {
    const ro = await lockInspection(ctx, staff, repairOrderId);
    const technician = await ctx.tx
      .selectFrom("app_user")
      .innerJoin("user_role", "user_role.user_id", "app_user.id")
      .select(["app_user.id", "app_user.display_name"])
      .where("app_user.id", "=", technicianUserId)
      .where("app_user.status", "=", "active")
      .where("user_role.role", "=", "technician")
      .executeTakeFirst();
    if (!technician) throw new ValidationError("Choose an active technician", { field: "technicianUserId" });

    const current = await ctx.tx
      .selectFrom("inspection_assignment")
      .select(["id", "technician_user_id"])
      .where("repair_order_id", "=", repairOrderId)
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (current?.technician_user_id === technicianUserId) {
      throw new ConflictError("already_assigned", "This technician is already assigned");
    }
    if (current) {
      await ctx.tx
        .updateTable("inspection_assignment")
        .set({ ended_at: ctx.txTime, ended_by: staff.userId })
        .where("id", "=", current.id)
        .execute();
    }
    await ctx.tx
      .insertInto("inspection_assignment")
      .values({
        repair_order_id: repairOrderId,
        technician_user_id: technicianUserId,
        assigned_by: staff.userId,
      })
      .execute();
    await ctx.audit({
      action: current ? "inspection.reassigned" : "inspection.assigned",
      entityType: "repair_order",
      entityId: repairOrderId,
      before: current ? { technicianUserId: current.technician_user_id } : null,
      after: { technicianUserId, technicianName: technician.display_name },
    });

    // B1: Checked-in → Diagnosing when a technician is assigned to the inspection.
    if (ro.status === "checked_in") {
      await ctx.tx
        .updateTable("repair_order")
        .set({ status: "diagnosing" })
        .where("id", "=", repairOrderId)
        .execute();
      await ctx.audit({
        action: "ro.diagnosis_started",
        entityType: "repair_order",
        entityId: repairOrderId,
        before: { status: "checked_in" },
        after: { status: "diagnosing" },
      });
    }
    return { repairOrderId };
  });
}

// --------------------------------------------------------------------------- findings

export interface FindingInput {
  title?: string | null;
  severity?: string | null;
  faultCodes?: string | string[] | null;
  customerNote?: string | null;
  internalNote?: string | null;
  templateItemId?: string | null;
}

interface ValidFinding {
  title: string;
  severity: FindingSeverity;
  fault_codes: string[];
  customer_note: string | null;
  internal_note: string | null;
}

/** Fault codes (T-10): split on commas or spaces, upper-cased, de-duplicated. */
export function parseFaultCodes(input: string | string[] | null | undefined): string[] {
  const parts = Array.isArray(input) ? input : (input ?? "").split(/[\s,;]+/);
  const codes = [...new Set(parts.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (codes.length > 10 || codes.some((code) => !FAULT_CODE.test(code))) {
    throw new ValidationError("Fault codes are 2–12 letters, digits or dashes, at most 10", {
      field: "faultCodes",
    });
  }
  return codes;
}

function note(value: string | null | undefined, field: string): string | null {
  const trimmed = value?.trim() || null;
  if (trimmed && trimmed.length > 2000) throw new ValidationError(`${field} is too long`, { field });
  return trimmed;
}

function validateFinding(input: FindingInput): ValidFinding {
  const title = input.title?.trim() ?? "";
  if (title.length < 1 || title.length > 200)
    throw new ValidationError("A title is required", { field: "title" });
  if (!SEVERITIES.includes(input.severity as FindingSeverity)) {
    throw new ValidationError("Choose OK, Attention soon or Urgent", { field: "severity" });
  }
  return {
    title,
    severity: input.severity as FindingSeverity,
    fault_codes: parseFaultCodes(input.faultCodes),
    customer_note: note(input.customerNote, "customerNote"),
    internal_note: note(input.internalNote, "internalNote"),
  };
}

function findingJson(finding: ValidFinding) {
  return {
    title: finding.title,
    severity: finding.severity,
    faultCodes: finding.fault_codes,
    customerNote: finding.customer_note,
    internalNote: finding.internal_note,
  };
}

export async function recordFinding(
  db: Kysely<DB>,
  staff: Staff,
  repairOrderId: string,
  input: FindingInput,
  idempotencyKey: string,
): Promise<CommandOutcome<{ findingId: string }>> {
  if (!isUuid(repairOrderId)) throw new NotFoundError("repair_order", repairOrderId);
  const finding = validateFinding(input);
  const templateItemId = input.templateItemId?.trim() || null;
  if (templateItemId && !isUuid(templateItemId)) {
    throw new ValidationError("Unknown checklist item", { field: "templateItemId" });
  }
  return runCommand(
    db,
    {
      name: "finding.record",
      actor: actorOf(staff),
      idempotency: {
        key: idempotencyKey,
        payload: { repairOrderId, templateItemId, ...findingJson(finding) },
      },
    },
    async (ctx) => {
      await lockInspection(ctx, staff, repairOrderId);
      if (templateItemId) {
        const item = await ctx.tx
          .selectFrom("checklist_template_item")
          .select("id")
          .where("id", "=", templateItemId)
          .executeTakeFirst();
        if (!item) throw new ValidationError("Unknown checklist item", { field: "templateItemId" });
        // Once per repair order (T-12). The repair-order lock makes this check race-free; a unique
        // index backs it up in the database.
        const existing = await ctx.tx
          .selectFrom("finding")
          .select("id")
          .where("repair_order_id", "=", repairOrderId)
          .where("template_item_id", "=", templateItemId)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (existing)
          throw new ConflictError("item_already_recorded", "This checklist item is already recorded");
      }
      const row = await ctx.tx
        .insertInto("finding")
        .values({
          repair_order_id: repairOrderId,
          template_item_id: templateItemId,
          ...finding,
          recorded_by: staff.userId,
          updated_by: staff.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await ctx.audit({
        action: "finding.recorded",
        entityType: "finding",
        entityId: row.id,
        after: { repairOrderId, templateItemId, ...findingJson(finding) },
      });
      return { findingId: row.id };
    },
  );
}

async function findingParent(db: Kysely<DB>, findingId: string): Promise<string> {
  if (!isUuid(findingId)) throw new NotFoundError("finding", findingId);
  const row = await db
    .selectFrom("finding")
    .select("repair_order_id")
    .where("id", "=", findingId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("finding", findingId);
  return row.repair_order_id;
}

async function lockActiveFinding(
  ctx: CommandContext,
  staff: Staff,
  repairOrderId: string,
  findingId: string,
) {
  await lockInspection(ctx, staff, repairOrderId);
  const row = await ctx.tx
    .selectFrom("finding")
    .selectAll()
    .where("id", "=", findingId)
    .executeTakeFirstOrThrow();
  if (row.status !== "active") throw new ConflictError("finding_withdrawn", "This finding was withdrawn");
  return row;
}

export async function updateFinding(
  db: Kysely<DB>,
  staff: Staff,
  findingId: string,
  input: FindingInput,
): Promise<CommandOutcome<{ findingId: string }>> {
  const finding = validateFinding(input);
  const repairOrderId = await findingParent(db, findingId);
  return runCommand(db, { name: "finding.update", actor: actorOf(staff) }, async (ctx) => {
    const before = await lockActiveFinding(ctx, staff, repairOrderId, findingId);
    await ctx.tx
      .updateTable("finding")
      .set({ ...finding, updated_at: ctx.txTime, updated_by: staff.userId })
      .where("id", "=", findingId)
      .execute();
    await ctx.audit({
      action: "finding.updated",
      entityType: "finding",
      entityId: findingId,
      before: findingJson(before),
      after: findingJson(finding),
    });
    return { findingId };
  });
}

export async function withdrawFinding(
  db: Kysely<DB>,
  staff: Staff,
  findingId: string,
  reason: string,
): Promise<CommandOutcome<{ findingId: string }>> {
  const why = reason.trim();
  if (why.length < 1 || why.length > 500)
    throw new ValidationError("A reason is required", { field: "withdrawnReason" });
  const repairOrderId = await findingParent(db, findingId);
  return runCommand(db, { name: "finding.withdraw", actor: actorOf(staff) }, async (ctx) => {
    await lockActiveFinding(ctx, staff, repairOrderId, findingId);
    await ctx.tx
      .updateTable("finding")
      .set({ status: "withdrawn", withdrawn_reason: why, updated_at: ctx.txTime, updated_by: staff.userId })
      .where("id", "=", findingId)
      .execute();
    await ctx.audit({
      action: "finding.withdrawn",
      entityType: "finding",
      entityId: findingId,
      details: { reason: why },
    });
    return { findingId };
  });
}

// --------------------------------------------------------------------------- finding photos

export async function addFindingPhoto(
  db: Kysely<DB>,
  storage: MediaStorage,
  staff: Staff,
  input: { findingId: string; bytes: Uint8Array },
  idempotencyKey: string,
): Promise<CommandOutcome<{ mediaId: string }>> {
  const { findingId, bytes } = input;
  const repairOrderId = await findingParent(db, findingId);
  const { maxPhotoBytes } = await getCheckInSettings(db);
  if (bytes.byteLength > maxPhotoBytes) {
    throw new ValidationError("Photo is too large", { field: "photo", reason: "too_large" });
  }
  const image = inspectImage(bytes);
  if (!image)
    throw new ValidationError("Not a JPEG, PNG or WebP photo", { field: "photo", reason: "not_image" });

  // Cheap checks before writing bytes, so refused uploads leave no files; re-checked under the lock.
  if (!(await canAccessRepairOrder(db, staff, repairOrderId)))
    throw new NotFoundError("repair_order", repairOrderId);
  const target = await db
    .selectFrom("finding")
    .select("status")
    .where("id", "=", findingId)
    .executeTakeFirstOrThrow();
  if (target.status !== "active") throw new ConflictError("finding_withdrawn", "This finding was withdrawn");

  const storageKey = photoKey(image.sha256, image.contentType);
  await storage.put(storageKey, bytes);

  return runCommand(
    db,
    {
      name: "finding.add_photo",
      actor: actorOf(staff),
      idempotency: { key: idempotencyKey, payload: { findingId, sha256: image.sha256 } },
    },
    async (ctx) => {
      await lockActiveFinding(ctx, staff, repairOrderId, findingId);
      const row = await ctx.tx
        .insertInto("media_asset")
        .values({
          finding_id: findingId,
          slot: "other",
          storage_key: storageKey,
          content_type: image.contentType,
          byte_size: bytes.byteLength,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
          uploaded_by: staff.userId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await ctx.audit({
        action: "finding.photo_added",
        entityType: "media_asset",
        entityId: row.id,
        after: { findingId, sha256: image.sha256, bytes: bytes.byteLength, visibility: "internal" },
      });
      return { mediaId: row.id };
    },
  );
}

async function findingPhotoParent(db: Kysely<DB>, mediaId: string) {
  if (!isUuid(mediaId)) throw new NotFoundError("media_asset", mediaId);
  const row = await db
    .selectFrom("media_asset")
    .innerJoin("finding", "finding.id", "media_asset.finding_id")
    .select(["media_asset.finding_id", "finding.repair_order_id"])
    .where("media_asset.id", "=", mediaId)
    .executeTakeFirst();
  if (!row?.finding_id) throw new NotFoundError("media_asset", mediaId);
  return { findingId: row.finding_id, repairOrderId: row.repair_order_id };
}

/** OD-11: a finding photo reaches customer-facing output only when this is set to "customer". */
export async function setFindingPhotoVisibility(
  db: Kysely<DB>,
  staff: Staff,
  mediaId: string,
  visibility: string,
): Promise<CommandOutcome<{ mediaId: string }>> {
  if (visibility !== "internal" && visibility !== "customer") {
    throw new ValidationError("Visibility is internal or customer", { field: "visibility" });
  }
  const { findingId, repairOrderId } = await findingPhotoParent(db, mediaId);
  return runCommand(db, { name: "finding.photo_visibility", actor: actorOf(staff) }, async (ctx) => {
    await lockActiveFinding(ctx, staff, repairOrderId, findingId);
    const updated = await ctx.tx
      .updateTable("media_asset")
      .set({ visibility })
      .where("id", "=", mediaId)
      .where("discarded_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new ConflictError("photo_not_discardable", "Photo was removed");
    await ctx.audit({
      action: "finding.photo_visibility_changed",
      entityType: "media_asset",
      entityId: mediaId,
      after: { findingId, visibility },
    });
    return { mediaId };
  });
}

export async function discardFindingPhoto(
  db: Kysely<DB>,
  staff: Staff,
  mediaId: string,
): Promise<CommandOutcome<{ mediaId: string }>> {
  const { findingId, repairOrderId } = await findingPhotoParent(db, mediaId);
  return runCommand(db, { name: "finding.discard_photo", actor: actorOf(staff) }, async (ctx) => {
    await lockActiveFinding(ctx, staff, repairOrderId, findingId);
    const updated = await ctx.tx
      .updateTable("media_asset")
      .set({ discarded_at: ctx.txTime })
      .where("id", "=", mediaId)
      .where("discarded_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new ConflictError("photo_not_discardable", "Photo was already removed");
    await ctx.audit({
      action: "finding.photo_discarded",
      entityType: "media_asset",
      entityId: mediaId,
      details: { findingId },
    });
    return { mediaId };
  });
}
