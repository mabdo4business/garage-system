import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo, type DemoResult } from "../scripts/demo-scenario";
import {
  BoardView,
  type BoardInvoice,
  type BoardPermissions,
} from "../src/app/[locale]/(staff)/workshop/board-view";
import { boardChanges, parseSnapshot } from "../src/components/board/changes";
import { t, type Locale } from "../src/i18n";
import { invoicesForRepairOrders } from "../src/server/billing/queries";
import { LocalDiskStorage } from "../src/server/media/storage";
import { ROLES } from "../src/server/auth/permissions";
import { qcBlockerOf } from "../src/server/quality/queries";
import { boardAccessFor, boardInvoicesFor } from "../src/server/workshop/board-access";
import { workshopBoard, type BoardRepairOrder } from "../src/server/workshop/queries";
import { createTestDatabase, type TestDatabase } from "./helpers/db";
import { TEST_PASSWORD } from "./helpers/users";

/**
 * Redesign UI-R2 — the workshop board: statuses as words, "do not start" only while awaiting the customer (AC2-01,
 * T-22), QC in one step only when nothing blocks it (AC2-25), Deliver locked with its reason (OD-50), no prices for
 * anyone and the invoice amount only for money holders, and the card-change detection behind pop and toast.
 */

describe("S24 — workshop board", () => {
  let db: TestDatabase;
  let storageDir: string;
  let demo: DemoResult;
  let board: BoardRepairOrder[];
  const now = new Date();
  const all: BoardPermissions = {
    editEstimate: true,
    recordApproval: true,
    requestQc: true,
    decideQc: true,
    takePayment: true,
    deliver: true,
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-board-"));
    demo = await seedDemo(db.app, new LocalDiskStorage(storageDir), TEST_PASSWORD, { suffix: ".s24" });
    board = await workshopBoard(db.app);
  }, 120_000);
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  const order = (key: string) => board.find((row) => row.id === demo.repairOrders[key])!;
  async function invoices(money: boolean) {
    const rows = await invoicesForRepairOrders(
      db.app,
      board.map((row) => row.id),
    );
    return new Map<string, BoardInvoice>(
      rows.map((row) => [
        row.repairOrderId,
        { number: row.number, paid: row.balance === "0.00", balance: money ? row.balance : null },
      ]),
    );
  }
  function render(
    locale: Locale,
    options: {
      money: boolean;
      can?: BoardPermissions;
      rows?: BoardRepairOrder[];
      map?: Map<string, BoardInvoice>;
    },
  ) {
    return renderToStaticMarkup(
      <BoardView
        locale={locale}
        board={options.rows ?? board}
        invoices={options.map ?? new Map()}
        can={options.can ?? all}
        now={now}
        businessDate="2026-10-27"
        renderRequestQc={() => <span>REQUEST-QC-FORM</span>}
      />,
    );
  }
  /** The markup of one card. */
  const cardOf = (html: string, id: string) => {
    const start = html.indexOf(`data-card="${id}"`);
    const end = html.indexOf("data-card=", start + 10);
    return html.slice(start, end < 0 ? undefined : end);
  };

  it("the board query: when the estimate was sent, and what blocks QC (shared with the QC screen)", () => {
    expect(order("awaiting").decisionSentAt).toBeInstanceOf(Date);
    expect(order("awaiting").qcBlocker).toBeNull(); // not in progress: no QC question yet
    expect(order("partly").status).toBe("in_progress");
    expect(order("partly").decisionSentAt).toBeInstanceOf(Date);
    expect(order("partly").qcBlocker).toBe("decision_pending");
    expect(order("working").qcBlocker).toBe("work_not_finished");
    expect(order("checkedIn1").decisionSentAt).toBeNull();
    expect(qcBlockerOf("in_progress", false, ["done", "stopped_by_customer"])).toBeNull();
    // As requestQc and the database guard: a cancelled job is not finished work.
    expect(qcBlockerOf("in_progress", false, ["done", "cancelled"])).toBe("work_not_finished");
    expect(qcBlockerOf("in_progress", false, ["done", "paused"])).toBe("work_not_finished");
    expect(qcBlockerOf("qc", false, ["done"])).toBe("not_in_progress");
  });

  it.each(["en", "ar"] as const)("%s: six columns with their status words and counts", (locale) => {
    const html = render(locale, { money: false });
    for (const status of ["checked_in", "diagnosing", "awaiting_approval", "in_progress", "qc", "ready"]) {
      expect(html).toContain(`id="col-${status}"`);
      expect(html).toContain(t(locale, `repairOrder.status.${status}` as never));
    }
    expect(html).toContain(t(locale, "workshop.title"));
    expect(html).toContain(t(locale === "ar" ? "en" : "ar", "workshop.title"));
    expect(html).toContain(t(locale, "board.inWorkshop", { n: String(board.length) }));
  });

  it('"do not start" only on an order awaiting the customer; a partly decided order says some jobs wait', () => {
    const html = render("en", { money: false });
    const stop = t("en", "board.doNotStart");
    expect(cardOf(html, demo.repairOrders.awaiting!)).toContain(stop);
    expect(cardOf(html, demo.repairOrders.awaiting!)).toContain("/estimate/approve");
    const partly = cardOf(html, demo.repairOrders.partly!);
    expect(partly).not.toContain(stop);
    expect(partly).toContain(t("en", "board.flag.someJobsAwaiting").replace("'", "&#x27;")); // as React escapes it
    expect(partly).toContain(t("en", "qc.blocker.decision_pending"));
    expect(html.split(stop).length - 1).toBe(1);
  });

  it("QC in one step only when nothing blocks it and the viewer may request it; otherwise the reason", () => {
    const working = order("working");
    expect(cardOf(render("en", { money: false }), working.id)).toContain(
      t("en", "qc.blocker.work_not_finished"),
    );
    expect(cardOf(render("en", { money: false }), working.id)).not.toContain("REQUEST-QC-FORM");
    const finished = { ...working, qcBlocker: null };
    expect(render("en", { money: false, rows: [finished] })).toContain("REQUEST-QC-FORM");
    // Advisors may not request QC (OD-36): they see why nothing is offered.
    const advisorView = render("en", { money: false, rows: [finished], can: { ...all, requestQc: false } });
    expect(advisorView).not.toContain("REQUEST-QC-FORM");
    expect(advisorView).toContain(t("en", "board.action.qcRequestedByWorkshop"));
    // A disabled button never submits.
    expect(cardOf(render("en", { money: false }), working.id)).toMatch(
      /<button type="button" class="board-locked" disabled="">/,
    );
  });

  it('Deliver stays locked and says why: the balance for money holders, "not paid yet" for others (OD-50)', async () => {
    const withMoney = render("en", { money: true, map: await invoices(true) });
    const without = render("en", { money: false, map: await invoices(false) });
    const invoice = (await invoicesForRepairOrders(db.app, [demo.repairOrders.ready!]))[0]!;
    const ready = cardOf(withMoney, demo.repairOrders.ready!);
    expect(ready).toContain("Deliver — balance due");
    expect(ready).toContain(invoice.balance);
    expect(ready).toContain(t("en", "board.deliver.why"));
    expect(cardOf(without, demo.repairOrders.ready!)).toContain(t("en", "board.deliver.notPaid"));
    // No amount anywhere on the board without money; prices never appear on cards (AC-07.3).
    expect(without).not.toMatch(/AED|د\.إ/);
    expect(without).not.toContain(invoice.total);
    expect(withMoney.replace(ready, "")).not.toMatch(/AED/);
    for (const amount of ["180.00", "270.00", "360.00"]) expect(without).not.toContain(amount);
  });

  it("I1-10: an unpaid Ready card offers Take payment; a paid one Hand over, with Deliver no longer locked", async () => {
    const ready = order("ready");
    const unpaid = new Map([[ready.id, { number: "INV-1", paid: false, balance: "180.00" }]]);
    const paid = new Map([[ready.id, { number: "INV-1", paid: true, balance: "0.00" }]]);
    const unpaidHtml = render("en", { money: true, rows: [ready], map: unpaid });
    expect(unpaidHtml).toContain(t("en", "board.action.takePayment"));
    expect(unpaidHtml).toContain("board-locked");
    expect(unpaidHtml).not.toContain(t("en", "board.action.handOver"));
    // Without payment.record (e.g. the accountant) only the invoice link.
    expect(
      render("en", { money: false, rows: [ready], map: unpaid, can: { ...all, takePayment: false } }),
    ).not.toContain(t("en", "board.action.takePayment"));
    const paidHtml = render("en", { money: true, rows: [ready], map: paid });
    expect(paidHtml).toContain(t("en", "board.action.handOver"));
    expect(paidHtml).toContain(`/repair-orders/${ready.id}#payments`);
    expect(paidHtml).not.toContain("board-locked");
    expect(
      render("en", { money: true, rows: [ready], map: paid, can: { ...all, deliver: false } }),
    ).not.toContain(t("en", "board.action.handOver"));
  });

  it("every status shows as a word; waiting for parts is a job chip in the purple pair", () => {
    const html = render("ar", { money: false });
    const parts = cardOf(html, demo.repairOrders.parts!);
    expect(parts).toContain(`chip-status-parts">${t("ar", "job.status.waiting_parts")}`);
    // Every chip carries text.
    expect(html).not.toMatch(/<span class="chip[^"]*"><\/span>/);
  });

  it("what the board offers each role: amounts for partner and manager only; actions per permission", async () => {
    const access = Object.fromEntries(ROLES.map((role) => [role, boardAccessFor([role])]));
    expect(access.partner).toEqual({
      money: true,
      canAssign: true,
      can: {
        editEstimate: true,
        recordApproval: true,
        requestQc: true,
        decideQc: true,
        takePayment: true,
        deliver: true,
      },
    });
    expect(access.manager).toEqual(access.partner);
    expect(access.service_advisor).toEqual({
      money: false,
      canAssign: false,
      can: {
        editEstimate: true,
        recordApproval: true,
        requestQc: false,
        decideQc: false,
        takePayment: true,
        deliver: true,
      },
    });
    // I1-10: the accountant reads invoices but takes no payment and hands over no car.
    expect(access.accountant!.can).toMatchObject({ takePayment: false, deliver: false });
    // The page applies the same access to the invoices it passes in (OD-50).
    const rows = await invoicesForRepairOrders(db.app, [demo.repairOrders.ready!]);
    expect([...boardInvoicesFor(access.service_advisor!, rows).values()]).toEqual([
      { number: rows[0]!.number, paid: false, balance: null },
    ]);
    expect([...boardInvoicesFor(access.manager!, rows).values()]).toEqual([
      { number: rows[0]!.number, paid: false, balance: rows[0]!.balance },
    ]);
  });

  it("offers only what can succeed: no approval link without a sent version, no assign form on finished jobs", () => {
    const awaiting = order("awaiting");
    const closed = { ...awaiting, decisionSentAt: null };
    expect(render("en", { money: false, rows: [awaiting] })).toContain("/estimate/approve");
    expect(render("en", { money: false, rows: [closed] })).not.toContain("/estimate/approve");
    const qc = order("qc");
    const html = renderToStaticMarkup(
      <BoardView
        locale="en"
        board={[qc, order("working")]}
        invoices={new Map()}
        can={all}
        now={now}
        businessDate="2026-10-27"
        renderAssign={(job) => <span>{`ASSIGN-${job.id}`}</span>}
      />,
    );
    for (const job of qc.jobs) expect(html).not.toContain(`ASSIGN-${job.id}`); // done jobs
    for (const job of order("working").jobs) expect(html).toContain(`ASSIGN-${job.id}`);
    // Release check is not QC: no "Record QC result" there.
    const release = renderToStaticMarkup(
      <BoardView
        locale="en"
        board={[{ ...qc, status: "release_check" }]}
        invoices={new Map()}
        can={all}
        now={now}
        businessDate="2026-10-27"
      />,
    );
    expect(release).not.toContain(t("en", "board.action.recordQc"));
    expect(release).toContain(t("en", "board.action.open"));
  });

  it("card changes: moved and new cards, nothing on the first visit; bad storage is ignored", () => {
    expect(boardChanges(null, { a: "qc" })).toEqual([]);
    expect(boardChanges({ a: "in_progress", b: "ready" }, { a: "qc", b: "ready", c: "checked_in" })).toEqual([
      { id: "a", kind: "moved" },
      { id: "c", kind: "new" },
    ]);
    expect(parseSnapshot("not json")).toBeNull();
    expect(parseSnapshot("[1,2]")).toBeNull();
    expect(parseSnapshot('{"a":"qc","b":3}')).toEqual({ a: "qc" });
  });

  it("the toast region announces politely and the cards carry their ids for the pop", () => {
    const html = render("en", { money: false });
    expect(html).toContain('role="status" aria-live="polite"');
    for (const row of board) expect(html).toContain(`data-card="${row.id}"`);
  });
});
