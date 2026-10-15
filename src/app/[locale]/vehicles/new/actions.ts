"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEFAULT_LOCALE, isLocale, type Locale } from "../../../../i18n";
import { authorize } from "../../../../server/auth/service";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import type { Emirate } from "../../../../server/db/schema";
import { createVehicle, findDuplicateVehicles, type VehicleInput } from "../../../../server/vehicle/service";

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/** Server action behind the "Register vehicle" form — works without client-side JavaScript. */
export async function createVehicleAction(formData: FormData): Promise<void> {
  const localeRaw = field(formData, "locale");
  const locale: Locale = isLocale(localeRaw) ? localeRaw : DEFAULT_LOCALE;
  const db = getDb();
  const session = await authorize(
    db,
    await validateSession(db, (await cookies()).get(SESSION_COOKIE)?.value),
    "vehicle.write",
  );

  const plate = {
    emirate: field(formData, "plateEmirate") as Emirate,
    code: field(formData, "plateCode"),
    number: field(formData, "plateNumber"),
  };
  const input: VehicleInput = {
    vin: field(formData, "vin") || null,
    make: field(formData, "make"),
    model: field(formData, "model"),
    year: Number(field(formData, "year")),
    colour: field(formData, "colour") || null,
    plate,
    ownerCustomerId: field(formData, "ownerCustomerId"),
  };
  const confirmDuplicate = field(formData, "confirmDuplicate") === "1";

  if (!confirmDuplicate) {
    const duplicates = await findDuplicateVehicles(db, { vin: input.vin, plate });
    if (duplicates.length > 0) {
      const params = new URLSearchParams({
        duplicate: "1",
        vin: input.vin ?? "",
        make: input.make,
        model: input.model,
        year: String(input.year),
        colour: input.colour ?? "",
        plateEmirate: plate.emirate,
        plateCode: plate.code,
        plateNumber: plate.number,
        ownerCustomerId: input.ownerCustomerId,
      });
      redirect(`/${locale}/vehicles/new?${params.toString()}`);
    }
  }

  const outcome = await createVehicle(
    db,
    { kind: "user", userId: session.userId },
    input,
    field(formData, "idempotencyKey"),
  );
  redirect(`/${locale}/vehicles/${outcome.result.vehicleId}`);
}
