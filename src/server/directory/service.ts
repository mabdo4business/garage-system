import { sql, type Kysely } from "kysely";
import { catalogs } from "../../i18n";
import type { DB, Emirate } from "../db/schema";
import { canReadContact, normalizeMobile, type CustomerContact } from "../customer/service";
import { EMIRATES, type PlateInput } from "../vehicle/service";

/**
 * The one search box (US-02.3: plate/mobile/name/VIN). Plain read, no command — rule 1 allows
 * reads outside a transaction. Contact fields are filtered per-viewer, same as getCustomer, and
 * a viewer who may not see mobile numbers cannot search by them either (I1-01 review finding 4).
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
  /** Null when the vehicle's plate was moved to another vehicle. */
  plate: PlateInput | null;
  ownerCustomerId: string;
}

export interface DirectorySearchResult {
  customers: DirectoryCustomerResult[];
  vehicles: DirectoryVehicleResult[];
}

const RESULT_LIMIT = 25;
const MIN_QUERY_LENGTH = 2;
/** Fewer digits than this would match a large share of all mobiles. */
const MIN_MOBILE_DIGITS = 3;
const MOBILE_QUERY = /^[+\d\s\-()]+$/;

/** Escapes LIKE wildcards so user input matches literally (backslash is PostgreSQL's default escape). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * "Sharjah A 12345", "الشارقة A12345", "A-12345" → optional emirate plus the code and number run
 * together, matched against code || number so a full plate finds the vehicle (review finding 9).
 */
function parsePlateQuery(q: string): { emirate: Emirate | null; compact: string } {
  let rest = q.trim().toLowerCase();
  let emirate: Emirate | null = null;
  outer: for (const candidate of EMIRATES) {
    const labels = [
      catalogs.en[`emirate.${candidate}`],
      catalogs.ar[`emirate.${candidate}`],
      candidate.replace(/_/g, " "),
    ];
    for (const label of labels) {
      if (label && rest.startsWith(label.toLowerCase())) {
        emirate = candidate;
        rest = rest.slice(label.length);
        break outer;
      }
    }
  }
  return { emirate, compact: rest.replace(/[\s\-_.]/g, "").toUpperCase() };
}

export async function searchDirectory(
  db: Kysely<DB>,
  viewerRoles: readonly string[],
  queryText: string,
): Promise<DirectorySearchResult> {
  const q = queryText.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return { customers: [], vehicles: [] };
  }
  const like = `%${escapeLike(q)}%`;
  const showContact = canReadContact(viewerRoles);
  const mobileDigits = MOBILE_QUERY.test(q) ? normalizeMobile(q) : "";
  const searchMobile = showContact && mobileDigits.length >= MIN_MOBILE_DIGITS;
  const plateQuery = parsePlateQuery(q);

  const customerRows = await db
    .selectFrom("customer")
    .select(["id", "name_en", "name_ar", "mobile", "email"])
    .where((eb) =>
      eb.or([
        eb("name_en", "ilike", like),
        eb("name_ar", "ilike", like),
        ...(searchMobile ? [eb("mobile_normalized", "like", `%${mobileDigits}%`)] : []),
      ]),
    )
    .orderBy(sql`coalesce(name_en, name_ar)`)
    .orderBy("id")
    .limit(RESULT_LIMIT)
    .execute();

  const vehicleRows = await db
    .selectFrom("vehicle")
    .leftJoin("vehicle_plate", (join) =>
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
    .where((eb) => {
      // An emirate on its own is not a plate: it only narrows a query that also has a code or number.
      const plateConditions = plateQuery.compact
        ? [
            eb(
              sql<string>`vehicle_plate.code || vehicle_plate.number`,
              "ilike",
              `%${escapeLike(plateQuery.compact)}%`,
            ),
            ...(plateQuery.emirate ? [eb("vehicle_plate.emirate", "=", plateQuery.emirate)] : []),
          ]
        : [];
      return eb.or([
        eb("vehicle.vin", "ilike", like),
        ...(plateConditions.length > 0 ? [eb.and(plateConditions)] : []),
      ]);
    })
    .orderBy("vehicle_plate.code")
    .orderBy("vehicle_plate.number")
    .orderBy("vehicle.id")
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
      plate:
        row.emirate && row.code && row.number
          ? { emirate: row.emirate, code: row.code, number: row.number }
          : null,
      ownerCustomerId: row.customer_id,
    })),
  };
}
