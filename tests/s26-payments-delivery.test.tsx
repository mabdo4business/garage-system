import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo, type DemoResult } from "../scripts/demo-scenario";
import { SettlementView } from "../src/app/[locale]/(staff)/repair-orders/[id]/payments/settlement-view";
import { t, type Locale } from "../src/i18n";
import { SESSION_COOKIE } from "../src/server/auth/session";
import {
  balancesFor,
  type Settlement,
  deliverVehicle,
  recordPayment,
  releaseOverrides,
  settlementOf,
  type PaymentInput,
} from "../src/server/billing/payments";
import type { Staff } from "../src/server/estimate/commands";
import { createHandlers } from "../src/server/http/handlers";
import { LocalDiskStorage } from "../src/server/media/storage";
import { dashboardSummary } from "../src/server/reporting/dashboard";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-10 — payments and delivery: one payment per key (AC2-20, AT-03, AT-04), the "possible duplicate" confirmation
 * (AC2-20), no overpayment (AC2-21) even when racing, card and transfer references (AC2-22, OD-51), partial payments
 * to the fil (OD-52), delivery blocked by a balance unless a partner releases it with a reason (AC2-27, OD-53) with
 * the partner alert, the handover checklist (OD-54), Delivered → Closed at balance 0 (B1), insert-only records and
 * the database guards, authorization, and a lost response retried (F-07).
 */

describe("S26 — payments and delivery", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const tokens: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  let seeds = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-payments-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
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
      tokens[name] = decodeURIComponent(match?.[1] ?? "");
    }
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  /** A fresh demo scenario: its "ready" repair order has an issued invoice of 180.00 (one labour hour). */
  async function freshReady(): Promise<{ demo: DemoResult; ro: string; invoiceId: string; total: string }> {
    const demo = await seedDemo(db.app, storage, TEST_PASSWORD, { suffix: `.s26${++seeds}` });
    const ro = demo.repairOrders.ready!;
    const invoice = await db.app
      .selectFrom("invoice")
      .select(["id", "total"])
      .where("repair_order_id", "=", ro)
      .executeTakeFirstOrThrow();
    return { demo, ro, invoiceId: invoice.id, total: invoice.total };
  }
  const advisorOf = (demo: DemoResult): Staff => demo.users["demo.advisor"];
  const partnerOf = (demo: DemoResult): Staff => demo.users["demo.partner"];
  const pay = (staff: Staff, invoiceId: string, input: PaymentInput, key = randomUUID()) =>
    recordPayment(db.app, staff, invoiceId, input, key);
  const status = async (ro: string) =>
    (await db.app.selectFrom("repair_order").select("status").where("id", "=", ro).executeTakeFirstOrThrow())
      .status;
  const paymentCount = async (invoiceId: string) =>
    (await db.app.selectFrom("payment").select("id").where("invoice_id", "=", invoiceId).execute()).length;
  const handover = { keysReturned: true, belongingsReturned: true };

  it("AC2-20 / AT-03 / AT-04: one payment per key, also for three concurrent requests; another payload is refused", async () => {
    const { demo, invoiceId, total } = await freshReady();
    expect(total).toBe("180.00");
    const key = randomUUID();
    const input = { amount: "20.00", method: "cash" };
    const results = await Promise.all([1, 2, 3].map(() => pay(advisorOf(demo), invoiceId, input, key)));
    expect(new Set(results.map((outcome) => outcome.result.paymentId)).size).toBe(1);
    expect(results.filter((outcome) => !outcome.replayed)).toHaveLength(1);
    expect(await paymentCount(invoiceId)).toBe(1);
    await expect(
      pay(advisorOf(demo), invoiceId, { amount: "25.00", method: "cash" }, key),
    ).rejects.toMatchObject({
      code: "idempotency_payload_mismatch",
    });
    expect(await paymentCount(invoiceId)).toBe(1);
  });

  it("AC2-20: the same amount again within two minutes under a new key asks for confirmation first", async () => {
    const { demo, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "50.00", method: "cash" });
    await expect(pay(advisorOf(demo), invoiceId, { amount: "50.00", method: "cash" })).rejects.toMatchObject({
      code: "possible_duplicate",
    });
    expect(await paymentCount(invoiceId)).toBe(1);
    // A different amount is not a duplicate; a confirmed one is saved.
    await pay(advisorOf(demo), invoiceId, { amount: "30.00", method: "cash" });
    await pay(advisorOf(demo), invoiceId, { amount: "50.00", method: "cash", confirmDuplicate: true });
    expect(await paymentCount(invoiceId)).toBe(3);
    expect((await settlementOf(db.app, (await freshRo(invoiceId))!))!.balance).toBe("50.00");
  });

  async function freshRo(invoiceId: string) {
    return (
      await db.app
        .selectFrom("invoice")
        .select("repair_order_id")
        .where("id", "=", invoiceId)
        .executeTakeFirst()
    )?.repair_order_id;
  }

  it('AC2-21: 200.00 against a balance of 172.50 is refused with "Amount exceeds balance due (172.50)"', async () => {
    const { demo, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "7.50", method: "cash" });
    await expect(pay(advisorOf(demo), invoiceId, { amount: "200.00", method: "cash" })).rejects.toMatchObject(
      {
        code: "amount_exceeds_balance",
        message: "Amount exceeds balance due (172.50)",
        details: { balance: "172.50" },
      },
    );
    // Over HTTP: 409 with the balance.
    const response = await handlers.recordPayment(
      new Request(`${BASE}/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: "172.51", method: "cash", idempotencyKey: randomUUID() }),
        headers: { "content-type": "application/json", ...cookie(tokens.advisor!) },
      }),
      invoiceId,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "amount_exceeds_balance",
      message: "Amount exceeds balance due (172.50)",
      details: { balance: "172.50" },
    });
    expect(await paymentCount(invoiceId)).toBe(1);
  });

  it("AC2-21: two concurrent payments that together exceed the balance — exactly one succeeds", async () => {
    const { demo, invoiceId } = await freshReady();
    const outcomes = await Promise.allSettled([
      pay(advisorOf(demo), invoiceId, { amount: "100.00", method: "cash" }),
      pay(partnerOf(demo), invoiceId, { amount: "90.00", method: "card", reference: "A1B2C3" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "amount_exceeds_balance" });
    expect(await paymentCount(invoiceId)).toBe(1);
  });

  it("AC2-22 / OD-51: card needs the approval code and transfer its reference; the balance stays unchanged", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    for (const reference of [undefined, "", "12", "1234 5678 9012 3456", "ABCDEFGHIJKLM"]) {
      await expect(
        pay(advisorOf(demo), invoiceId, { amount: "10.00", method: "card", reference }),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "approvalCode" } });
    }
    await expect(
      pay(advisorOf(demo), invoiceId, { amount: "10.00", method: "transfer", reference: "x" }),
    ).rejects.toMatchObject({ details: { field: "transferReference" } });
    await expect(
      pay(advisorOf(demo), invoiceId, { amount: "10.00", method: "cheque" }),
    ).rejects.toMatchObject({
      details: { field: "method" },
    });
    // Rule 5: a JavaScript number is never an amount.
    await expect(pay(advisorOf(demo), invoiceId, { amount: 10, method: "cash" })).rejects.toMatchObject({
      details: { field: "amount" },
    });
    expect((await settlementOf(db.app, ro))!.balance).toBe("180.00");
    await pay(advisorOf(demo), invoiceId, { amount: "10.00", method: "card", reference: "ab12cd" });
    await pay(advisorOf(demo), invoiceId, {
      amount: "20.00",
      method: "transfer",
      reference: "FT-2026-10-27-001",
    });
    const settlement = (await settlementOf(db.app, ro))!;
    expect(settlement.payments.map((row) => [row.method, row.reference])).toEqual([
      ["card", "AB12CD"],
      ["transfer", "FT-2026-10-27-001"],
    ]);
    expect(settlement.balance).toBe("150.00");
  });

  it("OD-52 / B1: part payments to the fil, then delivery at balance 0 ends Closed; the order takes no more", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "100.01", method: "cash" });
    const last = await pay(advisorOf(demo), invoiceId, {
      amount: "79.99",
      method: "card",
      reference: "Z9Z9",
    });
    expect(last.result).toMatchObject({ balance: "0.00", closed: false });
    expect(await status(ro)).toBe("ready"); // paid, not yet handed over
    await expect(pay(advisorOf(demo), invoiceId, { amount: "0.01", method: "cash" })).rejects.toMatchObject({
      code: "amount_exceeds_balance",
    });
    // OD-54: the handover checklist.
    await expect(
      deliverVehicle(db.app, advisorOf(demo), ro, { keysReturned: true }, randomUUID()),
    ).rejects.toMatchObject({ details: { field: "belongingsReturned" } });
    await expect(
      deliverVehicle(db.app, advisorOf(demo), ro, { belongingsReturned: true }, randomUUID()),
    ).rejects.toMatchObject({ details: { field: "keysReturned" } });
    const delivered = await deliverVehicle(db.app, advisorOf(demo), ro, handover, randomUUID());
    expect(delivered.result).toEqual({ status: "closed", balance: "0.00", override: false });
    expect(await status(ro)).toBe("closed");
    const audit = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("entity_id", "=", ro)
      .where("action", "in", ["ro.delivered", "ro.closed", "ro.release_override"])
      .execute();
    expect(audit.map((row) => row.action).sort()).toEqual(["ro.closed", "ro.delivered"]);
    await expect(pay(advisorOf(demo), invoiceId, { amount: "1.00", method: "cash" })).rejects.toMatchObject({
      code: "not_payable",
    });
    await expect(deliverVehicle(db.app, advisorOf(demo), ro, handover, randomUUID())).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  it("AC2-27 / OD-53: a balance blocks the advisor; a partner releases with a reason, the partners are alerted", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "80.00", method: "cash" });
    await expect(deliverVehicle(db.app, advisorOf(demo), ro, handover, randomUUID())).rejects.toMatchObject({
      code: "balance_due",
      message: "Balance due (100.00)",
    });
    // The manager may deliver but not release with a balance.
    await expect(
      deliverVehicle(
        db.app,
        demo.users["demo.manager"],
        ro,
        { ...handover, overrideReason: "Regular customer" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "balance_due" });
    await expect(deliverVehicle(db.app, partnerOf(demo), ro, handover, randomUUID())).rejects.toMatchObject({
      details: { field: "overrideReason" },
    });
    expect(await status(ro)).toBe("ready");
    const released = await deliverVehicle(
      db.app,
      partnerOf(demo),
      ro,
      { ...handover, overrideReason: "Fleet customer pays at month end" },
      randomUUID(),
    );
    expect(released.result).toEqual({ status: "delivered", balance: "100.00", override: true });
    expect(await status(ro)).toBe("delivered");
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["action", "after_state"])
      .where("entity_id", "=", ro)
      .where("action", "=", "ro.release_override")
      .executeTakeFirstOrThrow();
    expect(audit.after_state).toMatchObject({
      balance: "100.00",
      reason: "Fleet customer pays at month end",
    });
    const alert = await db.app
      .selectFrom("outbox_message")
      .select(["topic", "payload"])
      .where("topic", "=", "alert.release_override")
      .execute();
    expect(alert.map((row) => row.payload)).toContainEqual(
      expect.objectContaining({ repairOrderId: ro, balance: "100.00" }),
    );
    // The weekly exceptions list and the partners' dashboard.
    const today = (
      await sql<{ d: string }>`SELECT to_char(business_date_of(now()), 'YYYY-MM-DD') AS d`.execute(db.app)
    ).rows[0]!.d;
    const overrides = await releaseOverrides(db.app, today, today);
    expect(overrides).toContainEqual(
      expect.objectContaining({ repairOrderId: ro, balanceAtDelivery: "100.00", balanceNow: "100.00" }),
    );
    const summary = await dashboardSummary(db.app, { money: true });
    expect(summary.attention).toContainEqual(
      expect.objectContaining({ kind: "released_unpaid", repairOrderId: ro, balance: "100.00" }),
    );
    // T-36: partners and the manager (money holders) see it; advisors do not.
    const noMoney = await dashboardSummary(db.app, { money: false });
    expect(noMoney.attention.some((item) => item.kind === "released_unpaid")).toBe(false);
    // Paying the rest after delivery closes the order (B1 Delivered → Closed).
    const paid = await pay(advisorOf(demo), invoiceId, {
      amount: "100.00",
      method: "transfer",
      reference: "TRX-77",
    });
    expect(paid.result).toMatchObject({ balance: "0.00", closed: true });
    expect(await status(ro)).toBe("closed");
    expect(
      (await releaseOverrides(db.app, today, today)).find((row) => row.repairOrderId === ro),
    ).toMatchObject({
      balanceAtDelivery: "100.00",
      balanceNow: "0.00",
    });
  });

  it("the dashboard's Ready balance is the real balance (OD-50 until I1-10)", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "45.25", method: "cash" });
    const summary = await dashboardSummary(db.app, { money: true });
    expect(summary.attention).toContainEqual(
      expect.objectContaining({ kind: "ready_unpaid", repairOrderId: ro, balance: "134.75" }),
    );
    expect((await balancesFor(db.app, [ro])).get(ro)).toBe("134.75");
    await pay(advisorOf(demo), invoiceId, { amount: "134.75", method: "cash" });
    const after = await dashboardSummary(db.app, { money: true });
    expect(after.attention.some((item) => item.kind === "ready_unpaid" && item.repairOrderId === ro)).toBe(
      false,
    );
  });

  it("F-07: the response of a committed payment is lost; the retry returns the same payment, no duplicate", async () => {
    const { demo, invoiceId } = await freshReady();
    const key = randomUUID();
    const input = { amount: "12.00", method: "cash" };
    await expect(
      recordPayment(db.app, advisorOf(demo), invoiceId, input, key, {
        afterCommit: () => {
          throw new Error("response lost");
        },
      }),
    ).rejects.toThrow("response lost");
    expect(await paymentCount(invoiceId)).toBe(1);
    const retry = await pay(advisorOf(demo), invoiceId, input, key);
    expect(retry.replayed).toBe(true);
    const stored = await db.app
      .selectFrom("payment")
      .select("id")
      .where("invoice_id", "=", invoiceId)
      .execute();
    expect(retry.result.paymentId).toBe(stored[0]!.id);
    expect(await paymentCount(invoiceId)).toBe(1);
  });

  it("a failure before commit records nothing: no payment, delivery, status change, audit or alert", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    const crash = {
      beforeCommit: () => {
        throw new Error("fault injected before commit");
      },
    };
    await expect(
      recordPayment(
        db.app,
        advisorOf(demo),
        invoiceId,
        { amount: "5.00", method: "cash" },
        randomUUID(),
        crash,
      ),
    ).rejects.toThrow("fault injected");
    await expect(
      deliverVehicle(db.app, partnerOf(demo), ro, { ...handover, overrideReason: "x" }, randomUUID(), crash),
    ).rejects.toThrow("fault injected");
    expect(await paymentCount(invoiceId)).toBe(0);
    expect(await status(ro)).toBe("ready");
    expect(
      await db.app.selectFrom("vehicle_delivery").select("id").where("repair_order_id", "=", ro).execute(),
    ).toEqual([]);
    const audits = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("action", "in", ["payment.recorded", "ro.delivered", "ro.release_override"])
      .where("entity_id", "=", ro)
      .execute();
    expect(audits).toEqual([]);
    const alerts = await db.app
      .selectFrom("outbox_message")
      .select("payload")
      .where("topic", "=", "alert.release_override")
      .execute();
    expect(alerts.map((row) => (row.payload as { repairOrderId: string }).repairOrderId)).not.toContain(ro);
  });

  it("authorization: payments and delivery are counter roles; technicians, store keepers and the accountant get 403", async () => {
    const { ro, invoiceId } = await freshReady();
    const post = (token: string, kind: "pay" | "deliver") =>
      kind === "pay"
        ? handlers.recordPayment(
            new Request(`${BASE}/api/invoices/${invoiceId}/payments`, {
              method: "POST",
              body: JSON.stringify({ amount: "1.00", method: "cash", idempotencyKey: randomUUID() }),
              headers: { "content-type": "application/json", ...cookie(token) },
            }),
            invoiceId,
          )
        : handlers.deliverVehicle(
            new Request(`${BASE}/api/repair-orders/${ro}/deliver`, {
              method: "POST",
              body: JSON.stringify({ ...handover, idempotencyKey: randomUUID() }),
              headers: { "content-type": "application/json", ...cookie(token) },
            }),
            ro,
          );
    for (const who of ["tech", "store", "accountant"]) {
      expect((await post(tokens[who]!, "pay")).status).toBe(403);
      expect((await post(tokens[who]!, "deliver")).status).toBe(403);
    }
    const denied = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("action", "=", "authz.denied")
      .where("entity_id", "in", [ro, invoiceId])
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(6);
    // The accountant reads (invoice.read); the technician does not.
    const read = (token: string) =>
      handlers.getSettlement(
        new Request(`${BASE}/api/repair-orders/${ro}/payments`, { headers: cookie(token) }),
        ro,
      );
    expect((await read(tokens.accountant!)).status).toBe(200);
    expect((await read(tokens.tech!)).status).toBe(403);
    // Advisor: paying works; delivering with a balance is a conflict, not a permission error.
    expect((await post(tokens.advisor!, "pay")).status).toBe(201);
    const blocked = await post(tokens.advisor!, "deliver");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "balance_due", details: { balance: "179.00" } });
    // Cross-site posts are refused.
    const evil = await handlers.recordPayment(
      new Request(`${BASE}/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        body: JSON.stringify({ amount: "1.00", method: "cash", idempotencyKey: randomUUID() }),
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          ...cookie(tokens.advisor!),
        },
      }),
      invoiceId,
    );
    expect(evil.status).toBe(403);
  });

  it("database guards: insert-only records, no overpayment, no delivery or closing without their conditions", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "10.00", method: "cash" });
    for (const statement of [
      `UPDATE payment SET amount = 1 WHERE invoice_id = '${invoiceId}'`,
      `DELETE FROM payment WHERE invoice_id = '${invoiceId}'`,
      `UPDATE vehicle_delivery SET override_reason = 'x'`,
      `DELETE FROM vehicle_delivery`,
    ]) {
      expect((await sqlErrorAs(db.appUrl, statement))?.code).toBe("42501");
    }
    const advisorId = advisorOf(demo).userId;
    const overpay = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO payment (invoice_id, repair_order_id, amount, method, idempotency_key, recorded_by, business_date)
       VALUES ('${invoiceId}', '${ro}', 170.01, 'cash', '${randomUUID()}', '${advisorId}', '2026-01-01')`,
    );
    expect(overpay?.code).toBe("23514");
    const cardNumber = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO payment (invoice_id, repair_order_id, amount, method, reference, idempotency_key, recorded_by, business_date)
       VALUES ('${invoiceId}', '${ro}', 1, 'card', '4111111111111111', '${randomUUID()}', '${advisorId}', '2026-01-01')`,
    );
    expect(cardNumber?.code).toBe("23514");
    // An advisor's handover row with a balance is refused, even with a reason (OD-53).
    const advisorRelease = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO vehicle_delivery (repair_order_id, keys_returned, belongings_returned, override_reason, delivered_by, business_date)
       VALUES ('${ro}', true, true, 'because', '${advisorId}', '2026-01-01')`,
    );
    expect(advisorRelease?.code).toBe("42501");
    const skipHandover = await sqlErrorAs(
      db.appUrl,
      `UPDATE repair_order SET status = 'delivered' WHERE id = '${ro}'`,
    );
    expect(skipHandover?.code).toBe("42501");
    const skipToClosed = await sqlErrorAs(
      db.appUrl,
      `UPDATE repair_order SET status = 'closed' WHERE id = '${ro}'`,
    );
    expect(skipToClosed?.code).toBe("42501");
    // After a partner's release, closing still waits for the balance.
    await deliverVehicle(
      db.app,
      partnerOf(demo),
      ro,
      { ...handover, overrideReason: "Pays tomorrow" },
      randomUUID(),
    );
    const closeEarly = await sqlErrorAs(
      db.appUrl,
      `UPDATE repair_order SET status = 'closed' WHERE id = '${ro}'`,
    );
    expect(closeEarly?.code).toBe("42501");
    const back = await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'ready' WHERE id = '${ro}'`);
    expect(back?.code).toBe("42501");
  });

  it("no payment or handover without an issued invoice; an unknown invoice is not found", async () => {
    const { demo } = await freshReady();
    const qcRo = demo.repairOrders.qc!;
    expect(await settlementOf(db.app, qcRo)).toBeNull();
    await expect(deliverVehicle(db.app, advisorOf(demo), qcRo, handover, randomUUID())).rejects.toMatchObject(
      {
        code: "no_invoice",
      },
    );
    await expect(
      pay(advisorOf(demo), randomUUID(), { amount: "1.00", method: "cash" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rule 11: the same handover key twice returns the first result; one handover row", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "180.00", method: "cash" });
    const key = randomUUID();
    const first = await deliverVehicle(db.app, advisorOf(demo), ro, handover, key);
    const again = await deliverVehicle(db.app, advisorOf(demo), ro, handover, key);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(
      await db.app.selectFrom("vehicle_delivery").select("id").where("repair_order_id", "=", ro).execute(),
    ).toHaveLength(1);
  });

  it("AC2-20: a refused possible duplicate keeps no key, so the same form key confirms it", async () => {
    const { demo, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "40.00", method: "cash" });
    const key = randomUUID();
    await expect(
      pay(advisorOf(demo), invoiceId, { amount: "40.00", method: "cash" }, key),
    ).rejects.toMatchObject({
      code: "possible_duplicate",
    });
    const confirmed = await pay(
      advisorOf(demo),
      invoiceId,
      { amount: "40.00", method: "cash", confirmDuplicate: true },
      key,
    );
    expect(confirmed.replayed).toBe(false);
    expect(await paymentCount(invoiceId)).toBe(2);
  });

  it("a partner's release racing the payment that clears the balance: one handover, the order ends Closed", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    const outcomes = await Promise.allSettled([
      deliverVehicle(
        db.app,
        partnerOf(demo),
        ro,
        { ...handover, overrideReason: "Pays by transfer" },
        randomUUID(),
      ),
      pay(advisorOf(demo), invoiceId, { amount: "180.00", method: "transfer", reference: "RACE-01" }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(await status(ro)).toBe("closed");
    const rows = await db.app
      .selectFrom("vehicle_delivery")
      .select(["balance_due", "override_reason"])
      .where("repair_order_id", "=", ro)
      .execute();
    expect(rows).toHaveLength(1);
    // Whichever ran first: released with the full balance (then paid), or paid first and handed over at 0.
    expect([
      { balance_due: "180.00", override_reason: "Pays by transfer" },
      { balance_due: "0.00", override_reason: null },
    ]).toContainEqual(rows[0]);
  });

  it("two concurrent handovers: exactly one", async () => {
    const { demo, ro, invoiceId } = await freshReady();
    await pay(advisorOf(demo), invoiceId, { amount: "180.00", method: "cash" });
    const outcomes = await Promise.allSettled([
      deliverVehicle(db.app, advisorOf(demo), ro, handover, randomUUID()),
      deliverVehicle(db.app, partnerOf(demo), ro, handover, randomUUID()),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(
      (outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({
      code: "not_ready",
    });
  });
  describe("the payments and handover card", () => {
    const base: Settlement = {
      invoice: { id: "00000000-0000-4000-8000-000000000001", number: "INV-000042", total: "180.00" },
      paid: "0.00",
      balance: "180.00",
      payments: [],
      delivery: null,
    };
    const view = (
      locale: Locale,
      settlement: Settlement,
      options: {
        status?: "ready" | "delivered" | "closed";
        pay?: boolean;
        deliver?: boolean;
        release?: boolean;
      } = {},
    ) =>
      renderToStaticMarkup(
        <SettlementView
          locale={locale}
          settlement={settlement}
          status={options.status ?? "ready"}
          qc={{ oldParts: "returned_to_customer", odometerOutKm: 61234 }}
          can={{
            pay: options.pay ?? true,
            deliver: options.deliver ?? true,
            releaseWithBalance: options.release ?? false,
          }}
          renderPaymentForm={() => <span>PAYMENT-FORM</span>}
          renderDeliverForm={(override) => <span>{override ? "RELEASE-FORM" : "DELIVER-FORM"}</span>}
        />,
      );

    it.each(["en", "ar"] as const)(
      "%s: a balance due — the advisor takes payment; handover locked, saying why",
      (locale) => {
        const html = view(locale, base);
        expect(html).toContain("PAYMENT-FORM");
        expect(html).not.toContain("DELIVER-FORM");
        expect(html).not.toContain("RELEASE-FORM");
        expect(html).toMatch(/<button type="button" class="board-locked" disabled="">/);
        expect(html).toContain(t(locale, "delivery.lockedWhy"));
        expect(html).toContain("180.00");
        // OD-54: old parts and odometer out from the QC pass are shown, not asked again.
        expect(html).toContain(t(locale, "qc.oldParts.returned_to_customer"));
        expect(html).toContain("61234");
      },
    );

    it("a partner sees the release form with the reason (AC2-27, OD-53); a paid order the plain handover", () => {
      const partner = view("en", base, { release: true });
      expect(partner).toContain("RELEASE-FORM");
      expect(partner).not.toContain(t("en", "delivery.lockedWhy"));
      const paid = view("en", {
        ...base,
        paid: "180.00",
        balance: "0.00",
        payments: [
          {
            id: "p1",
            amount: "180.00",
            method: "card",
            reference: "AB12CD",
            recordedByName: "Demo Advisor",
            recordedAt: new Date("2026-10-27T08:00:00Z"),
          },
        ],
      });
      expect(paid).toContain("DELIVER-FORM");
      expect(paid).not.toContain("PAYMENT-FORM");
      expect(paid).toContain(t("en", "payment.paidInFull"));
      expect(paid).toContain("AB12CD");
      expect(paid).toContain(t("en", "payment.method.card"));
    });

    it("released with a balance: the reason shows and payments are still taken; read-only roles get no forms", () => {
      const delivered: Settlement = {
        ...base,
        delivery: {
          deliveredAt: new Date("2026-10-27T09:00:00Z"),
          deliveredByName: "Demo Partner",
          balanceDue: "180.00",
          overrideReason: "Fleet customer pays at month end",
        },
      };
      const html = view("en", delivered, { status: "delivered", release: true });
      expect(html).toContain("Fleet customer pays at month end");
      expect(html).toContain("PAYMENT-FORM");
      expect(html).not.toContain("RELEASE-FORM");
      const accountant = view("en", base, { pay: false, deliver: false });
      expect(accountant).not.toContain("PAYMENT-FORM");
      expect(accountant).not.toContain("DELIVER-FORM");
      expect(accountant).not.toContain("board-locked");
      const closed = view("en", { ...delivered, balance: "0.00", paid: "180.00" }, { status: "closed" });
      expect(closed).not.toContain("PAYMENT-FORM");
    });
  });
});
