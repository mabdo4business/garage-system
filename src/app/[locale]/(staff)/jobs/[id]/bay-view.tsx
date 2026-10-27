import type { ReactNode } from "react";
import { BayTimer } from "../../../../../components/bay/bay-clock";
import { formatClockDuration, TaskRing } from "../../../../../components/bay/task-ring";
import { JOB_STATUS_TONE, PlateBadge, StatusChip } from "../../../../../components/ui";
import { t, type Locale, type MessageKey } from "../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../i18n/format";
import { formatWhen } from "../../../../../i18n/time-labels";
import type { JobCard, MyJob } from "../../../../../server/workshop/queries";
import type { FormState } from "../../../form-state";
import { BayWork, TaskBox, type BayLine } from "./bay-work";

/**
 * The technician bay screen (redesign UI-R3, reference docs/design/Bay.dc.html): a dark tablet screen with the car,
 * the task ring, the time worked (from the job's own start/pause history) against the approved labour hours, the
 * authorized items to tick, the advisor's note with the recorded approval, and the technician's next jobs.
 *
 * Rules kept from I1-06: only the assignee changes the job (OD-27); only authorized items are listed and work never
 * starts without a recorded approval (AC2-01); no price, cost or customer contact anywhere (AC2-30); Done needs an
 * outcome for every item and a completion note (OD-31), and stays locked until then. Status is always a word.
 */

const SEVERITY_TONE = { ok: "success", soon: "warning", urgent: "danger" } as const;

export interface BayForms {
  start: () => ReactNode;
  waitingParts: () => ReactNode;
  resume: () => ReactNode;
  pause: () => ReactNode;
  requestQc: () => ReactNode;
}

export function BayView({
  locale,
  job,
  mine,
  queue,
  worked,
  businessDate,
  clock,
  canRequestQc,
  completeAction,
  completeHidden,
  forms,
}: {
  locale: Locale;
  job: JobCard;
  /** The viewer is the assignee and may act (OD-27); everyone else reads. */
  mine: boolean;
  queue: MyJob[];
  /** Seconds worked so far, from the job's status history. */
  worked: number;
  businessDate: string;
  clock?: ReactNode;
  canRequestQc: boolean;
  completeAction: (previous: FormState, formData: FormData) => Promise<FormState>;
  completeHidden: Record<string, string>;
  forms: BayForms;
}) {
  const base = `/${locale}`;
  const running = job.repairOrderStatus === "in_progress";
  const statusWord = t(locale, `job.status.${job.status}` as MessageKey);
  const name = (line: JobCard["lines"][number]) =>
    locale === "ar" ? line.descriptionAr : line.descriptionEn;
  const unit = (value: string | null) =>
    value === "hour"
      ? t(locale, "estimate.unit.hour")
      : value
        ? t(locale, `catalogue.unit.${value}` as MessageKey)
        : "";
  const detail = (line: JobCard["lines"][number]) =>
    [
      `${trimQty(line.qty)} ${unit(line.unit)}`.trim(),
      line.partsQty !== null ? t(locale, "job.partsIssued", { qty: trimQty(line.partsQty) || "0" }) : null,
    ]
      .filter(Boolean)
      .join(t(locale, "common.listSeparator"));
  const settled = job.lines.filter((line) => line.outcome !== null).length;

  const car = (
    <div className="bay-car">
      <div className="bay-car-top">
        {job.vehicle.plate ? <PlateBadge locale={locale} plate={job.vehicle.plate} /> : null}
        <span className="bay-status">
          <StatusChip status={JOB_STATUS_TONE[job.status]}>{statusWord}</StatusChip>
        </span>
      </div>
      <h1>
        <bdi dir="auto">
          {job.vehicle.make} {job.vehicle.model} {job.vehicle.year}
        </bdi>
      </h1>
      <p className="bay-sub">
        <bdi dir="ltr">{job.repairOrderNumber}</bdi>
        {t(locale, "common.listSeparator")}
        <bdi dir="auto">{job.title}</bdi>
      </p>
    </div>
  );

  const timerState =
    job.status === "in_progress" ? "running" : job.status === "paused" ? "paused" : "stopped";
  const timer = (
    <div className="bay-timer" data-state={timerState}>
      {timerState === "running" ? <span className="bay-dot breathe" aria-hidden="true" /> : null}
      {timerState === "paused" ? <span className="bay-dot paused" aria-hidden="true" /> : null}
      <span className="bay-timer-label">
        {t(
          locale,
          timerState === "running"
            ? "bay.timer.working"
            : timerState === "paused"
              ? "bay.timer.paused"
              : "bay.timer.total",
        )}
        {job.status === "paused" && job.reason ? (
          <>
            {t(locale, "common.listSeparator")}
            <bdi>{job.reason}</bdi>
          </>
        ) : null}
      </span>
      <BayTimer seconds={worked} running={timerState === "running"} />
      <span className="bay-booked">
        {job.bookedSeconds !== null
          ? t(locale, "bay.booked", { time: `⁦${formatClockDuration(job.bookedSeconds)}⁩` })
          : t(locale, "bay.noBooked")}
      </span>
    </div>
  );

  const readOnlyTasks = (
    <ul className="bay-tasks">
      {job.lines.map((line) => (
        <li key={line.id} className="bay-task" data-outcome={line.outcome ?? "open"}>
          <div className="bay-task-row">
            <div className="bay-tick" aria-disabled="true">
              <TaskBox outcome={line.outcome} />
              <span className="bay-task-text">
                <span dir="auto">{name(line)}</span>
                <span className="bay-task-detail">{detail(line)}</span>
              </span>
            </div>
            {line.outcome ? (
              <StatusChip tone={line.outcome === "done" ? "success" : "danger"}>
                {t(locale, line.outcome === "done" ? "job.line.done" : "job.line.notPerformed")}
              </StatusChip>
            ) : null}
          </div>
          {line.reason ? (
            <p className="bay-task-reason">
              <bdi>{line.reason}</bdi>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );

  let main: ReactNode;
  if (mine && running && job.status === "in_progress") {
    main = (
      <BayWork
        locale={locale}
        action={completeAction}
        hidden={completeHidden}
        lines={job.lines.map((line): BayLine => ({ id: line.id, label: name(line), detail: detail(line) }))}
        car={car}
        timer={timer}
        actions={forms.pause()}
      />
    );
  } else if (mine && job.status === "done") {
    const next = queue[0];
    main = (
      <>
        <div className="bay-head">
          {car}
          <TaskRing locale={locale} done={settled} total={job.lines.length} />
        </div>
        <div className="bay-finished success">
          <span className="bay-finished-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path className="tickpath" d="M20 6L9 17l-5-5" pathLength={24} />
            </svg>
          </span>
          <h2>{t(locale, "bay.done.title")}</h2>
          <p>
            {t(locale, "bay.done.time", { time: `⁦${formatClockDuration(worked)}⁩` })}
            {job.bookedSeconds !== null ? (
              <> {t(locale, "bay.booked", { time: `⁦${formatClockDuration(job.bookedSeconds)}⁩` })}</>
            ) : null}
          </p>
          <div className="bay-actions">
            {canRequestQc ? forms.requestQc() : null}
            {next ? (
              <a className="bay-done ready" href={`${base}/jobs/${next.id}`}>
                {t(locale, "bay.done.next")}
              </a>
            ) : (
              <a className="bay-secondary" href={`${base}/jobs`}>
                {t(locale, "bay.done.myJobs")}
              </a>
            )}
          </div>
        </div>
        {readOnlyTasks}
      </>
    );
  } else {
    main = (
      <>
        <div className="bay-head">
          {car}
          <TaskRing locale={locale} done={settled} total={job.lines.length} />
        </div>
        {timer}
        {!mine ? (
          <p className="bay-muted">
            {job.assigneeName
              ? t(locale, "job.assignedTo", { name: job.assigneeName })
              : t(locale, "workshop.unassigned")}
          </p>
        ) : null}
        {mine && !running ? <p className="bay-muted">{t(locale, "error.repairOrderNotInProgress")}</p> : null}
        {readOnlyTasks}
        {mine && running && (job.status === "authorized" || job.status === "paused") ? (
          <div className="bay-actions">
            {job.status === "authorized" ? (
              <>
                {forms.waitingParts()}
                {forms.start()}
              </>
            ) : (
              forms.resume()
            )}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="bay wide">
      <header className="bay-top rise">
        {job.bay ? (
          <span className="bay-label">
            <small>{t(locale, "workshop.bay")}</small>
            <bdi>{job.bay}</bdi>
          </span>
        ) : null}
        <div className="bay-who">
          <strong>
            <bdi>{job.assigneeName ?? t(locale, "workshop.unassigned")}</bdi>
          </strong>
          <span>{t(locale, "job.lines")}</span>
        </div>
        {clock}
      </header>

      <div className="bay-grid">
        <section className="bay-main rise" aria-label={job.title}>
          {main}
        </section>

        <aside className="bay-side rise">
          <section className="bay-panel" aria-labelledby="bay-advisor">
            <h2 id="bay-advisor">{t(locale, "bay.advisorNote")}</h2>
            {job.approval?.method === "garage_reduction" ? null : job.approval ? (
              <p className="bay-approval">
                {t(locale, "bay.approval", {
                  method: t(locale, `bay.approval.method.${job.approval.method}` as MessageKey),
                  when: formatWhen(job.approval.recordedAt, locale, businessDate),
                })}
              </p>
            ) : (
              <p className="bay-stop">{t(locale, "bay.notApproved")}</p>
            )}
            {job.finding ? (
              <div className="bay-finding">
                <div className="finding-head">
                  <StatusChip tone={SEVERITY_TONE[job.finding.severity]}>
                    {t(locale, `finding.severity.${job.finding.severity}` as MessageKey)}
                  </StatusChip>
                  <strong dir="auto">{job.finding.title}</strong>
                </div>
                {job.finding.customerNote ? <p dir="auto">{job.finding.customerNote}</p> : null}
                {job.finding.internalNote ? (
                  <p className="internal-note">
                    <StatusChip tone="neutral">{t(locale, "finding.internal")}</StatusChip>{" "}
                    <bdi>{job.finding.internalNote}</bdi>
                  </p>
                ) : null}
              </div>
            ) : null}
            <dl className="bay-facts">
              <dt>{t(locale, "checkIn.concerns")}</dt>
              <dd dir="auto">{job.concerns}</dd>
              {job.warningLights ? (
                <>
                  <dt>{t(locale, "checkIn.warningLights")}</dt>
                  <dd dir="auto">{job.warningLights}</dd>
                </>
              ) : null}
              <dt>{t(locale, "checkIn.odometer")}</dt>
              <dd>
                <bdi dir="ltr">{job.vehicle.odometerKm}</bdi>
              </dd>
            </dl>
          </section>

          {mine ? (
            <section className="bay-panel" aria-labelledby="bay-next">
              <h2 id="bay-next">{t(locale, "bay.upNext")}</h2>
              {queue.length === 0 ? <p className="bay-muted">{t(locale, "bay.upNextEmpty")}</p> : null}
              {queue.map((other) => (
                <a key={other.id} className="bay-queue" href={`${base}/jobs/${other.id}`}>
                  <span className="bay-queue-top">
                    {other.plate ? <PlateBadge locale={locale} plate={other.plate} /> : <span />}
                    <StatusChip status={JOB_STATUS_TONE[other.status]}>
                      {t(locale, `job.status.${other.status}` as MessageKey)}
                    </StatusChip>
                  </span>
                  <strong>
                    <bdi dir="auto">
                      {other.make} {other.model}
                    </bdi>
                  </strong>
                  <span dir="auto">{other.title}</span>
                </a>
              ))}
            </section>
          ) : null}
        </aside>
      </div>

      {job.history.length > 0 ? (
        <section className="bay-panel bay-history" aria-labelledby="bay-history">
          <h2 id="bay-history">{t(locale, "job.history")}</h2>
          <ul className="result-list">
            {job.history.map((event, index) => (
              <li key={index}>
                <span>
                  {t(locale, `job.status.${event.to}` as MessageKey)}
                  {event.reason ? (
                    <>
                      {t(locale, "common.listSeparator")}
                      <bdi>{event.reason}</bdi>
                    </>
                  ) : null}
                </span>
                <span className="meta">
                  <bdi>{formatDubaiDateTime(event.at, locale)}</bdi>
                  {event.actorName ? (
                    <>
                      {t(locale, "common.listSeparator")}
                      <bdi>{event.actorName}</bdi>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const trimQty = (qty: string) => qty.replace(/\.?0+$/, "");
