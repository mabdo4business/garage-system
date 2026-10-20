import { notFound } from "next/navigation";
import { isLocale, t } from "../../../i18n";
import { getDb } from "../../../server/db/client";
import { searchDirectory } from "../../../server/directory/service";
import { requirePagePermission } from "../server-support";
import { PlateText } from "../vehicles/plate-text";

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
  const session = await requirePagePermission(locale, "directory.search");

  const query = await searchParams;
  const q = typeof query.q === "string" ? query.q : "";
  const result = q ? await searchDirectory(getDb(), session.roles, q) : { customers: [], vehicles: [] };
  const noResults = q.length > 0 && result.customers.length === 0 && result.vehicles.length === 0;

  return (
    <main className="card card-wide">
      <h1>{t(locale, "directory.search.title")}</h1>
      <form method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder={t(locale, "directory.search.placeholder")}
          dir="auto"
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
                  {vehicle.plate ? (
                    <PlateText locale={locale} plate={vehicle.plate} />
                  ) : (
                    t(locale, "vehicle.profile.noPlate")
                  )}{" "}
                  —{" "}
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
