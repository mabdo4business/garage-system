import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { isLocale, t } from "../../../../i18n";
import { requirePagePermission } from "../../server-support";
import { CustomerForm } from "./customer-form";

export const dynamic = "force-dynamic";

export default async function NewCustomerPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "customer.write");

  return (
    <main className="card card-wide">
      <h1>{t(locale, "customer.new.title")}</h1>
      <CustomerForm locale={locale} idempotencyKey={randomUUID()} />
    </main>
  );
}
