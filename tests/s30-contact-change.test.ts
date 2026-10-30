import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { createHandlers } from "../src/server/http/handlers";
import { recordLinkApproval } from "../src/server/links/approval";
import { createCustomerLink } from "../src/server/links/commands";
import { openCustomerLink } from "../src/server/links/customer";
import { LocalDiskStorage } from "../src/server/media/storage";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { changeContact, contactHistory, type ContactChangeInput } from "../src/server/repair-order/contact";
import { createVehicle } from "../src/server/vehicle/service";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I2-06 — authorized contact change (Final Consistency Review F-10, Amendment A.4, v0.2.1 §3.7, T-08): verified in
 * person or by callback (OD-64), authorized by the owner or the current contact (OD-65), with a reason (OD-67);
 * applying it revokes every live customer link in the same transaction, and later approvals record the new contact.
 */

describe("S30 — authorized contact change", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  let laborId = "";
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  let ipCounter = 0;
  const visitor = () => ({ ip: `192.0.2.${++ipCounter}`, userAgent: "UA" });
  /** A Dubai wall-clock time, as a datetime-local field sends it, `minutesAgo` before now. */
  const dubaiLocal = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000 + 4 * 3_600_000).toISOString().slice(0, 16);

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-contact-"));
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
    laborId = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "labor_rate",
          code: "LAB-C",
          nameEn: "Labour",
          nameAr: "عمالة",
          price: "200.00",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  /**
   * A repair order whose owner is "Khalid" (mobile 0552…) and whose contact is the driver "Sami" (0553…), with a
   * sent estimate of one job and a live customer link.
   */
  async function withLink() {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const ownerMobile = `0552${String(counter).padStart(6, "0")}`;
    const driverMobile = `0553${String(counter).padStart(6, "0")}`;
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Khalid Owner${counter}`,
          mobile: ownerMobile,
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
          make: "Lexus",
          model: "LX",
          year: 2023,
          plate: { emirate: "sharjah", code: "CC", number: String(50000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      contactName: `Sami Driver${counter}`,
      contactMobile: driverMobile,
      contactRelationship: "driver",
      odometerKm: 10000,
      concerns: "Service",
      photoShortfallReason: "Test fixture",
    });
    const ro = (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const job = (await addJob(db.app, people.advisor!, ro, { title: "Service" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, job, { itemId: laborId, qty: "1" }, randomUUID());
    const { versionId } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const link = (await createCustomerLink(db.app, people.advisor!, ro)).result;
    const revisionId = (
      await db.app
        .selectFrom("job_revision")
        .select("id")
        .where("proposed_in_version_id", "=", versionId)
        .executeTakeFirstOrThrow()
    ).id;
    return {
      ro,
      versionId,
      revisionId,
      link,
      owner: { name: `Khalid Owner${counter}`, mobile: ownerMobile },
      driver: { name: `Sami Driver${counter}`, mobile: driverMobile },
    };
  }

  type Fixture = Awaited<ReturnType<typeof withLink>>;
  const callbackInput = (x: Fixture, overrides: Partial<ContactChangeInput> = {}): ContactChangeInput => ({
    expectedName: x.driver.name,
    expectedMobile: x.driver.mobile,
    expectedRelationship: "driver",
    newName: "Khalid (owner)",
    newMobile: x.owner.mobile,
    newRelationship: "owner",
    reason: "Owner taking over from the driver",
    authorizedBy: "owner",
    verification: "callback",
    calledAt: dubaiLocal(5),
    spokenTo: "Khalid",
    ...overrides,
  });
  const change = (x: Fixture, input: ContactChangeInput, key = randomUUID(), who = people.advisor!) =>
    changeContact(db.app, storage, who, x.ro, input, key);
  const contactOf = (ro: string) =>
    db.app
      .selectFrom("repair_order")
      .select(["contact_name", "contact_mobile", "contact_relationship"])
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
  const changesOf = (ro: string) =>
    db.app.selectFrom("contact_change").selectAll().where("repair_order_id", "=", ro).execute();

  // --- Changing the contact ---------------------------------------------------------------------

  it("by callback to the owner's number on file: the contact changes, every live link is revoked, all audited (F-10)", async () => {
    const x = await withLink();
    const outcome = await change(x, callbackInput(x));
    expect(outcome.result.linksRevoked).toBe(1);
    expect(await contactOf(x.ro)).toEqual({
      contact_name: "Khalid (owner)",
      contact_mobile: x.owner.mobile,
      contact_relationship: "owner",
    });
    const [row] = await changesOf(x.ro);
    expect(row).toMatchObject({
      old_name: x.driver.name,
      old_mobile: x.driver.mobile,
      old_relationship: "driver",
      reason: "Owner taking over from the driver",
      authorized_by: "owner",
      verification: "callback",
      called_number: x.owner.mobile, // OD-65: the authorizing person's number on file, not one typed in
      spoken_to: "Khalid",
      changed_by: people.advisor!.userId,
      signature_sha256: null,
    });
    const link = await db.app
      .selectFrom("customer_link")
      .select(["revoked_at", "revoke_reason", "revoked_by"])
      .where("id", "=", x.link.linkId)
      .executeTakeFirstOrThrow();
    expect(link).toMatchObject({ revoke_reason: "contact_changed", revoked_by: people.advisor!.userId });
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["action", "entity_id", "before_state", "after_state"])
      .where("action", "in", ["ro.contact_changed", "link.revoked"])
      .where("entity_id", "in", [x.ro, x.link.linkId])
      .orderBy("seq")
      .execute();
    expect(audit.map((row) => [row.action, row.entity_id])).toEqual([
      ["ro.contact_changed", x.ro],
      ["link.revoked", x.link.linkId],
    ]);
    expect(audit[0]!.before_state).toMatchObject({ name: x.driver.name, relationship: "driver" });
    expect(audit[0]!.after_state).toMatchObject({ name: "Khalid (owner)", relationship: "owner" });
    expect((await contactHistory(db.app, x.ro))[0]).toMatchObject({
      newName: "Khalid (owner)",
      spokenTo: "Khalid",
    });
  });

  it("T-08: after the change the old link shows the invalid page and no approval can be made through it", async () => {
    const x = await withLink();
    await change(x, callbackInput(x));
    expect(await openCustomerLink(db.app, x.link.token, visitor())).toEqual({ kind: "invalid" });
    expect(
      await recordLinkApproval(
        db.app,
        x.link.token,
        {
          approverName: "Sami",
          decisions: [{ revisionId: x.revisionId, decision: "approved" }],
          language: "en",
        },
        visitor(),
        randomUUID(),
      ),
    ).toEqual({ kind: "refused", page: "invalid" });
    expect(
      await db.app
        .selectFrom("approval_event")
        .select("id")
        .where("estimate_version_id", "=", x.versionId)
        .execute(),
    ).toEqual([]);
  });

  it("in person, authorized by the current contact: the signature is kept; a new link's approval records the new contact (A.4)", async () => {
    const x = await withLink();
    await change(x, {
      expectedName: x.driver.name,
      expectedMobile: x.driver.mobile,
      expectedRelationship: "driver",
      newName: "Huda Manager",
      newMobile: "0501234567",
      newRelationship: "company_representative",
      reason: "Company fleet manager takes over",
      authorizedBy: "current_contact",
      verification: "in_person",
      signerName: "Sami",
      signature: makePng(600, 200, counter),
    });
    const [row] = await changesOf(x.ro);
    expect(row).toMatchObject({ verification: "in_person", signer_name: "Sami", called_number: null });
    expect(row!.signature_storage_key).toMatch(/^signatures\//);
    expect(await storage.get(row!.signature_storage_key!)).not.toBeNull();

    const fresh = (await createCustomerLink(db.app, people.advisor!, x.ro)).result;
    const outcome = await recordLinkApproval(
      db.app,
      fresh.token,
      {
        approverName: "Huda",
        decisions: [{ revisionId: x.revisionId, decision: "approved" }],
        language: "en",
      },
      visitor(),
      randomUUID(),
    );
    expect(outcome.kind).toBe("recorded");
    const event = await db.app
      .selectFrom("approval_event")
      .select(["contact_name", "contact_mobile"])
      .where("estimate_version_id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ contact_name: "Huda Manager", contact_mobile: "0501234567" });
  });

  it("a callback authorized by the current contact goes to the current contact's number", async () => {
    const x = await withLink();
    await change(x, callbackInput(x, { authorizedBy: "current_contact", spokenTo: "Sami" }));
    expect((await changesOf(x.ro))[0]).toMatchObject({ called_number: x.driver.mobile });
  });

  // --- Refusals -----------------------------------------------------------------------------------

  it("refuses a stale form, a call outside the last 24 hours or in the future, and incomplete input — writing nothing", async () => {
    const x = await withLink();
    const refusals: [Partial<ContactChangeInput>, Record<string, unknown>][] = [
      [{ expectedName: "Someone else" }, { code: "contact_changed" }],
      [{ calledAt: dubaiLocal(25 * 60) }, { details: { field: "calledAt" } }],
      [{ calledAt: dubaiLocal(-30) }, { details: { field: "calledAt" } }],
      [{ calledAt: "yesterday" }, { details: { field: "calledAt" } }],
      [{ spokenTo: " " }, { details: { field: "spokenTo" } }],
      [{ reason: "" }, { details: { field: "reason" } }],
      [{ newName: "" }, { details: { field: "newName" } }],
      [{ newMobile: "12" }, { details: { field: "newMobile" } }],
      [{ newRelationship: "cousin" }, { details: { field: "newRelationship" } }],
      [{ authorizedBy: "neighbour" }, { details: { field: "authorizedBy" } }],
      [{ verification: "email" }, { details: { field: "verification" } }],
      [
        { verification: "in_person", signerName: "Sami", signature: new Uint8Array([1, 2, 3]) },
        { details: { field: "signature" } },
      ],
      [
        { verification: "in_person", signerName: "", signature: makePng(600, 200, 1) },
        { details: { field: "signerName" } },
      ],
    ];
    for (const [overrides, expected] of refusals) {
      await expect(change(x, callbackInput(x, overrides))).rejects.toMatchObject(expected);
    }
    expect(await changesOf(x.ro)).toEqual([]);
    expect((await contactOf(x.ro)).contact_name).toBe(x.driver.name);
    expect((await openCustomerLink(db.app, x.link.token, visitor())).kind).toBe("estimate"); // link untouched
  });

  it("refuses a change once the car is delivered, closed or cancelled", async () => {
    const x = await withLink();
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE repair_order DISABLE TRIGGER USER`.execute(tx);
      await sql`UPDATE repair_order SET status = 'delivered' WHERE id = ${x.ro}`.execute(tx);
      await sql`ALTER TABLE repair_order ENABLE TRIGGER USER`.execute(tx);
    });
    await expect(change(x, callbackInput(x))).rejects.toMatchObject({ code: "repair_order_closed" });
    // The database refuses it on its own too, whatever the command checked.
    await expect(
      db.app
        .insertInto("contact_change")
        .values({
          repair_order_id: x.ro,
          old_name: x.driver.name,
          old_mobile: x.driver.mobile,
          old_relationship: "driver",
          new_name: "Late",
          new_mobile: "0501230000",
          new_relationship: "other",
          reason: "test",
          authorized_by: "owner",
          verification: "callback",
          called_number: x.owner.mobile,
          called_at: new Date(),
          spoken_to: "Khalid",
          idempotency_key: randomUUID(),
          changed_by: people.advisor!.userId,
        })
        .execute(),
    ).rejects.toThrow(/delivered, closed or cancelled/);
    expect(await changesOf(x.ro)).toEqual([]);
  });

  it("a form that showed another relationship is stale, and a change to the same contact is refused", async () => {
    const x = await withLink();
    // Someone changes only the relationship (same name and mobile).
    await change(
      x,
      callbackInput(x, { newName: x.driver.name, newMobile: x.driver.mobile, newRelationship: "other" }),
    );
    // A form still showing "driver" is stale.
    await expect(change(x, callbackInput(x))).rejects.toMatchObject({ code: "contact_changed" });
    // Changing to exactly the current contact would only revoke links: refused.
    await expect(
      change(
        x,
        callbackInput(x, {
          expectedRelationship: "other",
          newName: x.driver.name,
          newMobile: x.driver.mobile,
          newRelationship: "other",
          authorizedBy: "current_contact",
        }),
      ),
    ).rejects.toMatchObject({ details: { field: "newName", reason: "unchanged" } });
    expect(await changesOf(x.ro)).toHaveLength(1);
  });

  it("over HTTP a stale form and a closed repair order answer 409 with their codes", async () => {
    const x = await withLink();
    const post = async (input: ContactChangeInput) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(input)) body.set(key, String(value));
      body.set("idempotencyKey", randomUUID());
      const response = await handlers.changeRepairOrderContact(
        new Request(`${BASE}/api/repair-orders/${x.ro}/contact`, {
          method: "POST",
          body,
          headers: cookie(people.advisor!.token),
        }),
        x.ro,
      );
      return { status: response.status, body: (await response.json()) as { error: string } };
    };
    expect(await post(callbackInput(x, { expectedName: "Stale" }))).toMatchObject({
      status: 409,
      body: { error: "contact_changed" },
    });
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE repair_order DISABLE TRIGGER USER`.execute(tx);
      await sql`UPDATE repair_order SET status = 'closed' WHERE id = ${x.ro}`.execute(tx);
      await sql`ALTER TABLE repair_order ENABLE TRIGGER USER`.execute(tx);
    });
    expect(await post(callbackInput(x))).toMatchObject({
      status: 409,
      body: { error: "repair_order_closed" },
    });
  });

  it("only advisors, managers and partners change the contact; a technician or store keeper gets 403, audited", async () => {
    const x = await withLink();
    const form = () => {
      const body = new FormData();
      for (const [key, value] of Object.entries(callbackInput(x))) body.set(key, String(value));
      body.set("idempotencyKey", randomUUID());
      return body;
    };
    for (const who of ["tech", "store"] as const) {
      const response = await handlers.changeRepairOrderContact(
        new Request(`${BASE}/api/repair-orders/${x.ro}/contact`, {
          method: "POST",
          body: form(),
          headers: cookie(people[who]!.token),
        }),
        x.ro,
      );
      expect(response.status).toBe(403);
    }
    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .where("entity_id", "=", x.ro)
      .execute();
    expect(denied.map((row) => (row.details as { permission: string }).permission)).toEqual([
      "repair_order.change_contact",
      "repair_order.change_contact",
    ]);
    const ok = await handlers.changeRepairOrderContact(
      new Request(`${BASE}/api/repair-orders/${x.ro}/contact`, {
        method: "POST",
        body: form(),
        headers: cookie(people.manager!.token),
      }),
      x.ro,
    );
    expect(ok.status).toBe(201);
    expect(await changesOf(x.ro)).toHaveLength(1);
  });

  it("the same form sent twice records one change", async () => {
    const x = await withLink();
    const key = randomUUID();
    const first = await change(x, callbackInput(x), key);
    const again = await change(x, callbackInput(x), key);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(await changesOf(x.ro)).toHaveLength(1);
  });

  // --- Races --------------------------------------------------------------------------------------

  it("two changes from the same form state at once: one wins, the other is told the contact changed", async () => {
    const x = await withLink();
    const results = await Promise.allSettled([
      change(x, callbackInput(x, { newName: "First" })),
      change(x, callbackInput(x, { newName: "Second" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "contact_changed" },
    });
    expect(await changesOf(x.ro)).toHaveLength(1);
  });

  it("a contact change racing a link approval: the approval lands first with the old contact, or is refused", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await withLink();
      const [approval] = await Promise.all([
        recordLinkApproval(
          db.app,
          x.link.token,
          {
            approverName: "Sami",
            decisions: [{ revisionId: x.revisionId, decision: "approved" }],
            language: "en",
          },
          visitor(),
          randomUUID(),
        ),
        change(x, callbackInput(x)),
      ]);
      const events = await db.app
        .selectFrom("approval_event")
        .select(["contact_name", "recorded_at"])
        .where("estimate_version_id", "=", x.versionId)
        .execute();
      if (approval.kind === "recorded") {
        expect(events).toEqual([{ contact_name: x.driver.name, recorded_at: expect.any(Date) }]);
      } else {
        expect(approval).toEqual({ kind: "refused", page: "invalid" });
        expect(events).toEqual([]);
      }
    }
  });

  // --- The database's own guard -------------------------------------------------------------------

  it("the database: no direct contact update, and a change must start from the current contact with a real callback number", async () => {
    const x = await withLink();
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET contact_name = 'Mallory' WHERE id = '${x.ro}'`))
        ?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "UPDATE contact_change SET reason = 'x'"))?.code).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, "DELETE FROM contact_change"))?.code).toBe("42501");
    const row = (overrides: Record<string, unknown>) => ({
      repair_order_id: x.ro,
      old_name: x.driver.name,
      old_mobile: x.driver.mobile,
      old_relationship: "driver" as const,
      new_name: "Mallory",
      new_mobile: "0509999999",
      new_relationship: "other" as const,
      reason: "test",
      authorized_by: "owner" as const,
      verification: "callback" as const,
      called_number: x.owner.mobile,
      called_at: new Date(),
      spoken_to: "Khalid",
      idempotency_key: randomUUID(),
      changed_by: people.advisor!.userId,
      ...overrides,
    });
    const insert = (overrides: Record<string, unknown>) =>
      db.app.insertInto("contact_change").values(row(overrides)).execute();
    await expect(insert({ called_number: "0500000000" })).rejects.toThrow(/mobile on file/);
    await expect(insert({ old_name: "Not the contact" })).rejects.toThrow(/current contact/);
    await expect(insert({ called_at: new Date(Date.now() - 25 * 3_600_000) })).rejects.toThrow(/24 hours/);
    await expect(insert({ spoken_to: null })).rejects.toThrow(/contact_change_check/);
    await expect(
      insert({ verification: "in_person", signer_name: "Sami", signature_sha256: "a".repeat(64) }),
    ).rejects.toThrow(/contact_change_check/);
    expect(await changesOf(x.ro)).toEqual([]);
    expect((await contactOf(x.ro)).contact_name).toBe(x.driver.name);
  });
});
