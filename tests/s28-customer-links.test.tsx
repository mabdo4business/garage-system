import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkPage } from "../src/components/link-page";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { estimateView } from "../src/server/estimate/queries";
import type { EstimateSnapshot } from "../src/server/estimate/snapshot";
import { startVersion, withdrawVersion } from "../src/server/estimate/versions";
import { createHandlers } from "../src/server/http/handlers";
import { addFindingPhoto, recordFinding, setFindingPhotoVisibility } from "../src/server/inspection/commands";
import { createCustomerLink, revokeCustomerLink } from "../src/server/links/commands";
import {
  customerLinkPhoto,
  maskPlateNumber,
  openCustomerLink,
  requesterFrom,
  type CustomerLinkPage,
} from "../src/server/links/customer";
import { customerLinkStatus } from "../src/server/links/queries";
import { hashLinkToken } from "../src/server/links/token";
import { LocalDiskStorage } from "../src/server/media/storage";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { setBusinessProfile } from "../src/server/settings/business-profile";
import { createVehicle } from "../src/server/vehicle/service";
import nextConfig from "../next.config";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I2-03a — customer links (PRD v0.2 §6.4): the token service (random, hashed, scoped, expiring, revocable,
 * rate-limited), the generic invalid page (AC2-04), tampering and rate limits (AC2-05), the read-only customer page
 * with only customer-facing data (rule 9, OD-63), and the staff side (create, replace, revoke).
 */

describe("S28 — customer links", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  let ipCounter = 0;
  /** A fresh IP per test, so one test's invalid attempts never block another's. */
  const freshIp = () => `198.51.100.${++ipCounter}`;
  const visitor = (ip = freshIp()) => ({ ip, userAgent: "Mozilla/5.0 (test phone)" });

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-links-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
      ["store", ["store_keeper"]],
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
    await createTaxCode(
      db.app,
      people.partner!,
      {
        code: "STD",
        labelEn: "STD",
        labelAr: "STD",
        category: "standard",
        rate: "5",
        effectiveFrom: "2026-01-01",
      },
      randomUUID(),
    );
    await setBusinessProfile(
      db.app,
      people.partner!,
      {
        legalNameEn: "Test Garage LLC",
        legalNameAr: "كراج الاختبار",
        addressEn: "Industrial Area 5, Sharjah",
        addressAr: "المنطقة الصناعية 5، الشارقة",
        phone: "065550000",
      },
      randomUUID(),
    );
    const item = async (kind: string, code: string, price: string, unit?: string) =>
      (
        await createItem(
          db.app,
          people.manager!,
          { kind, code, nameEn: `${code} EN`, nameAr: `${code} AR`, price, taxCode: "STD", unit },
          randomUUID(),
        )
      ).result.itemId;
    items.labor = await item("labor_rate", "LAB-L", "200.00");
    items.pads = await item("part", "PADS-L", "300.00", "piece");
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  async function newRepairOrder(preferredLanguage: "ar" | "en" = "en"): Promise<string> {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Mariam Link${counter} Haddad`,
          nameAr: `مريم ${counter} حداد`,
          mobile: `0549${String(counter).padStart(6, "0")}`,
          preferredLanguage,
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
          make: "Toyota",
          model: "Land Cruiser",
          year: 2021,
          plate: { emirate: "sharjah", code: "LK", number: String(70000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 50000,
      concerns: "Brakes",
      photoShortfallReason: "Test fixture",
    });
    return (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
  }

  /**
   * A sent v1 with "Brake pads" from an urgent finding (customer note, fault codes, one photo shown to the customer
   * and one kept internal, an internal note) and a typed "AC service" job.
   */
  async function sentEstimate(preferredLanguage: "ar" | "en" = "en") {
    const ro = await newRepairOrder(preferredLanguage);
    const findingId = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        {
          title: "Brake pads worn",
          severity: "urgent",
          faultCodes: "C1234, B0001",
          customerNote: "CUSTOMER-NOTE: pads are at 2 mm",
          internalNote: "INTERNAL-NOTE-SECRET",
        },
        randomUUID(),
      )
    ).result.findingId;
    const shown = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(400, 300, counter * 2) },
        randomUUID(),
      )
    ).result.mediaId;
    await setFindingPhotoVisibility(db.app, people.advisor!, shown, "customer");
    const internal = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId, bytes: makePng(400, 300, counter * 2 + 1) },
        randomUUID(),
      )
    ).result.mediaId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const brakes = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await addLine(db.app, people.advisor!, brakes, { itemId: items.labor, qty: "1" }, randomUUID());
    await addLine(db.app, people.advisor!, brakes, { itemId: items.pads, qty: "1" }, randomUUID());
    const ac = (await addJob(db.app, people.advisor!, ro, { title: "AC service" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, ac, { itemId: items.labor, qty: "1" }, randomUUID());
    const sent = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    return { ro, brakes, ac, findingId, shown, internal, ...sent };
  }

  const create = (ro: string, who = people.advisor!) => createCustomerLink(db.app, who, ro);
  const open = (token: string, requester = visitor()) => openCustomerLink(db.app, token, requester);
  const html = (page: CustomerLinkPage, token: string, locale: "ar" | "en" = "en") =>
    renderToStaticMarkup(
      <LinkPage
        locale={locale}
        token={token}
        page={page}
        idempotencyKey="00000000-0000-4000-8000-000000000000"
      />,
    );

  /** Moves a version's expiry (and its link's) into the past, as the owner with the guards off. */
  async function overdue(versionId: string) {
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition`.execute(tx);
      await sql`UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = ${versionId}`.execute(
        tx,
      );
      await sql`ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition`.execute(tx);
    });
  }

  async function setting(key: string, value: string) {
    await sql`UPDATE app_setting SET value = ${value} WHERE key = ${key}`.execute(db.owner);
  }

  // --- Token service ---------------------------------------------------------------------------

  it("creates a link: a 256-bit URL-safe token in the customer's language, stored only as its SHA-256", async () => {
    const { ro, versionId } = await sentEstimate("ar");
    const outcome = await create(ro);
    const { token, path, linkId } = outcome.result;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes ≥ 128 bits (§6.4)
    expect(path).toBe(`/ar/c/${token}`);

    const row = await db.app
      .selectFrom("customer_link")
      .selectAll()
      .where("id", "=", linkId)
      .executeTakeFirstOrThrow();
    expect(row.token_hash.equals(createHash("sha256").update(token).digest())).toBe(true);
    expect(row).toMatchObject({
      purpose: "estimate_approval",
      repair_order_id: ro,
      estimate_version_id: versionId,
    });
    const version = await db.app
      .selectFrom("estimate_version")
      .select("expires_at")
      .where("id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect(row.expires_at.getTime()).toBe(version.expires_at!.getTime()); // expires with the version

    // The token is nowhere in the database: not in the link, the audit log or the idempotency records.
    for (const table of ["customer_link", "audit_event", "idempotency_key"] as const) {
      const dump = await sql<{
        t: string;
      }>`SELECT string_agg(x::text, '') AS t FROM ${sql.table(table)} x`.execute(db.owner);
      expect(dump.rows[0]!.t ?? "").not.toContain(token);
    }
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["after_state"])
      .where("action", "=", "link.created")
      .where("entity_id", "=", linkId)
      .executeTakeFirstOrThrow();
    expect(audit.after_state).toMatchObject({ versionId, versionNo: 1, replaced: [] });
  });

  it("one live link per version: a new link replaces the old one, which stops working (T-41)", async () => {
    const { ro } = await sentEstimate();
    const first = (await create(ro)).result;
    const second = (await create(ro)).result;
    expect((await open(first.token)).kind).toBe("invalid");
    expect((await open(second.token)).kind).toBe("estimate");
    const revoked = await db.app
      .selectFrom("customer_link")
      .select(["revoke_reason", "revoked_by"])
      .where("id", "=", first.linkId)
      .executeTakeFirstOrThrow();
    expect(revoked).toEqual({ revoke_reason: "replaced", revoked_by: people.advisor!.userId });
    // The database holds the rule too: a second live link for the version is refused.
    const live = await db.app
      .selectFrom("customer_link")
      .selectAll()
      .where("id", "=", second.linkId)
      .executeTakeFirstOrThrow();
    await expect(
      db.app
        .insertInto("customer_link")
        .values({
          purpose: "estimate_approval",
          repair_order_id: ro,
          estimate_version_id: live.estimate_version_id,
          token_hash: hashLinkToken("A".repeat(43))!,
          expires_at: live.expires_at,
          created_by: people.advisor!.userId,
        })
        .execute(),
    ).rejects.toThrow(/customer_link_one_live/);
  });

  it("two links created at the same moment: both are recorded, exactly one is live", async () => {
    const { ro, versionId } = await sentEstimate();
    await Promise.all([create(ro), create(ro, people.manager!)]);
    const rows = await db.app
      .selectFrom("customer_link")
      .select(["revoked_at"])
      .where("estimate_version_id", "=", versionId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
  });

  it("refuses a link without a sent estimate, or for one past its expiry, and writes nothing", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    await expect(create(ro)).rejects.toMatchObject({ code: "estimate_closed" }); // still Checked-in, never sent

    const { ro: sentRo, versionId } = await sentEstimate();
    await overdue(versionId);
    await expect(create(sentRo)).rejects.toMatchObject({ code: "estimate_expired" });
    const links = await db.app
      .selectFrom("customer_link")
      .select("id")
      .where("repair_order_id", "in", [ro, sentRo])
      .execute();
    expect(links).toHaveLength(0);
    // The database refuses a link for an unsent version even if a command forgot to check.
    const draftVersion = await db.app
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .select(["estimate_version.id"])
      .where("estimate.repair_order_id", "=", ro)
      .executeTakeFirstOrThrow();
    await expect(
      db.app
        .insertInto("customer_link")
        .values({
          purpose: "estimate_approval",
          repair_order_id: ro,
          estimate_version_id: draftVersion.id,
          token_hash: hashLinkToken("B".repeat(43))!,
          expires_at: new Date(Date.now() + 86_400_000),
          created_by: people.advisor!.userId,
        })
        .execute(),
    ).rejects.toThrow(/sent, unexpired version/);
  });

  it("only advisors, managers and partners create or revoke links; a technician gets 403 and the attempt is audited", async () => {
    const { ro } = await sentEstimate();
    for (const who of ["tech", "store"] as const) {
      const response = await handlers.createCustomerLink(
        new Request(`${BASE}/api/repair-orders/${ro}/customer-link`, {
          method: "POST",
          headers: cookie(people[who]!.token),
        }),
        ro,
      );
      expect(response.status).toBe(403);
    }
    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .where("entity_id", "=", ro)
      .execute();
    expect(denied.map((row) => (row.details as { permission: string }).permission)).toEqual([
      "customer_link.create",
      "customer_link.create",
    ]);
    expect(
      await db.app.selectFrom("customer_link").select("id").where("repair_order_id", "=", ro).execute(),
    ).toEqual([]);

    const response = await handlers.createCustomerLink(
      new Request(`${BASE}/api/repair-orders/${ro}/customer-link`, {
        method: "POST",
        headers: cookie(people.advisor!.token),
      }),
      ro,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { linkId } = (await response.json()) as { linkId: string };
    const techRevoke = await handlers.revokeCustomerLink(
      new Request(`${BASE}/api/customer-links/${linkId}/revoke`, {
        method: "POST",
        headers: cookie(people.tech!.token),
      }),
      linkId,
    );
    expect(techRevoke.status).toBe(403);
  });

  it("revoking by hand ends the link at once; revoking again changes nothing", async () => {
    const { ro } = await sentEstimate();
    const { token, linkId } = (await create(ro)).result;
    expect((await revokeCustomerLink(db.app, people.advisor!, linkId)).result).toEqual({
      linkId,
      revoked: true,
    });
    expect((await open(token)).kind).toBe("invalid");
    expect((await revokeCustomerLink(db.app, people.advisor!, linkId)).result).toEqual({
      linkId,
      revoked: false,
    });
    const actions = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("entity_id", "=", linkId)
      .where("action", "like", "link.revoke%")
      .orderBy("seq")
      .execute();
    expect(actions.map((row) => row.action)).toEqual(["link.revoked", "link.revoke_repeated"]);
    expect((await customerLinkStatus(db.app, ro)).live).toBeNull();
  });

  it("the app role cannot change a token, restore a revoked link, or alter or delete access records", async () => {
    const { ro } = await sentEstimate();
    const { linkId } = (await create(ro)).result;
    await revokeCustomerLink(db.app, people.advisor!, linkId);
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE customer_link SET token_hash = '\\x00' WHERE id = '${linkId}'`))
        ?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM customer_link WHERE id = '${linkId}'`))?.code).toBe(
      "42501",
    );
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE customer_link SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL WHERE id = '${linkId}'`,
        )
      )?.message,
    ).toMatch(/revoked once/);
    expect((await sqlErrorAs(db.appUrl, "UPDATE customer_link_access SET ip = 'x'"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "DELETE FROM customer_link_access"))?.code).toBe("42501");
  });

  // --- The customer page (rule 9, §6.4 "data shown") -------------------------------------------

  it("shows the estimate with only customer-facing data: masked plate, first name, note, fault codes, the shared photo", async () => {
    const { ro, shown, internal } = await sentEstimate();
    const { token } = (await create(ro)).result;
    const page = await open(token);
    expect(page.kind).toBe("estimate");
    if (page.kind !== "estimate") return;
    const plate = String(70000 + counter);
    expect(page.estimate.vehicle).toEqual({
      make: "Toyota",
      model: "Land Cruiser",
      year: 2021,
      plate: { emirate: "sharjah", code: "LK", number: maskPlateNumber(plate) },
    });
    expect(maskPlateNumber(plate)).toBe(`•••${plate.slice(-2)}`);
    expect(page.estimate.customerFirstName).toEqual({ en: "Mariam", ar: "مريم" });
    expect(page.estimate.garageName).toEqual({ en: "Test Garage LLC", ar: "كراج الاختبار" });
    expect(page.estimate.visiblePhotoIds).toEqual([shown]);
    expect(page.estimate.pendingRevisionIds).toHaveLength(2);

    for (const locale of ["en", "ar"] as const) {
      const markup = html(page, token, locale);
      expect(markup).toContain("CUSTOMER-NOTE: pads are at 2 mm");
      expect(markup).toContain("C1234");
      expect(markup).toContain("B0001"); // fault codes (OD-63)
      expect(markup).toContain(`/c/${token}/photo/${shown}`);
      expect(markup).toContain("AC service");
      expect(markup).toContain(locale === "en" ? "Test Garage LLC" : "كراج الاختبار");
      expect(markup).toContain(locale === "en" ? "Mariam" : "مريم");
      // Never: internal notes, internal photos, the full plate, phone numbers, surnames or costs.
      expect(markup).not.toContain("INTERNAL-NOTE-SECRET");
      expect(markup).not.toContain(internal);
      expect(markup).not.toContain(plate);
      expect(markup).not.toContain("0549");
      expect(markup).not.toContain("Haddad");
      expect(markup).not.toContain("065550000");
      expect(markup).toContain(`href="/${locale === "en" ? "ar" : "en"}/c/${token}"`); // language switch
    }
    // Nothing internal in the view the page is built from, either.
    const view = JSON.stringify(page);
    expect(view).not.toContain("INTERNAL-NOTE-SECRET");
    expect(view).not.toContain(plate);
    expect(view).not.toContain(people.advisor!.userId);
  });

  it("the snapshot (schema 3) carries the finding's customer note, fault codes and shared photos — never the internal note", async () => {
    const { ro, shown } = await sentEstimate();
    const version = await db.app
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .select("estimate_version.snapshot")
      .where("estimate.repair_order_id", "=", ro)
      .executeTakeFirstOrThrow();
    const snapshot = version.snapshot as EstimateSnapshot;
    expect(snapshot.schema).toBe(3);
    expect(snapshot.jobs.map((job) => job.finding)).toEqual([
      { customerNote: "CUSTOMER-NOTE: pads are at 2 mm", faultCodes: ["C1234", "B0001"], photoIds: [shown] },
      null,
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("INTERNAL-NOTE-SECRET");
  });

  it("a photo comes only through an open link, only if it is in the snapshot and still shared; every refusal is the same 404", async () => {
    const { ro, shown, internal } = await sentEstimate();
    const other = await sentEstimate();
    const { token, linkId } = (await create(ro)).result;
    const get = (photoId: string, t = token) =>
      handlers.customerLinkPhoto(
        new Request(`${BASE}/c/${t}/photo/${photoId}`, { headers: { "x-forwarded-for": freshIp() } }),
        t,
        photoId,
      );
    const ok = await get(shown);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");

    const refusals = [
      await get(internal),
      await get(other.shown),
      await get(randomUUID()),
      await get(shown, "x".repeat(43)),
    ];
    for (const response of refusals) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
    // What the snapshot lists stays shared: once the estimate is sent, neither the command nor the database lets
    // a photo's visibility change (the link still re-checks it on every request).
    await expect(setFindingPhotoVisibility(db.app, people.advisor!, shown, "internal")).rejects.toMatchObject(
      {
        code: "inspection_closed",
      },
    );
    await expect(
      sql`UPDATE media_asset SET visibility = 'internal' WHERE id = ${shown}`.execute(db.owner),
    ).rejects.toThrow(/cannot change/);
    expect((await get(shown)).status).toBe(200);
    await revokeCustomerLink(db.app, people.advisor!, linkId);
    expect(await customerLinkPhoto(db.app, token, shown, visitor())).toBeNull();
  });

  // --- AC2-04 ----------------------------------------------------------------------------------

  it("AC2-04: unknown, malformed, revoked, expired and closed-order links all get the identical page with no vehicle or customer data", async () => {
    const unknown = "Z".repeat(43);
    const malformed = "not-a-token";

    const revoked = await sentEstimate();
    const revokedLink = (await create(revoked.ro)).result;
    await revokeCustomerLink(db.app, people.advisor!, revokedLink.linkId);

    const expired = await sentEstimate();
    const expiredLink = (await create(expired.ro)).result;
    await overdue(expired.versionId);

    const endedTokens: string[] = [];
    for (const status of ["delivered", "closed", "cancelled"]) {
      const ended = await sentEstimate();
      endedTokens.push((await create(ended.ro)).result.token);
      await db.owner.transaction().execute(async (tx) => {
        await sql`ALTER TABLE repair_order DISABLE TRIGGER USER`.execute(tx);
        await sql`UPDATE repair_order SET status = ${status} WHERE id = ${ended.ro}`.execute(tx);
        await sql`ALTER TABLE repair_order ENABLE TRIGGER USER`.execute(tx);
      });
    }

    const pages: string[] = [];
    for (const token of [unknown, malformed, revokedLink.token, expiredLink.token, ...endedTokens]) {
      const page = await open(token);
      expect(page).toEqual({ kind: "invalid" });
      // The token appears in nothing but the page's own state, so the markup is compared without it.
      pages.push(html(page, "TOKEN"));
    }
    expect(new Set(pages).size).toBe(1);
    expect(pages[0]).toContain("This link is no longer valid");
    for (const text of ["Toyota", "Land Cruiser", "Mariam", "LK", "Test Garage"])
      expect(pages[0]).not.toContain(text);
  });

  it("AC2-02 (page): a withdrawn version says it was updated and shows nothing of the newer version", async () => {
    const { ro } = await sentEstimate();
    const { token } = (await create(ro)).result;
    await withdrawVersion(db.app, people.advisor!, ro, { reasonCode: "needs_changes" }, randomUUID());
    // v2 is drafted and sent with a new job; the old link must not reveal it.
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const job = (await addJob(db.app, people.advisor!, ro, { title: "V2-ONLY-JOB" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, job, { itemId: items.labor, qty: "1" }, randomUUID());
    const page = await open(token);
    expect(page).toEqual({ kind: "updated" });
    const markup = html(page, token);
    expect(markup).toContain("This estimate has been updated");
    expect(markup).toContain("Please use the latest link from the garage.");
    expect(markup).not.toContain("V2-ONLY-JOB");
    expect(markup).not.toContain("Toyota");
  });

  it("after the customer decided in person, the link shows the decisions read-only", async () => {
    const { ro, versionId, contentHash } = await sentEstimate();
    const { token } = (await create(ro)).result;
    const revisions = await db.app
      .selectFrom("job_revision")
      .select("id")
      .where("proposed_in_version_id", "=", versionId)
      .orderBy("id")
      .execute();
    await recordInPersonApproval(
      db.app,
      storage,
      people.advisor!,
      {
        versionId,
        contentHash,
        language: "en",
        approverName: "Mariam",
        decisions: [
          { revisionId: revisions[0]!.id, decision: "approved" },
          { revisionId: revisions[1]!.id, decision: "declined" },
        ],
        signature: makePng(600, 200, 3),
      },
      randomUUID(),
    );
    const page = await open(token);
    expect(page.kind).toBe("estimate");
    if (page.kind !== "estimate") return;
    expect(page.estimate.status).toBe("closed");
    expect(page.estimate.pendingRevisionIds).toEqual([]);
    const markup = html(page, token);
    expect(markup).toContain("Approved");
    expect(markup).toContain("Declined");
    expect(markup).toContain("Every job in this estimate has been decided.");
    expect(markup).not.toMatch(/<form|<input|<button/);
  });

  it("§6.4 supersede: once a later version is sent, a decided version's link says the estimate was updated", async () => {
    const { ro, versionId, contentHash } = await sentEstimate();
    const { token } = (await create(ro)).result;
    const revisions = await db.app
      .selectFrom("job_revision")
      .select("id")
      .where("proposed_in_version_id", "=", versionId)
      .execute();
    await recordInPersonApproval(
      db.app,
      storage,
      people.advisor!,
      {
        versionId,
        contentHash,
        language: "en",
        approverName: "Mariam",
        decisions: revisions.map((r) => ({ revisionId: r.id, decision: "approved" as const })),
        signature: makePng(600, 200, 5),
      },
      randomUUID(),
    );
    expect((await open(token)).kind).toBe("estimate"); // v1 closed, nothing newer yet: read-only
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const job = (await addJob(db.app, people.advisor!, ro, { title: "V2-EXTRA-WORK" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, job, { itemId: items.labor, qty: "1" }, randomUUID());
    expect((await open(token)).kind).toBe("estimate"); // v2 only drafted: the customer has nothing newer
    // A link cannot be made over an unsent draft.
    await expect(create(ro)).rejects.toMatchObject({ code: "estimate_not_sent" });
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
    const page = await open(token);
    expect(page).toEqual({ kind: "updated" });
    expect(html(page, token)).not.toContain("V2-EXTRA-WORK");
  });

  it("AC2-05 on photos: a refused photo request counts as an invalid attempt; a blocked IP or a withdrawn version gets none", async () => {
    const { ro, shown, internal } = await sentEstimate();
    const { token } = (await create(ro)).result;
    const ip = freshIp();
    const invalidCount = async () =>
      (
        await db.app
          .selectFrom("customer_link_access")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("ip", "=", ip)
          .where("outcome", "=", "invalid")
          .executeTakeFirstOrThrow()
      ).n;
    expect(await customerLinkPhoto(db.app, token, shown, visitor(ip))).not.toBeNull();
    expect(await invalidCount()).toBe("0"); // a photo the page shows is not recorded
    expect(await customerLinkPhoto(db.app, token, internal, visitor(ip))).toBeNull(); // swapped photo id
    expect(await customerLinkPhoto(db.app, token, "not-a-uuid", visitor(ip))).toBeNull();
    expect(await customerLinkPhoto(db.app, "P".repeat(43), shown, visitor(ip))).toBeNull(); // modified token
    expect(await invalidCount()).toBe("3");
    for (let i = 0; i < 8; i++) await customerLinkPhoto(db.app, `${"P".repeat(42)}${i}`, shown, visitor(ip));
    expect(await customerLinkPhoto(db.app, token, shown, visitor(ip))).toBeNull(); // blocked now
    expect(await open(token, visitor(ip))).toEqual({ kind: "blocked" });

    await withdrawVersion(db.app, people.advisor!, ro, { reasonCode: "no_response" }, randomUUID());
    expect(await customerLinkPhoto(db.app, token, shown, visitor())).toBeNull();
  });

  // --- AC2-05 ----------------------------------------------------------------------------------

  it("AC2-05: a modified token is invalid, and more than the configured invalid attempts from one IP in 10 minutes block it", async () => {
    const { ro } = await sentEstimate();
    const { token } = (await create(ro)).result;
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const ip = freshIp();
    expect(await open(tampered, visitor(ip))).toEqual({ kind: "invalid" });
    for (let i = 0; i < 10; i++) await open(`${"Q".repeat(42)}${i}`, visitor(ip));
    // 11 invalid attempts recorded (more than the default 10): this IP is blocked, even with the valid token.
    expect(await open(token, visitor(ip))).toEqual({ kind: "blocked" });
    expect(html({ kind: "blocked" }, token)).toContain("Too many attempts");
    // Blocked requests are not recorded, so a flood writes nothing.
    const count = async () =>
      (
        await db.app
          .selectFrom("customer_link_access")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("ip", "=", ip)
          .executeTakeFirstOrThrow()
      ).n;
    const before = await count();
    await open(tampered, visitor(ip));
    expect(await count()).toBe(before);
    // Another IP is not affected.
    expect((await open(token)).kind).toBe("estimate");
    // Temporarily: once the attempts are older than 10 minutes, the IP is let through again.
    // (As the owner: the app role cannot change access records; the guard only stamps inserts.)
    await sql`UPDATE customer_link_access SET at = now() - interval '11 minutes' WHERE ip = ${ip}`.execute(
      db.owner,
    );
    expect((await open(token, visitor(ip))).kind).toBe("estimate");
  });

  it("AC2-05: the invalid-attempt limit and the per-link limit are settings", async () => {
    const { ro } = await sentEstimate();
    const { token } = (await create(ro)).result;
    await setting("link.invalid_per_ip_10min", "2");
    try {
      const ip = freshIp();
      for (let i = 0; i < 3; i++) await open(`${"R".repeat(42)}${i}`, visitor(ip));
      expect(await open(token, visitor(ip))).toEqual({ kind: "blocked" });
    } finally {
      await setting("link.invalid_per_ip_10min", "10");
    }
    await setting("link.requests_per_link_10min", "3");
    try {
      for (let i = 0; i < 3; i++) expect((await open(token)).kind).toBe("estimate");
      expect(await open(token)).toEqual({ kind: "blocked" }); // from any IP: the link itself is resting
    } finally {
      await setting("link.requests_per_link_10min", "60");
    }
  });

  it("records each opening with IP and browser, audited; staff see how often and when it was opened", async () => {
    const { ro } = await sentEstimate();
    const { token, linkId } = (await create(ro)).result;
    expect((await customerLinkStatus(db.app, ro)).live).toMatchObject({
      linkId,
      opens: 0,
      lastOpenedAt: null,
    });
    const ip = freshIp();
    await open(token, { ip, userAgent: "Mozilla/5.0 (iPhone)" });
    await open(token);
    const rows = await db.app
      .selectFrom("customer_link_access")
      .select(["outcome", "ip", "user_agent"])
      .where("customer_link_id", "=", linkId)
      .orderBy("at")
      .execute();
    expect(rows[0]).toEqual({ outcome: "opened", ip, user_agent: "Mozilla/5.0 (iPhone)" });
    expect(rows).toHaveLength(2);
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["actor_label", "details"])
      .where("action", "=", "link.opened")
      .where("entity_id", "=", linkId)
      .execute();
    expect(audit).toHaveLength(2);
    // The audit points at the access record; the IP itself stays where it can be purged (P1-09).
    expect(audit[0]).toMatchObject({ actor_label: "anonymous", details: { accessId: expect.any(String) } });
    expect(JSON.stringify(audit)).not.toContain(ip);
    const status = await customerLinkStatus(db.app, ro);
    expect(status.canCreate).toBe(true);
    expect(status.live).toMatchObject({ linkId, opens: 2, createdByName: expect.any(String) });
    expect(status.live!.lastOpenedAt).toBeInstanceOf(Date);
  });

  it("takes the IP the trusted proxy appended, never one the client wrote first (T-42), and caps what it keeps", () => {
    // The client forges a first entry; the proxy appends the address it saw.
    const forged = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7", "user-agent": "UA" });
    expect(requesterFrom(forged)).toEqual({ ip: "203.0.113.7", userAgent: "UA" });
    // Two trusted proxies: the outer one's entry counts.
    expect(requesterFrom(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 10.0.0.2" }), 2).ip).toBe(
      "203.0.113.7",
    );
    // x-real-ip is client-controlled without a proxy that sets it: ignored.
    expect(requesterFrom(new Headers({ "x-real-ip": "203.0.113.8" })).ip).toBe("unknown");
    expect(requesterFrom(new Headers({ "x-forwarded-for": "203.0.113.9" }), 2).ip).toBe("unknown");
    expect(requesterFrom(new Headers()).ip).toBe("unknown");
    expect(requesterFrom(new Headers({ "user-agent": "x".repeat(900) })).userAgent).toHaveLength(500);
  });

  it("a forged first x-forwarded-for entry does not escape the invalid-attempt block (AC2-05)", async () => {
    const proxySaw = freshIp();
    for (let i = 0; i < 11; i++) {
      const forgedFirst = `10.9.${i}.1`;
      await openCustomerLink(
        db.app,
        `${"F".repeat(42)}${i}`,
        requesterFrom(new Headers({ "x-forwarded-for": `${forgedFirst}, ${proxySaw}` })),
      );
    }
    const { ro } = await sentEstimate();
    const { token } = (await create(ro)).result;
    expect(
      await openCustomerLink(
        db.app,
        token,
        requesterFrom(new Headers({ "x-forwarded-for": `8.8.8.8, ${proxySaw}` })),
      ),
    ).toEqual({ kind: "blocked" });
  });

  it("masks short plates completely and shows at most two trailing digits (T-43)", () => {
    expect(["7", "45", "123", "1234", "12345"].map(maskPlateNumber)).toEqual([
      "•••",
      "•••",
      "•••",
      "•••4",
      "•••45",
    ]);
  });

  it("greets by first name, keeping compound names whole", async () => {
    const { firstName } = await import("../src/server/links/customer");
    expect(firstName("عبد الله الحمادي")).toBe("عبد الله");
    expect(firstName("Abdul Rahman Saeed")).toBe("Abdul Rahman");
    expect(firstName("أبو بكر")).toBe("أبو بكر");
    expect(firstName("  Mariam   Haddad ")).toBe("Mariam");
    expect(firstName("عبد")).toBe("عبد");
    expect(firstName(null)).toBeNull();
  });

  it("link pages are never indexed, cached or sent as a referrer (§6.4)", async () => {
    const rules = await nextConfig.headers!();
    for (const source of ["/:locale(ar|en)/c/:token", "/c/:path*"]) {
      const rule = rules.find((r) => r.source === source);
      expect(rule?.headers).toEqual(
        expect.arrayContaining([
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ]),
      );
    }
  });
});
