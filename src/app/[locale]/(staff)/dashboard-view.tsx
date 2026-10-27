import type { CSSProperties, ReactNode } from "react";
import { BarChart, ProgressBar } from "../../../components/dashboard/charts";
import { CountUp, CountUpMoney } from "../../../components/dashboard/motion";
import { JOB_STATUS_TONE, PlateBadge, REPAIR_ORDER_TONE, StatusChip } from "../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../i18n";
import { formatDue, formatDuration, formatWhen } from "../../../i18n/time-labels";
import { formatAed, formatAmountCompact, formatBusinessDay } from "../../../i18n/format";
import { Money } from "../../../server/core/money";
import type {
  Attention,
  BayRow,
  DashboardStatus,
  DashboardSummary,
} from "../../../server/reporting/dashboard";
import { OrdersPanel, type OrderItem } from "./orders-panel";

/**
 * Today, the workshop dashboard (UI-R4; data and permissions as OD-50). One screen answers three questions in
 * order: where are the cars (the workshop flow strip), what needs someone now (Needs attention, most urgent first),
 * and who is working on what (bays). The repair orders list below filters by stage, overdue and search. Money
 * appears only when `summary.money` is set, which the page does for `dashboard.money` holders only.
 */

const ATTENTION_FIRST = 5;

function initials(name: string | null): string {
  if (!name) return "—";
  return Array.from(
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join(""),
  )
    .join("")
    .toUpperCase();
}

const aed = (amount: string, locale: Locale) => <bdi dir="ltr">{formatAed(Money.parse(amount), locale)}</bdi>;
/** An amount inside a sentence, isolated left-to-right (FSI … PDI). */
const inlineAed = (amount: string, locale: Locale) => `⁨${formatAed(Money.parse(amount), locale)}⁩`;

// --------------------------------------------------------------------------- workshop flow

function FlowStrip({
  summary,
  locale,
  stage,
}: {
  summary: DashboardSummary;
  locale: Locale;
  stage: DashboardStatus | null;
}) {
  const total = summary.carsIn;
  return (
    <section className="flow" aria-labelledby="flow-title">
      <div className="flow-head">
        <h2 id="flow-title">{t(locale, "dashboard.flow.title")}</h2>
        <p className="flow-total">
          <span className="flow-total-figure">
            <CountUp value={total} />
          </span>{" "}
          {t(locale, "dashboard.carsIn")}
        </p>
      </div>
      {/* The proportion of cars at each stage; the stages below carry the words and counts. */}
      <div className="flow-track" aria-hidden="true">
        {summary.statusCounts
          .filter(({ count }) => count > 0)
          .map(({ status, count }) => (
            <span
              key={status}
              className="flow-track-part"
              style={
                {
                  flexGrow: count,
                  background: `var(--status-${REPAIR_ORDER_TONE[status]}-solid)`,
                } as CSSProperties
              }
            />
          ))}
      </div>
      <ol className="flow-stages">
        {summary.statusCounts.map(({ status, count, overdue }) => (
          <li key={status}>
            <a
              href={`/${locale}?stage=${status}#orders`}
              className="flow-stage"
              data-empty={count === 0 ? "true" : undefined}
              aria-current={stage === status ? "true" : undefined}
              style={{ "--stage": `var(--status-${REPAIR_ORDER_TONE[status]}-solid)` } as CSSProperties}
            >
              <span className="flow-stage-name">
                {t(locale, `repairOrder.status.${status}` as MessageKey)}
              </span>
              <span className="flow-stage-count">{count}</span>
              <span className={overdue > 0 ? "flow-stage-note is-late" : "flow-stage-note"}>
                {overdue > 0
                  ? t(locale, "dashboard.flow.overdue", { n: String(overdue) })
                  : count === 0
                    ? t(locale, "dashboard.flow.none")
                    : status === "ready"
                      ? t(locale, "dashboard.flow.toHandOver")
                      : t(locale, "dashboard.flow.onTime")}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --------------------------------------------------------------------------- revenue (money holders only)

function RevenueCard({ summary, locale }: { summary: DashboardSummary; locale: Locale }) {
  const money = summary.money!;
  const max = money.revenueByDay.reduce((m, day) => {
    const fils = Money.parse(day.total).fils;
    return fils > m ? fils : m;
  }, 0n);
  const dayLabel = (date: string) =>
    date === summary.businessDate ? t(locale, "dashboard.today") : formatBusinessDay(date, locale, "short");
  return (
    <section className="revenue" aria-labelledby="revenue-title">
      <h2 id="revenue-title">{t(locale, "dashboard.revenue.today")}</h2>
      <p className="revenue-figure">
        <CountUpMoney amount={money.today} locale={locale} />
      </p>
      <p className="muted revenue-note">
        {t(locale, "dashboard.kpi.invoicesToday", { n: String(money.invoicesToday) })}
      </p>
      <div className="revenue-week">
        <span>{t(locale, "dashboard.revenue.week")}</span>
        <strong>{aed(money.week, locale)}</strong>
      </div>
      <BarChart
        label={t(locale, "dashboard.revenue.title")}
        bars={money.revenueByDay.map((day) => {
          const fils = Money.parse(day.total).fils;
          return {
            key: day.date,
            label: dayLabel(day.date),
            value: fils === 0n ? "" : formatAmountCompact(Money.parse(day.total), locale),
            exact: formatAed(Money.parse(day.total), locale),
            // Display share only (bar height), not an amount.
            ratio: max > 0n ? Number((fils * 1000n) / max) / 1000 : 0,
            highlight: day.date === summary.businessDate,
          };
        })}
      />
    </section>
  );
}

// --------------------------------------------------------------------------- needs attention

function attentionParts(item: Attention, locale: Locale, businessDate: string) {
  const base = `/${locale}`;
  switch (item.kind) {
    case "awaiting_decision":
      return {
        tone: "approval",
        word: t(locale, "dashboard.attention.awaitingDecision"),
        title: t(locale, "dashboard.attention.doNotStart", { number: item.number }),
        detail: item.since
          ? t(locale, "dashboard.attention.sentAt", { time: formatWhen(item.since, locale, businessDate) })
          : null,
        href: `${base}/repair-orders/${item.repairOrderId}`,
      };
    case "paused":
      return {
        tone: "approval",
        word: t(locale, "dashboard.attention.paused"),
        title: item.title,
        detail: [item.number, item.reason].filter(Boolean).join(t(locale, "common.listSeparator")),
        href: `${base}/jobs/${item.jobId}`,
      };
    case "waiting_parts":
      return {
        tone: "parts",
        word: t(locale, "dashboard.attention.waitingParts"),
        title: item.title,
        detail: item.number,
        href: `${base}/jobs/${item.jobId}`,
      };
    case "ready_unpaid":
    case "released_unpaid":
      return {
        tone: item.kind === "ready_unpaid" ? "ready" : "danger",
        word: t(
          locale,
          item.kind === "ready_unpaid"
            ? "dashboard.attention.readyUnpaid"
            : "dashboard.attention.releasedUnpaid",
        ),
        title: item.balance
          ? t(locale, "dashboard.attention.balanceDue", { amount: inlineAed(item.balance, locale) })
          : t(locale, "dashboard.attention.notPaid"),
        detail: [item.number, item.kind === "ready_unpaid" ? item.invoiceNumber : null]
          .filter(Boolean)
          .join(t(locale, "common.listSeparator")),
        href: `${base}/repair-orders/${item.repairOrderId}`,
      };
  }
}

function AttentionRow({
  item,
  summary,
  locale,
}: {
  item: Attention;
  summary: DashboardSummary;
  locale: Locale;
}) {
  const parts = attentionParts(item, locale, summary.businessDate);
  const waited = item.since ? (summary.generatedAt.getTime() - item.since.getTime()) / 1000 : null;
  return (
    <li className={`attention-row tone-${parts.tone}`}>
      <span className="attention-word">{parts.word}</span>
      <span className="attention-text">
        <strong>
          <bdi>{parts.title}</bdi>
        </strong>
        {parts.detail ? (
          <span className="muted">
            <bdi>{parts.detail}</bdi>
          </span>
        ) : null}
      </span>
      {waited !== null ? (
        <span className="attention-age">
          {t(locale, "dashboard.attention.for", { time: formatDuration(locale, waited) })}
        </span>
      ) : (
        <span className="attention-age" />
      )}
      <a className="btn btn-secondary attention-open" href={parts.href}>
        {t(locale, "dashboard.open")}
        <span className="visually-hidden">
          {" "}
          {parts.word} {parts.title}
        </span>
      </a>
    </li>
  );
}

function AttentionPanel({ summary, locale }: { summary: DashboardSummary; locale: Locale }) {
  const items = summary.attention;
  const first = items.slice(0, ATTENTION_FIRST);
  const rest = items.slice(ATTENTION_FIRST);
  return (
    <section className="panel attention-panel" aria-labelledby="attention-title">
      <div className="panel-head">
        <h2 id="attention-title">{t(locale, "dashboard.attention.title")}</h2>
        {items.length > 0 ? (
          <span className="count-badge">
            {t(locale, "dashboard.attention.open", { n: String(items.length) })}
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="muted">{t(locale, "dashboard.attention.empty")}</p>
      ) : (
        <>
          <ul className="attention-rows">
            {first.map((item, i) => (
              <AttentionRow key={`${item.kind}-${i}`} item={item} summary={summary} locale={locale} />
            ))}
          </ul>
          {rest.length > 0 ? (
            <details className="attention-more">
              <summary>{t(locale, "dashboard.attention.showMore", { n: String(rest.length) })}</summary>
              <ul className="attention-rows">
                {rest.map((item, i) => (
                  <AttentionRow
                    key={`${item.kind}-more-${i}`}
                    item={item}
                    summary={summary}
                    locale={locale}
                  />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------- bays

function BayJob({ job, locale, delay }: { job: BayRow; locale: Locale; delay: number }) {
  const tone = JOB_STATUS_TONE[job.status];
  const over = job.bookedSeconds !== null && job.workedSeconds > job.bookedSeconds;
  return (
    <li className="bay-job-row">
      <span className="avatar" aria-hidden="true">
        {initials(job.assigneeName)}
      </span>
      <span className="bay-job-main">
        <a href={`/${locale}/jobs/${job.jobId}`}>
          <strong dir="auto">{job.title}</strong>
        </a>
        <span className="muted">
          <bdi>{job.assigneeName ?? t(locale, "workshop.unassigned")}</bdi>
          {t(locale, "common.listSeparator")}
          <bdi dir="auto">{job.vehicle}</bdi>
        </span>
        <span className="bay-job-status">
          <StatusChip status={tone}>{t(locale, `job.status.${job.status}` as MessageKey)}</StatusChip>
          <span className={over ? "bay-time is-over" : "bay-time"}>
            {job.bookedSeconds
              ? t(locale, "dashboard.bays.workedOf", {
                  worked: formatDuration(locale, job.workedSeconds),
                  booked: formatDuration(locale, job.bookedSeconds),
                })
              : t(locale, "dashboard.bays.worked", { worked: formatDuration(locale, job.workedSeconds) })}
          </span>
        </span>
        <ProgressBar
          tone={over ? "approval" : tone}
          share={job.bookedSeconds ? job.workedSeconds / job.bookedSeconds : 0}
          delay={delay}
        />
        {job.reason ? (
          <span className="muted bay-reason" dir="auto">
            {job.reason}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function BaysPanel({ summary, locale }: { summary: DashboardSummary; locale: Locale }) {
  // One tile per bay, jobs grouped; jobs without a bay last.
  const groups = new Map<string | null, BayRow[]>();
  for (const job of summary.bays) groups.set(job.bay, [...(groups.get(job.bay) ?? []), job]);
  const tiles = [...groups.entries()].sort(([a], [b]) =>
    a === null ? 1 : b === null ? -1 : a.localeCompare(b, "en", { numeric: true }),
  );
  let index = 0;
  return (
    <section className="panel bays-panel" aria-labelledby="bays-title">
      <div className="panel-head">
        <h2 id="bays-title">{t(locale, "dashboard.bays.title")}</h2>
        <span className="panel-meta">
          {t(locale, "dashboard.bays.active", { n: String(summary.bays.length) })}
        </span>
      </div>
      {tiles.length === 0 ? (
        <p className="muted">{t(locale, "dashboard.bays.empty")}</p>
      ) : (
        <div className="bay-tiles">
          {tiles.map(([bay, jobs]) => (
            <article key={bay ?? "none"} className="bay-tile">
              <h3>{bay ? t(locale, "dashboard.bays.bay", { bay }) : t(locale, "dashboard.bays.noBay")}</h3>
              <ul>
                {jobs.map((job) => (
                  <BayJob key={job.jobId} job={job} locale={locale} delay={0.3 + 0.06 * index++} />
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

// --------------------------------------------------------------------------- repair orders

function ordersOf(summary: DashboardSummary, locale: Locale): { items: OrderItem[]; head: ReactNode } {
  const money = summary.money !== null;
  const separator = t(locale, "common.listSeparator");
  const head = (
    <thead>
      <tr>
        <th scope="col">{t(locale, "dashboard.orders.order")}</th>
        <th scope="col">{t(locale, "dashboard.orders.car")}</th>
        <th scope="col">{t(locale, "dashboard.orders.status")}</th>
        <th scope="col" className="col-tech">
          {t(locale, "dashboard.orders.technician")}
        </th>
        <th scope="col">{t(locale, "dashboard.orders.promised")}</th>
        {money ? (
          <th scope="col" className="num">
            {t(locale, "dashboard.orders.amount")}
          </th>
        ) : null}
      </tr>
    </thead>
  );
  const items = summary.orders.map((order) => {
    // A Ready car is done: its promised time is shown as a time, never as overdue.
    const due = !order.promisedAt
      ? null
      : order.status === "ready"
        ? { label: formatWhen(order.promisedAt, locale, summary.businessDate), overdue: false }
        : formatDue(order.promisedAt, summary.generatedAt, locale, summary.businessDate);
    const statusWord = t(locale, `repairOrder.status.${order.status}` as MessageKey);
    const plate = order.plate ? `${order.plate.code} ${order.plate.number}` : "";
    return {
      id: order.id,
      status: order.status,
      overdue: order.overdue,
      href: `/${locale}/repair-orders/${order.id}`,
      haystack: [order.number, plate, order.vehicle, ...order.services, ...order.technicians, statusWord]
        .join(" ")
        .toLowerCase(),
      row: (
        <>
          <td>
            <span className="order-id">
              <a className="row-number" href={`/${locale}/repair-orders/${order.id}`}>
                <strong>
                  <bdi dir="ltr">{order.number}</bdi>
                </strong>
              </a>
              {order.plate ? <PlateBadge locale={locale} plate={order.plate} /> : null}
            </span>
          </td>
          <td>
            <span className="stack">
              <strong>
                <bdi dir="auto">{order.vehicle}</bdi>
              </strong>
              {order.services.length ? (
                <span className="muted clamp" dir="auto">
                  {order.services.join(separator)}
                </span>
              ) : null}
            </span>
          </td>
          <td>
            <StatusChip status={REPAIR_ORDER_TONE[order.status]}>{statusWord}</StatusChip>
          </td>
          <td className="col-tech">
            {order.technicians.length ? (
              <span className="avatars" title={order.technicians.join(separator)}>
                {order.technicians.slice(0, 3).map((name) => (
                  <span key={name} className="avatar avatar-sm" aria-hidden="true">
                    {initials(name)}
                  </span>
                ))}
                <span className="visually-hidden">{order.technicians.join(separator)}</span>
              </span>
            ) : (
              <span className="muted">—</span>
            )}
          </td>
          <td className={due?.overdue ? "due is-late" : "due"}>{due ? <bdi>{due.label}</bdi> : "—"}</td>
          {money ? <td className="num">{order.amount ? aed(order.amount, locale) : "—"}</td> : null}
        </>
      ),
    };
  });
  return { items, head };
}

// --------------------------------------------------------------------------- page

export function DashboardView({
  summary,
  locale,
  stage = null,
  actions,
}: {
  summary: DashboardSummary;
  locale: Locale;
  /** A stage chosen from the flow strip (`?stage=`), filtering the repair orders. */
  stage?: DashboardStatus | null;
  /** Live badge and New check-in, placed in the header. */
  actions?: ReactNode;
}) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  const { items, head } = ordersOf(summary, locale);
  const stageName = Object.fromEntries(
    summary.statusCounts.map(({ status }) => [
      status,
      t(locale, `repairOrder.status.${status}` as MessageKey),
    ]),
  );

  return (
    <div className="dashboard today wide">
      <header className="today-head">
        <div className="titles">
          <p className="today-date">{formatBusinessDay(summary.businessDate, locale, "long")}</p>
          <h1>{t(locale, "dashboard.title")}</h1>
          <span className="other-language" lang={other} dir={other === "ar" ? "rtl" : "ltr"}>
            {t(other, "dashboard.title")}
          </span>
        </div>
        {actions ? <div className="today-actions">{actions}</div> : null}
      </header>

      <div className={summary.money ? "today-top with-money" : "today-top"}>
        <FlowStrip summary={summary} locale={locale} stage={stage} />
        {summary.money ? <RevenueCard summary={summary} locale={locale} /> : null}
      </div>

      <div className="today-grid">
        <AttentionPanel summary={summary} locale={locale} />
        <BaysPanel summary={summary} locale={locale} />
      </div>

      <section className="panel orders-panel" id="orders" aria-labelledby="orders-title">
        <div className="panel-head">
          <h2 id="orders-title">{t(locale, "dashboard.orders.title")}</h2>
          <a href={`/${locale}/workshop`}>{t(locale, "dashboard.orders.boardLink")}</a>
        </div>
        {items.length === 0 ? (
          <p className="muted">{t(locale, "dashboard.orders.empty")}</p>
        ) : (
          <OrdersPanel
            items={items}
            head={head}
            initialStage={stage}
            labels={{
              group: t(locale, "dashboard.orders.filters"),
              all: t(locale, "dashboard.orders.filterAll"),
              overdue: t(locale, "dashboard.orders.filterOverdue"),
              search: t(locale, "dashboard.orders.search"),
              clearStage: t(locale, "dashboard.orders.clearStage"),
              stageName,
              noMatch: t(locale, "dashboard.orders.noMatch"),
              showAll: t(locale, "dashboard.orders.showAll"),
              showFewer: t(locale, "dashboard.orders.showFewer"),
            }}
          />
        )}
      </section>
    </div>
  );
}
