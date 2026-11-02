import type { ReactNode } from "react";
import { t, type Locale, type MessageKey } from "../../../../../../i18n";
import { formatAmount } from "../../../../../../i18n/format";
import type { CustomerInvoice } from "../../../../../../server/billing/queries";
import { Money, Qty } from "../../../../../../server/core/money";

/**
 * The printed invoice (I1-09b). Built only from `customerInvoice` — no parts cost, tax-change notice or staff names
 * (rule 9, AC2-31 pattern) — plus the business profile version recorded at issue (OD-46). Arabic and English on one
 * page (OD-48): the page's language comes first. Titles per OD-42; VAT columns and the TRN only when registered
 * (AC2-19). A line whose tax changed since approval prints its excl.-VAT unit price, net, VAT and total, never the
 * approved inclusive price (OD-45). Discounts are already inside the excl.-VAT unit price (no discount column).
 */

const amount = (value: string) => <bdi dir="ltr">{formatAmount(Money.parse(value))}</bdi>;
const trimQty = (qty: string) => qty.replace(/\.?0+$/, "") || "0";
const trimRate = (rate: string) => rate.replace(/\.?0+$/, "") || "0";

/** One label in both languages, the page's language first. */
function Both({ locale, k }: { locale: Locale; k: MessageKey }) {
  const order: Locale[] = locale === "ar" ? ["ar", "en"] : ["en", "ar"];
  return (
    <span className="bilingual">
      {order.map((lang) => (
        <span key={lang} lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
          {t(lang, k)}
        </span>
      ))}
    </span>
  );
}

/** Two values (Arabic and English text of the same thing), the page's language first; missing ones are skipped. */
function Pair({ locale, ar, en }: { locale: Locale; ar: string | null; en: string | null }) {
  const values: [Locale, string | null][] =
    locale === "ar"
      ? [
          ["ar", ar],
          ["en", en],
        ]
      : [
          ["en", en],
          ["ar", ar],
        ];
  return (
    <span className="bilingual">
      {values
        .filter((entry): entry is [Locale, string] => Boolean(entry[1]))
        .map(([lang, value]) => (
          <span key={lang} lang={lang} dir={lang === "ar" ? "rtl" : "ltr"}>
            {value}
          </span>
        ))}
    </span>
  );
}

function unitKey(unit: string | null): MessageKey | null {
  if (unit === "hour") return "estimate.unit.hour";
  return unit ? (`catalogue.unit.${unit}` as MessageKey) : null;
}

/** T-31: the unit price is rounded; flag the lines where qty × unit price is not the exact line amount. */
function roundedLine(line: CustomerInvoice["lines"][number]): boolean {
  return (
    Qty.parse(line.qty).milli * Money.parse(line.unitPriceNet).fils !== Money.parse(line.net).fils * 1000n
  );
}

function Detail({ locale, k, children }: { locale: Locale; k: MessageKey; children: ReactNode }) {
  return (
    <>
      <dt>
        <Both locale={locale} k={k} />
      </dt>
      <dd>{children}</dd>
    </>
  );
}

export function InvoiceDocument({ invoice, locale }: { invoice: CustomerInvoice; locale: Locale }) {
  const registered = invoice.registrationStatus === "registered";
  const business = invoice.business;
  const plate = invoice.vehicle.plate;
  const anyRounded = invoice.lines.some(roundedLine);

  return (
    <article className="invoice-print">
      <header className="invoice-print-head">
        <div className="invoice-print-business">
          {business ? (
            <>
              <h2>
                <Pair locale={locale} ar={business.legalNameAr} en={business.legalNameEn} />
              </h2>
              <p>
                <Pair locale={locale} ar={business.addressAr} en={business.addressEn} />
              </p>
              <p>
                <Both locale={locale} k="print.phone" /> <bdi dir="ltr">{business.phone}</bdi>
              </p>
            </>
          ) : (
            <p className="muted">
              <Both locale={locale} k="print.noProfile" />
            </p>
          )}
          {registered && invoice.trn ? (
            <p>
              <Both locale={locale} k="print.trn" /> <bdi dir="ltr">{invoice.trn}</bdi>
            </p>
          ) : null}
        </div>
        <h1 className="invoice-print-title">
          <Both locale={locale} k={registered ? "print.taxInvoice" : "print.invoice"} />
        </h1>
      </header>

      <dl className="invoice-print-facts">
        <Detail locale={locale} k="print.invoiceNumber">
          <bdi dir="ltr">{invoice.number}</bdi>
        </Detail>
        <Detail locale={locale} k="print.invoiceDate">
          <bdi dir="ltr">{invoice.businessDate}</bdi>
        </Detail>
        <Detail locale={locale} k="print.repairOrder">
          <bdi dir="ltr">{invoice.repairOrderNumber}</bdi>
        </Detail>
        <Detail locale={locale} k="print.customer">
          <Pair locale={locale} ar={invoice.customerNameAr} en={invoice.customerNameEn} />
        </Detail>
        <Detail locale={locale} k="print.vehicle">
          <bdi dir="ltr">
            {invoice.vehicle.make} {invoice.vehicle.model} {invoice.vehicle.year}
          </bdi>
        </Detail>
        {plate ? (
          <Detail locale={locale} k="print.plate">
            <Pair
              locale={locale}
              ar={t("ar", `emirate.${plate.emirate}` as MessageKey)}
              en={t("en", `emirate.${plate.emirate}` as MessageKey)}
            />{" "}
            <bdi dir="ltr">
              {plate.code} {plate.number}
            </bdi>
          </Detail>
        ) : null}
        {invoice.vehicle.vin ? (
          <Detail locale={locale} k="print.vin">
            <bdi dir="ltr">{invoice.vehicle.vin}</bdi>
          </Detail>
        ) : null}
      </dl>

      <table className="invoice-print-lines">
        <thead>
          <tr>
            <th scope="col">
              <Both locale={locale} k="print.description" />
            </th>
            <th scope="col">
              <Both locale={locale} k="print.qty" />
            </th>
            <th scope="col">
              <Both locale={locale} k={registered ? "print.unitPriceExVat" : "print.unitPrice"} />
            </th>
            <th scope="col">
              <Both locale={locale} k={registered ? "print.amountExVat" : "print.amount"} />
            </th>
            {registered ? (
              <>
                <th scope="col">
                  <Both locale={locale} k="print.vatRate" />
                </th>
                <th scope="col">
                  <Both locale={locale} k="print.vat" />
                </th>
                <th scope="col">
                  <Both locale={locale} k="print.lineTotal" />
                </th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => {
            const unit = unitKey(line.unit);
            return (
              <tr key={line.id}>
                <td>
                  <Pair locale={locale} ar={line.descriptionAr} en={line.descriptionEn} />
                </td>
                <td className="num">
                  <bdi dir="ltr">{trimQty(line.qty)}</bdi>
                  {unit ? (
                    <>
                      {" "}
                      <Pair locale={locale} ar={t("ar", unit)} en={t("en", unit)} />
                    </>
                  ) : null}
                </td>
                <td className="num">
                  {amount(line.unitPriceNet)}
                  {roundedLine(line) ? <sup>*</sup> : null}
                </td>
                <td className="num">{amount(line.net)}</td>
                {registered ? (
                  <>
                    <td className="num">
                      <bdi dir="ltr">{trimRate(line.taxRate)}%</bdi>
                    </td>
                    <td className="num">{amount(line.vat)}</td>
                    <td className="num">{amount(line.total)}</td>
                  </>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>

      <dl className="invoice-print-totals">
        {registered ? (
          <>
            <Detail locale={locale} k="print.totalExVat">
              {amount(invoice.net)}
            </Detail>
            <Detail locale={locale} k="print.totalVat">
              {amount(invoice.vat)}
            </Detail>
          </>
        ) : null}
        <Detail locale={locale} k="print.invoiceTotal">
          <strong>{amount(invoice.total)}</strong>
        </Detail>
      </dl>

      <footer className="invoice-print-notes">
        <p>
          <Both locale={locale} k="print.currency" />
        </p>
        {anyRounded ? (
          <p>
            <sup>*</sup>{" "}
            <Both locale={locale} k={registered ? "print.roundingNote" : "print.roundingNoteNoVat"} />
          </p>
        ) : null}
      </footer>
    </article>
  );
}
