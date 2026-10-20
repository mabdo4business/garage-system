import { sql, type Kysely } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { isUuid } from "../core/ids";
import { runCommand, type Actor, type CommandContext, type CommandOutcome } from "../command/runner";
import type { DB, Emirate } from "../db/schema";
import { EMIRATES } from "./emirates";

/**
 * Vehicles and their plate/ownership history (I1-01). Spec: PRD v0.1 EP-02, PRD v0.2 §7.2 item 8
 * (GAP-26 — plate history).
 *
 * A vehicle has at most one active plate. It can have none: when a plate that is still active on
 * one vehicle is confirmed onto another (US-02.4 warns, decision OD-1), the old vehicle's plate
 * row is closed without a replacement.
 */

export { EMIRATES };

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION;
}

export interface PlateInput {
  emirate: Emirate;
  code: string;
  number: string;
}

export interface VehicleInput {
  vin?: string | null;
  make: string;
  model: string;
  year: number;
  colour?: string | null;
  plate: PlateInput;
  ownerCustomerId: string;
}

/** Set after the advisor has seen the "plate is active on another vehicle" warning and confirmed. */
export interface PlateMoveOption {
  movePlate?: boolean;
}

interface ValidVehicle {
  vin: string | null;
  make: string;
  model: string;
  year: number;
  colour: string | null;
  plate: PlateInput;
  ownerCustomerId: string;
}

function validatePlate(plate: PlateInput): PlateInput {
  if (!EMIRATES.includes(plate.emirate)) {
    throw new ValidationError(`emirate must be one of ${EMIRATES.join(", ")}`, { field: "plateEmirate" });
  }
  const code = plate.code.trim().toUpperCase();
  if (code.length < 1 || code.length > 4) {
    throw new ValidationError("Plate code must be 1–4 characters", { field: "plateCode" });
  }
  const number = plate.number.trim();
  if (!/^[0-9]{1,5}$/.test(number)) {
    throw new ValidationError("Plate number must be 1–5 digits", { field: "plateNumber" });
  }
  return { emirate: plate.emirate, code, number };
}

function validate(input: VehicleInput): ValidVehicle {
  const make = input.make.trim();
  if (make.length < 1 || make.length > 100) {
    throw new ValidationError("Make must be 1–100 characters", { field: "make" });
  }
  const model = input.model.trim();
  if (model.length < 1 || model.length > 100) {
    throw new ValidationError("Model must be 1–100 characters", { field: "model" });
  }
  if (!Number.isInteger(input.year) || input.year < 1960 || input.year > 2100) {
    throw new ValidationError("Year must be an integer between 1960 and 2100", { field: "year" });
  }
  const vin = input.vin?.trim() || null;
  if (vin && (vin.length < 5 || vin.length > 32)) {
    throw new ValidationError("VIN must be 5–32 characters", { field: "vin" });
  }
  const colour = input.colour?.trim() || null;
  if (colour && colour.length > 50) {
    throw new ValidationError("Colour must be at most 50 characters", { field: "colour" });
  }
  if (!isUuid(input.ownerCustomerId)) {
    throw new ValidationError("ownerCustomerId must be a customer id", { field: "ownerCustomerId" });
  }
  return {
    vin,
    make,
    model,
    year: input.year,
    colour,
    plate: validatePlate(input.plate),
    ownerCustomerId: input.ownerCustomerId,
  };
}

export interface DuplicateVehicle {
  id: string;
  make: string;
  model: string;
  reason: "vin" | "plate_active" | "plate_previously_active";
}

/**
 * Plain read — warns on VIN reuse, on a plate currently active on another vehicle (confirming
 * moves it), and on a plate that was active on a different vehicle before.
 */
export async function findDuplicateVehicles(
  db: Kysely<DB>,
  query: { vin?: string | null; plate: PlateInput; excludeVehicleId?: string },
): Promise<DuplicateVehicle[]> {
  const plate = validatePlate(query.plate);
  const matches: DuplicateVehicle[] = [];

  if (query.vin?.trim()) {
    const rows = await db
      .selectFrom("vehicle")
      .select(["id", "make", "model"])
      .where("vin", "=", query.vin.trim())
      .execute();
    matches.push(...rows.map((row) => ({ ...row, reason: "vin" as const })));
  }

  const plateRows = await db
    .selectFrom("vehicle_plate")
    .innerJoin("vehicle", "vehicle.id", "vehicle_plate.vehicle_id")
    .select(["vehicle.id", "vehicle.make", "vehicle.model", "vehicle_plate.valid_to"])
    .where("vehicle_plate.emirate", "=", plate.emirate)
    .where("vehicle_plate.code", "=", plate.code)
    .where("vehicle_plate.number", "=", plate.number)
    .orderBy("vehicle_plate.valid_from", "asc")
    .execute();
  for (const row of plateRows) {
    if (row.id === query.excludeVehicleId) continue;
    matches.push({
      id: row.id,
      make: row.make,
      model: row.model,
      reason: row.valid_to === null ? "plate_active" : "plate_previously_active",
    });
  }

  return matches;
}

/**
 * Wall-clock time read after the vehicle lock is held. Closing one history row and opening the
 * next must use the same instant, and it must be later than the instant the previous holder of
 * the lock used — ctx.txTime (transaction start) is not, when this transaction started first but
 * waited for the lock (I1-01 review finding 1). Kept as PostgreSQL text: a JS Date drops the
 * microseconds, and two serialised commands in the same millisecond would then collide.
 */
async function timeUnderLock(ctx: CommandContext): Promise<string> {
  const result = await sql<{ at: string }>`SELECT clock_timestamp()::text AS at`.execute(ctx.tx);
  return result.rows[0]!.at;
}

/**
 * Identifies what a duplicate warning was shown for (VIN + plate, normalised as stored). A
 * confirmation counts only when the caller sends back the key for the values it is now submitting,
 * so a plate cannot be moved without the warning for that plate having been seen (OD-1).
 */
export function duplicateConfirmKey(query: { vin?: string | null; plate: PlateInput }): string {
  const { plate } = query;
  return [query.vin?.trim() ?? "", plate.emirate, plate.code.trim().toUpperCase(), plate.number.trim()].join(
    "|",
  );
}

function samePlate(a: PlateInput, b: PlateInput): boolean {
  return a.emirate === b.emirate && a.code === b.code && a.number === b.number;
}

async function activePlateHolder(
  db: Kysely<DB> | CommandContext["tx"],
  plate: PlateInput,
): Promise<{ plateRowId: string; vehicleId: string } | undefined> {
  const row = await db
    .selectFrom("vehicle_plate")
    .select(["id", "vehicle_id"])
    .where("emirate", "=", plate.emirate)
    .where("code", "=", plate.code)
    .where("number", "=", plate.number)
    .where("valid_to", "is", null)
    .executeTakeFirst();
  return row ? { plateRowId: row.id, vehicleId: row.vehicle_id } : undefined;
}

function plateAlreadyActive(plate: PlateInput, holderVehicleId?: string): ConflictError {
  return new ConflictError(
    "plate_already_active",
    `Plate ${plate.emirate}-${plate.code}-${plate.number} is already active on another vehicle`,
    holderVehicleId ? { vehicleId: holderVehicleId } : undefined,
  );
}

/**
 * Gives `vehicleId` the plate, closing its current plate row and — when `movePlate` is set — the
 * row of another vehicle that still holds the plate. Every vehicle touched must already be locked
 * (`lockedVehicleIds`); a holder outside that set means the plate moved since the caller looked,
 * which is reported as a conflict rather than closing an unlocked vehicle's row.
 */
async function assignPlate(
  ctx: CommandContext,
  args: {
    vehicleId: string;
    plate: PlateInput;
    movePlate: boolean;
    lockedVehicleIds: readonly string[];
    at: string;
    changedBy: string | null;
  },
): Promise<void> {
  const { vehicleId, plate, at, changedBy } = args;
  const holder = await activePlateHolder(ctx.tx, plate);
  if (holder && holder.vehicleId !== vehicleId) {
    if (!args.movePlate || !args.lockedVehicleIds.includes(holder.vehicleId)) {
      throw plateAlreadyActive(plate, holder.vehicleId);
    }
    await ctx.tx
      .updateTable("vehicle_plate")
      .set({ valid_to: at })
      .where("id", "=", holder.plateRowId)
      .where("valid_to", "is", null)
      .execute();
    await ctx.audit({
      action: "vehicle.plate_retired",
      entityType: "vehicle",
      entityId: holder.vehicleId,
      before: { emirate: plate.emirate, code: plate.code, number: plate.number },
      after: null,
      details: { reason: "moved_to_vehicle", vehicleId },
    });
  }

  try {
    await ctx.tx
      .insertInto("vehicle_plate")
      .values({
        vehicle_id: vehicleId,
        emirate: plate.emirate,
        code: plate.code,
        number: plate.number,
        valid_from: at,
        changed_by: changedBy,
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another vehicle took the plate between our read and our insert. The transaction is
      // aborted now, so no further query (not even to name the holder) can run in it.
      throw plateAlreadyActive(plate);
    }
    throw error;
  }
}

export type CreateVehicleResult = { vehicleId: string };

export async function createVehicle(
  db: Kysely<DB>,
  actor: Actor,
  input: VehicleInput,
  idempotencyKey: string,
  options: PlateMoveOption = {},
): Promise<CommandOutcome<CreateVehicleResult>> {
  const valid = validate(input);
  const movePlate = options.movePlate === true;
  return runCommand(
    db,
    {
      name: "vehicle.create",
      actor,
      idempotency: {
        key: idempotencyKey,
        payload: {
          vin: valid.vin,
          make: valid.make,
          model: valid.model,
          year: valid.year,
          colour: valid.colour,
          plate: { emirate: valid.plate.emirate, code: valid.plate.code, number: valid.plate.number },
          ownerCustomerId: valid.ownerCustomerId,
          movePlate,
        },
      },
    },
    async (ctx) => {
      const holder = movePlate ? await activePlateHolder(ctx.tx, valid.plate) : undefined;
      const lockedVehicleIds = holder ? await ctx.locks.acquire("vehicle", [holder.vehicleId]) : [];

      const owner = await ctx.tx
        .selectFrom("customer")
        .select("id")
        .where("id", "=", valid.ownerCustomerId)
        .executeTakeFirst();
      if (!owner) {
        throw new NotFoundError("customer", valid.ownerCustomerId);
      }

      const createdBy = actor.kind === "user" ? actor.userId : null;
      const at = await timeUnderLock(ctx);
      const vehicle = await ctx.tx
        .insertInto("vehicle")
        .values({
          vin: valid.vin,
          make: valid.make,
          model: valid.model,
          year: valid.year,
          colour: valid.colour,
          created_by: createdBy,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await assignPlate(ctx, {
        vehicleId: vehicle.id,
        plate: valid.plate,
        movePlate,
        lockedVehicleIds,
        at,
        changedBy: createdBy,
      });

      await ctx.tx
        .insertInto("vehicle_ownership")
        .values({
          vehicle_id: vehicle.id,
          customer_id: valid.ownerCustomerId,
          valid_from: at,
          changed_by: createdBy,
        })
        .execute();

      await ctx.audit({
        action: "vehicle.created",
        entityType: "vehicle",
        entityId: vehicle.id,
        after: {
          vin: valid.vin,
          make: valid.make,
          model: valid.model,
          year: valid.year,
          colour: valid.colour,
          plate: { emirate: valid.plate.emirate, code: valid.plate.code, number: valid.plate.number },
          ownerCustomerId: valid.ownerCustomerId,
        },
      });
      return { vehicleId: vehicle.id };
    },
  );
}

export type ChangePlateResult = { vehicleId: string };

export async function changePlate(
  db: Kysely<DB>,
  actor: Actor,
  vehicleId: string,
  newPlate: PlateInput,
  idempotencyKey: string,
  options: PlateMoveOption = {},
): Promise<CommandOutcome<ChangePlateResult>> {
  if (!isUuid(vehicleId)) {
    throw new NotFoundError("vehicle", vehicleId);
  }
  const plate = validatePlate(newPlate);
  const movePlate = options.movePlate === true;
  return runCommand(
    db,
    {
      name: "vehicle.change_plate",
      actor,
      idempotency: { key: idempotencyKey, payload: { vehicleId, plate: { ...plate }, movePlate } },
    },
    async (ctx) => {
      // Both vehicles (this one and the plate's current holder) are locked in one call so the
      // ids go in ascending order.
      const holder = movePlate ? await activePlateHolder(ctx.tx, plate) : undefined;
      const lockedVehicleIds = await ctx.locks.acquire(
        "vehicle",
        holder ? [vehicleId, holder.vehicleId] : [vehicleId],
      );
      const at = await timeUnderLock(ctx);

      const current = await ctx.tx
        .selectFrom("vehicle_plate")
        .select(["id", "emirate", "code", "number"])
        .where("vehicle_id", "=", vehicleId)
        .where("valid_to", "is", null)
        .executeTakeFirst();
      if (current && samePlate(current, plate)) {
        throw new ValidationError("New plate is the same as the current plate", { field: "plateNumber" });
      }

      const changedBy = actor.kind === "user" ? actor.userId : null;
      if (current) {
        await ctx.tx
          .updateTable("vehicle_plate")
          .set({ valid_to: at })
          .where("id", "=", current.id)
          .execute();
      }
      await assignPlate(ctx, { vehicleId, plate, movePlate, lockedVehicleIds, at, changedBy });

      await ctx.audit({
        action: "vehicle.plate_changed",
        entityType: "vehicle",
        entityId: vehicleId,
        before: current ? { emirate: current.emirate, code: current.code, number: current.number } : null,
        after: { emirate: plate.emirate, code: plate.code, number: plate.number },
      });
      return { vehicleId };
    },
  );
}

export type TransferOwnershipResult = { vehicleId: string };

export async function transferOwnership(
  db: Kysely<DB>,
  actor: Actor,
  vehicleId: string,
  newOwnerCustomerId: string,
  idempotencyKey: string,
): Promise<CommandOutcome<TransferOwnershipResult>> {
  if (!isUuid(vehicleId)) {
    throw new NotFoundError("vehicle", vehicleId);
  }
  if (!isUuid(newOwnerCustomerId)) {
    throw new ValidationError("newOwnerCustomerId must be a customer id", { field: "newOwnerCustomerId" });
  }
  return runCommand(
    db,
    {
      name: "vehicle.transfer_owner",
      actor,
      idempotency: { key: idempotencyKey, payload: { vehicleId, newOwnerCustomerId } },
    },
    async (ctx) => {
      await ctx.locks.acquire("vehicle", [vehicleId]);
      const at = await timeUnderLock(ctx);

      // The lock confirms the vehicle exists, and it always has exactly one active ownership row.
      const current = await ctx.tx
        .selectFrom("vehicle_ownership")
        .select(["id", "customer_id"])
        .where("vehicle_id", "=", vehicleId)
        .where("valid_to", "is", null)
        .executeTakeFirstOrThrow();
      if (current.customer_id === newOwnerCustomerId) {
        throw new ValidationError("Vehicle is already owned by this customer", {
          field: "newOwnerCustomerId",
        });
      }
      const newOwner = await ctx.tx
        .selectFrom("customer")
        .select("id")
        .where("id", "=", newOwnerCustomerId)
        .executeTakeFirst();
      if (!newOwner) {
        throw new NotFoundError("customer", newOwnerCustomerId);
      }

      await ctx.tx
        .updateTable("vehicle_ownership")
        .set({ valid_to: at })
        .where("id", "=", current.id)
        .execute();
      await ctx.tx
        .insertInto("vehicle_ownership")
        .values({
          vehicle_id: vehicleId,
          customer_id: newOwnerCustomerId,
          valid_from: at,
          changed_by: actor.kind === "user" ? actor.userId : null,
        })
        .execute();

      await ctx.audit({
        action: "vehicle.ownership_changed",
        entityType: "vehicle",
        entityId: vehicleId,
        before: { customerId: current.customer_id },
        after: { customerId: newOwnerCustomerId },
      });
      return { vehicleId };
    },
  );
}

export interface VehicleProfile {
  id: string;
  vin: string | null;
  make: string;
  model: string;
  year: number;
  colour: string | null;
  currentOwnerCustomerId: string;
  currentOwnerName: string | null;
  /** Null after the vehicle's plate was moved to another vehicle and none was given back. */
  plate: PlateInput | null;
  plateHistory: (PlateInput & { validFrom: Date; validTo: Date | null })[];
  ownershipHistory: {
    customerId: string;
    customerName: string | null;
    validFrom: Date;
    validTo: Date | null;
  }[];
}

/** Plain read: current owner, current plate, and both histories in validity order. */
export async function getVehicle(db: Kysely<DB>, id: string): Promise<VehicleProfile | null> {
  if (!isUuid(id)) return null;
  const vehicle = await db
    .selectFrom("vehicle")
    .select(["id", "vin", "make", "model", "year", "colour"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!vehicle) return null;

  const plateRows = await db
    .selectFrom("vehicle_plate")
    .select(["emirate", "code", "number", "valid_from", "valid_to"])
    .where("vehicle_id", "=", id)
    .orderBy("valid_from", "asc")
    .execute();
  const ownershipRows = await db
    .selectFrom("vehicle_ownership")
    .innerJoin("customer", "customer.id", "vehicle_ownership.customer_id")
    .select([
      "vehicle_ownership.customer_id",
      "vehicle_ownership.valid_from",
      "vehicle_ownership.valid_to",
      "customer.name_en",
      "customer.name_ar",
    ])
    .where("vehicle_ownership.vehicle_id", "=", id)
    .orderBy("vehicle_ownership.valid_from", "asc")
    .execute();

  const currentPlate = plateRows.find((row) => row.valid_to === null);
  const currentOwnership = ownershipRows.find((row) => row.valid_to === null);
  if (!currentOwnership) {
    throw new Error(`Vehicle ${id} has no active owner — data integrity violation`);
  }

  return {
    id: vehicle.id,
    vin: vehicle.vin,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    colour: vehicle.colour,
    currentOwnerCustomerId: currentOwnership.customer_id,
    currentOwnerName: currentOwnership.name_en ?? currentOwnership.name_ar,
    plate: currentPlate
      ? { emirate: currentPlate.emirate, code: currentPlate.code, number: currentPlate.number }
      : null,
    plateHistory: plateRows.map((row) => ({
      emirate: row.emirate,
      code: row.code,
      number: row.number,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    })),
    ownershipHistory: ownershipRows.map((row) => ({
      customerId: row.customer_id,
      customerName: row.name_en ?? row.name_ar,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    })),
  };
}
