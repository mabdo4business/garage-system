import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { getDb } from "../../../../server/db/client";
import { myJobs } from "../../../../server/workshop/queries";
import { requirePagePermission } from "../../server-support";
import { JOB_TONE } from "./shared";

export const dynamic = "force-dynamic";

/** US-07.3: the jobs assigned to me — vehicle and work only: no prices, no customer contact. */
export default async function MyJobsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "workshop.my_jobs");
  const jobs = await myJobs(getDb(), session.userId);
  return (
    <div className="workshop">
      <PageHeader title={t(locale, "nav.myJobs")} />
      {jobs.length === 0 ? (
        <EmptyState title={t(locale, "job.noneAssigned")} text={t(locale, "job.noneAssignedHint")} />
      ) : (
        <Card>
          <ul className="result-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <a href={`/${locale}/jobs/${job.id}`}>
                  {job.plate ? <PlateBadge locale={locale} plate={job.plate} /> : null}
                  <strong dir="auto">{job.title}</strong>
                  <bdi dir="ltr" className="meta">
                    {job.make} {job.model} · {job.repairOrderNumber}
                  </bdi>
                  {job.bay ? (
                    <span className="meta">
                      {t(locale, "workshop.bay")}: <bdi>{job.bay}</bdi>
                    </span>
                  ) : null}
                  <StatusChip tone={JOB_TONE[job.status]}>
                    {t(locale, `job.status.${job.status}` as MessageKey)}
                  </StatusChip>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
