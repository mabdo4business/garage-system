import { randomUUID } from "node:crypto";
import { Alert, Card, StatusChip } from "../../../../../../components/ui";
import { t, type Locale } from "../../../../../../i18n";
import { dubaiDate, formatAed } from "../../../../../../i18n/format";
import { Money } from "../../../../../../server/core/money";
import { getDb } from "../../../../../../server/db/client";
import { repairOrderBilling } from "../../../../../../server/billing/queries";
import { ActionForm } from "../../../../action-form";
import { createDraftAction, discardAction, issueAction } from "./actions";

const aed = (amount: string, locale: Locale) => <bdi>{formatAed(Money.parse(amount), locale)}</bdi>;
const trim = (qty: string) => qty.replace(/\.?0+$/, "") || "0";

/** The repair order's invoice (I1-09a): issued invoice, or drafts previewed at today's tax, or the way to start one. */
export async function InvoiceCard({
  locale,
  repairOrderId,
  canIssue,
  qcPassed,
}: {
  locale: Locale;
  repairOrderId: string;
  canIssue: boolean;
  qcPassed: boolean;
}) {
  const billing = await repairOrderBilling(getDb(), repairOrderId, dubaiDate(new Date()));
  if (!billing.invoice && billing.drafts.length === 0 && !qcPassed) return null;
  return (
    <Card title={t(locale, "invoice.title")}>
      {billing.invoice ? (
        <p>
          <StatusChip tone="success">{t(locale, "invoice.issued")}</StatusChip>{" "}
          <a href={`/${locale}/invoices/${billing.invoice.id}`}>
            <bdi dir="ltr">{billing.invoice.number}</bdi>
          </a>{" "}
          {aed(billing.invoice.total, locale)}
        </p>
      ) : null}
      {billing.drafts.map((draft) => (
        <div key={draft.id} className="invoice-draft" data-draft={draft.id}>
          <h3>{t(locale, "invoice.draft")}</h3>
          {draft.previewError ? (
            <Alert tone="warning">
              <p>
                {t(
                  locale,
                  draft.previewError === "no_tax_profile" ? "error.noTaxProfile" : "error.noTaxRate",
                )}
              </p>
            </Alert>
          ) : null}
          {draft.preview ? (
            <>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">{t(locale, "estimate.line.description")}</th>
                      <th scope="col">{t(locale, "estimate.line.qty")}</th>
                      <th scope="col">{t(locale, "invoice.net")}</th>
                      <th scope="col">{t(locale, "invoice.vat")}</th>
                      <th scope="col">{t(locale, "estimate.line.total")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.preview.lines.map((line) => (
                      <tr key={line.revisionLineId} className={line.taxChanged ? "tax-changed" : undefined}>
                        <td>
                          <bdi>{locale === "ar" ? line.descriptionAr : line.descriptionEn}</bdi>
                        </td>
                        <td className="num">
                          <bdi dir="ltr">{trim(line.qty)}</bdi>
                        </td>
                        <td className="num">{aed(line.net, locale)}</td>
                        <td className="num">
                          {aed(line.vat, locale)}{" "}
                          <bdi dir="ltr" className="muted">
                            ({trim(line.taxRate)}%)
                          </bdi>
                        </td>
                        <td className="num">{aed(line.total, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="detail-list">
                <dt>{t(locale, "invoice.net")}</dt>
                <dd className="num">{aed(draft.preview.net, locale)}</dd>
                <dt>{t(locale, "invoice.vat")}</dt>
                <dd className="num">{aed(draft.preview.vat, locale)}</dd>
                <dt>
                  <strong>{t(locale, "invoice.total")}</strong>
                </dt>
                <dd className="num">
                  <strong>{aed(draft.preview.total, locale)}</strong>
                </dd>
              </dl>
              {canIssue ? (
                <div className="form-actions">
                  <ActionForm
                    locale={locale}
                    action={issueAction}
                    hidden={{ draftId: draft.id, idempotencyKey: randomUUID() }}
                    submit="invoice.issue"
                    variant="primary"
                  >
                    {draft.preview.taxChanged ? (
                      <Alert tone="warning">
                        <p>{t(locale, "invoice.taxChanged")}</p>
                        <div className="field">
                          <label htmlFor={`notice-${draft.id}`}>{t(locale, "invoice.taxChangeNotice")}</label>
                          <textarea
                            id={`notice-${draft.id}`}
                            name="taxChangeNotice"
                            required
                            maxLength={1000}
                          />
                        </div>
                      </Alert>
                    ) : null}
                  </ActionForm>
                  <ActionForm
                    locale={locale}
                    action={discardAction}
                    hidden={{ draftId: draft.id, repairOrderId, idempotencyKey: randomUUID() }}
                    submit="invoice.discard"
                    variant="quiet"
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ))}
      {!billing.invoice && billing.drafts.length === 0 && qcPassed && canIssue ? (
        <ActionForm
          locale={locale}
          action={createDraftAction}
          hidden={{ repairOrderId, idempotencyKey: randomUUID() }}
          submit="invoice.createDraft"
          variant="primary"
        />
      ) : null}
    </Card>
  );
}
