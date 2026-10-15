import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import { EMIRATES } from "../../../../server/vehicle/service";
import { createVehicleAction } from "./actions";

export const dynamic = "force-dynamic";

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function NewVehiclePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(getDb(), token);
  if (!session) redirect(`/${locale}/login`);

  const query = await searchParams;
  const duplicate = str(query.duplicate) === "1";
  const values = {
    vin: str(query.vin),
    make: str(query.make),
    model: str(query.model),
    year: str(query.year),
    colour: str(query.colour),
    plateEmirate: str(query.plateEmirate) || EMIRATES[0],
    plateCode: str(query.plateCode),
    plateNumber: str(query.plateNumber),
    ownerCustomerId: str(query.ownerCustomerId),
  };

  return (
    <main className="card card-wide">
      <h1>{t(locale, "vehicle.new.title")}</h1>
      {duplicate ? (
        <p role="alert" className="error">
          {t(locale, "vehicle.duplicate.heading")} — {t(locale, "vehicle.duplicate.body")}
        </p>
      ) : null}
      <p className="hint">
        <a href={`/${locale}/search`}>{t(locale, "directory.search.title")}</a>
      </p>
      <form action={createVehicleAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        {duplicate ? <input type="hidden" name="confirmDuplicate" value="1" /> : null}

        <label htmlFor="ownerCustomerId">{t(locale, "vehicle.new.owner")}</label>
        <input
          id="ownerCustomerId"
          name="ownerCustomerId"
          defaultValue={values.ownerCustomerId}
          required
          dir="ltr"
        />

        <label htmlFor="vin">{t(locale, "vehicle.new.vin")}</label>
        <input id="vin" name="vin" defaultValue={values.vin} dir="ltr" />

        <label htmlFor="make">{t(locale, "vehicle.new.make")}</label>
        <input id="make" name="make" defaultValue={values.make} required dir="ltr" />

        <label htmlFor="model">{t(locale, "vehicle.new.model")}</label>
        <input id="model" name="model" defaultValue={values.model} required dir="ltr" />

        <label htmlFor="year">{t(locale, "vehicle.new.year")}</label>
        <input id="year" name="year" type="number" defaultValue={values.year} required dir="ltr" />

        <label htmlFor="colour">{t(locale, "vehicle.new.colour")}</label>
        <input id="colour" name="colour" defaultValue={values.colour} dir="ltr" />

        <label htmlFor="plateEmirate">{t(locale, "vehicle.new.emirate")}</label>
        <select id="plateEmirate" name="plateEmirate" defaultValue={values.plateEmirate}>
          {EMIRATES.map((emirate) => (
            <option key={emirate} value={emirate}>
              {t(locale, `emirate.${emirate}` as MessageKey)}
            </option>
          ))}
        </select>

        <label htmlFor="plateCode">{t(locale, "vehicle.new.plateCode")}</label>
        <input id="plateCode" name="plateCode" defaultValue={values.plateCode} required dir="ltr" />

        <label htmlFor="plateNumber">{t(locale, "vehicle.new.plateNumber")}</label>
        <input id="plateNumber" name="plateNumber" defaultValue={values.plateNumber} required dir="ltr" />

        <button type="submit">
          {duplicate ? t(locale, "vehicle.duplicate.createAnyway") : t(locale, "vehicle.new.submit")}
        </button>
      </form>
    </main>
  );
}
