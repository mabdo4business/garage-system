import type { Kysely } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import { runCommand, type Actor, type CommandOutcome } from "../command/runner";
import type { DB, Emirate } from "../db/schema";

/**
 * Vehicles and their plate/ownership history (I1-01). Spec: PRD v0.1 EP-02, PRD v0.2 §7.2 item 8
 * (GAP-26 — plate history).
 */

export const EMIRATES: readonly Emirate[] = [
  "abu_dhabi",
  "dubai",
  "sharjah",
  "ajman",
  "umm_al_quwain",
  "ras_al_khaimah",
  "fujairah",
];

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
    throw new ValidationError(`emirate must be one of ${EMIRATES.join(", ")}`);
  }
  const code = plate.code.trim().toUpperCase();
  if (code.length < 1 || code.length > 4) {
    throw new ValidationError("Plate code must be 1–4 characters");
  }
  const number = plate.number.trim();
  if (!/^[0-9]{1,5}$/.test(number)) {
    throw new ValidationError("Plate number must be 1–5 digits");
  }
  return { emirate: plate.emirate, code, number };
}

function validate(input: VehicleInput): ValidVehicle {
  const make = input.make.trim();
  const model = input.model.trim();
  if (make.length < 1 || make.length > 100 || model.length < 1 || model.length > 100) {
    throw new ValidationError("Make and model must be 1–100 characters");
  }
  if (!Number.isInteger(input.year) || input.year < 1960 || input.year > 2100) {
    throw new ValidationError("Year must be an integer between 1960 and 2100");
  }
  const vin = input.vin?.trim() || null;
  if (vin && (vin.length < 5 || vin.length > 32)) {
    throw new ValidationError("VIN must be 5–32 characters");
  }
  const colour = input.colour?.trim() || null;
  if (colour && colour.length > 50) {
    throw new ValidationError("Colour must be at most 50 characters");
  }
  if (!input.ownerCustomerId) {
    throw new ValidationError("ownerCustomerId is required");
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
  reason: "vin" | "plate_previously_active";
}

/** Plain read — warns on VIN reuse or a plate that was active on a different vehicle before. */
export async function findDuplicateVehicles(
  db: Kysely<DB>,
  query: { vin?: string | null; plate: PlateInput },
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
    .select(["vehicle.id", "vehicle.make", "vehicle.model"])
    .where("vehicle_plate.emirate", "=", plate.emirate)
    .where("vehicle_plate.code", "=", plate.code)
    .where("vehicle_plate.number", "=", plate.number)
    .where("vehicle_plate.valid_to", "is not", null)
    .execute();
  matches.push(...plateRows.map((row) => ({ ...row, reason: "plate_previously_active" as const })));

  return matches;
}

export type CreateVehicleResult = { vehicleId: string };

export async function createVehicle(
  db: Kysely<DB>,
  actor: Actor,
  input: VehicleInput,
  idempotencyKey: string,
): Promise<CommandOutcome<CreateVehicleResult>> {
  const valid = validate(input);
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
        },
      },
    },
    async (ctx) => {
      const owner = await ctx.tx
        .selectFrom("customer")
        .select("id")
        .where("id", "=", valid.ownerCustomerId)
        .executeTakeFirst();
      if (!owner) {
        throw new NotFoundError("customer", valid.ownerCustomerId);
      }

      const createdBy = actor.kind === "user" ? actor.userId : null;
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

      try {
        await ctx.tx
          .insertInto("vehicle_plate")
          .values({
            vehicle_id: vehicle.id,
            emirate: valid.plate.emirate,
            code: valid.plate.code,
            number: valid.plate.number,
            changed_by: createdBy,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError(
            "plate_already_active",
            `Plate ${valid.plate.emirate}-${valid.plate.code}-${valid.plate.number} is already active on another vehicle`,
          );
        }
        throw error;
      }

      await ctx.tx
        .insertInto("vehicle_ownership")
        .values({ vehicle_id: vehicle.id, customer_id: valid.ownerCustomerId, changed_by: createdBy })
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
): Promise<CommandOutcome<ChangePlateResult>> {
  const plate = validatePlate(newPlate);
  return runCommand(db, { name: "vehicle.change_plate", actor }, async (ctx) => {
    await ctx.locks.acquire("vehicle", [vehicleId]);

    // The lock above already confirmed the vehicle exists; a vehicle always has exactly one
    // active plate row (created together in createVehicle), so this is an invariant, not a
    // user-facing not-found case.
    const current = await ctx.tx
      .selectFrom("vehicle_plate")
      .select(["id", "emirate", "code", "number"])
      .where("vehicle_id", "=", vehicleId)
      .where("valid_to", "is", null)
      .executeTakeFirstOrThrow();
    if (current.emirate === plate.emirate && current.code === plate.code && current.number === plate.number) {
      throw new ValidationError("New plate is the same as the current plate");
    }

    const changedBy = actor.kind === "user" ? actor.userId : null;
    await ctx.tx
      .updateTable("vehicle_plate")
      .set({ valid_to: ctx.txTime })
      .where("id", "=", current.id)
      .execute();

    try {
      await ctx.tx
        .insertInto("vehicle_plate")
        .values({
          vehicle_id: vehicleId,
          emirate: plate.emirate,
          code: plate.code,
          number: plate.number,
          changed_by: changedBy,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "plate_already_active",
          `Plate ${plate.emirate}-${plate.code}-${plate.number} is already active on another vehicle`,
        );
      }
      throw error;
    }

    await ctx.audit({
      action: "vehicle.plate_changed",
      entityType: "vehicle",
      entityId: vehicleId,
      before: { emirate: current.emirate, code: current.code, number: current.number },
      after: { emirate: plate.emirate, code: plate.code, number: plate.number },
    });
    return { vehicleId };
  });
}

export type TransferOwnershipResult = { vehicleId: string };

export async function transferOwnership(
  db: Kysely<DB>,
  actor: Actor,
  vehicleId: string,
  newOwnerCustomerId: string,
): Promise<CommandOutcome<TransferOwnershipResult>> {
  return runCommand(db, { name: "vehicle.transfer_owner", actor }, async (ctx) => {
    await ctx.locks.acquire("vehicle", [vehicleId]);

    // Same reasoning as changePlate: the lock confirms the vehicle exists, and it always has
    // exactly one active ownership row.
    const current = await ctx.tx
      .selectFrom("vehicle_ownership")
      .select(["id", "customer_id"])
      .where("vehicle_id", "=", vehicleId)
      .where("valid_to", "is", null)
      .executeTakeFirstOrThrow();
    if (current.customer_id === newOwnerCustomerId) {
      throw new ValidationError("Vehicle is already owned by this customer");
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
      .set({ valid_to: ctx.txTime })
      .where("id", "=", current.id)
      .execute();
    await ctx.tx
      .insertInto("vehicle_ownership")
      .values({
        vehicle_id: vehicleId,
        customer_id: newOwnerCustomerId,
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
  });
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
  plate: PlateInput;
  plateHistory: (PlateInput & { validFrom: Date; validTo: Date | null })[];
  ownershipHistory: { customerId: string; validFrom: Date; validTo: Date | null }[];
}

/** Plain read: current owner, current plate, and both histories in validity order. */
export async function getVehicle(db: Kysely<DB>, id: string): Promise<VehicleProfile | null> {
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
    .select(["customer_id", "valid_from", "valid_to"])
    .where("vehicle_id", "=", id)
    .orderBy("valid_from", "asc")
    .execute();

  const currentPlate = plateRows.find((row) => row.valid_to === null);
  const currentOwnership = ownershipRows.find((row) => row.valid_to === null);
  if (!currentPlate || !currentOwnership) {
    throw new Error(`Vehicle ${id} has no active plate or owner — data integrity violation`);
  }
  const owner = await db
    .selectFrom("customer")
    .select(["name_en", "name_ar"])
    .where("id", "=", currentOwnership.customer_id)
    .executeTakeFirst();

  return {
    id: vehicle.id,
    vin: vehicle.vin,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    colour: vehicle.colour,
    currentOwnerCustomerId: currentOwnership.customer_id,
    currentOwnerName: owner ? (owner.name_en ?? owner.name_ar) : null,
    plate: { emirate: currentPlate.emirate, code: currentPlate.code, number: currentPlate.number },
    plateHistory: plateRows.map((row) => ({
      emirate: row.emirate,
      code: row.code,
      number: row.number,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    })),
    ownershipHistory: ownershipRows.map((row) => ({
      customerId: row.customer_id,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    })),
  };
}
