import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import {
  createItem,
  getCatalogueItem,
  listCatalogue,
  priceAt,
  setItemActive,
  setPrice,
  updateItemDetails,
} from "../src/server/catalog/items";
import {
  addTaxProfile,
  createTaxCode,
  setTaxCodeRate,
  taxCodeRateOn,
  taxProfileOn,
  type Staff,
} from "../src/server/catalog/tax";
import { createHandlers } from "../src/server/http/handlers";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/** I1-04 — price list (labor rates, packages, parts and non-stock items) and dated tax settings. */

describe("S15 — catalog and tax", () => {
  let db: TestDatabase;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  const get = (path: string, token: string) => new Request(`${BASE}${path}`, { headers: cookie(token) });
  const post = (path: string, token: string, body: unknown) =>
    new Request(`${BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...cookie(token) },
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    handlers = createHandlers(db.app);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["storekeeper", ["store_keeper"]],
      ["tech", ["technician"]],
      ["accountant", ["accountant"]],
    ] as const) {
      const user = await makeUser(db.app, [...roles], name);
      const response = await handlers.login(
        new Request(`${BASE}/api/auth/login`, {
          method: "POST",
          body: new URLSearchParams({ username: user.username, password: TEST_PASSWORD, locale: "en" }),
        }),
      );
      const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(response.headers.get("set-cookie") ?? "");
      people[name] = { userId: user.userId, roles: [...roles], token: decodeURIComponent(match?.[1] ?? "") };
    }
    // A standard-category code for the items below (values are the partner's, entered here as test data).
    await createTaxCode(
      db.app,
      people.partner!,
      {
        code: "STD",
        labelEn: "Standard",
        labelAr: "قياسي",
        category: "standard",
        rate: "5",
        effectiveFrom: "2026-01-01",
      },
      randomUUID(),
    );
  });
  afterAll(async () => {
    await db?.destroy();
  });

  let counter = 0;
  const code = (prefix: string) => `${prefix}-${++counter}`;
  const labor = (overrides: Record<string, unknown> = {}) =>
    createItem(
      db.app,
      people.manager!,
      {
        kind: "labor_rate",
        code: code("LAB"),
        nameEn: "General labour",
        nameAr: "عمالة عامة",
        price: "150.00",
        taxCode: "STD",
        ...overrides,
      },
      randomUUID(),
    );

  // --- Items --------------------------------------------------------------------------------

  it("creates labor rates, packages, stock parts and non-stock items with a first price", async () => {
    const rate = (await labor()).result.itemId;
    const pkg = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "package",
          code: code("PKG"),
          nameEn: "Minor service",
          nameAr: "صيانة صغرى",
          price: "399",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;
    const part = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "part",
          code: code("PRT"),
          nameEn: "Oil filter",
          nameAr: "فلتر زيت",
          partNo: "90915-YZZE1",
          brand: "Toyota",
          partType: "oem",
          unit: "piece",
          stockTracked: true,
          price: "45.50",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;
    const sublet = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "part",
          code: code("SUB"),
          nameEn: "Cylinder head machining",
          nameAr: "خراطة رأس السلندر",
          unit: "job",
          price: "600",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;

    expect(await getCatalogueItem(db.app, rate)).toMatchObject({
      kind: "labor_rate",
      price: "150.00",
      stockTracked: false,
      unit: null,
    });
    expect(await getCatalogueItem(db.app, pkg)).toMatchObject({ kind: "package", price: "399.00" });
    expect(await getCatalogueItem(db.app, part)).toMatchObject({
      kind: "part",
      stockTracked: true,
      partType: "oem",
      price: "45.50",
    });
    expect(await getCatalogueItem(db.app, sublet)).toMatchObject({
      kind: "part",
      stockTracked: false,
      unit: "job",
    });
    expect((await listCatalogue(db.app, { kind: "part" })).map((item) => item.id)).toEqual(
      expect.arrayContaining([part, sublet]),
    );
  });

  it("validates kind, code, names, part unit, price and tax code", async () => {
    const attempt = (overrides: Record<string, unknown>) => labor(overrides);
    await expect(attempt({ kind: "service" })).rejects.toMatchObject({ details: { field: "kind" } });
    await expect(attempt({ code: "has space" })).rejects.toMatchObject({ details: { field: "code" } });
    await expect(attempt({ nameAr: " " })).rejects.toMatchObject({ details: { field: "nameAr" } });
    await expect(attempt({ kind: "part" })).rejects.toMatchObject({ details: { field: "unit" } });
    for (const price of ["-1", "12.345", "abc", ""]) {
      await expect(attempt({ price })).rejects.toMatchObject({ details: { field: "price" } });
    }
    await expect(attempt({ taxCode: "NOPE" })).rejects.toMatchObject({ details: { field: "taxCode" } });
    const { itemId } = (await labor({ code: "DUP-1" })).result;
    expect(itemId).toBeTruthy();
    await expect(labor({ code: "DUP-1" })).rejects.toMatchObject({ code: "item_code_taken" });
  });

  it("a price change adds history, audits before/after, and priceAt answers for any instant (basis for AC2-12)", async () => {
    const { itemId } = (await labor({ price: "150" })).result;
    // JS times have millisecond precision, the database's microseconds: step clear of both prices.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeChange = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await setPrice(db.app, people.manager!, itemId, { price: "175.00", taxCode: "STD" }, randomUUID());

    const item = await getCatalogueItem(db.app, itemId);
    expect(item!.history.map((row) => row.price)).toEqual(["175.00", "150.00"]);
    expect((await priceAt(db.app, itemId, beforeChange))!.price).toBe("150.00");
    expect((await priceAt(db.app, itemId, new Date()))!.price).toBe("175.00");

    const audit = await db.app
      .selectFrom("audit_event")
      .select(["before_state", "after_state"])
      .where("action", "=", "catalogue.price_changed")
      .where("entity_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ before_state: { price: "150.00" }, after_state: { price: "175.00" } });
    await expect(
      setPrice(db.app, people.manager!, itemId, { price: "175", taxCode: "STD" }, randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "price" },
    });
  });

  it("simultaneous price changes on one item wait for each other (the item lock)", async () => {
    const { itemId } = (await labor({ price: "100" })).result;
    // Hold the item's row lock from outside while two changes arrive; they must queue behind it.
    const pg = (await import("pg")).default;
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM catalogue_item WHERE id = $1 FOR UPDATE", [itemId]);
      const same = [
        setPrice(db.app, people.manager!, itemId, { price: "120.00", taxCode: "STD" }, randomUUID()),
        setPrice(db.app, people.manager!, itemId, { price: "120.00", taxCode: "STD" }, randomUUID()),
      ].map((attempt) =>
        attempt.then(
          () => "ok",
          (error: unknown) => error,
        ),
      );
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const outcomes = await Promise.all(same);
      // With the lock the second sees the first and is told the price is already current; without it
      // both would read 100.00 and both would insert 120.00.
      expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome !== "ok")).toMatchObject({ details: { field: "price" } });
    } finally {
      await holder.end();
    }
    const audits = await db.app
      .selectFrom("audit_event")
      .select(["before_state", "after_state"])
      .where("action", "=", "catalogue.price_changed")
      .where("entity_id", "=", itemId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ before_state: { price: "100.00" }, after_state: { price: "120.00" } });
  });

  it("a price row inserted by a transaction that began earlier still counts as the newer price", async () => {
    const { itemId } = (await labor({ price: "100" })).result;
    // A transaction begins (its now() is fixed here), a full price change happens meanwhile, then the
    // first one inserts and commits last: its row must be the current price.
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: db.appUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT now()");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await setPrice(db.app, people.manager!, itemId, { price: "120.00", taxCode: "STD" }, randomUUID());
      await client.query("INSERT INTO catalogue_price (item_id, price, tax_code) VALUES ($1, 130, 'STD')", [
        itemId,
      ]);
      await client.query("COMMIT");
    } finally {
      await client.end();
    }
    expect((await getCatalogueItem(db.app, itemId))!.price).toBe("130.00");
  });

  it("details can change (audited); kind, code and stock flag cannot; items can be deactivated", async () => {
    const { itemId } = (await labor()).result;
    await updateItemDetails(db.app, people.manager!, itemId, {
      nameEn: "Electrical labour",
      nameAr: "عمالة كهرباء",
    });
    expect((await getCatalogueItem(db.app, itemId))!.nameEn).toBe("Electrical labour");
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["before_state", "after_state"])
      .where("action", "=", "catalogue.item_updated")
      .where("entity_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      before_state: { name_en: "General labour" },
      after_state: { name_en: "Electrical labour" },
    });

    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE catalogue_item SET kind = 'part' WHERE id = '${itemId}'`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE catalogue_item SET stock_tracked = true WHERE id = '${itemId}'`))
        ?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE catalogue_item SET code = 'X' WHERE id = '${itemId}'`))?.code,
    ).toBe("42501");

    await setItemActive(db.app, people.manager!, itemId, false);
    expect((await listCatalogue(db.app, { kind: "labor_rate" })).map((item) => item.id)).not.toContain(
      itemId,
    );
    expect(
      (await listCatalogue(db.app, { kind: "labor_rate", includeInactive: true })).map((item) => item.id),
    ).toContain(itemId);
  });

  it("price history is insert-only for the app role, with the database's own time", async () => {
    const { itemId } = (await labor()).result;
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE catalogue_price SET price = 1 WHERE item_id = '${itemId}'`))?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `DELETE FROM catalogue_price WHERE item_id = '${itemId}'`))?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM catalogue_item WHERE id = '${itemId}'`))?.code).toBe(
      "42501",
    );
    // A back-dated price is stamped with the real time instead.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO catalogue_price (item_id, price, tax_code, effective_from) VALUES ('${itemId}', 1, 'STD', '2000-01-01')`,
        )
      )?.code,
    ).toBeUndefined();
    expect(await priceAt(db.app, itemId, new Date("2001-01-01"))).toBeNull();
    for (const table of ["tax_profile", "tax_code_rate"]) {
      expect((await sqlErrorAs(db.appUrl, `UPDATE ${table} SET effective_from = '2000-01-01'`))?.code).toBe(
        "42501",
      );
      expect((await sqlErrorAs(db.appUrl, `DELETE FROM ${table}`))?.code).toBe("42501");
    }
  });

  // --- Tax settings ----------------------------------------------------------------------------

  it("tax profiles are dated history; registered needs a 15-digit TRN; both modes are kept (basis for AC2-19)", async () => {
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "not_registered", effectiveFrom: "2026-01-01" },
      randomUUID(),
    );
    await expect(
      addTaxProfile(
        db.app,
        people.partner!,
        { registrationStatus: "registered", trn: "12345", effectiveFrom: "2026-11-01" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { field: "trn" } });
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "registered", trn: "100 123 456 700 003", effectiveFrom: "2026-11-01" },
      randomUUID(),
    );
    expect(await taxProfileOn(db.app, "2025-12-31")).toBeNull();
    expect(await taxProfileOn(db.app, "2026-10-31")).toMatchObject({
      registrationStatus: "not_registered",
      trn: null,
    });
    expect(await taxProfileOn(db.app, "2026-11-01")).toMatchObject({
      registrationStatus: "registered",
      trn: "100123456700003",
    });
    await expect(
      addTaxProfile(
        db.app,
        people.partner!,
        { registrationStatus: "not_registered", effectiveFrom: "2026-11-01" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "tax_date_not_after_latest" });
    // OD-16: never before the latest profile, even when the date is free.
    await expect(
      addTaxProfile(
        db.app,
        people.partner!,
        { registrationStatus: "not_registered", effectiveFrom: "2026-05-01" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "tax_date_not_after_latest" });
    expect(await taxProfileOn(db.app, "2026-06-01")).toMatchObject({ registrationStatus: "not_registered" });
    // The database refuses it too (as the app role, bypassing the command).
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          "INSERT INTO tax_profile (registration_status, effective_from) VALUES ('not_registered', '2026-05-02')",
        )
      )?.code,
    ).toBe("23514");
    await expect(
      addTaxProfile(
        db.app,
        people.partner!,
        { registrationStatus: "not_registered", effectiveFrom: "2026-02-30" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { field: "effectiveFrom" } });
  });

  it("tax code rates are dated history", async () => {
    await createTaxCode(
      db.app,
      people.partner!,
      {
        code: "ZR",
        labelEn: "Zero-rated",
        labelAr: "نسبة صفرية",
        category: "zero_rated",
        rate: "0",
        effectiveFrom: "2026-01-01",
      },
      randomUUID(),
    );
    await setTaxCodeRate(
      db.app,
      people.partner!,
      "STD",
      { rate: "7.5", effectiveFrom: "2027-01-01" },
      randomUUID(),
    );
    expect(await taxCodeRateOn(db.app, "STD", "2026-12-31")).toBe("5.00");
    expect(await taxCodeRateOn(db.app, "STD", "2027-01-01")).toBe("7.50");
    expect(await taxCodeRateOn(db.app, "ZR", "2026-06-01")).toBe("0.00");
    await expect(
      setTaxCodeRate(
        db.app,
        people.partner!,
        "STD",
        { rate: "101", effectiveFrom: "2028-01-01" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({
      details: { field: "rate" },
    });
    await expect(
      setTaxCodeRate(
        db.app,
        people.partner!,
        "STD",
        { rate: "5", effectiveFrom: "2027-01-01" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "tax_date_not_after_latest" });
    await expect(
      setTaxCodeRate(
        db.app,
        people.partner!,
        "STD",
        { rate: "6", effectiveFrom: "2026-06-01" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "tax_date_not_after_latest" });
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          "INSERT INTO tax_code_rate (code, rate, effective_from) VALUES ('STD', 0, '2000-01-01')",
        )
      )?.code,
    ).toBe("23514");
    await expect(
      createTaxCode(
        db.app,
        people.partner!,
        {
          code: "X",
          labelEn: "x",
          labelAr: "x",
          category: "luxury",
          rate: "1",
          effectiveFrom: "2026-01-01",
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { field: "category" } });
  });

  // --- Authorization ---------------------------------------------------------------------------

  it("advisors and store keepers read prices, technicians see none, managers price, only partners touch tax", async () => {
    const { itemId } = (await labor()).result;
    expect(
      (await handlers.listCatalogue(get("/api/catalogue?kind=labor_rate", people.advisor!.token))).status,
    ).toBe(200);
    expect(
      (await handlers.getCatalogueItem(get(`/api/catalogue/${itemId}`, people.storekeeper!.token), itemId))
        .status,
    ).toBe(200);
    expect(
      (await handlers.listCatalogue(get("/api/catalogue?kind=labor_rate", people.tech!.token))).status,
    ).toBe(403);

    for (const who of ["advisor", "storekeeper", "tech"] as const) {
      const response = await handlers.setCataloguePrice(
        post(`/api/catalogue/${itemId}/price`, people[who]!.token, {
          price: "1",
          taxCode: "STD",
          idempotencyKey: randomUUID(),
        }),
        itemId,
      );
      expect({ who, status: response.status }).toEqual({ who, status: 403 });
    }
    const byManager = await handlers.setCataloguePrice(
      post(`/api/catalogue/${itemId}/price`, people.manager!.token, {
        price: "199",
        taxCode: "STD",
        idempotencyKey: randomUUID(),
      }),
      itemId,
    );
    expect(byManager.status).toBe(201);

    const profile = {
      registrationStatus: "not_registered",
      effectiveFrom: "2030-01-01",
      idempotencyKey: randomUUID(),
    };
    expect(
      (await handlers.addTaxProfile(post("/api/tax/profiles", people.manager!.token, profile))).status,
    ).toBe(403);
    expect((await handlers.getTaxSettings(get("/api/tax", people.manager!.token))).status).toBe(403);
    expect(
      (await handlers.addTaxProfile(post("/api/tax/profiles", people.partner!.token, profile))).status,
    ).toBe(201);
  });

  it("creating an item twice with the same key replays it", async () => {
    const key = randomUUID();
    const input = {
      kind: "package",
      code: code("RPL"),
      nameEn: "AC service",
      nameAr: "صيانة التكييف",
      price: "250",
      taxCode: "STD",
    };
    const first = await createItem(db.app, people.manager!, input, key);
    const again = await createItem(db.app, people.manager!, input, key);
    expect(again).toMatchObject({ replayed: true, result: first.result });
  });

  // --- Review fixes ----------------------------------------------------------------------------

  it("a price too large for the column is a validation error, not a server error", async () => {
    await expect(labor({ price: "9999999999999" })).rejects.toMatchObject({ details: { field: "price" } });
    await expect(labor({ price: "999999999999.99" })).resolves.toMatchObject({ replayed: false });
  });

  it("priceAt returns the price row id, for estimates to store", async () => {
    const { itemId } = (await labor({ price: "80" })).result;
    const found = await priceAt(db.app, itemId, new Date(Date.now() + 1000));
    const row = await db.app
      .selectFrom("catalogue_price")
      .select("id")
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(found).toMatchObject({ priceId: row.id, price: "80.00" });
  });

  it("tax settings and prices replay on a repeated key", async () => {
    const profileKey = randomUUID();
    const profile = { registrationStatus: "registered", trn: "100123456700003", effectiveFrom: "2031-01-01" };
    const first = await addTaxProfile(db.app, people.partner!, profile, profileKey);
    expect(await addTaxProfile(db.app, people.partner!, profile, profileKey)).toMatchObject({
      replayed: true,
      result: first.result,
    });

    const codeKey = randomUUID();
    const code = {
      code: "RPLT",
      labelEn: "Replay",
      labelAr: "إعادة",
      category: "standard",
      rate: "5",
      effectiveFrom: "2026-01-01",
    };
    await createTaxCode(db.app, people.partner!, code, codeKey);
    expect(await createTaxCode(db.app, people.partner!, code, codeKey)).toMatchObject({ replayed: true });

    const { itemId } = (await labor({ price: "90" })).result;
    const priceKey = randomUUID();
    await setPrice(db.app, people.manager!, itemId, { price: "95", taxCode: "STD" }, priceKey);
    expect(
      await setPrice(db.app, people.manager!, itemId, { price: "95", taxCode: "STD" }, priceKey),
    ).toMatchObject({ replayed: true });
    expect((await getCatalogueItem(db.app, itemId))!.history).toHaveLength(2);
  });

  it("tax codes keep their labels and creation time for the app role", async () => {
    expect((await sqlErrorAs(db.appUrl, "UPDATE tax_code SET label_en = 'x' WHERE code = 'STD'"))?.code).toBe(
      "42501",
    );
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          "INSERT INTO tax_code (code, label_en, label_ar, category, created_at) VALUES ('FORGED', 'x', 'x', 'exempt', '2000-01-01')",
        )
      )?.code,
    ).toBeUndefined();
    const row = await db.app
      .selectFrom("tax_code")
      .select("created_at")
      .where("code", "=", "FORGED")
      .executeTakeFirstOrThrow();
    expect(row.created_at.getFullYear()).toBeGreaterThan(2020);
  });

  it("the remaining authorization cases: creating items, technician item reads, accountants, tax for managers", async () => {
    const { itemId } = (await labor()).result;
    const newItem = {
      kind: "labor_rate",
      code: code("AUTH"),
      nameEn: "x",
      nameAr: "x",
      price: "1",
      taxCode: "STD",
      idempotencyKey: randomUUID(),
    };
    for (const who of ["advisor", "tech", "accountant", "storekeeper"] as const) {
      const response = await handlers.createCatalogueItem(
        post("/api/catalogue", people[who]!.token, newItem),
      );
      expect({ who, status: response.status }).toEqual({ who, status: 403 });
    }
    expect(
      (await handlers.getCatalogueItem(get(`/api/catalogue/${itemId}`, people.tech!.token), itemId)).status,
    ).toBe(403);
    expect(
      (await handlers.getCatalogueItem(get(`/api/catalogue/${itemId}`, people.accountant!.token), itemId))
        .status,
    ).toBe(200);
    // Tax codes and rates are only reachable through partner-only actions (T-15).
    const { hasPermission } = await import("../src/server/auth/permissions");
    expect(
      ["partner", "manager", "service_advisor", "store_keeper", "accountant", "technician"].filter((role) =>
        hasPermission([role], "tax.manage"),
      ),
    ).toEqual(["partner"]);
  });
});
