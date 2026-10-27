import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { sql } from "kysely";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EstimateDocument } from "../src/app/[locale]/(counter)/repair-orders/[id]/estimate/approve/estimate-document";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem, setPrice } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { canonicalJson, sha256Hex } from "../src/server/core/json";
import { createCustomer } from "../src/server/customer/service";
import { isJobAuthorized, recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import {
  addJob,
  addLine,
  excludeUrgentFinding,
  openEstimate,
  removeJob,
  setLineDiscount,
  type Staff,
} from "../src/server/estimate/commands";
import { approvalScreenView, estimateView } from "../src/server/estimate/queries";
import type { EstimateSnapshot } from "../src/server/estimate/snapshot";
import {
  discardDraft,
  expireDueEstimates,
  reproposeJob,
  startVersion,
  withdrawVersion,
} from "../src/server/estimate/versions";
import { createHandlers } from "../src/server/http/handlers";
import { recordFinding } from "../src/server/inspection/commands";
import { LocalDiskStorage } from "../src/server/media/storage";
import { requestQc } from "../src/server/quality/commands";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, startJob } from "../src/server/workshop/commands";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I2-01 — estimate versions (v0.2.1 §3.1–3.2): later versions with one sent at a time, withdrawal with a reason
 * (OD-57), expiry by the system or at submission (AC21-07), approval racing withdrawal (AC21-05), partial decision
 * then withdrawal (AC21-06), offering declined or lapsed jobs again (OD-55), earlier approvals as context (§2.1 #4),
 * urgent findings in every version (OD-58), discarding a later draft, and QC unblocked by withdrawal (X-12, AC2-25).
 */

describe("S27 — estimate versions", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  const signature = makePng(600, 200, 11);

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-versions-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
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
    const item = async (kind: string, code: string, price: string, unit?: string) =>
      (
        await createItem(
          db.app,
          people.manager!,
          { kind, code, nameEn: `${code} EN`, nameAr: `${code} AR`, price, taxCode: "STD", unit },
          randomUUID(),
        )
      ).result.itemId;
    items.labor = await item("labor_rate", "LAB-V", "200.00");
    items.pads = await item("part", "PADS-V", "300.00", "piece");
    items.cleaner = await item("part", "CLN-V", "20.00", "piece");
  });
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
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
          nameEn: `Versions Customer ${counter}`,
          mobile: `0548${String(counter).padStart(6, "0")}`,
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
          year: 2020,
          plate: { emirate: "sharjah", code: "EV", number: String(60000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 80000,
      concerns: "Brakes, AC, wipers",
      photoShortfallReason: "Test fixture",
    });
    return (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
  }

  /** v1 with three jobs A (brakes: labour + pads), B (AC), C (wipers), sent. */
  async function sentThreeJobs() {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const job = async (title: string) =>
      (await addJob(db.app, people.advisor!, ro, { title }, randomUUID())).result.jobId;
    const a = await job("Front brakes");
    const b = await job("AC service");
    const c = await job("Wipers");
    await addLine(db.app, people.advisor!, a, { itemId: items.labor, qty: "1" }, randomUUID());
    await addLine(db.app, people.advisor!, a, { itemId: items.pads, qty: "1" }, randomUUID());
    await addLine(db.app, people.advisor!, b, { itemId: items.labor, qty: "1" }, randomUUID());
    await addLine(db.app, people.advisor!, c, { itemId: items.cleaner, qty: "1" }, randomUUID());
    const sent = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    return { ro, a, b, c, ...sent };
  }

  const revisionsOf = (jobId: string) =>
    db.app
      .selectFrom("job_revision")
      .selectAll()
      .where("job_id", "=", jobId)
      .orderBy("revision_no")
      .execute();
  const latestRevision = async (jobId: string) => (await revisionsOf(jobId)).at(-1)!;
  const roStatus = async (ro: string) =>
    (await db.app.selectFrom("repair_order").select("status").where("id", "=", ro).executeTakeFirstOrThrow())
      .status;
  const versionsOf = (ro: string) =>
    db.app
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .selectAll("estimate_version")
      .where("estimate.repair_order_id", "=", ro)
      .orderBy("estimate_version.version_no")
      .execute();

  const approve = async (
    versionId: string,
    contentHash: string,
    decisions: { jobId: string; decision: "approved" | "declined" }[],
    key = randomUUID(),
  ) =>
    recordInPersonApproval(
      db.app,
      storage,
      people.advisor!,
      {
        versionId,
        contentHash,
        language: "en",
        approverName: "Omar Saeed",
        decisions: await Promise.all(
          decisions.map(async (d) => ({
            revisionId: (await latestRevision(d.jobId)).id,
            decision: d.decision,
          })),
        ),
        signature,
      },
      key,
    );

  /** Moves a version's expiry into the past, as the owner with the guard off (the scheduler has not run). */
  async function overdue(versionId: string) {
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition`.execute(tx);
      await sql`UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = ${versionId}`.execute(
        tx,
      );
      await sql`ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition`.execute(tx);
    });
  }

  const withdraw = (ro: string, reasonCode = "no_response", reason?: string, key = randomUUID()) =>
    withdrawVersion(db.app, people.advisor!, ro, { reasonCode, reason }, key);

  // --- AC21-06 -------------------------------------------------------------------------------

  it("AC21-06: partial decision then withdrawal — A stays approved, B and C lapse, B is offered as a new revision", async () => {
    const { ro, a, b, c, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    expect(await roStatus(ro)).toBe("in_progress");

    const outcome = await withdraw(ro, "needs_changes");
    expect(outcome.result).toEqual({ versionId, outcome: "withdrawn", lapsedJobs: 2 });
    expect((await latestRevision(a)).status).toBe("approved");
    expect(await isJobAuthorized(db.app, a)).toBe(true);
    for (const job of [b, c]) {
      expect(await latestRevision(job)).toMatchObject({ status: "lapsed", lapse_reason: "withdrawn" });
      expect(await isJobAuthorized(db.app, job)).toBe(false);
    }
    expect(await roStatus(ro)).toBe("in_progress");
    const end = await db.app
      .selectFrom("estimate_version_end")
      .selectAll()
      .where("estimate_version_id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect(end).toMatchObject({
      outcome: "withdrawn",
      reason_code: "needs_changes",
      ended_by: people.advisor!.userId,
    });
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["after_state"])
      .where("action", "=", "estimate.withdrawn")
      .where("entity_id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect((audit.after_state as { lapsed: unknown[] }).lapsed).toHaveLength(2);

    // Approved work starts; lapsed work cannot.
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, a, randomUUID());
    await expect(
      assignJob(db.app, people.manager!, b, { assigneeId: people.tech!.userId }, randomUUID()),
    ).rejects.toMatchObject({ code: "job_not_assignable" });

    // Re-proposing B: a new revision JR-B2 in v2; JR-B1 untouched.
    const before = await revisionsOf(b);
    const v2 = (await startVersion(db.app, people.advisor!, ro, randomUUID())).result;
    expect(v2.versionNo).toBe(2);
    await reproposeJob(db.app, people.advisor!, b, randomUUID());
    const after = await revisionsOf(b);
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({
      revision_no: 2,
      kind: "original",
      status: "draft",
      proposed_in_version_id: v2.versionId,
    });
  });

  // --- AC21-05 -------------------------------------------------------------------------------

  it("AC21-05: a withdrawal first — the approval is refused with 'This estimate has been updated', nothing recorded", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    await withdraw(ro);
    await expect(approve(versionId, contentHash, [{ jobId: a, decision: "approved" }])).rejects.toMatchObject(
      {
        code: "estimate_updated",
        message: "This estimate has been updated",
      },
    );
    expect(await latestRevision(a)).toMatchObject({ status: "lapsed" });
    expect(
      await db.app
        .selectFrom("approval_event")
        .select("id")
        .where("estimate_version_id", "=", versionId)
        .execute(),
    ).toHaveLength(0);
  });

  it("AC21-05: an approval first — the withdrawal lapses nothing it decided", async () => {
    const { ro, a, b, c, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [
      { jobId: a, decision: "approved" },
      { jobId: b, decision: "declined" },
    ]);
    const outcome = await withdraw(ro);
    expect(outcome.result.lapsedJobs).toBe(1);
    expect((await latestRevision(a)).status).toBe("approved");
    expect((await latestRevision(b)).status).toBe("declined");
    expect((await latestRevision(c)).status).toBe("lapsed");
  });

  it("AC21-05: approval and withdrawal submitted together — one wins, never both a decision and a lapse", async () => {
    for (let round = 0; round < 3; round++) {
      const { ro, a, versionId, contentHash } = await sentThreeJobs();
      const holder = new pg.Client({ connectionString: db.appUrl });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
        const all = Promise.allSettled([
          approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]),
          withdraw(ro),
        ]);
        await waitForLockWaiters(db, 2);
        await holder.query("COMMIT");
        const [approval, withdrawal] = await all;
        expect(withdrawal.status).toBe("fulfilled");
        const revision = await latestRevision(a);
        const decisions = await db.app
          .selectFrom("revision_decision")
          .select("id")
          .where("revision_id", "=", revision.id)
          .execute();
        if (approval.status === "fulfilled") {
          expect(revision.status).toBe("approved");
          expect(decisions).toHaveLength(1);
        } else {
          expect(approval.reason).toMatchObject({ code: "estimate_updated" });
          expect(revision).toMatchObject({ status: "lapsed", lapse_reason: "withdrawn" });
          expect(decisions).toHaveLength(0);
        }
      } finally {
        await holder.end();
      }
    }
  });

  // --- AC21-07 -------------------------------------------------------------------------------

  it("AC21-07: a submission after expiry is refused, the pending job lapses (expired), the approved one stays", async () => {
    const { ro, a, b, c, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await overdue(versionId);
    const key = randomUUID();
    await expect(
      approve(versionId, contentHash, [{ jobId: b, decision: "approved" }], key),
    ).rejects.toMatchObject({
      code: "estimate_expired",
    });
    // The expiry was committed although the submission was refused.
    const version = (await versionsOf(ro))[0]!;
    expect(version.status).toBe("expired");
    expect(await latestRevision(a)).toMatchObject({ status: "approved" });
    for (const job of [b, c]) {
      expect(await latestRevision(job)).toMatchObject({ status: "lapsed", lapse_reason: "expired" });
    }
    const end = await db.app
      .selectFrom("estimate_version_end")
      .selectAll()
      .where("estimate_version_id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect(end).toMatchObject({ outcome: "expired", ended_by: null, reason_code: null });
    const audit = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "estimate.expired")
      .where("entity_id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ trigger: "submission" });
    // The same form submitted again gets the same answer; one approval event in all (A's).
    await expect(
      approve(versionId, contentHash, [{ jobId: b, decision: "approved" }], key),
    ).rejects.toMatchObject({
      code: "estimate_expired",
    });
    expect(
      await db.app
        .selectFrom("approval_event")
        .select("id")
        .where("estimate_version_id", "=", versionId)
        .execute(),
    ).toHaveLength(1);
  });

  it("the scheduler expires only overdue versions, once", async () => {
    const due = await sentThreeJobs();
    const fresh = await sentThreeJobs();
    await overdue(due.versionId);
    const expired = await expireDueEstimates(db.app);
    expect(expired).toContain(due.versionId);
    expect(expired).not.toContain(fresh.versionId);
    expect((await versionsOf(due.ro))[0]!.status).toBe("expired");
    expect((await versionsOf(fresh.ro))[0]!.status).toBe("sent");
    expect(await expireDueEstimates(db.app)).not.toContain(due.versionId);
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["actor_label", "details"])
      .where("action", "=", "estimate.expired")
      .where("entity_id", "=", due.versionId)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ trigger: "scheduler" });
  });

  it("withdrawing an overdue version records it as expired", async () => {
    const { ro, versionId } = await sentThreeJobs();
    await overdue(versionId);
    const outcome = await withdraw(ro);
    expect(outcome.result).toMatchObject({ versionId, outcome: "expired", lapsedJobs: 3 });
    expect((await versionsOf(ro))[0]!.status).toBe("expired");
  });

  // --- One sent version at a time; later versions ---------------------------------------------

  it("one version open at a time: no new version while one is sent or drafted (command and database)", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await expect(startVersion(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "version_still_open",
      details: { version: "1", status: "sent" },
    });
    const estimateId = (await versionsOf(ro))[0]!.estimate_id;
    const direct = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO estimate_version (estimate_id, version_no) VALUES ('${estimateId}', 2)`,
    );
    expect(direct?.code).toBe("42501");

    await withdraw(ro);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await expect(startVersion(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "version_still_open",
      details: { version: "2", status: "draft" },
    });
    const skipping = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO estimate_version (estimate_id, version_no) VALUES ('${estimateId}', 4)`,
    );
    expect(skipping).not.toBeNull();
  });

  it("version 2 while work runs: the car stays In progress, earlier approvals are context, a new approval authorizes", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    // A approved; B and C undecided, then lapse when v1 is withdrawn.
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await withdraw(ro);
    const v2 = (await startVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const pins = (await addJob(db.app, people.advisor!, ro, { title: "Caliper slider pins" }, randomUUID()))
      .result.jobId;
    await addLine(db.app, people.advisor!, pins, { itemId: items.labor, qty: "0.5" }, randomUUID());
    const sent = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    expect(sent.versionId).toBe(v2.versionId);
    expect(await roStatus(ro)).toBe("in_progress");
    expect(
      await db.app
        .selectFrom("audit_event")
        .select("seq")
        .where("action", "=", "ro.awaiting_approval")
        .where("entity_id", "=", ro)
        .execute(),
    ).toHaveLength(1); // only v1 moved the car

    const version = (await versionsOf(ro))[1]!;
    const snapshot = version.snapshot as EstimateSnapshot;
    expect(snapshot.schema).toBe(2);
    expect(snapshot.versionNo).toBe(2);
    expect(snapshot.jobs.map((job) => job.jobId)).toEqual([pins]);
    expect(snapshot.earlierApproved).toEqual([
      {
        jobId: a,
        revisionId: (await latestRevision(a)).id,
        title: "Front brakes",
        versionNo: 1,
        total: "500.00",
      },
    ]);
    expect(sha256Hex(canonicalJson(snapshot))).toBe(version.content_hash);
    const screen = (await approvalScreenView(db.app, ro))!;
    expect(screen.versionId).toBe(v2.versionId);
    expect(screen.pendingRevisionIds).toEqual([(await latestRevision(pins)).id]);

    const firstEvent = await db.app
      .selectFrom("approval_event")
      .selectAll()
      .where("estimate_version_id", "=", versionId)
      .executeTakeFirstOrThrow();
    await approve(sent.versionId, sent.contentHash, [{ jobId: pins, decision: "approved" }]);
    expect(await isJobAuthorized(db.app, pins)).toBe(true);
    expect(await roStatus(ro)).toBe("in_progress");
    expect((await versionsOf(ro))[1]!.status).toBe("closed");
    // AE-1 and its decision unchanged (AC21-01 pattern).
    expect(
      await db.app
        .selectFrom("approval_event")
        .selectAll()
        .where("id", "=", firstEvent.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(firstEvent);
  });

  it("a car whose first version was all declined gets version 2 while Awaiting approval", async () => {
    const { ro, a, b, c, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [
      { jobId: a, decision: "declined" },
      { jobId: b, decision: "declined" },
      { jobId: c, decision: "declined" },
    ]);
    expect(await roStatus(ro)).toBe("awaiting_approval");
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await reproposeJob(db.app, people.advisor!, a, randomUUID());
    const sent = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    expect(await roStatus(ro)).toBe("awaiting_approval");
    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    expect(await roStatus(ro)).toBe("in_progress");
    expect(await isJobAuthorized(db.app, a)).toBe(true);
  });

  // --- Withdraw rules ------------------------------------------------------------------------

  it("withdrawal needs a reason; Other needs the text; replays record one withdrawal (OD-57, rule 11)", async () => {
    const { ro, versionId } = await sentThreeJobs();
    await expect(withdraw(ro, "")).rejects.toMatchObject({ details: { field: "reasonCode" } });
    await expect(withdraw(ro, "bored")).rejects.toMatchObject({ details: { field: "reasonCode" } });
    await expect(withdraw(ro, "other", "  ")).rejects.toMatchObject({ details: { field: "reason" } });
    const key = randomUUID();
    const first = await withdraw(ro, "other", "Customer will call back next week", key);
    const second = await withdraw(ro, "other", "Customer will call back next week", key);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    const ends = await db.app
      .selectFrom("estimate_version_end")
      .selectAll()
      .where("estimate_version_id", "=", versionId)
      .execute();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason_code: "other", reason: "Customer will call back next week" });
    // Nothing left to withdraw.
    await expect(withdraw(ro)).rejects.toMatchObject({ code: "estimate_not_sent" });
  });

  it("technicians cannot withdraw, start versions or offer jobs again (403, audited)", async () => {
    const { ro, b, versionId } = await sentThreeJobs();
    const post = (path: string, body: Record<string, string>) =>
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { ...cookie(people.tech!.token), origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID(), ...body }),
      });
    expect(
      (
        await handlers.withdrawEstimate(
          post(`/api/repair-orders/${ro}/estimate/withdraw`, { reasonCode: "other" }),
          ro,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handlers.startEstimateVersion(post(`/api/repair-orders/${ro}/estimate/versions`, {}), ro))
        .status,
    ).toBe(403);
    expect(
      (await handlers.discardEstimateDraft(post(`/api/repair-orders/${ro}/estimate/discard`, {}), ro)).status,
    ).toBe(403);
    expect((await handlers.reproposeEstimateJob(post(`/api/repair-jobs/${b}/repropose`, {}), b)).status).toBe(
      403,
    );
    expect(
      await db.app
        .selectFrom("audit_event")
        .select("seq")
        .where("action", "=", "authz.denied")
        .where("entity_id", "=", b)
        .execute(),
    ).toHaveLength(1);
    const denied = await db.app
      .selectFrom("audit_event")
      .select("seq")
      .where("action", "=", "authz.denied")
      .where("entity_id", "=", ro)
      .execute();
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect((await versionsOf(ro))[0]!.status).toBe("sent");

    // The advisor withdraws over HTTP.
    const ok = await handlers.withdrawEstimate(
      new Request(`${BASE}/api/repair-orders/${ro}/estimate/withdraw`, {
        method: "POST",
        headers: { ...cookie(people.advisor!.token), origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID(), reasonCode: "no_response" }),
      }),
      ro,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ versionId, outcome: "withdrawn" });
  });

  // --- QC (AC2-25, X-12) ---------------------------------------------------------------------

  async function finish(jobId: string) {
    await assignJob(db.app, people.manager!, jobId, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, jobId, randomUUID());
    const lines = await db.app
      .selectFrom("revision_line")
      .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
      .select("revision_line.id")
      .where("job_revision.job_id", "=", jobId)
      .where("job_revision.status", "=", "approved")
      .execute();
    await completeJob(
      db.app,
      people.tech!,
      jobId,
      { lines: lines.map((line) => ({ lineId: line.id, outcome: "done" })), note: "Done" },
      randomUUID(),
    );
  }

  it("a pending version blocks QC; withdrawing it ('no response') unblocks it (AC2-25, X-12)", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await finish(a);
    await expect(requestQc(db.app, people.tech!, ro, randomUUID())).rejects.toMatchObject({
      code: "decision_pending",
      details: { version: "1" },
    });
    await withdraw(ro, "no_response");
    await requestQc(db.app, people.tech!, ro, randomUUID());
    expect(await roStatus(ro)).toBe("qc");
  });

  it("an overdue version does not block QC: requesting QC records the expiry", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await finish(a);
    await overdue(versionId);
    await requestQc(db.app, people.tech!, ro, randomUUID());
    expect(await roStatus(ro)).toBe("qc");
    expect((await versionsOf(ro))[0]!.status).toBe("expired");
    const audit = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "estimate.expired")
      .where("entity_id", "=", versionId)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ trigger: "qc_request" });
  });

  // --- Offering again, removing, discarding --------------------------------------------------

  it("offering a declined job again copies its items at today's prices, without discounts (OD-55, T-18, OD-19)", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const a = (await addJob(db.app, people.advisor!, ro, { title: "Front brakes" }, randomUUID())).result
      .jobId;
    const b = (await addJob(db.app, people.advisor!, ro, { title: "AC service" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, a, { itemId: items.labor, qty: "1" }, randomUUID());
    const pads = (await addLine(db.app, people.advisor!, b, { itemId: items.pads, qty: "2" }, randomUUID()))
      .result.lineId;
    await addLine(db.app, people.advisor!, b, { itemId: items.labor, qty: "1.5" }, randomUUID());
    await setLineDiscount(db.app, people.manager!, pads, { discount: "50.00" }, randomUUID());
    const v1 = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(v1.versionId, v1.contentHash, [
      { jobId: a, decision: "approved" },
      { jobId: b, decision: "declined" },
    ]);
    await setPrice(db.app, people.manager!, items.pads!, { price: "330.00", taxCode: "STD" }, randomUUID());

    // Not before a draft exists; never for approved work.
    await expect(reproposeJob(db.app, people.advisor!, b, randomUUID())).rejects.toMatchObject({
      code: "no_draft",
    });
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await expect(reproposeJob(db.app, people.advisor!, a, randomUUID())).rejects.toMatchObject({
      code: "not_reproposable",
    });
    const { revisionId, skippedItems } = (await reproposeJob(db.app, people.advisor!, b, randomUUID()))
      .result;
    expect(skippedItems).toEqual([]);
    const lines = await db.app
      .selectFrom("revision_line")
      .select(["catalogue_item_id", "qty", "unit_price", "discount", "line_total"])
      .where("revision_id", "=", revisionId)
      .orderBy("created_at")
      .execute();
    expect(lines).toEqual([
      {
        catalogue_item_id: items.pads,
        qty: "2.000",
        unit_price: "330.00",
        discount: "0.00",
        line_total: "660.00",
      },
      {
        catalogue_item_id: items.labor,
        qty: "1.500",
        unit_price: "200.00",
        discount: "0.00",
        line_total: "300.00",
      },
    ]);
    // Twice is refused: the job already has an open revision.
    await expect(reproposeJob(db.app, people.advisor!, b, randomUUID())).rejects.toMatchObject({
      code: "not_reproposable",
    });
    const view = (await estimateView(db.app, ro))!;
    expect(view.versionNo).toBe(2);
    expect(view.jobs.map((job) => job.id)).toEqual([b]);
    expect(view.earlierApproved.map((job) => job.jobId)).toEqual([a]);
    expect(view.reofferable).toEqual([]);
    expect(view.versions.map((v) => [v.versionNo, v.status])).toEqual([
      [1, "closed"],
      [2, "draft"],
    ]);
  });

  it("removing a job offered again discards only its revision; discarding the draft keeps history (§3.1)", async () => {
    const { ro, a, b, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await withdraw(ro);
    await expect(discardDraft(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "no_draft",
    });
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await reproposeJob(db.app, people.advisor!, b, randomUUID());
    expect((await estimateView(db.app, ro))!.reofferable.map((job) => job.title)).toEqual(["Wipers"]);

    await removeJob(db.app, people.advisor!, b, {}, randomUUID());
    const bRevisions = await revisionsOf(b);
    expect(bRevisions.map((r) => r.status)).toEqual(["lapsed", "discarded"]);
    const bJob = await db.app
      .selectFrom("repair_job")
      .select("removed_at")
      .where("id", "=", b)
      .executeTakeFirstOrThrow();
    expect(bJob.removed_at).toBeNull();
    let view = (await estimateView(db.app, ro))!;
    expect(view.jobs).toEqual([]);
    expect(view.reofferable.map((job) => job.title).sort()).toEqual(["AC service", "Wipers"]);

    // The database refuses removing a job with history.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_job SET removed_at = now() WHERE id = '${b}'`))?.code,
    ).toBe("42501");

    // Discard the draft: its new job is removed, its re-offer discarded; v3 can start.
    const fresh = (await addJob(db.app, people.advisor!, ro, { title: "Air filter" }, randomUUID())).result
      .jobId;
    await reproposeJob(db.app, people.advisor!, b, randomUUID());
    await discardDraft(db.app, people.advisor!, ro, randomUUID());
    expect(
      (
        await db.app
          .selectFrom("repair_job")
          .select("removed_at")
          .where("id", "=", fresh)
          .executeTakeFirstOrThrow()
      ).removed_at,
    ).not.toBeNull();
    expect((await revisionsOf(b)).map((r) => r.status)).toEqual(["lapsed", "discarded", "discarded"]);
    expect((await versionsOf(ro)).map((v) => v.status)).toEqual(["withdrawn", "discarded"]);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    view = (await estimateView(db.app, ro))!;
    expect(view.versionNo).toBe(3);
    expect(view.versions.map((v) => v.status)).toEqual(["withdrawn", "discarded", "draft"]);
    expect(view.versions[0]).toMatchObject({ outcome: "withdrawn", reasonCode: "no_response" });
  });

  it("the first version is never discarded", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    await expect(discardDraft(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "first_version",
    });
  });

  // --- OD-58 ---------------------------------------------------------------------------------

  it("every version addresses each open urgent finding again (OD-58)", async () => {
    const ro = await newRepairOrder();
    const leak = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Brake fluid leak", severity: "urgent", internalNote: "" },
        randomUUID(),
      )
    ).result.findingId;
    const belt = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Cracked belt", severity: "urgent", internalNote: "" },
        randomUUID(),
      )
    ).result.findingId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    let view = (await estimateView(db.app, ro))!;
    const leakJob = view.jobs.find((job) => job.findingId === leak)!.id;
    const beltJob = view.jobs.find((job) => job.findingId === belt)!.id;
    // v1: the leak is left out with a reason; the belt is offered.
    await removeJob(
      db.app,
      people.advisor!,
      leakJob,
      { reason: "Customer goes to the dealer" },
      randomUUID(),
    );
    await addLine(db.app, people.advisor!, beltJob, { itemId: items.labor, qty: "1" }, randomUUID());
    const other = (await addJob(db.app, people.advisor!, ro, { title: "Oil change" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, other, { itemId: items.cleaner, qty: "1" }, randomUUID());
    const v1 = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(v1.versionId, v1.contentHash, [{ jobId: other, decision: "approved" }]);
    await withdraw(ro); // the belt lapses

    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const extra = (await addJob(db.app, people.advisor!, ro, { title: "Wipers" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, extra, { itemId: items.cleaner, qty: "1" }, randomUUID());
    view = (await estimateView(db.app, ro))!;
    const state = (id: string) => view.urgentFindings.find((f) => f.findingId === id)!;
    expect(state(leak)).toMatchObject({ state: "open", reofferJobId: null });
    expect(state(belt)).toMatchObject({ state: "open", reofferJobId: beltJob });
    await expect(sendVersion(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "urgent_finding_open",
    });

    // Leave both out for this version (the belt's lapsed job is not "included").
    await excludeUrgentFinding(
      db.app,
      people.advisor!,
      ro,
      { findingId: leak, reason: "Still going to the dealer" },
      randomUUID(),
    );
    await expect(
      addJob(db.app, people.advisor!, ro, { findingId: belt }, randomUUID()),
    ).rejects.toMatchObject({ code: "finding_already_included" }); // offered again instead, below
    await reproposeJob(db.app, people.advisor!, beltJob, randomUUID());
    view = (await estimateView(db.app, ro))!;
    expect(state(leak).state).toBe("excluded");
    expect(state(belt).state).toBe("included");
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
  });

  // --- Database guards -----------------------------------------------------------------------

  it("the database keeps version endings and lapses consistent", async () => {
    const { ro, b, versionId } = await sentThreeJobs();
    const bRev = (await latestRevision(b)).id;
    // No status change without its recorded end.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE estimate_version SET status = 'withdrawn' WHERE id = '${versionId}'`,
        )
      )?.code,
    ).toBe("42501");
    // No lapse while the version is still sent; no lapse reason without a lapse.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE job_revision SET status = 'lapsed', lapse_reason = 'withdrawn' WHERE id = '${bRev}'`,
        )
      )?.code,
    ).toBe("42501");
    // A withdrawal names its reason; "other" needs text.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO estimate_version_end (estimate_version_id, outcome, ended_by)
           VALUES ('${versionId}', 'withdrawn', '${people.advisor!.userId}')`,
        )
      )?.code,
    ).toBe("23514");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO estimate_version_end (estimate_version_id, outcome, reason_code, ended_by)
           VALUES ('${versionId}', 'withdrawn', 'other', '${people.advisor!.userId}')`,
        )
      )?.code,
    ).toBe("23514");
    // Not expired before its time.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO estimate_version_end (estimate_version_id, outcome) VALUES ('${versionId}', 'expired')`,
        )
      )?.code,
    ).toBe("42501");
    // Status moved with its end row but the pending work not lapsed: refused at commit (deferred check).
    const unlapsed = await sqlErrorAs(
      db.appUrl,
      `BEGIN;
       INSERT INTO estimate_version_end (estimate_version_id, outcome, reason_code, ended_by)
         VALUES ('${versionId}', 'withdrawn', 'no_response', '${people.advisor!.userId}');
       UPDATE estimate_version SET status = 'withdrawn' WHERE id = '${versionId}';
       COMMIT;`,
    );
    expect(unlapsed?.message).toMatch(/ended with revisions still open/);
    expect((await versionsOf(ro))[0]!.status).toBe("sent");
    await withdraw(ro);
    // The end record is insert-only.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE estimate_version_end SET reason = 'x' WHERE estimate_version_id = '${versionId}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `DELETE FROM estimate_version_end WHERE estimate_version_id = '${versionId}'`,
        )
      )?.code,
    ).toBe("42501");
    // A lapsed revision never becomes pending or approved again.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE job_revision SET status = 'pending', lapse_reason = NULL WHERE id = '${bRev}'`,
        )
      )?.code,
    ).toBe("42501");
    // Revision numbers run in sequence, and only lapsed or declined jobs get another.
    const v2 = (await startVersion(db.app, people.advisor!, ro, randomUUID())).result.versionId;
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO job_revision (job_id, revision_no, kind, proposed_in_version_id) VALUES ('${b}', 3, 'original', '${v2}')`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `INSERT INTO job_revision (job_id, revision_no, kind, proposed_in_version_id) VALUES ('${b}', 2, 'add_scope', '${v2}')`,
        )
      )?.code,
    ).toBe("42501");
  });

  // --- Review follow-ups ----------------------------------------------------------------------

  it("an urgent job left out of v2 and then offered again: the reason is cleared; removing it records one reason", async () => {
    const ro = await newRepairOrder();
    const belt = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Cracked belt", severity: "urgent", internalNote: "" },
        randomUUID(),
      )
    ).result.findingId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const beltJob = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await addLine(db.app, people.advisor!, beltJob, { itemId: items.labor, qty: "1" }, randomUUID());
    const other = (await addJob(db.app, people.advisor!, ro, { title: "Oil change" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, other, { itemId: items.cleaner, qty: "1" }, randomUUID());
    const v1 = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(v1.versionId, v1.contentHash, [{ jobId: other, decision: "approved" }]);
    await withdraw(ro);
    const v2 = (await startVersion(db.app, people.advisor!, ro, randomUUID())).result.versionId;
    await excludeUrgentFinding(
      db.app,
      people.advisor!,
      ro,
      { findingId: belt, reason: "Next visit" },
      randomUUID(),
    );
    const offered = await reproposeJob(db.app, people.advisor!, beltJob, randomUUID());
    expect(offered.result.revisionId).toBeTruthy();
    const live = () =>
      db.app
        .selectFrom("urgent_finding_exclusion")
        .select("reason")
        .where("estimate_version_id", "=", v2)
        .where("finding_id", "=", belt)
        .where("cleared_at", "is", null)
        .execute();
    expect(await live()).toEqual([]);
    expect((await estimateView(db.app, ro))!.urgentFindings[0]!.state).toBe("included");
    // Removing the re-offer of an urgent job needs a reason, recorded once.
    await expect(removeJob(db.app, people.advisor!, beltJob, {}, randomUUID())).rejects.toMatchObject({
      details: { field: "reason" },
    });
    await removeJob(db.app, people.advisor!, beltJob, { reason: "Customer will decide later" }, randomUUID());
    expect(await live()).toEqual([{ reason: "Customer will decide later" }]);
    expect((await estimateView(db.app, ro))!.urgentFindings[0]!.state).toBe("excluded");
  });

  it("an urgent job the customer declined counts as decided in later versions, even if its re-offer lapsed (OD-58)", async () => {
    const ro = await newRepairOrder();
    const belt = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Cracked belt", severity: "urgent", internalNote: "" },
        randomUUID(),
      )
    ).result.findingId;
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const beltJob = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await addLine(db.app, people.advisor!, beltJob, { itemId: items.labor, qty: "1" }, randomUUID());
    const v1 = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(v1.versionId, v1.contentHash, [{ jobId: beltJob, decision: "declined" }]);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    expect((await estimateView(db.app, ro))!.urgentFindings[0]).toMatchObject({
      findingId: belt,
      state: "decided",
    });
    await reproposeJob(db.app, people.advisor!, beltJob, randomUUID());
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
    await withdraw(ro); // the re-offer lapses
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const extra = (await addJob(db.app, people.advisor!, ro, { title: "Wipers" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, extra, { itemId: items.cleaner, qty: "1" }, randomUUID());
    const view = (await estimateView(db.app, ro))!;
    expect(view.urgentFindings[0]).toMatchObject({ state: "decided" });
    // The screen and send agree: no reason needed, and none can be recorded.
    await expect(
      excludeUrgentFinding(db.app, people.advisor!, ro, { findingId: belt, reason: "x" }, randomUUID()),
    ).rejects.toMatchObject({ code: "finding_already_included" });
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
  });

  it("racing: two new versions at once make one; two re-offers of a job make one revision", async () => {
    const { ro, a, b, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await withdraw(ro);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const starts = Promise.allSettled([
        startVersion(db.app, people.advisor!, ro, randomUUID()),
        startVersion(db.app, people.manager!, ro, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await starts;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "version_still_open",
      });

      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const offers = Promise.allSettled([
        reproposeJob(db.app, people.advisor!, b, randomUUID()),
        reproposeJob(db.app, people.manager!, b, randomUUID()),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const offered = await offers;
      expect(offered.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((offered.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "not_reproposable",
      });
      expect((await revisionsOf(b)).map((r) => r.status)).toEqual(["lapsed", "draft"]);
    } finally {
      await holder.end();
    }
    expect((await versionsOf(ro)).map((v) => v.status)).toEqual(["withdrawn", "draft"]);
  });

  it("starting a version, offering again and discarding replay under the same key (rule 11)", async () => {
    const { ro, a, b, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await withdraw(ro);
    const startKey = randomUUID();
    const first = await startVersion(db.app, people.advisor!, ro, startKey);
    const again = await startVersion(db.app, people.advisor!, ro, startKey);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    const offerKey = randomUUID();
    const offer = await reproposeJob(db.app, people.advisor!, b, offerKey);
    const offerAgain = await reproposeJob(db.app, people.advisor!, b, offerKey);
    expect(offerAgain.replayed).toBe(true);
    expect(offerAgain.result).toEqual(offer.result);
    expect(await revisionsOf(b)).toHaveLength(2);
    expect(
      await db.app
        .selectFrom("revision_line")
        .select("id")
        .where("revision_id", "=", offer.result.revisionId)
        .execute(),
    ).toHaveLength(1);
    const discardKey = randomUUID();
    await discardDraft(db.app, people.advisor!, ro, discardKey);
    expect((await discardDraft(db.app, people.advisor!, ro, discardKey)).replayed).toBe(true);
    expect((await versionsOf(ro)).map((v) => v.status)).toEqual(["withdrawn", "discarded"]);
  });

  it("QC waits while a later version is an unsent draft; discarding it unblocks QC (OD-59)", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await finish(a);
    await withdraw(ro);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await addJob(db.app, people.advisor!, ro, { title: "Air filter" }, randomUUID());
    await expect(requestQc(db.app, people.tech!, ro, randomUUID())).rejects.toMatchObject({
      code: "draft_open",
      details: { version: "2" },
    });
    // The database refuses it as well.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'qc' WHERE id = '${ro}'`))?.message,
    ).toMatch(/unsent estimate draft/);
    // The counter screen never shows v1's closed document in place of the newer draft.
    expect(await approvalScreenView(db.app, ro)).toBeNull();
    await discardDraft(db.app, people.advisor!, ro, randomUUID());
    await requestQc(db.app, people.tech!, ro, randomUUID());
    expect(await roStatus(ro)).toBe("qc");
  });

  // --- Customer document ---------------------------------------------------------------------

  it("the customer's document lists earlier approvals with no decision control, in Arabic and English", async () => {
    const { ro, a, versionId, contentHash } = await sentThreeJobs();
    await approve(versionId, contentHash, [{ jobId: a, decision: "approved" }]);
    await withdraw(ro);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const pins = (await addJob(db.app, people.advisor!, ro, { title: "Slider pins" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, pins, { itemId: items.cleaner, qty: "1" }, randomUUID());
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
    const snapshot = (await approvalScreenView(db.app, ro))!.snapshot;
    for (const [locale, heading] of [
      ["en", "Already approved"],
      ["ar", "تمت الموافقة عليه سابقاً"],
    ] as const) {
      const html = renderToStaticMarkup(<EstimateDocument snapshot={snapshot} locale={locale} />);
      expect(html).toContain(heading);
      expect(html).toContain(`data-context-revision="${(await latestRevision(a)).id}"`);
      expect(html).toContain("Front brakes");
      // The context section has no form controls; only the new job is a decidable section.
      const context = html.slice(
        html.indexOf("estimate-document-context"),
        html.indexOf("estimate-document-job"),
      );
      expect(context).not.toMatch(/<input|<button|<select/);
      expect(html).toContain(`data-revision="${(await latestRevision(pins)).id}"`);
    }
  });
});
