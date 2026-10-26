import { notFound } from "next/navigation";
import { ButtonLink } from "../../../../../../components/ui";
import { isLocale, t } from "../../../../../../i18n";
import { customerInvoice } from "../../../../../../server/billing/queries";
import { getDb } from "../../../../../../server/db/client";
import { requirePagePermission } from "../../../../server-support";
import { PrintButton } from "../../../print-button";
import { InvoiceDocument } from "./invoice-document";

export const dynamic = "force-dynamic";

/** The printed invoice (I1-09b): customer-facing, so only `customerInvoice` reaches it (rule 9). */
export default async function InvoicePrintPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "invoice.read", { entityType: "invoice", entityId: id });
  const invoice = await customerInvoice(getDb(), id);
  if (!invoice) notFound();
  return (
    <>
      <nav className="print-toolbar">
        <ButtonLink href={`/${locale}/invoices/${invoice.id}`}>{t(locale, "print.back")}</ButtonLink>
        <PrintButton label={t(locale, "print.print")} />
      </nav>
      <InvoiceDocument invoice={invoice} locale={locale} />
    </>
  );
}
