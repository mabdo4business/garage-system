import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { createHandlers } from "../src/server/http/handlers";
import {
  clearWaitingParts,
  issueFromStock,
  markWaitingParts,
  receiveAndIssue,
  receiveStock,
} from "../src/server/inventory/commands";
import { setItemActive } from "../src/server/catalog/items";
import { partsForOpenJobs, stockList } from "../src/server/inventory/queries";
import { LocalDiskStorage } from "../src/server/media/storage";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, startJob } from "../src/server/workshop/commands";
import { jobCard } from "../src/server/workshop/queries";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-07 — parts for a job: goods receipt (OD-28), issue from stock under the pool rule (Amendment §A.1, T-02 /
 * AT-17, AT-13 issue half), receive-and-issue for special orders and non-stock items (T-23, OD-30), no negative
 * stock (AC2-13, AC2-14), the v0.2.1 §3.3 issue guard, Waiting parts (B2), and who may do it (OD-29).
 */

describe("S19 — parts for a job", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-parts-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["store", ["store_keeper"]],
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
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  async function part(stockTracked: boolean, price = "50.00"): Promise<string> {
    counter++;
    return (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "part",
          code: `P-${counter}`,
          nameEn: `Part ${counter}`,
          nameAr: `قطعة ${counter}`,
          price,
          taxCode: "STD",
          unit: "piece",
          stockTracked,
        },
        randomUUID(),
      )
    ).result.itemId;
  }

  async function labor(): Promise<string> {
    items.labor ??= (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "labor_rate",
          code: "LAB",
          nameEn: "Labour",
          nameAr: "عمالة",
          price: "150.00",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;
    return items.labor;
  }

  /**
   * A repair order In progress with job "Brakes" holding the given part lines (plus a labour line), approved —
   * or, with decide "pending" / "declined", sent and undecided / declined.
   */
  async function jobWith(
    lines: { itemId: string; qty: string }[],
    decide: "approved" | "pending" | "declined" = "approved",
  ) {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Parts ${counter}`,
          mobile: `0549${String(counter).padStart(6, "0")}`,
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
          make: "Kia",
          model: "Rio",
          year: 2020,
          plate: { emirate: "sharjah", code: "PT", number: String(70000 + counter) },
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
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const job = (await addJob(db.app, people.advisor!, ro, { title: "Brakes" }, randomUUID())).result.jobId;
    const laborLine = (
      await addLine(db.app, people.advisor!, job, { itemId: await labor(), qty: "1" }, randomUUID())
    ).result.lineId;
    const partLines: string[] = [];
    for (const line of lines) {
      partLines.push(
        (await addLine(db.app, people.advisor!, job, { itemId: line.itemId, qty: line.qty }, randomUUID()))
          .result.lineId,
      );
    }
    // A second job, always approved, keeps the repair order In progress when "Brakes" is declined.
    const other = (await addJob(db.app, people.advisor!, ro, { title: "Check" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, other, { itemId: await labor(), qty: "1" }, randomUUID());
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    if (decide !== "pending") {
      const revisions = await db.app
        .selectFrom("job_revision")
        .select(["id", "job_id"])
        .where("job_id", "in", [job, other])
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
            decision: rev.job_id === job ? decide : "approved",
          })),
          signature: makePng(300, 100, 4),
        },
        randomUUID(),
      );
    }
    return { ro, job, laborLine, partLines };
  }

  const receive = (itemId: string, qty: string, amount: string, staff = people.store!) =>
    receiveStock(
      db.app,
      staff,
      itemId,
      { qty, amount, supplierName: "Al Futtaim Parts", supplierRef: `INV-${randomUUID().slice(0, 6)}` },
      randomUUID(),
    );
  const issue = (lineId: string, qty: string, overReason?: string, staff = people.store!) =>
    issueFromStock(db.app, staff, lineId, { qty, overReason }, randomUUID());
  const balance = (itemId: string) =>
    db.app
      .selectFrom("stock_balance")
      .select(["qty", "value"])
      .where("item_id", "=", itemId)
      .executeTakeFirstOrThrow();
  const wip = (lineId: string) =>
    db.app.selectFrom("line_wip").selectAll().where("revision_line_id", "=", lineId).executeTakeFirst();

  // --- Pool rule on the persisted ledger ---------------------------------------------------

  it("receive 3 for 10.00, issue 1, 1, 1 → 3.33, 3.33, 3.34; stock 0 / 0.00 (T-02 / AT-17)", async () => {
    const pad = await part(true);
    await receive(pad, "3", "10.00");
    expect(await balance(pad)).toEqual({ qty: "3.000", value: "10.00" });
    const { partLines } = await jobWith([{ itemId: pad, qty: "3" }]);
    const costs = [];
    for (let i = 0; i < 3; i++) costs.push((await issue(partLines[0]!, "1")).result.cost);
    expect(costs).toEqual(["3.33", "3.33", "3.34"]);
    expect(await balance(pad)).toEqual({ qty: "0.000", value: "0.00" });
    expect(await wip(partLines[0]!)).toMatchObject({ qty: "3.000", value: "10.00" });
    const movements = await db.app
      .selectFrom("stock_movement")
      .select(["kind", "value"])
      .where("item_id", "=", pad)
      .orderBy("created_at")
      .execute();
    expect(movements.map((m) => [m.kind, m.value])).toEqual([
      ["receipt", "10.00"],
      ["issue", "3.33"],
      ["issue", "3.33"],
      ["issue", "3.34"],
    ]);
  });

  it("issues at 8.00 and 9.00 make line WIP 17.00 with basis 8.50 (AT-13, issue half)", async () => {
    const pad = await part(true);
    const { partLines } = await jobWith([{ itemId: pad, qty: "2" }]);
    await receive(pad, "1", "8.00");
    await issue(partLines[0]!, "1");
    await receive(pad, "1", "9.00");
    await issue(partLines[0]!, "1");
    expect(await wip(partLines[0]!)).toMatchObject({
      qty: "2.000",
      value: "17.00",
      basis_qty: "2.000",
      basis_value: "17.00",
    });
    expect(await balance(pad)).toEqual({ qty: "0.000", value: "0.00" });
  });

  // --- No negative stock -------------------------------------------------------------------

  it("refuses more than is on hand and leaves stock unchanged (AC2-14)", async () => {
    const pad = await part(true);
    await receive(pad, "2", "100.00");
    const { partLines } = await jobWith([{ itemId: pad, qty: "3" }]);
    await expect(issue(partLines[0]!, "3")).rejects.toMatchObject({
      code: "insufficient_stock",
      details: { reason: "insufficient_stock" },
    });
    expect(await balance(pad)).toEqual({ qty: "2.000", value: "100.00" });
    expect(await wip(partLines[0]!)).toBeUndefined();
  });

  it("two issues of the last unit at once: exactly one succeeds (AC2-13)", async () => {
    const pad = await part(true);
    await receive(pad, "1", "60.00");
    const first = await jobWith([{ itemId: pad, qty: "1" }]);
    const second = await jobWith([{ itemId: pad, qty: "1" }]);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT item_id FROM stock_balance WHERE item_id = $1 FOR UPDATE", [pad]);
      const both = Promise.allSettled([
        issue(first.partLines[0]!, "1"),
        issue(second.partLines[0]!, "1", undefined, people.advisor!),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "insufficient_stock",
      });
    } finally {
      await holder.end();
    }
    expect(await balance(pad)).toEqual({ qty: "0.000", value: "0.00" });
  });

  // --- Issue guard (v0.2.1 §3.3) -----------------------------------------------------------

  it("parts go only to approved, unfrozen part lines of running work", async () => {
    const pad = await part(true);
    await receive(pad, "20", "200.00");
    const pending = await jobWith([{ itemId: pad, qty: "1" }], "pending");
    const declined = await jobWith([{ itemId: pad, qty: "1" }], "declined");
    for (const line of [pending.partLines[0]!, declined.partLines[0]!]) {
      await expect(issue(line, "1")).rejects.toMatchObject({ code: "line_not_issuable" });
    }
    const approved = await jobWith([{ itemId: pad, qty: "1" }]);
    // Not a part line.
    await expect(issue(approved.laborLine, "1")).rejects.toMatchObject({ code: "line_not_issuable" });
    // A done job takes no more parts.
    await assignJob(db.app, people.manager!, approved.job, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, approved.job, randomUUID());
    await completeJob(
      db.app,
      people.tech!,
      approved.job,
      {
        lines: [
          { lineId: approved.laborLine, outcome: "done" },
          { lineId: approved.partLines[0]!, outcome: "not_performed", reason: "Not needed" },
        ],
        note: "Done",
      },
      randomUUID(),
    );
    await expect(issue(approved.partLines[0]!, "1")).rejects.toMatchObject({ code: "line_not_issuable" });

    // Frozen: superseded by a line of a revision still awaiting a decision (set-up as the owner, guards off).
    const frozen = await jobWith([{ itemId: pad, qty: "1" }]);
    const line = await db.app
      .selectFrom("revision_line")
      .selectAll()
      .where("id", "=", frozen.partLines[0]!)
      .executeTakeFirstOrThrow();
    const version = await db.app
      .selectFrom("job_revision")
      .select("proposed_in_version_id")
      .where("job_id", "=", frozen.job)
      .executeTakeFirstOrThrow();
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE job_revision DISABLE TRIGGER USER`.execute(tx);
      await sql`ALTER TABLE revision_line DISABLE TRIGGER USER`.execute(tx);
      const rev = await sql<{ id: string }>`
        INSERT INTO job_revision (job_id, revision_no, kind, proposed_in_version_id, status)
        VALUES (${frozen.job}, 2, 'price_change', ${version.proposed_in_version_id}, 'pending') RETURNING id`.execute(
        tx,
      );
      await sql`
        INSERT INTO revision_line (revision_id, line_type, catalogue_item_id, catalogue_price_id, description_en, description_ar,
          unit, qty, unit_price, gross, line_total, net, vat, tax_code, tax_rate, supersedes_line_id)
        VALUES (${rev.rows[0]!.id}, 'part', ${line.catalogue_item_id}, ${line.catalogue_price_id}, 'x', 'x', 'piece', 1,
          ${line.unit_price}, ${line.gross}, ${line.line_total}, ${line.net}, ${line.vat}, ${line.tax_code}, ${line.tax_rate}, ${line.id})`.execute(
        tx,
      );
      await sql`ALTER TABLE job_revision ENABLE TRIGGER USER`.execute(tx);
      await sql`ALTER TABLE revision_line ENABLE TRIGGER USER`.execute(tx);
    });
    await expect(issue(frozen.partLines[0]!, "1")).rejects.toMatchObject({ code: "line_not_issuable" });
    // The database refuses too.
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO stock_movement (item_id, kind, qty, value, revision_line_id) VALUES ('${pad}', 'issue', 1, 10, '${pending.partLines[0]}')`,
    );
    expect(forged?.code).toBe("42501");
  });

  it("more than the approved quantity needs a reason (v0.2.1 §3.3)", async () => {
    const pad = await part(true);
    await receive(pad, "5", "50.00");
    const { partLines } = await jobWith([{ itemId: pad, qty: "2" }]);
    await issue(partLines[0]!, "2");
    await expect(issue(partLines[0]!, "1")).rejects.toMatchObject({ details: { field: "overReason" } });
    await issue(partLines[0]!, "1", "First pad cracked while fitting");
    const movements = await db.app
      .selectFrom("line_cost_movement")
      .select("over_reason")
      .where("revision_line_id", "=", partLines[0]!)
      .orderBy("created_at")
      .execute();
    expect(movements.map((m) => m.over_reason)).toEqual([null, "First pad cracked while fitting"]);
  });

  // --- Receive-and-issue (T-23, OD-30) -----------------------------------------------------

  it("receive-and-issue costs a non-stock item or a special order straight to the line; stock is unchanged", async () => {
    const machining = await part(false, "600.00");
    const pad = await part(true);
    const { partLines } = await jobWith([
      { itemId: machining, qty: "1" },
      { itemId: pad, qty: "1" },
    ]);
    // A non-stock item cannot come from the shelf, nor be received into stock.
    await expect(issue(partLines[0]!, "1")).rejects.toMatchObject({ code: "not_stock_tracked" });
    await expect(receive(machining, "1", "1.00")).rejects.toMatchObject({ code: "not_stock_tracked" });
    await receiveAndIssue(
      db.app,
      people.advisor!,
      partLines[0]!,
      { qty: "1", amount: "420.00", supplierName: "Sharjah Machining", supplierRef: "SM-114" },
      randomUUID(),
    );
    expect(await wip(partLines[0]!)).toMatchObject({ qty: "1.000", value: "420.00" });
    // Special order for a stock part: on hand untouched.
    await receiveAndIssue(
      db.app,
      people.store!,
      partLines[1]!,
      { qty: "1", amount: "45.50", supplierName: "Dealer", supplierRef: "D-9" },
      randomUUID(),
    );
    expect(await balance(pad)).toEqual({ qty: "0.000", value: "0.00" });
    expect(await wip(partLines[1]!)).toMatchObject({ value: "45.50" });
    await expect(
      receiveAndIssue(
        db.app,
        people.store!,
        partLines[1]!,
        { qty: "1", amount: "1", supplierName: " ", supplierRef: "x" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { field: "supplierName" } });
  });

  // --- Waiting parts (B2) ------------------------------------------------------------------

  it("a job waits for parts and is back to Approved when they arrive", async () => {
    const pad = await part(true);
    const { job, partLines } = await jobWith([{ itemId: pad, qty: "1" }]);
    await markWaitingParts(db.app, people.store!, job, randomUUID());
    expect((await jobCard(db.app, job))!.status).toBe("waiting_parts");
    // Still assignable while waiting.
    await assignJob(db.app, people.manager!, job, { assigneeId: people.tech!.userId }, randomUUID());
    await receive(pad, "1", "30.00");
    await issue(partLines[0]!, "1");
    const card = (await jobCard(db.app, job))!;
    expect(card.status).toBe("authorized");
    // The technician sees what arrived, never what it cost.
    expect(card.lines.find((l) => l.id === partLines[0])?.partsQty).toBe("1.000");
    const response = await handlers.getJob(
      new Request(`${BASE}/api/jobs/${job}`, { headers: cookie(people.tech!.token) }),
      job,
    );
    const text = await response.text();
    expect(text).not.toContain("30.00");
    expect(text).not.toContain("cost");
    expect(card.history.map((e) => e.to)).toEqual(["authorized", "waiting_parts", "authorized"]);
    // The assignee may mark it too; another technician may not.
    await markWaitingParts(db.app, people.tech!, job, randomUUID());
    const other = await makeUser(db.app, ["technician"], "tech-other");
    await expect(
      markWaitingParts(db.app, { userId: other.userId, roles: ["technician"] }, job, randomUUID()),
    ).rejects.toMatchObject({ code: "not_found" }); // AC2-30: not theirs, so "not found" (and logged)
    const denied = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("entity_id", "=", job)
      .where("action", "=", "authz.denied")
      .execute();
    expect(denied).toHaveLength(1);
  });

  // --- Permissions, lists, database guards -------------------------------------------------

  it("technicians and accountants neither receive nor issue (OD-29); stock values are for stock roles only (T-24)", async () => {
    const pad = await part(true);
    const { partLines } = await jobWith([{ itemId: pad, qty: "1" }]);
    await expect(receive(pad, "1", "1.00", people.tech!)).rejects.toMatchObject({ code: "forbidden" });
    await expect(receive(pad, "1", "1.00", people.accountant!)).rejects.toMatchObject({ code: "forbidden" });
    await expect(issue(partLines[0]!, "1", undefined, people.tech!)).rejects.toMatchObject({
      code: "forbidden",
    });
    const get = (token: string, path: string) => new Request(`${BASE}${path}`, { headers: cookie(token) });
    expect((await handlers.getStock(get(people.tech!.token, "/api/stock"))).status).toBe(403);
    expect(
      (await handlers.getPartsForJobs(get(people.accountant!.token, "/api/stock/parts-for-jobs"))).status,
    ).toBe(403);
    expect((await handlers.getStock(get(people.store!.token, "/api/stock"))).status).toBe(200);
    const post = await handlers.lineParts(
      new Request(`${BASE}/api/revision-lines/${partLines[0]}/issue`, {
        method: "POST",
        body: JSON.stringify({ qty: "1", idempotencyKey: randomUUID() }),
        headers: { "content-type": "application/json", ...cookie(people.tech!.token) },
      }),
      partLines[0]!,
      "issue",
    );
    expect(post.status).toBe(403);

    await receive(pad, "4", "100.00");
    const row = (await stockList(db.app)).find((s) => s.itemId === pad)!;
    expect(row).toMatchObject({ qty: "4.000", value: "100.00", unitCost: "25.000000" });
    const todo = (await partsForOpenJobs(db.app)).find((l) => l.lineId === partLines[0]);
    expect(todo).toMatchObject({
      approvedQty: "1.000",
      costedQty: "0.000",
      onHand: "4.000",
      stockTracked: true,
    });
  });

  it("the database keeps pools equal to their movements and movements immutable", async () => {
    const pad = await part(true);
    await receive(pad, "2", "20.00");
    // A pool changed without a movement fails at commit; a negative pool fails at once.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE stock_balance SET qty = 5, value = 50 WHERE item_id = '${pad}'`))
        ?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE stock_balance SET qty = -1 WHERE item_id = '${pad}'`))?.code,
    ).toBe("23514");
    // A receipt row alone (no pool change) fails at commit too.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO stock_movement (item_id, kind, qty, value, supplier_name, supplier_ref) VALUES ('${pad}', 'receipt', 1, 5, 'x', 'y')`,
        )
      )?.code,
    ).toBe("42501");
    for (const statement of [
      `UPDATE stock_movement SET value = 0`,
      `DELETE FROM stock_movement`,
      `DELETE FROM stock_balance`,
      `UPDATE line_cost_movement SET value = 0`,
      `DELETE FROM line_wip`,
    ]) {
      expect((await sqlErrorAs(db.appUrl, statement))?.code).toBe("42501");
    }
    expect(await balance(pad)).toEqual({ qty: "2.000", value: "20.00" });
  });

  it("a retried issue replays instead of issuing twice (rule 11)", async () => {
    const pad = await part(true);
    await receive(pad, "3", "30.00");
    const { partLines } = await jobWith([{ itemId: pad, qty: "3" }]);
    const key = randomUUID();
    const first = await issueFromStock(db.app, people.store!, partLines[0]!, { qty: "1" }, key);
    const again = await issueFromStock(db.app, people.store!, partLines[0]!, { qty: "1" }, key);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(await balance(pad)).toEqual({ qty: "2.000", value: "20.00" });
  });

  // --- Integrity review additions -----------------------------------------------------------

  it("waiting parts clears only when every approved part line has all its parts (OD-33)", async () => {
    const pads = await part(true);
    const disc = await part(true);
    const { job, partLines } = await jobWith([
      { itemId: pads, qty: "4" },
      { itemId: disc, qty: "2" },
    ]);
    await receive(pads, "4", "80.00");
    await receive(disc, "2", "100.00");
    await markWaitingParts(db.app, people.store!, job, randomUUID());
    await issue(partLines[0]!, "1");
    expect((await jobCard(db.app, job))!.status).toBe("waiting_parts");
    await issue(partLines[0]!, "3");
    await issue(partLines[1]!, "1");
    expect((await jobCard(db.app, job))!.status).toBe("waiting_parts");
    await issue(partLines[1]!, "1");
    expect((await jobCard(db.app, job))!.status).toBe("authorized");
    // Staff can clear it by hand earlier, and set it again.
    await markWaitingParts(db.app, people.store!, job, randomUUID());
    await clearWaitingParts(db.app, people.advisor!, job, randomUUID());
    expect((await jobCard(db.app, job))!.status).toBe("authorized");
  });

  it("whole units for parts counted in pieces, sets and jobs (OD-22)", async () => {
    const pad = await part(true);
    await expect(receive(pad, "2.5", "10.00")).rejects.toMatchObject({
      details: { field: "qty", reason: "whole_number" },
    });
    await receive(pad, "3", "30.00");
    const { partLines } = await jobWith([{ itemId: pad, qty: "1" }]);
    await expect(issue(partLines[0]!, "0.5")).rejects.toMatchObject({ details: { reason: "whole_number" } });
    await expect(
      receiveAndIssue(
        db.app,
        people.store!,
        partLines[0]!,
        { qty: "0.5", amount: "5", supplierName: "S", supplierRef: "R" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { reason: "whole_number" } });
    // Oil by the litre takes fractions.
    counter++;
    const oil = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "part",
          code: `OIL-${counter}`,
          nameEn: "Oil",
          nameAr: "زيت",
          price: "30.00",
          taxCode: "STD",
          unit: "litre",
          stockTracked: true,
        },
        randomUUID(),
      )
    ).result.itemId;
    await receive(oil, "4.5", "45.00");
    // The database refuses a fractional piece count whatever the code does.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO stock_movement (item_id, kind, qty, value, supplier_name, supplier_ref) VALUES ('${pad}', 'receipt', 0.5, 1, 'x', 'y')`,
        )
      )?.code,
    ).toBe("23514");
  });

  it("no receipts into a deactivated part; its stock still issues (OD-34)", async () => {
    const pad = await part(true);
    await receive(pad, "2", "20.00");
    const { partLines } = await jobWith([{ itemId: pad, qty: "1" }]);
    await setItemActive(db.app, people.manager!, pad, false);
    await expect(receive(pad, "1", "10.00")).rejects.toMatchObject({ code: "item_inactive" });
    await issue(partLines[0]!, "1");
    expect(await balance(pad)).toEqual({ qty: "1.000", value: "10.00" });
  });

  it("two over-issues to one line at once: the second needs a reason (v0.2.1 §3.3)", async () => {
    const pad = await part(true);
    await receive(pad, "5", "50.00");
    const { ro, partLines } = await jobWith([{ itemId: pad, qty: "2" }]);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        issue(partLines[0]!, "2"),
        issue(partLines[0]!, "1", undefined, people.advisor!),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        details: { field: "overReason" },
      });
    } finally {
      await holder.end();
    }
  });

  it("retried receipts and receive-and-issue replay instead of recording twice (rule 11)", async () => {
    const pad = await part(true);
    const input = { qty: "2", amount: "20.00", supplierName: "Supplier", supplierRef: "R-1" };
    const key = randomUUID();
    const first = await receiveStock(db.app, people.store!, pad, input, key);
    const again = await receiveStock(db.app, people.store!, pad, input, key);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(await balance(pad)).toEqual({ qty: "2.000", value: "20.00" });

    const { partLines } = await jobWith([{ itemId: pad, qty: "1" }]);
    const raiKey = randomUUID();
    const rai = { qty: "1", amount: "12.00", supplierName: "Dealer", supplierRef: "D-1" };
    await receiveAndIssue(db.app, people.store!, partLines[0]!, rai, raiKey);
    expect((await receiveAndIssue(db.app, people.store!, partLines[0]!, rai, raiKey)).replayed).toBe(true);
    expect(await wip(partLines[0]!)).toMatchObject({ qty: "1.000", value: "12.00" });
  });

  it("the database refuses issues without a job line, a moved basis, and waiting parts by the wrong people", async () => {
    const pad = await part(true);
    await receive(pad, "2", "20.00");
    const { job, partLines } = await jobWith([{ itemId: pad, qty: "1" }]);
    // A stock issue (and its pool change) without the line's side fails at commit.
    const orphan = await sqlErrorAs(
      db.appUrl,
      `BEGIN;
       INSERT INTO stock_movement (item_id, kind, qty, value, revision_line_id) VALUES ('${pad}', 'issue', 1, 10, '${partLines[0]}');
       UPDATE stock_balance SET qty = 1, value = 10 WHERE item_id = '${pad}';
       COMMIT;`,
    );
    expect(orphan?.code).toBe("42501");
    // The basis moves only when units enter (the trigger refuses before the basis CHECK is reached).
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE stock_balance SET basis_value = 1 WHERE item_id = '${pad}'`))
        ?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE stock_balance SET basis_qty = 0 WHERE item_id = '${pad}'`))?.code,
    ).toBe("42501");
    // Waiting parts: not by an accountant, not by a deactivated store keeper.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'waiting_parts', updated_by = '${people.accountant!.userId}' WHERE id = '${job}'`,
        )
      )?.code,
    ).toBe("42501");
    const gone = await makeUser(db.app, ["store_keeper"], "store-gone");
    await db.owner
      .updateTable("app_user")
      .set({ status: "deactivated", deactivated_at: new Date() })
      .where("id", "=", gone.userId)
      .execute();
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'waiting_parts', updated_by = '${gone.userId}' WHERE id = '${job}'`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("waiting parts needs running work; the HTTP action works for store keepers", async () => {
    const pad = await part(true);
    const { ro, job } = await jobWith([{ itemId: pad, qty: "1" }]);
    const response = await handlers.jobAction(
      new Request(`${BASE}/api/jobs/${job}/waiting-parts`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
        headers: { "content-type": "application/json", ...cookie(people.store!.token) },
      }),
      job,
      "waiting-parts",
    );
    expect(response.status).toBe(201);
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", ro).execute();
    await expect(clearWaitingParts(db.app, people.store!, job, randomUUID())).rejects.toMatchObject({
      code: "repair_order_not_in_progress",
    });
  });
});
