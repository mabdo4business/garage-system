import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { isLocale, t } from "../../../../i18n";
import { requirePagePermission } from "../../server-support";
import { VehicleForm } from "./vehicle-form";

export const dynamic = "force-dynamic";

export default async function NewVehiclePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "vehicle.write");

  return (
    <main className="card card-wide">
      <h1>{t(locale, "vehicle.new.title")}</h1>
      <p className="hint">
        <a href={`/${locale}/search`}>{t(locale, "directory.search.title")}</a>
      </p>
      <VehicleForm locale={locale} idempotencyKey={randomUUID()} />
    </main>
  );
}
