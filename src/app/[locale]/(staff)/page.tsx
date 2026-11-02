import { notFound, redirect } from "next/navigation";
import { LiveRefresh } from "../../../components/dashboard/motion";
import { quickActionsFor } from "../../../components/shell/nav";
import { ButtonLink, PageHeader } from "../../../components/ui";
import { isLocale, t } from "../../../i18n";
import { dubaiDate, formatDubaiTime } from "../../../i18n/format";
import { requirePageSession } from "../server-support";
import { hasPermission } from "../../../server/auth/permissions";
import { getDb } from "../../../server/db/client";
import {
  DASHBOARD_STATUSES,
  dashboardModeFor,
  dashboardSummary,
  type DashboardStatus,
} from "../../../server/reporting/dashboard";
import { NoTaxProfileBanner } from "./catalogue/shared";
import { DashboardView } from "./dashboard-view";

export const dynamic = "force-dynamic";

/**
 * Today. Front-office roles (dashboard.read) get the workshop dashboard (OD-50), with money for dashboard.money
 * holders only; technicians go straight to My jobs; everyone else gets the business date and their shortcuts.
 */
export default async function TodayPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ stage?: string | string[] }>;
}) {
  const { locale } = await params;
  const { stage } = await searchParams;
  if (!isLocale(locale)) notFound();
  const session = await requirePageSession(locale);
  const db = getDb();
  const banner = hasPermission(session.roles, "catalogue.read") ? (
    <NoTaxProfileBanner db={db} locale={locale} />
  ) : null;

  const { mode, money } = dashboardModeFor(session.roles);
  if (mode === "dashboard") {
    const now = new Date();
    const summary = await dashboardSummary(db, { money, now });
    const chosen = (DASHBOARD_STATUSES as readonly string[]).includes(String(stage))
      ? (stage as DashboardStatus)
      : null;
    return (
      <>
        {banner}
        <DashboardView
          summary={summary}
          locale={locale}
          stage={chosen}
          actions={
            <>
              <LiveRefresh locale={locale} renderedAt={formatDubaiTime(now, locale)} />
              {hasPermission(session.roles, "repair_order.check_in") ? (
                <ButtonLink href={`/${locale}/search`} variant="primary">
                  {t(locale, "dashboard.newCheckIn")}
                </ButtonLink>
              ) : null}
            </>
          }
        />
      </>
    );
  }
  if (mode === "my_jobs") redirect(`/${locale}/jobs`);

  const actions = quickActionsFor(session.roles);
  return (
    <>
      <PageHeader
        title={t(locale, "today.greeting", { name: session.displayName })}
        subtitle={t(locale, "home.businessDate", { date: dubaiDate(new Date()) })}
      />
      {banner}
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
