import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EstimateDocument } from "../src/components/estimate-document";
import { SESSION_COOKIE } from "../src/server/auth/session";
import { createInvoiceDraft, invoicePreview } from "../src/server/billing/invoice";
import { createItem } from "../src/server/catalog/items";
import { addTaxProfile, createTaxCode } from "../src/server/catalog/tax";
import { createCustomer } from "../src/server/customer/service";
import { amendJob, replaceLine } from "../src/server/estimate/amendments";
import { authorizedScope, recordInPersonApproval, sendVersion } from "../src/server/estimate/approval";
import {
  addJob,
  addLine,
  openEstimate,
  removeJob,
  setLineDiscount,
  type Staff,
} from "../src/server/estimate/commands";
import { estimateView } from "../src/server/estimate/queries";
import { hashSnapshot, type EstimateSnapshot } from "../src/server/estimate/snapshot";
import { startVersion, withdrawVersion } from "../src/server/estimate/versions";
import { createHandlers } from "../src/server/http/handlers";
import {
  addFindingPhoto,
  discardFindingPhoto,
  recordFinding,
  setFindingPhotoVisibility,
  updateFinding,
} from "../src/server/inspection/commands";
import { recordLinkApproval } from "../src/server/links/approval";
import { createCustomerLink } from "../src/server/links/commands";
import { issueFromStock, receiveStock } from "../src/server/inventory/commands";
import { partsForOpenJobs } from "../src/server/inventory/queries";
import { LocalDiskStorage } from "../src/server/media/storage";
import { passQc, requestQc } from "../src/server/quality/commands";
import { completeCheckIn, startCheckIn, updateCheckIn } from "../src/server/repair-order/check-in";
import { setBusinessProfile } from "../src/server/settings/business-profile";
import { Money } from "../src/server/core/money";
import { createVehicle } from "../src/server/vehicle/service";
import { assignJob, completeJob, startJob } from "../src/server/workshop/commands";
import { jobCard } from "../src/server/workshop/queries";
import { createTestDatabase, sqlErrorAs, type TestDatabase } from "./helpers/db";
import { makePng } from "./helpers/images";
import { makeUser, TEST_PASSWORD } from "./helpers/users";

/**
 * I2-02a — amendments of approved work (v0.2.1 §2.1–§2.3, §3.2, §3.3): added scope keeps the first approval
 * (AC21-01), a price change needs the customer and the cap stays until then (AC2-06), a replaced line is frozen for
 * parts (AC21-08, F-13), the §2.3 supersession guards, a done job reopened by an approved amendment, findings
 * during work (OD-72), snapshot schema 4 and rule 9, permissions and idempotency.
 */

describe("S32 — amendments", () => {
  let db: TestDatabase;
  let storageDir: string;
  let storage: LocalDiskStorage;
  let handlers: ReturnType<typeof createHandlers>;
  const people: Record<string, Staff & { token: string }> = {};
  const items: Record<string, string> = {};
  const BASE = "http://localhost:3000";
  const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` });
  const signature = makePng(600, 200, 7);

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-amendments-"));
    storage = new LocalDiskStorage(storageDir);
    handlers = createHandlers(db.app, storage);
    for (const [name, roles] of [
      ["partner", ["partner"]],
      ["manager", ["manager"]],
      ["advisor", ["service_advisor"]],
      ["tech", ["technician"]],
      ["tech2", ["technician"]],
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
        legalNameEn: "Test Garage LLC",
        legalNameAr: "كراج الاختبار",
        addressEn: "Sharjah",
        addressAr: "الشارقة",
        phone: "06 555 1234",
      },
      randomUUID(),
    );
    const item = async (kind: string, code: string, price: string, unit?: string) =>
      (
        await createItem(
          db.app,
          people.manager!,
          {
            kind,
            code,
            nameEn: `${code} EN`,
            nameAr: `${code} AR`,
            price,
            taxCode: "STD",
            unit,
            stockTracked: kind === "part",
          },
          randomUUID(),
        )
      ).result.itemId;
    // v0.2.1 §2.3: labour 180, pads 300, cleaner 20; later pins 100 and labour 50.
    items.labor = await item("labor_rate", "LAB-A", "180.00");
    items.labor50 = await item("labor_rate", "LAB-B", "50.00");
    items.pads = await item("part", "PADS-OEM", "300.00", "piece");
    items.padsAm = await item("part", "PADS-AM", "250.00", "piece");
    items.cleaner = await item("part", "CLN-A", "20.00", "piece");
    items.pins = await item("part", "PINS-A", "100.00", "piece");
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
          nameEn: `Amend Customer ${counter}`,
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
          make: "Toyota",
          model: "Camry",
          year: 2019,
          plate: { emirate: "sharjah", code: "AM", number: String(70000 + counter) },
          ownerCustomerId: customerId,
        },
        randomUUID(),
      )
    ).result.vehicleId;
    const { checkInId } = (await startCheckIn(db.app, advisor, vehicleId, randomUUID())).result;
    await updateCheckIn(db.app, advisor, checkInId, {
      odometerKm: 30000,
      concerns: "Brakes",
      photoShortfallReason: "Test fixture",
    });
    return (await completeCheckIn(db.app, advisor, checkInId, randomUUID())).result.repairOrderId;
  }

  const latestRevision = async (jobId: string) =>
    db.app
      .selectFrom("job_revision")
      .selectAll()
      .where("job_id", "=", jobId)
      .orderBy("revision_no", "desc")
      .executeTakeFirstOrThrow();

  async function approve(
    versionId: string,
    contentHash: string,
    decisions: { jobId: string; decision: "approved" | "declined" }[],
  ) {
    return recordInPersonApproval(
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
      randomUUID(),
    );
  }

  /** §2.3 steps 1–3: job A "Front brakes" approved for 500.00 (RL-1 labour 180, RL-2 pads 300, RL-3 cleaner 20). */
  async function approvedJobA() {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const a = (await addJob(db.app, people.advisor!, ro, { title: "Front brakes" }, randomUUID())).result
      .jobId;
    const line = async (itemId: string, qty = "1") =>
      (await addLine(db.app, people.advisor!, a, { itemId, qty }, randomUUID())).result.lineId;
    const rl1 = await line(items.labor!);
    const rl2 = await line(items.pads!);
    const rl3 = await line(items.cleaner!);
    const v1 = (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
    await approve(v1.versionId, v1.contentHash, [{ jobId: a, decision: "approved" }]);
    return { ro, a, rl1, rl2, rl3, v1 };
  }

  /** Starts version 2 and opens a change of job A in it. */
  async function amendA(ro: string, a: string) {
    const v2 = (await startVersion(db.app, people.advisor!, ro, randomUUID())).result;
    const { revisionId } = (await amendJob(db.app, people.advisor!, a, randomUUID())).result;
    return { v2, revisionId };
  }

  const send = async (ro: string) => (await sendVersion(db.app, people.advisor!, ro, randomUUID())).result;
  const lineTotal = async (lineIds: string[]) => {
    const rows = await db.app
      .selectFrom("revision_line")
      .select("line_total")
      .where("id", "in", lineIds)
      .execute();
    return rows.reduce((sum, row) => sum.add(Money.parse(row.line_total)), Money.ZERO).toString();
  };
  const authorizedTotal = async (jobId: string) => lineTotal(await authorizedScope(db.app, jobId));
  const jobStatus = async (jobId: string) =>
    (
      await db.app
        .selectFrom("repair_job")
        .select("execution_status")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow()
    ).execution_status;

  async function stock(itemId: string, qty = "5") {
    await receiveStock(
      db.app,
      people.store!,
      itemId,
      { qty, amount: "500.00", supplierName: "Supplier", supplierRef: `REF-${randomUUID().slice(0, 8)}` },
      randomUUID(),
    );
  }

  // --- AC21-01 -------------------------------------------------------------------------------------------------

  it("AC21-01: added scope keeps AE-1 and RD-1; J-A is authorized for 650.00; v2 shows JR-A1 as context only", async () => {
    const { ro, a, v1 } = await approvedJobA();
    const ae1 = await db.app
      .selectFrom("approval_event")
      .selectAll()
      .where("estimate_version_id", "=", v1.versionId)
      .executeTakeFirstOrThrow();
    const rd1 = await db.app
      .selectFrom("revision_decision")
      .selectAll()
      .where("approval_event_id", "=", ae1.id)
      .execute();
    expect(await authorizedTotal(a)).toBe("500.00");

    const { v2, revisionId } = await amendA(ro, a);
    const rl4 = (await addLine(db.app, people.advisor!, a, { itemId: items.pins!, qty: "1" }, randomUUID()))
      .result.lineId;
    const rl5 = (
      await addLine(db.app, people.advisor!, a, { itemId: items.labor50!, qty: "1" }, randomUUID())
    ).result.lineId;
    const sent = await send(ro);
    expect(sent.versionId).toBe(v2.versionId);
    expect(await latestRevision(a)).toMatchObject({
      id: revisionId,
      revision_no: 2,
      kind: "add_scope",
      status: "pending",
    });

    // Not authorized yet: the cap and the technician's work are still the 500.00 (AC2-06).
    expect(await authorizedTotal(a)).toBe("500.00");
    expect(await authorizedScope(db.app, a)).not.toContain(rl4);

    const version = await db.app
      .selectFrom("estimate_version")
      .select(["snapshot", "content_hash"])
      .where("id", "=", v2.versionId)
      .executeTakeFirstOrThrow();
    const snapshot = version.snapshot as EstimateSnapshot;
    expect(snapshot.schema).toBe(4);
    expect(snapshot.earlierApproved).toEqual([
      {
        jobId: a,
        revisionId: ae1 && rd1[0]!.revision_id,
        title: "Front brakes",
        versionNo: 1,
        total: "500.00",
      },
    ]);
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({
      jobId: a,
      revisionId,
      revisionKind: "add_scope",
      total: "150.00",
    });
    expect(hashSnapshot(snapshot)).toBe(version.content_hash);

    // The customer's document: the 500.00 appears as context with no decision control.
    const html = renderToStaticMarkup(
      <EstimateDocument snapshot={snapshot} locale="en" photoUrl={(id) => `/p/${id}`} />,
    );
    const context =
      /<section class="card estimate-document-context">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
    expect(context).toContain("Front brakes");
    expect(context).not.toMatch(/<input|<button|<select/);
    expect(html).toContain("Added work");

    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    expect(await authorizedTotal(a)).toBe("650.00");
    expect((await authorizedScope(db.app, a)).sort()).toEqual(expect.arrayContaining([rl4, rl5]));
    // AE-1 and RD-1 untouched; a new AE-2 with RD-2.
    expect(
      await db.app
        .selectFrom("approval_event")
        .selectAll()
        .where("id", "=", ae1.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(ae1);
    expect(
      await db.app
        .selectFrom("revision_decision")
        .selectAll()
        .where("approval_event_id", "=", ae1.id)
        .execute(),
    ).toEqual(rd1);
    const ae2 = await db.app
      .selectFrom("approval_event")
      .innerJoin("revision_decision", "revision_decision.approval_event_id", "approval_event.id")
      .select(["approval_event.id", "revision_decision.revision_id", "revision_decision.decision"])
      .where("approval_event.estimate_version_id", "=", v2.versionId)
      .execute();
    expect(ae2).toEqual([{ id: expect.any(String), revision_id: revisionId, decision: "approved" }]);
    expect(ae2[0]!.id).not.toBe(ae1.id);
  });

  // --- AC2-06 / price change -----------------------------------------------------------------------------------

  it("AC2-06: raising the labour needs the customer — the cap and the work stay as approved until then", async () => {
    const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, a, randomUUID());
    await amendA(ro, a);
    // 1.5 hours instead of 1: 270.00 instead of 180.00.
    const rl6 = (await replaceLine(db.app, people.advisor!, rl1, { qty: "1.5" }, randomUUID())).result.lineId;
    const replaced = await db.app
      .selectFrom("revision_line")
      .selectAll()
      .where("id", "=", rl6)
      .executeTakeFirstOrThrow();
    expect(replaced).toMatchObject({
      supersedes_line_id: rl1,
      line_total: "270.00",
      catalogue_item_id: items.labor,
    });
    const sent = await send(ro);
    expect((await latestRevision(a)).kind).toBe("price_change");

    // Pending: RL-1 is still the authorized labour; the new line is neither workable nor billable.
    expect((await authorizedScope(db.app, a)).sort()).toEqual([rl1, rl2, rl3].sort());
    const card = (await jobCard(db.app, a))!;
    expect(card.lines.map((line) => line.id)).not.toContain(rl6);
    expect(card.changeAwaitingCustomer).toBe(true);
    expect(card.lines.find((line) => line.id === rl1)!.frozen).toBe(true);
    await expect(
      completeJob(
        db.app,
        people.tech!,
        a,
        { lines: [{ lineId: rl6, outcome: "done" }], note: "Done" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "lines" } });

    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    expect((await authorizedScope(db.app, a)).sort()).toEqual([rl2, rl3, rl6].sort());
    expect(await authorizedTotal(a)).toBe("590.00");
    const after = (await jobCard(db.app, a))!;
    expect(after.changeAwaitingCustomer).toBe(false);
    expect(after.lines.map((line) => line.id)).toContain(rl6);
  });

  it("a declined or lapsed price change leaves the approved line authorized and unfrozen", async () => {
    for (const ending of ["declined", "withdrawn"] as const) {
      const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
      await amendA(ro, a);
      await replaceLine(db.app, people.advisor!, rl2, { qty: "2" }, randomUUID());
      const sent = await send(ro);
      if (ending === "declined") {
        await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "declined" }]);
      } else {
        await withdrawVersion(db.app, people.advisor!, ro, { reasonCode: "needs_changes" }, randomUUID());
        expect((await latestRevision(a)).status).toBe("lapsed");
      }
      expect((await authorizedScope(db.app, a)).sort()).toEqual([rl1, rl2, rl3].sort());
      expect(await authorizedTotal(a)).toBe("500.00");
      expect((await jobCard(db.app, a))!.lines.every((line) => !line.frozen)).toBe(true);
    }
  });

  // --- AC21-08 / substitution ----------------------------------------------------------------------------------

  it("AC21-08: pads cannot be issued to a line a pending substitution replaces; after the decision they can or the new line takes them", async () => {
    await stock(items.pads!);
    await stock(items.padsAm!);
    const { ro, a, rl2 } = await approvedJobA();
    await amendA(ro, a);
    const rl8 = (
      await replaceLine(db.app, people.advisor!, rl2, { itemId: items.padsAm!, qty: "1" }, randomUUID())
    ).result.lineId;
    const sent = await send(ro);
    expect((await latestRevision(a)).kind).toBe("substitution");

    await expect(
      issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "line_awaiting_decision",
      message: "Line awaiting customer decision",
    });
    // The parts list says why and offers no issue.
    const listed = (await partsForOpenJobs(db.app)).find((line) => line.lineId === rl2)!;
    expect(listed.frozen).toBe(true);
    // The database refuses a forged issue to the frozen line too.
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO stock_movement (item_id, kind, qty, value, revision_line_id) VALUES ('${items.pads}', 'issue', 1, 60, '${rl2}')`,
    );
    expect(forged?.code).toBe("42501");

    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    await expect(
      issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "line_not_issuable",
    });
    await issueFromStock(db.app, people.store!, rl8, { qty: "1" }, randomUUID());
    expect(await authorizedTotal(a)).toBe("450.00");
  });

  it("F-13: a parts issue racing the send of a change that replaces the line — one wins, never both", async () => {
    await stock(items.pads!, "20");
    for (let round = 0; round < 4; round++) {
      const { ro, a, rl2 } = await approvedJobA();
      await amendA(ro, a);
      await replaceLine(db.app, people.advisor!, rl2, { itemId: items.padsAm!, qty: "1" }, randomUUID());
      const [issued, sent] = await Promise.allSettled([
        issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID()),
        sendVersion(db.app, people.advisor!, ro, randomUUID()),
      ]);
      expect([issued.status, sent.status].filter((status) => status === "fulfilled")).toHaveLength(1);
      if (issued.status === "fulfilled") {
        expect(sent).toMatchObject({ status: "rejected", reason: { code: "line_not_replaceable" } });
      } else {
        expect(issued).toMatchObject({ status: "rejected", reason: { code: "line_awaiting_decision" } });
      }
    }
  });

  // --- §2.3 supersession guards --------------------------------------------------------------------------------

  it("§2.3 guards: what may not be replaced is refused with its reason", async () => {
    await stock(items.cleaner!);
    const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
    // No change open yet.
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await expect(replaceLine(db.app, people.advisor!, rl2, { qty: "2" }, randomUUID())).rejects.toMatchObject(
      {
        code: "no_amendment",
      },
    );
    await amendJob(db.app, people.advisor!, a, randomUUID());
    await expect(amendJob(db.app, people.advisor!, a, randomUUID())).rejects.toMatchObject({
      code: "amendment_open",
    });
    // Same item at the same or a lower amount is not a price change (a reduction is I2-02b).
    for (const qty of ["1"]) {
      await expect(replaceLine(db.app, people.advisor!, rl2, { qty }, randomUUID())).rejects.toMatchObject({
        code: "price_not_higher",
      });
    }
    await expect(
      replaceLine(db.app, people.advisor!, rl1, { qty: "0.5" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "price_not_higher",
    });
    // Another type.
    await expect(
      replaceLine(db.app, people.advisor!, rl1, { itemId: items.pads!, qty: "1" }, randomUUID()),
    ).rejects.toMatchObject({ code: "line_type_differs" });
    // A line with parts issued (returns arrive with I4-02).
    await issueFromStock(db.app, people.store!, rl3, { qty: "1" }, randomUUID());
    await expect(replaceLine(db.app, people.advisor!, rl3, { qty: "2" }, randomUUID())).rejects.toMatchObject(
      {
        code: "line_has_parts",
      },
    );
    // Twice in the same change.
    await replaceLine(db.app, people.advisor!, rl2, { qty: "2" }, randomUUID());
    await expect(replaceLine(db.app, people.advisor!, rl2, { qty: "3" }, randomUUID())).rejects.toMatchObject(
      {
        code: "line_already_replaced",
      },
    );
    // A line that is not authorized (one added in this very change).
    const added = (await addLine(db.app, people.advisor!, a, { itemId: items.pins!, qty: "1" }, randomUUID()))
      .result.lineId;
    await expect(
      replaceLine(db.app, people.advisor!, added, { qty: "2" }, randomUUID()),
    ).rejects.toMatchObject({
      code: "line_not_authorized",
    });
  });

  it("only approved jobs are changed: a job new in the draft or declined is not amendable", async () => {
    const ro = await newRepairOrder();
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const a = (await addJob(db.app, people.advisor!, ro, { title: "A" }, randomUUID())).result.jobId;
    const b = (await addJob(db.app, people.advisor!, ro, { title: "B" }, randomUUID())).result.jobId;
    await addLine(db.app, people.advisor!, a, { itemId: items.labor!, qty: "1" }, randomUUID());
    await addLine(db.app, people.advisor!, b, { itemId: items.labor!, qty: "1" }, randomUUID());
    await expect(amendJob(db.app, people.advisor!, a, randomUUID())).rejects.toMatchObject({
      code: "not_amendable",
    });
    const sent = await send(ro);
    await approve(sent.versionId, sent.contentHash, [
      { jobId: a, decision: "approved" },
      { jobId: b, decision: "declined" },
    ]);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await expect(amendJob(db.app, people.advisor!, b, randomUUID())).rejects.toMatchObject({
      code: "not_amendable",
    });
    // The staff view offers "Change this job" for A only.
    const view = (await estimateView(db.app, ro))!;
    expect(view.earlierApproved.map((job) => [job.jobId, job.amendable])).toEqual([[a, true]]);
  });

  it("send re-checks the guards: parts issued since drafting, or a discount bringing the price back down, are refused", async () => {
    await stock(items.pads!);
    const first = await approvedJobA();
    await amendA(first.ro, first.a);
    await replaceLine(db.app, people.advisor!, first.rl2, { itemId: items.padsAm!, qty: "1" }, randomUUID());
    await issueFromStock(db.app, people.store!, first.rl2, { qty: "1" }, randomUUID());
    await expect(send(first.ro)).rejects.toMatchObject({ code: "line_not_replaceable" });

    const second = await approvedJobA();
    await amendA(second.ro, second.a);
    const raised = (await replaceLine(db.app, people.advisor!, second.rl1, { qty: "1.5" }, randomUUID()))
      .result.lineId;
    // 270.00 − 90.00 = 180.00: the same as approved.
    await setLineDiscount(db.app, people.manager!, raised, { discount: "90.00" }, randomUUID());
    await expect(send(second.ro)).rejects.toMatchObject({ code: "price_not_higher" });
  });

  it("the database refuses replacements the commands would refuse", async () => {
    const { ro, a, rl1, rl2 } = await approvedJobA();
    await amendA(ro, a);
    const draftRevision = await latestRevision(a);
    const price = await db.app
      .selectFrom("revision_line")
      .selectAll()
      .where("id", "=", rl2)
      .executeTakeFirstOrThrow();
    const insert = (supersedes: string, revisionId: string) =>
      sqlErrorAs(
        db.appUrl,
        `INSERT INTO revision_line (revision_id, line_type, catalogue_item_id, catalogue_price_id, description_en,
           description_ar, unit, qty, unit_price, gross, line_total, net, vat, tax_code, tax_rate, supersedes_line_id)
         VALUES ('${revisionId}', 'part', '${price.catalogue_item_id}', '${price.catalogue_price_id}', 'x', 'x', 'piece',
           2, ${price.unit_price}, 600.00, 600.00, 571.43, 28.57, '${price.tax_code}', ${price.tax_rate}, '${supersedes}')`,
      );
    // Another type (RL-1 is labour).
    expect((await insert(rl1, draftRevision.id))?.code).toBe("42501");
    // A line of another repair order's job.
    const other = await approvedJobA();
    expect((await insert(other.rl2, draftRevision.id))?.code).toBe("42501");
    // An Original revision never supersedes: a new job in the same draft.
    const fresh = (await addJob(db.app, people.advisor!, ro, { title: "New" }, randomUUID())).result.jobId;
    const freshRevision = await latestRevision(fresh);
    expect((await insert(rl2, freshRevision.id))?.code).toBe("42501");
    // A reduction or partial-work agreement cannot be inserted yet (I2-02b).
    const bad = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO job_revision (job_id, revision_no, kind, proposed_in_version_id) VALUES ('${other.a}', 2, 'reduction', '${draftRevision.proposed_in_version_id}')`,
    );
    expect(bad?.code).toBe("42501");
    // The valid one goes in.
    expect(await insert(rl2, draftRevision.id)).toBeNull();
  });

  // --- §3.3 reopen ---------------------------------------------------------------------------------------------

  it("§3.3: a done job goes back to In progress when an amendment is approved; a declined one leaves it done", async () => {
    for (const decision of ["approved", "declined"] as const) {
      const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
      await stock(items.pads!);
      await stock(items.cleaner!);
      await issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID());
      await issueFromStock(db.app, people.store!, rl3, { qty: "1" }, randomUUID());
      await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
      await startJob(db.app, people.tech!, a, randomUUID());
      await completeJob(
        db.app,
        people.tech!,
        a,
        {
          lines: [rl1, rl2, rl3].map((lineId) => ({ lineId, outcome: "done" })),
          note: "Brakes done",
        },
        randomUUID(),
      );
      expect(await jobStatus(a)).toBe("done");

      await amendA(ro, a);
      const rl4 = (await addLine(db.app, people.advisor!, a, { itemId: items.pins!, qty: "1" }, randomUUID()))
        .result.lineId;
      const sent = await send(ro);
      await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision }]);
      if (decision === "declined") {
        expect(await jobStatus(a)).toBe("done");
        continue;
      }
      expect(await jobStatus(a)).toBe("in_progress");
      const audit = await db.app
        .selectFrom("audit_event")
        .select(["before_state", "after_state"])
        .where("action", "=", "job.reopened")
        .where("entity_id", "=", a)
        .executeTakeFirstOrThrow();
      expect(audit.before_state).toEqual({ status: "done" });
      // QC waits for the job; Done again needs the new line's outcome.
      await expect(requestQc(db.app, people.tech!, ro, randomUUID())).rejects.toMatchObject({
        code: "work_not_finished",
      });
      await expect(
        completeJob(db.app, people.tech!, a, { lines: [], note: "Done" }, randomUUID()),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "lines" } });
      await completeJob(
        db.app,
        people.tech!,
        a,
        { lines: [{ lineId: rl4, outcome: "not_performed", reason: "Pins fine" }], note: "Pins checked" },
        randomUUID(),
      );
      expect(await jobStatus(a)).toBe("done");
    }
  });

  it("the database reopens a done job only through an approved amendment", async () => {
    const { a, rl1, rl2, rl3 } = await approvedJobA();
    await stock(items.pads!);
    await stock(items.cleaner!);
    await issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID());
    await issueFromStock(db.app, people.store!, rl3, { qty: "1" }, randomUUID());
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, a, randomUUID());
    await completeJob(
      db.app,
      people.tech!,
      a,
      { lines: [rl1, rl2, rl3].map((lineId) => ({ lineId, outcome: "done" })), note: "Done" },
      randomUUID(),
    );
    const forged = await sqlErrorAs(
      db.appUrl,
      `UPDATE repair_job SET execution_status = 'in_progress', updated_by = '${people.tech!.userId}' WHERE id = '${a}'`,
    );
    expect(forged?.code).toBe("42501");
  });

  // --- Invoice ---------------------------------------------------------------------------------------------------

  it("after an approved price change the invoice bills the new line, never the replaced one", async () => {
    await stock(items.pads!);
    await stock(items.cleaner!);
    const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
    await amendA(ro, a);
    const rl6 = (await replaceLine(db.app, people.advisor!, rl1, { qty: "1.5" }, randomUUID())).result.lineId;
    const sent = await send(ro);
    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    await issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID());
    await issueFromStock(db.app, people.store!, rl3, { qty: "1" }, randomUUID());
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, a, randomUUID());
    await completeJob(
      db.app,
      people.tech!,
      a,
      { lines: [rl6, rl2, rl3].map((lineId) => ({ lineId, outcome: "done" })), note: "Done" },
      randomUUID(),
    );
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await passQc(
      db.app,
      people.partner!,
      ro,
      {
        noNewWarningLights: true,
        roadTest: "done",
        odometerOutKm: "30010",
        fluidsOk: true,
        cleanlinessOk: true,
        belongingsOk: true,
        oldParts: "disposed",
      },
      randomUUID(),
    );
    const draftId = (await createInvoiceDraft(db.app, people.advisor!, ro, randomUUID())).result.draftId;
    const day = (
      await sql<{
        d: string;
      }>`SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS d`.execute(db.app)
    ).rows[0]!.d;
    const preview = (await invoicePreview(db.app, draftId, day))!;
    expect(preview.lines.map((line) => line.revisionLineId).sort()).toEqual([rl6, rl2, rl3].sort());
    expect(preview.total).toBe("590.00");
  });

  // --- Discard, permissions, idempotency -----------------------------------------------------------------------

  it("taking a change out discards only its revision; the approved work and its urgent finding stay as they were", async () => {
    const ro = await newRepairOrder();
    await recordFinding(
      db.app,
      people.advisor!,
      ro,
      { title: "Brake pads worn", severity: "urgent", internalNote: "" },
      randomUUID(),
    );
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const a = (await estimateView(db.app, ro))!.jobs[0]!.id;
    await addLine(db.app, people.advisor!, a, { itemId: items.pads!, qty: "1" }, randomUUID());
    const sent = await send(ro);
    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    const { revisionId } = await amendA(ro, a);
    await addLine(db.app, people.advisor!, a, { itemId: items.pins!, qty: "1" }, randomUUID());
    await removeJob(db.app, people.advisor!, a, {}, randomUUID());
    expect(
      await db.app
        .selectFrom("job_revision")
        .select("status")
        .where("id", "=", revisionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "discarded" });
    expect(
      await db.app
        .selectFrom("repair_job")
        .select("removed_at")
        .where("id", "=", a)
        .executeTakeFirstOrThrow(),
    ).toEqual({ removed_at: null });
    expect(await db.app.selectFrom("urgent_finding_exclusion").select("id").execute()).toHaveLength(0);
    expect(await authorizedTotal(a)).toBe("300.00");
    // A new change can be opened again.
    await amendJob(db.app, people.advisor!, a, randomUUID());
  });

  it("technicians, store keepers and the accountant cannot change approved work (command and HTTP, audited)", async () => {
    const { ro, a, rl2 } = await approvedJobA();
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    for (const who of ["tech", "store", "accountant"]) {
      await expect(amendJob(db.app, people[who]!, a, randomUUID())).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(replaceLine(db.app, people[who]!, rl2, { qty: "2" }, randomUUID())).rejects.toMatchObject({
        code: "forbidden",
      });
    }
    const response = await handlers.amendEstimateJob(
      new Request(`${BASE}/api/repair-jobs/${a}/amend`, {
        method: "POST",
        headers: { ...cookie(people.tech!.token), origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      }),
      a,
    );
    expect(response.status).toBe(403);
    const ok = await handlers.amendEstimateJob(
      new Request(`${BASE}/api/repair-jobs/${a}/amend`, {
        method: "POST",
        headers: { ...cookie(people.advisor!.token), origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID() }),
      }),
      a,
    );
    expect(ok.status).toBe(201);
    const replaced = await handlers.replaceEstimateLine(
      new Request(`${BASE}/api/revision-lines/${rl2}/replace`, {
        method: "POST",
        headers: { ...cookie(people.advisor!.token), origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({ qty: "2", idempotencyKey: randomUUID() }),
      }),
      rl2,
    );
    expect(replaced.status).toBe(201);
  });

  it("opening a change and replacing a line replay under the same key (rule 11)", async () => {
    const { ro, a, rl2 } = await approvedJobA();
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const key = randomUUID();
    const first = await amendJob(db.app, people.advisor!, a, key);
    const replay = await amendJob(db.app, people.advisor!, a, key);
    expect(replay).toMatchObject({ replayed: true, result: first.result });
    const lineKey = randomUUID();
    const line = await replaceLine(db.app, people.advisor!, rl2, { qty: "2" }, lineKey);
    const lineReplay = await replaceLine(db.app, people.advisor!, rl2, { qty: "2" }, lineKey);
    expect(lineReplay).toMatchObject({ replayed: true, result: line.result });
    expect(
      await db.app.selectFrom("revision_line").select("id").where("supersedes_line_id", "=", rl2).execute(),
    ).toHaveLength(1);
    const audit = await db.app
      .selectFrom("audit_event")
      .select(["before_state", "after_state"])
      .where("action", "=", "estimate.line_replaced")
      .where("entity_id", "=", line.result.lineId)
      .executeTakeFirstOrThrow();
    expect(audit.before_state).toMatchObject({ lineId: rl2, total: "300.00" });
    expect(audit.after_state).toMatchObject({ total: "600.00" });
  });

  // --- Snapshot, rendering -------------------------------------------------------------------------------------

  it("schema 4: a replacement names the line it replaces, without costs or notes; Arabic and English show it", async () => {
    const { ro, a, rl2 } = await approvedJobA();
    await amendA(ro, a);
    await replaceLine(db.app, people.advisor!, rl2, { itemId: items.padsAm!, qty: "1" }, randomUUID());
    const sent = await send(ro);
    const snapshot = (
      await db.app
        .selectFrom("estimate_version")
        .select("snapshot")
        .where("id", "=", sent.versionId)
        .executeTakeFirstOrThrow()
    ).snapshot as EstimateSnapshot;
    const line = snapshot.jobs[0]!.lines[0]!;
    expect(Object.keys(line.replaces!).sort()).toEqual(
      ["descriptionAr", "descriptionEn", "lineId", "qty", "total", "unit"].sort(),
    );
    expect(line.replaces).toMatchObject({ lineId: rl2, descriptionEn: "PADS-OEM EN", total: "300.00" });
    expect(JSON.stringify(snapshot)).not.toMatch(/cost|internal|wip/i);
    // v1's job A shows its approved 500.00 as context.
    expect(snapshot.earlierApproved?.[0]?.total).toBe("500.00");

    const en = renderToStaticMarkup(
      <EstimateDocument snapshot={snapshot} locale="en" photoUrl={(id) => id} />,
    );
    expect(en).toContain("Different part or service");
    expect(en).toContain("Replaces:");
    expect(en).toContain("PADS-OEM EN");
    expect(en).toMatch(/Difference.*−/s);
    const ar = renderToStaticMarkup(
      <EstimateDocument snapshot={snapshot} locale="ar" photoUrl={(id) => id} />,
    );
    expect(ar).toContain("بدلاً من:");
    expect(ar).toContain("PADS-OEM AR");

    // After approval, a later version's context counts the replacement, not the replaced pads.
    await approve(sent.versionId, sent.contentHash, [{ jobId: a, decision: "approved" }]);
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    const view = (await estimateView(db.app, ro))!;
    expect(view.earlierApproved.map((job) => job.total).sort()).toEqual(["200.00", "250.00"]);
  });

  // --- OD-72 findings during work ------------------------------------------------------------------------------

  it("OD-72: findings are recorded during work by the job's technician and staff; urgent ones join the open draft", async () => {
    const { ro, a } = await approvedJobA();
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    // The technician holding a job of this car records what they found.
    await recordFinding(
      db.app,
      people.tech!,
      ro,
      { title: "Caliper slider pins worn", severity: "soon", internalNote: "" },
      randomUUID(),
    );
    // Another technician cannot.
    await expect(
      recordFinding(
        db.app,
        people.tech2!,
        ro,
        { title: "Other", severity: "ok", internalNote: "" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    // An urgent finding while version 2 is a draft joins it as a job (OD-23).
    await startVersion(db.app, people.advisor!, ro, randomUUID());
    await recordFinding(
      db.app,
      people.advisor!,
      ro,
      { title: "Brake hose cracked", severity: "urgent", internalNote: "" },
      randomUUID(),
    );
    const view = (await estimateView(db.app, ro))!;
    expect(view.jobs.map((job) => job.title)).toContain("Brake hose cracked");
    expect(view.otherFindings.map((finding) => finding.title)).toContain("Caliper slider pins worn");
  });

  it("OD-72: findings stay closed once the car is in QC", async () => {
    const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
    await stock(items.pads!);
    await stock(items.cleaner!);
    await issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID());
    await issueFromStock(db.app, people.store!, rl3, { qty: "1" }, randomUUID());
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, a, randomUUID());
    await completeJob(
      db.app,
      people.tech!,
      a,
      { lines: [rl1, rl2, rl3].map((lineId) => ({ lineId, outcome: "done" })), note: "Done" },
      randomUUID(),
    );
    await requestQc(db.app, people.tech!, ro, randomUUID());
    await expect(
      recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Late", severity: "ok", internalNote: "" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "inspection_closed" });
    const forged = await sqlErrorAs(
      db.appUrl,
      `INSERT INTO finding (repair_order_id, title, severity, recorded_by) VALUES ('${ro}', 'x', 'ok', '${people.advisor!.userId}')`,
    );
    expect(forged?.code).toBe("42501");
  });

  // --- Review follow-ups ---------------------------------------------------------------------------------------

  it("the database refuses to send an amendment whose replaced line took parts, or whose price change is not higher", async () => {
    await stock(items.pads!);
    // Marks the draft version Sent behind the command's back, so only the revision guard (0025) is left to refuse.
    const forceSent = async (ro: string) =>
      db.owner.transaction().execute(async (tx) => {
        await sql`ALTER TABLE estimate_version DISABLE TRIGGER USER`.execute(tx);
        await sql`UPDATE estimate_version SET status = 'sent', sent_at = now(), snapshot = '{}', content_hash = repeat('0', 64), expires_at = now() + interval '1 day' WHERE status = 'draft'
                   AND estimate_id = (SELECT id FROM estimate WHERE repair_order_id = ${ro})`.execute(tx);
        await sql`ALTER TABLE estimate_version ENABLE TRIGGER USER`.execute(tx);
      });
    const pend = (revisionId: string) =>
      sqlErrorAs(db.appUrl, `UPDATE job_revision SET status = 'pending' WHERE id = '${revisionId}'`);

    const parts = await approvedJobA();
    const partsChange = (await amendA(parts.ro, parts.a)).revisionId;
    await replaceLine(db.app, people.advisor!, parts.rl2, { itemId: items.padsAm!, qty: "1" }, randomUUID());
    await issueFromStock(db.app, people.store!, parts.rl2, { qty: "1" }, randomUUID());
    await forceSent(parts.ro);
    const refusedParts = await pend(partsChange);
    expect(refusedParts?.code).toBe("42501");
    expect(refusedParts?.message).toContain("replaces a line it may not replace");

    const price = await approvedJobA();
    const priceChange = (await amendA(price.ro, price.a)).revisionId;
    const raised = (await replaceLine(db.app, people.advisor!, price.rl1, { qty: "1.5" }, randomUUID()))
      .result.lineId;
    await setLineDiscount(db.app, people.manager!, raised, { discount: "100.00" }, randomUUID());
    await forceSent(price.ro);
    const refusedPrice = await pend(priceChange);
    expect(refusedPrice?.code).toBe("42501");
    expect(refusedPrice?.message).toContain("replaces a line it may not replace");

    // The same path with a valid change goes through, and fixes the kind.
    const valid = await approvedJobA();
    const validChange = (await amendA(valid.ro, valid.a)).revisionId;
    await replaceLine(db.app, people.advisor!, valid.rl1, { qty: "1.5" }, randomUUID());
    await forceSent(valid.ro);
    expect(await pend(validChange)).toBeNull();
    expect((await latestRevision(valid.a)).kind).toBe("price_change");
  });

  it("§3.3 through the customer link: the approval reopens the done job with no staff member recorded", async () => {
    const { ro, a, rl1, rl2, rl3 } = await approvedJobA();
    await stock(items.pads!);
    await stock(items.cleaner!);
    await issueFromStock(db.app, people.store!, rl2, { qty: "1" }, randomUUID());
    await issueFromStock(db.app, people.store!, rl3, { qty: "1" }, randomUUID());
    await assignJob(db.app, people.manager!, a, { assigneeId: people.tech!.userId }, randomUUID());
    await startJob(db.app, people.tech!, a, randomUUID());
    await completeJob(
      db.app,
      people.tech!,
      a,
      { lines: [rl1, rl2, rl3].map((lineId) => ({ lineId, outcome: "done" })), note: "Done" },
      randomUUID(),
    );
    const { revisionId } = await amendA(ro, a);
    await addLine(db.app, people.advisor!, a, { itemId: items.pins!, qty: "1" }, randomUUID());
    await send(ro);
    const { token } = (await createCustomerLink(db.app, people.advisor!, ro)).result;
    const outcome = await recordLinkApproval(
      db.app,
      token,
      { approverName: "Omar", decisions: [{ revisionId, decision: "approved" }], language: "en" },
      { ip: "203.0.113.77", userAgent: "Mozilla/5.0 (customer phone)" },
      randomUUID(),
    );
    expect(outcome.kind).toBe("recorded");
    expect(await jobStatus(a)).toBe("in_progress");
    const event = await db.app
      .selectFrom("job_status_event")
      .select(["from_status", "to_status", "actor_id"])
      .where("job_id", "=", a)
      .orderBy("occurred_at", "desc")
      .executeTakeFirstOrThrow();
    expect(event).toEqual({ from_status: "done", to_status: "in_progress", actor_id: null });
  });

  it("OD-10 during work: a finding shown in a sent estimate stays read-only, its photos too; new findings stay open", async () => {
    const ro = await newRepairOrder();
    const shown = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Pads worn", severity: "soon", customerNote: "Pads at 2 mm", internalNote: "" },
        randomUUID(),
      )
    ).result.findingId;
    const photo = (
      await addFindingPhoto(
        db.app,
        storage,
        people.advisor!,
        { findingId: shown, bytes: makePng(64, 64, 3) },
        randomUUID(),
      )
    ).result.mediaId;
    await setFindingPhotoVisibility(db.app, people.advisor!, photo, "customer");
    await openEstimate(db.app, people.advisor!, ro, randomUUID());
    const { jobId } = (
      await addJob(db.app, people.advisor!, ro, { title: "Pads", findingId: shown }, randomUUID())
    ).result;
    await addLine(db.app, people.advisor!, jobId, { itemId: items.pads!, qty: "1" }, randomUUID());
    const sent = await send(ro);
    await approve(sent.versionId, sent.contentHash, [{ jobId, decision: "approved" }]);
    expect(
      (
        await db.app
          .selectFrom("repair_order")
          .select("status")
          .where("id", "=", ro)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("in_progress");

    await expect(
      updateFinding(db.app, people.advisor!, shown, { title: "Pads fine", severity: "ok", internalNote: "" }),
    ).rejects.toMatchObject({ code: "finding_sent" });
    await expect(setFindingPhotoVisibility(db.app, people.advisor!, photo, "internal")).rejects.toMatchObject(
      {
        code: "finding_sent",
      },
    );
    await expect(discardFindingPhoto(db.app, people.advisor!, photo)).rejects.toMatchObject({
      code: "finding_sent",
    });
    for (const statement of [
      `UPDATE finding SET severity = 'ok' WHERE id = '${shown}'`,
      `UPDATE media_asset SET visibility = 'internal' WHERE id = '${photo}'`,
      `UPDATE media_asset SET discarded_at = now() WHERE id = '${photo}'`,
    ]) {
      expect((await sqlErrorAs(db.appUrl, statement))?.code).toBe("42501");
    }
    // A new photo on it is fine (it starts internal), and a finding of the work itself stays editable.
    await addFindingPhoto(
      db.app,
      storage,
      people.advisor!,
      { findingId: shown, bytes: makePng(64, 64, 4) },
      randomUUID(),
    );
    const fresh = (
      await recordFinding(
        db.app,
        people.advisor!,
        ro,
        { title: "Hose", severity: "soon", internalNote: "" },
        randomUUID(),
      )
    ).result.findingId;
    await updateFinding(db.app, people.advisor!, fresh, {
      title: "Brake hose",
      severity: "urgent",
      internalNote: "",
    });
  });
});
