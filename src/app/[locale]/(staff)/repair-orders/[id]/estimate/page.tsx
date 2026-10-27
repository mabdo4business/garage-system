import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Alert, Card, EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../../../components/ui";
import { isLocale, t, type Locale, type MessageKey } from "../../../../../../i18n";
import { formatAed, formatDubaiDateTime } from "../../../../../../i18n/format";
import { hasPermission } from "../../../../../../server/auth/permissions";
import { KINDS, listCatalogue } from "../../../../../../server/catalog/items";
import { Money } from "../../../../../../server/core/money";
import { getDb } from "../../../../../../server/db/client";
import { OPEN_FOR_DRAFT } from "../../../../../../server/estimate/commands";
import {
  estimateView,
  type EarlierJob,
  type EstimateLineView,
  type VersionSummary,
} from "../../../../../../server/estimate/queries";
import { getRepairOrder } from "../../../../../../server/repair-order/queries";
import { requirePagePermission } from "../../../../server-support";
import { NoTaxProfileBanner } from "../../../catalogue/shared";
import { StepForm, type StepField } from "./estimate-forms";

export const dynamic = "force-dynamic";

const SEVERITY_TONE = { ok: "success", soon: "warning", urgent: "danger" } as const;
const STATE_TONE = { included: "success", decided: "neutral", excluded: "neutral", open: "danger" } as const;
const WITHDRAW_REASONS = ["no_response", "needs_changes", "other"] as const;
const REVISION_TONE: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  approved: "success",
  declined: "danger",
  pending: "warning",
  lapsed: "neutral",
};

const aed = (amount: string, locale: Locale) => <bdi>{formatAed(Money.parse(amount), locale)}</bdi>;

/** Jobs of earlier versions: title, the version, its status (and why it lapsed), the total as proposed. */
function EarlierList({
  locale,
  jobs,
  action,
}: {
  locale: Locale;
  jobs: EarlierJob[];
  action?: (job: EarlierJob) => ReactNode;
}) {
  return (
    <ul className="result-list earlier-jobs">
      {jobs.map((job) => (
        <li key={job.revisionId}>
          <span>
            <strong dir="auto">{job.title}</strong>{" "}
            <StatusChip tone={REVISION_TONE[job.status] ?? "neutral"}>
              {t(locale, `estimate.revision.${job.status}` as MessageKey)}
              {job.lapseReason
                ? `${t(locale, "common.listSeparator")}${t(locale, `estimate.lapse.${job.lapseReason}` as MessageKey)}`
                : ""}
            </StatusChip>
          </span>
          <span className="meta">
            {t(locale, "estimate.inVersion", { no: String(job.versionNo) })}
            {t(locale, "common.listSeparator")}
            {aed(job.total, locale)}
          </span>
          {action ? action(job) : null}
        </li>
      ))}
    </ul>
  );
}

/** One version in the history line: "v1 Withdrawn · No response from customer" (I2-01). */
function versionLabel(locale: Locale, version: VersionSummary): string {
  const parts = [
    t(locale, "estimate.versionEntry", { no: String(version.versionNo) }),
    t(locale, `estimate.status.${version.status}` as MessageKey),
  ];
  if (version.reasonCode) {
    parts.push(
      version.reasonCode === "other" && version.reason
        ? version.reason
        : t(locale, `estimate.endReason.${version.reasonCode}` as MessageKey),
    );
  } else if (version.outcome === "expired") {
    parts.push(t(locale, "estimate.expiredBySystem"));
  }
  return parts.join(t(locale, "common.listSeparator"));
}

/**
 * Estimate builder (I1-05a): jobs, catalogue lines, discounts (OD-19), totals (AC-06.1, OD-18). I2-01: the version
 * history, withdrawal, a new version, work approved earlier (context) and declined or lapsed jobs to offer again.
 */
export default async function EstimatePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "estimate.read", {
    entityType: "repair_order",
    entityId: id,
  });
  const db = getDb();
  const ro = await getRepairOrder(db, session.roles, id);
  if (!ro) notFound();
  const view = await estimateView(db, id);

  const roOpen = ro.status === "checked_in" || ro.status === "diagnosing";
  const draftOpen = (OPEN_FOR_DRAFT as readonly string[]).includes(ro.status);
  const canEdit = hasPermission(session.roles, "estimate.edit") && draftOpen && view?.status === "draft";
  // A sent version past its expiry is shown as expired; the next action on it records that (§5).
  const shownStatus = view?.overdue ? "expired" : view?.status;
  const ended =
    shownStatus === "closed" ||
    shownStatus === "withdrawn" ||
    shownStatus === "expired" ||
    shownStatus === "discarded";
  const canStartVersion =
    view !== null &&
    ended &&
    (ro.status === "awaiting_approval" || ro.status === "in_progress") &&
    hasPermission(session.roles, "estimate.edit");
  const canDiscount = canEdit && hasPermission(session.roles, "estimate.discount");
  const name = (line: { descriptionEn: string; descriptionAr: string }) =>
    locale === "ar" ? line.descriptionAr : line.descriptionEn;

  const header = (
    <PageHeader
      title={
        <>
          {t(locale, "estimate.title")} <bdi dir="ltr">{ro.number}</bdi>
        </>
      }
      subtitle={
        <>
          {ro.plate ? <PlateBadge locale={locale} plate={ro.plate} /> : null}{" "}
          <bdi dir="ltr">
            {t(locale, "vehicle.summary", { make: ro.make, model: ro.model, year: String(ro.year) })}
          </bdi>{" "}
          {view ? (
            <>
              <StatusChip>{t(locale, "estimate.version", { no: String(view.versionNo) })}</StatusChip>{" "}
              <StatusChip tone={view.status === "draft" ? "warning" : "neutral"}>
                {t(locale, `estimate.status.${shownStatus}` as MessageKey)}
              </StatusChip>
            </>
          ) : null}
        </>
      }
    />
  );

  if (!view) {
    return (
      <>
        {header}
        <NoTaxProfileBanner db={db} locale={locale} />
        <EmptyState
          title={t(locale, "estimate.none")}
          text={t(locale, "estimate.noneText")}
          action={
            roOpen && hasPermission(session.roles, "estimate.edit") ? (
              <StepForm
                locale={locale}
                action="open"
                hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
                submit="estimate.start"
                variant="primary"
              />
            ) : undefined
          }
        />
      </>
    );
  }

  const catalogue = canEdit
    ? await Promise.all(
        KINDS.map(async (kind) => ({
          group: t(locale, `catalogue.kind.${kind}`),
          items: (await listCatalogue(db, { kind }))
            .filter((item) => item.price !== null)
            .map((item) => ({
              value: item.id,
              label: `${locale === "ar" ? item.nameAr : item.nameEn} · ${item.code} · ${formatAed(Money.parse(item.price!), locale)}`,
            })),
        })),
      )
    : [];
  const lineFields: StepField[] = [
    {
      name: "itemId",
      label: "estimate.item",
      required: true,
      options: catalogue,
      placeholder: "estimate.chooseItem",
    },
    { name: "qty", label: "estimate.qty", required: true, inputMode: "decimal", defaultValue: "1" },
  ];

  const unitLabel = (line: EstimateLineView) =>
    line.unit === "hour"
      ? t(locale, "estimate.unit.hour")
      : line.unit
        ? t(locale, `catalogue.unit.${line.unit}` as MessageKey)
        : "";

  return (
    <>
      {header}
      {view.versions.length > 1 ? (
        <nav className="estimate-versions" aria-label={t(locale, "estimate.versions")}>
          <ol>
            {view.versions.map((version) => (
              <li
                key={version.versionNo}
                aria-current={version.versionNo === view.versionNo ? "true" : undefined}
              >
                <bdi>{versionLabel(locale, version)}</bdi>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      {view.status === "draft" && !canEdit ? (
        <Alert tone="warning">
          <p>{t(locale, "estimate.readOnly")}</p>
        </Alert>
      ) : null}
      {view.sentAt && view.expiresAt ? (
        <Card
          title={t(locale, `estimate.status.${shownStatus}` as MessageKey)}
          actions={
            view.status === "sent" &&
            !view.overdue &&
            hasPermission(session.roles, "estimate.record_approval") ? (
              <a className="btn btn-primary" href={`/${locale}/repair-orders/${id}/estimate/approve`}>
                {t(locale, "estimate.recordDecision")}
              </a>
            ) : undefined
          }
        >
          <p>
            {t(locale, "estimate.sentInfo", {
              sent: formatDubaiDateTime(view.sentAt, locale),
              expires: formatDubaiDateTime(view.expiresAt, locale),
            })}
          </p>
          <p className="muted">
            {t(locale, "estimate.contentHash")}: <bdi dir="ltr">{view.contentHash?.slice(0, 12)}</bdi>
          </p>
          {view.overdue ? <p className="muted">{t(locale, "estimate.overdue")}</p> : null}
          {view.status === "sent" && hasPermission(session.roles, "estimate.send") ? (
            <details className="disclosure">
              <summary>{t(locale, "estimate.withdraw")}</summary>
              <p className="muted">{t(locale, "estimate.withdrawHint")}</p>
              <StepForm
                locale={locale}
                action="withdraw"
                hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
                fields={[
                  {
                    name: "reasonCode",
                    label: "estimate.withdrawReason",
                    required: true,
                    placeholder: "estimate.chooseReason",
                    options: [
                      {
                        group: t(locale, "estimate.withdrawReason"),
                        items: WITHDRAW_REASONS.map((code) => ({
                          value: code,
                          label: t(locale, `estimate.endReason.${code}`),
                        })),
                      },
                    ],
                  },
                  { name: "reason", label: "estimate.withdrawReasonText" },
                ]}
                submit="estimate.withdraw"
              />
            </details>
          ) : null}
        </Card>
      ) : null}
      {canStartVersion ? (
        <Card title={t(locale, "estimate.newVersion", { no: String(view.versionNo + 1) })}>
          <p className="muted">{t(locale, "estimate.newVersionHint")}</p>
          <StepForm
            locale={locale}
            action="startVersion"
            hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
            submit="estimate.newVersion"
            submitParams={{ no: String(view.versionNo + 1) }}
            variant="primary"
          />
        </Card>
      ) : null}
      {view.earlierApproved.length > 0 ? (
        <Card title={t(locale, "estimate.approvedEarlier")}>
          <p className="muted">{t(locale, "estimate.approvedEarlierHint")}</p>
          <EarlierList locale={locale} jobs={view.earlierApproved} />
        </Card>
      ) : null}
      {view.reofferable.length > 0 ? (
        <Card title={t(locale, "estimate.notApproved")}>
          <p className="muted">
            {t(locale, canEdit ? "estimate.notApprovedHint" : "estimate.offerAgainFirst")}
          </p>
          <EarlierList
            locale={locale}
            jobs={view.reofferable}
            action={(job) =>
              canEdit ? (
                <StepForm
                  locale={locale}
                  action="repropose"
                  hidden={{ repairOrderId: id, jobId: job.jobId, idempotencyKey: randomUUID() }}
                  submit="estimate.offerAgain"
                  inline
                />
              ) : null
            }
          />
        </Card>
      ) : null}
      <p className="muted">{t(locale, "estimate.pricesIncludeVat")}</p>

      {view.urgentFindings.length > 0 ? (
        <Card title={t(locale, "estimate.urgentFindings")}>
          <p className="muted">{t(locale, "estimate.urgentHint")}</p>
          <ul className="finding-list">
            {view.urgentFindings.map((finding) => (
              <li key={finding.findingId} className="finding">
                <div className="finding-head">
                  <StatusChip tone="danger">{t(locale, "finding.severity.urgent")}</StatusChip>
                  <strong dir="auto">{finding.title}</strong>
                  <StatusChip tone={STATE_TONE[finding.state]}>
                    {t(locale, `estimate.findingState.${finding.state}` as MessageKey)}
                  </StatusChip>
                </div>
                {finding.reason ? <p dir="auto">{finding.reason}</p> : null}
                {canEdit && (finding.state === "open" || finding.state === "excluded") ? (
                  <div className="form-actions">
                    {finding.reofferJobId ? (
                      <StepForm
                        locale={locale}
                        action="repropose"
                        hidden={{
                          repairOrderId: id,
                          jobId: finding.reofferJobId,
                          idempotencyKey: randomUUID(),
                        }}
                        submit="estimate.offerAgain"
                      />
                    ) : (
                      <StepForm
                        locale={locale}
                        action="addJob"
                        hidden={{
                          repairOrderId: id,
                          findingId: finding.findingId,
                          idempotencyKey: randomUUID(),
                        }}
                        submit="estimate.include"
                      />
                    )}
                    {finding.state === "open" ? (
                      <details className="disclosure">
                        <summary>{t(locale, "estimate.exclude")}</summary>
                        <StepForm
                          locale={locale}
                          action="exclude"
                          hidden={{
                            repairOrderId: id,
                            findingId: finding.findingId,
                            idempotencyKey: randomUUID(),
                          }}
                          fields={[{ name: "reason", label: "estimate.excludeReason", required: true }]}
                          submit="estimate.exclude"
                        />
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canEdit && view.otherFindings.length > 0 ? (
        <Card title={t(locale, "estimate.otherFindings")}>
          <ul className="finding-list">
            {view.otherFindings.map((finding) => (
              <li key={finding.findingId} className="finding">
                <div className="finding-head">
                  <StatusChip tone={SEVERITY_TONE[finding.severity]}>
                    {t(locale, `finding.severity.${finding.severity}` as MessageKey)}
                  </StatusChip>
                  <strong dir="auto">{finding.title}</strong>
                </div>
                <StepForm
                  locale={locale}
                  action="addJob"
                  hidden={{ repairOrderId: id, findingId: finding.findingId, idempotencyKey: randomUUID() }}
                  submit="estimate.include"
                />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <h2>{t(locale, "estimate.jobs")}</h2>
      {view.jobs.length === 0 ? <EmptyState title={t(locale, "estimate.noJobs")} /> : null}
      {view.jobs.map((job) => (
        <Card
          key={job.id}
          title={job.title}
          actions={
            <>
              {job.findingSeverity ? (
                <StatusChip tone={SEVERITY_TONE[job.findingSeverity]}>
                  {t(locale, "estimate.fromFinding")}
                  {t(locale, "common.listSeparator")}
                  {t(locale, `finding.severity.${job.findingSeverity}` as MessageKey)}
                </StatusChip>
              ) : null}{" "}
              {job.revisionStatus !== "draft" ? (
                <StatusChip tone={REVISION_TONE[job.revisionStatus] ?? "neutral"}>
                  {t(locale, `estimate.revision.${job.revisionStatus}` as MessageKey)}
                </StatusChip>
              ) : null}
            </>
          }
        >
          {job.lines.length === 0 ? (
            <p className="muted">{t(locale, "estimate.noLines")}</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table estimate-lines">
                <thead>
                  <tr>
                    <th scope="col">{t(locale, "estimate.line.description")}</th>
                    <th scope="col">{t(locale, "estimate.line.qty")}</th>
                    <th scope="col">{t(locale, "estimate.line.unitPrice")}</th>
                    <th scope="col">{t(locale, "estimate.line.discount")}</th>
                    <th scope="col">{t(locale, "estimate.line.total")}</th>
                    {canEdit ? <th scope="col">{t(locale, "estimate.line.actions")}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {job.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <bdi>{name(line)}</bdi>
                      </td>
                      <td className="num">
                        <bdi dir="ltr">{line.qty.replace(/\.?0+$/, "")}</bdi> {unitLabel(line)}
                      </td>
                      <td className="num">{aed(line.unitPrice, locale)}</td>
                      <td className="num">{line.discount === "0.00" ? "—" : aed(line.discount, locale)}</td>
                      <td className="num">{aed(line.total, locale)}</td>
                      {canEdit ? (
                        <td>
                          <details className="disclosure">
                            <summary>{t(locale, "estimate.line.actions")}</summary>
                            <StepForm
                              locale={locale}
                              action="qty"
                              hidden={{ repairOrderId: id, lineId: line.id, idempotencyKey: randomUUID() }}
                              fields={[
                                {
                                  name: "qty",
                                  label: "estimate.qty",
                                  required: true,
                                  inputMode: "decimal",
                                  defaultValue: line.qty.replace(/\.?0+$/, ""),
                                },
                              ]}
                              submit="estimate.setQty"
                            />
                            {canDiscount ? (
                              <StepForm
                                locale={locale}
                                action="discount"
                                hidden={{ repairOrderId: id, lineId: line.id, idempotencyKey: randomUUID() }}
                                fields={[
                                  {
                                    name: "discount",
                                    label: "estimate.discountAmount",
                                    required: true,
                                    inputMode: "decimal",
                                    defaultValue: line.discount,
                                  },
                                ]}
                                submit="estimate.setDiscount"
                              />
                            ) : null}
                            <StepForm
                              locale={locale}
                              action="removeLine"
                              hidden={{ repairOrderId: id, lineId: line.id, idempotencyKey: randomUUID() }}
                              submit="estimate.removeLine"
                              variant="quiet"
                            />
                          </details>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="estimate-job-total">
            {t(locale, "estimate.jobTotal")} <strong>{aed(job.total, locale)}</strong>
          </p>
          {canEdit ? (
            <>
              <details className="disclosure">
                <summary>{t(locale, "estimate.addLine")}</summary>
                <StepForm
                  locale={locale}
                  action="addLine"
                  hidden={{ repairOrderId: id, jobId: job.id, idempotencyKey: randomUUID() }}
                  fields={lineFields}
                  submit="estimate.addLine"
                  variant="primary"
                />
              </details>
              <details className="disclosure">
                <summary>{t(locale, "estimate.removeJob")}</summary>
                <StepForm
                  locale={locale}
                  action="removeJob"
                  hidden={{ repairOrderId: id, jobId: job.id, idempotencyKey: randomUUID() }}
                  fields={[
                    {
                      name: "reason",
                      label: "estimate.removeReason",
                      required: job.findingSeverity === "urgent",
                    },
                  ]}
                  submit="estimate.removeJob"
                />
              </details>
            </>
          ) : null}
        </Card>
      ))}

      {canEdit ? (
        <Card title={t(locale, "estimate.addJob")}>
          <StepForm
            locale={locale}
            action="addJob"
            hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
            fields={[{ name: "title", label: "estimate.jobTitle", required: true }]}
            submit="estimate.addJob"
          />
        </Card>
      ) : null}

      <Card title={t(locale, "estimate.totals")}>
        <dl className="detail-list estimate-totals">
          <dt>{t(locale, "estimate.gross")}</dt>
          <dd className="num">{aed(view.totals.gross, locale)}</dd>
          <dt>{t(locale, "estimate.discountTotal")}</dt>
          <dd className="num">{aed(view.totals.discount, locale)}</dd>
          <dt>
            <strong>{t(locale, "estimate.total")}</strong>
          </dt>
          <dd className="num">
            <strong>{aed(view.totals.total, locale)}</strong>
          </dd>
          {view.totals.byRate
            .filter((rate) => rate.rate !== "0.00")
            .map((rate) => (
              <div key={rate.rate} className="contents">
                <dt>
                  {/* The rate is isolated (U+2066…U+2069) so "5%" keeps its order inside Arabic text. */}
                  {t(locale, "estimate.vatAt", { rate: `\u2066${rate.rate.replace(/\.?0+$/, "")}%\u2069` })}
                </dt>
                <dd className="num">{aed(rate.vat, locale)}</dd>
              </div>
            ))}
          <dt>{t(locale, "estimate.net")}</dt>
          <dd className="num">{aed(view.totals.net, locale)}</dd>
        </dl>
      </Card>

      {canEdit && view.versionNo > 1 ? (
        <details className="disclosure">
          <summary>{t(locale, "estimate.discardDraft")}</summary>
          <StepForm
            locale={locale}
            action="discard"
            hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
            submit="estimate.discardDraft"
            variant="quiet"
          />
        </details>
      ) : null}

      {canEdit && hasPermission(session.roles, "estimate.send") && view.jobs.length > 0 ? (
        <Card title={t(locale, "estimate.send")}>
          <p className="muted">{t(locale, "estimate.sendHint")}</p>
          <StepForm
            locale={locale}
            action="send"
            hidden={{ repairOrderId: id, idempotencyKey: randomUUID() }}
            submit="estimate.send"
            variant="primary"
          />
        </Card>
      ) : null}
    </>
  );
}
