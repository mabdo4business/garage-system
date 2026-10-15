import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale, t, type MessageKey } from "../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../server/auth/session";
import { getDb } from "../../../server/db/client";
import { searchDirectory, type DirectoryVehicleResult } from "../../../server/directory/service";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const db = getDb();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(db, token);
  if (!session) redirect(`/${locale}/login`);

  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q : "";
  const result = q ? await searchDirectory(db, session.roles, q) : { customers: [], vehicles: [] };
  const noResults = q.length > 0 && result.customers.length === 0 && result.vehicles.length === 0;

  const plateText = (plate: DirectoryVehicleResult["plate"]) => (
    <span dir="ltr">
      {t(locale, `emirate.${plate.emirate}` as MessageKey)} {plate.code} {plate.number}
    </span>
  );

  return (
    <main className="card card-wide">
      <h1>{t(locale, "directory.search.title")}</h1>
      <form method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder={t(locale, "directory.search.placeholder")}
          dir="ltr"
          autoFocus
        />
        <button type="submit">{t(locale, "directory.search.submit")}</button>
      </form>
      <p>
        <a href={`/${locale}/customers/new`}>{t(locale, "directory.newCustomer")}</a>
        {" · "}
        <a href={`/${locale}/vehicles/new`}>{t(locale, "directory.newVehicle")}</a>
      </p>

      {noResults ? <p className="hint">{t(locale, "directory.search.noResults")}</p> : null}

      {result.customers.length > 0 ? (
        <>
          <h2>{t(locale, "directory.search.customersHeading")}</h2>
          <ul className="results">
            {result.customers.map((customer) => (
              <li key={customer.id}>
                <a href={`/${locale}/customers/${customer.id}`}>
                  {customer.nameEn ?? customer.nameAr ?? <span dir="ltr">{customer.id}</span>}
                </a>
                {customer.contact ? (
                  <span className="hint">
                    {" "}
                    · <span dir="ltr">{customer.contact.mobile}</span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {result.vehicles.length > 0 ? (
        <>
          <h2>{t(locale, "directory.search.vehiclesHeading")}</h2>
          <ul className="results">
            {result.vehicles.map((vehicle) => (
              <li key={vehicle.id}>
                <a href={`/${locale}/vehicles/${vehicle.id}`}>
                  {plateText(vehicle.plate)} —{" "}
                  <span dir="ltr">
                    {vehicle.make} {vehicle.model} ({vehicle.year})
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
