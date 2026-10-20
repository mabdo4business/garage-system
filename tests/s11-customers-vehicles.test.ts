import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
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
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
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
      index: i,
      code: i.toString(36).padStart(3, "0"),
    }));
    // One transaction: every vehicle must have its current owner by commit (0004).
    await db.app.transaction().execute(async (seed) => {
      await chunked(seedRows, 1000, (chunk) =>
        seed
          .insertInto("vehicle")
          .values(chunk.map((row) => ({ id: row.id, make: "Bulk", model: "Filler", year: 2020 })))
          .execute(),
      );
      await chunked(seedRows, 1000, (chunk) =>
        seed
          .insertInto("vehicle_plate")
          .values(
            chunk.map((row) => ({
              vehicle_id: row.id,
              emirate: "dubai" as const,
              code: row.code,
              number: String(row.index).padStart(5, "0"), // 00000–09999: realistic spread for partial matches
            })),
          )
          .execute(),
      );
      await chunked(seedRows, 1000, (chunk) =>
        seed
          .insertInto("vehicle_ownership")
          .values(chunk.map((row) => ({ vehicle_id: row.id, customer_id: filler.id })))
          .execute(),
      );
    });

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

    // A broad partial match (hundreds of plates contain "12") is still capped and fast.
    const broadStart = performance.now();
    const broad = await searchDirectory(db.app, ["service_advisor"], "12");
    const broadMs = performance.now() - broadStart;
    expect(broad.vehicles).toHaveLength(25);
    expect(broadMs).toBeLessThan(2000);
  }, 15_000);

  // --- Ownership change keeps history ------------------------------------------------------

  it("transferring ownership closes the old row and opens a new one, keeping history", async () => {
    const ownerA = await newCustomer({ mobile: "0501111111" });
    const ownerB = await newCustomer({ mobile: "0502222222" });
    const vehicle = await newVehicle(ownerA);

    await transferOwnership(db.app, advisor, vehicle.result.vehicleId, ownerB, randomUUID());

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
    await expect(
      transferOwnership(db.app, advisor, vehicle.result.vehicleId, owner, randomUUID()),
    ).rejects.toThrow(ValidationError);
  });

  // --- Plate change keeps history (GAP-26) --------------------------------------------------

  it("changing a plate closes the old row, opens a new one, and allows reuse after retirement", async () => {
    const owner = await newCustomer({ mobile: "0504444444" });
    const vehicleA = await newVehicle(owner, { plate: { emirate: "ajman", code: "P1", number: "11111" } });

    await changePlate(
      db.app,
      advisor,
      vehicleA.result.vehicleId,
      {
        emirate: "ajman",
        code: "P2",
        number: "22222",
      },
      randomUUID(),
    );

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
      changePlate(
        db.app,
        advisor,
        vehicleB.result.vehicleId,
        {
          emirate: "fujairah",
          code: "Q1",
          number: "33333",
        },
        randomUUID(),
      ),
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

  /** Every row but the last is closed exactly when the next one opens; only the last is active. */
  function expectGaplessChain(rows: { valid_from: Date; valid_to: Date | null }[], expectedLength: number) {
    expect(rows).toHaveLength(expectedLength);
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i]!.valid_to).not.toBeNull();
      expect(rows[i]!.valid_to!.getTime()).toBe(rows[i + 1]!.valid_from.getTime());
    }
    expect(rows[rows.length - 1]!.valid_to).toBeNull();
  }

  it("concurrent ownership transfers on one vehicle all succeed, serialised into a gapless history", async () => {
    const ownerA = await newCustomer({ mobile: "0501414141" });
    const others = [
      await newCustomer({ mobile: "0501515151" }),
      await newCustomer({ mobile: "0501616161" }),
      await newCustomer({ mobile: "0501717171" }),
    ];
    // Several rounds: a transaction that starts before, but locks after, another must still succeed.
    for (let round = 0; round < 5; round++) {
      const vehicle = await newVehicle(ownerA);
      const outcomes = await Promise.allSettled(
        others.map((owner) =>
          transferOwnership(db.app, advisor, vehicle.result.vehicleId, owner, randomUUID()),
        ),
      );
      expect(outcomes.map((o) => (o.status === "rejected" ? o.reason : "ok"))).toEqual(["ok", "ok", "ok"]);

      const rows = await db.app
        .selectFrom("vehicle_ownership")
        .select(["customer_id", "valid_from", "valid_to"])
        .where("vehicle_id", "=", vehicle.result.vehicleId)
        .orderBy("valid_from", "asc")
        .execute();
      expectGaplessChain(rows, 4);
      expect(rows[0]!.customer_id).toBe(ownerA);
      expect(new Set(rows.slice(1).map((r) => r.customer_id))).toEqual(new Set(others));
    }
  });

  it("concurrent plate changes on one vehicle all succeed, serialised into a gapless history", async () => {
    const owner = await newCustomer({ mobile: "0501818181" });
    for (let round = 0; round < 5; round++) {
      const vehicle = await newVehicle(owner);
      const plates = ["1", "2", "3"].map((n) => ({
        emirate: "ras_al_khaimah" as const,
        code: `C${round}`,
        number: `${n}${n}${n}`,
      }));
      const outcomes = await Promise.allSettled(
        plates.map((plate) => changePlate(db.app, advisor, vehicle.result.vehicleId, plate, randomUUID())),
      );
      expect(outcomes.map((o) => (o.status === "rejected" ? o.reason : "ok"))).toEqual(["ok", "ok", "ok"]);

      const rows = await db.app
        .selectFrom("vehicle_plate")
        .select(["valid_from", "valid_to"])
        .where("vehicle_id", "=", vehicle.result.vehicleId)
        .orderBy("valid_from", "asc")
        .execute();
      expectGaplessChain(rows, 4);
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

describe("S11 — I1-01 review fixes", () => {
  let db: TestDatabase;
  let advisor: Actor;
  let advisorToken: string;
  let technicianToken: string;
  let handlers: ReturnType<typeof createHandlers>;

  beforeAll(async () => {
    db = await createTestDatabase();
    handlers = createHandlers(db.app);
    const adv = await makeUser(db.app, ["service_advisor"], "advisor");
    advisor = adv.actor;
    const tech = await makeUser(db.app, ["technician"], "tech");
    advisorToken = await signIn(adv.username);
    technicianToken = await signIn(tech.username);
  });
  afterAll(async () => {
    await db?.destroy();
  });

  async function signIn(username: string) {
    return tokenFrom(
      await handlers.login(form("/api/auth/login", { username, password: TEST_PASSWORD, locale: "en" })),
    );
  }

  function request(path: string, init: { token?: string; body?: unknown; origin?: string } = {}) {
    return new Request(`${BASE}${path}`, {
      method: init.body === undefined ? "GET" : "POST",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers: {
        "content-type": "application/json",
        ...(init.token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(init.token)}` } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
      },
    });
  }

  let mobileCounter = 0;
  const newCustomer = async (overrides: Partial<Parameters<typeof createCustomer>[2]> = {}) =>
    (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: "Review Customer",
          mobile: `05200${String(mobileCounter++).padStart(5, "0")}`,
          preferredLanguage: "en",
          marketingConsent: false,
          ...overrides,
        },
        randomUUID(),
      )
    ).result.customerId;

  let plateCounter = 0;
  const newVehicle = async (
    ownerCustomerId: string,
    overrides: Partial<VehicleInput> = {},
    options: { movePlate?: boolean } = {},
  ) =>
    (
      await createVehicle(
        db.app,
        advisor,
        {
          make: "Nissan",
          model: "Patrol",
          year: 2021,
          plate: { emirate: "ajman", code: "RV", number: String(20000 + plateCounter++) },
          ownerCustomerId,
          ...overrides,
        },
        randomUUID(),
        options,
      )
    ).result.vehicleId;

  // --- Finding 3: an unmatched name must not match every customer -------------------------

  it("a search that matches nobody returns nothing, and LIKE wildcards match literally", async () => {
    await newCustomer({ nameEn: "Somebody Else" });
    for (const q of ["Zzzznobody", "%%", "__", "971", "05"]) {
      const result = await searchDirectory(db.app, ["service_advisor"], q);
      expect({ q, customers: result.customers }).toEqual({ q, customers: [] });
    }
  });

  // --- Finding 4: no mobile lookup without customer.read_contact --------------------------

  it("a technician cannot find a customer by mobile number; an advisor can", async () => {
    const customerId = await newCustomer({ nameEn: "Omar Saeed", mobile: "0559876543" });

    const asTechnician = await searchDirectory(db.app, ["technician"], "0559876");
    expect(asTechnician.customers).toEqual([]);

    const asAdvisor = await searchDirectory(db.app, ["service_advisor"], "0559876");
    expect(asAdvisor.customers.map((c) => c.id)).toEqual([customerId]);
    expect(asAdvisor.customers[0]!.contact).toEqual({ mobile: "0559876543", email: null });

    // By name a technician finds the customer, but without contact details.
    const byName = await searchDirectory(db.app, ["technician"], "Omar Saeed");
    expect(byName.customers.map((c) => [c.id, c.contact])).toEqual([[customerId, null]]);
  });

  it("GET /api/customers/:id omits mobile and email for a technician", async () => {
    const customerId = await newCustomer({ mobile: "0559876500", email: "omar@example.com" });
    const asTechnician = await handlers.getCustomer(
      request(`/api/customers/${customerId}`, { token: technicianToken }),
      customerId,
    );
    expect(asTechnician.status).toBe(200);
    const body = (await asTechnician.json()) as Record<string, unknown>;
    expect(body.contact).toBeNull();
    expect(JSON.stringify(body)).not.toContain("0559876500");
    expect(JSON.stringify(body)).not.toContain("omar@example.com");
  });

  // --- Finding 9: a full plate finds the vehicle -----------------------------------------

  it("searching a full plate, with or without the emirate, finds the vehicle", async () => {
    const owner = await newCustomer();
    const vehicleId = await newVehicle(owner, { plate: { emirate: "sharjah", code: "SH", number: "54321" } });

    for (const q of ["SH 54321", "SH54321", "sh-54321", "Sharjah SH 54321", "الشارقة SH54321", "54321"]) {
      const result = await searchDirectory(db.app, ["technician"], q);
      expect({ q, ids: result.vehicles.map((v) => v.id) }).toEqual({ q, ids: [vehicleId] });
    }
    const otherEmirate = await searchDirectory(db.app, ["technician"], "Dubai SH 54321");
    expect(otherEmirate.vehicles).toEqual([]);
  });

  // --- Finding 10 / decision OD-1: warn, then move a still-active plate ------------------

  it("a plate active on another vehicle warns; confirming moves it and leaves the old vehicle without a plate", async () => {
    const owner = await newCustomer();
    const plate = { emirate: "abu_dhabi" as const, code: "M1", number: "60606" };
    const vehicleA = await newVehicle(owner, { plate });

    const warned = await handlers.createVehicle(
      request("/api/vehicles", {
        token: advisorToken,
        body: {
          make: "Lexus",
          model: "LX",
          year: 2024,
          plateEmirate: plate.emirate,
          plateCode: plate.code,
          plateNumber: plate.number,
          ownerCustomerId: owner,
          idempotencyKey: randomUUID(),
        },
      }),
    );
    expect(await warned.json()).toMatchObject({
      status: "duplicate",
      matches: [{ id: vehicleA, reason: "plate_active" }],
    });

    // Without confirmation the command itself refuses — the warning is not the only guard.
    await expect(newVehicle(owner, { plate })).rejects.toMatchObject({ code: "plate_already_active" });

    const vehicleB = await newVehicle(owner, { plate }, { movePlate: true });

    const profileA = await getVehicle(db.app, vehicleA);
    const profileB = await getVehicle(db.app, vehicleB);
    expect(profileA!.plate).toBeNull();
    expect(profileB!.plate).toEqual(plate);
    expect(profileA!.plateHistory[0]!.validTo!.getTime()).toBe(
      profileB!.plateHistory[0]!.validFrom.getTime(),
    );

    const retired = await db.app
      .selectFrom("audit_event")
      .select(["details", "before_state"])
      .where("action", "=", "vehicle.plate_retired")
      .where("entity_id", "=", vehicleA)
      .execute();
    expect(retired).toHaveLength(1);
    expect(retired[0]!.details).toMatchObject({ reason: "moved_to_vehicle", vehicleId: vehicleB });

    // The vehicle left without a plate can be given a new one.
    await changePlate(
      db.app,
      advisor,
      vehicleA,
      { emirate: "abu_dhabi", code: "M2", number: "60607" },
      randomUUID(),
    );
    expect((await getVehicle(db.app, vehicleA))!.plate).toEqual({
      emirate: "abu_dhabi",
      code: "M2",
      number: "60607",
    });

    // changePlate can move a plate too.
    const vehicleC = await newVehicle(owner);
    await expect(changePlate(db.app, advisor, vehicleC, plate, randomUUID())).rejects.toMatchObject({
      code: "plate_already_active",
    });
    await changePlate(db.app, advisor, vehicleC, plate, randomUUID(), { movePlate: true });
    expect((await getVehicle(db.app, vehicleB))!.plate).toBeNull();
    expect((await getVehicle(db.app, vehicleC))!.plate).toEqual(plate);
  });

  it("losing the race for a plate on the unique index is a clean plate_already_active conflict", async () => {
    const owner = await newCustomer();
    const plate = { emirate: "dubai" as const, code: "UQ", number: "41414" };
    const rival = await newVehicle(owner);

    // Another transaction inserts the plate for a different vehicle and holds it uncommitted, so
    // our insert waits on the unique index and fails with 23505 once the rival commits.
    const other = new pg.Client({ connectionString: db.appUrl });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "INSERT INTO vehicle_plate (vehicle_id, emirate, code, number) VALUES ($1, $2, $3, $4)",
        [rival, plate.emirate, plate.code, plate.number],
      );
      const attempt = newVehicle(owner, { plate }).then(
        () => "ok",
        (error: unknown) => error,
      );
      await waitForLockWaiters(db, 1);
      await other.query("COMMIT");
      expect(await attempt).toMatchObject({ code: "plate_already_active" });
    } finally {
      await other.end();
    }
  });

  it("two vehicles racing to take the same active plate: the plate ends on exactly one, losers get a clean conflict", async () => {
    const owner = await newCustomer();
    const plate = { emirate: "dubai" as const, code: "RC", number: "70707" };
    const holder = await newVehicle(owner, { plate });
    const [x, y] = [await newVehicle(owner), await newVehicle(owner)];

    const outcomes = await Promise.allSettled([
      changePlate(db.app, advisor, x, plate, randomUUID(), { movePlate: true }),
      changePlate(db.app, advisor, y, plate, randomUUID(), { movePlate: true }),
    ]);
    // The second may find the plate moved to a vehicle it did not lock: a clean conflict, not a 500.
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({ code: "plate_already_active" });
      }
    }
    const active = await db.app
      .selectFrom("vehicle_plate")
      .select("vehicle_id")
      .where("emirate", "=", plate.emirate)
      .where("code", "=", plate.code)
      .where("number", "=", plate.number)
      .where("valid_to", "is", null)
      .execute();
    expect(active).toHaveLength(1);
    expect([x, y]).toContain(active[0]!.vehicle_id);
    expect((await getVehicle(db.app, holder))!.plate).toBeNull();
  });

  // --- Finding 5: a retried create replays instead of warning about itself -----------------

  it("retrying POST /api/customers with the same key replays the result instead of warning", async () => {
    const body = {
      nameEn: "Retry Ali",
      mobile: "0561112222",
      preferredLanguage: "en",
      idempotencyKey: randomUUID(),
    };
    const first = await handlers.createCustomer(request("/api/customers", { token: advisorToken, body }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { customerId: string };

    const retry = await handlers.createCustomer(request("/api/customers", { token: advisorToken, body }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "created", customerId: firstBody.customerId });

    const rows = await db.app
      .selectFrom("customer")
      .select("id")
      .where("mobile_normalized", "=", "561112222")
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("retrying POST /api/vehicles with the same key replays the result instead of warning", async () => {
    const owner = await newCustomer();
    const body = {
      vin: "JTMHV05J604000001",
      make: "Toyota",
      model: "Land Cruiser",
      year: 2023,
      plateEmirate: "sharjah",
      plateCode: "RT",
      plateNumber: "80808",
      ownerCustomerId: owner,
      idempotencyKey: randomUUID(),
    };
    const first = await handlers.createVehicle(request("/api/vehicles", { token: advisorToken, body }));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { vehicleId: string };

    const retry = await handlers.createVehicle(request("/api/vehicles", { token: advisorToken, body }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "created", vehicleId: firstBody.vehicleId });

    const rows = await db.app.selectFrom("vehicle").select("id").where("vin", "=", body.vin).execute();
    expect(rows).toHaveLength(1);
  });

  it("createVehicle with the same idempotency key creates one vehicle and replays", async () => {
    const owner = await newCustomer();
    const key = randomUUID();
    const input: VehicleInput = {
      make: "Kia",
      model: "Sportage",
      year: 2020,
      plate: { emirate: "fujairah", code: "ID", number: "90909" },
      ownerCustomerId: owner,
    };
    const first = await createVehicle(db.app, advisor, input, key);
    const second = await createVehicle(db.app, advisor, input, key);
    expect(second.replayed).toBe(true);
    expect(second.result.vehicleId).toBe(first.result.vehicleId);
    await expect(createVehicle(db.app, advisor, { ...input, year: 2019 }, key)).rejects.toMatchObject({
      code: "idempotency_payload_mismatch",
    });
  });

  // --- Finding 8: malformed ids are validation / not-found errors, never 500 ----------------

  it("malformed ids are rejected cleanly", async () => {
    const owner = await newCustomer();
    const vehicleId = await newVehicle(owner);

    await expect(newVehicle("not-a-uuid")).rejects.toThrow(ValidationError);
    await expect(transferOwnership(db.app, advisor, "not-a-uuid", owner, randomUUID())).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );
    await expect(transferOwnership(db.app, advisor, vehicleId, "x", randomUUID())).rejects.toThrow(
      ValidationError,
    );
    await expect(
      changePlate(db.app, advisor, "x", { emirate: "dubai", code: "A", number: "1" }, randomUUID()),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await getVehicle(db.app, "x")).toBeNull();
    expect(await getCustomer(db.app, ["partner"], "x")).toBeNull();

    const response = await handlers.transferVehicleOwner(
      request(`/api/vehicles/${vehicleId}/transfer-owner`, {
        token: advisorToken,
        body: { newOwnerCustomerId: "x", idempotencyKey: randomUUID() },
      }),
      vehicleId,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "validation_failed",
      details: { field: "newOwnerCustomerId" },
    });
  });

  // --- Finding 17: handler authorization, 404 and same-origin for plate / transfer / get -----

  it("plate change and transfer handlers: technician 403, bad id 404, cross-origin 403", async () => {
    const owner = await newCustomer();
    const other = await newCustomer();
    const vehicleId = await newVehicle(owner);
    const plateBody = {
      plateEmirate: "dubai",
      plateCode: "HT",
      plateNumber: "12121",
      idempotencyKey: randomUUID(),
    };

    const techPlate = await handlers.changeVehiclePlate(
      request(`/api/vehicles/${vehicleId}/plate`, { token: technicianToken, body: plateBody }),
      vehicleId,
    );
    expect(techPlate.status).toBe(403);
    const techTransfer = await handlers.transferVehicleOwner(
      request(`/api/vehicles/${vehicleId}/transfer-owner`, {
        token: technicianToken,
        body: { newOwnerCustomerId: other, idempotencyKey: randomUUID() },
      }),
      vehicleId,
    );
    expect(techTransfer.status).toBe(403);

    const crossOrigin = await handlers.changeVehiclePlate(
      request(`/api/vehicles/${vehicleId}/plate`, {
        token: advisorToken,
        body: plateBody,
        origin: "https://evil.example",
      }),
      vehicleId,
    );
    expect(crossOrigin.status).toBe(403);
    expect((await getVehicle(db.app, vehicleId))!.plateHistory).toHaveLength(1);

    const badId = await handlers.getVehicle(request("/api/vehicles/nope", { token: advisorToken }), "nope");
    expect(badId.status).toBe(404);
    const missing = randomUUID();
    const notFound = await handlers.getVehicle(
      request(`/api/vehicles/${missing}`, { token: advisorToken }),
      missing,
    );
    expect(notFound.status).toBe(404);

    const ok = await handlers.changeVehiclePlate(
      request(`/api/vehicles/${vehicleId}/plate`, { token: advisorToken, body: plateBody }),
      vehicleId,
    );
    expect(ok.status).toBe(200);
    const transferred = await handlers.transferVehicleOwner(
      request(`/api/vehicles/${vehicleId}/transfer-owner`, {
        token: advisorToken,
        body: { newOwnerCustomerId: other, idempotencyKey: randomUUID() },
      }),
      vehicleId,
    );
    expect(transferred.status).toBe(200);
    const asTechnician = await handlers.getVehicle(
      request(`/api/vehicles/${vehicleId}`, { token: technicianToken }),
      vehicleId,
    );
    expect(await asTechnician.json()).toMatchObject({
      currentOwnerCustomerId: other,
      plate: { emirate: "dubai", code: "HT", number: "12121" },
    });
  });

  // --- Finding 6: closed history rows and vehicle rows cannot be rewritten ------------------

  it("the application role cannot rewrite or reopen closed history, nor update a vehicle", async () => {
    const ownerA = await newCustomer();
    const ownerB = await newCustomer();
    const vehicleId = await newVehicle(ownerA);
    await transferOwnership(db.app, advisor, vehicleId, ownerB, randomUUID());
    await changePlate(
      db.app,
      advisor,
      vehicleId,
      { emirate: "ajman", code: "GR", number: "31313" },
      randomUUID(),
    );

    for (const table of ["vehicle_ownership", "vehicle_plate"]) {
      const closed = `vehicle_id = '${vehicleId}' AND valid_to IS NOT NULL`;
      expect(
        (await sqlErrorAs(db.appUrl, `UPDATE ${table} SET valid_to = '2000-01-01' WHERE ${closed}`))?.code,
      ).toBe("42501");
      expect((await sqlErrorAs(db.appUrl, `UPDATE ${table} SET valid_to = NULL WHERE ${closed}`))?.code).toBe(
        "42501",
      );
      // Setting an open row's valid_to back to NULL is also refused.
      const open = `vehicle_id = '${vehicleId}' AND valid_to IS NULL`;
      expect((await sqlErrorAs(db.appUrl, `UPDATE ${table} SET valid_to = NULL WHERE ${open}`))?.code).toBe(
        "42501",
      );
    }
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE vehicle SET colour = 'pink' WHERE id = '${vehicleId}'`))?.code,
    ).toBe("42501");
    // Row locks still work (they do not fire UPDATE triggers).
    expect(
      (await sqlErrorAs(db.appUrl, `SELECT id FROM vehicle WHERE id = '${vehicleId}' FOR UPDATE`))?.code,
    ).toBeUndefined();
  });

  it("an active history row cannot be closed in the future, and a vehicle always keeps one current owner", async () => {
    const owner = await newCustomer();
    const vehicleId = await newVehicle(owner);
    const open = `vehicle_id = '${vehicleId}' AND valid_to IS NULL`;

    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE vehicle_plate SET valid_to = '2999-01-01' WHERE ${open}`))?.code,
    ).toBe("23514");
    // Closing the only ownership row, with no replacement, fails at commit.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE vehicle_ownership SET valid_to = now() WHERE ${open}`))?.code,
    ).toBe("23514");
    // A vehicle inserted without an owner fails at commit too.
    expect(
      (await sqlErrorAs(db.appUrl, "INSERT INTO vehicle (make, model, year) VALUES ('No', 'Owner', 2020)"))
        ?.code,
    ).toBe("23514");

    // Closing a plate now, without a replacement, stays allowed: that is a plate move (OD-1).
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE vehicle_plate SET valid_to = now() WHERE ${open}`))?.code,
    ).toBe(undefined);
    const profile = await getVehicle(db.app, vehicleId);
    expect(profile!.currentOwnerCustomerId).toBe(owner);
  });

  // --- N2: plate change and transfer replay on a repeated key --------------------------------

  it("changePlate and transferOwnership replay on a repeated idempotency key", async () => {
    const ownerA = await newCustomer();
    const ownerB = await newCustomer();
    const vehicleId = await newVehicle(ownerA);

    const plateKey = randomUUID();
    const plate = { emirate: "sharjah" as const, code: "RP", number: "51515" };
    const firstPlate = await changePlate(db.app, advisor, vehicleId, plate, plateKey);
    const againPlate = await changePlate(db.app, advisor, vehicleId, plate, plateKey);
    expect([firstPlate.replayed, againPlate.replayed]).toEqual([false, true]);

    const transferKey = randomUUID();
    const firstTransfer = await transferOwnership(db.app, advisor, vehicleId, ownerB, transferKey);
    const againTransfer = await transferOwnership(db.app, advisor, vehicleId, ownerB, transferKey);
    expect([firstTransfer.replayed, againTransfer.replayed]).toEqual([false, true]);

    const profile = await getVehicle(db.app, vehicleId);
    expect(profile!.plateHistory).toHaveLength(2);
    expect(profile!.ownershipHistory).toHaveLength(2);
  });

  // --- N4: the API moves a plate only when confirmFor matches the warned plate ---------------

  it("POST /api/vehicles/:id/plate moves a plate only with the confirmFor key from the warning", async () => {
    const owner = await newCustomer();
    const plate = { plateEmirate: "dubai", plateCode: "CF", plateNumber: "61616" };
    const holder = await newVehicle(owner, { plate: { emirate: "dubai", code: "CF", number: "61616" } });
    const target = await newVehicle(owner);
    const post = (body: Record<string, unknown>) =>
      handlers.changeVehiclePlate(
        request(`/api/vehicles/${target}/plate`, {
          token: advisorToken,
          body: { ...body, idempotencyKey: randomUUID() },
        }),
        target,
      );

    const warned = (await (await post(plate)).json()) as { status: string; confirmFor: string };
    expect(warned.status).toBe("duplicate");

    // A confirmation for a different plate (or a bare flag) is not a confirmation for this one.
    expect(await (await post({ ...plate, confirmDuplicate: true })).json()).toMatchObject({
      status: "duplicate",
    });
    expect(await (await post({ ...plate, confirmFor: "|dubai|CF|00000" })).json()).toMatchObject({
      status: "duplicate",
    });
    expect((await getVehicle(db.app, holder))!.plate).not.toBeNull();

    const moved = await post({ ...plate, confirmFor: warned.confirmFor });
    expect(await moved.json()).toMatchObject({ status: "changed" });
    expect((await getVehicle(db.app, holder))!.plate).toBeNull();
  });

  // --- N5: error responses carry only the field name ------------------------------------------

  it("error responses expose details.field only", async () => {
    const response = await handlers.getCustomer(request(`/api/customers/x`), "x");
    expect(response.status).toBe(401);
    const forbidden = await handlers.createVehicle(
      request("/api/vehicles", { token: technicianToken, body: { idempotencyKey: randomUUID() } }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).not.toHaveProperty("details");
  });
});
