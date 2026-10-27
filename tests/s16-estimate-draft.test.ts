import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem, setPrice } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { Money, Qty } from "../src/server/core/money";
import { createCustomer } from "../src/server/customer/service";
import {
  addJob,
  addLine,
  excludeUrgentFinding,
  openEstimate,
  removeJob,
  removeLine,
  setLineDiscount,
  updateLineQty,
  type Staff,
} from "../src/server/estimate/commands";
import { computeLine, sumLines } from "../src/server/estimate/pricing";
import { estimateView } from "../src/server/estimate/queries";
import { createHandlers } from "../src/server/http/handlers";
import { recordFinding, updateFinding, withdrawFinding } from "../src/server/inspection/commands";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/** I1-05a — estimate draft: jobs, lines, totals (AC-06.1, OD-18), AC-05.2, AC2-12 (line keeps its price), OD-19. */

describe("S16 — estimate draft", () => {
  let db: TestDatabase;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
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
      ["tech", ["technician"]],
      ["storekeeper", ["store_keeper"]],
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
    // Test data entered as a partner would (OD-13): a 5% code and an unusual 12.5% one for rounding.
    for (const [code, rate] of [
      ["STD", "5"],
      ["ODD", "12.5"],
    ] as const) {
      await createTaxCode(
        db.app,
        people.partner!,
        { code, labelEn: code, labelAr: code, category: "standard", rate, effectiveFrom: "2026-01-01" },
        randomUUID(),
      );
    }
    const item = async (kind: string, code: string, price: string, taxCode = "STD", unit?: string) =>
      (
        await createItem(
          db.app,
          people.manager!,
          { kind, code, nameEn: `${code} EN`, nameAr: `${code} AR`, price, taxCode, unit },
          randomUUID(),
        )
      ).result.itemId;
    items.labor = await item("labor_rate", "LAB-1", "150.00");
    items.pkg = await item("package", "PKG-1", "399.00");
    items.part = await item("part", "PRT-1", "12.35", "STD", "piece");
    items.odd = await item("part", "PRT-ODD", "10.01", "ODD", "piece");
  });
  afterAll(async () => {
    await db?.destroy();
  });

  let counter = 0;
  async function newRepairOrder(): Promise<string> {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Estimate Customer ${counter}`,
          mobile: `0546${String(counter).padStart(6, "0")}`,
          preferredLanguage: "en",
          marketingConsent: false,
        },
        randomUUID(),
      )
    ).result.customerId;
    const vehicleId = (
      await createVehicle(
        db.app,
        advisor,
        {
          make: "Nissan",
          model: "Patrol",
          year: 2019,
          plate: { emirate: "sharjah", code: "ES", number: String(40000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 90000,
      concerns: "Brakes squeal",
      photoShortfallReason: "Test fixture",
    });
    return (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
  }

  const finding = async (ro: string, title: string, severity: string) =>
    (await recordFinding(db.app, people.advisor!, ro, { title, severity }, randomUUID())).result.findingId;

  const today = async () =>
    (
      await sql<{
        d: string;
      }>`SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS d`.execute(db.app)
    ).rows[0]!.d;

  /** A draft with one empty job; returns the repair order and job ids. */
  async function draftWithJob(): Promise<{ ro: string; jobId: string }> {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const { jobId } = (await addJob(db.app, people.advisor!, ro, { title: "Front brakes" }, randomUUID()))
      .result;
    return { ro, jobId };
  }

  const line = (jobId: string, itemId: string, qty: string, staff = people.advisor!) =>
    addLine(db.app, staff, jobId, { itemId, qty }, randomUUID()).then((outcome) => outcome.result.lineId);

  // --- Arithmetic (OD-18) --------------------------------------------------------------------

  it("splits VAT out of the quoted amount per line, to the fil (OD-18, AC-06.1)", () => {
    const at = (qty: string, price: string, discount: string, rate: string) => {
      const amounts = computeLine({
        qty: Qty.parse(qty),
        unitPrice: Money.parse(price),
        discount: Money.parse(discount),
        rate,
      });
      return [amounts.gross, amounts.total, amounts.net, amounts.vat].map(String);
    };
    expect(at("1", "105.00", "0", "5.00")).toEqual(["105.00", "105.00", "100.00", "5.00"]);
    expect(at("1", "10.01", "0", "5.00")).toEqual(["10.01", "10.01", "9.53", "0.48"]);
    expect(at("1.5", "150.00", "20.00", "5.00")).toEqual(["225.00", "205.00", "195.24", "9.76"]);
    // Quantity × price rounds half-up to the fil; so does the net (0.005 → 0.01).
    expect(at("0.005", "1.00", "0", "0.00")).toEqual(["0.01", "0.01", "0.01", "0.00"]);
    expect(at("1", "0.01", "0", "100.00")).toEqual(["0.01", "0.01", "0.01", "0.00"]);
    expect(at("3", "10.01", "0", "12.50")).toEqual(["30.03", "30.03", "26.69", "3.34"]);
    // Net + VAT always equals what was quoted.
    for (const total of ["0.01", "0.99", "1.05", "33.33", "999.99", "12345.67"]) {
      const [, quoted, net, vat] = at("1", total, "0", "5.00");
      expect(Money.parse(net!).add(Money.parse(vat!)).toString()).toBe(quoted);
    }
    expect(() => at("1", "10.00", "10.01", "5.00")).toThrow(/discount/);
  });

  it("totals are sums of the rounded lines, with VAT per rate", () => {
    const lines = [
      {
        ...computeLine({
          qty: Qty.parse("1"),
          unitPrice: Money.parse("10.01"),
          discount: Money.ZERO,
          rate: "5.00",
        }),
        rate: "5.00",
      },
      {
        ...computeLine({
          qty: Qty.parse("1"),
          unitPrice: Money.parse("10.01"),
          discount: Money.ZERO,
          rate: "5.00",
        }),
        rate: "5.00",
      },
      {
        ...computeLine({
          qty: Qty.parse("1"),
          unitPrice: Money.parse("10.01"),
          discount: Money.ZERO,
          rate: "12.50",
        }),
        rate: "12.50",
      },
    ];
    const totals = sumLines(lines);
    expect(totals.total.toString()).toBe("30.03");
    expect(totals.net.toString()).toBe("27.96"); // 9.53 + 9.53 + 8.90
    expect(totals.vat.toString()).toBe("2.07");
    expect(totals.byRate.map((r) => [r.rate, r.net.toString(), r.vat.toString()])).toEqual([
      ["5.00", "19.06", "0.96"],
      ["12.50", "8.90", "1.11"],
    ]);
  });

  // --- Tax profile -------------------------------------------------------------------------

  it("refuses to start an estimate while no tax profile is in force", async () => {
    const ro = await newRepairOrder();
    await expect(openEstimate(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "no_tax_profile",
    });
    expect(await estimateView(db.app, ro)).toBeNull();

    // Not registered from January: lines carry no VAT.
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "not_registered", effectiveFrom: "2026-01-01" },
      randomUUID(),
    );
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const { jobId } = (await addJob(db.app, people.advisor!, ro, { title: "Service" }, randomUUID())).result;
    await line(jobId, items.pkg!, "1");
    const view = (await estimateView(db.app, ro))!;
    expect(view.jobs[0]!.lines[0]).toMatchObject({
      total: "399.00",
      net: "399.00",
      vat: "0.00",
      taxRate: "0.00",
    });

    // Registered from today (OD-13); the rest of this file prices with VAT.
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "registered", trn: "100000000000003", effectiveFrom: await today() },
      randomUUID(),
    );
  });

  // --- Lines and totals --------------------------------------------------------------------

  it("prices lines from the catalogue and totals them to the fil (AC-06.1)", async () => {
    const { ro, jobId } = await draftWithJob();
    const labor = await line(jobId, items.labor!, "1.5");
    await line(jobId, items.part!, "3");
    await line(jobId, items.pkg!, "1");
    await setLineDiscount(db.app, people.manager!, labor, { discount: "20" }, randomUUID());

    const view = (await estimateView(db.app, ro))!;
    const lines = view.jobs[0]!.lines;
    expect(lines.map((l) => [l.lineType, l.unit, l.qty, l.unitPrice, l.gross, l.discount, l.total])).toEqual([
      ["labor", "hour", "1.500", "150.00", "225.00", "20.00", "205.00"],
      ["part", "piece", "3.000", "12.35", "37.05", "0.00", "37.05"],
      ["package", null, "1.000", "399.00", "399.00", "0.00", "399.00"],
    ]);
    // Net per line: 195.24, 35.29, 380.00 → VAT 9.76, 1.76, 19.00.
    expect(view.totals).toEqual({
      gross: "661.05",
      discount: "20.00",
      total: "641.05",
      net: "610.53",
      vat: "30.52",
      byRate: [{ rate: "5.00", net: "610.53", vat: "30.52" }],
    });
    expect(view.jobs[0]!.total).toBe("641.05");

    // Quantity change keeps the discount and recomputes; a removed line leaves the totals.
    await updateLineQty(db.app, people.advisor!, labor, { qty: "2" }, randomUUID());
    await removeLine(db.app, people.advisor!, lines[2]!.id, randomUUID());
    const after = (await estimateView(db.app, ro))!;
    expect(after.jobs[0]!.lines.map((l) => l.total)).toEqual(["280.00", "37.05"]);
    expect(after.totals.total).toBe("317.05");
    // A quantity that would push the line below its discount is refused.
    await setLineDiscount(db.app, people.manager!, labor, { discount: "250" }, randomUUID());
    await expect(
      updateLineQty(db.app, people.advisor!, labor, { qty: "1" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("the database checks the same arithmetic on every line, at any rate", async () => {
    const { ro, jobId } = await draftWithJob();
    const odd = await line(jobId, items.odd!, "3");
    expect((await estimateView(db.app, ro))!.jobs[0]!.lines[0]).toMatchObject({
      total: "30.03",
      net: "26.69",
      vat: "3.34",
      taxRate: "12.50",
    });
    const forged = await sqlErrorAs(
      db.appUrl,
      `UPDATE revision_line SET net = net + 0.01, vat = vat - 0.01 WHERE id = '${odd}'`,
    );
    expect(forged?.code).toBe("23514");
    const total = await sqlErrorAs(
      db.appUrl,
      `UPDATE revision_line SET line_total = line_total + 1 WHERE id = '${odd}'`,
    );
    expect(total?.code).toBe("23514");
  });

  it("a line keeps the price it was added at; later lines use the new price (AC2-12, T-18)", async () => {
    const { ro, jobId } = await draftWithJob();
    const item = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "labor_rate",
          code: "LAB-AC12",
          nameEn: "AC labour",
          nameAr: "عمالة مكيف",
          price: "200.00",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;
    const first = await line(jobId, item, "1");
    await setPrice(db.app, people.manager!, item, { price: "250.00", taxCode: "STD" }, randomUUID());
    const second = await line(jobId, item, "1");

    const rows = await db.app
      .selectFrom("revision_line")
      .innerJoin("catalogue_price", "catalogue_price.id", "revision_line.catalogue_price_id")
      .select(["revision_line.id", "revision_line.unit_price", "catalogue_price.price"])
      .where("revision_line.id", "in", [first, second])
      .execute();
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[first]).toMatchObject({ unit_price: "200.00", price: "200.00" });
    expect(byId[second]).toMatchObject({ unit_price: "250.00", price: "250.00" });
    expect((await estimateView(db.app, ro))!.totals.total).toBe("450.00");
    // The price cannot be rewritten on the line itself.
    const err = await sqlErrorAs(
      db.appUrl,
      `UPDATE revision_line SET unit_price = 250 WHERE id = '${first}'`,
    );
    expect(err).not.toBeNull();
  });

  it("refuses inactive items, unknown items and bad quantities", async () => {
    const { jobId } = await draftWithJob();
    await expect(line(jobId, randomUUID(), "1")).rejects.toMatchObject({ code: "validation_failed" });
    for (const qty of ["0", "-1", "1.0001", "abc", ""]) {
      await expect(line(jobId, items.part!, qty)).rejects.toMatchObject({ details: { field: "qty" } });
    }
  });

  // --- Urgent findings (AC-05.2) -----------------------------------------------------------

  it("pre-selects urgent findings; leaving one out needs a reason (AC-05.2)", async () => {
    const ro = await newRepairOrder();
    const pads = await finding(ro, "Brake pads at 2 mm", "urgent");
    const wipers = await finding(ro, "Wiper blades worn", "soon");
    await openEstimate(db.app, people.advisor!, ro, randomUUID());

    let view = (await estimateView(db.app, ro))!;
    expect(view.jobs.map((job) => [job.title, job.findingId, job.findingSeverity])).toEqual([
      ["Brake pads at 2 mm", pads, "urgent"],
    ]);
    expect(view.urgentFindings).toEqual([
      { findingId: pads, title: "Brake pads at 2 mm", state: "included", reason: null, reofferJobId: null },
    ]);
    expect(view.otherFindings).toEqual([{ findingId: wipers, title: "Wiper blades worn", severity: "soon" }]);

    const padsJob = view.jobs[0]!.id;
    await expect(removeJob(db.app, people.advisor!, padsJob, {}, randomUUID())).rejects.toMatchObject({
      details: { field: "reason" },
    });
    await removeJob(
      db.app,
      people.advisor!,
      padsJob,
      { reason: "Customer will replace at dealer" },
      randomUUID(),
    );
    view = (await estimateView(db.app, ro))!;
    expect(view.jobs).toEqual([]);
    expect(view.urgentFindings[0]).toMatchObject({
      state: "excluded",
      reason: "Customer will replace at dealer",
    });

    // Including it again clears the exclusion.
    await addJob(db.app, people.advisor!, ro, { findingId: pads }, randomUUID());
    view = (await estimateView(db.app, ro))!;
    expect(view.urgentFindings[0]).toMatchObject({ state: "included", reason: null });
    await expect(
      addJob(db.app, people.advisor!, ro, { findingId: pads }, randomUUID()),
    ).rejects.toMatchObject({
      code: "finding_already_included",
    });

    // An optional finding becomes a job on request; removing it needs no reason.
    const { jobId } = (await addJob(db.app, people.advisor!, ro, { findingId: wipers }, randomUUID())).result;
    expect((await estimateView(db.app, ro))!.otherFindings).toEqual([]);
    await removeJob(db.app, people.advisor!, jobId, {}, randomUUID());

    const audit = await db.app
      .selectFrom("audit_event")
      .select(["action", "details"])
      .where("entity_id", "=", padsJob)
      .where("action", "=", "estimate.job_removed")
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({
      urgentFindingExcluded: pads,
      reason: "Customer will replace at dealer",
    });
  });

  it("an urgent finding recorded or raised to urgent while the draft is open joins it as a job (OD-23)", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const late = await finding(ro, "Coolant leak", "urgent");
    const soon = await finding(ro, "Tyres wearing", "soon");
    let view = (await estimateView(db.app, ro))!;
    expect(view.jobs.map((job) => job.findingId)).toEqual([late]);
    expect(view.urgentFindings).toEqual([
      { findingId: late, title: "Coolant leak", state: "included", reason: null, reofferJobId: null },
    ]);

    // A technician's edit raises a finding to urgent: it joins too (the technician sees no prices; the job has none).
    await updateFinding(db.app, people.advisor!, soon, {
      title: "Tyres worn to the cords",
      severity: "urgent",
    });
    view = (await estimateView(db.app, ro))!;
    expect(view.jobs.map((job) => [job.findingId, job.title])).toEqual([
      [late, "Coolant leak"],
      [soon, "Tyres worn to the cords"],
    ]);
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["details"])
      .where("action", "=", "estimate.job_added")
      .where("entity_id", "=", view.jobs[1]!.id)
      .executeTakeFirstOrThrow();
    expect(audit.details).toEqual({ preselectedUrgentFinding: true });

    // A finding already left out with a reason is not added back behind the advisor's back.
    await removeJob(
      db.app,
      people.advisor!,
      view.jobs[0]!.id,
      { reason: "Customer declined at desk" },
      randomUUID(),
    );
    await updateFinding(db.app, people.advisor!, late, {
      title: "Coolant leak at the pump",
      severity: "urgent",
    });
    expect((await estimateView(db.app, ro))!.urgentFindings.find((u) => u.findingId === late)).toMatchObject({
      state: "excluded",
    });
  });

  it("an urgent finding without a job can be left out only with a reason (AC-05.2)", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    // Set-up only: a finding that reached the table without the inspection command (so it has no job).
    const late = (
      await db.owner
        .insertInto("finding")
        .values({ repair_order_id: ro, title: "Brake fluid leak", severity: "urgent" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    expect((await estimateView(db.app, ro))!.urgentFindings).toEqual([
      { findingId: late, title: "Brake fluid leak", state: "open", reason: null, reofferJobId: null },
    ]);
    await expect(
      excludeUrgentFinding(db.app, people.advisor!, ro, { findingId: late, reason: " " }, randomUUID()),
    ).rejects.toMatchObject({ details: { field: "reason" } });
    await excludeUrgentFinding(
      db.app,
      people.advisor!,
      ro,
      { findingId: late, reason: "Customer declined" },
      randomUUID(),
    );
    expect((await estimateView(db.app, ro))!.urgentFindings[0]).toMatchObject({ state: "excluded" });
    await expect(
      excludeUrgentFinding(db.app, people.advisor!, ro, { findingId: late, reason: "again" }, randomUUID()),
    ).rejects.toMatchObject({ code: "finding_already_excluded" });
    // Only urgent findings are excluded this way.
    const soon = await finding(ro, "Wipers worn", "soon");
    await expect(
      excludeUrgentFinding(db.app, people.advisor!, ro, { findingId: soon, reason: "n/a" }, randomUUID()),
    ).rejects.toMatchObject({ code: "validation_failed" });

    // Including it again clears the exclusion and says so in the audit log.
    const { jobId } = (await addJob(db.app, people.advisor!, ro, { findingId: late }, randomUUID())).result;
    const audit = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("entity_id", "=", jobId)
      .where("action", "=", "estimate.job_added")
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ clearedExclusion: { reason: "Customer declined" } });
  });

  it("a finding with a job in the draft cannot be withdrawn until the job is removed (OD-24)", async () => {
    const ro = await newRepairOrder();
    const pads = await finding(ro, "Pads at 1 mm", "urgent");
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    await expect(withdrawFinding(db.app, people.advisor!, pads, "Recorded twice")).rejects.toMatchObject({
      code: "finding_in_estimate",
    });
    // The database refuses too.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE finding SET status = 'withdrawn', withdrawn_reason = 'x' WHERE id = '${pads}'`,
        )
      )?.code,
    ).toBe("42501");
    const jobId = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await removeJob(db.app, people.advisor!, jobId, { reason: "Recorded twice" }, randomUUID());
    await withdrawFinding(db.app, people.advisor!, pads, "Recorded twice");
  });

  // --- Quantities (OD-22) ------------------------------------------------------------------

  it("only labour hours and parts sold by litre, kg or metre take fractions (OD-22)", async () => {
    const { jobId } = await draftWithJob();
    const litre = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "part",
          code: "OIL-5W30",
          nameEn: "Engine oil",
          nameAr: "زيت محرك",
          price: "30.00",
          taxCode: "STD",
          unit: "litre",
        },
        randomUUID(),
      )
    ).result.itemId;
    await line(jobId, items.labor!, "0.25");
    await line(jobId, litre, "4.5");
    for (const [item, qty] of [
      [items.pkg!, "0.5"],
      [items.part!, "1.5"],
      [items.part!, "0.001"],
    ] as const) {
      await expect(line(jobId, item, qty)).rejects.toMatchObject({
        details: { field: "qty", reason: "whole_number" },
      });
    }
    const piece = await line(jobId, items.part!, "2");
    await expect(
      updateLineQty(db.app, people.advisor!, piece, { qty: "0.5" }, randomUUID()),
    ).rejects.toMatchObject({
      details: { reason: "whole_number" },
    });
    // The database refuses a fractional piece count whatever the code does.
    const forged = await sqlErrorAs(
      db.appUrl,
      `UPDATE revision_line SET qty = 0.5, gross = 6.18, line_total = 6.18, net = 5.89, vat = 0.29 WHERE id = '${piece}'`,
    );
    expect(forged?.code).toBe("23514");
  });

  // --- Permissions -------------------------------------------------------------------------

  it("only managers and partners give discounts (OD-19)", async () => {
    const { jobId } = await draftWithJob();
    const id = await line(jobId, items.labor!, "1");
    await expect(
      setLineDiscount(db.app, people.advisor!, id, { discount: "5" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    const viaHttp = await handlers.setEstimateLineDiscount(
      post(`/api/revision-lines/${id}/discount`, people.advisor!.token, {
        discount: "5",
        idempotencyKey: randomUUID(),
      }),
      id,
    );
    expect(viaHttp.status).toBe(403);
    const partner = await handlers.setEstimateLineDiscount(
      post(`/api/revision-lines/${id}/discount`, people.partner!.token, {
        discount: "5",
        idempotencyKey: randomUUID(),
      }),
      id,
    );
    expect(partner.status).toBe(201);
    await expect(
      setLineDiscount(db.app, people.manager!, id, { discount: "150.01" }, randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "discount" },
    });
    await expect(
      setLineDiscount(db.app, people.manager!, id, { discount: "-1" }, randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "discount" },
    });
  });

  it("technicians and store keepers can neither see nor build estimates (no prices, AC2-30)", async () => {
    const { ro, jobId } = await draftWithJob();
    for (const name of ["tech", "storekeeper"]) {
      const token = people[name]!.token;
      expect((await handlers.getEstimate(get(`/api/repair-orders/${ro}/estimate`, token), ro)).status).toBe(
        403,
      );
      expect(
        (await handlers.openEstimate(post(`/api/repair-orders/${ro}/estimate`, token, {}), ro)).status,
      ).toBe(403);
      const addResponse = await handlers.addEstimateLine(
        post(`/api/repair-jobs/${jobId}/lines`, token, {
          itemId: items.part,
          qty: "1",
          idempotencyKey: randomUUID(),
        }),
        jobId,
      );
      expect(addResponse.status).toBe(403);
      await expect(addJob(db.app, people[name]!, ro, { title: "x" }, randomUUID())).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const denied = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("action", "=", "authz.denied")
      .where("entity_id", "=", ro)
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(4);

    const advisor = await handlers.getEstimate(
      get(`/api/repair-orders/${ro}/estimate`, people.advisor!.token),
      ro,
    );
    expect(advisor.status).toBe(200);
  });

  // --- Draft lifecycle and database guards -------------------------------------------------

  it("one estimate per repair order, even when two advisors start it at once (T-19)", async () => {
    const ro = await newRepairOrder();
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        openEstimate(db.app, people.advisor!, ro, randomUUID()),
        openEstimate(db.app, people.manager!, ro, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "estimate_exists" });
    } finally {
      await holder.end();
    }
  });

  it("replays an add-line with the same key instead of adding twice", async () => {
    const { ro, jobId } = await draftWithJob();
    const key = randomUUID();
    const first = await addLine(db.app, people.advisor!, jobId, { itemId: items.part, qty: "1" }, key);
    const again = await addLine(db.app, people.advisor!, jobId, { itemId: items.part, qty: "1" }, key);
    expect(again.replayed).toBe(true);
    expect(again.result.lineId).toBe(first.result.lineId);
    expect((await estimateView(db.app, ro))!.jobs[0]!.lines).toHaveLength(1);
    await expect(
      addLine(db.app, people.advisor!, jobId, { itemId: items.part, qty: "2" }, key),
    ).rejects.toMatchObject({
      code: "idempotency_payload_mismatch",
    });
  });

  it("nothing changes once the repair order has left Checked-in/Diagnosing", async () => {
    const { ro, jobId } = await draftWithJob();
    const id = await line(jobId, items.part!, "1");
    // Set-up: the repair order has left Checked-in/Diagnosing (cancelled; sending is tested in s17).
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", ro).execute();

    await expect(line(jobId, items.part!, "1")).rejects.toMatchObject({ code: "estimate_closed" });
    await expect(
      updateLineQty(db.app, people.advisor!, id, { qty: "2" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "estimate_closed",
    });
    await expect(removeJob(db.app, people.advisor!, jobId, {}, randomUUID())).rejects.toMatchObject({
      code: "estimate_closed",
    });
    // The database refuses too, whatever the code does.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE revision_line SET qty = 2, gross = 24.70, line_total = 24.70, net = 23.52, vat = 1.18 WHERE id = '${id}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_job SET title = 'x' WHERE id = '${jobId}'`))?.code,
    ).toBe("42501");
  });

  it("the app role cannot delete estimate records or forge their state", async () => {
    const { ro, jobId } = await draftWithJob();
    const id = await line(jobId, items.part!, "1");
    for (const table of [
      "estimate",
      "estimate_version",
      "repair_job",
      "job_revision",
      "revision_line",
      "urgent_finding_exclusion",
    ]) {
      expect((await sqlErrorAs(db.appUrl, `DELETE FROM ${table}`))?.code).toBe("42501");
    }
    // Statuses are not the draft's to change (I1-05b grants sending).
    expect((await sqlErrorAs(db.appUrl, `UPDATE estimate_version SET status = 'sent'`))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `UPDATE job_revision SET status = 'approved'`))?.code).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'authorized' WHERE id = '${jobId}'`,
        )
      )?.code,
    ).toBe("42501");
    // A line cannot claim another item's price row.
    const otherPrice = await db.app
      .selectFrom("catalogue_price")
      .select("id")
      .where("item_id", "=", items.pkg!)
      .executeTakeFirstOrThrow();
    const revision = await db.app
      .selectFrom("revision_line")
      .select("revision_id")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO revision_line (revision_id, line_type, catalogue_item_id, catalogue_price_id, description_en, description_ar,
         qty, unit_price, gross, line_total, net, vat, tax_code, tax_rate)
       VALUES ('${revision.revision_id}', 'part', '${items.part}', '${otherPrice.id}', 'x', 'x', 1, 1.00, 1.00, 1.00, 0.95, 0.05, 'STD', 5)`,
    );
    expect(forged?.code).toBe("42501");
    expect(ro).toBeTruthy();
  });

  it("replays discount and add-job submissions instead of applying them twice", async () => {
    const { ro, jobId } = await draftWithJob();
    const id = await line(jobId, items.labor!, "1");
    const key = randomUUID();
    await setLineDiscount(db.app, people.manager!, id, { discount: "10" }, key);
    const again = await setLineDiscount(db.app, people.manager!, id, { discount: "10" }, key);
    expect(again.replayed).toBe(true);
    const audits = await db.app
      .selectFrom("audit_event")
      .select("seq")
      .where("entity_id", "=", id)
      .where("action", "=", "estimate.line_discount_set")
      .execute();
    expect(audits).toHaveLength(1);

    const jobKey = randomUUID();
    const first = await addJob(db.app, people.advisor!, ro, { title: "Alignment" }, jobKey);
    const second = await addJob(db.app, people.advisor!, ro, { title: "Alignment" }, jobKey);
    expect(second.replayed).toBe(true);
    expect(second.result.jobId).toBe(first.result.jobId);
    expect((await estimateView(db.app, ro))!.jobs.filter((job) => job.title === "Alignment")).toHaveLength(1);

    // Removing a line twice with one key: the retry replays instead of failing.
    const removeKey = randomUUID();
    await removeLine(db.app, people.advisor!, id, removeKey);
    expect((await removeLine(db.app, people.advisor!, id, removeKey)).replayed).toBe(true);
  });

  it("two advisors including the same finding at once: one job (T-19)", async () => {
    const ro = await newRepairOrder();
    const wipers = await finding(ro, "Wiper blades split", "soon");
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        addJob(db.app, people.advisor!, ro, { findingId: wipers }, randomUUID()),
        addJob(db.app, people.manager!, ro, { findingId: wipers }, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "finding_already_included",
      });
    } finally {
      await holder.end();
    }
  });

  it("the database refuses jobs, estimates and lines that bypass the draft rules", async () => {
    // A job for a repair order with no draft estimate.
    const bare = await newRepairOrder();
    expect(
      (await sqlErrorAs(db.appUrl, `INSERT INTO repair_job (repair_order_id, title) VALUES ('${bare}', 'x')`))
        ?.code,
    ).toBe("42501");
    // An estimate for a repair order that has moved on.
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", bare).execute();
    expect(
      (await sqlErrorAs(db.appUrl, `INSERT INTO estimate (repair_order_id) VALUES ('${bare}')`))?.code,
    ).toBe("42501");

    // A line with a made-up tax rate, or with no catalogue price at all.
    const { jobId } = await draftWithJob();
    const id = await line(jobId, items.part!, "1");
    const row = await db.app
      .selectFrom("revision_line")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const insert = (rate: string, net: string, vat: string, priceId: string | null) =>
      sqlErrorAs(
        db.appUrl,
        `INSERT INTO revision_line (revision_id, line_type, catalogue_item_id, catalogue_price_id, description_en, description_ar,
           unit, qty, unit_price, gross, line_total, net, vat, tax_code, tax_rate)
         VALUES ('${row.revision_id}', 'part', '${items.part}', ${priceId ? `'${priceId}'` : "NULL"}, 'x', 'x', 'piece', 1, 12.35,
           12.35, 12.35, ${net}, ${vat}, 'STD', ${rate})`,
      );
    expect((await insert("0", "12.35", "0.00", row.catalogue_price_id))?.code).toBe("42501");
    // The trigger refuses it before the NOT NULL check (23514) is reached.
    expect((await insert("5", "11.76", "0.59", null))?.code).toBe("42501");
    // The same values through the rules are accepted (the forgeries above failed only on their lie).
    expect(await insert("5", "11.76", "0.59", row.catalogue_price_id)).toBeNull();

    // Removal times are the database's, not the caller's.
    await sqlErrorAs(db.appUrl, `UPDATE revision_line SET removed_at = '2020-01-01' WHERE id = '${id}'`);
    const removed = await db.app
      .selectFrom("revision_line")
      .select("removed_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(removed.removed_at!.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
  });
});
