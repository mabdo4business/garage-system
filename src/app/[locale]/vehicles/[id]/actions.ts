"use server";

import { redirect } from "next/navigation";
import { idempotencyKeyUsed } from "../../../../server/command/runner";
import type { Emirate } from "../../../../server/db/schema";
import { getDb } from "../../../../server/db/client";
import {
  changePlate,
  duplicateConfirmKey,
  findDuplicateVehicles,
  transferOwnership,
  type DuplicateVehicle,
  type PlateInput,
} from "../../../../server/vehicle/service";
import type { FormState } from "../../form-state";
import { errorFrom, field, localeOf, requireActionPermission, valuesOf } from "../../server-support";

export interface PlateDuplicate {
  matches: DuplicateVehicle[];
  /** Plate the warning was shown for; confirming only counts for this plate. */
  confirmFor: string;
}

export type ChangePlateFormState = FormState<PlateDuplicate>;
export type TransferOwnerFormState = FormState;

/** Warns when the plate is or was on another vehicle; confirming moves a still-active plate here (OD-1). */
export async function changePlateAction(
  previous: ChangePlateFormState,
  formData: FormData,
): Promise<ChangePlateFormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["plateEmirate", "plateCode", "plateNumber"]);
  const seq = previous.seq + 1;
  const vehicleId = field(formData, "vehicleId");
  const idempotencyKey = field(formData, "idempotencyKey");
  const db = getDb();

  try {
    const session = await requireActionPermission("vehicle.write");
    const plate: PlateInput = {
      emirate: (values.plateEmirate ?? "") as Emirate,
      code: values.plateCode ?? "",
      number: values.plateNumber ?? "",
    };
    const confirmKey = duplicateConfirmKey({ plate });
    const confirmed = field(formData, "confirmFor") === confirmKey;
    if (!confirmed && !(await idempotencyKeyUsed(db, "vehicle.change_plate", idempotencyKey))) {
      const duplicates = await findDuplicateVehicles(db, { plate, excludeVehicleId: vehicleId });
      if (duplicates.length > 0) {
        return { seq, values, duplicate: { matches: duplicates, confirmFor: confirmKey } };
      }
    }
    await changePlate(db, { kind: "user", userId: session.userId }, vehicleId, plate, idempotencyKey, {
      movePlate: confirmed,
    });
  } catch (error) {
    return { seq, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/vehicles/${vehicleId}`);
}

export async function transferOwnerAction(
  previous: TransferOwnerFormState,
  formData: FormData,
): Promise<TransferOwnerFormState> {
  const locale = localeOf(formData);
  const values = valuesOf(formData, ["newOwnerCustomerId"]);
  const seq = previous.seq + 1;
  const vehicleId = field(formData, "vehicleId");

  try {
    const session = await requireActionPermission("vehicle.write");
    await transferOwnership(
      getDb(),
      { kind: "user", userId: session.userId },
      vehicleId,
      values.newOwnerCustomerId ?? "",
      field(formData, "idempotencyKey"),
    );
  } catch (error) {
    return { seq, values, error: errorFrom(error) };
  }
  redirect(`/${locale}/vehicles/${vehicleId}`);
}
