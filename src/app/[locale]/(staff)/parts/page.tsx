import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { formatAed } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { Money, Qty } from "../../../../server/core/money";
import { getDb } from "../../../../server/db/client";
import { partsForOpenJobs } from "../../../../server/inventory/queries";
import { ActionForm } from "../../action-form";
import { requirePagePermission } from "../../server-support";
import { JOB_TONE } from "../jobs/shared";
import { issueAction, receiveAndIssueAction, waitingPartsAction } from "../stock/actions";

export const dynamic = "force-dynamic";

const trim = (qty: string) => qty.replace(/\.?0+$/, "") || "0";

/**
 * Parts for jobs (I1-07): approved part lines of running work. Issue from stock, or receive-and-issue a
 * special order / non-stock item with its supplier cost (T-23, OD-30); mark a job waiting for parts (B2).
 */
export default async function PartsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "stock.read");
  const lines = await partsForOpenJobs(getDb());
  const canIssue = hasPermission(session.roles, "stock.issue");
  const name = (line: { descriptionEn: string; descriptionAr: string }) =>
    locale === "ar" ? line.descriptionAr : line.descriptionEn;
  const field = (id: string, label: MessageKey, props: Record<string, unknown> = {}) => (
    <div className="field">
      <label htmlFor={id}>{t(locale, label)}</label>
      <input id={id} {...props} />
    </div>
  );

  return (
    <>
      <PageHeader title={t(locale, "parts.title")} subtitle={t(locale, "parts.subtitle")} />
      {lines.length === 0 ? <EmptyState title={t(locale, "parts.empty")} /> : null}
      <ul className="finding-list">
        {lines.map((line) => {
          const covered = Qty.parse(line.costedQty).compare(Qty.parse(line.approvedQty)) >= 0;
          return (
            <li key={line.lineId} className="finding" data-line={line.lineId}>
              <div className="finding-head">
                {line.plate ? <PlateBadge locale={locale} plate={line.plate} /> : null}
                <bdi dir="ltr">{line.repairOrderNumber}</bdi>
                <strong dir="auto">{line.jobTitle}</strong>
                <StatusChip tone={JOB_TONE[line.jobStatus]}>
                  {t(locale, `job.status.${line.jobStatus}` as MessageKey)}
                </StatusChip>
              </div>
              <p>
                <bdi>{name(line)}</bdi>{" "}
                {line.itemCode ? (
                  <bdi dir="ltr" className="muted">
                    {line.itemCode}
                  </bdi>
                ) : null}{" "}
                <StatusChip tone={line.stockTracked ? "info" : "neutral"}>
                  {t(locale, line.stockTracked ? "parts.stockPart" : "parts.nonStock")}
                </StatusChip>
              </p>
              <p className="muted">
                {t(locale, "parts.progress", {
                  costed: trim(line.costedQty),
                  approved: trim(line.approvedQty),
                })}
                {line.onHand !== null ? (
                  <>
                    {t(locale, "common.listSeparator")}
                    {t(locale, "parts.onHand", { qty: trim(line.onHand) })}
                  </>
                ) : null}
                {t(locale, "common.listSeparator")}
                {t(locale, "parts.cost")}: <bdi>{formatAed(Money.parse(line.cost), locale)}</bdi>
              </p>
              {canIssue ? (
                <div className="form-actions">
                  {line.stockTracked ? (
                    <details className="disclosure">
                      <summary>{t(locale, "parts.issue")}</summary>
                      <ActionForm
                        locale={locale}
                        action={issueAction}
                        hidden={{ lineId: line.lineId, idempotencyKey: randomUUID() }}
                        submit="parts.issue"
                        variant="primary"
                      >
                        {field(`issue-qty-${line.lineId}`, "estimate.line.qty", {
                          name: "qty",
                          required: true,
                          inputMode: "decimal",
                          dir: "ltr",
                          defaultValue: covered ? "" : "1",
                        })}
                        {field(`issue-over-${line.lineId}`, "parts.overReason", {
                          name: "overReason",
                          dir: "auto",
                        })}
                      </ActionForm>
                    </details>
                  ) : null}
                  <details className="disclosure">
                    <summary>{t(locale, "parts.receiveAndIssue")}</summary>
                    <ActionForm
                      locale={locale}
                      action={receiveAndIssueAction}
                      hidden={{ lineId: line.lineId, idempotencyKey: randomUUID() }}
                      submit="parts.receiveAndIssue"
                    >
                      <p className="muted">{t(locale, "stock.costHint")}</p>
                      {field(`rai-qty-${line.lineId}`, "estimate.line.qty", {
                        name: "qty",
                        required: true,
                        inputMode: "decimal",
                        dir: "ltr",
                      })}
                      {field(`rai-amount-${line.lineId}`, "stock.amount", {
                        name: "amount",
                        required: true,
                        inputMode: "decimal",
                        dir: "ltr",
                      })}
                      {field(`rai-supplier-${line.lineId}`, "stock.supplierName", {
                        name: "supplierName",
                        required: true,
                        dir: "auto",
                      })}
                      {field(`rai-ref-${line.lineId}`, "stock.supplierRef", {
                        name: "supplierRef",
                        required: true,
                        dir: "ltr",
                      })}
                      {field(`rai-over-${line.lineId}`, "parts.overReason", {
                        name: "overReason",
                        dir: "auto",
                      })}
                    </ActionForm>
                  </details>
                  {line.jobStatus === "authorized" && !covered ? (
                    <ActionForm
                      locale={locale}
                      action={waitingPartsAction}
                      hidden={{ jobId: line.jobId, idempotencyKey: randomUUID() }}
                      submit="parts.markWaiting"
                      variant="quiet"
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
