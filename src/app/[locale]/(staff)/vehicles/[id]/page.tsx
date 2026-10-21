import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, DataTable, PageHeader, PlateBadge } from "../../../../../components/ui";
import { isLocale, t } from "../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../i18n/format";
import { hasPermission } from "../../../../../server/auth/permissions";
import { getDb } from "../../../../../server/db/client";
import { getVehicle } from "../../../../../server/vehicle/service";
import { requirePagePermission } from "../../../server-support";
import { CheckInButton } from "../../check-ins/check-in-button";
import { ChangePlateForm, TransferOwnerForm } from "./vehicle-forms";

export const dynamic = "force-dynamic";

export default async function VehicleProfilePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "vehicle.read", {
    entityType: "vehicle",
    entityId: id,
  });

  const vehicle = await getVehicle(getDb(), id);
  if (!vehicle) notFound();
  const canWrite = hasPermission(session.roles, "vehicle.write");
  const canCheckIn = hasPermission(session.roles, "repair_order.check_in");
  const when = (instant: Date | null) =>
    instant ? <bdi>{formatDubaiDateTime(instant, locale)}</bdi> : t(locale, "vehicle.profile.current");

  return (
    <>
      <PageHeader
        title={`${vehicle.make} ${vehicle.model}`}
        subtitle={
          vehicle.plate ? (
            <PlateBadge locale={locale} plate={vehicle.plate} />
          ) : (
            t(locale, "vehicle.profile.noPlate")
          )
        }
        actions={canCheckIn ? <CheckInButton locale={locale} vehicleId={vehicle.id} /> : undefined}
      />

      <Card>
        <dl className="detail-list">
          <dt>{t(locale, "vehicle.new.year")}</dt>
          <dd>
            <bdi dir="ltr">{vehicle.year}</bdi>
          </dd>
          {vehicle.vin ? (
            <>
              <dt>{t(locale, "vehicle.new.vin")}</dt>
              <dd>
                <bdi dir="ltr">{vehicle.vin}</bdi>
              </dd>
            </>
          ) : null}
          {vehicle.colour ? (
            <>
              <dt>{t(locale, "vehicle.new.colour")}</dt>
              <dd>{vehicle.colour}</dd>
            </>
          ) : null}
          <dt>{t(locale, "vehicle.profile.owner")}</dt>
          <dd>
            <a href={`/${locale}/customers/${vehicle.currentOwnerCustomerId}`}>
              {vehicle.currentOwnerName ?? <span dir="ltr">{vehicle.currentOwnerCustomerId}</span>}
            </a>
          </dd>
        </dl>
      </Card>

      <Card title={t(locale, "vehicle.profile.plateHistory")}>
        <DataTable
          columns={[
            t(locale, "vehicle.profile.plate"),
            t(locale, "vehicle.profile.from"),
            t(locale, "vehicle.profile.to"),
          ]}
          rows={vehicle.plateHistory.map((row) => [
            <PlateBadge key="plate" locale={locale} plate={row} />,
            when(row.validFrom),
            when(row.validTo),
          ])}
        />
      </Card>

      <Card title={t(locale, "vehicle.profile.ownershipHistory")}>
        <DataTable
          columns={[
            t(locale, "vehicle.profile.ownerColumn"),
            t(locale, "vehicle.profile.from"),
            t(locale, "vehicle.profile.to"),
          ]}
          rows={vehicle.ownershipHistory.map((row) => [
            <a key="owner" href={`/${locale}/customers/${row.customerId}`}>
              {row.customerName ?? <span dir="ltr">{row.customerId}</span>}
            </a>,
            when(row.validFrom),
            when(row.validTo),
          ])}
        />
      </Card>

      {canWrite ? (
        <>
          <Card title={t(locale, "vehicle.profile.changePlate")}>
            <ChangePlateForm
              locale={locale}
              vehicleId={vehicle.id}
              idempotencyKey={randomUUID()}
              currentEmirate={vehicle.plate?.emirate}
            />
          </Card>
          <Card title={t(locale, "vehicle.profile.transferOwner")}>
            <TransferOwnerForm locale={locale} vehicleId={vehicle.id} idempotencyKey={randomUUID()} />
          </Card>
        </>
      ) : null}
    </>
  );
}
