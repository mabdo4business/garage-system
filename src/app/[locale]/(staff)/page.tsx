import { notFound } from "next/navigation";
import { quickActionsFor } from "../../../components/shell/nav";
import { PageHeader } from "../../../components/ui";
import { isLocale, t } from "../../../i18n";
import { dubaiDate } from "../../../i18n/format";
import { requirePageSession } from "../server-support";
import { hasPermission } from "../../../server/auth/permissions";
import { getDb } from "../../../server/db/client";
import { NoTaxProfileBanner } from "./catalogue/shared";

export const dynamic = "force-dynamic";

/**
 * Today (deck: bookings, cars on site, alerts). Those panels arrive with the stories that create
 * the data (I1-02 repair orders, I5-05 bookings); until then: who you are, the business date and
 * the actions your role can take.
 */
export default async function TodayPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePageSession(locale);
  const actions = quickActionsFor(session.roles);

  return (
    <>
      <PageHeader
        title={t(locale, "today.greeting", { name: session.displayName })}
        subtitle={t(locale, "home.businessDate", { date: dubaiDate(new Date()) })}
      />
      {hasPermission(session.roles, "catalogue.read") ? (
        <NoTaxProfileBanner db={getDb()} locale={locale} />
      ) : null}
      <section aria-labelledby="quick-actions">
        <h2 id="quick-actions" className="visually-hidden">
          {t(locale, "today.quickActions")}
        </h2>
        <div className="quick-actions">
          {actions.map((action) => (
            <a key={action.key} href={`/${locale}${action.path}`}>
              <strong>{t(locale, action.label)}</strong>
              <span>{t(locale, action.description)}</span>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}
