import type { ReactNode } from "react";
import { BoardMotion } from "../../../../components/board/board-motion";
import { JOB_STATUS_TONE, PlateBadge, REPAIR_ORDER_TONE, StatusChip } from "../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../i18n";
import { formatAed } from "../../../../i18n/format";
import { formatDue, formatDuration, formatWhen } from "../../../../i18n/time-labels";
import { Money } from "../../../../server/core/money";
import type { RepairOrderStatus } from "../../../../server/db/schema";
import { ASSIGNABLE_JOB_STATUSES } from "../../../../server/workshop/commands";
import type { BoardAccess, BoardInvoice } from "../../../../server/workshop/board-access";
import type { BoardJob, BoardRepairOrder } from "../../../../server/workshop/queries";
import { BoardColumns, type BoardItem } from "./board-client";

/**
 * The workshop board (US-07.1; UI-R2, second pass UI-R5). Columns by repair order status, every status in words, no
 * prices on cards (AC-07.3). A card is compact — plate, time, car, its jobs in one line each, flags, and the next
 * step — and opens a side panel with the jobs in full, their assignment and links. The next step is a button only
 * where the board can do it in one step (request QC), otherwise a link to the screen that records it (approval
 * needs a signature, QC its checklist). Work never starts without a recorded approval (AC2-01, enforced in the
 * database): an order awaiting the customer says "do not start". Deliver stays locked, saying why, while a balance
 * is due (AC2-27); "Take payment" and "Hand over" open the repair order's payments (I1-10).
 */

export const BOARD_COLUMNS = [
  "checked_in",
  "diagnosing",
  "awaiting_approval",
  "in_progress",
  "qc",
  "ready",
] as const satisfies readonly RepairOrderStatus[];
type Column = (typeof BOARD_COLUMNS)[number];

/** Jobs listed on a card; the rest are counted ("+2 more") and listed in the panel. */
const CARD_JOBS = 3;

const columnOf = (status: RepairOrderStatus): Column =>
  status === "release_check" ? "qc" : (status as Column);

/** Waiting for the owner, not the workshop: never late (T-38). */
const waitingForOwner = (status: RepairOrderStatus) => status === "ready" || status === "release_check";

/**
 * What the board's filters look at (UI-R5). These travel to the browser with the card, so they hold only what the
 * card already shows to every board viewer: number, plate, car, status, jobs and their technicians and bays —
 * never an amount.
 */
export function boardFilterFacts(
  order: BoardRepairOrder,
  now: Date,
  statusWords: string[],
): { haystack: string; technicians: string[]; unassigned: boolean; overdue: boolean } {
  return {
    haystack: [
      order.number,
      order.plate ? `${order.plate.code} ${order.plate.number}` : "",
      order.make,
      order.model,
      String(order.year),
      ...statusWords,
      ...order.jobs.flatMap((job) => [job.title, job.assigneeName ?? "", job.bay ?? ""]),
    ]
      .join(" ")
      .toLowerCase(),
    technicians: [
      ...new Set(order.jobs.map((job) => job.assigneeName).filter((name): name is string => name !== null)),
    ],
    unassigned: order.jobs.some((job) => ASSIGNABLE_JOB_STATUSES.includes(job.status) && !job.assigneeId),
    // As the card shows it: an order awaiting the customer shows when the estimate was sent, never "overdue".
    overdue:
      order.promisedAt !== null &&
      order.promisedAt < now &&
      !waitingForOwner(order.status) &&
      !(order.status === "awaiting_approval" && order.decisionSentAt !== null),
  };
}

export type { BoardInvoice } from "../../../../server/workshop/board-access";
export type BoardPermissions = BoardAccess["can"];

export function BoardView({
  locale,
  board,
  invoices,
  can,
  now,
  businessDate,
  live,
  renderAssign,
  renderRequestQc,
  viewerId = "anonymous",
}: {
  locale: Locale;
  board: BoardRepairOrder[];
  invoices: Map<string, BoardInvoice>;
  can: BoardPermissions;
  now: Date;
  businessDate: string;
  live?: ReactNode;
  renderAssign?: (job: BoardJob) => ReactNode;
  renderRequestQc?: (order: BoardRepairOrder) => ReactNode;
  /** The signed-in user: filters are remembered per person on this browser. */
  viewerId?: string;
}) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  const base = `/${locale}`;
  const separator = t(locale, "common.listSeparator");
  const statusLabel = (column: Column) => t(locale, `repairOrder.status.${column}` as MessageKey);

  function timeLabel(order: BoardRepairOrder): { text: string; tone: "" | "warn" | "late" } {
    if (order.status === "awaiting_approval" && order.decisionSentAt) {
      return {
        text: t(locale, "board.time.sent", { when: formatWhen(order.decisionSentAt, locale, businessDate) }),
        tone: "warn",
      };
    }
    if (order.promisedAt) {
      if (waitingForOwner(order.status)) {
        return {
          text: t(locale, "board.time.promised", {
            when: formatWhen(order.promisedAt, locale, businessDate),
          }),
          tone: "",
        };
      }
      const due = formatDue(order.promisedAt, now, locale, businessDate);
      return { text: due.label, tone: due.overdue ? "late" : "" };
    }
    return {
      text: t(locale, "board.time.onSite", {
        duration: formatDuration(locale, (now.getTime() - order.checkedInAt.getTime()) / 1000),
      }),
      tone: "",
    };
  }

  const link = (path: string, key: MessageKey) => (
    <a className="board-go" href={`${base}${path}`}>
      {t(locale, key)}
    </a>
  );
  const locked = (text: string) => (
    <button type="button" className="board-locked" disabled>
      {text}
    </button>
  );

  function nextStep(order: BoardRepairOrder): ReactNode {
    switch (columnOf(order.status)) {
      case "checked_in":
        return link(`/repair-orders/${order.id}`, "board.action.open");
      case "diagnosing":
        return can.editEstimate
          ? link(`/repair-orders/${order.id}/estimate`, "board.action.estimate")
          : link(`/repair-orders/${order.id}`, "board.action.open");
      case "awaiting_approval":
        // Only while a version awaits the customer (a version where every job was declined is closed, T-22).
        return can.recordApproval && order.decisionSentAt
          ? link(`/repair-orders/${order.id}/estimate/approve`, "board.action.recordApproval")
          : null;
      case "in_progress":
        if (order.qcBlocker) return locked(t(locale, `qc.blocker.${order.qcBlocker}` as MessageKey));
        return can.requestQc && renderRequestQc
          ? renderRequestQc(order)
          : locked(t(locale, "board.action.qcRequestedByWorkshop"));
      case "qc":
        if (order.status === "release_check") return link(`/repair-orders/${order.id}`, "board.action.open");
        return can.decideQc
          ? link(`/repair-orders/${order.id}/qc`, "board.action.recordQc")
          : locked(t(locale, "board.action.waitingQc"));
      case "ready": {
        const invoice = invoices.get(order.id);
        if (invoice?.paid) {
          return can.deliver
            ? link(`/repair-orders/${order.id}#payments`, "board.action.handOver")
            : link(`/repair-orders/${order.id}`, "board.action.open");
        }
        const reason = !invoice
          ? t(locale, "board.deliver.noInvoice")
          : invoice.balance
            ? t(locale, "board.deliver.balanceDue", {
                amount: `⁨${formatAed(Money.parse(invoice.balance), locale)}⁩`,
              })
            : t(locale, "board.deliver.notPaid");
        return (
          <div className="board-deliver">
            {locked(reason)}
            <p className="muted">{t(locale, "board.deliver.why")}</p>
            {invoice && can.takePayment
              ? link(`/repair-orders/${order.id}#payments`, "board.action.takePayment")
              : link(
                  `/repair-orders/${order.id}`,
                  invoice ? "board.action.openInvoice" : "board.action.open",
                )}
          </div>
        );
      }
    }
  }

  function flagsOf(order: BoardRepairOrder): ReactNode {
    const someWaiting = order.flags.awaitingDecision && order.status !== "awaiting_approval";
    if (!order.flags.paused && !order.flags.anotherOpen && !someWaiting) return null;
    return (
      <p className="board-flags">
        {someWaiting ? (
          <StatusChip status="approval">{t(locale, "board.flag.someJobsAwaiting")}</StatusChip>
        ) : null}
        {order.flags.paused ? (
          <StatusChip status="approval">{t(locale, "workshop.flag.paused")}</StatusChip>
        ) : null}
        {order.flags.anotherOpen ? (
          <StatusChip tone="info">{t(locale, "workshop.flag.anotherOpen")}</StatusChip>
        ) : null}
      </p>
    );
  }

  function card(order: BoardRepairOrder): ReactNode {
    const time = timeLabel(order);
    const shown = order.jobs.slice(0, CARD_JOBS);
    return (
      <>
        <div className="board-card-top">
          {order.plate ? <PlateBadge locale={locale} plate={order.plate} /> : <span />}
          <span className={`board-time ${time.tone}`}>{time.text}</span>
        </div>
        <p className="board-card-title">
          <strong>
            <bdi dir="auto">
              {order.make} {order.model} {order.year}
            </bdi>
          </strong>
          <span className="board-card-number">
            <bdi dir="ltr">{order.number}</bdi>
          </span>
        </p>
        {order.status === "awaiting_approval" ? (
          <p className="board-stop">{t(locale, "board.doNotStart")}</p>
        ) : null}
        {order.status === "release_check" ? (
          <StatusChip status="qc">{t(locale, "repairOrder.status.release_check")}</StatusChip>
        ) : null}
        {flagsOf(order)}
        {order.jobs.length === 0 ? (
          <p className="muted board-nojobs">{t(locale, "workshop.noJobs")}</p>
        ) : (
          <ul className="board-card-jobs">
            {shown.map((job) => (
              <li key={job.id}>
                <span className="board-card-job" dir="auto">
                  {job.title}
                </span>
                <StatusChip status={JOB_STATUS_TONE[job.status]}>
                  {t(locale, `job.status.${job.status}` as MessageKey)}
                </StatusChip>
                <span
                  className={job.assigneeName ? "avatar avatar-xs" : "avatar avatar-xs avatar-none"}
                  title={job.assigneeName ?? t(locale, "workshop.unassigned")}
                  aria-hidden="true"
                >
                  {initialsOf(job.assigneeName)}
                </span>
                <span className="visually-hidden">
                  {job.assigneeName ?? t(locale, "workshop.unassigned")}
                </span>
              </li>
            ))}
            {order.jobs.length > CARD_JOBS ? (
              <li className="muted board-card-more">
                {t(locale, "board.moreJobs", { n: String(order.jobs.length - CARD_JOBS) })}
              </li>
            ) : null}
          </ul>
        )}
        <div className="board-next">{nextStep(order)}</div>
      </>
    );
  }

  function panel(order: BoardRepairOrder): ReactNode {
    const time = timeLabel(order);
    const column = columnOf(order.status);
    return (
      <>
        <header className="board-panel-head">
          {order.plate ? <PlateBadge locale={locale} plate={order.plate} /> : null}
          <h2>
            <bdi dir="auto">
              {order.make} {order.model} {order.year}
            </bdi>
          </h2>
          <p className="board-panel-meta">
            <a href={`${base}/repair-orders/${order.id}`}>
              <bdi dir="ltr">{order.number}</bdi>
            </a>
            <StatusChip status={REPAIR_ORDER_TONE[column]}>
              {t(locale, `repairOrder.status.${order.status}` as MessageKey)}
            </StatusChip>
            <span className={`board-time ${time.tone}`}>{time.text}</span>
          </p>
        </header>
        <section className="board-panel-section" aria-label={t(locale, "board.panel.jobs")}>
          <h3>{t(locale, "board.panel.jobs")}</h3>
          {order.jobs.length === 0 ? (
            <p className="muted">{t(locale, "workshop.noJobs")}</p>
          ) : (
            <ul className="board-jobs">
              {order.jobs.map((job) => (
                <li key={job.id} className="board-job" data-job={job.id}>
                  <div className="board-job-head">
                    <a href={`${base}/jobs/${job.id}`} dir="auto">
                      {job.title}
                    </a>
                    <StatusChip status={JOB_STATUS_TONE[job.status]}>
                      {t(locale, `job.status.${job.status}` as MessageKey)}
                    </StatusChip>
                  </div>
                  <p className="board-job-who">
                    <span className="avatar avatar-sm" aria-hidden="true">
                      {initialsOf(job.assigneeName)}
                    </span>
                    <span>
                      <bdi>{job.assigneeName ?? t(locale, "workshop.unassigned")}</bdi>
                      {job.bay ? (
                        <>
                          {separator}
                          {t(locale, "workshop.bay")}: <bdi>{job.bay}</bdi>
                        </>
                      ) : null}
                    </span>
                  </p>
                  {renderAssign && ASSIGNABLE_JOB_STATUSES.includes(job.status) ? renderAssign(job) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
        <nav className="board-panel-links" aria-label={t(locale, "board.panel.links")}>
          <a className="btn btn-primary" href={`${base}/repair-orders/${order.id}`}>
            {t(locale, "board.action.open")}
          </a>
          {can.editEstimate &&
          (column === "diagnosing" || column === "awaiting_approval" || column === "in_progress") ? (
            <a className="btn btn-secondary" href={`${base}/repair-orders/${order.id}/estimate`}>
              {t(locale, "board.panel.estimate")}
            </a>
          ) : null}
        </nav>
      </>
    );
  }

  const items: BoardItem[] = board.map((order) => ({
    id: order.id,
    column: columnOf(order.status),
    ...boardFilterFacts(order, now, [
      statusLabel(columnOf(order.status)),
      t(locale, `repairOrder.status.${order.status}` as MessageKey),
    ]),
    title: `${order.make} ${order.model} ${order.year} ${order.number}`,
    card: card(order),
    panel: panel(order),
  }));
  const technicians = [...new Set(items.flatMap((item) => item.technicians))].sort((a, b) =>
    a.localeCompare(b, locale),
  );

  const motionCards = board.map((order) => ({
    id: order.id,
    status: columnOf(order.status),
    moved: t(locale, "board.toast.moved", {
      number: order.number,
      status: statusLabel(columnOf(order.status)),
    }),
    added: t(locale, "board.toast.added", { number: order.number }),
  }));

  return (
    <div className="board-page wide">
      <header className="board-hero">
        <a className="board-back" href={base}>
          {t(locale, "board.back")}
        </a>
        <div className="titles">
          <h1>{t(locale, "workshop.title")}</h1>
          <span className="other-language" lang={other} dir={other === "ar" ? "rtl" : "ltr"}>
            {t(other, "workshop.title")}
          </span>
        </div>
        <div className="board-hero-chips">
          <span className="hero-chip">{t(locale, "board.inWorkshop", { n: String(board.length) })}</span>
          {live}
        </div>
      </header>

      <BoardColumns
        columns={BOARD_COLUMNS.map((column) => ({
          key: column,
          label: statusLabel(column),
          tone: REPAIR_ORDER_TONE[column],
        }))}
        items={items}
        technicians={technicians}
        storageKey={`garage.board.filters.${viewerId}`}
        labels={{
          group: t(locale, "board.filter.group"),
          search: t(locale, "board.filter.search"),
          technician: t(locale, "board.filter.technician"),
          allTechnicians: t(locale, "board.filter.allTechnicians"),
          unassigned: t(locale, "board.filter.unassigned"),
          overdue: t(locale, "board.filter.overdue"),
          clear: t(locale, "board.filter.clear"),
          showing: t(locale, "board.filter.showing"),
          empty: t(locale, "board.emptyColumn"),
          noMatch: t(locale, "board.filter.noMatch"),
          details: t(locale, "board.details"),
          close: t(locale, "board.panel.close"),
        }}
      />
      <BoardMotion cards={motionCards} more={t(locale, "board.toast.more")} />
    </div>
  );
}

function initialsOf(name: string | null): string {
  if (!name) return "—";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
}
