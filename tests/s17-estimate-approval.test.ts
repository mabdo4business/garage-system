import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createItem, setPrice } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode, setTaxCodeRate } from "../src/server/catalog/tax";
import { canonicalJson, sha256Hex } from "../src/server/core/json";
import { createCustomer } from "../src/server/customer/service";
import {
  authorizedScope,
  isJobAuthorized,
  recordInPersonApproval,
  sendVersion,
} from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { approvalScreenView, estimateView } from "../src/server/estimate/queries";
import type { EstimateSnapshot } from "../src/server/estimate/snapshot";
import { createHandlers } from "../src/server/http/handlers";
import { recordFinding, updateFinding } from "../src/server/inspection/commands";
import { LocalDiskStorage } from "../src/server/media/storage";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { createVehicle } from "../src/server/vehicle/service";
import { createTestDatabase, sqlErrorAs, waitForLockWaiters, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I1-05b — sending the estimate (canonical snapshot + hash, P0-11 / AT-20 basic) and in-person approval
 * (OD-20): whole-job decisions, AC2-01 (unapproved work cannot start), AC2-12 after sending, OD-25, T-21, T-22.
 */

describe("S17 — estimate send and in-person approval", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  const signature = makePng(600, 200, 7);

  const today = async () =>
    (
      await sql<{
        d: string;
      }>`SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS d`.execute(db.app)
    ).rows[0]!.d;

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-approval-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
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
    // Test data a partner would enter (OD-13).
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
    const item = async (kind: string, code: string, price: string, taxCode = "STD", unit?: string) =>
      (
        await createItem(
          db.app,
          people.manager!,
          { kind, code, nameEn: `${code} EN`, nameAr: `${code} AR`, price, taxCode, unit },
          randomUUID(),
        )
      ).result.itemId;
    items.labor = await item("labor_rate", "LAB-1", "150.00");
    items.part = await item("part", "PRT-1", "12.35", "STD", "piece");
    items.changing = await item("part", "PRT-CHG", "20.00", "CHG", "piece");
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
          nameEn: `Approval Customer ${counter}`,
          mobile: `0547${String(counter).padStart(6, "0")}`,
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
          make: "Toyota",
          model: "Camry",
          year: 2021,
          plate: { emirate: "sharjah", code: "AP", number: String(50000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 45000,
      concerns: "Brakes and AC",
      photoShortfallReason: "Test fixture",
    });
    return (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
  }

  /** A repair order with an estimate of two jobs: "Brakes" (from an urgent finding) and "AC service". */
  async function twoJobEstimate() {
    const ro = await newRepairOrder();
    await recordFinding(
      db.app,
      people.advisor!,
      ro,
      { title: "Brake pads at 2 mm", severity: "urgent", internalNote: "INTERNAL-NOTE-XYZ" },
      randomUUID(),
    );
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const brakes = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await addLine(db.app, people.advisor!, brakes, { itemId: items.labor, qty: "1.5" }, randomUUID());
    await addLine(db.app, people.advisor!, brakes, { itemId: items.part, qty: "2" }, randomUUID());
    const ac = (await addJob(db.app, people.advisor!, ro, { title: "AC service" }, randomUUID())).result
      .jobId;
    await addLine(db.app, people.advisor!, ac, { itemId: items.labor, qty: "1" }, randomUUID());
    return { ro, brakes, ac };
  }

  async function versionOf(ro: string) {
    return db.app
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .selectAll("estimate_version")
      .where("estimate.repair_order_id", "=", ro)
      .executeTakeFirstOrThrow();
  }

  async function revisionOf(jobId: string) {
    return db.app
      .selectFrom("job_revision")
      .selectAll()
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();
  }

  const approve = async (
    versionId: string,
    contentHash: string,
    decisions: { revisionId: string; decision: string }[],
    overrides: Partial<{ language: string; approverName: string; signature: Uint8Array; staff: Staff }> = {},
    key = randomUUID(),
  ) =>
    recordInPersonApproval(
      db.app,
      storage,
      overrides.staff ?? people.advisor!,
      {
        versionId,
        contentHash,
        language: overrides.language ?? "ar",
        approverName: overrides.approverName ?? "Fatima Al Ali",
        decisions,
        signature: overrides.signature ?? signature,
      },
      key,
    );

  // --- Send --------------------------------------------------------------------------------

  it("sends: freezes a canonical snapshot whose hash is reproducible (AT-20 basic, P0-11)", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    const sent = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const version = await versionOf(ro);
    expect(version.status).toBe("sent");
    expect(version.content_hash).toBe(sent.contentHash);
    // The stored snapshot re-hashes to the stored hash with the fixed serialization.
    expect(sha256Hex(canonicalJson(version.snapshot))).toBe(version.content_hash);

    const snapshot = version.snapshot as EstimateSnapshot;
    expect(snapshot.schema).toBe(1);
    expect(snapshot.jobs.map((job) => [job.jobId, job.title, job.findingSeverity, job.total])).toEqual([
      [brakes, "Brake pads at 2 mm", "urgent", "249.70"],
      [ac, "AC service", null, "150.00"],
    ]);
    // Language-neutral: both descriptions travel together, whichever language is shown.
    expect(snapshot.jobs[0]!.lines[0]).toMatchObject({
      descriptionEn: "LAB-1 EN",
      descriptionAr: "LAB-1 AR",
    });
    expect(snapshot.totals).toMatchObject({ total: "399.70", net: "380.67", vat: "19.03" });
    expect(snapshot.pricing).toEqual({ pricesIncludeVat: true, vatMethod: "per_line_inclusive_half_up" });
    expect(snapshot.terms).toEqual({ ar: null, en: null }); // no terms text until the owners supply it (OD-20)
    expect(snapshot.expiresAt).toBe(version.expires_at!.toISOString());
    // OD-21: valid for 7 days.
    const days = (version.expires_at!.getTime() - version.sent_at!.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    // Rule 9: nothing internal or personal.
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("INTERNAL-NOTE-XYZ");
    expect(text).not.toContain("0547");
    expect(text).not.toContain(people.advisor!.userId);

    expect((await revisionOf(brakes)).status).toBe("pending");
    expect((await revisionOf(ac)).status).toBe("pending");
    const order = await db.app
      .selectFrom("repair_order")
      .select("status")
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    expect(order.status).toBe("awaiting_approval");
    const audit = await db.app
      .selectFrom("audit_event")
      .select("action")
      .where("action", "in", ["estimate.sent", "ro.awaiting_approval"])
      .where("entity_id", "in", [ro, version.id])
      .execute();
    expect(audit).toHaveLength(2);
  });

  it("refuses to send an empty estimate, a job without items or an undecided urgent finding (AC-05.2)", async () => {
    const empty = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, empty, randomUUID());
    await expect(sendVersion(db.app, people.advisor!, empty, randomUUID())).rejects.toMatchObject({
      code: "estimate_empty",
    });
    await addJob(db.app, people.advisor!, empty, { title: "Check noise" }, randomUUID());
    await expect(sendVersion(db.app, people.advisor!, empty, randomUUID())).rejects.toMatchObject({
      code: "job_without_lines",
    });

    const { ro } = await twoJobEstimate();
    // Set-up: an urgent finding that reached the table without the inspection command, so it has no job.
    await db.owner
      .insertInto("finding")
      .values({ repair_order_id: ro, title: "Steering rack leak", severity: "urgent" })
      .execute();
    await expect(sendVersion(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "urgent_finding_open",
    });
    expect((await versionOf(ro)).status).toBe("draft");
  });

  it("refuses to send a line whose VAT rate is no longer in force (T-21)", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const { jobId } = (await addJob(db.app, people.advisor!, ro, { title: "Parts" }, randomUUID())).result;
    await addLine(db.app, people.advisor!, jobId, { itemId: items.changing, qty: "1" }, randomUUID());
    await setTaxCodeRate(
      db.app,
      people.partner!,
      "CHG",
      { rate: "10", effectiveFrom: await today() },
      randomUUID(),
    );
    await expect(sendVersion(db.app, people.advisor!, ro, randomUUID())).rejects.toMatchObject({
      code: "tax_rate_changed",
    });
  });

  it("after sending nothing in the estimate changes, and price changes do not touch it (AC2-12)", async () => {
    const { ro, brakes } = await twoJobEstimate();
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
    const before = await versionOf(ro);

    await setPrice(db.app, people.manager!, items.labor!, { price: "175.00", taxCode: "STD" }, randomUUID());
    await expect(
      addLine(db.app, people.advisor!, brakes, { itemId: items.labor, qty: "1" }, randomUUID()),
    ).rejects.toMatchObject({ code: "estimate_closed" });
    const after = await versionOf(ro);
    expect(after.content_hash).toBe(before.content_hash);
    expect((await estimateView(db.app, ro))!.totals.total).toBe("399.70");

    const line = await db.app
      .selectFrom("revision_line")
      .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
      .select("revision_line.id")
      .where("job_revision.job_id", "=", brakes)
      .executeTakeFirstOrThrow();
    // The app role cannot rewrite a sent line, the snapshot, or re-send.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE revision_line SET discount = 1 WHERE id = '${line.id}'`))?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE estimate_version SET content_hash = repeat('0', 64) WHERE id = '${after.id}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE estimate_version SET status = 'draft' WHERE id = '${after.id}'`))
        ?.code,
    ).toBe("42501");
    expect((await sqlErrorAs(db.appUrl, `DELETE FROM approval_event`))?.code).toBe("42501");
  });

  // --- In-person approval ------------------------------------------------------------------

  it("records whole-job decisions with the signature; approved work is authorized (OD-20, OD-25, T-22)", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const brakesRev = (await revisionOf(brakes)).id;
    const acRev = (await revisionOf(ac)).id;

    const outcome = await approve(versionId, contentHash, [
      { revisionId: acRev, decision: "approved" },
      { revisionId: brakesRev, decision: "declined" },
    ]);
    const event = await db.app
      .selectFrom("approval_event")
      .selectAll()
      .where("id", "=", outcome.result.approvalEventId)
      .executeTakeFirstOrThrow();
    const order = await db.app
      .selectFrom("repair_order")
      .select(["status", "contact_name", "contact_mobile"])
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      method: "in_person_signature",
      verification_level: "in_person",
      approver_name: "Fatima Al Ali",
      displayed_language: "ar",
      content_hash: contentHash,
      contact_name: order.contact_name, // A.4 snapshot
      contact_mobile: order.contact_mobile,
      recorded_by: people.advisor!.userId,
      terms_ar_id: null,
      terms_en_id: null,
    });
    // The signature bytes are stored and match the recorded hash.
    // Evidence is kept apart from photos, out of reach of any photo clean-up.
    expect(event.signature_storage_key).toMatch(/^signatures\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/);
    const stored = await storage.get(event.signature_storage_key!);
    expect(sha256Hex(Buffer.from(stored!))).toBe(event.signature_sha256);

    const decisions = await db.app
      .selectFrom("revision_decision")
      .select(["revision_id", "decision", "urgent_ack_pending"])
      .where("approval_event_id", "=", event.id)
      .orderBy("decision")
      .execute();
    expect(decisions).toEqual([
      { revision_id: acRev, decision: "approved", urgent_ack_pending: false },
      { revision_id: brakesRev, decision: "declined", urgent_ack_pending: true }, // OD-25
    ]);
    expect((await revisionOf(ac)).status).toBe("approved");
    expect((await revisionOf(brakes)).status).toBe("declined");
    const jobs = await db.app
      .selectFrom("repair_job")
      .select(["id", "execution_status"])
      .where("repair_order_id", "=", ro)
      .execute();
    expect(Object.fromEntries(jobs.map((job) => [job.id, job.execution_status]))).toEqual({
      [ac]: "authorized",
      [brakes]: "not_authorized",
    });
    expect((await versionOf(ro)).status).toBe("closed");
    expect(order.status).toBe("in_progress");
    expect(await isJobAuthorized(db.app, ac)).toBe(true);
    expect(await isJobAuthorized(db.app, brakes)).toBe(false);
    expect(await authorizedScope(db.app, ac)).toHaveLength(1);
    expect(await authorizedScope(db.app, brakes)).toEqual([]);

    // AT-20: the approval's hash is the stored snapshot's hash, whatever language was displayed.
    expect(sha256Hex(canonicalJson((await versionOf(ro)).snapshot))).toBe(event.content_hash);
  });

  it("a submission may decide some jobs; the rest stay pending until decided (T-22)", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(
      versionId,
      contentHash,
      [{ revisionId: (await revisionOf(brakes)).id, decision: "approved" }],
      {
        language: "en",
      },
    );
    expect((await versionOf(ro)).status).toBe("sent");
    expect((await revisionOf(ac)).status).toBe("pending");
    // A decided job is not decided again.
    await expect(
      approve(versionId, contentHash, [{ revisionId: (await revisionOf(brakes)).id, decision: "declined" }]),
    ).rejects.toMatchObject({ code: "revision_not_pending" });
    await approve(versionId, contentHash, [{ revisionId: (await revisionOf(ac)).id, decision: "declined" }]);
    expect((await versionOf(ro)).status).toBe("closed");
  });

  it("all jobs declined: the repair order stays Awaiting approval (T-22)", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(versionId, contentHash, [
      { revisionId: (await revisionOf(brakes)).id, decision: "declined" },
      { revisionId: (await revisionOf(ac)).id, decision: "declined" },
    ]);
    const order = await db.app
      .selectFrom("repair_order")
      .select("status")
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    expect(order.status).toBe("awaiting_approval");
  });

  it("refuses an approval for other content, an unsent or expired version, or a line instead of a job", async () => {
    const { ro, brakes } = await twoJobEstimate();
    const draft = await versionOf(ro);
    const brakesRev = (await revisionOf(brakes)).id;
    await expect(
      approve(draft.id, "a".repeat(64), [{ revisionId: brakesRev, decision: "approved" }]),
    ).rejects.toMatchObject({ code: "estimate_not_sent" });
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await expect(
      approve(versionId, "b".repeat(64), [{ revisionId: brakesRev, decision: "approved" }]),
    ).rejects.toMatchObject({ code: "estimate_changed" });
    // Approval is per job only: a line id is not a decidable revision.
    const lineId = (
      await db.app
        .selectFrom("revision_line")
        .select("id")
        .where("revision_id", "=", brakesRev)
        .executeTakeFirstOrThrow()
    ).id;
    await expect(
      approve(versionId, contentHash, [{ revisionId: lineId, decision: "approved" }]),
    ).rejects.toMatchObject({
      code: "revision_not_pending",
    });
    await expect(
      approve(versionId, contentHash, [{ revisionId: brakesRev, decision: "maybe" }]),
    ).rejects.toMatchObject({ details: { field: "decisions" } });
    await expect(
      approve(versionId, contentHash, [{ revisionId: brakesRev, decision: "approved" }], {
        approverName: "  ",
      }),
    ).rejects.toMatchObject({ details: { field: "approverName" } });
    await expect(
      approve(versionId, contentHash, [{ revisionId: brakesRev, decision: "approved" }], {
        signature: new TextEncoder().encode("not an image"),
      }),
    ).rejects.toMatchObject({ details: { field: "signature" } });

    // Expired (set-up: the owner moves the expiry into the past with the guard switched off).
    await db.owner.transaction().execute(async (tx) => {
      await sql`ALTER TABLE estimate_version DISABLE TRIGGER estimate_version_transition`.execute(tx);
      await sql`UPDATE estimate_version SET expires_at = now() - interval '1 minute' WHERE id = ${versionId}`.execute(
        tx,
      );
      await sql`ALTER TABLE estimate_version ENABLE TRIGGER estimate_version_transition`.execute(tx);
    });
    await expect(
      approve(versionId, contentHash, [{ revisionId: brakesRev, decision: "approved" }]),
    ).rejects.toMatchObject({ code: "estimate_expired" });
    expect(
      await db.app
        .selectFrom("approval_event")
        .select("id")
        .where("estimate_version_id", "=", versionId)
        .execute(),
    ).toEqual([]);
  });

  // --- AC2-01 ------------------------------------------------------------------------------

  it("unapproved or declined work cannot be authorized or started (AC2-01)", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    // Sent but undecided: nothing may start.
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    for (const status of ["authorized", "in_progress"]) {
      expect(
        (
          await sqlErrorAs(
            db.appUrl,
            `UPDATE repair_job SET execution_status = '${status}' WHERE id = '${brakes}'`,
          )
        )?.code,
      ).toBe("42501");
    }
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE repair_order SET status = 'in_progress' WHERE id = '${ro}'`))
        ?.code,
    ).toBe("42501");
    // A revision is approved only by a recorded decision.
    expect(
      (await sqlErrorAs(db.appUrl, `UPDATE job_revision SET status = 'approved' WHERE job_id = '${brakes}'`))
        ?.code,
    ).toBe("42501");

    await approve(versionId, contentHash, [
      { revisionId: (await revisionOf(ac)).id, decision: "approved" },
      { revisionId: (await revisionOf(brakes)).id, decision: "declined" },
    ]);
    // Declined stays unauthorized; approved work starts only through the workshop (I1-06).
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'authorized' WHERE id = '${brakes}'`,
        )
      )?.code,
    ).toBe("42501");
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET execution_status = 'in_progress' WHERE id = '${ac}'`,
        )
      )?.code,
    ).toBe("42501");
  });

  it("the database refuses forged evidence", async () => {
    const { ro, brakes } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const order = await db.app
      .selectFrom("repair_order")
      .select(["contact_name", "contact_mobile"])
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    const event = (hash: string, contactMobile: string) =>
      sqlErrorAs(
        db.appUrl,
        `INSERT INTO approval_event (estimate_version_id, method, verification_level, approver_name, signature_sha256,
           signature_storage_key, signature_content_type, contact_name, contact_mobile, displayed_language, content_hash,
           idempotency_key)
         VALUES ('${versionId}', 'in_person_signature', 'in_person', 'X', repeat('1', 64), 'k', 'image/png',
           '${order.contact_name}', '${contactMobile}', 'en', '${hash}', '${randomUUID()}')`,
      );
    expect((await event("c".repeat(64), order.contact_mobile))?.code).toBe("42501"); // other content
    expect((await event(contentHash, "0500000000"))?.code).toBe("42501"); // not the contact in effect (A.4)

    // A declined urgent job must carry the OD-25 flag.
    const outcome = await approve(versionId, contentHash, [
      { revisionId: (await revisionOf(brakes)).id, decision: "approved" },
    ]);
    const ac = (await estimateView(db.app, ro))!.jobs[1]!.id;
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO revision_decision (approval_event_id, revision_id, decision, urgent_ack_pending)
       VALUES ('${outcome.result.approvalEventId}', '${(await revisionOf(ac)).id}', 'declined', true)`,
    );
    expect(forged?.code).toBe("42501");
  });

  // --- Concurrency and idempotency ---------------------------------------------------------

  it("two staff recording the same decision at once: one approval event (A.4 / F-11)", async () => {
    const { ro, brakes } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const decisions = [{ revisionId: (await revisionOf(brakes)).id, decision: "approved" }];
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const both = Promise.allSettled([
        approve(versionId, contentHash, decisions),
        approve(versionId, contentHash, decisions, { staff: people.manager! }),
      ]);
      await waitForLockWaiters(db, 2);
      await holder.query("COMMIT");
      const results = await both;
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({
        code: "revision_not_pending",
      });
    } finally {
      await holder.end();
    }
    expect(
      await db.app
        .selectFrom("approval_event")
        .select("id")
        .where("estimate_version_id", "=", versionId)
        .execute(),
    ).toHaveLength(1);
  });

  it("a retried submission replays instead of recording twice (rule 11)", async () => {
    const { ro, brakes } = await twoJobEstimate();
    const sendKey = randomUUID();
    const sent = await sendVersion(db.app, people.advisor!, ro, sendKey);
    const resent = await sendVersion(db.app, people.advisor!, ro, sendKey);
    expect(resent.replayed).toBe(true);
    expect(resent.result).toEqual(sent.result);
    const decisions = [{ revisionId: (await revisionOf(brakes)).id, decision: "approved" }];
    const key = randomUUID();
    const first = await approve(sent.result.versionId, sent.result.contentHash, decisions, {}, key);
    const again = await approve(sent.result.versionId, sent.result.contentHash, decisions, {}, key);
    expect(again.replayed).toBe(true);
    expect(again.result.approvalEventId).toBe(first.result.approvalEventId);
  });

  // --- HTTP and permissions ----------------------------------------------------------------

  it("advisors send and record approvals over HTTP; technicians and store keepers cannot", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    const sendRequest = (token: string) =>
      new Request(`${BASE}/api/repair-orders/${ro}/estimate/send`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
        headers: { "content-type": "application/json", ...cookie(token) },
      });
    for (const name of ["tech", "storekeeper"]) {
      expect((await handlers.sendEstimate(sendRequest(people[name]!.token), ro)).status).toBe(403);
    }
    const sent = await handlers.sendEstimate(sendRequest(people.advisor!.token), ro);
    expect(sent.status).toBe(201);
    const { versionId, contentHash } = (await sent.json()) as { versionId: string; contentHash: string };

    const approvalRequest = (token: string) => {
      const form = new FormData();
      form.set("contentHash", contentHash);
      form.set("language", "en");
      form.set("approverName", "Omar Saeed");
      form.set("idempotencyKey", randomUUID());
      form.set(`decision.${brakesRev}`, "approved");
      form.set(`decision.${acRev}`, ""); // left undecided
      form.set("signature", new Blob([Buffer.from(signature)], { type: "image/png" }), "signature.png");
      return new Request(`${BASE}/api/estimate-versions/${versionId}/approvals`, {
        method: "POST",
        body: form,
        headers: cookie(token),
      });
    };
    const brakesRev = (await revisionOf(brakes)).id;
    const acRev = (await revisionOf(ac)).id;
    expect(
      (await handlers.recordEstimateApproval(approvalRequest(people.tech!.token), versionId)).status,
    ).toBe(403);
    const response = await handlers.recordEstimateApproval(approvalRequest(people.advisor!.token), versionId);
    expect(response.status).toBe(201);
    expect((await revisionOf(brakes)).status).toBe("approved");
    expect((await revisionOf(ac)).status).toBe("pending");
  });

  it("findings are read-only once the estimate is sent (OD-10)", async () => {
    const { ro } = await twoJobEstimate();
    const finding = await db.app
      .selectFrom("finding")
      .select("id")
      .where("repair_order_id", "=", ro)
      .executeTakeFirstOrThrow();
    await sendVersion(db.app, people.advisor!, ro, randomUUID());
    await expect(
      updateFinding(db.app, people.advisor!, finding.id, { title: "Pads at 1 mm", severity: "urgent" }),
    ).rejects.toMatchObject({ code: "inspection_closed" });
  });

  it("sending races: one send wins; an item added at the same moment is in the snapshot or refused", async () => {
    const { ro, ac } = await twoJobEstimate();
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM repair_order WHERE id = $1 FOR UPDATE", [ro]);
      const all = Promise.allSettled([
        sendVersion(db.app, people.advisor!, ro, randomUUID()),
        sendVersion(db.app, people.manager!, ro, randomUUID()),
        addLine(db.app, people.advisor!, ac, { itemId: items.part, qty: "1" }, randomUUID()),
      ]);
      await waitForLockWaiters(db, 3);
      await holder.query("COMMIT");
      const [first, second, line] = await all;
      expect([first, second].filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        ([first, second].find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
      ).toMatchObject({
        code: "estimate_closed",
      });
      if (line.status === "rejected") expect(line.reason).toMatchObject({ code: "estimate_closed" });
    } finally {
      await holder.end();
    }
    // Whatever the order, the snapshot holds exactly the live lines and its hash matches it.
    const version = await versionOf(ro);
    const snapshot = version.snapshot as EstimateSnapshot;
    const live = await db.app
      .selectFrom("revision_line")
      .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
      .select("revision_line.id")
      .where("job_revision.proposed_in_version_id", "=", version.id)
      .where("revision_line.removed_at", "is", null)
      .execute();
    expect(snapshot.jobs.flatMap((job) => job.lines.map((l) => l.lineId)).sort()).toEqual(
      live.map((l) => l.id).sort(),
    );
    expect(sha256Hex(canonicalJson(snapshot))).toBe(version.content_hash);
  });

  it("no decision is recorded once the repair order is no longer awaiting work", async () => {
    const { ro, brakes } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await db.owner.updateTable("repair_order").set({ status: "cancelled" }).where("id", "=", ro).execute();
    await expect(
      approve(versionId, contentHash, [{ revisionId: (await revisionOf(brakes)).id, decision: "approved" }]),
    ).rejects.toMatchObject({ code: "estimate_closed" });
    const order = await db.app
      .selectFrom("repair_order")
      .select(["contact_name", "contact_mobile"])
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO approval_event (estimate_version_id, method, verification_level, approver_name, signature_sha256,
         signature_storage_key, signature_content_type, contact_name, contact_mobile, displayed_language, content_hash,
         idempotency_key)
       VALUES ('${versionId}', 'in_person_signature', 'in_person', 'X', repeat('1', 64), 'k', 'image/png',
         '${order.contact_name}', '${order.contact_mobile}', 'en', '${contentHash}', '${randomUUID()}')`,
    );
    expect(forged?.code).toBe("42501");
  });

  it("the database keeps evidence, decisions and jobs consistent", async () => {
    const { ro, brakes, ac } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const order = await db.app
      .selectFrom("repair_order")
      .select(["contact_name", "contact_mobile"])
      .where("id", "=", ro)
      .executeTakeFirstOrThrow();
    const eventSql = (method: string, level: string, id: string) =>
      `INSERT INTO approval_event (id, estimate_version_id, method, verification_level, approver_name, signature_sha256,
         signature_storage_key, signature_content_type, contact_name, contact_mobile, displayed_language, content_hash,
         idempotency_key)
       VALUES ('${id}', '${versionId}', '${method}', '${level}', 'X', repeat('1', 64), 'k', 'image/png',
         '${order.contact_name}', '${order.contact_mobile}', 'en', '${contentHash}', '${randomUUID()}');`;
    // Only in-person approvals exist yet.
    expect((await sqlErrorAs(db.appUrl, eventSql("link", "possession", randomUUID())))?.code).toBe("42501");

    // A decision row without moving its revision fails at commit.
    const eventId = randomUUID();
    const brakesRev = (await revisionOf(brakes)).id;
    const unapplied = await sqlErrorAs(
      db.appUrl,
      `BEGIN; ${eventSql("in_person_signature", "in_person", eventId)}
       INSERT INTO revision_decision (approval_event_id, revision_id, decision, urgent_ack_pending)
       VALUES ('${eventId}', '${brakesRev}', 'approved', false); COMMIT;`,
    );
    expect(unapplied?.code).toBe("42501");
    expect((await revisionOf(brakes)).status).toBe("pending");

    // A decision for a revision of another version.
    const other = await twoJobEstimate();
    const otherSent = (await sendVersion(db.app, people.advisor!, other.ro, randomUUID())).result;
    const outcome = await approve(otherSent.versionId, otherSent.contentHash, [
      { revisionId: (await revisionOf(other.ac)).id, decision: "approved" },
    ]);
    const crossed = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO revision_decision (approval_event_id, revision_id, decision)
       VALUES ('${outcome.result.approvalEventId}', '${(await revisionOf(ac)).id}', 'approved')`,
    );
    expect(crossed?.code).toBe("42501");

    // A job is never updated except to remove (draft) or authorize it.
    expect(
      (
        await sqlErrorAs(
          db.appUrl,
          `UPDATE repair_job SET removed_by = '${people.advisor!.userId}' WHERE id = '${other.ac}'`,
        )
      )?.code,
    ).toBe("42501");

    // A draft is not sent once the repair order has moved on.
    const third = await twoJobEstimate();
    await db.owner
      .updateTable("repair_order")
      .set({ status: "cancelled" })
      .where("id", "=", third.ro)
      .execute();
    const draft = await versionOf(third.ro);
    const sent = await sqlErrorAs(
      db.appUrl,
      `UPDATE estimate_version SET status = 'sent', sent_by = '${people.advisor!.userId}', snapshot = '{}',
         content_hash = repeat('a', 64), expires_at = now() + interval '1 day' WHERE id = '${draft.id}'`,
    );
    expect(sent?.code).toBe("42501");
  });

  // Last: it adds terms texts, which every later snapshot would then carry.
  it("records and shows the terms text version of the language displayed (P0-11, AT-20)", async () => {
    const ids: Record<string, string> = {};
    for (const [language, body] of [
      ["ar", "نص شروط تجريبي للاختبار فقط"],
      ["en", "Test-only terms text"],
    ] as const) {
      ids[language] = (
        await db.owner
          .insertInto("terms_text")
          .values({ kind: "estimate", language, version_no: 1, body })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    }
    const { ro, ac } = await twoJobEstimate();
    const { versionId, contentHash } = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const view = (await approvalScreenView(db.app, ro))!;
    expect(view.snapshot.terms).toEqual({ ar: ids.ar, en: ids.en });
    expect(view.termsBody).toEqual({ ar: "نص شروط تجريبي للاختبار فقط", en: "Test-only terms text" });
    const outcome = await approve(
      versionId,
      contentHash,
      [{ revisionId: (await revisionOf(ac)).id, decision: "approved" }],
      {
        language: "ar",
      },
    );
    const event = await db.app
      .selectFrom("approval_event")
      .select(["displayed_language", "terms_ar_id", "terms_en_id"])
      .where("id", "=", outcome.result.approvalEventId)
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ displayed_language: "ar", terms_ar_id: ids.ar, terms_en_id: ids.en });
    // Terms texts are never edited in place.
    expect((await sqlErrorAs(db.appUrl, `UPDATE terms_text SET body = 'x'`))?.code).toBe("42501");
  });
});
