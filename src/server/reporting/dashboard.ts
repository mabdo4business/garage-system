import { sql, type Kysely } from "kysely";
import { hasPermission } from "../auth/permissions";
import { balancesFor } from "../billing/payments";
import { Money } from "../core/money";
import type { DB, Emirate, JobExecutionStatus, RepairOrderStatus } from "../db/schema";
import { bookedSecondsOf, workedSeconds } from "../workshop/queries";

/**
 * The workshop dashboard (redesign, OD-50): read-only figures from the live tables, never sample data. Money
 * (revenue and amounts) is included only when the caller asks for it, and the page asks only for holders of
 * `dashboard.money`. Revenue is invoiced totals including VAT by business date; payments arrive with I1-10.
 * Nothing here returns customer contact details or costs.
 */

/** Board order of open repair orders; release_check is counted with quality check. */
export const DASHBOARD_STATUSES = [
  "checked_in",
  "diagnosing",
  "awaiting_approval",
  "in_progress",
  "qc",
  "ready",
] as const satisfies readonly RepairOrderStatus[];
export type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];

const OPEN: RepairOrderStatus[] = [...DASHBOARD_STATUSES, "release_check"];
const ACTIVE_JOB: JobExecutionStatus[] = ["in_progress", "paused", "waiting_parts"];

type Plate = { emirate: Emirate; code: string; number: string } | null;

export interface BayRow {
  jobId: string;
  bay: string | null;
  assigneeName: string | null;
  title: string;
  vehicle: string;
  repairOrderNumber: string;
  status: JobExecutionStatus;
  /** Seconds spent In progress so far (from the job's status history). */
  workedSeconds: number;
  /** Approved labour hours on the job, in seconds; null when the job has no labour line. */
  bookedSeconds: number | null;
  reason: string | null;
}

/**
 * Something a person should act on. `since` is when it started waiting, where the tables record it (estimate sent,
 * job paused or put on waiting parts); the list is ordered most urgent first (UI-R4): the customer's decision blocks
 * work, then money released or due, then stalled jobs; oldest first within a kind.
 */
export type Attention =
  | { kind: "awaiting_decision"; repairOrderId: string; number: string; since: Date | null }
  | {
      kind: "paused";
      jobId: string;
      number: string;
      title: string;
      reason: string | null;
      since: Date | null;
    }
  | { kind: "waiting_parts"; jobId: string; number: string; title: string; since: Date | null }
  | {
      kind: "ready_unpaid";
      since: null;
      repairOrderId: string;
      number: string;
      invoiceNumber: string | null;
      /** Balance due (invoice total − payments, I1-10); money callers only. */
      balance: string | null;
    }
  | {
      /** AC2-27: handed over with a balance by a partner's release override, not yet paid. */
      kind: "released_unpaid";
      since: null;
      repairOrderId: string;
      number: string;
      /** Money callers only. */
      balance: string | null;
    };

export interface OrderRow {
  id: string;
  number: string;
  status: DashboardStatus;
  plate: Plate;
  vehicle: string;
  services: string[];
  technicians: string[];
  promisedAt: Date | null;
  /** Past its promised time and not waiting for its owner (Ready, release check; T-38). */
  overdue: boolean;
  /** Invoice total once issued, otherwise the approved amount; null without money or before any approval. */
  amount: string | null;
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface DailyAmount {
  date: string;
  total: string;
}

export interface DashboardSummary {
  businessDate: string;
  /** The instant the figures were read; relative times ("overdue by 2 h") are measured from it. */
  generatedAt: Date;
  statusCounts: { status: DashboardStatus; count: number; overdue: number }[];
  carsIn: number;
  /** Check-ins per business day, oldest first, the last seven days including today. */
  checkInsByDay: DailyCount[];
  awaitingApproval: number;
  oldestAwaitingSince: Date | null;
  ready: number;
  readyInvoiced: number;
  money: {
    revenueByDay: DailyAmount[];
    today: string;
    week: string;
    invoicesToday: number;
  } | null;
  bays: BayRow[];
  attention: Attention[];
  orders: OrderRow[];
}

/** T-38: the customer's decision blocks work, then money, then stalled jobs. */
const URGENCY: Attention["kind"][] = [
  "awaiting_decision",
  "released_unpaid",
  "ready_unpaid",
  "paused",
  "waiting_parts",
];

/** Most urgent kind first; within a kind, longest waiting first (items without a start time last). In place. */
export function sortAttention(items: Attention[]): Attention[] {
  return items.sort(
    (a, b) =>
      URGENCY.indexOf(a.kind) - URGENCY.indexOf(b.kind) ||
      (a.since?.getTime() ?? Infinity) - (b.since?.getTime() ?? Infinity),
  );
}

/** Waiting for the owner, not the workshop: never overdue (T-38). */
const WAITING_FOR_OWNER: RepairOrderStatus[] = ["ready", "release_check"];

const asDashboardStatus = (status: RepairOrderStatus): DashboardStatus =>
  status === "release_check" ? "qc" : (status as DashboardStatus);

export type DashboardMode = "dashboard" | "my_jobs" | "shortcuts";

/**
 * What Today shows (OD-50): the dashboard for dashboard.read holders (money only with dashboard.money), My jobs for
 * other assignees (technicians), the shortcuts page for everyone else.
 */
export function dashboardModeFor(roles: readonly string[]): { mode: DashboardMode; money: boolean } {
  if (hasPermission(roles, "dashboard.read")) {
    return { mode: "dashboard", money: hasPermission(roles, "dashboard.money") };
  }
  return { mode: hasPermission(roles, "workshop.my_jobs") ? "my_jobs" : "shortcuts", money: false };
}

export async function dashboardSummary(
  db: Kysely<DB>,
  options: { money: boolean; now?: Date },
): Promise<DashboardSummary> {
  const now = options.now ?? new Date();
  const days = await sql<{ d: string }>`
    SELECT to_char(day, 'YYYY-MM-DD') AS d
    FROM generate_series(business_date_of(${now}) - 6, business_date_of(${now}), interval '1 day') AS day
    ORDER BY day`.execute(db);
  const dates = days.rows.map((row) => row.d);
  const businessDate = dates[dates.length - 1]!;

  const orders = await db
    .selectFrom("repair_order")
    .innerJoin("vehicle", "vehicle.id", "repair_order.vehicle_id")
    .leftJoin("vehicle_plate", (join) =>
      join.onRef("vehicle_plate.vehicle_id", "=", "vehicle.id").on("vehicle_plate.valid_to", "is", null),
    )
    .select([
      "repair_order.id",
      "repair_order.number",
      "repair_order.status",
      "repair_order.promised_at",
      "vehicle.make",
      "vehicle.model",
      "vehicle.year",
      "vehicle_plate.emirate",
      "vehicle_plate.code",
      "vehicle_plate.number as plate_number",
    ])
    .where("repair_order.status", "in", OPEN)
    .orderBy("repair_order.checked_in_at")
    .execute();
  const ids = orders.map((order) => order.id);

  const checkIns = await db
    .selectFrom("repair_order")
    .select(["business_date", (eb) => eb.fn.countAll<string>().as("n")])
    .where("business_date", ">=", dates[0]!)
    .groupBy("business_date")
    .execute();
  const checkInsOn = new Map(checkIns.map((row) => [String(row.business_date), Number(row.n)]));

  const jobs = ids.length
    ? await db
        .selectFrom("repair_job")
        .leftJoin("job_assignment", (join) =>
          join.onRef("job_assignment.job_id", "=", "repair_job.id").on("job_assignment.ended_at", "is", null),
        )
        .leftJoin("app_user", "app_user.id", "job_assignment.assignee_id")
        .select([
          "repair_job.id",
          "repair_job.repair_order_id",
          "repair_job.title",
          "repair_job.execution_status",
          "repair_job.execution_reason",
          "job_assignment.bay",
          "app_user.display_name",
        ])
        .where("repair_job.repair_order_id", "in", ids)
        .where("repair_job.removed_at", "is", null)
        .orderBy("repair_job.created_at")
        .execute()
    : [];
  const jobIds = jobs.map((job) => job.id);

  // Authorized scope per job (as estimate/approval.authorizedScope): lines of approved revisions not superseded.
  const approvedLines = jobIds.length
    ? await db
        .selectFrom("revision_line")
        .innerJoin("job_revision", "job_revision.id", "revision_line.revision_id")
        .select([
          "revision_line.id",
          "revision_line.supersedes_line_id",
          "revision_line.unit",
          "revision_line.qty",
          "revision_line.line_total",
          "job_revision.job_id",
        ])
        .where("job_revision.job_id", "in", jobIds)
        .where("job_revision.status", "=", "approved")
        .where("revision_line.removed_at", "is", null)
        .execute()
    : [];
  const superseded = new Set(
    approvedLines.map((line) => line.supersedes_line_id).filter((id) => id !== null),
  );
  const authorized = approvedLines.filter((line) => !superseded.has(line.id));

  const activeJobIds = jobs.filter((job) => ACTIVE_JOB.includes(job.execution_status)).map((job) => job.id);
  const events = activeJobIds.length
    ? await db
        .selectFrom("job_status_event")
        .select(["job_id", "to_status", "occurred_at"])
        .where("job_id", "in", activeJobIds)
        .orderBy("occurred_at")
        .orderBy("id")
        .execute()
    : [];

  const sent = ids.length
    ? await db
        .selectFrom("estimate_version")
        .innerJoin("estimate", "estimate.id", "estimate_version.estimate_id")
        .select(["estimate.repair_order_id", "estimate_version.sent_at"])
        .where("estimate.repair_order_id", "in", ids)
        .where("estimate_version.status", "=", "sent")
        // Past its expiry the customer can no longer decide (I2-01), as on the board.
        .where("estimate_version.expires_at", ">", sql<Date>`now()`)
        .execute()
    : [];
  const sentAt = new Map(sent.map((row) => [row.repair_order_id, row.sent_at]));

  const invoices = ids.length
    ? await db
        .selectFrom("invoice")
        .select(["repair_order_id", "number", "total"])
        .where("repair_order_id", "in", ids)
        .execute()
    : [];
  const invoiceOf = new Map(invoices.map((row) => [row.repair_order_id, row]));

  const byOrder = (orderId: string) => jobs.filter((job) => job.repair_order_id === orderId);
  const numberOf = new Map(orders.map((order) => [order.id, order.number]));
  const vehicleOf = new Map(orders.map((order) => [order.id, `${order.make} ${order.model} ${order.year}`]));

  const bays: BayRow[] = jobs
    .filter((job) => ACTIVE_JOB.includes(job.execution_status))
    .map((job) => {
      return {
        jobId: job.id,
        bay: job.bay,
        assigneeName: job.display_name,
        title: job.title,
        vehicle: vehicleOf.get(job.repair_order_id) ?? "",
        repairOrderNumber: numberOf.get(job.repair_order_id) ?? "",
        status: job.execution_status,
        workedSeconds: workedSeconds(
          events
            .filter((event) => event.job_id === job.id)
            .map((event) => ({ to: event.to_status, at: event.occurred_at })),
          now,
        ),
        bookedSeconds: bookedSecondsOf(authorized.filter((line) => line.job_id === job.id)),
        reason: job.execution_status === "paused" ? job.execution_reason : null,
      };
    })
    .sort((a, b) => (a.bay ?? "￿").localeCompare(b.bay ?? "￿", "en", { numeric: true }));

  /** When a job entered its current status (its latest status event). */
  const enteredAt = (jobId: string): Date | null =>
    events.filter((event) => event.job_id === jobId).at(-1)?.occurred_at ?? null;

  const attention: Attention[] = [];
  // Only orders still Awaiting approval: under T-22 a partly decided version stays "sent" while approved jobs run.
  const awaitingOrders = orders.filter(
    (order) => order.status === "awaiting_approval" && sentAt.has(order.id),
  );
  for (const order of awaitingOrders) {
    attention.push({
      kind: "awaiting_decision",
      repairOrderId: order.id,
      number: order.number,
      since: sentAt.get(order.id) ?? null,
    });
  }
  for (const job of jobs) {
    if (job.execution_status === "paused") {
      attention.push({
        kind: "paused",
        jobId: job.id,
        number: numberOf.get(job.repair_order_id) ?? "",
        title: job.title,
        reason: job.execution_reason,
        since: enteredAt(job.id),
      });
    } else if (job.execution_status === "waiting_parts") {
      attention.push({
        kind: "waiting_parts",
        jobId: job.id,
        number: numberOf.get(job.repair_order_id) ?? "",
        title: job.title,
        since: enteredAt(job.id),
      });
    }
  }
  // Ready and not fully paid (I1-10: the real balance); a paid Ready car only waits for its owner.
  const readyOrders = orders.filter((row) => row.status === "ready");
  const balances = await balancesFor(
    db,
    readyOrders.map((order) => order.id),
  );
  for (const order of readyOrders) {
    const invoice = invoiceOf.get(order.id);
    const balance = balances.get(order.id);
    if (balance !== undefined && Money.parse(balance).isZero()) continue;
    attention.push({
      kind: "ready_unpaid",
      since: null,
      repairOrderId: order.id,
      number: order.number,
      invoiceNumber: invoice?.number ?? null,
      balance: options.money && balance !== undefined ? balance : null,
    });
  }
  // A delivered order is still open only while a balance is due (delivery at balance 0 closes it, B1). Shown to
  // partners and the manager (T-36), who would otherwise get the release alert.
  const released = !options.money
    ? []
    : await db
        .selectFrom("repair_order")
        .select(["id", "number"])
        .where("status", "=", "delivered")
        .orderBy("number")
        .execute();
  const releasedBalances = await balancesFor(
    db,
    released.map((order) => order.id),
  );
  for (const order of released) {
    attention.push({
      kind: "released_unpaid",
      since: null,
      repairOrderId: order.id,
      number: order.number,
      balance: releasedBalances.get(order.id) ?? null,
    });
  }

  sortAttention(attention);

  const rows: OrderRow[] = orders.map((order) => {
    const own = byOrder(order.id);
    const invoice = invoiceOf.get(order.id);
    const ownIds = new Set(own.map((job) => job.id));
    const approved = authorized.filter((line) => ownIds.has(line.job_id));
    const amount = !options.money
      ? null
      : invoice
        ? Money.parse(invoice.total).toString()
        : approved.length
          ? approved.reduce((sum, line) => sum.add(Money.parse(line.line_total)), Money.ZERO).toString()
          : null;
    return {
      id: order.id,
      number: order.number,
      status: asDashboardStatus(order.status),
      plate:
        order.emirate && order.code !== null && order.plate_number !== null
          ? { emirate: order.emirate, code: order.code, number: order.plate_number }
          : null,
      vehicle: `${order.make} ${order.model} ${order.year}`,
      services: own.map((job) => job.title),
      technicians: [...new Set(own.map((job) => job.display_name).filter((name) => name !== null))],
      promisedAt: order.promised_at,
      overdue:
        order.promised_at !== null &&
        order.promised_at.getTime() < now.getTime() &&
        !WAITING_FOR_OWNER.includes(order.status),
      amount,
    };
  });

  const statusCounts = DASHBOARD_STATUSES.map((status) => ({
    status,
    count: rows.filter((row) => row.status === status).length,
    overdue: rows.filter((row) => row.status === status && row.overdue).length,
  }));
  const awaitingSince = awaitingOrders
    .map((order) => sentAt.get(order.id) ?? null)
    .filter((at): at is Date => at !== null);

  let money: DashboardSummary["money"] = null;
  if (options.money) {
    const revenue = await db
      .selectFrom("invoice")
      .select([
        "business_date",
        sql<string>`sum(total)::text`.as("total"),
        (eb) => eb.fn.countAll<string>().as("n"),
      ])
      .where("business_date", ">=", dates[0]!)
      .groupBy("business_date")
      .execute();
    const on = new Map(revenue.map((row) => [String(row.business_date), row]));
    const revenueByDay = dates.map((date) => ({
      date,
      total: Money.parse(on.get(date)?.total ?? "0").toString(),
    }));
    money = {
      revenueByDay,
      today: revenueByDay[revenueByDay.length - 1]!.total,
      week: revenueByDay.reduce((sum, day) => sum.add(Money.parse(day.total)), Money.ZERO).toString(),
      invoicesToday: Number(on.get(businessDate)?.n ?? 0),
    };
  }

  return {
    businessDate,
    generatedAt: now,
    statusCounts,
    carsIn: rows.length,
    checkInsByDay: dates.map((date) => ({ date, count: checkInsOn.get(date) ?? 0 })),
    awaitingApproval: rows.filter((row) => row.status === "awaiting_approval").length,
    oldestAwaitingSince: awaitingSince.length
      ? new Date(Math.min(...awaitingSince.map((at) => at.getTime())))
      : null,
    ready: rows.filter((row) => row.status === "ready").length,
    readyInvoiced: rows.filter((row) => row.status === "ready" && invoiceOf.has(row.id)).length,
    money,
    bays,
    attention,
    orders: rows,
  };
}
