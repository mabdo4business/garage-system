import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Alert, Card, EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../../../components/ui";
import { isLocale, t, type Locale, type MessageKey } from "../../../../../../i18n";
import { formatAed } from "../../../../../../i18n/format";
import { hasPermission } from "../../../../../../server/auth/permissions";
import { KINDS, listCatalogue } from "../../../../../../server/catalog/items";
import { Money } from "../../../../../../server/core/money";
import { getDb } from "../../../../../../server/db/client";
import { estimateView, type EstimateLineView } from "../../../../../../server/estimate/queries";
import { getRepairOrder } from "../../../../../../server/repair-order/queries";
import { requirePagePermission } from "../../../../server-support";
import { NoTaxProfileBanner } from "../../../catalogue/shared";
import { StepForm, type StepField } from "./estimate-forms";

export const dynamic = "force-dynamic";

const SEVERITY_TONE = { ok: "success", soon: "warning", urgent: "danger" } as const;
const STATE_TONE = { included: "success", excluded: "neutral", open: "danger" } as const;

const aed = (amount: string, locale: Locale) => <bdi>{formatAed(Money.parse(amount), locale)}</bdi>;

/** Estimate builder (I1-05a): jobs, catalogue lines, discounts (OD-19), totals (AC-06.1, OD-18). */
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
  const canEdit = hasPermission(session.roles, "estimate.edit") && roOpen && view?.status === "draft";
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
                {t(locale, `estimate.status.${view.status}` as MessageKey)}
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
      {!canEdit ? (
        <Alert tone="warning">
          <p>{t(locale, "estimate.readOnly")}</p>
        </Alert>
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
                {canEdit && finding.state !== "included" ? (
                  <div className="form-actions">
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
            job.findingSeverity ? (
              <StatusChip tone={SEVERITY_TONE[job.findingSeverity]}>
                {t(locale, "estimate.fromFinding")}
                {t(locale, "common.listSeparator")}
                {t(locale, `finding.severity.${job.findingSeverity}` as MessageKey)}
              </StatusChip>
            ) : undefined
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
    </>
  );
}
