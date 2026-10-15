import type { Kysely } from "kysely";
import type { DB } from "../db/schema";
import { canReadContact, normalizeMobile, type CustomerContact } from "../customer/service";
import type { PlateInput } from "../vehicle/service";

/**
 * The one search box (US-02.3: plate/mobile/name/VIN). Plain read, no command — rule 1 allows
 * reads outside a transaction. Contact fields are filtered per-viewer, same as getCustomer.
 */

export interface DirectoryCustomerResult {
  id: string;
  nameEn: string | null;
  nameAr: string | null;
  contact: CustomerContact | null;
}

export interface DirectoryVehicleResult {
  id: string;
  make: string;
  model: string;
  year: number;
  plate: PlateInput;
  ownerCustomerId: string;
}

export interface DirectorySearchResult {
  customers: DirectoryCustomerResult[];
  vehicles: DirectoryVehicleResult[];
}

const RESULT_LIMIT = 25;
const MIN_QUERY_LENGTH = 2;

export async function searchDirectory(
  db: Kysely<DB>,
  viewerRoles: readonly string[],
  queryText: string,
): Promise<DirectorySearchResult> {
  const q = queryText.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return { customers: [], vehicles: [] };
  }
  const like = `%${q}%`;
  const mobileLike = `%${normalizeMobile(q)}%`;
  const showContact = canReadContact(viewerRoles);

  const customerRows = await db
    .selectFrom("customer")
    .select(["id", "name_en", "name_ar", "mobile", "email", "mobile_normalized"])
    .where((eb) =>
      eb.or([
        eb("name_en", "ilike", like),
        eb("name_ar", "ilike", like),
        eb("mobile_normalized", "like", mobileLike),
      ]),
    )
    .limit(RESULT_LIMIT)
    .execute();

  const vehicleRows = await db
    .selectFrom("vehicle")
    .innerJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .innerJoin("vehicle_ownership", (join) =>
      join
        .onRef("vehicle_ownership.vehicle_id", "=", "vehicle.id")
        .on("vehicle_ownership.valid_to", "is", null),
    )
    .select([
      "vehicle.id",
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number",
      "vehicle_ownership.customer_id",
    ])
    .where((eb) =>
      eb.or([
        eb("vehicle.vin", "ilike", like),
        eb("vehicle_plate.code", "ilike", like),
        eb("vehicle_plate.number", "ilike", like),
      ]),
    )
    .limit(RESULT_LIMIT)
    .execute();

  return {
    customers: customerRows.map((row) => ({
      id: row.id,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      contact: showContact ? { mobile: row.mobile, email: row.email } : null,
    })),
    vehicles: vehicleRows.map((row) => ({
      id: row.id,
      make: row.make,
      model: row.model,
      year: row.year,
      plate: { emirate: row.emirate, code: row.code, number: row.number },
      ownerCustomerId: row.customer_id,
    })),
  };
}
