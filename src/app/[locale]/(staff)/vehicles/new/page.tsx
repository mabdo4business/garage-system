import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "../../../../../components/ui";
import { isLocale, t } from "../../../../../i18n";
import { requirePagePermission } from "../../../server-support";
import { VehicleForm } from "./vehicle-form";

export const dynamic = "force-dynamic";

export default async function NewVehiclePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "vehicle.write");

  return (
    <>
      <PageHeader title={t(locale, "vehicle.new.title")} />
      <Card>
        <VehicleForm locale={locale} idempotencyKey={randomUUID()} />
      </Card>
    </>
  );
}
