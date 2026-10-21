import { randomUUID } from "node:crypto";
import type { Kysely, Updateable } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import type { JsonValue } from "../core/json";
import {
  runCommand,
  type Actor,
  type CommandContext,
  type CommandOutcome,
  type RunCommandOptions,
} from "../command/runner";
import { normalizeMobile } from "../customer/service";
import type { CheckInStatus, ContactRelationship, DB, PhotoSlot } from "../db/schema";
import { inspectImage } from "../media/image";
import { photoKey, type MediaStorage } from "../media/storage";
import { allocateNumber } from "../numbering/numbering";

/**
 * Check-in (I1-02). A check-in is a draft while details and photos are added (OD-2); completing it
 * creates the repair order in Checked-in (PRD v0.2 B1, `ro.checked_in`) with an RO number (OD-3) and
 * locks its photos (AC-04.2b). Fewer photos than the required slots needs a reason (AC-04.2, D-18).
 */

export const PHOTO_SLOTS: readonly PhotoSlot[] = ["front", "rear", "left", "right", "odometer", "other"];
export const RELATIONSHIPS: readonly ContactRelationship[] = [
  "owner",
  "driver",
  "company_representative",
  "other",
];

export interface CheckInSettings {
  requiredSlots: PhotoSlot[];
  maxPhotoBytes: number;
}

/** Configuration (D-18, T-07; no minimum resolution per B-12); read-only for the app. */
export async function getCheckInSettings(db: Kysely<DB>): Promise<CheckInSettings> {
  const rows = await db.selectFrom("app_setting").select(["key", "value"]).execute();
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const slots = value("check_in.required_photo_slots");
  const maxBytes = value("media.max_photo_bytes");
  if (!Array.isArray(slots) || typeof maxBytes !== "number") {
    throw new Error("Check-in settings are missing or malformed in app_setting");
  }
  return {
    requiredSlots: slots.filter((slot): slot is PhotoSlot => PHOTO_SLOTS.includes(slot as PhotoSlot)),
    maxPhotoBytes: maxBytes,
  };
}

function userId(actor: Actor): string | null {
  return actor.kind === "user" ? actor.userId : null;
}

async function lockOpenCheckIn(ctx: CommandContext, checkInId: string) {
  await ctx.locks.acquire("check_in", [checkInId]);
  const row = await ctx.tx
    .selectFrom("check_in")
    .selectAll()
    .where("id", "=", checkInId)
    .executeTakeFirstOrThrow();
  if (row.status !== "in_progress") {
    throw new ConflictError("check_in_closed", `Check-in ${checkInId} is ${row.status}`, {
      status: row.status,
    });
  }
  return row;
}

// --------------------------------------------------------------------------- start

export async function startCheckIn(
  db: Kysely<DB>,
  actor: Actor,
  vehicleId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<{ checkInId: string }>> {
  if (!isUuid(vehicleId)) throw new ValidationError("vehicleId must be a vehicle id", { field: "vehicleId" });
  return runCommand(
    db,
    { name: "check_in.start", actor, idempotency: { key: idempotencyKey, payload: { vehicleId } } },
    async (ctx) => {
      const owner = await ctx.tx
        .selectFrom("vehicle_ownership")
        .innerJoin("customer", "customer.id", "vehicle_ownership.customer_id")
        .select([
          "customer.id",
          "customer.name_en",
          "customer.name_ar",
          "customer.mobile",
          "customer.mobile_normalized",
        ])
        .where("vehicle_ownership.vehicle_id", "=", vehicleId)
        .where("vehicle_ownership.valid_to", "is", null)
        .executeTakeFirst();
      if (!owner) throw new NotFoundError("vehicle", vehicleId);

      // The owner is the usual authorized contact; the advisor changes it when someone else will approve.
      const row = await ctx.tx
        .insertInto("check_in")
        .values({
          customer_id: owner.id,
          vehicle_id: vehicleId,
          contact_name: owner.name_en ?? owner.name_ar,
          contact_mobile: owner.mobile,
          contact_mobile_normalized: owner.mobile_normalized,
          contact_relationship: "owner",
          created_by: userId(actor),
          updated_at: ctx.txTime,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await ctx.audit({
        action: "check_in.started",
        entityType: "check_in",
        entityId: row.id,
        after: { vehicleId, customerId: owner.id },
      });
      return { checkInId: row.id };
    },
  );
}

// --------------------------------------------------------------------------- update

export interface CheckInFields {
  contactName?: string | null;
  contactMobile?: string | null;
  contactRelationship?: string | null;
  odometerKm?: number | null;
  fuelEighths?: number | null;
  warningLights?: string | null;
  concerns?: string | null;
  belongings?: string | null;
  keysReceived?: number | null;
  keyTag?: string | null;
  promisedAt?: Date | null;
  photoShortfallReason?: string | null;
}

function text(value: string | null | undefined, max: number, field: string): string | null {
  const trimmed = value?.trim() || null;
  if (trimmed && trimmed.length > max) throw new ValidationError(`${field} is too long`, { field });
  return trimmed;
}

function integer(value: number | null | undefined, min: number, max: number, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a whole number from ${min} to ${max}`, { field });
  }
  return value;
}

/** Validates a draft's fields; anything may still be empty until completion. */
/** Validates the fields given. A field left undefined keeps its stored value; null clears it. */
function validateFields(input: CheckInFields): Updateable<DB["check_in"]> {
  const set: Updateable<DB["check_in"]> = {};
  if (input.contactName !== undefined) set.contact_name = text(input.contactName, 200, "contactName");
  if (input.contactMobile !== undefined) {
    const mobile = text(input.contactMobile, 20, "contactMobile");
    const normalized = mobile ? normalizeMobile(mobile) : null;
    if (mobile && !/^[0-9]{6,15}$/.test(normalized ?? "")) {
      throw new ValidationError("Mobile must contain 6–15 digits", { field: "contactMobile" });
    }
    set.contact_mobile = mobile;
    set.contact_mobile_normalized = normalized;
  }
  if (input.contactRelationship !== undefined) {
    const relationship = input.contactRelationship?.trim() || null;
    if (relationship && !RELATIONSHIPS.includes(relationship as ContactRelationship)) {
      throw new ValidationError("Unknown relationship", { field: "contactRelationship" });
    }
    set.contact_relationship = relationship as ContactRelationship | null;
  }
  if (input.odometerKm !== undefined) set.odometer_km = integer(input.odometerKm, 0, 2_000_000, "odometerKm");
  if (input.fuelEighths !== undefined) set.fuel_eighths = integer(input.fuelEighths, 0, 8, "fuelEighths");
  if (input.warningLights !== undefined) set.warning_lights = text(input.warningLights, 500, "warningLights");
  if (input.concerns !== undefined) set.concerns = text(input.concerns, 2000, "concerns");
  if (input.belongings !== undefined) set.belongings = text(input.belongings, 1000, "belongings");
  if (input.keysReceived !== undefined)
    set.keys_received = integer(input.keysReceived, 0, 20, "keysReceived");
  if (input.keyTag !== undefined) set.key_tag = text(input.keyTag, 50, "keyTag");
  if (input.promisedAt !== undefined) {
    if (input.promisedAt && Number.isNaN(input.promisedAt.getTime())) {
      throw new ValidationError("Promised time is not a valid date", { field: "promisedAt" });
    }
    set.promised_at = input.promisedAt;
  }
  if (input.photoShortfallReason !== undefined) {
    set.photo_shortfall_reason = text(input.photoShortfallReason, 500, "photoShortfallReason");
  }
  return set;
}

export async function updateCheckIn(
  db: Kysely<DB>,
  actor: Actor,
  checkInId: string,
  input: CheckInFields,
): Promise<CommandOutcome<{ checkInId: string }>> {
  if (!isUuid(checkInId)) throw new NotFoundError("check_in", checkInId);
  const fields = validateFields(input);
  return runCommand(db, { name: "check_in.update", actor }, async (ctx) => {
    await lockOpenCheckIn(ctx, checkInId);
    await ctx.tx
      .updateTable("check_in")
      .set({ ...fields, updated_at: ctx.txTime })
      .where("id", "=", checkInId)
      .execute();
    await ctx.audit({
      action: "check_in.updated",
      entityType: "check_in",
      entityId: checkInId,
      // Only the fields this save changed; Dates become ISO strings.
      after: JSON.parse(JSON.stringify(fields)) as JsonValue,
    });
    return { checkInId };
  });
}

// --------------------------------------------------------------------------- photos

export async function addCheckInPhoto(
  db: Kysely<DB>,
  storage: MediaStorage,
  actor: Actor,
  input: { checkInId: string; slot: string; bytes: Uint8Array },
  idempotencyKey: string,
): Promise<CommandOutcome<{ mediaId: string }>> {
  const { checkInId, slot, bytes } = input;
  if (!isUuid(checkInId)) throw new NotFoundError("check_in", checkInId);
  if (!PHOTO_SLOTS.includes(slot as PhotoSlot))
    throw new ValidationError("Unknown photo slot", { field: "slot" });
  const settings = await getCheckInSettings(db);
  if (bytes.byteLength > settings.maxPhotoBytes) {
    throw new ValidationError("Photo is too large", { field: "photo", reason: "too_large" });
  }
  const image = inspectImage(bytes);
  if (!image)
    throw new ValidationError("Not a JPEG, PNG or WebP photo", { field: "photo", reason: "not_image" });
  // Cheap read before writing bytes, so closed or unknown check-ins don't leave files behind. The
  // command re-checks under the lock.
  const target = await db
    .selectFrom("check_in")
    .select("status")
    .where("id", "=", checkInId)
    .executeTakeFirst();
  if (!target) throw new NotFoundError("check_in", checkInId);
  if (target.status !== "in_progress") {
    throw new ConflictError("check_in_closed", `Check-in ${checkInId} is ${target.status}`, {
      status: target.status,
    });
  }

  // Bytes first, record second (rule 3): a failure below leaves an unreferenced file only.
  const storageKey = photoKey(image.sha256, image.contentType);
  await storage.put(storageKey, bytes);

  return runCommand(
    db,
    {
      name: "check_in.add_photo",
      actor,
      idempotency: { key: idempotencyKey, payload: { checkInId, slot, sha256: image.sha256 } },
    },
    async (ctx) => {
      await lockOpenCheckIn(ctx, checkInId);
      if (slot !== "other") {
        const replaced = await ctx.tx
          .updateTable("media_asset")
          .set({ discarded_at: ctx.txTime })
          .where("check_in_id", "=", checkInId)
          .where("slot", "=", slot as PhotoSlot)
          .where("discarded_at", "is", null)
          .returning("id")
          .execute();
        for (const old of replaced) {
          await ctx.audit({
            action: "check_in.photo_discarded",
            entityType: "media_asset",
            entityId: old.id,
            details: { checkInId, slot, reason: "replaced" },
          });
        }
      }
      const row = await ctx.tx
        .insertInto("media_asset")
        .values({
          check_in_id: checkInId,
          slot: slot as PhotoSlot,
          storage_key: storageKey,
          content_type: image.contentType,
          byte_size: bytes.byteLength,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
          uploaded_by: userId(actor),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await ctx.audit({
        action: "check_in.photo_added",
        entityType: "media_asset",
        entityId: row.id,
        after: {
          checkInId,
          slot,
          sha256: image.sha256,
          bytes: bytes.byteLength,
          width: image.width,
          height: image.height,
        },
      });
      return { mediaId: row.id };
    },
  );
}

export async function discardCheckInPhoto(
  db: Kysely<DB>,
  actor: Actor,
  mediaId: string,
): Promise<CommandOutcome<{ mediaId: string }>> {
  if (!isUuid(mediaId)) throw new NotFoundError("media_asset", mediaId);
  const media = await db
    .selectFrom("media_asset")
    .select("check_in_id")
    .where("id", "=", mediaId)
    .executeTakeFirst();
  if (!media) throw new NotFoundError("media_asset", mediaId);
  return runCommand(db, { name: "check_in.discard_photo", actor }, async (ctx) => {
    await lockOpenCheckIn(ctx, media.check_in_id);
    const updated = await ctx.tx
      .updateTable("media_asset")
      .set({ discarded_at: ctx.txTime })
      .where("id", "=", mediaId)
      .where("discarded_at", "is", null)
      .where("locked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new ConflictError("photo_not_discardable", "Photo is already discarded or locked");
    await ctx.audit({
      action: "check_in.photo_discarded",
      entityType: "media_asset",
      entityId: mediaId,
      details: { checkInId: media.check_in_id, reason: "removed" },
    });
    return { mediaId };
  });
}

// --------------------------------------------------------------------------- abandon

export async function abandonCheckIn(
  db: Kysely<DB>,
  actor: Actor,
  checkInId: string,
  reason: string,
): Promise<CommandOutcome<{ checkInId: string }>> {
  if (!isUuid(checkInId)) throw new NotFoundError("check_in", checkInId);
  const why = text(reason, 500, "abandonedReason");
  if (!why) throw new ValidationError("A reason is required", { field: "abandonedReason" });
  return runCommand(db, { name: "check_in.abandon", actor }, async (ctx) => {
    await lockOpenCheckIn(ctx, checkInId);
    await ctx.tx
      .updateTable("check_in")
      .set({ status: "abandoned" satisfies CheckInStatus, abandoned_reason: why, updated_at: ctx.txTime })
      .where("id", "=", checkInId)
      .execute();
    await ctx.audit({
      action: "check_in.abandoned",
      entityType: "check_in",
      entityId: checkInId,
      details: { reason: why },
    });
    return { checkInId };
  });
}

// --------------------------------------------------------------------------- complete

export async function completeCheckIn(
  db: Kysely<DB>,
  actor: Actor,
  checkInId: string,
  idempotencyKey: string,
  // Test-only fault injection (allocation rollback), as in test-document/service.ts.
  hooks?: RunCommandOptions["hooks"],
): Promise<CommandOutcome<{ repairOrderId: string; number: string }>> {
  if (!isUuid(checkInId)) throw new NotFoundError("check_in", checkInId);
  const settings = await getCheckInSettings(db);
  return runCommand(
    db,
    { name: "check_in.complete", actor, idempotency: { key: idempotencyKey, payload: { checkInId } }, hooks },
    async (ctx) => {
      // The vehicle first (rank 5 before check-in 7), so its owner cannot change underneath us (T-09).
      const vehicle = await ctx.tx
        .selectFrom("check_in")
        .select("vehicle_id")
        .where("id", "=", checkInId)
        .executeTakeFirst();
      if (!vehicle) throw new NotFoundError("check_in", checkInId);
      await ctx.locks.acquire("vehicle", [vehicle.vehicle_id]);
      const draft = await lockOpenCheckIn(ctx, checkInId);
      const owner = await ctx.tx
        .selectFrom("vehicle_ownership")
        .select("customer_id")
        .where("vehicle_id", "=", draft.vehicle_id)
        .where("valid_to", "is", null)
        .executeTakeFirstOrThrow();
      if (owner.customer_id !== draft.customer_id) {
        throw new ConflictError(
          "owner_changed",
          "The vehicle changed owner since this check-in started; start a new one",
        );
      }

      // B1: customer, vehicle, authorized contact, odometer, concerns. Fuel and keys are recorded
      // but optional (OD-6).
      const required: [unknown, string][] = [
        [draft.contact_name, "contactName"],
        [draft.contact_mobile, "contactMobile"],
        [draft.contact_relationship, "contactRelationship"],
        [draft.odometer_km, "odometerKm"],
        [draft.concerns, "concerns"],
      ];
      const missing = required.find(([value]) => value === null);
      if (missing)
        throw new ValidationError(`${missing[1]} is required to complete check-in`, { field: missing[1] });

      const photos = await ctx.tx
        .selectFrom("media_asset")
        .select(["id", "slot"])
        .where("check_in_id", "=", checkInId)
        .where("discarded_at", "is", null)
        .execute();
      const present = new Set(photos.map((photo) => photo.slot));
      const missingSlots = settings.requiredSlots.filter((slot) => !present.has(slot));
      if (missingSlots.length > 0 && !draft.photo_shortfall_reason) {
        throw new ValidationError("Missing check-in photos need a reason", {
          field: "photoShortfallReason",
          missingSlots,
        });
      }
      const shortfallReason = missingSlots.length > 0 ? draft.photo_shortfall_reason : null;

      const repairOrderId = randomUUID();
      const number = await allocateNumber(ctx, "repair_order", { type: "repair_order", id: repairOrderId });
      await ctx.tx
        .insertInto("repair_order")
        .values({
          id: repairOrderId,
          number: number.text,
          customer_id: draft.customer_id,
          vehicle_id: draft.vehicle_id,
          check_in_id: checkInId,
          contact_name: draft.contact_name!,
          contact_mobile: draft.contact_mobile!,
          contact_relationship: draft.contact_relationship!,
          odometer_km: draft.odometer_km!,
          fuel_eighths: draft.fuel_eighths,
          warning_lights: draft.warning_lights,
          concerns: draft.concerns!,
          belongings: draft.belongings,
          keys_received: draft.keys_received,
          key_tag: draft.key_tag,
          promised_at: draft.promised_at,
          photo_shortfall_reason: shortfallReason,
          checked_in_at: ctx.txTime,
          checked_in_by: userId(actor),
          business_date: ctx.businessDate,
        })
        .execute();
      if (photos.length > 0) {
        await ctx.tx
          .updateTable("media_asset")
          .set({ repair_order_id: repairOrderId, locked_at: ctx.txTime })
          .where("check_in_id", "=", checkInId)
          .where("discarded_at", "is", null)
          .execute();
      }
      await ctx.tx
        .updateTable("check_in")
        .set({ status: "completed" satisfies CheckInStatus, updated_at: ctx.txTime })
        .where("id", "=", checkInId)
        .execute();

      await ctx.audit({
        action: "ro.checked_in",
        entityType: "repair_order",
        entityId: repairOrderId,
        after: {
          number: number.text,
          checkInId,
          customerId: draft.customer_id,
          vehicleId: draft.vehicle_id,
          authorizedContact: {
            name: draft.contact_name,
            mobile: draft.contact_mobile,
            relationship: draft.contact_relationship,
          },
          odometerKm: draft.odometer_km,
          fuelEighths: draft.fuel_eighths,
          photoSlots: [...present].sort(),
          missingSlots,
          photoShortfallReason: shortfallReason,
        },
      });
      return { repairOrderId, number: number.text };
    },
  );
}

// --------------------------------------------------------------------------- exclude (AC2-33)

export async function excludePhoto(
  db: Kysely<DB>,
  actor: Actor,
  mediaId: string,
  reason: string,
): Promise<CommandOutcome<{ mediaId: string }>> {
  if (!isUuid(mediaId)) throw new NotFoundError("media_asset", mediaId);
  const why = text(reason, 500, "excludedReason");
  if (!why) throw new ValidationError("A reason is required", { field: "excludedReason" });
  const media = await db
    .selectFrom("media_asset")
    .select(["repair_order_id"])
    .where("id", "=", mediaId)
    .executeTakeFirst();
  if (!media) throw new NotFoundError("media_asset", mediaId);
  if (!media.repair_order_id) {
    throw new ConflictError(
      "photo_not_locked",
      "Only photos of a completed check-in are excluded; drafts are discarded",
    );
  }
  const repairOrderId = media.repair_order_id;
  return runCommand(db, { name: "media.exclude", actor }, async (ctx) => {
    await ctx.locks.acquire("repair_order", [repairOrderId]);
    const updated = await ctx.tx
      .updateTable("media_asset")
      .set({ excluded_at: ctx.txTime, excluded_by: userId(actor), excluded_reason: why })
      .where("id", "=", mediaId)
      .where("excluded_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new ConflictError("photo_already_excluded", "Photo is already excluded");
    await ctx.audit({
      action: "media.excluded",
      entityType: "media_asset",
      entityId: mediaId,
      details: { repairOrderId, reason: why },
    });
    return { mediaId };
  });
}

// --------------------------------------------------------------------------- form input

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalWholeNumber(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : optionalText(value);
  if (raw === null) return null;
  // Whole numbers only (odometer, fuel, keys); anything else is passed on as NaN so validation names the field.
  return /^\s*\d{1,9}\s*$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
}

/**
 * A `datetime-local` value ("2026-10-21T17:30") has no zone; business time is Asia/Dubai, which
 * is UTC+04:00 all year (no daylight saving).
 */
export function parseDubaiLocalDateTime(value: unknown): Date | null {
  const raw = optionalText(value);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) return new Date(Number.NaN);
  const instant = new Date(`${raw}:00+04:00`);
  // Round trip: "2026-02-31T10:00" or "T24:00" would otherwise roll over into another day.
  const back = new Date(instant.getTime() + 4 * 3_600_000).toISOString().slice(0, 16);
  return back === raw ? instant : new Date(Number.NaN);
}

/** Form or JSON body → draft fields. Keys absent from the body stay unchanged (undefined). */
export function checkInFieldsFrom(body: Record<string, unknown>): CheckInFields {
  const given = <T>(key: string, parse: (value: unknown) => T): T | undefined =>
    key in body ? parse(body[key]) : undefined;
  return {
    contactName: given("contactName", optionalText),
    contactMobile: given("contactMobile", optionalText),
    contactRelationship: given("contactRelationship", optionalText),
    odometerKm: given("odometerKm", optionalWholeNumber),
    fuelEighths: given("fuelEighths", optionalWholeNumber),
    warningLights: given("warningLights", optionalText),
    concerns: given("concerns", optionalText),
    belongings: given("belongings", optionalText),
    keysReceived: given("keysReceived", optionalWholeNumber),
    keyTag: given("keyTag", optionalText),
    promisedAt: given("promisedAt", parseDubaiLocalDateTime),
    photoShortfallReason: given("photoShortfallReason", optionalText),
  };
}
