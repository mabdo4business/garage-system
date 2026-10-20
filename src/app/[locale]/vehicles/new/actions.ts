"use server";

import { redirect } from "next/navigation";
import { idempotencyKeyUsed } from "../../../../server/command/runner";
import type { Emirate } from "../../../../server/db/schema";
import { getDb } from "../../../../server/db/client";
import {
  createVehicle,
  duplicateConfirmKey,
  findDuplicateVehicles,
  type DuplicateVehicle,
  type PlateInput,
  type VehicleInput,
} from "../../../../server/vehicle/service";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../server-support";

export interface VehicleDuplicate {
  matches: DuplicateVehicle[];
  /** VIN + plate the warning was shown for; confirming only counts for these values. */
  confirmFor: string;
}

export type VehicleFormState = FormState<VehicleDuplicate>;

const FIELDS = [
  "ownerCustomerId",
  "vin",
  "make",
  "model",
  "year",
  "colour",
  "plateEmirate",
  "plateCode",
  "plateNumber",
] as const;

/**
 * Server action behind the "Register vehicle" form. Warns on duplicate VIN or a plate that is or
 * was on another vehicle; confirming moves a still-active plate to the new vehicle (OD-1).
 */
export async function createVehicleAction(
  previous: VehicleFormState,
  formData: FormData,
): Promise<VehicleFormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, FIELDS);
  const seq = previous.seq + 1;
  const idempotencyKey = field(formData, "idempotencyKey");
  const db = getDb();

  let vehicleId: string;
  try {
    const session = await requireActionPermission("vehicle.write");
    const plate: PlateInput = {
      emirate: (values.plateEmirate ?? "") as Emirate,
      code: values.plateCode ?? "",
      number: values.plateNumber ?? "",
    };
    const input: VehicleInput = {
      vin: values.vin || null,
      make: values.make ?? "",
      model: values.model ?? "",
      year: /^\d{1,4}$/.test(values.year ?? "") ? Number(values.year) : Number.NaN,
      colour: values.colour || null,
      plate,
      ownerCustomerId: values.ownerCustomerId ?? "",
    };
    const confirmKey = duplicateConfirmKey({ vin: input.vin, plate });
    const confirmed = field(formData, "confirmFor") === confirmKey;
    if (!confirmed && !(await idempotencyKeyUsed(db, "vehicle.create", idempotencyKey))) {
      const duplicates = await findDuplicateVehicles(db, { vin: input.vin, plate });
      if (duplicates.length > 0) {
        return { seq, values, duplicate: { matches: duplicates, confirmFor: confirmKey } };
      }
    }
    const outcome = await createVehicle(db, { kind: "user", userId: session.userId }, input, idempotencyKey, {
      movePlate: confirmed,
    });
    vehicleId = outcome.result.vehicleId;
  } catch (error) {
    return { seq, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/vehicles/${vehicleId}`);
}
