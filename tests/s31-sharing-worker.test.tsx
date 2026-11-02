import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { withdrawVersion } from "../src/server/estimate/versions";
import { createHandlers } from "../src/server/http/handlers";
import { createCustomerLink } from "../src/server/links/commands";
import { markMessageShared, prepareReadyMessage } from "../src/server/messages/commands";
import { notInformed } from "../src/server/messages/queries";
import { whatsAppUrl } from "../src/server/messages/text";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { setBusinessProfile } from "../src/server/settings/business-profile";
import { createVehicle } from "../src/server/vehicle/service";
import { createWorker } from "../src/server/worker/worker";
import { workshopBoard } from "../src/server/workshop/queries";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I2-09 — staff-initiated sharing and the background worker (PRD v0.2 E9-S2, AC2-28, OD-68–OD-71): the estimate
 * message prepared with its link, the car-ready message, "I sent it", "Customer not yet informed" after 15 minutes,
 * and the worker that processes the outbox and expires overdue estimates.
 */

describe("S31 — sharing and the worker", () => {
  let db: TestDatabase;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  let laborId = "";
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });

  beforeAll(async () => {
    db = await createTestDatabase();
    handlers = createHandlers(db.app);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
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
        legalNameEn: "Share Garage LLC",
        legalNameAr: "كراج المشاركة",
        addressEn: "Sharjah",
        addressAr: "الشارقة",
        phone: "065550001",
      },
      randomUUID(),
    );
    laborId = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "labor_rate",
          code: "LAB-S",
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
  });

  let counter = 0;
  /** A sent estimate for "Noura" (contact, mobile 0554…, preferred language as given) on a Mazda CX-5. */
  async function sentEstimate(preferredLanguage: "ar" | "en" = "en") {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const mobile = `0554${String(counter).padStart(6, "0")}`;
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        { nameEn: `Noura Share${counter}`, mobile, preferredLanguage, marketingConsent: false },
        randomUUID(),
      )
    ).result.customerId;
    const vehicleId = (
      await createVehicle(
        db.app,
        advisor,
        {
          make: "Mazda",
          model: "CX-5",
          year: 2022,
          plate: { emirate: "sharjah", code: "SH", number: String(30000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      contactName: `Noura${counter}`,
      odometerKm: 20000,
      concerns: "Service",
      photoShortfallReason: "Test fixture",
    });
    const ro = (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const job = (await addJob(db.app, people.advisor!, ro, { title: "Service" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, job, { itemId: laborId, qty: "1" }, randomUUID());
    const { versionId } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    return { ro, versionId, mobile, contact: `Noura${counter}` };
  }
  const link = (ro: string) =>
    createCustomerLink(db.app, people.advisor!, ro, { baseUrl: "https://garage.example" });
  const messagesOf = (ro: string) =>
    db.app
      .selectFrom("customer_message")
      .selectAll()
      .where("repair_order_id", "=", ro)
      .orderBy("prepared_at")
      .execute();
  /** Moves a message's preparation back in time (as the owner: the app may not). */
  const age = (messageId: string, minutes: number) =>
    sql`UPDATE customer_message SET prepared_at = now() - make_interval(mins => ${minutes}) WHERE id = ${messageId}`.execute(
      db.owner,
    );
  async function setStatus(ro: string, status: string) {
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE repair_order DISABLE TRIGGER USER`.execute(tx);
      await sql`UPDATE repair_order SET status = ${status} WHERE id = ${ro}`.execute(tx);
      await sql`ALTER TABLE repair_order ENABLE TRIGGER USER`.execute(tx);
    });
  }
  const boardFlag = async (ro: string) =>
    (await workshopBoard(db.app)).find((order) => order.id === ro)?.customerNotInformed;

  // --- The estimate message -------------------------------------------------------------------------

  it("creating a link prepares the message in the customer's language, with the link — stored with [link] only", async () => {
    const x = await sentEstimate("ar");
    const { token, message } = (await link(x.ro)).result;
    expect(message.language).toBe("ar");
    expect(message.bodies.ar).toContain(`https://garage.example/ar/c/${token}`);
    expect(message.bodies.en).toContain(`https://garage.example/en/c/${token}`);
    expect(message.bodies.ar).toContain(`مرحباً ${x.contact}`);
    expect(message.bodies.ar).toContain("Mazda CX-5");
    expect(message.bodies.ar).toContain("كراج المشاركة");
    expect(message.bodies.en).toContain("The estimate for your Mazda CX-5 is ready");
    expect(message.bodies.en).toContain("Share Garage LLC");
    // Never the plate or an amount (rule 9, OD-68).
    for (const body of Object.values(message.bodies)) {
      expect(body).not.toContain(String(30000 + counter));
      expect(body).not.toMatch(/AED|د\.إ|200\.00/);
    }
    expect(message.whatsApp.ar).toBe(
      `https://wa.me/971${x.mobile.slice(1)}?text=${encodeURIComponent(message.bodies.ar)}`,
    );

    const [row] = await messagesOf(x.ro);
    expect(row).toMatchObject({
      kind: "estimate_link",
      language: "ar",
      recipient_mobile: x.mobile,
      shared_at: null,
    });
    // Both texts as the advisor saw them, the link stored only as [link].
    expect(row!.body_ar).toBe(message.bodies.ar.replace(`https://garage.example/ar/c/${token}`, "[link]"));
    expect(row!.body_en).toBe(message.bodies.en.replace(`https://garage.example/en/c/${token}`, "[link]"));
    // The token is nowhere in the database, the audit log included.
    for (const table of ["customer_message", "audit_event"] as const) {
      const dump = await sql<{
        t: string | null;
      }>`SELECT string_agg(x::text, '') AS t FROM ${sql.table(table)} x`.execute(db.owner);
      expect(dump.rows[0]!.t ?? "").not.toContain(token);
    }
    expect(
      await db.app
        .selectFrom("audit_event")
        .select("action")
        .where("entity_id", "=", message.messageId)
        .execute(),
    ).toEqual([{ action: "message.prepared" }]);
  });

  it('"I sent it" records the language actually sent, once; afterwards the message never changes', async () => {
    const x = await sentEstimate("en");
    const { message } = (await link(x.ro)).result;
    expect((await markMessageShared(db.app, people.advisor!, message.messageId, "ar")).result).toEqual({
      messageId: message.messageId,
      shared: true,
    });
    const [row] = await messagesOf(x.ro);
    expect(row).toMatchObject({ language: "ar", shared_by: people.advisor!.userId });
    // The texts are the ones prepared; "I sent it" only records which language went.
    expect(row!.body_ar).toContain("مرحباً");
    expect(row!.body_ar).toContain("[link]");
    expect(row!.shared_at).toBeInstanceOf(Date);
    expect((await markMessageShared(db.app, people.manager!, message.messageId, "en")).result.shared).toBe(
      false,
    );
    const actions = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("entity_id", "=", message.messageId)
      .orderBy("seq")
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      "message.prepared",
      "message.shared",
      "message.share_repeated",
    ]);
    // The database holds it too.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE customer_message SET language = 'en' WHERE id = '${message.messageId}'`,
        )
      )?.message,
    ).toMatch(/does not change/);
    expect(
      (await sqlErrorAs(db.appUrl, `DELETE FROM customer_message WHERE id = '${message.messageId}'`))?.code,
    ).toBe("42501");
    await expect(
      db.app
        .insertInto("customer_message")
        .values({
          repair_order_id: x.ro,
          kind: "estimate_link",
          customer_link_id: row!.customer_link_id,
          language: "en",
          body_ar: "[link]",
          body_en: "Open https://garage.example/en/c/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA [link]",
          recipient_mobile: x.mobile,
          prepared_by: people.advisor!.userId,
        })
        .execute(),
    ).rejects.toThrow(/customer_message_check/);
  });

  // --- AC2-28 ---------------------------------------------------------------------------------------

  it('AC2-28: prepared and not confirmed within 15 minutes shows "Customer not yet informed"; confirming clears it', async () => {
    const x = await sentEstimate();
    const { message } = (await link(x.ro)).result;
    expect(await boardFlag(x.ro)).toBe(false); // just prepared
    await age(message.messageId, 16);
    expect(await boardFlag(x.ro)).toBe(true);
    await markMessageShared(db.app, people.advisor!, message.messageId, "en");
    expect(await boardFlag(x.ro)).toBe(false);
  });

  it("AC2-28: the flag follows the newest message and stops once the version no longer waits for the customer", async () => {
    const x = await sentEstimate();
    const first = (await link(x.ro)).result.message;
    await age(first.messageId, 30);
    expect(await boardFlag(x.ro)).toBe(true);
    // A new link and message just prepared: the newest is fresh, so no flag yet.
    await link(x.ro);
    expect(await boardFlag(x.ro)).toBe(false);
    for (const row of await messagesOf(x.ro)) await age(row.id, 20);
    expect(await boardFlag(x.ro)).toBe(true);
    await withdrawVersion(db.app, people.advisor!, x.ro, { reasonCode: "needs_changes" }, randomUUID());
    expect(await boardFlag(x.ro)).toBe(false);
  });

  // --- The ready message ----------------------------------------------------------------------------

  it("the ready message only for a Ready car; flagged while Ready and unconfirmed, no longer once handed over", async () => {
    const x = await sentEstimate("en");
    await expect(prepareReadyMessage(db.app, people.advisor!, x.ro)).rejects.toMatchObject({
      code: "not_ready",
    });
    await setStatus(x.ro, "ready");
    const ready = (await prepareReadyMessage(db.app, people.advisor!, x.ro)).result;
    expect(ready.bodies.en).toBe(
      `Hello ${x.contact},\nYour Mazda CX-5 is ready for collection.\nShare Garage LLC`,
    );
    expect(ready.bodies.ar).toContain("جاهزة للاستلام");
    const row = (await messagesOf(x.ro)).find((m) => m.kind === "vehicle_ready")!;
    expect(row).toMatchObject({ customer_link_id: null, language: "en" });
    await age(ready.messageId, 16);
    expect((await notInformed(db.app, [x.ro])).has(x.ro)).toBe(true);
    await setStatus(x.ro, "delivered");
    expect((await notInformed(db.app, [x.ro])).has(x.ro)).toBe(false);
  });

  it("once a ready message was confirmed sent, preparing another left unsent does not raise the flag", async () => {
    const x = await sentEstimate();
    await setStatus(x.ro, "ready");
    const first = (await prepareReadyMessage(db.app, people.advisor!, x.ro)).result;
    await markMessageShared(db.app, people.advisor!, first.messageId, "en");
    const second = (await prepareReadyMessage(db.app, people.manager!, x.ro)).result;
    await age(second.messageId, 16);
    expect((await notInformed(db.app, [x.ro])).has(x.ro)).toBe(false);
  });

  it("an estimate message whose link was replaced cannot be confirmed sent: the newer one is the one to send", async () => {
    const x = await sentEstimate();
    const old = (await link(x.ro)).result.message;
    const fresh = (await link(x.ro)).result.message;
    await expect(markMessageShared(db.app, people.advisor!, old.messageId, "en")).rejects.toMatchObject({
      code: "message_superseded",
    });
    expect((await markMessageShared(db.app, people.advisor!, fresh.messageId, "en")).result.shared).toBe(
      true,
    );
    expect((await messagesOf(x.ro)).find((m) => m.id === old.messageId)?.shared_at).toBeNull();
  });

  it("an aged, unconfirmed estimate message on a version past its expiry (not yet swept) is not flagged", async () => {
    const x = await sentEstimate();
    const { message } = (await link(x.ro)).result;
    await age(message.messageId, 20);
    expect(await boardFlag(x.ro)).toBe(true);
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition`.execute(tx);
      await sql`UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = ${x.versionId}`.execute(
        tx,
      );
      await sql`ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition`.execute(tx);
    });
    expect(await boardFlag(x.ro)).toBe(false);
  });

  it("the database refuses a message inserted as already sent, and texts changed after preparing", async () => {
    const x = await sentEstimate();
    const { message } = (await link(x.ro)).result;
    const [row] = await messagesOf(x.ro);
    await expect(
      db.app
        .insertInto("customer_message")
        .values({
          repair_order_id: x.ro,
          kind: "vehicle_ready",
          language: "en",
          body_ar: "x",
          body_en: "x",
          recipient_mobile: x.mobile,
          prepared_by: people.advisor!.userId,
          shared_at: new Date(),
          shared_by: people.advisor!.userId,
        })
        .execute(),
    ).rejects.toThrow(/starts unsent/);
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE customer_message SET body_en = 'changed' WHERE id = '${message.messageId}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(row!.body_en).toContain("[link]");
  });

  it("text containing /c/ (a name, a model) is accepted; only a token-shaped link path is refused", async () => {
    const x = await sentEstimate();
    const row = (body: string) => ({
      repair_order_id: x.ro,
      kind: "vehicle_ready" as const,
      language: "en" as const,
      body_ar: body,
      body_en: body,
      recipient_mobile: x.mobile,
      prepared_by: people.advisor!.userId,
    });
    await db.app.insertInto("customer_message").values(row("Your A/c/B is ready")).execute();
    await expect(
      db.app
        .insertInto("customer_message")
        .values(row(`See /en/c/${"T".repeat(43)}`))
        .execute(),
    ).rejects.toThrow(/customer_message_check/);
  });

  it("links use PUBLIC_BASE_URL; without it only development falls back to the request's own address (T-46)", async () => {
    const { publicOrigin } = await import("../src/server/links/origin");
    expect(
      publicOrigin("http://localhost:5001", {
        PUBLIC_BASE_URL: "https://garage.example/",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("https://garage.example");
    expect(
      publicOrigin("http://192.168.1.20:5001", { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv),
    ).toBe("http://192.168.1.20:5001");
    expect(() =>
      publicOrigin("https://evil.example", { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(expect.objectContaining({ code: "public_url_missing" }));
    expect(() =>
      publicOrigin(null, { PUBLIC_BASE_URL: "https://garage.example/path" } as unknown as NodeJS.ProcessEnv),
    ).toThrow(expect.objectContaining({ code: "public_url_missing" }));
    expect(() => publicOrigin(null, { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toThrow(
      expect.objectContaining({ code: "public_url_missing" }),
    );
  });

  it("only advisors, managers and partners prepare or confirm messages; a technician gets 403, audited", async () => {
    const x = await sentEstimate();
    await setStatus(x.ro, "ready");
    const prepare = await handlers.prepareReadyMessage(
      new Request(`${BASE}/api/repair-orders/${x.ro}/messages/ready`, {
        method: "POST",
        headers: cookie(people.tech!.token),
      }),
      x.ro,
    );
    expect(prepare.status).toBe(403);
    const ready = (await prepareReadyMessage(db.app, people.advisor!, x.ro)).result;
    const confirm = await handlers.markMessageShared(
      new Request(`${BASE}/api/customer-messages/${ready.messageId}/shared`, {
        method: "POST",
        body: JSON.stringify({ language: "en" }),
        headers: { ...cookie(people.tech!.token), "content-type": "application/json" },
      }),
      ready.messageId,
    );
    expect(confirm.status).toBe(403);
    const denied = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "authz.denied")
      .where("entity_id", "in", [x.ro, ready.messageId])
      .execute();
    expect(denied.map((row) => (row.details as { permission: string }).permission)).toEqual([
      "message.share",
      "message.share",
    ]);
    const ok = await handlers.markMessageShared(
      new Request(`${BASE}/api/customer-messages/${ready.messageId}/shared`, {
        method: "POST",
        body: JSON.stringify({ language: "en" }),
        headers: { ...cookie(people.advisor!.token), "content-type": "application/json" },
      }),
      ready.messageId,
    );
    expect(ok.status).toBe(200);
  });

  it("WhatsApp numbers: UAE mobiles get 971; other countries are used as stored", () => {
    expect(whatsAppUrl("050 123 4567", "Hi")).toBe("https://wa.me/971501234567?text=Hi");
    expect(whatsAppUrl("+971 50 123 4567", "Hi")).toBe("https://wa.me/971501234567?text=Hi");
    expect(whatsAppUrl("00971501234567", "a b")).toBe("https://wa.me/971501234567?text=a%20b");
    expect(whatsAppUrl("+44 7700 900123", "Hi")).toBe("https://wa.me/447700900123?text=Hi");
  });

  // --- The worker ------------------------------------------------------------------------------------

  it("the worker expires overdue estimates on its own, at most once a minute", async () => {
    const x = await sentEstimate();
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition`.execute(tx);
      await sql`UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = ${x.versionId}`.execute(
        tx,
      );
      await sql`ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition`.execute(tx);
    });
    const worker = createWorker(db.app, { handlers: {} });
    const first = await worker.tick(1_000_000);
    expect(first.expired).toContain(x.versionId);
    const version = await db.app
      .selectFrom("estimate_version")
      .select("status")
      .where("id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(version.status).toBe("expired");
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["details", "actor_label"])
      .where("action", "=", "estimate.expired")
      .where("entity_id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_label: "system:estimate-expiry", details: { trigger: "scheduler" } });
    expect((await worker.tick(1_000_000 + 30_000)).expired).toBeNull(); // within the minute: no sweep
    expect((await worker.tick(1_000_000 + 60_000)).expired).toEqual([]);
  });

  it("the worker handles only topics it has a handler for; the others wait untouched", async () => {
    const insert = (topic: string) =>
      db.owner
        .insertInto("outbox_message")
        .values({ topic, payload: JSON.stringify({ n: 1 }), command_id: randomUUID() })
        .returning("id")
        .executeTakeFirstOrThrow();
    const waiting = await insert("alert.release_override");
    const handled = await insert("test.sharing_topic");
    const seen: string[] = [];
    const worker = createWorker(db.app, {
      handlers: { "test.sharing_topic": async (message) => void seen.push(message.id) },
    });
    const result = await worker.tick();
    expect(seen).toEqual([handled.id]);
    expect(result.failed).toBe(0);
    const rows = await db.owner
      .selectFrom("outbox_message")
      .select(["id", "attempts", "processed_at", "last_error"])
      .where("id", "in", [waiting.id, handled.id])
      .execute();
    expect(rows.find((r) => r.id === waiting.id)).toMatchObject({
      attempts: 0,
      processed_at: null,
      last_error: null,
    });
    expect(rows.find((r) => r.id === handled.id)?.processed_at).toBeInstanceOf(Date);
  });

  it("the worker runs on its interval and stops cleanly after the tick in progress", async () => {
    const ticks: string[] = [];
    const worker = createWorker(db.app, {
      intervalMs: 10,
      handlers: { "test.loop_topic": async (message) => void ticks.push(message.id) },
    });
    const message = await db.owner
      .insertInto("outbox_message")
      .values({ topic: "test.loop_topic", payload: JSON.stringify({}), command_id: randomUUID() })
      .returning("id")
      .executeTakeFirstOrThrow();
    worker.start();
    const deadline = Date.now() + 5_000;
    while (ticks.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stop();
    expect(ticks).toEqual([message.id]);
  });
});
