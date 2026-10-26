import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import {
  createInvoiceDraft,
  discardInvoiceDraft,
  invoicePreview,
  issueInvoice,
} from "../src/server/billing/invoice";
import { invoiceView, customerInvoice } from "../src/server/billing/queries";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode, setTaxCodeRate } from "../src/server/catalog/tax";
import { setBusinessProfile } from "../src/server/settings/business-profile";
import { createCustomer } from "../src/server/customer/service";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { createHandlers } from "../src/server/http/handlers";
import { issueFromStock, receiveAndIssue, receiveStock } from "../src/server/inventory/commands";
import { LocalDiskStorage } from "../src/server/media/storage";
import { findNumberGaps } from "../src/server/numbering/numbering";
import { passQc, requestQc } from "../src/server/quality/commands";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { changePlate, createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, startJob } from "../src/server/workshop/commands";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-09a — invoice issue: draft content (T-29), the cap (AC21-02, AC21-04), P0-06 (AT-12) and COGS (T-28), tax on the
 * invoice date (AC2-19, OD-41), numbering (AC2-17, OD-40), immutability (AC2-18), Ready after issue (B1).
 */

describe("S21 — invoice issue", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  const today = async () =>
    (
      await sql<{
        d: string;
      }>`SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS d`.execute(db.app)
    ).rows[0]!.d;

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-invoice-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
      ["store", ["store_keeper"]],
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
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "registered", trn: "100000000000003", effectiveFrom: "2026-01-01" },
      randomUUID(),
    );
    // I1-09b: no invoice without the business profile (OD-47).
    await setBusinessProfile(
      db.app,
      people.partner!,
      {
        legalNameEn: "Test Garage LLC",
        legalNameAr: "كراج الاختبار",
        addressEn: "Sharjah",
        addressAr: "الشارقة",
        phone: "06 555 1234",
      },
      randomUUID(),
    );
    for (const code of ["STD", "CHG"]) {
      await createTaxCode(
        db.app,
        people.partner!,
        { code, labelEn: code, labelAr: code, category: "standard", rate: "5", effectiveFrom: "2026-01-01" },
        randomUUID(),
      );
    }
    const item = async (data: Record<string, unknown>) =>
      (await createItem(db.app, people.manager!, { taxCode: "STD", ...data } as never, randomUUID())).result
        .itemId;
    items.labor = await item({
      kind: "labor_rate",
      code: "LAB",
      nameEn: "Labour",
      nameAr: "عمالة",
      price: "150.00",
    });
    items.pad = await item({
      kind: "part",
      code: "PAD",
      nameEn: "Pad",
      nameAr: "فحمة",
      price: "80.00",
      unit: "piece",
      stockTracked: true,
    });
    items.chg = await item({
      kind: "labor_rate",
      code: "LAB-CHG",
      nameEn: "Labour CHG",
      nameAr: "عمالة",
      price: "105.00",
      taxCode: "CHG",
    });
    items.sublet = await item({
      kind: "part",
      code: "MACH",
      nameEn: "Head machining",
      nameAr: "خراطة رأس",
      price: "210.00",
      unit: "job",
      stockTracked: false,
    });
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  /**
   * A repair order in QC (passed): job A = labour + pad (issued unless `issuePad: false`; `partItem` replaces the
   * pad), job B = labour with an extra line marked "not performed", job C declined.
   */
  async function readyForInvoice(
    options: { issuePad?: boolean; laborItem?: string; partItem?: string; qc?: boolean } = {},
  ) {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Invoice ${counter}`,
          mobile: `0542${String(counter).padStart(6, "0")}`,
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
          make: "Mazda",
          model: "6",
          year: 2019,
          plate: { emirate: "sharjah", code: "IV", number: String(90000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 30000,
      concerns: "Service",
      photoShortfallReason: "Test",
    });
    const ro = (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const job = async (title: string) =>
      (await addJob(db.app, people.advisor!, ro, { title }, randomUUID())).result.jobId;
    const line = async (jobId: string, itemId: string, qty: string) =>
      (await addLine(db.app, people.advisor!, jobId, { itemId, qty }, randomUUID())).result.lineId;
    const a = await job("A");
    const aLabor = await line(a, options.laborItem ?? items.labor!, "1");
    const aPad = await line(a, options.partItem ?? items.pad!, "1");
    const b = await job("B");
    const bLabor = await line(b, items.labor!, "2");
    const bExtra = await line(b, items.labor!, "1");
    const c = await job("C");
    await line(c, items.labor!, "1");
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const revisions = await db.app
      .selectFrom("job_revision")
      .select(["id", "job_id"])
      .where("job_id", "in", [a, b, c])
      .execute();
    await recordInPersonApproval(
      db.app,
      storage,
      people.advisor!,
      {
        versionId,
        contentHash,
        language: "en",
        approverName: "Customer",
        decisions: revisions.map((rev) => ({
          revisionId: rev.id,
          decision: rev.job_id === c ? "declined" : "approved",
        })),
        signature: makePng(300, 100, 2),
      },
      randomUUID(),
    );
    if (options.issuePad !== false) {
      await receiveStock(
        db.app,
        people.store!,
        items.pad!,
        { qty: "1", amount: "45.00", supplierName: "S", supplierRef: `R${counter}` },
        randomUUID(),
      );
      await issueFromStock(db.app, people.store!, aPad, { qty: "1" }, randomUUID());
    }
    for (const [jobId, outcomes] of [
      [
        a,
        [
          { lineId: aLabor, outcome: "done" },
          { lineId: aPad, outcome: "done" },
        ],
      ],
      [
        b,
        [
          { lineId: bLabor, outcome: "done" },
          { lineId: bExtra, outcome: "not_performed", reason: "Not needed" },
        ],
      ],
    ] as const) {
      await assignJob(db.app, people.manager!, jobId, { assigneeId: people.tech!.userId }, randomUUID());
      await startJob(db.app, people.tech!, jobId, randomUUID());
      await completeJob(db.app, people.tech!, jobId, { lines: [...outcomes], note: "Done" }, randomUUID());
    }
    await requestQc(db.app, people.tech!, ro, randomUUID());
    if (options.qc !== false) {
      await passQc(
        db.app,
        people.partner!,
        ro,
        {
          noNewWarningLights: true,
          roadTest: "done",
          odometerOutKm: "30010",
          fluidsOk: true,
          cleanlinessOk: true,
          belongingsOk: true,
          oldParts: "disposed",
        },
        randomUUID(),
      );
    }
    return { ro, vehicleId, customerId, aLabor, aPad, bLabor, bExtra };
  }

  const draft = async (ro: string) =>
    (await createInvoiceDraft(db.app, people.advisor!, ro, randomUUID())).result.draftId;
  const issue = (draftId: string, notice?: string, staff = people.advisor!) =>
    issueInvoice(db.app, staff, draftId, { taxChangeNotice: notice }, randomUUID());
  const roStatus = async (ro: string) =>
    (await db.app.selectFrom("repair_order").select("status").where("id", "=", ro).executeTakeFirstOrThrow())
      .status;

  // --- Draft and issue ------------------------------------------------------------------------

  it("bills only done work: approved, done lines; not performed and declined work are left out (T-29)", async () => {
    const { ro, aLabor, aPad, bLabor, bExtra } = await readyForInvoice();
    const draftId = await draft(ro);
    const preview = (await invoicePreview(db.app, draftId, await today()))!;
    expect(preview.lines.map((line) => line.revisionLineId).sort()).toEqual([aLabor, aPad, bLabor].sort());
    expect(preview.lines.map((line) => line.revisionLineId)).not.toContain(bExtra);
    // 150 + 80 + 300 = 530.00 incl. VAT (5%).
    expect(preview).toMatchObject({ total: "530.00", registrationStatus: "registered", taxChanged: false });
  });

  it("issues a numbered invoice that snapshots tax per line and makes the repair order Ready (AC2-19, B1)", async () => {
    const { ro, aPad } = await readyForInvoice();
    const { invoiceId, number } = (await issue(await draft(ro))).result;
    expect(number).toMatch(/^INV-\d{6}$/);
    expect(await roStatus(ro)).toBe("ready");
    const view = (await invoiceView(db.app, invoiceId))!;
    expect(view).toMatchObject({
      registrationStatus: "registered",
      trn: "100000000000003",
      total: "530.00",
      vat: "25.24",
    });
    expect(view.lines.every((line) => line.taxRate === "5.00" && line.taxCategory === "standard")).toBe(true);
    // Lines in the estimate's order; the excl.-VAT unit price is net ÷ qty (T-31): B's labour is 2 h for 285.71 net.
    expect(view.lines.map((line) => [line.descriptionEn, line.qty, line.unitPriceNet])).toEqual([
      ["Labour", "1.000", "142.86"],
      ["Pad", "1.000", "76.19"],
      ["Labour", "2.000", "142.86"],
    ]);
    // T-28 / AT-12: the pad's cost moved from WIP to COGS at its issue cost.
    expect(view.cogs).toBe("45.00");
    const wip = await db.app
      .selectFrom("line_wip")
      .select(["qty", "value"])
      .where("revision_line_id", "=", aPad)
      .executeTakeFirstOrThrow();
    expect(wip).toEqual({ qty: "0.000", value: "0.00" });
    // Customer output never carries cost.
    expect(JSON.stringify(await customerInvoice(db.app, invoiceId))).not.toContain("cogs");
  });

  it("keeps the customer and vehicle as they were at issue, whatever changes later (T-32, AC2-18)", async () => {
    const { ro, vehicleId, customerId } = await readyForInvoice();
    const { invoiceId } = (await issue(await draft(ro))).result;
    const before = (await invoiceView(db.app, invoiceId))!;
    expect(before).toMatchObject({
      customerNameEn: `Invoice ${counter}`,
      vehicle: { make: "Mazda", model: "6", year: 2019, plate: { emirate: "sharjah", code: "IV" } },
    });
    await changePlate(
      db.app,
      { kind: "user", userId: people.advisor!.userId },
      vehicleId,
      { emirate: "dubai", code: "Z", number: String(70000 + counter) },
      randomUUID(),
    );
    // No customer edit screen exists yet; a future one must not reach issued invoices either.
    await db.owner.updateTable("customer").set({ name_en: "Renamed" }).where("id", "=", customerId).execute();
    expect(await invoiceView(db.app, invoiceId)).toEqual(before);
  });

  it("refuses an invoice before QC passes", async () => {
    const { ro } = await readyForInvoice({ qc: false });
    await expect(draft(ro)).rejects.toMatchObject({ code: "qc_not_passed" });
  });

  it("refuses to bill a stock part line without issued stock, naming it; then issues with COGS = issue cost (AT-12)", async () => {
    const { ro, aPad } = await readyForInvoice({ issuePad: false });
    const draftId = await draft(ro);
    await expect(issue(draftId)).rejects.toMatchObject({
      code: "parts_not_issued",
      message: expect.stringContaining("Pad"),
    });
    expect(await roStatus(ro)).toBe("qc");
    // The database refuses billing beyond what was issued too.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO revision_line_billing (revision_line_id, net_billed_qty, net_billed_net) VALUES ('${aPad}', 1, 76.19)`,
        )
      )?.code,
    ).toBe("42501");
    // The part that was used is recorded now (the job is done, the repair order in QC), and the invoice issues
    // with COGS equal to the issue cost.
    await receiveStock(
      db.app,
      people.store!,
      items.pad!,
      { qty: "1", amount: "41.50", supplierName: "S", supplierRef: "LATE" },
      randomUUID(),
    );
    const issued = await issueFromStock(db.app, people.store!, aPad, { qty: "1" }, randomUUID());
    const { invoiceId } = (await issue(draftId)).result;
    expect((await invoiceView(db.app, invoiceId))!.cogs).toBe(issued.result.cost);
  });

  it("a non-stock line is billed only after its actual cost is entered; COGS = that cost (P0-06, B-08)", async () => {
    const { ro, aPad } = await readyForInvoice({ partItem: items.sublet, issuePad: false });
    const draftId = await draft(ro);
    await expect(issue(draftId)).rejects.toMatchObject({
      code: "parts_not_issued",
      message: expect.stringContaining("Head machining"),
    });
    await receiveAndIssue(
      db.app,
      people.store!,
      aPad,
      { qty: "1", amount: "120.00", supplierName: "Machine shop", supplierRef: "MS-1" },
      randomUUID(),
    );
    const { invoiceId } = (await issue(draftId)).result;
    expect((await invoiceView(db.app, invoiceId))!.cogs).toBe("120.00");
  });

  // --- The cap (AC21-02, AC21-04) -------------------------------------------------------------

  it("a line that stopped being billable after the draft is refused at issue (AC21-02, invoice_cap)", async () => {
    const { ro, bLabor } = await readyForInvoice();
    const draftId = await draft(ro);
    // Set-up as the owner, guards off: the line's "done" outcome is superseded after the draft was made (as an
    // amendment will be able to do from I2-02).
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE job_line_outcome DISABLE TRIGGER USER`.execute(tx);
      await sql`UPDATE job_line_outcome SET superseded_at = now() WHERE revision_line_id = ${bLabor}`.execute(
        tx,
      );
      await sql`ALTER TABLE job_line_outcome ENABLE TRIGGER USER`.execute(tx);
    });
    await expect(issue(draftId)).rejects.toMatchObject({ code: "invoice_cap" });
    expect(await roStatus(ro)).toBe("qc");
    expect(await findNumberGaps(db.app, "invoice")).toEqual([]);
  });

  it("a second invoice for the repair order is refused, and the database caps net billed (AC21-02)", async () => {
    const { ro } = await readyForInvoice();
    const first = await draft(ro);
    const second = await draft(ro);
    await issue(first);
    await expect(issue(second)).rejects.toMatchObject({ code: "qc_not_passed" }); // the repair order is Ready now
    // Even straight in the database: the counters cap net billed at what was authorized.
    const line = await db.app
      .selectFrom("revision_line_billing")
      .select("revision_line_id")
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE revision_line_billing SET net_billed_qty = net_billed_qty + 1 WHERE revision_line_id = '${line.revision_line_id}'`,
        )
      )?.code,
    ).toBe("23514");
  });

  it("two drafts issued at once: exactly one invoice, and no number is consumed by the other (AC21-04, AC2-17)", async () => {
    const { ro } = await readyForInvoice();
    const first = await draft(ro);
    const second = await draft(ro);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([issue(first), issue(second, undefined, people.manager!)]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      // The loser waited on the repair order lock and then found it Ready.
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "qc_not_passed",
      });
    } finally {
      await holder.end();
    }
    expect(
      await db.app.selectFrom("invoice").select("id").where("repair_order_id", "=", ro).execute(),
    ).toHaveLength(1);
    expect(await findNumberGaps(db.app, "invoice")).toEqual([]);
  });

  it("concurrent issues on two repair orders get consecutive numbers (AC2-17)", async () => {
    const one = await readyForInvoice();
    const two = await readyForInvoice();
    const [a, b] = await Promise.all([issue(await draft(one.ro)), issue(await draft(two.ro))]);
    const numbers = [a.result.number, b.result.number]
      .map((n) => Number.parseInt(n.slice(4), 10))
      .sort((x, y) => x - y);
    expect(numbers[1]! - numbers[0]!).toBe(1);
    expect(await findNumberGaps(db.app, "invoice")).toEqual([]);
  });

  // --- Immutability, permissions, idempotency -----------------------------------------------

  it("an issued invoice cannot be changed or deleted, by anyone (AC2-18)", async () => {
    const { ro } = await readyForInvoice();
    const { invoiceId } = (await issue(await draft(ro))).result;
    for (const statement of [
      `UPDATE invoice SET total = 1 WHERE id = '${invoiceId}'`,
      `UPDATE invoice_line SET net = 1 WHERE invoice_id = '${invoiceId}'`,
      `DELETE FROM invoice_line WHERE invoice_id = '${invoiceId}'`,
      `DELETE FROM invoice WHERE id = '${invoiceId}'`,
      `UPDATE line_cogs_movement SET value = 0`,
    ]) {
      expect((await sqlErrorAs(db.appUrl, statement))?.code).toBe("42501");
    }
    // The repair order cannot be made Ready without an invoice, nor an invoice inserted without a number.
    const other = await readyForInvoice();
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'ready' WHERE id = '${other.ro}'`))
        ?.code,
    ).toBe("42501");
    const otherDraft = await draft(other.ro);
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO invoice (id, number, repair_order_id, customer_id, draft_id, registration_status, gross,
             discount, net, vat, total, business_date)
           SELECT gen_random_uuid(), 'INV-999999', id, customer_id, '${otherDraft}', 'not_registered', 0, 0, 0, 0, 0,
             current_date FROM repair_order WHERE id = '${other.ro}'`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("advisors, managers and partners issue; the accountant reads; technicians and store keepers neither", async () => {
    const { ro } = await readyForInvoice();
    for (const who of ["tech", "store", "accountant"]) {
      await expect(createInvoiceDraft(db.app, people[who]!, ro, randomUUID())).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const draftId = await draft(ro);
    const key = randomUUID();
    const first = await issueInvoice(db.app, people.manager!, draftId, {}, key);
    const replay = await issueInvoice(db.app, people.manager!, draftId, {}, key);
    expect(replay).toMatchObject({ replayed: true, result: first.result });
    const get = (token: string) =>
      handlers.getInvoice(
        new Request(`${BASE}/api/invoices/${first.result.invoiceId}`, { headers: cookie(token) }),
        first.result.invoiceId,
      );
    // The accountant reads the invoice but not its cost (T-24); the advisor sees both.
    const forAccountant = await get(people.accountant!.token);
    expect(forAccountant.status).toBe(200);
    expect(await forAccountant.json()).not.toHaveProperty("cogs");
    expect(await (await get(people.advisor!.token)).json()).toHaveProperty("cogs", "45.00");
    expect((await get(people.tech!.token)).status).toBe(403);
    const billing = (token: string) =>
      handlers.getRepairOrderBilling(
        new Request(`${BASE}/api/repair-orders/${ro}/invoice`, { headers: cookie(token) }),
        ro,
      );
    expect((await billing(people.tech!.token)).status).toBe(403);
    expect((await billing(people.accountant!.token)).status).toBe(200);
    const post = await handlers.invoiceDraftAction(
      new Request(`${BASE}/api/invoice-drafts/${draftId}/discard`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
        headers: { "content-type": "application/json", ...cookie(people.accountant!.token) },
      }),
      draftId,
      "discard",
    );
    expect(post.status).toBe(403);
  });

  it("invoice POSTs refuse other origins and unknown actions", async () => {
    const { ro } = await readyForInvoice();
    const headers = (origin?: string) => ({
      "content-type": "application/json",
      ...cookie(people.advisor!.token),
      ...(origin ? { origin } : {}),
    });
    const create = await handlers.createInvoiceDraft(
      new Request(`${BASE}/api/repair-orders/${ro}/invoice-drafts`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
        headers: headers("https://evil.example"),
      }),
      ro,
    );
    expect(create.status).toBe(403);
    const draftId = await draft(ro);
    const action = (name: string, origin?: string) =>
      handlers.invoiceDraftAction(
        new Request(`${BASE}/api/invoice-drafts/${draftId}/${name}`, {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: randomUUID() }),
          headers: headers(origin),
        }),
        draftId,
        name,
      );
    expect((await action("issue", "https://evil.example")).status).toBe(403);
    expect((await action("bogus")).status).toBe(404);
    expect(await roStatus(ro)).toBe("qc");
  });

  it("a discarded draft cannot be issued", async () => {
    const { ro } = await readyForInvoice();
    const draftId = await draft(ro);
    await discardInvoiceDraft(db.app, people.advisor!, draftId, randomUUID());
    await expect(issue(draftId)).rejects.toMatchObject({ code: "draft_closed" });
  });

  // --- Tax on the invoice date (OD-41, AC2-19) — last: these change the tax settings -------

  it("a rate change since approval keeps the approved net, recomputes VAT and needs the customer notice (OD-41)", async () => {
    const { ro } = await readyForInvoice({ laborItem: items.chg });
    await setTaxCodeRate(
      db.app,
      people.partner!,
      "CHG",
      { rate: "10", effectiveFrom: await today() },
      randomUUID(),
    );
    const draftId = await draft(ro);
    const preview = (await invoicePreview(db.app, draftId, await today()))!;
    const changed = preview.lines.find((line) => line.taxCode === "CHG")!;
    expect(changed).toMatchObject({
      net: "100.00",
      vat: "10.00",
      total: "110.00",
      taxRate: "10.00",
      taxChanged: true,
    });
    await expect(issue(draftId)).rejects.toMatchObject({ details: { field: "taxChangeNotice" } });
    const { invoiceId } = (await issue(draftId, "Told the customer by phone that VAT rose to 10%")).result;
    const view = (await invoiceView(db.app, invoiceId))!;
    expect(view.taxChangeNotice).toContain("10%");
    // T-31: the approved inclusive price stays for reference; the excl.-VAT unit price is the approved net.
    expect(view.lines.find((line) => line.taxCode === "CHG")).toMatchObject({
      unitPrice: "105.00",
      unitPriceNet: "100.00",
      net: "100.00",
      total: "110.00",
    });
  });

  it("not registered on the invoice date: no VAT and no TRN (AC2-19)", async () => {
    const { ro } = await readyForInvoice();
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "not_registered", effectiveFrom: await today() },
      randomUUID(),
    );
    const draftId = await draft(ro);
    const { invoiceId } = (
      await issue(draftId, "Customer told: the garage is not VAT-registered on this date")
    ).result;
    const view = (await invoiceView(db.app, invoiceId))!;
    expect(view).toMatchObject({ registrationStatus: "not_registered", trn: null, vat: "0.00" });
    expect(view.lines.every((line) => line.vat === "0.00" && line.taxCategory === "not_registered")).toBe(
      true,
    );
  });
});
