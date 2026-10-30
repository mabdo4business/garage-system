import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import pg from "pg";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkPage } from "../src/components/link-page";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { estimateView } from "../src/server/estimate/queries";
import { reproposeJob, startVersion, withdrawVersion } from "../src/server/estimate/versions";
import { recordFinding } from "../src/server/inspection/commands";
import { recordLinkApproval } from "../src/server/links/approval";
import { createCustomerLink, revokeCustomerLink } from "../src/server/links/commands";
import { openCustomerLink } from "../src/server/links/customer";
import { LocalDiskStorage } from "../src/server/media/storage";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, startJob } from "../src/server/workshop/commands";
import { createTestDatabase, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser } from "./helpers/users";

/**
 * I2-03b — approval through the customer link (PRD v0.2 §6.4, OD-60–OD-62): the typed name and per-job decisions
 * recorded at link-possession level with the link, IP and browser as evidence; one decision per form (AC2-03); no
 * decision on a withdrawn or expired version (AC2-02, AC21-05, AC21-07); tampering counted (AC2-05); and the races
 * with an in-person decision and a revoke.
 */

describe("S29 — approval through the customer link", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  const people: Record<string, Staff> = {};
  const items: Record<string, string> = {};
  let ipCounter = 0;
  const freshIp = () => `203.0.113.${++ipCounter}`;
  const visitor = (ip = freshIp()) => ({ ip, userAgent: "Mozilla/5.0 (Android; customer phone)" });

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-link-approval-"));
    storage = new LocalDiskStorage(storageDir);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
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
    items.labor = (
      await createItem(
        db.app,
        people.manager!,
        {
          kind: "labor_rate",
          code: "LAB-A",
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
  /** A sent v1: "Brake pads" from an urgent finding and "AC service", each one labour line; and its link. */
  async function linked() {
    counter++;
    const advisor = { kind: "user" as const, userId: people.advisor!.userId };
    const customerId = (
      await createCustomer(
        db.app,
        advisor,
        {
          nameEn: `Omar Approve${counter}`,
          mobile: `0551${String(counter).padStart(6, "0")}`,
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
          make: "Kia",
          model: "Sportage",
          year: 2022,
          plate: { emirate: "sharjah", code: "AP", number: String(40000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 30000,
      concerns: "Brakes",
      contactName: "Omar",
      photoShortfallReason: "Test fixture",
    });
    const ro = (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
    await recordFinding(
      db.app,
      people.advisor!,
      ro,
      { title: "Brake pads", severity: "urgent" },
      randomUUID(),
    );
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const brakes = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await addLine(db.app, people.advisor!, brakes, { itemId: items.labor, qty: "1" }, randomUUID());
    const ac = (await addJob(db.app, people.advisor!, ro, { title: "AC service" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, ac, { itemId: items.labor, qty: "1" }, randomUUID());
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const link = (await createCustomerLink(db.app, people.advisor!, ro)).result;
    const revisionOf = async (jobId: string) =>
      (
        await db.app
          .selectFrom("job_revision")
          .select("id")
          .where("job_id", "=", jobId)
          .where("proposed_in_version_id", "=", versionId)
          .executeTakeFirstOrThrow()
      ).id;
    return {
      ro,
      brakes,
      ac,
      versionId,
      contentHash,
      ...link,
      brakesRev: await revisionOf(brakes),
      acRev: await revisionOf(ac),
    };
  }

  const submit = (
    token: string,
    decisions: { revisionId: string; decision: string }[],
    options: { name?: string; key?: string; requester?: ReturnType<typeof visitor>; language?: string } = {},
  ) =>
    recordLinkApproval(
      db.app,
      token,
      { approverName: options.name ?? "عمر الشامسي", decisions, language: options.language ?? "ar" },
      options.requester ?? visitor(),
      options.key ?? randomUUID(),
    );

  const eventsOf = (versionId: string) =>
    db.app.selectFrom("approval_event").selectAll().where("estimate_version_id", "=", versionId).execute();

  async function overdue(versionId: string) {
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition`.execute(tx);
      await sql`UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = ${versionId}`.execute(
        tx,
      );
      await sql`ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition`.execute(tx);
    });
  }

  // --- Recording, with its evidence -------------------------------------------------------------

  it("records the decisions at L1 with the typed name, link, IP, browser, contact, hash and language (§6.4)", async () => {
    const x = await linked();
    const requester = visitor();
    const outcome = await submit(
      x.token,
      [
        { revisionId: x.acRev, decision: "approved" },
        { revisionId: x.brakesRev, decision: "declined" },
      ],
      { name: "  عمر الشامسي  ", requester },
    );
    expect(outcome).toMatchObject({ kind: "recorded", replayed: false });

    const [event] = await eventsOf(x.versionId);
    const ro = await db.app
      .selectFrom("repair_order")
      .select(["status", "contact_name", "contact_mobile"])
      .where("id", "=", x.ro)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      method: "link",
      verification_level: "possession",
      approver_name: "عمر الشامسي", // as typed (trimmed), never matched with the contact (OD-61)
      customer_link_id: x.linkId,
      ip: requester.ip,
      user_agent: requester.userAgent,
      contact_name: ro.contact_name,
      contact_mobile: ro.contact_mobile,
      displayed_language: "ar",
      content_hash: x.contentHash,
      recorded_by: null,
      signature_sha256: null,
    });
    const decisions = await db.app
      .selectFrom("revision_decision")
      .select(["revision_id", "decision", "urgent_ack_pending"])
      .where("approval_event_id", "=", event!.id)
      .orderBy("decision")
      .execute();
    expect(decisions).toEqual([
      { revision_id: x.acRev, decision: "approved", urgent_ack_pending: false },
      { revision_id: x.brakesRev, decision: "declined", urgent_ack_pending: true }, // OD-25
    ]);
    expect(ro.status).toBe("in_progress"); // T-22
    const version = await db.app
      .selectFrom("estimate_version")
      .select("status")
      .where("id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(version.status).toBe("closed");

    const audit = await db.app
      .selectFrom("audit_event")
      .select(["actor_label", "after_state"])
      .where("action", "=", "estimate.approval_recorded")
      .where("entity_id", "=", event!.id)
      .executeTakeFirstOrThrow();
    expect(audit.actor_label).toBe("anonymous");
    expect(audit.after_state).toMatchObject({ method: "link", linkId: x.linkId, versionClosed: true });
    // Neither the token nor the IP is copied anywhere else.
    for (const table of ["audit_event", "idempotency_key"] as const) {
      const dump = await sql<{
        t: string | null;
      }>`SELECT string_agg(x::text, '') AS t FROM ${sql.table(table)} x`.execute(db.owner);
      expect(dump.rows[0]!.t ?? "").not.toContain(x.token);
      expect(dump.rows[0]!.t ?? "").not.toContain(requester.ip);
    }
    // Staff see who decided through the link.
    expect((await estimateView(db.app, x.ro))!.linkDecisions).toEqual([
      { approverName: "عمر الشامسي", recordedAt: expect.any(Date) },
    ]);
  });

  it("AC2-01: work approved through the link can start; the declined job cannot", async () => {
    const x = await linked();
    await submit(x.token, [
      { revisionId: x.acRev, decision: "approved" },
      { revisionId: x.brakesRev, decision: "declined" },
    ]);
    for (const job of [x.ac, x.brakes]) {
      await assignJob(db.app, people.manager!, job, { assigneeId: people.tech!.userId }, randomUUID()).catch(
        () => undefined,
      );
    }
    await expect(startJob(db.app, people.tech!, x.ac, randomUUID())).resolves.toBeDefined();
    await expect(startJob(db.app, people.tech!, x.brakes, randomUUID())).rejects.toBeDefined();
  });

  it("partial decision: jobs left for later stay pending, the version stays sent and the form offers only them", async () => {
    const x = await linked();
    await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]);
    const version = await db.app
      .selectFrom("estimate_version")
      .select("status")
      .where("id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(version.status).toBe("sent");
    const page = await openCustomerLink(db.app, x.token, visitor());
    expect(page.kind === "estimate" && page.estimate.pendingRevisionIds).toEqual([x.brakesRev]);
    const markup = renderToStaticMarkup(
      <LinkPage locale="en" token={x.token} page={page} idempotencyKey={randomUUID()} done />,
    );
    expect(markup).toContain(`name="decision.${x.brakesRev}"`);
    expect(markup).not.toContain(`name="decision.${x.acRev}"`);
    expect(markup).toContain("Thank you — your decision has been recorded");
    // The second decision completes it.
    await submit(x.token, [{ revisionId: x.brakesRev, decision: "approved" }]);
    expect(await eventsOf(x.versionId)).toHaveLength(2);
  });

  it("refuses a form without a name or without any decision, and records nothing", async () => {
    const x = await linked();
    await expect(
      submit(x.token, [{ revisionId: x.acRev, decision: "approved" }], { name: "  " }),
    ).rejects.toMatchObject({
      details: { field: "approverName" },
    });
    await expect(submit(x.token, [])).rejects.toMatchObject({ details: { field: "decisions" } });
    await expect(submit(x.token, [{ revisionId: x.acRev, decision: "maybe" }])).rejects.toMatchObject({
      details: { field: "decisions" },
    });
    expect(await eventsOf(x.versionId)).toEqual([]);
  });

  // --- AC2-03 -----------------------------------------------------------------------------------

  it("AC2-03: Confirm tapped twice stores one decision and both answers agree; a later form finds it decided", async () => {
    const x = await linked();
    const key = randomUUID();
    const decisions = [{ revisionId: x.acRev, decision: "approved" }];
    const [first, second] = await Promise.all([
      submit(x.token, decisions, { key }),
      submit(x.token, decisions, { key }),
    ]);
    expect(first.kind).toBe("recorded");
    expect(second.kind).toBe("recorded");
    if (first.kind !== "recorded" || second.kind !== "recorded") return;
    expect(second.approvalEventId).toBe(first.approvalEventId);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(await eventsOf(x.versionId)).toHaveLength(1);
    // A new form (new key) deciding the same job: nothing pending for it, the page shows what was recorded.
    expect(await submit(x.token, decisions)).toEqual({ kind: "refused", page: "decided" });
    expect(await eventsOf(x.versionId)).toHaveLength(1);
  });

  // --- AC2-02, AC21-05, AC21-07 -------------------------------------------------------------------

  it("AC2-02: v2 withdrawn and v3 sent — a decision through the v2 link is refused, nothing is recorded on either, the page says it was updated", async () => {
    const x = await linked();
    await withdrawVersion(db.app, people.advisor!, x.ro, { reasonCode: "needs_changes" }, randomUUID());
    expect(await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }])).toEqual({
      kind: "refused",
      page: "updated",
    });
    // v3 is sent with its own link; the old link still refuses and never shows it.
    await startVersion(db.app, people.advisor!, x.ro, randomUUID());
    await reproposeJob(db.app, people.advisor!, x.brakes, randomUUID()); // OD-58: the urgent finding stays covered
    const job = (await addJob(db.app, people.advisor!, x.ro, { title: "V3-ONLY" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, job, { itemId: items.labor, qty: "1" }, randomUUID());
    const v3 = (await sendVersion(db.app, people.advisor!, x.ro, randomUUID())).result.versionId;
    await createCustomerLink(db.app, people.advisor!, x.ro);
    expect(await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }])).toEqual({
      kind: "refused",
      page: "updated",
    });
    expect(await eventsOf(x.versionId)).toEqual([]);
    expect(await eventsOf(v3)).toEqual([]);
    expect(await openCustomerLink(db.app, x.token, visitor())).toEqual({ kind: "updated" });
  });

  it("AC21-05: a link approval racing a withdrawal ends one way — never a decision and a lapse on the same job", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await linked();
      const [approval, withdrawal] = await Promise.allSettled([
        submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]),
        withdrawVersion(db.app, people.advisor!, x.ro, { reasonCode: "no_response" }, randomUUID()),
      ]);
      const revision = await db.app
        .selectFrom("job_revision")
        .leftJoin("revision_decision", "revision_decision.revision_id", "job_revision.id")
        .select(["job_revision.status", "revision_decision.decision"])
        .where("job_revision.id", "=", x.acRev)
        .executeTakeFirstOrThrow();
      if (revision.decision) {
        expect(revision.status).toBe("approved");
        expect(approval).toMatchObject({ status: "fulfilled", value: { kind: "recorded" } });
      } else {
        expect(revision.status).toBe("lapsed");
        expect(withdrawal.status).toBe("fulfilled");
        expect(approval).toMatchObject({ status: "fulfilled", value: { kind: "refused", page: "updated" } });
      }
    }
  });

  it("AC21-07: JR-A approved through the link, the version passes its expiry, a submission on JR-B records the expiry — JR-B lapses, JR-A stays approved", async () => {
    const x = await linked();
    await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]);
    await overdue(x.versionId); // no scheduler has run
    expect(await submit(x.token, [{ revisionId: x.brakesRev, decision: "approved" }])).toEqual({
      kind: "refused",
      page: "invalid",
    });
    const revisions = await db.app
      .selectFrom("job_revision")
      .select(["id", "status", "lapse_reason"])
      .where("proposed_in_version_id", "=", x.versionId)
      .execute();
    expect(revisions.find((r) => r.id === x.acRev)).toMatchObject({ status: "approved" });
    expect(revisions.find((r) => r.id === x.brakesRev)).toMatchObject({
      status: "lapsed",
      lapse_reason: "expired",
    });
    const version = await db.app
      .selectFrom("estimate_version")
      .select("status")
      .where("id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(version.status).toBe("expired");
    const audit = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "estimate.expired")
      .where("entity_id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ trigger: "submission" });
    expect(await eventsOf(x.versionId)).toHaveLength(1); // only JR-A's
  });

  it("every submission counts toward the link's request limit (T-42); staff's opened count is openings only", async () => {
    const x = await linked();
    await sql`UPDATE app_setting SET value = '2' WHERE key = 'link.requests_per_link_10min'`.execute(
      db.owner,
    );
    try {
      await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]);
      expect(await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }])).toEqual({
        kind: "refused",
        page: "decided",
      });
      // Two submissions recorded: the third, from anywhere, finds the link resting.
      expect(await submit(x.token, [{ revisionId: x.brakesRev, decision: "approved" }])).toEqual({
        kind: "refused",
        page: "blocked",
      });
    } finally {
      await sql`UPDATE app_setting SET value = '60' WHERE key = 'link.requests_per_link_10min'`.execute(
        db.owner,
      );
    }
    const outcomes = await db.app
      .selectFrom("customer_link_access")
      .select("outcome")
      .where("customer_link_id", "=", x.linkId)
      .execute();
    expect(outcomes.map((row) => row.outcome)).toEqual(["submitted", "submitted"]);
    const audit = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("entity_id", "=", x.linkId)
      .where("action", "=", "link.submitted")
      .execute();
    expect(audit).toHaveLength(2);
  });

  it("AC21-07: expiring while the submission waits for the lock — the command records the expiry and refuses", async () => {
    const x = await linked();
    // Someone holds the repair order; the submission passes the link check and waits for the lock. Meanwhile the
    // version passes its expiry. When the lock frees, the command itself must find it due, expire it and refuse.
    const blocker = new pg.Client({ connectionString: db.ownerUrl });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [x.ro]);
      const submission = submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]);
      await waitForLockWaiters(db, 1);
      await blocker.query("ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition");
      await blocker.query(
        "UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [x.versionId],
      );
      await blocker.query("ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition");
      await blocker.query("COMMIT");
      expect(await submission).toEqual({ kind: "refused", page: "invalid" });
    } finally {
      await blocker.end();
    }
    expect(await eventsOf(x.versionId)).toEqual([]);
    const version = await db.app
      .selectFrom("estimate_version")
      .select("status")
      .where("id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(version.status).toBe("expired"); // committed although the submission was refused
    const audit = await db.app
      .selectFrom("audit_event")
      .select("details")
      .where("action", "=", "estimate.expired")
      .where("entity_id", "=", x.versionId)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ trigger: "submission" });
  });

  // --- AC2-05 -----------------------------------------------------------------------------------

  it("AC2-05: a job from another estimate or a tampered token counts as an invalid attempt; a blocked IP is refused", async () => {
    const x = await linked();
    const other = await linked();
    const ip = freshIp();
    expect(
      await submit(x.token, [{ revisionId: other.acRev, decision: "approved" }], { requester: visitor(ip) }),
    ).toEqual({ kind: "refused", page: "invalid" });
    const tampered = x.token.slice(0, -1) + (x.token.endsWith("A") ? "B" : "A");
    expect(
      await submit(tampered, [{ revisionId: x.acRev, decision: "approved" }], { requester: visitor(ip) }),
    ).toEqual({
      kind: "refused",
      page: "invalid",
    });
    const invalid = await db.app
      .selectFrom("customer_link_access")
      .select("customer_link_id")
      .where("ip", "=", ip)
      .where("outcome", "=", "invalid")
      .execute();
    expect(invalid.map((row) => row.customer_link_id).sort()).toEqual([null, x.linkId].sort());
    for (let i = 0; i < 9; i++) await openCustomerLink(db.app, `${"T".repeat(42)}${i}`, visitor(ip));
    expect(
      await submit(x.token, [{ revisionId: x.acRev, decision: "approved" }], { requester: visitor(ip) }),
    ).toEqual({
      kind: "refused",
      page: "blocked",
    });
    expect(await eventsOf(x.versionId)).toEqual([]);
    expect(await eventsOf(other.versionId)).toEqual([]);
  });

  // --- Races ------------------------------------------------------------------------------------

  it("two link submissions from two forms at once: one decision", async () => {
    const x = await linked();
    const decisions = [{ revisionId: x.acRev, decision: "approved" }];
    const results = await Promise.all([submit(x.token, decisions), submit(x.token, decisions)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["recorded", "refused"]);
    expect(await eventsOf(x.versionId)).toHaveLength(1);
  });

  it("a link decision racing an in-person decision on the same job: one decision", async () => {
    const x = await linked();
    const [link, inPerson] = await Promise.allSettled([
      submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]),
      recordInPersonApproval(
        db.app,
        storage,
        people.advisor!,
        {
          versionId: x.versionId,
          contentHash: x.contentHash,
          language: "en",
          approverName: "Omar",
          decisions: [{ revisionId: x.acRev, decision: "declined" }],
          signature: makePng(600, 200, counter),
        },
        randomUUID(),
      ),
    ]);
    const decisions = await db.app
      .selectFrom("revision_decision")
      .select("decision")
      .where("revision_id", "=", x.acRev)
      .execute();
    expect(decisions).toHaveLength(1);
    const linkWon = link.status === "fulfilled" && link.value.kind === "recorded";
    expect(linkWon).toBe(inPerson.status === "rejected");
  });

  it("a link revoked while the submission waits for the lock: the command sees it and refuses with the invalid page", async () => {
    const x = await linked();
    // The revoke commits while the submission (past its link check) waits on the repair order — exactly the window
    // the in-transaction re-check exists for; without it the database guard would fail the request outright.
    const blocker = new pg.Client({ connectionString: db.ownerUrl });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [x.ro]);
      const submission = submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]);
      await waitForLockWaiters(db, 1);
      await blocker.query(
        "UPDATE customer_link SET revoked_at = now(), revoked_by = $2, revoke_reason = 'manual' WHERE id = $1",
        [x.linkId, people.advisor!.userId],
      );
      await blocker.query("COMMIT");
      expect(await submission).toEqual({ kind: "refused", page: "invalid" });
    } finally {
      await blocker.end();
    }
    expect(await eventsOf(x.versionId)).toEqual([]);
  });

  it("a revoke and a submission at once: one or the other, never a decision through a revoked link", async () => {
    const x = await linked();
    const [submission] = await Promise.all([
      submit(x.token, [{ revisionId: x.acRev, decision: "approved" }]),
      revokeCustomerLink(db.app, people.advisor!, x.linkId),
    ]);
    const events = await eventsOf(x.versionId);
    if (submission.kind === "recorded") {
      const link = await db.app
        .selectFrom("customer_link")
        .select("revoked_at")
        .where("id", "=", x.linkId)
        .executeTakeFirstOrThrow();
      expect(events[0]!.recorded_at.getTime()).toBeLessThanOrEqual(link.revoked_at!.getTime());
    } else {
      expect(submission).toEqual({ kind: "refused", page: "invalid" });
      expect(events).toEqual([]);
    }
  });

  // --- The database's own guard ------------------------------------------------------------------

  it("the database refuses link evidence on the wrong method, a link from another version, and a revoked link", async () => {
    const x = await linked();
    const other = await linked();
    const ro = await db.app
      .selectFrom("repair_order")
      .select(["contact_name", "contact_mobile"])
      .where("id", "=", x.ro)
      .executeTakeFirstOrThrow();
    const row = (overrides: Record<string, unknown>) => ({
      estimate_version_id: x.versionId,
      method: "link" as const,
      verification_level: "possession" as const,
      approver_name: "Omar",
      signature_sha256: null,
      signature_storage_key: null,
      signature_content_type: null,
      contact_name: ro.contact_name,
      contact_mobile: ro.contact_mobile,
      displayed_language: "en" as const,
      terms_ar_id: null,
      terms_en_id: null,
      content_hash: x.contentHash,
      idempotency_key: randomUUID(),
      recorded_by: null,
      customer_link_id: x.linkId,
      ip: "203.0.113.250",
      user_agent: "UA",
      ...overrides,
    });
    const insert = (overrides: Record<string, unknown>) =>
      db.app.insertInto("approval_event").values(row(overrides)).execute();
    await expect(insert({ customer_link_id: null, ip: null })).rejects.toThrow(
      /live link to its own version/,
    );
    await expect(insert({ customer_link_id: other.linkId })).rejects.toThrow(/live link to its own version/);
    await expect(insert({ ip: null })).rejects.toThrow(/approval_event_link_evidence/);
    await expect(insert({ verification_level: "in_person" })).rejects.toThrow(/approval_event_link_evidence/);
    await expect(insert({ recorded_by: people.advisor!.userId })).rejects.toThrow(
      /approval_event_link_evidence/,
    );
    await expect(
      insert({
        method: "in_person_signature",
        verification_level: "in_person",
        recorded_by: people.advisor!.userId,
        signature_sha256: "a".repeat(64),
        signature_storage_key: "signatures/x.png",
        signature_content_type: "image/png",
      }),
    ).rejects.toThrow(/approval_event_link_evidence/);
    await revokeCustomerLink(db.app, people.advisor!, x.linkId);
    await expect(insert({})).rejects.toThrow(/live link to its own version/);
    expect(await eventsOf(x.versionId)).toEqual([]);
  });
});
