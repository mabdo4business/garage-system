import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, PageHeader, PlateBadge, StatusChip } from "../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../i18n/format";
import { hasPermission } from "../../../../../server/auth/permissions";
import { NotFoundError } from "../../../../../server/core/errors";
import { getDb } from "../../../../../server/db/client";
import { requireJobAccess } from "../../../../../server/workshop/commands";
import { jobCard } from "../../../../../server/workshop/queries";
import { ActionForm } from "../../../action-form";
import { requirePagePermission } from "../../../server-support";
import { completeJobAction, pauseJobAction, resumeJobAction, startJobAction } from "../actions";
import { waitingPartsAction } from "../../stock/actions";
import { qcView } from "../../../../../server/quality/queries";
import { requestQcAction } from "../../repair-orders/[id]/qc/actions";
import { JOB_TONE } from "../shared";

export const dynamic = "force-dynamic";

const SEVERITY_TONE = { ok: "success", soon: "warning", urgent: "danger" } as const;

/** The job card (US-07.3/07.4): what to do on which car — never what it costs (AC2-30). Tablet-first. */
export default async function JobPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(
    locale,
    // Front-office staff read job cards from the board; assignees from My jobs.
    "workshop.my_jobs",
    { entityType: "repair_job", entityId: id },
    "workshop.board",
  );
  const db = getDb();
  try {
    await requireJobAccess(db, session, id); // AC2-30: not found (and logged) for anyone else
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const job = await jobCard(db, id);
  if (!job) notFound();
  const mine = job.assigneeId === session.userId && hasPermission(session.roles, "workshop.my_jobs");
  const running = job.repairOrderStatus === "in_progress";
  const name = (line: { descriptionEn: string; descriptionAr: string }) =>
    locale === "ar" ? line.descriptionAr : line.descriptionEn;
  const unit = (value: string | null) =>
    value === "hour"
      ? t(locale, "estimate.unit.hour")
      : value
        ? t(locale, `catalogue.unit.${value}` as MessageKey)
        : "";
  const hidden = () => ({ jobId: job.id, idempotencyKey: randomUUID() });
  const qc = mine ? await qcView(db, job.repairOrderId) : null;

  return (
    <div className="workshop">
      <PageHeader
        title={<span dir="auto">{job.title}</span>}
        subtitle={
          <>
            {job.vehicle.plate ? <PlateBadge locale={locale} plate={job.vehicle.plate} /> : null}{" "}
            <bdi dir="ltr">
              {job.vehicle.make} {job.vehicle.model} {job.vehicle.year} · {job.repairOrderNumber}
            </bdi>{" "}
            <StatusChip tone={JOB_TONE[job.status]}>
              {t(locale, `job.status.${job.status}` as MessageKey)}
            </StatusChip>
          </>
        }
      />
      {job.status === "paused" && job.reason ? (
        <p>
          <StatusChip tone="danger">{t(locale, "job.pausedBecause")}</StatusChip> <bdi>{job.reason}</bdi>
        </p>
      ) : null}
      {!mine ? (
        <p className="muted">
          {job.assigneeName
            ? t(locale, "job.assignedTo", { name: job.assigneeName })
            : t(locale, "workshop.unassigned")}
        </p>
      ) : null}

      {mine && !running ? <p className="muted">{t(locale, "error.repairOrderNotInProgress")}</p> : null}
      {qc && qc.blocker === null && hasPermission(session.roles, "qc.request") ? (
        <ActionForm
          locale={locale}
          action={requestQcAction}
          hidden={{ repairOrderId: job.repairOrderId, idempotencyKey: randomUUID(), back: `/jobs/${job.id}` }}
          submit="qc.request"
          variant="primary"
        />
      ) : null}
      {mine && running ? (
        <div className="form-actions job-actions">
          {job.status === "authorized" ? (
            <>
              <ActionForm
                locale={locale}
                action={startJobAction}
                hidden={hidden()}
                submit="job.start"
                variant="primary"
              />
              <ActionForm
                locale={locale}
                action={waitingPartsAction}
                hidden={{ ...hidden(), back: "job" }}
                submit="parts.markWaiting"
                variant="quiet"
              />
            </>
          ) : null}
          {job.status === "paused" ? (
            <ActionForm
              locale={locale}
              action={resumeJobAction}
              hidden={hidden()}
              submit="job.resume"
              variant="primary"
            />
          ) : null}
          {job.status === "in_progress" ? (
            <details className="disclosure">
              <summary>{t(locale, "job.pause")}</summary>
              <ActionForm locale={locale} action={pauseJobAction} hidden={hidden()} submit="job.pause">
                <div className="field">
                  <label htmlFor="pauseReason">{t(locale, "job.pauseReason")}</label>
                  <input id="pauseReason" name="pauseReason" required dir="auto" />
                </div>
              </ActionForm>
            </details>
          ) : null}
        </div>
      ) : null}

      <Card title={t(locale, "job.lines")}>
        {mine && running && job.status === "in_progress" ? (
          <ActionForm
            locale={locale}
            action={completeJobAction}
            hidden={hidden()}
            submit="job.complete"
            variant="primary"
          >
            <ul className="finding-list">
              {job.lines.map((line) => (
                <li key={line.id} className="finding">
                  <strong>
                    <bdi>{name(line)}</bdi> · <bdi dir="ltr">{line.qty.replace(/\.?0+$/, "")}</bdi>{" "}
                    {unit(line.unit)}
                  </strong>
                  {line.partsQty !== null ? (
                    <span className="muted">
                      {t(locale, "job.partsIssued", { qty: line.partsQty.replace(/\.?0+$/, "") || "0" })}
                    </span>
                  ) : null}
                  <fieldset className="segmented segmented-2">
                    <legend className="visually-hidden">{name(line)}</legend>
                    <label className="choice-approved">
                      <input type="radio" name={`outcome.${line.id}`} value="done" required />{" "}
                      <span>{t(locale, "job.line.done")}</span>
                    </label>
                    <label className="choice-declined">
                      <input type="radio" name={`outcome.${line.id}`} value="not_performed" />{" "}
                      <span>{t(locale, "job.line.notPerformed")}</span>
                    </label>
                  </fieldset>
                  <div className="field">
                    <label htmlFor={`reason-${line.id}`}>
                      {t(locale, "job.line.reason")}{" "}
                      <span className="optional">{t(locale, "job.line.reasonHint")}</span>
                    </label>
                    <input id={`reason-${line.id}`} name={`reason.${line.id}`} dir="auto" />
                  </div>
                </li>
              ))}
            </ul>
            <div className="field">
              <label htmlFor="note">{t(locale, "job.note")}</label>
              <textarea id="note" name="note" maxLength={500} required />
            </div>
          </ActionForm>
        ) : (
          <ul className="finding-list">
            {job.lines.map((line) => (
              <li key={line.id} className="finding">
                <strong>
                  <bdi>{name(line)}</bdi> · <bdi dir="ltr">{line.qty.replace(/\.?0+$/, "")}</bdi>{" "}
                  {unit(line.unit)}
                </strong>
                {line.partsQty !== null ? (
                  <span className="muted">
                    {t(locale, "job.partsIssued", { qty: line.partsQty.replace(/\.?0+$/, "") || "0" })}
                  </span>
                ) : null}
                {line.outcome ? (
                  <p>
                    <StatusChip tone={line.outcome === "done" ? "success" : "danger"}>
                      {t(locale, line.outcome === "done" ? "job.line.done" : "job.line.notPerformed")}
                    </StatusChip>{" "}
                    {line.reason ? <bdi>{line.reason}</bdi> : null}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t(locale, "job.vehicle")}>
        <dl className="detail-list">
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
          {job.bay ? (
            <>
              <dt>{t(locale, "workshop.bay")}</dt>
              <dd>
                <bdi>{job.bay}</bdi>
              </dd>
            </>
          ) : null}
        </dl>
        {job.finding ? (
          <div className="finding">
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
      </Card>

      {job.history.length > 0 ? (
        <Card title={t(locale, "job.history")}>
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
        </Card>
      ) : null}
    </div>
  );
}
