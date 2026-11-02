import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvoiceDocument } from "../src/app/[locale]/(print)/invoices/[id]/print/invoice-document";
import { t } from "../src/i18n";
import { hasPermission } from "../src/server/auth/permissions";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createInvoiceDraft, issueInvoice } from "../src/server/billing/invoice";
import { customerInvoice } from "../src/server/billing/queries";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode, setTaxCodeRate } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { createHandlers } from "../src/server/http/handlers";
import { assignInspection, recordFinding } from "../src/server/inspection/commands";
import { issueFromStock, receiveStock } from "../src/server/inventory/commands";
import { LocalDiskStorage } from "../src/server/media/storage";
import { findNumberGaps } from "../src/server/numbering/numbering";
import { passQc, requestQc } from "../src/server/quality/commands";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import {
  businessProfileHistory,
  currentBusinessProfile,
  setBusinessProfile,
} from "../src/server/settings/business-profile";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, startJob } from "../src/server/workshop/commands";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-09b — printed invoice: the business profile (OD-42, OD-46, OD-47, T-33) and the bilingual print view (OD-48)
 * with its titles and VAT columns (AC2-19), changed-tax lines (OD-45) and nothing internal (rule 9, AC2-31 pattern).
 */

describe("S22 — printed invoice", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string; displayName: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  const today = async () =>
    (
      await sql<{
        d: string;
      }>`SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS d`.execute(db.app)
    ).rows[0]!.d;
  const PROFILE = {
    legalNameEn: "Al Noor Auto Repair LLC",
    legalNameAr: "النور لتصليح السيارات ذ.م.م",
    addressEn: "Industrial Area 6, Sharjah",
    addressAr: "المنطقة الصناعية 6، الشارقة",
    phone: "+971 6 555 1234",
  };
  const INTERNAL_NOTE = "Customer haggles hard; supplier invoice SUP-77 not yet paid";
  const NOTICE = "Told the customer by phone that VAT rose to 10%";

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-print-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["partner2", ["partner"]],
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
      const row = await db.app
        .selectFrom("app_user")
        .select("display_name")
        .where("id", "=", user.userId)
        .executeTakeFirstOrThrow();
      people[name] = {
        userId: user.userId,
        roles: [...roles],
        token: decodeURIComponent(match?.[1] ?? ""),
        displayName: row.display_name,
      };
    }
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "registered", trn: "100000000000003", effectiveFrom: "2026-01-01" },
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
    items.chg = await item({
      kind: "labor_rate",
      code: "LAB-CHG",
      nameEn: "Diagnosis",
      nameAr: "تشخيص",
      price: "105.00",
      taxCode: "CHG",
    });
    items.pad = await item({
      kind: "part",
      code: "PAD",
      nameEn: "Brake pad",
      nameAr: "فحمة فرامل",
      price: "80.00",
      unit: "piece",
      stockTracked: true,
    });
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  /**
   * A repair order with a passed QC: one job built from a finding with an internal note, with the given lines
   * (catalogue item and quantity) done. Pad lines get stock issued at 37.77 (a cost that appears nowhere else).
   */
  async function readyForInvoice(lines: { itemId: string; qty: string }[]) {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Print Customer ${counter}`,
          nameAr: `عميل ${counter}`,
          mobile: `0543${String(counter).padStart(6, "0")}`,
          preferredLanguage: "ar",
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
          year: 2021,
          vin: `JN1PRINT${String(counter).padStart(9, "0")}`,
          plate: { emirate: "sharjah", code: "PR", number: String(80000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 50000,
      concerns: "Brakes",
      photoShortfallReason: "Test",
    });
    const ro = (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
    await assignInspection(db.app, people.manager!, ro, people.tech!.userId);
    const { findingId } = (
      await recordFinding(
        db.app,
        people.tech!,
        ro,
        { title: "Worn pads", severity: "soon", internalNote: INTERNAL_NOTE },
        randomUUID(),
      )
    ).result;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const jobId = (await addJob(db.app, people.advisor!, ro, { findingId }, randomUUID())).result.jobId;
    const lineIds: string[] = [];
    for (const line of lines) {
      lineIds.push((await addLine(db.app, people.advisor!, jobId, line, randomUUID())).result.lineId);
    }
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const revision = await db.app
      .selectFrom("job_revision")
      .select("id")
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();
    await recordInPersonApproval(
      db.app,
      storage,
      people.advisor!,
      {
        versionId,
        contentHash,
        language: "ar",
        approverName: "Customer",
        decisions: [{ revisionId: revision.id, decision: "approved" }],
        signature: makePng(300, 100, 3),
      },
      randomUUID(),
    );
    for (const [index, line] of lines.entries()) {
      if (line.itemId !== items.pad) continue;
      await receiveStock(
        db.app,
        people.store!,
        items.pad,
        { qty: line.qty, amount: "37.77", supplierName: "S", supplierRef: `P${counter}-${index}` },
        randomUUID(),
      );
      await issueFromStock(db.app, people.store!, lineIds[index]!, { qty: line.qty }, randomUUID());
    }
    await assignJob(db.app, people.manager!, jobId, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, jobId, randomUUID());
    await completeJob(
      db.app,
      people.tech!,
      jobId,
      { lines: lineIds.map((lineId) => ({ lineId, outcome: "done" as const })), note: "Done" },
      randomUUID(),
    );
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await passQc(
      db.app,
      people.partner!,
      ro,
      {
        noNewWarningLights: true,
        roadTest: "done",
        odometerOutKm: "50010",
        fluidsOk: true,
        cleanlinessOk: true,
        belongingsOk: true,
        oldParts: "disposed",
      },
      randomUUID(),
    );
    return { ro };
  }

  const draft = async (ro: string) =>
    (await createInvoiceDraft(db.app, people.advisor!, ro, randomUUID())).result.draftId;
  const issue = (draftId: string, notice?: string) =>
    issueInvoice(db.app, people.advisor!, draftId, { taxChangeNotice: notice }, randomUUID());
  const saveProfile = (staff: Staff, input: Partial<typeof PROFILE> & { supersedesId?: string }) =>
    setBusinessProfile(db.app, staff, { ...PROFILE, ...input }, randomUUID());
  const render = async (invoiceId: string, locale: "ar" | "en" = "ar") =>
    renderToStaticMarkup(
      <InvoiceDocument invoice={(await customerInvoice(db.app, invoiceId))!} locale={locale} />,
    );
  /** Text content only, with Intl's spaces normalised. */
  const textOf = (html: string) =>
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/[  ‎‏]/g, " ")
      .replace(/\s+/g, " ");

  // --- OD-47: no invoice without the business profile (runs first: no profile exists yet) --------------------

  it("refuses to issue an invoice until a partner enters the business profile; no number is used (OD-47)", async () => {
    expect(await currentBusinessProfile(db.app)).toBeNull();
    const { ro } = await readyForInvoice([{ itemId: items.labor!, qty: "1" }]);
    const draftId = await draft(ro);
    await expect(issue(draftId)).rejects.toMatchObject({ code: "no_business_profile" });
    const status = await db.app
      .selectFrom("repair_order")
      .select("status")
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe("qc");
    const numbers = await db.app
      .selectFrom("issued_number")
      .select("number_text")
      .where("series", "=", "invoice")
      .execute();
    expect(numbers).toEqual([]);
    // The database refuses the same, whatever the application sends.
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO invoice (id, number, repair_order_id, customer_id, draft_id, registration_status, gross,
         discount, net, vat, total, business_date)
       SELECT gen_random_uuid(), 'INV-999999', id, customer_id, '${draftId}', 'not_registered', 0, 0, 0, 0, 0,
         current_date FROM repair_order WHERE id = '${ro}'`,
    );
    expect(forged).toMatchObject({ code: "42501", message: expect.stringContaining("business profile") });
    // The error reaches the advisor as a 409 with its own code.
    const response = await handlers.invoiceDraftAction(
      new Request(`${BASE}/api/invoice-drafts/${draftId}/issue`, {
        method: "POST",
        headers: { ...cookie(people.advisor!.token), origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      }),
      draftId,
      "issue",
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "no_business_profile" });

    // Once the profile exists the same draft issues as INV-000001: nothing was skipped.
    await saveProfile(people.partner!, {});
    const { number } = (await issue(draftId)).result;
    expect(number).toBe("INV-000001");
    expect(await findNumberGaps(db.app, "invoice")).toEqual([]);
  });

  // --- The business profile -------------------------------------------------------------------------------

  it("each change is a new version naming the one it replaces, audited with before and after (OD-46)", async () => {
    const first = (await currentBusinessProfile(db.app))!;
    expect(first).toMatchObject(PROFILE);
    const { profileId } = (
      await saveProfile(people.partner2!, { phone: "06 555 9999", supersedesId: first.id })
    ).result;
    expect((await currentBusinessProfile(db.app))!).toMatchObject({ id: profileId, phone: "06 555 9999" });
    const history = await businessProfileHistory(db.app);
    expect(history.map((version) => version.id)).toEqual([profileId, first.id]);
    expect(history[0]!.createdByName).toBe(people.partner2!.displayName);
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["before_state", "after_state", "actor_user_id"])
      .where("action", "=", "settings.business_profile_changed")
      .where("entity_id", "=", profileId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_user_id: people.partner2!.userId,
      before_state: { id: first.id, phone: PROFILE.phone },
      after_state: { id: profileId, phone: "06 555 9999", legalNameEn: PROFILE.legalNameEn },
    });
    // The same key twice records one version.
    const key = randomUUID();
    const input = { ...PROFILE, supersedesId: profileId };
    const once = await setBusinessProfile(db.app, people.partner!, input, key);
    const again = await setBusinessProfile(db.app, people.partner!, input, key);
    expect(again).toMatchObject({ replayed: true, result: once.result });
    expect(await businessProfileHistory(db.app)).toHaveLength(3);
  });

  it("only partners change it, through the command and the API (OD-42)", async () => {
    const current = (await currentBusinessProfile(db.app))!;
    for (const who of ["manager", "advisor", "accountant", "tech", "store"]) {
      await expect(saveProfile(people[who]!, { supersedesId: current.id })).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(hasPermission(people[who]!.roles, "business_profile.manage")).toBe(false);
    }
    const post = (token: string, origin = BASE) =>
      handlers.setBusinessProfile(
        new Request(`${BASE}/api/settings/business-profile`, {
          method: "POST",
          headers: { ...cookie(token), origin, "content-type": "application/json" },
          body: JSON.stringify({ ...PROFILE, supersedesId: current.id, idempotencyKey: randomUUID() }),
        }),
      );
    expect((await post(people.manager!.token)).status).toBe(403);
    const denied = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("action", "=", "authz.denied")
      .where("actor_user_id", "=", people.manager!.userId)
      .execute();
    expect(denied.length).toBeGreaterThan(0);
    const get = (token: string) =>
      handlers.getBusinessProfile(
        new Request(`${BASE}/api/settings/business-profile`, { headers: cookie(token) }),
      );
    expect((await get(people.advisor!.token)).status).toBe(403);
    expect(await (await get(people.partner!.token)).json()).toMatchObject({ current: { id: current.id } });
    expect((await post(people.partner!.token, "https://evil.example")).status).toBe(403);
    expect(await currentBusinessProfile(db.app)).toEqual(current);
    const created = await post(people.partner!.token);
    expect(created.status).toBe(201);
  });

  it("refuses missing or too long details and a bad phone number; nothing is saved (T-33)", async () => {
    const current = (await currentBusinessProfile(db.app))!;
    for (const [input, field] of [
      [{ legalNameEn: "  " }, "legalNameEn"],
      [{ legalNameAr: "" }, "legalNameAr"],
      [{ addressEn: "x".repeat(501) }, "addressEn"],
      [{ addressAr: "" }, "addressAr"],
      [{ phone: "12345" }, "phone"],
      [{ phone: "06 555 12a4" }, "phone"],
      [{ phone: "+971 1234567890123456" }, "phone"],
    ] as const) {
      await expect(
        saveProfile(people.partner!, { ...input, supersedesId: current.id }),
      ).rejects.toMatchObject({
        code: "validation_failed",
        details: { field },
      });
    }
    await expect(saveProfile(people.partner!, { supersedesId: "not-a-uuid" })).rejects.toMatchObject({
      details: { field: "supersedesId" },
    });
    expect(await currentBusinessProfile(db.app)).toEqual(current);
  });

  it("two partners saving from the same version: exactly one wins, the other is asked to reload", async () => {
    const current = (await currentBusinessProfile(db.app))!;
    const results = await Promise.allSettled([
      saveProfile(people.partner!, { phone: "06 111 1111", supersedesId: current.id }),
      saveProfile(people.partner2!, { phone: "06 222 2222", supersedesId: current.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "profile_changed" });
    // A form filled from an older version is refused too, and so is a second "first" version.
    await expect(saveProfile(people.partner!, { supersedesId: current.id })).rejects.toMatchObject({
      code: "profile_changed",
    });
    await expect(saveProfile(people.partner!, {})).rejects.toMatchObject({ code: "profile_changed" });
    const chain = await db.app.selectFrom("business_profile").select(["id", "supersedes_id"]).execute();
    expect(chain.filter((row) => row.supersedes_id === null)).toHaveLength(1);
    expect(new Set(chain.map((row) => row.supersedes_id)).size).toBe(chain.length);
  });

  it("versions cannot be changed or deleted by the application (OD-46)", async () => {
    const current = (await currentBusinessProfile(db.app))!;
    for (const statement of [
      `UPDATE business_profile SET legal_name_en = 'Other' WHERE id = '${current.id}'`,
      `DELETE FROM business_profile WHERE id = '${current.id}'`,
      `UPDATE invoice SET business_profile_id = NULL`,
    ]) {
      expect((await sqlErrorAs(db.appUrl, statement))?.code).toBe("42501");
    }
    // A second successor of a version that already has one is refused by the database (one chain).
    const older = (await businessProfileHistory(db.app))[1]!;
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO business_profile (supersedes_id, legal_name_en, legal_name_ar, address_en, address_ar, phone)
           VALUES ('${older.id}', 'a', 'b', 'c', 'd', '065551234')`,
        )
      )?.code,
    ).toBe("23505");
    // A second root inserted directly is refused by the database.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO business_profile (legal_name_en, legal_name_ar, address_en, address_ar, phone)
           VALUES ('a', 'b', 'c', 'd', '065551234')`,
        )
      )?.code,
    ).toBe("23505");
  });

  // --- The printed invoice ----------------------------------------------------------------------------------

  it("records the profile version at issue; a reprint after a change shows the old details (OD-46)", async () => {
    const before = (await currentBusinessProfile(db.app))!;
    const { ro } = await readyForInvoice([{ itemId: items.labor!, qty: "1" }]);
    const { invoiceId } = (await issue(await draft(ro))).result;
    const row = await db.app
      .selectFrom("invoice")
      .select("business_profile_id")
      .where("id", "=", invoiceId)
      .executeTakeFirstOrThrow();
    expect(row.business_profile_id).toBe(before.id);
    const printed = await render(invoiceId);
    await saveProfile(people.partner!, {
      legalNameEn: "Renamed Garage LLC",
      addressEn: "Somewhere else",
      supersedesId: before.id,
    });
    expect(await render(invoiceId)).toBe(printed);
    expect(printed).toContain(PROFILE.legalNameEn);
    expect(printed).not.toContain("Renamed Garage LLC");
  });

  it("registered: “Tax Invoice / فاتورة ضريبية”, the TRN and the VAT columns, both languages (AC2-19, OD-42, OD-48)", async () => {
    // 2 h of labour: 300.00 incl. VAT = 285.71 net, so the unit price excl. VAT (142.86) is rounded (T-31).
    const { ro } = await readyForInvoice([
      { itemId: items.labor!, qty: "2" },
      { itemId: items.pad!, qty: "1" },
    ]);
    const { invoiceId, number } = (await issue(await draft(ro))).result;
    const html = await render(invoiceId, "ar");
    const text = textOf(html);
    for (const lang of ["ar", "en"] as const) {
      for (const key of [
        "print.taxInvoice",
        "print.trn",
        "print.unitPriceExVat",
        "print.vatRate",
        "print.vat",
        "print.lineTotal",
        "print.totalVat",
        "print.roundingNote",
      ] as const) {
        expect(text, `${lang}:${key}`).toContain(t(lang, key));
      }
    }
    expect(html).toContain('lang="ar"');
    expect(html).toContain('lang="en"');
    expect(text).toContain("100000000000003");
    expect(text).toContain(number);
    for (const value of [
      PROFILE.legalNameAr,
      PROFILE.addressAr,
      `Print Customer ${counter}`,
      `عميل ${counter}`,
      "عمالة",
      "Labour",
      "فحمة فرامل",
      "Brake pad",
      "Nissan Patrol 2021",
      "الشارقة",
      "PR 8000",
    ]) {
      expect(text).toContain(value);
    }
    // Labour line: 2 × 142.86* → 285.71 net, 14.29 VAT, 300.00; pad: 76.19, 3.81, 80.00; total 380.00.
    for (const value of [
      "142.86",
      "285.71",
      "14.29",
      "300.00",
      "76.19",
      "3.81",
      "80.00",
      "361.90",
      "18.10",
      "380.00",
    ]) {
      expect(text).toContain(value);
    }
    expect(html).toContain("<sup>*</sup>");
  });

  it("an exact unit price carries no rounding note", async () => {
    const { ro } = await readyForInvoice([{ itemId: items.chg!, qty: "1" }]);
    const { invoiceId } = (await issue(await draft(ro))).result;
    const html = await render(invoiceId, "en");
    expect(textOf(html)).toContain("100.00");
    expect(html).not.toContain(t("en", "print.roundingNote"));
    expect(html).not.toContain("<sup>");
  });

  it("nothing internal is printed: no parts cost, tax notice, staff name or internal note (rule 9, AC2-31)", async () => {
    const { ro } = await readyForInvoice([
      { itemId: items.pad!, qty: "1" },
      { itemId: items.chg!, qty: "1" },
    ]);
    await setTaxCodeRate(
      db.app,
      people.partner!,
      "CHG",
      { rate: "10", effectiveFrom: await today() },
      randomUUID(),
    );
    const { invoiceId } = (await issue(await draft(ro), NOTICE)).result;
    for (const locale of ["ar", "en"] as const) {
      const text = textOf(await render(invoiceId, locale));
      expect(text).not.toContain("37.77"); // the pad's cost (COGS)
      expect(text).not.toContain(NOTICE);
      expect(text).not.toContain(INTERNAL_NOTE);
      for (const person of Object.values(people)) expect(text).not.toContain(person.displayName);
      // OD-45: the changed-tax line prints its excl.-VAT unit price, net, VAT 10% and total — never the approved
      // VAT-inclusive 105.00.
      expect(text).toContain("100.00");
      expect(text).toContain("10%");
      expect(text).toContain("110.00");
      expect(text).not.toContain("105.00");
    }
  });

  it("the print view's permission (invoice.read) excludes technicians and store keepers (page: e2e invoice spec)", () => {
    for (const who of ["partner", "manager", "advisor", "accountant"]) {
      expect(hasPermission(people[who]!.roles, "invoice.read")).toBe(true);
    }
    for (const who of ["tech", "store"]) {
      expect(hasPermission(people[who]!.roles, "invoice.read")).toBe(false);
    }
  });

  it("not registered on the invoice date: “Invoice / فاتورة”, no TRN and no VAT columns (AC2-19)", async () => {
    // 3 h approved at 450.00 incl. VAT: net 428.57, unit price 142.86 (rounded, so the footnote is printed).
    const { ro } = await readyForInvoice([{ itemId: items.labor!, qty: "3" }]);
    await addTaxProfile(
      db.app,
      people.partner!,
      { registrationStatus: "not_registered", effectiveFrom: await today() },
      randomUUID(),
    );
    const { invoiceId } = (
      await issue(await draft(ro), "Customer told: the garage is not VAT-registered on this date")
    ).result;
    const text = textOf(await render(invoiceId, "en"));
    expect(text).toContain(`${t("en", "print.invoice")} ${t("ar", "print.invoice")}`);
    for (const lang of ["ar", "en"] as const) {
      for (const key of [
        "print.taxInvoice",
        "print.trn",
        "print.vat",
        "print.vatRate",
        "print.totalVat",
      ] as const) {
        expect(text, `${lang}:${key}`).not.toContain(t(lang, key));
      }
    }
    expect(text).not.toContain("100000000000003");
    expect(text).not.toMatch(/VAT|ضريب/);
    expect(text).toContain(t("en", "print.roundingNoteNoVat"));
    // OD-41: the approved net (428.57) is kept and no VAT is added.
    expect(text).toContain("Invoice total إجمالي الفاتورة 428.57");
  });
});
