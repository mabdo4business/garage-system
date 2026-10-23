import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, PageHeader, StatusChip } from "../../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../../i18n/format";
import { getDb } from "../../../../../../server/db/client";
import { DISPOSITIONS } from "../../../../../../server/quality/commands";
import { qcView } from "../../../../../../server/quality/queries";
import { ActionForm } from "../../../../action-form";
import { requirePagePermission } from "../../../../server-support";
import { JOB_TONE } from "../../../jobs/shared";
import { failQcAction, passQcAction } from "./actions";

export const dynamic = "force-dynamic";

const QC_TONE = { pending: "warning", passed: "success", failed: "danger" } as const;
const CHECKS = ["noNewWarningLights", "fluidsOk", "cleanlinessOk", "belongingsOk"] as const;

/** QC form (I1-08, PRD v0.2 §G): managers and partners pass or fail it (OD-36). Tablet-first. */
export default async function QcPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "qc.decide", { entityType: "repair_order", entityId: id });
  const view = await qcView(getDb(), id);
  if (!view) notFound();
  const pending = view.records.find((record) => record.status === "pending");
  const done = view.jobs.filter((job) => job.status === "done");

  return (
    <div className="workshop">
      <PageHeader
        title={
          <>
            {t(locale, "qc.title")} <bdi dir="ltr">{view.number}</bdi>
          </>
        }
        subtitle={<StatusChip>{t(locale, `repairOrder.status.${view.status}` as MessageKey)}</StatusChip>}
      />
      {pending ? (
        <>
          <Card title={t(locale, "qc.pass")}>
            <ActionForm
              locale={locale}
              action={passQcAction}
              hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
              submit="qc.pass"
              variant="primary"
            >
              {CHECKS.map((check) => (
                <label key={check} className="checkbox">
                  <input type="checkbox" name={check} required />{" "}
                  {t(locale, `qc.check.${check}` as MessageKey)}
                </label>
              ))}
              <fieldset className="segmented segmented-2">
                <legend>{t(locale, "qc.roadTest")}</legend>
                <label>
                  <input type="radio" name="roadTest" value="done" required />{" "}
                  <span>{t(locale, "qc.roadTest.done")}</span>
                </label>
                <label>
                  <input type="radio" name="roadTest" value="not_applicable" />{" "}
                  <span>{t(locale, "qc.roadTest.not_applicable")}</span>
                </label>
              </fieldset>
              <div className="field">
                <label htmlFor="roadTestReason">
                  {t(locale, "qc.roadTestReason")}{" "}
                  <span className="optional">{t(locale, "qc.ifNotApplicable")}</span>
                </label>
                <input id="roadTestReason" name="roadTestReason" dir="auto" />
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="odometerOutKm">{t(locale, "qc.odometerOut")}</label>
                  <input id="odometerOutKm" name="odometerOutKm" required inputMode="numeric" dir="ltr" />
                  <span className="hint">
                    {t(locale, "qc.odometerIn", { km: `\u2066${view.odometerInKm}\u2069` })}
                  </span>
                </div>
                <div className="field">
                  <label htmlFor="odometerReason">
                    {t(locale, "qc.odometerReason")}{" "}
                    <span className="optional">{t(locale, "qc.ifLower")}</span>
                  </label>
                  <input id="odometerReason" name="odometerReason" dir="auto" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="oldParts">{t(locale, "qc.oldParts")}</label>
                <select id="oldParts" name="oldParts" required defaultValue="">
                  <option value="" />
                  {DISPOSITIONS.map((value) => (
                    <option key={value} value={value}>
                      {t(locale, `qc.oldParts.${value}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pass-notes">
                  {t(locale, "qc.notes")} <span className="optional">{t(locale, "common.optional")}</span>
                </label>
                <textarea id="pass-notes" name="notes" maxLength={2000} />
              </div>
            </ActionForm>
          </Card>
          <Card title={t(locale, "qc.fail")}>
            <ActionForm
              locale={locale}
              action={failQcAction}
              hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
              submit="qc.fail"
            >
              <fieldset className="field">
                <legend>
                  {t(locale, "qc.returnJobs")}{" "}
                  <span className="optional">{t(locale, "common.optional")}</span>
                </legend>
                {done.map((job) => (
                  <label key={job.id} className="checkbox">
                    <input type="checkbox" name="jobIds" value={job.id} /> <bdi dir="auto">{job.title}</bdi>
                    {job.assigneeName ? (
                      <span className="muted">
                        {t(locale, "common.listSeparator")}
                        <bdi>{job.assigneeName}</bdi>
                      </span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
              <div className="field">
                <label htmlFor="fail-notes">{t(locale, "qc.failNotes")}</label>
                <textarea id="fail-notes" name="notes" required maxLength={2000} />
              </div>
            </ActionForm>
          </Card>
        </>
      ) : (
        <p className="muted">{t(locale, "qc.nonePending")}</p>
      )}
      <Card title={t(locale, "qc.jobs")}>
        <ul className="result-list">
          {view.jobs.map((job) => (
            <li key={job.id}>
              <span dir="auto">{job.title}</span>
              <StatusChip tone={JOB_TONE[job.status]}>
                {t(locale, `job.status.${job.status}` as MessageKey)}
              </StatusChip>
            </li>
          ))}
        </ul>
      </Card>
      {view.records.length > 0 ? (
        <Card title={t(locale, "qc.history")}>
          <ul className="result-list">
            {view.records.map((record) => (
              <li key={record.id}>
                <StatusChip tone={QC_TONE[record.status]}>
                  {t(locale, `qc.status.${record.status}` as MessageKey)}
                </StatusChip>
                <span className="meta">
                  <bdi dir="ltr">{formatDubaiDateTime(record.decidedAt ?? record.requestedAt, locale)}</bdi>
                  {record.decidedByName ? (
                    <>
                      {t(locale, "common.listSeparator")}
                      <bdi>{record.decidedByName}</bdi>
                    </>
                  ) : null}
                </span>
                {record.notes ? <span dir="auto">{record.notes}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
