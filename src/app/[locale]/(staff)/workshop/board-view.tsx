import type { CSSProperties, ReactNode } from "react";
import { BoardMotion } from "../../../../components/board/board-motion";
import { JOB_STATUS_TONE, PlateBadge, REPAIR_ORDER_TONE, StatusChip } from "../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../i18n";
import { formatAed } from "../../../../i18n/format";
import { formatDuration, formatWhen } from "../../../../i18n/time-labels";
import { Money } from "../../../../server/core/money";
import type { RepairOrderStatus } from "../../../../server/db/schema";
import { ASSIGNABLE_JOB_STATUSES } from "../../../../server/workshop/commands";
import type { BoardJob, BoardRepairOrder } from "../../../../server/workshop/queries";

/**
 * The workshop board (US-07.1; redesign reference docs/design/Board.dc.html, UI-R2). Columns by repair order status,
 * every status in words, no prices on cards (AC-07.3). Each card says what happens next: a button only where the
 * board can do it in one step (request QC), otherwise a link to the screen that records it (approval needs a
 * signature, QC its checklist). Work never starts without a recorded approval (AC2-01, enforced in the database):
 * an order awaiting the customer says "do not start". Deliver stays locked, saying why, until payments (I1-10,
 * OD-50).
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

const columnOf = (status: RepairOrderStatus): Column =>
  status === "release_check" ? "qc" : (status as Column);

export interface BoardInvoice {
  number: string;
  /** Only for dashboard.money holders (OD-50); null otherwise. */
  total: string | null;
}

export interface BoardPermissions {
  editEstimate: boolean;
  recordApproval: boolean;
  requestQc: boolean;
  decideQc: boolean;
}

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
}) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  const base = `/${locale}`;
  const statusLabel = (column: Column) => t(locale, `repairOrder.status.${column}` as MessageKey);

  function timeLabel(order: BoardRepairOrder): { text: string; tone: "" | "warn" | "late" } {
    if (order.status === "awaiting_approval" && order.decisionSentAt) {
      return {
        text: t(locale, "board.time.sent", { when: formatWhen(order.decisionSentAt, locale, businessDate) }),
        tone: "warn",
      };
    }
    if (order.promisedAt) {
      const when = formatWhen(order.promisedAt, locale, businessDate);
      return order.promisedAt < now && order.status !== "ready"
        ? { text: t(locale, "board.time.overdue", { when }), tone: "late" }
        : { text: t(locale, "board.time.promised", { when }), tone: "" };
    }
    return {
      text: t(locale, "board.time.onSite", {
        duration: formatDuration(locale, (now.getTime() - order.checkedInAt.getTime()) / 1000),
      }),
      tone: "",
    };
  }

  function nextStep(order: BoardRepairOrder): ReactNode {
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
        const reason = !invoice
          ? t(locale, "board.deliver.noInvoice")
          : invoice.total
            ? t(locale, "board.deliver.balanceDue", {
                amount: `⁨${formatAed(Money.parse(invoice.total), locale)}⁩`,
              })
            : t(locale, "board.deliver.notPaid");
        return (
          <div className="board-deliver">
            {locked(reason)}
            <p className="muted">{t(locale, "board.deliver.why")}</p>
            {link(`/repair-orders/${order.id}`, invoice ? "board.action.openInvoice" : "board.action.open")}
          </div>
        );
      }
    }
  }

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
      <header className="board-hero rise">
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

      <div className="board-scroll">
        <div className="board">
          {BOARD_COLUMNS.map((column, index) => {
            const orders = board.filter((order) => columnOf(order.status) === column);
            const tone = REPAIR_ORDER_TONE[column];
            return (
              <section
                key={column}
                className="board-column rise"
                style={{ animationDelay: `${(0.06 * index).toFixed(2)}s` } as CSSProperties}
                aria-labelledby={`col-${column}`}
              >
                <h2 id={`col-${column}`}>
                  <span
                    className="dot"
                    style={{ background: `var(--status-${tone}-solid)` }}
                    aria-hidden="true"
                  />
                  <span className="column-name">{statusLabel(column)}</span>
                  <span className={`column-count chip-status-${tone}`}>
                    <bdi dir="ltr">{orders.length}</bdi>
                  </span>
                </h2>
                {orders.length === 0 ? <p className="board-empty">{t(locale, "board.emptyColumn")}</p> : null}
                {orders.map((order) => {
                  const time = timeLabel(order);
                  return (
                    <article key={order.id} className="board-card" data-card={order.id}>
                      <div className="board-card-top">
                        {order.plate ? <PlateBadge locale={locale} plate={order.plate} /> : <span />}
                        <span className={`board-time ${time.tone}`}>{time.text}</span>
                      </div>
                      <div className="board-card-title">
                        <strong>
                          <bdi dir="auto">
                            {order.make} {order.model} {order.year}
                          </bdi>
                        </strong>
                        <a href={`${base}/repair-orders/${order.id}`}>
                          <bdi dir="ltr">{order.number}</bdi>
                        </a>
                      </div>
                      {order.status === "awaiting_approval" ? (
                        <p className="board-stop">{t(locale, "board.doNotStart")}</p>
                      ) : null}
                      {order.status === "release_check" ? (
                        <StatusChip status="qc">{t(locale, "repairOrder.status.release_check")}</StatusChip>
                      ) : null}
                      {order.flags.paused ||
                      order.flags.anotherOpen ||
                      (order.flags.awaitingDecision && order.status !== "awaiting_approval") ? (
                        <p className="board-flags">
                          {order.flags.awaitingDecision && order.status !== "awaiting_approval" ? (
                            <StatusChip status="approval">
                              {t(locale, "board.flag.someJobsAwaiting")}
                            </StatusChip>
                          ) : null}
                          {order.flags.paused ? (
                            <StatusChip status="approval">{t(locale, "workshop.flag.paused")}</StatusChip>
                          ) : null}
                          {order.flags.anotherOpen ? (
                            <StatusChip tone="info">{t(locale, "workshop.flag.anotherOpen")}</StatusChip>
                          ) : null}
                        </p>
                      ) : null}
                      {order.jobs.length === 0 ? (
                        <p className="muted board-nojobs">{t(locale, "workshop.noJobs")}</p>
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
                                      {t(locale, "common.listSeparator")}
                                      {t(locale, "workshop.bay")}: <bdi>{job.bay}</bdi>
                                    </>
                                  ) : null}
                                </span>
                              </p>
                              {renderAssign && ASSIGNABLE_JOB_STATUSES.includes(job.status)
                                ? renderAssign(job)
                                : null}
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="board-next">{nextStep(order)}</div>
                    </article>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>
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
