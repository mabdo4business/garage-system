import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardView } from "../src/app/[locale]/(staff)/dashboard-view";
import { formatDue } from "../src/i18n/time-labels";
import { seedDemo, type DemoResult } from "../scripts/demo-scenario";
import { t } from "../src/i18n";
import { hasPermission, ROLES } from "../src/server/auth/permissions";
import { LocalDiskStorage } from "../src/server/media/storage";
import {
  dashboardModeFor,
  dashboardSummary,
  sortAttention,
  type Attention,
} from "../src/server/reporting/dashboard";
import { workedSeconds } from "../src/server/workshop/queries";
import { createTestDatabase, type TestDatabase } from "./helpers/db";
import { TEST_PASSWORD } from "./helpers/users";

/**
 * Redesign — the workshop dashboard (OD-50): real figures from the demo scenario (every workshop stage, created
 * through the real commands), money only for partners and the manager, and the design tokens' contrast (OD-49).
 * UI-R4: the workshop flow strip, Needs attention most urgent first, overdue repair orders and the stage filter.
 */

describe("S23 — workshop dashboard", () => {
  let db: TestDatabase;
  let storageDir: string;
  let demo: DemoResult;

  beforeAll(async () => {
    db = await createTestDatabase();
    storageDir = mkdtempSync(join(tmpdir(), "garage-dashboard-"));
    demo = await seedDemo(db.app, new LocalDiskStorage(storageDir), TEST_PASSWORD, { suffix: ".s23" });
  }, 120_000);
  afterAll(async () => {
    await db?.destroy();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("counts open repair orders by status, in board order, from the live rows", async () => {
    const summary = await dashboardSummary(db.app, { money: true });
    expect(summary.statusCounts.map(({ status, count }) => ({ status, count }))).toEqual([
      { status: "checked_in", count: 2 },
      { status: "diagnosing", count: 1 },
      { status: "awaiting_approval", count: 1 },
      { status: "in_progress", count: 4 },
      { status: "qc", count: 1 },
      { status: "ready", count: 1 },
    ]);
    expect(summary.carsIn).toBe(10);
    expect(summary.awaitingApproval).toBe(1);
    expect(summary.oldestAwaitingSince).toBeInstanceOf(Date);
    expect(summary.ready).toBe(1);
    expect(summary.readyInvoiced).toBe(1);
    expect(summary.checkInsByDay).toHaveLength(7);
    expect(summary.checkInsByDay.at(-1)).toEqual({ date: summary.businessDate, count: 10 });
  });

  it("revenue is the invoiced total (incl. VAT) by business date; amounts are exact strings", async () => {
    const summary = await dashboardSummary(db.app, { money: true });
    const invoice = await db.app
      .selectFrom("invoice")
      .select(["total", "business_date"])
      .where("repair_order_id", "=", demo.repairOrders.ready!)
      .executeTakeFirstOrThrow();
    expect(summary.money).toEqual({
      revenueByDay: summary.checkInsByDay.map(({ date }) => ({
        date,
        total: date === String(invoice.business_date) ? invoice.total : "0.00",
      })),
      today: invoice.total,
      week: invoice.total,
      invoicesToday: 1,
    });
    // Ready with an invoice and no payments yet (I1-10): the whole total is due.
    expect(summary.attention).toContainEqual(
      expect.objectContaining({
        kind: "ready_unpaid",
        repairOrderId: demo.repairOrders.ready,
        balance: invoice.total,
      }),
    );
    const readyRow = summary.orders.find((row) => row.id === demo.repairOrders.ready)!;
    expect(readyRow.amount).toBe(invoice.total);
    // Before invoicing, the amount is the approved total (1.5 h × 180.00 incl. VAT).
    expect(summary.orders.find((row) => row.id === demo.repairOrders.working)!.amount).toBe("270.00");
    // Never sent or approved: no amount.
    expect(summary.orders.find((row) => row.id === demo.repairOrders.checkedIn1)!.amount).toBeNull();
  });

  it("without dashboard.money: no revenue, no amounts, no balances (OD-50)", async () => {
    const summary = await dashboardSummary(db.app, { money: false });
    expect(summary.money).toBeNull();
    expect(summary.orders.every((row) => row.amount === null)).toBe(true);
    for (const item of summary.attention) {
      if (item.kind === "ready_unpaid") expect(item.balance).toBeNull();
    }
    expect(JSON.stringify(summary)).not.toMatch(/\d+\.\d\d"/); // no money string anywhere
  });

  it("dashboard money is for partners and the manager only; the dashboard itself for front-office roles", () => {
    expect(ROLES.filter((role) => hasPermission([role], "dashboard.money"))).toEqual(["partner", "manager"]);
    expect(ROLES.filter((role) => hasPermission([role], "dashboard.read"))).toEqual([
      "partner",
      "manager",
      "service_advisor",
    ]);
  });

  it("bays: active jobs with their bay, assignee, booked labour hours and the pause reason", async () => {
    const summary = await dashboardSummary(db.app, { money: false });
    expect(
      summary.bays.map(({ bay, status, bookedSeconds, reason, assigneeName }) => ({
        bay,
        status,
        bookedSeconds,
        reason,
        assigneeName,
      })),
    ).toEqual([
      {
        bay: "1",
        status: "in_progress",
        bookedSeconds: 5400,
        reason: null,
        assigneeName: "Demo Technician One",
      },
      {
        bay: "2",
        status: "paused",
        bookedSeconds: 7200,
        reason: "Waiting for the leak-test dye to settle",
        assigneeName: "Demo Technician Two",
      },
      {
        bay: "3",
        status: "waiting_parts",
        bookedSeconds: 7200,
        reason: null,
        assigneeName: "Demo Technician One",
      },
    ]);
    expect(summary.attention.map((item) => item.kind).sort()).toEqual(
      ["awaiting_decision", "paused", "ready_unpaid", "waiting_parts"].sort(),
    );
    // Nothing internal or personal beyond staff names: no customer names or mobiles.
    expect(JSON.stringify(summary)).not.toMatch(/Demo Customer|0559/);
  });

  it.each(["en", "ar"] as const)(
    "renders in %s: both titles, every status as a word, the figures as text, and money only when allowed",
    async (locale) => {
      const withMoney = renderToStaticMarkup(
        <DashboardView summary={await dashboardSummary(db.app, { money: true })} locale={locale} />,
      );
      const without = renderToStaticMarkup(
        <DashboardView summary={await dashboardSummary(db.app, { money: false })} locale={locale} />,
      );
      expect(withMoney).toContain(t("en", "dashboard.title"));
      expect(withMoney).toContain(t("ar", "dashboard.title"));
      for (const status of ["checked_in", "diagnosing", "awaiting_approval", "in_progress", "qc", "ready"]) {
        expect(withMoney).toContain(t(locale, `repairOrder.status.${status}` as never));
      }
      // Count-ups render the final value (no JavaScript / reduced motion shows the real figure).
      expect(withMoney).toMatch(/<span class="visually-hidden">10<\/span>/);
      expect(withMoney).toContain(t(locale, "dashboard.revenue.title"));
      expect(withMoney).toContain("270.00");
      // OD-50: no revenue, amounts or balances without dashboard.money.
      expect(without).not.toContain(t(locale, "dashboard.revenue.title"));
      expect(without).not.toContain(t(locale, "dashboard.orders.amount"));
      const invoice = await db.app
        .selectFrom("invoice")
        .select("total")
        .where("repair_order_id", "=", demo.repairOrders.ready!)
        .executeTakeFirstOrThrow();
      for (const amount of ["270.00", invoice.total]) expect(without).not.toContain(amount);
      expect(without).not.toMatch(/AED|د\.إ/);
      expect(without).toContain(t(locale, "dashboard.attention.notPaid"));
      // Awaiting decision is flagged "do not start" with its own number (AC2-01 stays enforced in the database).
      const awaiting = await db.app
        .selectFrom("repair_order")
        .select("number")
        .where("id", "=", demo.repairOrders.awaiting!)
        .executeTakeFirstOrThrow();
      expect(without).toContain(t(locale, "dashboard.attention.doNotStart", { number: awaiting.number }));
    },
  );

  it('a partly decided estimate (T-22) never shows "do not start" while its approved work may run', async () => {
    const summary = await dashboardSummary(db.app, { money: false });
    const partly = summary.orders.find((row) => row.id === demo.repairOrders.partly)!;
    expect(partly.status).toBe("in_progress");
    const awaiting = summary.attention.filter((item) => item.kind === "awaiting_decision");
    expect(awaiting).toEqual([expect.objectContaining({ repairOrderId: demo.repairOrders.awaiting })]);
    // The KPI and its note agree: one order awaiting, and the oldest time is that order's own.
    expect(summary.awaitingApproval).toBe(1);
    const sent = await db.app
      .selectFrom("estimate_version")
      .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
      .select("estimate_version.sent_at")
      .where("estimate.repair_order_id", "=", demo.repairOrders.awaiting!)
      .executeTakeFirstOrThrow();
    expect(summary.oldestAwaitingSince).toEqual(sent.sent_at);
  });

  // --- UI-R4 -----------------------------------------------------------------------------------

  it("Needs attention is ordered most urgent first, oldest first; paused and parts jobs say since when", async () => {
    const summary = await dashboardSummary(db.app, { money: true });
    const order = ["awaiting_decision", "released_unpaid", "ready_unpaid", "paused", "waiting_parts"];
    const ranks = summary.attention.map((item) => order.indexOf(item.kind));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const item of summary.attention) {
      if (item.kind === "paused" || item.kind === "waiting_parts" || item.kind === "awaiting_decision") {
        expect(item.since).toBeInstanceOf(Date);
      }
    }
  });

  it("attention order (T-38): decision, released, ready with balance, paused, parts; oldest first within a kind", () => {
    const at = (hour: number) => new Date(Date.UTC(2026, 9, 27, hour));
    const items: Attention[] = [
      { kind: "waiting_parts", jobId: "p1", number: "RO-9", title: "Parts", since: at(1) },
      { kind: "paused", jobId: "j-new", number: "RO-5", title: "Newer pause", reason: null, since: at(9) },
      {
        kind: "ready_unpaid",
        since: null,
        repairOrderId: "r1",
        number: "RO-3",
        invoiceNumber: null,
        balance: null,
      },
      { kind: "paused", jobId: "j-old", number: "RO-4", title: "Older pause", reason: null, since: at(2) },
      { kind: "released_unpaid", since: null, repairOrderId: "x1", number: "RO-2", balance: null },
      { kind: "awaiting_decision", repairOrderId: "a2", number: "RO-7", since: at(8) },
      { kind: "awaiting_decision", repairOrderId: "a1", number: "RO-1", since: at(3) },
    ];
    expect(sortAttention(items).map((item) => item.number)).toEqual([
      "RO-1",
      "RO-7",
      "RO-2",
      "RO-3",
      "RO-4",
      "RO-5",
      "RO-9",
    ]);
  });

  it("overdue: past the promised time and not yet Ready; counted per stage", async () => {
    const now = new Date(Date.now() + 30 * 86_400_000);
    const summary = await dashboardSummary(db.app, { money: false, now });
    expect(summary.generatedAt).toEqual(now);
    for (const row of summary.orders) {
      expect(row.overdue).toBe(row.promisedAt !== null && row.status !== "ready");
    }
    expect(summary.orders.some((row) => row.overdue)).toBe(true);
    for (const { status, overdue } of summary.statusCounts) {
      expect(overdue).toBe(summary.orders.filter((row) => row.status === status && row.overdue).length);
    }
    // Today, nothing in the demo is late (promised times are hours ahead).
    const today = await dashboardSummary(db.app, { money: false });
    expect(today.orders.filter((row) => row.overdue)).toEqual([]);
  });

  it("due labels: overdue by, due in, or the time beyond a day", () => {
    const now = new Date(Date.UTC(2026, 9, 27, 10, 0));
    const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
    expect(formatDue(at(-185), now, "en", "2026-10-27")).toEqual({
      label: "Overdue by 3 h 5 min",
      overdue: true,
    });
    expect(formatDue(at(40), now, "en", "2026-10-27")).toEqual({ label: "Due in 40 min", overdue: false });
    // Within the minute: "Due now", never "Overdue by 0 min".
    expect(formatDue(new Date(now.getTime() - 30_000), now, "en", "2026-10-27")).toEqual({
      label: "Due now",
      overdue: true,
    });
    expect(formatDue(new Date(now.getTime() + 30_000), now, "en", "2026-10-27").label).toBe("Due now");
    expect(formatDue(at(40), now, "ar", "2026-10-27").label).toContain("40");
    expect(formatDue(at(3 * 24 * 60), now, "en", "2026-10-27").overdue).toBe(false);
  });

  it.each(["en", "ar"] as const)(
    "renders the flow strip (%s): every stage a link that filters the list, Ready never shown late",
    async (locale) => {
      const late = await dashboardSummary(db.app, {
        money: false,
        now: new Date(Date.now() + 30 * 86_400_000),
      });
      const html = renderToStaticMarkup(<DashboardView summary={late} locale={locale} />);
      for (const { status } of late.statusCounts)
        expect(html).toContain(`href="/${locale}?stage=${status}#orders"`);
      expect(html).toContain(t(locale, "dashboard.flow.title"));
      const readyRow = late.orders.find((row) => row.status === "ready")!;
      const ordersHtml = html.slice(html.indexOf('id="orders"'));
      expect(ordersHtml).toContain("is-late"); // others are overdue in 30 days
      expect(ordersHtml).toContain(readyRow.number);
      const readyHtml = ordersHtml.slice(ordersHtml.lastIndexOf("<tr", ordersHtml.indexOf(readyRow.number)));
      const readyCells = readyHtml.slice(0, readyHtml.indexOf("</tr>"));
      expect(readyCells).not.toContain("is-late");

      // A stage from the strip filters the list on first render (no JavaScript needed).
      const filtered = renderToStaticMarkup(<DashboardView summary={late} locale={locale} stage="ready" />);
      const rows = filtered.slice(filtered.indexOf('id="orders"'));
      expect(rows).toContain(readyRow.number);
      const other = late.orders.find((row) => row.status === "in_progress")!;
      expect(rows).not.toContain(`>${other.number}<`);
    },
  );

  it("Today per role: dashboard (money only for partner and manager), My jobs for technicians, else shortcuts", () => {
    expect(Object.fromEntries(ROLES.map((role) => [role, dashboardModeFor([role])]))).toEqual({
      partner: { mode: "dashboard", money: true },
      manager: { mode: "dashboard", money: true },
      service_advisor: { mode: "dashboard", money: false },
      technician: { mode: "my_jobs", money: false },
      store_keeper: { mode: "shortcuts", money: false },
      accountant: { mode: "shortcuts", money: false },
    });
  });

  it("time worked counts only In progress spells, up to now", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 8, minute));
    expect(
      workedSeconds(
        [
          { to: "in_progress", at: at(0) },
          { to: "paused", at: at(10) },
          { to: "in_progress", at: at(30) },
        ],
        at(35),
      ),
    ).toBe(15 * 60);
    expect(workedSeconds([{ to: "waiting_parts", at: at(0) }], at(35))).toBe(0);
  });

  it("design tokens: every text pair ≥ 4.5:1, field edges and chart marks ≥ 3:1, in both themes (OD-49)", () => {
    const css = readFileSync(join(process.cwd(), "src/app/[locale]/tokens.css"), "utf8");
    const [light, rest] = css.split("@media (prefers-color-scheme: dark)");
    const dark = rest!.split("/* Tablets")[0]!;
    const vars = (text: string) =>
      Object.fromEntries([...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
    const themes = { light: vars(light!), dark: { ...vars(light!), ...vars(dark) } };
    const resolve = (theme: Record<string, string>, name: string) => {
      let value = theme[name];
      while (value?.startsWith("var(")) value = theme[value.slice(6, -1)];
      return value!;
    };
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const statuses = ["checked", "diagnosing", "approval", "progress", "parts", "qc", "ready"];
    const pairs: [string, string, number][] = [
      ["fg", "bg", 4.5],
      ["fg", "surface", 4.5],
      ["fg-soft", "surface", 4.5],
      ["muted", "surface", 4.5],
      ["muted", "bg", 4.5],
      ["link", "surface", 4.5],
      ["primary-fg", "primary-bg", 4.5],
      ["nav-fg", "nav-bg", 4.5],
      ["nav-fg-muted", "nav-bg", 4.5],
      ["nav-active-fg", "nav-active-bg", 4.5],
      ["warning-fg", "warning-bg", 4.5],
      ["danger-fg", "danger-bg", 4.5],
      ["plate-fg", "plate-bg", 4.5],
      ["border-strong", "surface", 3],
      ["border-strong", "bg", 3],
      ...statuses.flatMap((s): [string, string, number][] => [
        [`status-${s}-ink`, `status-${s}-bg`, 4.5],
        [`status-${s}-solid`, "surface", 3],
      ]),
    ];
    const failures = Object.entries(themes).flatMap(([name, theme]) =>
      pairs
        .map(([fg, bg, min]) => ({ name, fg, bg, ratio: ratio(resolve(theme, fg), resolve(theme, bg)), min }))
        .filter((pair) => pair.ratio < pair.min),
    );
    expect(failures).toEqual([]);
  });
});
