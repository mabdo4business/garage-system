import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { createHandlers } from "../src/server/http/handlers";
import { markWaitingParts } from "../src/server/inventory/commands";
import { LocalDiskStorage } from "../src/server/media/storage";
import { failQc, passQc, requestQc, type QcChecklist } from "../src/server/quality/commands";
import { qcView } from "../src/server/quality/queries";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, startJob } from "../src/server/workshop/commands";
import { jobCard } from "../src/server/workshop/queries";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-08 — quality check: request guard (B1, AC2-25), pass with the full checklist (§G, GAP-47/48), the self-check
 * rule (AC2-26, OD-37), fail and rework (T-26), who may do what (OD-36), database guards.
 */

describe("S20 — quality check", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  const people: Record<string, Staff> = {};
  let laborItem: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-qc-"));
    storage = new LocalDiskStorage(storageDir);
    createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
      ["tech2", ["technician"]],
      ["store", ["store_keeper"]],
    ] as const) {
      const user = await makeUser(db.app, [...roles], name);
      people[name] = { userId: user.userId, roles: [...roles] };
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
    laborItem = (
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
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let counter = 0;
  /** A repair order In progress with jobs A and B, both approved (or only A, leaving the version Sent). */
  async function repairOrder(approveB = true) {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `QC ${counter}`,
          mobile: `0541${String(counter).padStart(6, "0")}`,
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
          make: "Honda",
          model: "Accord",
          year: 2018,
          plate: { emirate: "sharjah", code: "QC", number: String(80000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 120000,
      concerns: "Service",
      photoShortfallReason: "Test",
    });
    const ro = (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const jobs: { id: string; line: string }[] = [];
    for (const title of ["A", "B"]) {
      const id = (await addJob(db.app, people.advisor!, ro, { title }, randomUUID())).result.jobId;
      const line = (await addLine(db.app, people.advisor!, id, { itemId: laborItem, qty: "1" }, randomUUID()))
        .result.lineId;
      jobs.push({ id, line });
    }
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const revisions = await db.app
      .selectFrom("job_revision")
      .select(["id", "job_id"])
      .where(
        "job_id",
        "in",
        jobs.map((j) => j.id),
      )
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
        decisions: revisions
          .filter((rev) => approveB || rev.job_id === jobs[0]!.id)
          .map((rev) => ({ revisionId: rev.id, decision: "approved" })),
        signature: makePng(300, 100, 8),
      },
      randomUUID(),
    );
    return { ro, a: jobs[0]!, b: jobs[1]! };
  }

  async function finish(job: { id: string; line: string }, staff = people.tech!) {
    const live = await db.app
      .selectFrom("job_assignment")
      .select("assignee_id")
      .where("job_id", "=", job.id)
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (!live) await assignJob(db.app, people.manager!, job.id, { assigneeId: staff.userId }, randomUUID());
    await startJob(db.app, staff, job.id, randomUUID());
    await completeJob(
      db.app,
      staff,
      job.id,
      { lines: [{ lineId: job.line, outcome: "done" }], note: "Done" },
      randomUUID(),
    );
  }

  const checklist = (overrides: Partial<QcChecklist> = {}): QcChecklist => ({
    noNewWarningLights: true,
    roadTest: "done",
    odometerOutKm: "120012",
    fluidsOk: true,
    cleanlinessOk: true,
    belongingsOk: true,
    oldParts: "returned_to_customer",
    ...overrides,
  });
  const status = async (ro: string) =>
    (await db.app.selectFrom("repair_order").select("status").where("id", "=", ro).executeTakeFirstOrThrow())
      .status;

  // --- Request (B1, AC2-25) -----------------------------------------------------------------

  it("QC is requested only when every approved job is done and nothing awaits the customer (AC2-25)", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await expect(requestQc(db.app, people.tech!, ro, randomUUID())).rejects.toMatchObject({
      code: "work_not_finished",
    });
    await markWaitingParts(db.app, people.store!, b.id, randomUUID());
    await expect(requestQc(db.app, people.manager!, ro, randomUUID())).rejects.toMatchObject({
      code: "work_not_finished",
    });

    // Job B never decided: the version is still Sent.
    const pending = await repairOrder(false);
    await finish(pending.a);
    await expect(requestQc(db.app, people.tech!, pending.ro, randomUUID())).rejects.toMatchObject({
      code: "decision_pending",
      message: expect.stringContaining("v1"),
    });
    // The database refuses too.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'qc' WHERE id = '${pending.ro}'`))?.code,
    ).toBe("42501");
    expect((await qcView(db.app, pending.ro))!.blocker).toBe("decision_pending");
  });

  it("technicians request QC only on their own repair orders; advisors do not request; only managers and partners decide (OD-36)", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    await expect(requestQc(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requestQc(db.app, people.tech2!, ro, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    await requestQc(db.app, people.tech!, ro, randomUUID());
    expect(await status(ro)).toBe("qc");
    for (const who of ["tech", "advisor", "store"]) {
      await expect(passQc(db.app, people[who]!, ro, checklist(), randomUUID())).rejects.toMatchObject({
        code: "forbidden",
      });
    }
  });

  // --- Pass (§G, GAP-47/48) -----------------------------------------------------------------

  it("a pass needs every check, the road test, the odometer (or a reason) and the old-parts disposition", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    for (const missing of ["noNewWarningLights", "fluidsOk", "cleanlinessOk", "belongingsOk"] as const) {
      await expect(
        passQc(db.app, people.partner!, ro, checklist({ [missing]: false }), randomUUID()),
      ).rejects.toMatchObject({
        details: { field: missing },
      });
    }
    await expect(
      passQc(db.app, people.partner!, ro, checklist({ roadTest: "not_applicable" }), randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "roadTestReason" },
    });
    await expect(
      passQc(db.app, people.partner!, ro, checklist({ oldParts: "sold" }), randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "oldParts" },
    });
    // GAP-48: lower than at check-in (120000) only with a reason.
    await expect(
      passQc(db.app, people.partner!, ro, checklist({ odometerOutKm: "119990" }), randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "odometerReason" },
    });
    await passQc(
      db.app,
      people.partner!,
      ro,
      checklist({ odometerOutKm: "119990", odometerReason: "Cluster replaced" }),
      randomUUID(),
    );
    const view = (await qcView(db.app, ro))!;
    expect(view.records[0]).toMatchObject({
      status: "passed",
      odometerOutKm: 119990,
      odometerReason: "Cluster replaced",
      oldParts: "returned_to_customer",
    });
    // Ready waits for the invoice (I1-09); the repair order stays in QC.
    expect(await status(ro)).toBe("qc");
    await expect(passQc(db.app, people.partner!, ro, checklist(), randomUUID())).rejects.toMatchObject({
      code: "qc_not_pending",
    });
  });

  // --- Self-check (AC2-26, OD-37) ------------------------------------------------------------

  it("someone who did the work cannot pass its QC while the setting is on (AC2-26)", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a, people.manager!);
    await finish(b);
    await requestQc(db.app, people.manager!, ro, randomUUID());
    await expect(passQc(db.app, people.manager!, ro, checklist(), randomUUID())).rejects.toMatchObject({
      code: "qc_self_check",
    });
    // The database refuses too.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE qc_record SET status = 'passed', no_new_warning_lights = true, road_test = 'done', odometer_out_km = 120100,
           fluids_ok = true, cleanliness_ok = true, belongings_ok = true, old_parts = 'disposed', decided_by = '${people.manager!.userId}'
         WHERE repair_order_id = '${ro}' AND status = 'pending'`,
        )
      )?.code,
    ).toBe("42501");
    // Switched off (a partner's setting), the same manager may pass it.
    await db.owner
      .updateTable("app_setting")
      .set({ value: JSON.stringify(false) })
      .where("key", "=", "qc.different_person")
      .execute();
    try {
      await passQc(db.app, people.manager!, ro, checklist(), randomUUID());
    } finally {
      await db.owner
        .updateTable("app_setting")
        .set({ value: JSON.stringify(true) })
        .where("key", "=", "qc.different_person")
        .execute();
    }
  });

  // --- Fail and rework (T-26) ---------------------------------------------------------------

  it("a failed QC returns the chosen jobs for rework; the next request is a new record", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await expect(
      failQc(db.app, people.manager!, ro, { notes: " ", jobIds: [a.id] }, randomUUID()),
    ).rejects.toMatchObject({
      details: { field: "notes" },
    });
    await expect(
      failQc(db.app, people.manager!, ro, { notes: "Noise", jobIds: [randomUUID()] }, randomUUID()),
    ).rejects.toMatchObject({ details: { field: "jobIds" } });
    await failQc(
      db.app,
      people.manager!,
      ro,
      { notes: "Brake squeal on road test", jobIds: [a.id] },
      randomUUID(),
    );
    expect(await status(ro)).toBe("in_progress");
    const reopened = (await jobCard(db.app, a.id))!;
    expect(reopened.status).toBe("authorized");
    expect(reopened.lines[0]!.outcome).toBeNull(); // the old outcome is superseded, kept
    expect(reopened.history.at(-1)).toMatchObject({
      from: "done",
      to: "authorized",
      reason: "Brake squeal on road test",
    });
    expect((await jobCard(db.app, b.id))!.status).toBe("done");
    const outcomes = await db.app
      .selectFrom("job_line_outcome")
      .select("superseded_at")
      .where("job_id", "=", a.id)
      .execute();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.superseded_at).not.toBeNull();

    // Rework, then a fresh QC record.
    await finish(a);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await passQc(db.app, people.partner!, ro, checklist(), randomUUID());
    expect((await qcView(db.app, ro))!.records.map((r) => r.status)).toEqual(["passed", "failed"]);
  });

  // --- Database guards -----------------------------------------------------------------------

  it("the database keeps the QC rules whatever the code does", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    // A done job is not reopened, nor the repair order made ready, without QC.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'authorized', updated_by = '${people.manager!.userId}' WHERE id = '${a.id}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'ready' WHERE id = '${ro}'`))?.code,
    ).toBe("42501");
    await requestQc(db.app, people.tech!, ro, randomUUID());
    // A pass with checks missing, a second pending record, a record decided twice.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE qc_record SET status = 'passed', decided_by = '${people.partner!.userId}' WHERE repair_order_id = '${ro}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO qc_record (repair_order_id, requested_by) VALUES ('${ro}', '${people.partner!.userId}')`,
        )
      )?.code,
    ).toBe("23505");
    // Only managers, partners or someone on the job request it; checklist values are not set at request.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO qc_record (repair_order_id, requested_by) VALUES ('${ro}', '${people.advisor!.userId}')`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO qc_record (repair_order_id, requested_by, notes) VALUES ('${ro}', '${people.partner!.userId}', 'x')`,
        )
      )?.code,
    ).toBe("42501");
    await passQc(db.app, people.partner!, ro, checklist(), randomUUID());
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE qc_record SET status = 'failed', notes = 'x' WHERE repair_order_id = '${ro}'`,
        )
      )?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM qc_record`))?.code).toBe("42501");
  });

  // --- Concurrency and idempotency -----------------------------------------------------------

  it("a pass and a fail at once: one decision; a retried request replays", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    const key = randomUUID();
    await requestQc(db.app, people.tech!, ro, key);
    expect((await requestQc(db.app, people.tech!, ro, key)).replayed).toBe(true);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        passQc(db.app, people.partner!, ro, checklist(), randomUUID()),
        failQc(db.app, people.manager!, ro, { notes: "Leak", jobIds: [a.id] }, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "qc_not_pending",
      });
    } finally {
      await holder.end();
    }
  });

  // --- Review additions -----------------------------------------------------------------------

  it("a failed QC may reopen no job: the repair order goes back to work and QC is requested again (OD-39)", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await failQc(
      db.app,
      people.manager!,
      ro,
      { notes: "Customer's bag left on the bench", jobIds: [] },
      randomUUID(),
    );
    expect(await status(ro)).toBe("in_progress");
    expect((await jobCard(db.app, a.id))!.status).toBe("done");
    expect((await qcView(db.app, ro))!.blocker).toBeNull();
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await passQc(db.app, people.partner!, ro, checklist(), randomUUID());
  });

  it("pass and fail replay with the same key; a different payload with the key is refused (rule 11)", async () => {
    const first = await repairOrder();
    await finish(first.a);
    await finish(first.b);
    await requestQc(db.app, people.tech!, first.ro, randomUUID());
    const passKey = randomUUID();
    const passed = await passQc(db.app, people.partner!, first.ro, checklist(), passKey);
    const replay = await passQc(db.app, people.partner!, first.ro, checklist(), passKey);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(passed.result);
    await expect(
      passQc(db.app, people.partner!, first.ro, checklist({ oldParts: "disposed" }), passKey),
    ).rejects.toMatchObject({ code: "idempotency_payload_mismatch" });

    const second = await repairOrder();
    await finish(second.a);
    await finish(second.b);
    await requestQc(db.app, people.tech!, second.ro, randomUUID());
    const failKey = randomUUID();
    const failed = await failQc(
      db.app,
      people.manager!,
      second.ro,
      { notes: "Leak", jobIds: [second.a.id] },
      failKey,
    );
    const again = await failQc(
      db.app,
      people.manager!,
      second.ro,
      { notes: "Leak", jobIds: [second.a.id] },
      failKey,
    );
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(failed.result);
  });

  it("over HTTP: technicians cannot read or decide QC; cross-site and unknown actions are refused", async () => {
    const handlers = createHandlers(db.app, storage);
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    const login = async (name: string) => {
      const user = await makeUser(
        db.app,
        [...people[name]!.roles],
        `${name}-http-${randomUUID().slice(0, 4)}`,
      );
      const response = await handlers.login(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          body: new URLSearchParams({ username: user.username, password: TEST_PASSWORD, locale: "en" }),
        }),
      );
      return decodeURIComponent(
        new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "",
      );
    };
    const headers = (token: string, extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      ...extra,
    });
    const tech = await login("tech");
    const advisor = await login("advisor");
    const partner = await login("partner");
    const action = (token: string, name: string, body: Record<string, unknown> = {}, extra = {}) =>
      handlers.qcAction(
        new Request(`http://localhost:3000/api/repair-orders/${ro}/qc/${name}`, {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: randomUUID(), ...body }),
          headers: headers(token, extra),
        }),
        ro,
        name,
      );
    expect(
      (
        await handlers.getQc(
          new Request(`http://localhost:3000/api/repair-orders/${ro}/qc`, { headers: headers(tech) }),
          ro,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handlers.getQc(new Request(`http://localhost:3000/api/repair-orders/${ro}/qc`), ro)).status,
    ).toBe(401);
    expect((await action(advisor, "fail", { notes: "x" })).status).toBe(403);
    expect((await action(partner, "request", {}, { origin: "https://evil.example" })).status).toBe(403);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    expect((await action(partner, "approve")).status).toBe(404);
    const key = randomUUID();
    const body = { ...checklist(), idempotencyKey: key };
    expect((await action(partner, "pass", body)).status).toBe(201);
    expect((await action(partner, "pass", body)).status).toBe(200);
  });

  it("someone whose assignment has ended still cannot pass the QC (OD-37: is or was assigned)", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a, people.manager!);
    await finish(b);
    // The manager's assignment on A ends when A is reassigned after the work.
    await db.owner
      .updateTable("job_assignment")
      .set({ ended_at: new Date(), ended_by: people.partner!.userId })
      .where("job_id", "=", a.id)
      .execute();
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await expect(passQc(db.app, people.manager!, ro, checklist(), randomUUID())).rejects.toMatchObject({
      code: "qc_self_check",
    });
  });

  it("two QC requests at once: one record", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        requestQc(db.app, people.tech!, ro, randomUUID()),
        requestQc(db.app, people.manager!, ro, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "repair_order_not_in_progress",
      });
    } finally {
      await holder.end();
    }
    expect((await qcView(db.app, ro))!.records).toHaveLength(1);
  });

  it("the database checks the checker's role, the odometer reason, supersession and odometer range", async () => {
    const { ro, a, b } = await repairOrder();
    await finish(a);
    await finish(b);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    const pass = (decidedBy: string, odometer: number, reason: string | null) =>
      sqlErrorAs(
        db.appUrl,
        `UPDATE qc_record SET status = 'passed', no_new_warning_lights = true, road_test = 'done', odometer_out_km = ${odometer},
           odometer_reason = ${reason ? `'${reason}'` : "NULL"}, fluids_ok = true, cleanliness_ok = true, belongings_ok = true,
           old_parts = 'disposed', decided_by = '${decidedBy}' WHERE repair_order_id = '${ro}' AND status = 'pending'`,
      );
    expect((await pass(people.tech2!.userId, 120100, null))?.code).toBe("42501"); // not a manager or partner
    expect((await pass(people.partner!.userId, 119000, null))?.code).toBe("42501"); // lower odometer, no reason
    // Outcomes are superseded only by a failed QC, and a done job never loses them.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE job_line_outcome SET superseded_at = now() WHERE job_id = '${a.id}'`,
        )
      )?.code,
    ).toBe("42501");
    await expect(
      passQc(db.app, people.partner!, ro, checklist({ odometerOutKm: "2500000" }), randomUUID()),
    ).rejects.toMatchObject({ details: { field: "odometerOutKm" } });
    await passQc(
      db.app,
      people.partner!,
      ro,
      checklist({ odometerOutKm: 120050 as unknown as string }),
      randomUUID(),
    );
    // Out of QC only back to work, to Ready (after a pass) or cancelled.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'delivered' WHERE id = '${ro}'`))?.code,
    ).toBe("42501");
  });
});
