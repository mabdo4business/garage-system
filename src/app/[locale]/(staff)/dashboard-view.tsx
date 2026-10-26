import type { CSSProperties } from "react";
import { BarChart, Donut, ProgressBar, Sparkline } from "../../../components/dashboard/charts";
import { CountUp, CountUpMoney } from "../../../components/dashboard/motion";
import { JOB_STATUS_TONE, PlateBadge, REPAIR_ORDER_TONE, StatusChip } from "../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../i18n";
import { formatDuration, formatWhen } from "../../../i18n/time-labels";
import { formatAed, formatAmountCompact, formatBusinessDay } from "../../../i18n/format";
import { Money } from "../../../server/core/money";
import type { Attention, DashboardSummary } from "../../../server/reporting/dashboard";

/**
 * The workshop dashboard (redesign reference docs/design/Main.dc.html, OD-50) from real figures. Money appears
 * only when `summary.money` is set, which the page does for `dashboard.money` holders only.
 */

const delay = (seconds: number) => ({ animationDelay: `${seconds.toFixed(2)}s` }) as CSSProperties;

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

function AttentionCard({
  item,
  locale,
  businessDate,
}: {
  item: Attention;
  locale: Locale;
  businessDate: string;
}) {
  const base = `/${locale}`;
  switch (item.kind) {
    case "awaiting_decision":
      return (
        <li className="attention attention-approval lift">
          <span className="attention-kind">{t(locale, "dashboard.attention.awaitingDecision")}</span>
          <strong>{t(locale, "dashboard.attention.doNotStart", { number: item.number })}</strong>
          {item.since ? (
            <span className="muted">
              {t(locale, "dashboard.attention.sentAt", {
                time: formatWhen(item.since, locale, businessDate),
              })}
            </span>
          ) : null}
          <a href={`${base}/repair-orders/${item.repairOrderId}`}>{t(locale, "dashboard.openRepairOrder")}</a>
        </li>
      );
    case "paused":
      return (
        <li className="attention attention-approval lift">
          <span className="attention-kind">{t(locale, "dashboard.attention.paused")}</span>
          <strong dir="auto">{item.title}</strong>
          <span className="muted">
            <bdi dir="ltr">{item.number}</bdi>
            {item.reason ? (
              <>
                {" · "}
                <bdi>{item.reason}</bdi>
              </>
            ) : null}
          </span>
          <a href={`${base}/jobs/${item.jobId}`}>{t(locale, "dashboard.openJob")}</a>
        </li>
      );
    case "waiting_parts":
      return (
        <li className="attention attention-parts lift">
          <span className="attention-kind">{t(locale, "dashboard.attention.waitingParts")}</span>
          <strong dir="auto">{item.title}</strong>
          <span className="muted">
            <bdi dir="ltr">{item.number}</bdi>
          </span>
          <a href={`${base}/jobs/${item.jobId}`}>{t(locale, "dashboard.openJob")}</a>
        </li>
      );
    case "ready_unpaid":
      return (
        <li className="attention attention-ready lift">
          <span className="attention-kind">{t(locale, "dashboard.attention.readyUnpaid")}</span>
          <strong>
            {item.balance
              ? t(locale, "dashboard.attention.balanceDue", {
                  // Isolated left-to-right inside the sentence (FSI … PDI), like every amount on the page.
                  amount: `\u2068${formatAed(Money.parse(item.balance), locale)}\u2069`,
                })
              : t(locale, "dashboard.attention.notPaid")}
          </strong>
          <span className="muted">
            <bdi dir="ltr">{item.number}</bdi>
            {item.invoiceNumber ? (
              <>
                {" · "}
                <bdi dir="ltr">{item.invoiceNumber}</bdi>
              </>
            ) : null}
          </span>
          <a href={`${base}/repair-orders/${item.repairOrderId}`}>{t(locale, "dashboard.openRepairOrder")}</a>
        </li>
      );
  }
}

export function DashboardView({ summary, locale }: { summary: DashboardSummary; locale: Locale }) {
  const money = summary.money;
  const other: Locale = locale === "ar" ? "en" : "ar";
  const checkInsToday = summary.checkInsByDay.at(-1)?.count ?? 0;
  const statusLabel = (status: string) => t(locale, `repairOrder.status.${status}` as MessageKey);
  const dayLabel = (date: string) =>
    date === summary.businessDate ? t(locale, "dashboard.today") : formatBusinessDay(date, locale, "short");
  const maxRevenue = money
    ? money.revenueByDay.reduce((max, day) => {
        const fils = Money.parse(day.total).fils;
        return fils > max ? fils : max;
      }, 0n)
    : 0n;

  return (
    <div className="dashboard wide">
      <div className="dashboard-head rise">
        <div className="titles">
          <span className="eyebrow">{formatBusinessDay(summary.businessDate, locale, "long")}</span>
          <h1>{t(locale, "dashboard.title")}</h1>
          <span className="other-language" lang={other} dir={other === "ar" ? "rtl" : "ltr"}>
            {t(other, "dashboard.title")}
          </span>
        </div>
      </div>

      <section className="kpis" aria-label={t(locale, "dashboard.kpis")}>
        <article className="kpi rise lift" style={delay(0)}>
          <h2>{t(locale, "dashboard.kpi.carsIn")}</h2>
          <div className="kpi-figure">
            <span className="kpi-value">
              <CountUp value={summary.carsIn} />
            </span>
            <Sparkline
              tone="progress"
              values={summary.checkInsByDay.map((day) => day.count)}
              label={t(locale, "dashboard.kpi.checkInsTrend", {
                values: summary.checkInsByDay.map((day) => `${dayLabel(day.date)} ${day.count}`).join(", "),
              })}
            />
          </div>
          <p className="kpi-note">
            {t(locale, "dashboard.kpi.checkedInToday", { n: String(checkInsToday) })}
          </p>
        </article>
        <article className="kpi rise lift" style={delay(0.08)}>
          <h2>{t(locale, "dashboard.kpi.awaitingApproval")}</h2>
          <div className="kpi-figure">
            <span className="kpi-value">
              <CountUp value={summary.awaitingApproval} />
            </span>
          </div>
          <p className="kpi-note">
            {summary.oldestAwaitingSince
              ? t(locale, "dashboard.kpi.oldestSent", {
                  time: formatWhen(summary.oldestAwaitingSince, locale, summary.businessDate),
                })
              : t(locale, "dashboard.kpi.noneWaiting")}
          </p>
        </article>
        <article className="kpi rise lift" style={delay(0.16)}>
          <h2>{t(locale, "dashboard.kpi.ready")}</h2>
          <div className="kpi-figure">
            <span className="kpi-value">
              <CountUp value={summary.ready} />
            </span>
          </div>
          <p className="kpi-note">
            {t(locale, "dashboard.kpi.readyInvoiced", { n: String(summary.readyInvoiced) })}
          </p>
        </article>
        {money ? (
          <article className="kpi rise lift" style={delay(0.24)}>
            <h2>{t(locale, "dashboard.kpi.revenueToday")}</h2>
            <div className="kpi-figure">
              <span className="kpi-value kpi-money">
                <CountUpMoney amount={money.today} locale={locale} />
              </span>
            </div>
            <p className="kpi-note">
              {t(locale, "dashboard.kpi.invoicesToday", { n: String(money.invoicesToday) })}
            </p>
          </article>
        ) : null}
      </section>

      <div className="dashboard-row">
        {money ? (
          <section className="panel panel-wide rise" style={delay(0.25)} aria-labelledby="revenue-title">
            <div className="panel-head">
              <div>
                <h2 id="revenue-title">{t(locale, "dashboard.revenue.title")}</h2>
                <p className="muted">{t(locale, "dashboard.revenue.subtitle")}</p>
              </div>
              <span className="panel-figure">{aed(money.week, locale)}</span>
            </div>
            <BarChart
              label={t(locale, "dashboard.revenue.title")}
              bars={money.revenueByDay.map((day) => {
                const fils = Money.parse(day.total).fils;
                return {
                  key: day.date,
                  label: dayLabel(day.date),
                  value: formatAmountCompact(Money.parse(day.total), locale),
                  exact: formatAed(Money.parse(day.total), locale),
                  // Display share only (bar height), not an amount.
                  ratio: maxRevenue > 0n ? Number((fils * 1000n) / maxRevenue) / 1000 : 0,
                  highlight: day.date === summary.businessDate,
                };
              })}
            />
          </section>
        ) : null}

        <section className="panel rise" style={delay(0.35)} aria-labelledby="status-title">
          <h2 id="status-title">{t(locale, "dashboard.byStatus")}</h2>
          <Donut
            label={t(locale, "dashboard.byStatus")}
            segments={summary.statusCounts.map(({ status, count }) => ({
              key: status,
              label: statusLabel(status),
              count,
              tone: REPAIR_ORDER_TONE[status],
            }))}
            center={
              <>
                <span className="donut-total">
                  <CountUp value={summary.carsIn} />
                </span>
                <span className="muted">{t(locale, "dashboard.carsIn")}</span>
              </>
            }
          />
        </section>
      </div>

      <div className="dashboard-row">
        <section className="panel panel-wide rise" style={delay(0.45)} aria-labelledby="bays-title">
          <div className="panel-head">
            <h2 id="bays-title">{t(locale, "dashboard.bays.title")}</h2>
            <span className="panel-meta">
              {t(locale, "dashboard.bays.active", { n: String(summary.bays.length) })}
            </span>
          </div>
          {summary.bays.length === 0 ? (
            <p className="muted">{t(locale, "dashboard.bays.empty")}</p>
          ) : (
            <ul className="bay-list">
              {summary.bays.map((bay, i) => {
                const tone = JOB_STATUS_TONE[bay.status];
                return (
                  <li key={bay.jobId}>
                    <span className="bay-label">
                      {bay.bay
                        ? t(locale, "dashboard.bays.bay", { bay: bay.bay })
                        : t(locale, "dashboard.bays.noBay")}
                    </span>
                    <span className="avatar" aria-hidden="true">
                      {initials(bay.assigneeName)}
                    </span>
                    <span className="bay-job">
                      <a href={`/${locale}/jobs/${bay.jobId}`}>
                        <strong dir="auto">{bay.title}</strong>
                      </a>
                      <span className="muted">
                        <bdi>{bay.assigneeName ?? t(locale, "workshop.unassigned")}</bdi>
                        {" · "}
                        <bdi dir="auto">{bay.vehicle}</bdi>
                      </span>
                    </span>
                    <span className="bay-progress">
                      <span className="bay-progress-head">
                        <StatusChip status={tone}>
                          {t(locale, `job.status.${bay.status}` as MessageKey)}
                        </StatusChip>
                        <span>
                          {bay.bookedSeconds
                            ? t(locale, "dashboard.bays.workedOf", {
                                worked: formatDuration(locale, bay.workedSeconds),
                                booked: formatDuration(locale, bay.bookedSeconds),
                              })
                            : t(locale, "dashboard.bays.worked", {
                                worked: formatDuration(locale, bay.workedSeconds),
                              })}
                        </span>
                      </span>
                      <ProgressBar
                        tone={tone}
                        share={bay.bookedSeconds ? bay.workedSeconds / bay.bookedSeconds : 0}
                        delay={0.5 + 0.08 * i}
                      />
                      {bay.reason ? (
                        <span className="muted" dir="auto">
                          {bay.reason}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel rise" style={delay(0.55)} aria-labelledby="attention-title">
          <div className="panel-head">
            <h2 id="attention-title">{t(locale, "dashboard.attention.title")}</h2>
            {summary.attention.length > 0 ? (
              <span className="count-badge blink">
                {t(locale, "dashboard.attention.open", { n: String(summary.attention.length) })}
              </span>
            ) : null}
          </div>
          {summary.attention.length === 0 ? (
            <p className="muted">{t(locale, "dashboard.attention.empty")}</p>
          ) : (
            <ul className="attention-list">
              {summary.attention.map((item, i) => (
                <AttentionCard
                  key={`${item.kind}-${i}`}
                  item={item}
                  locale={locale}
                  businessDate={summary.businessDate}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel rise" style={delay(0.65)} aria-labelledby="orders-title">
        <div className="panel-head">
          <h2 id="orders-title">{t(locale, "dashboard.orders.title")}</h2>
          <a href={`/${locale}/workshop`}>{t(locale, "dashboard.orders.board")}</a>
        </div>
        {summary.orders.length === 0 ? (
          <p className="muted">{t(locale, "dashboard.orders.empty")}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table orders-table">
              <thead>
                <tr>
                  <th scope="col">{t(locale, "dashboard.orders.order")}</th>
                  <th scope="col">{t(locale, "dashboard.orders.plate")}</th>
                  <th scope="col">{t(locale, "dashboard.orders.car")}</th>
                  <th scope="col">{t(locale, "dashboard.orders.status")}</th>
                  <th scope="col">{t(locale, "dashboard.orders.technician")}</th>
                  <th scope="col">{t(locale, "dashboard.orders.promised")}</th>
                  {money ? (
                    <th scope="col" className="num">
                      {t(locale, "dashboard.orders.amount")}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {summary.orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <a href={`/${locale}/repair-orders/${order.id}`}>
                        <strong>
                          <bdi dir="ltr">{order.number}</bdi>
                        </strong>
                      </a>
                    </td>
                    <td>{order.plate ? <PlateBadge locale={locale} plate={order.plate} /> : "—"}</td>
                    <td>
                      <span className="stack">
                        <strong>
                          <bdi dir="auto">{order.vehicle}</bdi>
                        </strong>
                        {order.services.length ? (
                          <span className="muted" dir="auto">
                            {order.services.join(t(locale, "common.listSeparator"))}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <StatusChip status={REPAIR_ORDER_TONE[order.status]}>
                        {statusLabel(order.status)}
                      </StatusChip>
                    </td>
                    <td>
                      {order.technicians.length ? (
                        <bdi>{order.technicians.join(t(locale, "common.listSeparator"))}</bdi>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="num">
                      {order.promisedAt ? (
                        <bdi dir="ltr">{formatWhen(order.promisedAt, locale, summary.businessDate)}</bdi>
                      ) : (
                        "—"
                      )}
                    </td>
                    {money ? <td className="num">{order.amount ? aed(order.amount, locale) : "—"}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
