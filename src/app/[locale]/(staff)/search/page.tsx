import { notFound } from "next/navigation";
import { ButtonLink, Card, EmptyState, PageHeader, PlateBadge } from "../../../../components/ui";
import { isLocale, t } from "../../../../i18n";
import { hasPermission } from "../../../../server/auth/permissions";
import { getDb } from "../../../../server/db/client";
import { searchDirectory } from "../../../../server/directory/service";
import { requirePagePermission } from "../../server-support";

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
  const q = typeof query.q === "string" ? query.q.trim() : "";
  const result = q ? await searchDirectory(getDb(), session.roles, q) : { customers: [], vehicles: [] };
  const noResults = q.length > 0 && result.customers.length === 0 && result.vehicles.length === 0;
  const canAddCustomer = hasPermission(session.roles, "customer.write");
  const canAddVehicle = hasPermission(session.roles, "vehicle.write");

  return (
    <>
      <PageHeader
        title={t(locale, "directory.search.title")}
        actions={
          <>
            {canAddCustomer ? (
              <ButtonLink href={`/${locale}/customers/new`}>{t(locale, "directory.newCustomer")}</ButtonLink>
            ) : null}
            {canAddVehicle ? (
              <ButtonLink href={`/${locale}/vehicles/new`}>{t(locale, "directory.newVehicle")}</ButtonLink>
            ) : null}
          </>
        }
      />

      <form method="get" className="search-hero" role="search">
        <label htmlFor="q" className="visually-hidden">
          {t(locale, "shell.search.label")}
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder={t(locale, "directory.search.placeholder")}
          dir="auto"
          autoFocus
        />
        <button type="submit" className="btn btn-primary">
          {t(locale, "directory.search.submit")}
        </button>
      </form>

      {!q ? (
        <EmptyState
          title={t(locale, "directory.search.emptyTitle")}
          text={t(locale, "directory.search.empty")}
        />
      ) : null}
      {noResults ? (
        <EmptyState
          title={t(locale, "directory.search.noResults")}
          text={t(locale, "directory.search.noResultsHint")}
          action={
            canAddCustomer ? (
              <ButtonLink href={`/${locale}/customers/new`} variant="primary">
                {t(locale, "directory.newCustomer")}
              </ButtonLink>
            ) : undefined
          }
        />
      ) : null}

      {result.vehicles.length > 0 ? (
        <Card title={t(locale, "directory.search.vehiclesHeading")}>
          <ul className="result-list">
            {result.vehicles.map((vehicle) => (
              <li key={vehicle.id}>
                <a href={`/${locale}/vehicles/${vehicle.id}`}>
                  {vehicle.plate ? (
                    <PlateBadge locale={locale} plate={vehicle.plate} />
                  ) : (
                    <span className="meta">{t(locale, "vehicle.profile.noPlate")}</span>
                  )}
                  <span dir="ltr">
                    {vehicle.make} {vehicle.model} ({vehicle.year})
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {result.customers.length > 0 ? (
        <Card title={t(locale, "directory.search.customersHeading")}>
          <ul className="result-list">
            {result.customers.map((customer) => (
              <li key={customer.id}>
                <a href={`/${locale}/customers/${customer.id}`}>
                  <strong>{customer.nameEn ?? customer.nameAr}</strong>
                  {customer.nameEn && customer.nameAr ? (
                    <span className="meta" dir="rtl">
                      {customer.nameAr}
                    </span>
                  ) : null}
                  {customer.contact ? (
                    <span className="meta" dir="ltr">
                      {customer.contact.mobile}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
