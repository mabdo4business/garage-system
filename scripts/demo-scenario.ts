import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { createUser } from "../src/server/auth/service";
import { createInvoiceDraft, issueInvoice } from "../src/server/billing/invoice";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode, getTaxSettings } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import type { DB } from "../src/server/db/schema";
import { recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import { addJob, addLine, openEstimate, type Staff } from "../src/server/estimate/commands";
import { assignInspection, recordFinding } from "../src/server/inspection/commands";
import { markWaitingParts } from "../src/server/inventory/commands";
import type { MediaStorage } from "../src/server/media/storage";
import { passQc, requestQc } from "../src/server/quality/commands";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { currentBusinessProfile, setBusinessProfile } from "../src/server/settings/business-profile";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, pauseJob, startJob } from "../src/server/workshop/commands";
import { makePng } from "../tests/helpers/images";

/**
 * DEVELOPMENT ONLY: sample repair orders at every workshop stage, created through the real commands (so audit,
 * numbering and every rule apply exactly as in use). Names are clearly fictitious. Used by `npm run db:demo` and by
 * the dashboard test. Invoices and check-ins are dated today: commands cannot backdate, so the 7-day history fills
 * up only as days pass.
 */

export const DEMO_USERS = [
  ["demo.partner", "Demo Partner", ["partner"]],
  ["demo.manager", "Demo Manager", ["manager"]],
  ["demo.advisor", "Demo Advisor", ["service_advisor"]],
  ["demo.tech1", "Demo Technician One", ["technician"]],
  ["demo.tech2", "Demo Technician Two", ["technician"]],
  ["demo.store", "Demo Store Keeper", ["store_keeper"]],
] as const;

type Who = (typeof DEMO_USERS)[number][0];

export interface DemoResult {
  users: Record<Who, Staff>;
  repairOrders: Record<string, string>;
}

export async function seedDemo(
  db: Kysely<DB>,
  storage: MediaStorage,
  password: string,
  options: { suffix?: string } = {},
): Promise<DemoResult> {
  const suffix = options.suffix ?? "";
  const users = {} as Record<Who, Staff>;
  for (const [username, displayName, roles] of DEMO_USERS) {
    const name = `${username}${suffix}`;
    const existing = await db
      .selectFrom("app_user")
      .select("id")
      .where("username", "=", name)
      .executeTakeFirst();
    const userId =
      existing?.id ??
      (
        await createUser(
          db,
          { kind: "system", name: "dev-demo" },
          { username: name, displayName, password, roles: [...roles] },
        )
      ).userId;
    users[username] = { userId, roles: [...roles] };
  }
  const { "demo.partner": partner, "demo.manager": manager, "demo.advisor": advisor } = users;
  const { "demo.tech1": tech1, "demo.tech2": tech2 } = users;
  const key = () => randomUUID();

  // Tax and business profile: only when none exist (a real garage enters its own, OD-13 / OD-47).
  const tax = await getTaxSettings(db);
  if (tax.profiles.length === 0) {
    await addTaxProfile(
      db,
      partner,
      { registrationStatus: "registered", trn: "100000000000003", effectiveFrom: "2026-01-01" },
      key(),
    );
  }
  const code = `DEMO${suffix.replace(/\W/g, "").toUpperCase()}`.slice(0, 20);
  if (!tax.codes.some((row) => row.code === code)) {
    await createTaxCode(
      db,
      partner,
      {
        code,
        labelEn: "Demo standard",
        labelAr: "قياسي تجريبي",
        category: "standard",
        rate: "5",
        effectiveFrom: "2026-01-01",
      },
      key(),
    );
  }
  if (!(await currentBusinessProfile(db))) {
    await setBusinessProfile(
      db,
      partner,
      {
        legalNameEn: "Demo Garage LLC",
        legalNameAr: "كراج تجريبي ذ.م.م",
        addressEn: "Industrial Area, Sharjah (demo)",
        addressAr: "المنطقة الصناعية، الشارقة (تجريبي)",
        phone: "+971 6 500 0000",
      },
      key(),
    );
  }
  const item = async (data: Record<string, unknown>) =>
    (await createItem(db, manager, { taxCode: code, ...data } as never, key())).result.itemId;
  const tag = suffix.replace(/\W/g, "").toUpperCase() || String(Date.now() % 100000);
  const labour = await item({
    kind: "labor_rate",
    code: `DL-${tag}`,
    nameEn: "Workshop labour",
    nameAr: "عمالة الورشة",
    price: "180.00",
  });
  const part = await item({
    kind: "part",
    code: `DP-${tag}`,
    nameEn: "Rear shock absorber",
    nameAr: "مساعد خلفي",
    price: "420.00",
    unit: "piece",
    stockTracked: true,
  });

  let n = 0;
  // Each run starts past every customer already there, so runs seconds apart (tests seed several times) never reuse a
  // plate or mobile.
  const existing = Number(
    (
      await db
        .selectFrom("customer")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .executeTakeFirstOrThrow()
    ).n,
  );
  const runBase = Math.floor(Date.now() / 1000) + existing;
  const cars = [
    ["Toyota", "Camry", 2021],
    ["Nissan", "Patrol", 2019],
    ["Lexus", "ES", 2020],
    ["Kia", "Sportage", 2022],
    ["Mitsubishi", "Pajero", 2018],
    ["Hyundai", "Tucson", 2021],
    ["Honda", "Accord", 2020],
    ["Mazda", "CX-5", 2021],
    ["Chevrolet", "Tahoe", 2020],
  ] as const;

  /** A checked-in repair order for a fictitious customer. */
  async function checkIn(concerns: string, promisedInHours: number | null) {
    const [make, model, year] = cars[n % cars.length]!;
    n++;
    // Digits only (T-06): a per-run base keeps mobiles and plates unique across repeated runs.
    const serial = String((runBase + n) % 1_000_000).padStart(6, "0");
    const actor = { kind: "user" as const, userId: advisor.userId };
    const customerId = (
      await createCustomer(
        db,
        actor,
        {
          nameEn: `Demo Customer ${n}`,
          nameAr: `عميل تجريبي ${n}`,
          mobile: `0559${serial}`,
          preferredLanguage: n % 2 ? "ar" : "en",
          marketingConsent: false,
        },
        key(),
      )
    ).result.customerId;
    const vehicleId = (
      await createVehicle(
        db,
        actor,
        {
          make,
          model,
          year,
          plate: {
            emirate: "sharjah",
            code: String((n % 3) + 1),
            number: serial.slice(-5),
          },
          ownerCustomerId: customerId,
        },
        key(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db, actor, vehicleId, key())).result;
    await updateCheckIn(db, actor, checkInId, {
      odometerKm: 40000 + n * 7311,
      concerns,
      photoShortfallReason: "Demo data: no photos",
      promisedAt: promisedInHours === null ? null : new Date(Date.now() + promisedInHours * 3_600_000),
    });
    return (await completeCheckIn(db, actor, checkInId, key())).result.repairOrderId;
  }

  /** Inspection, one job with the given lines, sent and approved in person. Returns the job and its lines. */
  async function approved(ro: string, title: string, lines: { itemId: string; qty: string }[]) {
    await assignInspection(db, manager, ro, tech1.userId);
    const { findingId } = (
      await recordFinding(db, tech1, ro, { title, severity: "soon", customerNote: title }, key())
    ).result;
    await openEstimate(db, advisor, ro, key());
    const jobId = (await addJob(db, advisor, ro, { findingId }, key())).result.jobId;
    const lineIds: string[] = [];
    for (const line of lines) lineIds.push((await addLine(db, advisor, jobId, line, key())).result.lineId);
    const { versionId, contentHash } = (await sendVersion(db, advisor, ro, key())).result;
    return { jobId, lineIds, versionId, contentHash };
  }

  async function approve(job: Awaited<ReturnType<typeof approved>>) {
    const revision = await db
      .selectFrom("job_revision")
      .select("id")
      .where("job_id", "=", job.jobId)
      .executeTakeFirstOrThrow();
    await recordInPersonApproval(
      db,
      storage,
      advisor,
      {
        versionId: job.versionId,
        contentHash: job.contentHash,
        language: "en",
        approverName: "Demo Customer",
        decisions: [{ revisionId: revision.id, decision: "approved" }],
        signature: makePng(300, 100, n),
      },
      key(),
    );
  }

  const repairOrders: Record<string, string> = {};

  repairOrders.checkedIn1 = await checkIn("Noise from front axle", 6);
  repairOrders.checkedIn2 = await checkIn("Battery warning light", null);

  repairOrders.diagnosing = await checkIn("Rattle on cold start", 4);
  await assignInspection(db, manager, repairOrders.diagnosing, tech2.userId);

  repairOrders.awaiting = await checkIn("Brakes squeal", 5);
  await approved(repairOrders.awaiting, "Front brake discs worn", [{ itemId: labour, qty: "1.5" }]);

  repairOrders.working = await checkIn("Service due", 3);
  const working = await approved(repairOrders.working, "Oil and filter service", [
    { itemId: labour, qty: "1.5" },
  ]);
  await approve(working);
  await assignJob(db, manager, working.jobId, { assigneeId: tech1.userId, bay: "1" }, key());
  await startJob(db, tech1, working.jobId, key());

  repairOrders.paused = await checkIn("AC not cold", 8);
  const paused = await approved(repairOrders.paused, "AC regas and leak test", [
    { itemId: labour, qty: "2" },
  ]);
  await approve(paused);
  await assignJob(db, manager, paused.jobId, { assigneeId: tech2.userId, bay: "2" }, key());
  await startJob(db, tech2, paused.jobId, key());
  await pauseJob(db, tech2, paused.jobId, { reason: "Waiting for the leak-test dye to settle" }, key());

  repairOrders.parts = await checkIn("Knock over bumps", 24);
  const parts = await approved(repairOrders.parts, "Rear shock absorbers", [
    { itemId: labour, qty: "2" },
    { itemId: part, qty: "2" },
  ]);
  await approve(parts);
  await assignJob(db, manager, parts.jobId, { assigneeId: tech1.userId, bay: "3" }, key());
  await markWaitingParts(db, advisor, parts.jobId, key());

  // Partly decided (T-22): two jobs sent, the customer approves one now and decides the other later. The version
  // stays "sent" while the approved job may start.
  repairOrders.partly = await checkIn("Service and a noise at the rear", 6);
  await assignInspection(db, manager, repairOrders.partly, tech1.userId);
  await openEstimate(db, advisor, repairOrders.partly, key());
  const partlyJobs: string[] = [];
  for (const title of ["Brake fluid change", "Exhaust heat shield"]) {
    const jobId = (await addJob(db, advisor, repairOrders.partly, { title }, key())).result.jobId;
    await addLine(db, advisor, jobId, { itemId: labour, qty: "1" }, key());
    partlyJobs.push(jobId);
  }
  const partlySent = (await sendVersion(db, advisor, repairOrders.partly, key())).result;
  const firstRevision = await db
    .selectFrom("job_revision")
    .select("id")
    .where("job_id", "=", partlyJobs[0]!)
    .executeTakeFirstOrThrow();
  await recordInPersonApproval(
    db,
    storage,
    advisor,
    {
      versionId: partlySent.versionId,
      contentHash: partlySent.contentHash,
      language: "en",
      approverName: "Demo Customer",
      decisions: [{ revisionId: firstRevision.id, decision: "approved" }],
      signature: makePng(300, 100, 99),
    },
    key(),
  );

  async function workDone(ro: string, title: string) {
    const job = await approved(ro, title, [{ itemId: labour, qty: "1" }]);
    await approve(job);
    await assignJob(db, manager, job.jobId, { assigneeId: tech2.userId }, key());
    await startJob(db, tech2, job.jobId, key());
    await completeJob(
      db,
      tech2,
      job.jobId,
      { lines: job.lineIds.map((lineId) => ({ lineId, outcome: "done" as const })), note: "Done (demo)" },
      key(),
    );
    await requestQc(db, tech2, ro, key());
  }

  repairOrders.qc = await checkIn("Engine diagnostics", 2);
  await workDone(repairOrders.qc, "Engine diagnostics");

  repairOrders.ready = await checkIn("Major service", 1);
  await workDone(repairOrders.ready, "Major service");
  await passQc(
    db,
    manager,
    repairOrders.ready,
    {
      noNewWarningLights: true,
      roadTest: "done",
      odometerOutKm: String(40000 + n * 7311 + 12),
      fluidsOk: true,
      cleanlinessOk: true,
      belongingsOk: true,
      oldParts: "disposed",
    },
    key(),
  );
  const draftId = (await createInvoiceDraft(db, advisor, repairOrders.ready, key())).result.draftId;
  await issueInvoice(db, advisor, draftId, {}, key());

  return { users, repairOrders };
}
