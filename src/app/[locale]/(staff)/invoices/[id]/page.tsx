import { notFound } from "next/navigation";
import { Card, PageHeader, PlateBadge, StatusChip } from "../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../i18n";
import { formatAed, formatDubaiDateTime } from "../../../../../i18n/format";
import { hasPermission } from "../../../../../server/auth/permissions";
import { invoiceView } from "../../../../../server/billing/queries";
import { Money } from "../../../../../server/core/money";
import { getDb } from "../../../../../server/db/client";
import { requirePagePermission } from "../../../server-support";

export const dynamic = "force-dynamic";

const aed = (amount: string, locale: "ar" | "en") => <bdi>{formatAed(Money.parse(amount), locale)}</bdi>;
const trim = (qty: string) => qty.replace(/\.?0+$/, "") || "0";

/** The issued invoice on screen for staff (I1-09a). Immutable: corrections are credit notes (I3). */
export default async function InvoicePage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "invoice.read", {
    entityType: "invoice",
    entityId: id,
  });
  const invoice = await invoiceView(getDb(), id);
  if (!invoice) notFound();
  const showCost = hasPermission(session.roles, "stock.read"); // T-24
  const registered = invoice.registrationStatus === "registered";

  return (
    <>
      <PageHeader
        title={
          <>
            {t(locale, "invoice.title")} <bdi dir="ltr">{invoice.number}</bdi>
          </>
        }
        subtitle={
          <>
            {invoice.vehicle.plate ? <PlateBadge locale={locale} plate={invoice.vehicle.plate} /> : null}{" "}
            <bdi dir="ltr">
              {invoice.vehicle.make} {invoice.vehicle.model} · {invoice.repairOrderNumber}
            </bdi>{" "}
            <StatusChip tone="success">{t(locale, "invoice.issued")}</StatusChip>
          </>
        }
      />
      <Card>
        <dl className="detail-list">
          <dt>{t(locale, "invoice.customer")}</dt>
          <dd>
            <bdi>
              {(locale === "ar" ? invoice.customerNameAr : invoice.customerNameEn) ??
                invoice.customerNameEn ??
                invoice.customerNameAr}
            </bdi>
          </dd>
          <dt>{t(locale, "invoice.date")}</dt>
          <dd>
            <bdi dir="ltr">{formatDubaiDateTime(invoice.issuedAt, locale)}</bdi>
          </dd>
          <dt>{t(locale, "invoice.taxPosition")}</dt>
          <dd>
            {t(locale, `invoice.registration.${invoice.registrationStatus}` as MessageKey)}
            {invoice.trn ? (
              <>
                {t(locale, "common.listSeparator")}
                {t(locale, "tax.trn")}: <bdi dir="ltr">{invoice.trn}</bdi>
              </>
            ) : null}
          </dd>
          {invoice.taxChangeNotice ? (
            <>
              <dt>{t(locale, "invoice.taxChangeNotice")}</dt>
              <dd dir="auto">{invoice.taxChangeNotice}</dd>
            </>
          ) : null}
        </dl>
      </Card>
      <Card>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t(locale, "estimate.line.description")}</th>
                <th scope="col">{t(locale, "estimate.line.qty")}</th>
                <th scope="col">{t(locale, "estimate.line.discount")}</th>
                <th scope="col">{t(locale, "invoice.net")}</th>
                {registered ? <th scope="col">{t(locale, "invoice.vat")}</th> : null}
                <th scope="col">{t(locale, "estimate.line.total")}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <bdi>{locale === "ar" ? line.descriptionAr : line.descriptionEn}</bdi>
                  </td>
                  <td className="num">
                    <bdi dir="ltr">{trim(line.qty)}</bdi>
                  </td>
                  <td className="num">{line.discount === "0.00" ? "—" : aed(line.discount, locale)}</td>
                  <td className="num">{aed(line.net, locale)}</td>
                  {registered ? (
                    <td className="num">
                      {aed(line.vat, locale)}{" "}
                      <bdi dir="ltr" className="muted">
                        ({trim(line.taxRate)}%)
                      </bdi>
                    </td>
                  ) : null}
                  <td className="num">{aed(line.total, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="detail-list">
          <dt>{t(locale, "invoice.net")}</dt>
          <dd className="num">{aed(invoice.net, locale)}</dd>
          {registered ? (
            <>
              <dt>{t(locale, "invoice.vat")}</dt>
              <dd className="num">{aed(invoice.vat, locale)}</dd>
            </>
          ) : null}
          <dt>
            <strong>{t(locale, "invoice.total")}</strong>
          </dt>
          <dd className="num">
            <strong>{aed(invoice.total, locale)}</strong>
          </dd>
          {showCost ? (
            <>
              <dt>{t(locale, "invoice.cogs")}</dt>
              <dd className="num">{aed(invoice.cogs, locale)}</dd>
            </>
          ) : null}
        </dl>
        <p className="muted">{t(locale, "invoice.immutable")}</p>
      </Card>
    </>
  );
}
