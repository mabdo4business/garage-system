import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/server/command/runner";
import { ConflictError, ValidationError } from "../src/server/core/errors";
import { createCustomer, findDuplicateCustomersByMobile, getCustomer } from "../src/server/customer/service";
import { searchDirectory } from "../src/server/directory/service";
import { createHandlers } from "../src/server/http/handlers";
import { SESSION_COOKIE } from "../src/server/auth/session";
import {
  changePlate,
  createVehicle,
  findDuplicateVehicles,
  getVehicle,
  transferOwnership,
  type VehicleInput,
} from "../src/server/vehicle/service";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

const BASE = "http://localhost:3000";

function jsonRequest(path: string, body: unknown, token?: string) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}),
    },
  });
}

function form(path: string, fields: Record<string, string>) {
  return new Request(`${BASE}${path}`, { method: "POST", body: new URLSearchParams(fields) });
}

function tokenFrom(response: Response): string {
  const cookie = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(cookie);
  return decodeURIComponent(match?.[1] ?? "");
}

async function chunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}

describe("S11 — customers and vehicles", () => {
  let db: TestDatabase;
  let advisor: Actor;
  let technicianUsername: string;
  let technicianUserId: string;
  let advisorToken: string;
  let handlers: ReturnType<typeof createHandlers>;

  beforeAll(async () => {
    db = await createTestDatabase();
    const adv = await makeUser(db.app, ["service_advisor"], "advisor");
    advisor = adv.actor;
    const tech = await makeUser(db.app, ["technician"], "tech");
    technicianUsername = tech.username;
    technicianUserId = tech.userId;
    handlers = createHandlers(db.app);
    advisorToken = await signIn(adv.username);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const signIn = async (username: string) =>
    tokenFrom(
      await handlers.login(form("/api/auth/login", { username, password: TEST_PASSWORD, locale: "en" })),
    );

  const newCustomer = async (overrides: Partial<Parameters<typeof createCustomer>[2]> = {}) =>
    (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: "Ali Hassan",
          mobile: "0501234567",
          preferredLanguage: "en",
          marketingConsent: false,
          ...overrides,
        },
        randomUUID(),
      )
    ).result.customerId;

  let defaultPlateCounter = 0;
  const newVehicle = async (ownerCustomerId: string, overrides: Partial<VehicleInput> = {}) =>
    createVehicle(
      db.app,
      advisor,
      {
        make: "Toyota",
        model: "Corolla",
        year: 2022,
        plate: { emirate: "sharjah", code: "A", number: String(1000 + defaultPlateCounter++) },
        ownerCustomerId,
        ...overrides,
      },
      randomUUID(),
    );

  // --- AC-02.4: duplicate mobile warns, does not block ------------------------------------

  it("AC-02.4: warns on duplicate mobile and only creates a second record when confirmed", async () => {
    const mobile = "0509998888";
    const first = await newCustomer({ mobile });

    const duplicates = await findDuplicateCustomersByMobile(db.app, mobile);
    expect(duplicates.map((d) => d.id)).toContain(first);

    const warned = await handlers.createCustomer(
      jsonRequest(
        "/api/customers",
        { nameEn: "Second Ali", mobile, preferredLanguage: "en", idempotencyKey: randomUUID() },
        advisorToken,
      ),
    );
    expect(warned.status).toBe(200);
    expect(await warned.json()).toMatchObject({ status: "duplicate" });

    const confirmed = await handlers.createCustomer(
      jsonRequest(
        "/api/customers",
        {
          nameEn: "Second Ali",
          mobile,
          preferredLanguage: "en",
          confirmDuplicate: true,
          idempotencyKey: randomUUID(),
        },
        advisorToken,
      ),
    );
    expect(confirmed.status).toBe(201);

    const rows = await db.app
      .selectFrom("customer")
      .select("id")
      .where("mobile_normalized", "=", "509998888")
      .execute();
    expect(rows).toHaveLength(2);
  });

  // --- AC-02.3: search is correct and fast at 10,000 vehicles -----------------------------

  it("AC-02.3: finds the right vehicle by partial plate number in under 2 seconds with 10,000 vehicles", async () => {
    const filler = await db.app
      .insertInto("customer")
      .values({
        name_en: "Bulk Filler",
        mobile: "0500000000",
        mobile_normalized: "500000000",
        preferred_language: "en",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const seedRows = Array.from({ length: 10_000 }, (_, i) => ({
      id: randomUUID(),
      code: i.toString(36).padStart(3, "0"),
    }));
    await chunked(seedRows, 1000, (chunk) =>
      db.app
        .insertInto("vehicle")
        .values(chunk.map((row) => ({ id: row.id, make: "Bulk", model: "Filler", year: 2020 })))
        .execute(),
    );
    await chunked(seedRows, 1000, (chunk) =>
      db.app
        .insertInto("vehicle_plate")
        .values(
          chunk.map((row) => ({
            vehicle_id: row.id,
            emirate: "dubai" as const,
            code: row.code,
            number: "00000", // every bulk row shares this; only `code` varies, so the active-plate index stays unique
          })),
        )
        .execute(),
    );
    await chunked(seedRows, 1000, (chunk) =>
      db.app
        .insertInto("vehicle_ownership")
        .values(chunk.map((row) => ({ vehicle_id: row.id, customer_id: filler.id })))
        .execute(),
    );

    const target = await createVehicle(
      db.app,
      advisor,
      {
        make: "Toyota",
        model: "Corolla",
        year: 2022,
        plate: { emirate: "sharjah", code: "ZZZ", number: "77777" },
        ownerCustomerId: filler.id,
      },
      randomUUID(),
    );

    const start = performance.now();
    const result = await searchDirectory(db.app, ["service_advisor"], "7777");
    const elapsedMs = performance.now() - start;

    expect(result.vehicles.map((v) => v.id)).toContain(target.result.vehicleId);
    expect(elapsedMs).toBeLessThan(2000);
  }, 15_000);

  // --- Ownership change keeps history ------------------------------------------------------

  it("transferring ownership closes the old row and opens a new one, keeping history", async () => {
    const ownerA = await newCustomer({ mobile: "0501111111" });
    const ownerB = await newCustomer({ mobile: "0502222222" });
    const vehicle = await newVehicle(ownerA);

    await transferOwnership(db.app, advisor, vehicle.result.vehicleId, ownerB);

    const rows = await db.app
      .selectFrom("vehicle_ownership")
      .select(["customer_id", "valid_to"])
      .where("vehicle_id", "=", vehicle.result.vehicleId)
      .orderBy("valid_from", "asc")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ customer_id: ownerA });
    expect(rows[0]!.valid_to).not.toBeNull();
    expect(rows[1]).toMatchObject({ customer_id: ownerB, valid_to: null });

    const profile = await getVehicle(db.app, vehicle.result.vehicleId);
    expect(profile!.currentOwnerCustomerId).toBe(ownerB);
  });

  it("transferring to the current owner is rejected", async () => {
    const owner = await newCustomer({ mobile: "0503333333" });
    const vehicle = await newVehicle(owner);
    await expect(transferOwnership(db.app, advisor, vehicle.result.vehicleId, owner)).rejects.toThrow(
      ValidationError,
    );
  });

  // --- Plate change keeps history (GAP-26) --------------------------------------------------

  it("changing a plate closes the old row, opens a new one, and allows reuse after retirement", async () => {
    const owner = await newCustomer({ mobile: "0504444444" });
    const vehicleA = await newVehicle(owner, { plate: { emirate: "ajman", code: "P1", number: "11111" } });

    await changePlate(db.app, advisor, vehicleA.result.vehicleId, {
      emirate: "ajman",
      code: "P2",
      number: "22222",
    });

    const history = await db.app
      .selectFrom("vehicle_plate")
      .select(["code", "number", "valid_to"])
      .where("vehicle_id", "=", vehicleA.result.vehicleId)
      .orderBy("valid_from", "asc")
      .execute();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ code: "P1", number: "11111" });
    expect(history[0]!.valid_to).not.toBeNull();
    expect(history[1]).toMatchObject({ code: "P2", number: "22222", valid_to: null });

    // The retired plate (ajman P1 11111) can now be assigned to a different vehicle.
    const vehicleB = await newVehicle(owner, { plate: { emirate: "ajman", code: "P1", number: "11111" } });
    expect(vehicleB.result.vehicleId).not.toBe(vehicleA.result.vehicleId);

    const duplicates = await findDuplicateVehicles(db.app, {
      plate: { emirate: "ajman", code: "P1", number: "11111" },
    });
    expect(duplicates.some((d) => d.id === vehicleA.result.vehicleId)).toBe(true);
  });

  it("assigning a still-active plate to a different vehicle is rejected", async () => {
    const owner = await newCustomer({ mobile: "0505555555" });
    await newVehicle(owner, { plate: { emirate: "fujairah", code: "Q1", number: "33333" } });
    await expect(
      newVehicle(owner, { plate: { emirate: "fujairah", code: "Q1", number: "33333" } }),
    ).rejects.toThrow(ConflictError);

    const vehicleB = await newVehicle(owner);
    await expect(
      changePlate(db.app, advisor, vehicleB.result.vehicleId, {
        emirate: "fujairah",
        code: "Q1",
        number: "33333",
      }),
    ).rejects.toMatchObject({ code: "plate_already_active" });
  });

  // --- Technician cannot read phone numbers -------------------------------------------------

  it("technicians never see mobile/email; advisors do", async () => {
    const customerId = await newCustomer({ mobile: "0506666666", email: "ali@example.com" });

    const asTechnician = await getCustomer(db.app, ["technician"], customerId);
    expect(asTechnician!.contact).toBeNull();

    const asAdvisor = await getCustomer(db.app, ["service_advisor"], customerId);
    expect(asAdvisor!.contact).toEqual({ mobile: "0506666666", email: "ali@example.com" });
  });

  // --- Validation (negative cases) ----------------------------------------------------------

  it("rejects a customer with neither English nor Arabic name", async () => {
    await expect(
      createCustomer(
        db.app,
        advisor,
        { mobile: "0507777777", preferredLanguage: "en", marketingConsent: false },
        randomUUID(),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an invalid preferredLanguage", async () => {
    await expect(
      createCustomer(
        db.app,
        advisor,
        // @ts-expect-error — invalid on purpose
        { nameEn: "X", mobile: "0507777778", preferredLanguage: "fr", marketingConsent: false },
        randomUUID(),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a vehicle with an out-of-range year", async () => {
    const owner = await newCustomer({ mobile: "0508888888" });
    await expect(newVehicle(owner, { year: 1899 })).rejects.toThrow(ValidationError);
  });

  it("rejects a vehicle whose ownerCustomerId does not exist", async () => {
    await expect(newVehicle(randomUUID())).rejects.toThrow(/not found|customer/i);
  });

  // --- Authorization ---------------------------------------------------------------------

  it("denies a technician at the server for customer.write, and audits the denial", async () => {
    const token = await signIn(technicianUsername);
    const response = await handlers.createCustomer(
      jsonRequest(
        "/api/customers",
        { nameEn: "Blocked", mobile: "0509090910", preferredLanguage: "en", idempotencyKey: randomUUID() },
        token,
      ),
    );
    expect(response.status).toBe(403);

    const created = await db.app
      .selectFrom("customer")
      .select("id")
      .where("mobile_normalized", "=", "509090910")
      .execute();
    expect(created).toHaveLength(0);

    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", technicianUserId)
      .execute();
    expect(denied.some((d) => (d.details as { permission?: string }).permission === "customer.write")).toBe(
      true,
    );
  });

  it("denies a technician at the server for vehicle.write", async () => {
    const owner = await newCustomer({ mobile: "0509191919" });
    const token = await signIn(technicianUsername);
    const response = await handlers.createVehicle(
      jsonRequest(
        "/api/vehicles",
        {
          make: "Toyota",
          model: "Corolla",
          year: 2022,
          plateEmirate: "dubai",
          plateCode: "T1",
          plateNumber: "55555",
          ownerCustomerId: owner,
          idempotencyKey: randomUUID(),
        },
        token,
      ),
    );
    expect(response.status).toBe(403);
  });

  // --- Idempotency ---------------------------------------------------------------------------

  it("creating a customer twice with the same idempotency key returns one row, replayed the second time", async () => {
    const key = randomUUID();
    const input = {
      nameEn: "Idempotent Ali",
      mobile: "0501212121",
      preferredLanguage: "en" as const,
      marketingConsent: false,
    };
    const first = await createCustomer(db.app, advisor, input, key);
    const second = await createCustomer(db.app, advisor, input, key);
    expect(first.result.customerId).toBe(second.result.customerId);
    expect(second.replayed).toBe(true);

    const rows = await db.app
      .selectFrom("customer")
      .select("id")
      .where("mobile_normalized", "=", "501212121")
      .execute();
    expect(rows).toHaveLength(1);
  });

  // --- Concurrency -----------------------------------------------------------------------

  it("two vehicles racing for the same active plate: exactly one succeeds", async () => {
    const owner = await newCustomer({ mobile: "0501313131" });
    const plate = { emirate: "umm_al_quwain" as const, code: "R1", number: "44444" };
    const outcomes = await Promise.allSettled([newVehicle(owner, { plate }), newVehicle(owner, { plate })]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "plate_already_active" });
  });

  it("two ownership transfers racing on the same vehicle leave exactly one active owner and no overlap", async () => {
    const ownerA = await newCustomer({ mobile: "0501414141" });
    const ownerB = await newCustomer({ mobile: "0501515151" });
    const ownerC = await newCustomer({ mobile: "0501616161" });
    const vehicle = await newVehicle(ownerA);

    await Promise.allSettled([
      transferOwnership(db.app, advisor, vehicle.result.vehicleId, ownerB),
      transferOwnership(db.app, advisor, vehicle.result.vehicleId, ownerC),
    ]);

    const rows = await db.app
      .selectFrom("vehicle_ownership")
      .select(["customer_id", "valid_from", "valid_to"])
      .where("vehicle_id", "=", vehicle.result.vehicleId)
      .orderBy("valid_from", "asc")
      .execute();
    expect(rows.filter((r) => r.valid_to === null)).toHaveLength(1);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.valid_from.getTime()).toBeGreaterThanOrEqual(rows[i - 1]!.valid_from.getTime());
      if (rows[i - 1]!.valid_to) {
        expect(rows[i - 1]!.valid_to!.getTime()).toBeLessThanOrEqual(rows[i]!.valid_from.getTime());
      }
    }
  });

  // --- Grants ----------------------------------------------------------------------------

  it("the application role cannot UPDATE customer or vehicle, and may only close validity windows", async () => {
    expect((await sqlErrorAs(db.appUrl, "UPDATE customer SET name_en = 'X'"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "UPDATE vehicle SET make = 'X'"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "UPDATE vehicle_plate SET code = 'X'"))?.code).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, "UPDATE vehicle_plate SET valid_to = now() WHERE id = gen_random_uuid()"))
        ?.code,
    ).toBeUndefined();
    expect(
      (await sqlErrorAs(db.appUrl, "UPDATE vehicle_ownership SET customer_id = gen_random_uuid()"))?.code,
    ).toBe("42501");
  });
});
