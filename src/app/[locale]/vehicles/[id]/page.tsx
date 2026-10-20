import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { isLocale, t } from "../../../../i18n";
import { formatDubaiDateTime } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { getDb } from "../../../../server/db/client";
import { getVehicle } from "../../../../server/vehicle/service";
import { requirePagePermission } from "../../server-support";
import { PlateText } from "../plate-text";
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

  return (
    <main className="card card-wide">
      <h1>{t(locale, "vehicle.profile.title")}</h1>
      <p>
        <span dir="ltr">
          {vehicle.make} {vehicle.model} ({vehicle.year})
        </span>
        {vehicle.vin ? (
          <>
            {" "}
            · {t(locale, "vehicle.new.vin")} <span dir="ltr">{vehicle.vin}</span>
          </>
        ) : null}
      </p>
      <p>
        {t(locale, "vehicle.profile.plate")}:{" "}
        {vehicle.plate ? (
          <PlateText locale={locale} plate={vehicle.plate} />
        ) : (
          <span className="hint">{t(locale, "vehicle.profile.noPlate")}</span>
        )}
      </p>
      <p>
        {t(locale, "vehicle.profile.owner")}:{" "}
        <a href={`/${locale}/customers/${vehicle.currentOwnerCustomerId}`}>
          {vehicle.currentOwnerName ?? <span dir="ltr">{vehicle.currentOwnerCustomerId}</span>}
        </a>
      </p>

      <h2>{t(locale, "vehicle.profile.plateHistory")}</h2>
      <table>
        <tbody>
          {vehicle.plateHistory.map((row, index) => (
            <tr key={index}>
              <td>
                <PlateText locale={locale} plate={row} />
              </td>
              <td dir="ltr">{formatDubaiDateTime(row.validFrom, locale)}</td>
              <td dir="ltr">{row.validTo ? formatDubaiDateTime(row.validTo, locale) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t(locale, "vehicle.profile.ownershipHistory")}</h2>
      <table>
        <tbody>
          {vehicle.ownershipHistory.map((row, index) => (
            <tr key={index}>
              <td>
                <a href={`/${locale}/customers/${row.customerId}`}>
                  {row.customerName ?? <span dir="ltr">{row.customerId}</span>}
                </a>
              </td>
              <td dir="ltr">{formatDubaiDateTime(row.validFrom, locale)}</td>
              <td dir="ltr">{row.validTo ? formatDubaiDateTime(row.validTo, locale) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {canWrite ? (
        <>
          <h2>{t(locale, "vehicle.profile.changePlate")}</h2>
          <ChangePlateForm locale={locale} vehicleId={vehicle.id} idempotencyKey={randomUUID()} />

          <h2>{t(locale, "vehicle.profile.transferOwner")}</h2>
          <TransferOwnerForm locale={locale} vehicleId={vehicle.id} idempotencyKey={randomUUID()} />
        </>
      ) : null}
    </main>
  );
}
