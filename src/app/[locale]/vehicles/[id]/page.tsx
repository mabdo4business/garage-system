import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { formatDubaiDateTime } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import { EMIRATES, getVehicle } from "../../../../server/vehicle/service";
import { changePlateAction, transferOwnerAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function VehicleProfilePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const db = getDb();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(db, token);
  if (!session) redirect(`/${locale}/login`);

  const vehicle = await getVehicle(db, id);
  if (!vehicle) notFound();
  const canWrite = hasPermission(session.roles, "vehicle.write");

  const plateText = (plate: { emirate: string; code: string; number: string }) => (
    <span dir="ltr">
      {t(locale, `emirate.${plate.emirate}` as MessageKey)} {plate.code} {plate.number}
    </span>
  );

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
            · VIN <span dir="ltr">{vehicle.vin}</span>
          </>
        ) : null}
      </p>
      <p>
        {t(locale, "vehicle.profile.plate")}: {plateText(vehicle.plate)}
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
              <td>{plateText(row)}</td>
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
                <a href={`/${locale}/customers/${row.customerId}`} dir="ltr">
                  {row.customerId}
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
          <form action={changePlateAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="vehicleId" value={vehicle.id} />
            <label htmlFor="plateEmirate">{t(locale, "vehicle.new.emirate")}</label>
            <select id="plateEmirate" name="plateEmirate" defaultValue={vehicle.plate.emirate}>
              {EMIRATES.map((emirate) => (
                <option key={emirate} value={emirate}>
                  {t(locale, `emirate.${emirate}` as MessageKey)}
                </option>
              ))}
            </select>
            <label htmlFor="plateCode">{t(locale, "vehicle.new.plateCode")}</label>
            <input id="plateCode" name="plateCode" required dir="ltr" />
            <label htmlFor="plateNumber">{t(locale, "vehicle.new.plateNumber")}</label>
            <input id="plateNumber" name="plateNumber" required dir="ltr" />
            <button type="submit">{t(locale, "vehicle.profile.submit")}</button>
          </form>

          <h2>{t(locale, "vehicle.profile.transferOwner")}</h2>
          <form action={transferOwnerAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="vehicleId" value={vehicle.id} />
            <label htmlFor="newOwnerCustomerId">{t(locale, "vehicle.profile.newOwnerId")}</label>
            <input id="newOwnerCustomerId" name="newOwnerCustomerId" required dir="ltr" />
            <button type="submit">{t(locale, "vehicle.profile.submit")}</button>
          </form>
        </>
      ) : null}
    </main>
  );
}
