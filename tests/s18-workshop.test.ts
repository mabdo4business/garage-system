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
import { LocalDiskStorage } from "../src/server/media/storage";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import {
  assignJob,
  completeJob,
  pauseJob,
  requireJobAccess,
  resumeJob,
  startJob,
} from "../src/server/workshop/commands";
import { jobCard, myJobs, workshopBoard } from "../src/server/workshop/queries";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-06 — workshop: assignment (OD-26), execution statuses by the assignee only (OD-27, v0.2.1 §3.3),
 * AC2-01 (unapproved work cannot start; logged), AC2-30 (scoping, no prices), US-07.1/07.3, and OQ-1.
 */

describe("S18 — workshop execution", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  let laborItem: string;
  let partItem: string;
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-workshop-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
      ["tech2", ["technician"]],
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
          code: "LAB-1",
          nameEn: "Labour",
          nameAr: "عمالة",
          price: "150.00",
          taxCode: "STD",
        },
        randomUUID(),
      )
    ).result.itemId;
    partItem = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "part",
          code: "PAD-1",
          nameEn: "Brake pad",
          nameAr: "فحمة",
          price: "80.00",
          taxCode: "STD",
          unit: "piece",
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
  async function newVehicle(): Promise<string> {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Workshop Customer ${counter}`,
          mobile: `0548${String(counter).padStart(6, "0")}`,
          preferredLanguage: "en",
          marketingConsent: false,
        },
        randomUUID(),
      )
    ).result.customerId;
    return (
      await createVehicle(
        db.app,
        advisor,
        {
          make: "Nissan",
          model: "Altima",
          year: 2019,
          plate: { emirate: "sharjah", code: "WS", number: String(60000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
  }

  async function checkIn(vehicleId: string, confirm?: string) {
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 70000,
      concerns: "Brakes squeal",
      photoShortfallReason: "Test fixture",
    });
    return completeCheckIn(db.app, advisor, checkInId, randomUUID(), undefined, {
      confirmOpenRepairOrder: confirm,
    });
  }

  /**
   * A repair order In progress: job "Brakes" (labour + 2 pads) approved, job "AC" declined — or, with
   * `decide: false`, sent and still pending.
   */
  async function approvedRepairOrder(decide = true) {
    const ro = (await checkIn(await newVehicle())).result.repairOrderId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const brakes = (await addJob(db.app, people.advisor!, ro, { title: "Brakes" }, randomUUID())).result
      .jobId;
    const labor = (
      await addLine(db.app, people.advisor!, brakes, { itemId: laborItem, qty: "1.5" }, randomUUID())
    ).result.lineId;
    const pads = (
      await addLine(db.app, people.advisor!, brakes, { itemId: partItem, qty: "2" }, randomUUID())
    ).result.lineId;
    const ac = (await addJob(db.app, people.advisor!, ro, { title: "AC" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, ac, { itemId: laborItem, qty: "1" }, randomUUID());
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    if (decide) {
      const revisions = await db.app
        .selectFrom("job_revision")
        .select(["id", "job_id"])
        .where("job_id", "in", [brakes, ac])
        .execute();
      const rev = (job: string) => revisions.find((row) => row.job_id === job)!.id;
      await recordInPersonApproval(
        db.app,
        storage,
        people.advisor!,
        {
          versionId,
          contentHash,
          language: "en",
          approverName: "Customer",
          decisions: [
            { revisionId: rev(brakes), decision: "approved" },
            { revisionId: rev(ac), decision: "declined" },
          ],
          signature: makePng(300, 100, 3),
        },
        randomUUID(),
      );
    }
    return { ro, brakes, ac, labor, pads };
  }

  const audits = (entityId: string, action: string) =>
    db.app
      .selectFrom("audit_event")
      .select(["action", "details"])
      .where("entity_id", "=", entityId)
      .where("action", "=", action)
      .execute();

  // --- Assignment (OD-26) ------------------------------------------------------------------

  it("managers assign one person per job; reassignment keeps the history (OD-26)", async () => {
    const { brakes, ac } = await approvedRepairOrder();
    await expect(
      assignJob(db.app, people.advisor!, brakes, { assigneeId: people.tech!.userId }, randomUUID()),
    ).rejects.toMatchObject({ code: "forbidden" });
    await assignJob(
      db.app,
      people.manager!,
      brakes,
      { assigneeId: people.tech!.userId, bay: "Bay 2" },
      randomUUID(),
    );
    await expect(
      assignJob(
        db.app,
        people.manager!,
        brakes,
        { assigneeId: people.tech!.userId, bay: "Bay 2" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "already_assigned" });
    await assignJob(db.app, people.partner!, brakes, { assigneeId: people.tech2!.userId }, randomUUID());

    const history = await db.app
      .selectFrom("job_assignment")
      .select(["assignee_id", "bay", "ended_at", "ended_by"])
      .where("job_id", "=", brakes)
      .orderBy("assigned_at")
      .execute();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      assignee_id: people.tech!.userId,
      bay: "Bay 2",
      ended_by: people.partner!.userId,
    });
    expect(history[1]).toMatchObject({ assignee_id: people.tech2!.userId, bay: null, ended_at: null });
    expect(await audits(brakes, "job.reassigned")).toHaveLength(1);

    // Only technicians, managers and partners; only authorized, unfinished jobs.
    for (const who of ["advisor", "storekeeper"]) {
      await expect(
        assignJob(db.app, people.manager!, brakes, { assigneeId: people[who]!.userId }, randomUUID()),
      ).rejects.toMatchObject({ details: { field: "assigneeId" } });
    }
    await expect(
      assignJob(db.app, people.manager!, ac, { assigneeId: people.tech!.userId }, randomUUID()),
    ).rejects.toMatchObject({ code: "job_not_assignable" });
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO job_assignment (job_id, assignee_id) VALUES ('${ac}', '${people.tech!.userId}')`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE job_assignment SET assignee_id = '${people.tech!.userId}' WHERE job_id = '${brakes}'`,
        )
      )?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM job_assignment`))?.code).toBe("42501");
  });

  // --- AC2-01 ------------------------------------------------------------------------------

  it("unapproved work cannot start, and the attempt is logged (AC2-01, AC-07.4)", async () => {
    // Declined job.
    const { ac } = await approvedRepairOrder();
    await expect(startJob(db.app, people.manager!, ac, randomUUID())).rejects.toMatchObject({
      code: "job_not_authorized",
    });
    expect(await audits(ac, "job.start_refused")).toHaveLength(1);
    // Pending (sent, undecided) job.
    const pending = await approvedRepairOrder(false);
    await expect(startJob(db.app, people.manager!, pending.brakes, randomUUID())).rejects.toMatchObject({
      code: "job_not_authorized",
    });
    expect(await audits(pending.brakes, "job.start_refused")).toHaveLength(1);
    // A technician calling the API on a job that is not theirs gets "not found", also logged.
    const response = await handlers.jobAction(
      new Request(`${BASE}/api/jobs/${pending.brakes}/start`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
        headers: { "content-type": "application/json", ...cookie(people.tech!.token) },
      }),
      pending.brakes,
      "start",
    );
    expect(response.status).toBe(404);
    expect(await audits(pending.brakes, "authz.denied")).toHaveLength(1);
    const job = await db.app
      .selectFrom("repair_job")
      .select("execution_status")
      .where("id", "=", pending.brakes)
      .executeTakeFirstOrThrow();
    expect(job.execution_status).toBe("not_authorized");
  });

  // --- Execution ---------------------------------------------------------------------------

  it("the assignee starts, pauses with a reason, resumes and completes with every line accounted for (§3.3)", async () => {
    const { brakes, labor, pads } = await approvedRepairOrder();
    await assignJob(
      db.app,
      people.manager!,
      brakes,
      { assigneeId: people.tech!.userId, bay: "Bay 1" },
      randomUUID(),
    );
    expect(
      (await myJobs(db.app, people.tech!.userId)).map((job) => [job.id, job.status, job.bay]),
    ).toContainEqual([brakes, "authorized", "Bay 1"]);

    await startJob(db.app, people.tech!, brakes, randomUUID());
    await expect(pauseJob(db.app, people.tech!, brakes, { reason: " " }, randomUUID())).rejects.toMatchObject(
      {
        details: { field: "pauseReason" },
      },
    );
    await pauseJob(db.app, people.tech!, brakes, { reason: "Awaiting customer decision" }, randomUUID());
    await resumeJob(db.app, people.tech!, brakes, randomUUID());

    // Every authorized line, once; not performed needs a reason.
    await expect(
      completeJob(
        db.app,
        people.tech!,
        brakes,
        { lines: [{ lineId: labor, outcome: "done" }] },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { field: "lines" } });
    await expect(
      completeJob(
        db.app,
        people.tech!,
        brakes,
        {
          lines: [
            { lineId: labor, outcome: "done" },
            { lineId: pads, outcome: "not_performed" },
          ],
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ details: { field: "notPerformedReason" } });
    await completeJob(
      db.app,
      people.tech!,
      brakes,
      {
        lines: [
          { lineId: labor, outcome: "done" },
          { lineId: pads, outcome: "not_performed", reason: "Pads still at 6 mm on inspection" },
        ],
        note: "Calipers cleaned",
      },
      randomUUID(),
    );

    const card = (await jobCard(db.app, brakes))!;
    expect(card.status).toBe("done");
    expect(card.reason).toBe("Calipers cleaned");
    expect(card.lines.map((line) => [line.id, line.outcome, line.reason])).toEqual([
      [labor, "done", null],
      [pads, "not_performed", "Pads still at 6 mm on inspection"],
    ]);
    // The history is written by the database, with the actor.
    expect(card.history.map((event) => [event.from, event.to, event.reason])).toEqual([
      ["not_authorized", "authorized", null],
      ["authorized", "in_progress", null],
      ["in_progress", "paused", "Awaiting customer decision"],
      ["paused", "in_progress", null],
      ["in_progress", "done", "Calipers cleaned"],
    ]);
    const actors = await db.app
      .selectFrom("job_status_event")
      .select("actor_id")
      .where("job_id", "=", brakes)
      .execute();
    expect(actors.slice(1).every((row) => row.actor_id === people.tech!.userId)).toBe(true);
    // Done is done.
    await expect(startJob(db.app, people.tech!, brakes, randomUUID())).rejects.toMatchObject({
      code: "job_status_changed",
    });
    expect((await myJobs(db.app, people.tech!.userId)).map((job) => job.id)).not.toContain(brakes);
  });

  it("only the assignee changes a job's status; a manager reassigns to act (OD-27)", async () => {
    const { brakes } = await approvedRepairOrder();
    await assignJob(db.app, people.manager!, brakes, { assigneeId: people.tech!.userId }, randomUUID());
    await expect(startJob(db.app, people.manager!, brakes, randomUUID())).rejects.toMatchObject({
      code: "not_assignee",
    });
    await assignJob(db.app, people.manager!, brakes, { assigneeId: people.manager!.userId }, randomUUID());
    await startJob(db.app, people.manager!, brakes, randomUUID());
    // The former assignee lost access to the job.
    await expect(startJob(db.app, people.tech!, brakes, randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("the database refuses status changes that skip the rules", async () => {
    const { brakes, labor } = await approvedRepairOrder();
    await assignJob(db.app, people.manager!, brakes, { assigneeId: people.tech!.userId }, randomUUID());
    // Not the assignee.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'in_progress', updated_by = '${people.tech2!.userId}' WHERE id = '${brakes}'`,
        )
      )?.code,
    ).toBe("42501");
    await startJob(db.app, people.tech!, brakes, randomUUID());
    // Pause without a reason; done without line outcomes; a skipped transition.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'paused', updated_by = '${people.tech!.userId}' WHERE id = '${brakes}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'done', updated_by = '${people.tech!.userId}' WHERE id = '${brakes}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'authorized', updated_by = '${people.tech!.userId}' WHERE id = '${brakes}'`,
        )
      )?.code,
    ).toBe("42501");
    // Outcomes only by the assignee; the history only by the database.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO job_line_outcome (job_id, revision_line_id, outcome, recorded_by) VALUES ('${brakes}', '${labor}', 'done', '${people.tech2!.userId}')`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO job_status_event (job_id, from_status, to_status) VALUES ('${brakes}', 'a', 'b')`,
        )
      )?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `UPDATE job_line_outcome SET outcome = 'done'`))?.code).toBe("42501");
  });

  // --- AC2-30 ------------------------------------------------------------------------------

  it("technicians see only their own jobs, never prices or customer contact (AC2-30, AC-07.3)", async () => {
    const { ro, brakes } = await approvedRepairOrder();
    await assignJob(db.app, people.manager!, brakes, { assigneeId: people.tech!.userId }, randomUUID());
    const get = (token: string, path: string) => new Request(`${BASE}${path}`, { headers: cookie(token) });

    const own = await handlers.getJob(get(people.tech!.token, `/api/jobs/${brakes}`), brakes);
    expect(own.status).toBe(200);
    const text = await own.text();
    for (const forbidden of [
      "price",
      "Price",
      "total",
      "net",
      "vat",
      "discount",
      "cost",
      "0548",
      "150.00",
      "80.00",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(JSON.parse(text)).toMatchObject({ title: "Brakes", lines: [{ qty: "1.500" }, { qty: "2.000" }] });

    const other = await handlers.getJob(get(people.tech2!.token, `/api/jobs/${brakes}`), brakes);
    expect(other.status).toBe(404);
    expect(await audits(brakes, "authz.denied")).toHaveLength(1);
    await expect(requireJobAccess(db.app, people.tech2!, brakes)).rejects.toMatchObject({
      code: "not_found",
    });
    // Board is for the front office and managers.
    expect((await handlers.getWorkshopBoard(get(people.tech!.token, "/api/workshop/board"))).status).toBe(
      403,
    );
    const board = await handlers.getWorkshopBoard(get(people.advisor!.token, "/api/workshop/board"));
    expect(board.status).toBe(200);
    const boardText = await board.text();
    expect(boardText).toContain(brakes);
    expect(boardText).not.toContain("150.00");
    expect((await workshopBoard(db.app)).find((order) => order.id === ro)?.jobs).toEqual([
      expect.objectContaining({ id: brakes, status: "authorized", assigneeName: expect.any(String) }),
    ]);
  });

  // --- Concurrency and idempotency ---------------------------------------------------------

  it("two starts at once: one wins; a retried start replays", async () => {
    const { ro, brakes } = await approvedRepairOrder();
    await assignJob(db.app, people.manager!, brakes, { assigneeId: people.tech!.userId }, randomUUID());
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        startJob(db.app, people.tech!, brakes, randomUUID()),
        startJob(db.app, people.tech!, brakes, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "job_status_changed",
      });
    } finally {
      await holder.end();
    }
    const key = randomUUID();
    await pauseJob(db.app, people.tech!, brakes, { reason: "Lunch" }, key);
    expect((await pauseJob(db.app, people.tech!, brakes, { reason: "Lunch" }, key)).replayed).toBe(true);
  });

  // --- OQ-1 --------------------------------------------------------------------------------

  it("a second open repair order for a vehicle needs the advisor to confirm the open one (OQ-1)", async () => {
    const vehicle = await newVehicle();
    const first = (await checkIn(vehicle)).result;
    await expect(checkIn(vehicle)).rejects.toMatchObject({
      code: "open_repair_order_exists",
      details: { openRepairOrder: first.number },
    });
    await expect(checkIn(vehicle, "RO-999999")).rejects.toMatchObject({ code: "open_repair_order_exists" });
    const second = (await checkIn(vehicle, first.number)).result;
    const row = await db.app
      .selectFrom("repair_order")
      .select("duplicate_open_ack")
      .where("id", "=", second.repairOrderId)
      .executeTakeFirstOrThrow();
    expect(row.duplicate_open_ack).toBe(first.number);
    const audit = await db.app
      .selectFrom("audit_event")
      .select("after_state")
      .where("entity_id", "=", second.repairOrderId)
      .where("action", "=", "ro.checked_in")
      .executeTakeFirstOrThrow();
    expect(audit.after_state).toMatchObject({ confirmedOpenRepairOrder: first.number });
    // The board flags both.
    const board = await workshopBoard(db.app);
    for (const id of [first.repairOrderId, second.repairOrderId]) {
      expect(board.find((order) => order.id === id)?.flags.anotherOpen).toBe(true);
    }
    // A confirmation with nothing open is refused.
    await expect(checkIn(await newVehicle(), "RO-000001")).rejects.toMatchObject({
      code: "open_repair_order_gone",
    });
  });
});
