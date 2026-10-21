import { notFound } from "next/navigation";
import { Card, EmptyState, PageHeader, PlateBadge } from "../../../../components/ui";
import { isLocale, t } from "../../../../i18n";
import { formatDubaiDateTime } from "../../../../i18n/format";
import { getDb } from "../../../../server/db/client";
import { myInspections } from "../../../../server/inspection/queries";
import { requirePagePermission } from "../../server-support";

export const dynamic = "force-dynamic";

/** The technician's assigned inspections — vehicle and concerns only: no contact details, no prices. */
export default async function MyInspectionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "inspection.my_work");
  const items = await myInspections(getDb(), session.userId);

  return (
    <div className="workshop">
      <PageHeader title={t(locale, "nav.myInspections")} />
      {items.length === 0 ? (
        <EmptyState
          title={t(locale, "inspection.noneAssigned")}
          text={t(locale, "inspection.noneAssignedHint")}
        />
      ) : (
        <Card>
          <ul className="result-list">
            {items.map((item) => (
              <li key={item.repairOrderId}>
                <a href={`/${locale}/repair-orders/${item.repairOrderId}/inspection`}>
                  {item.plate ? <PlateBadge locale={locale} plate={item.plate} /> : null}
                  <bdi dir="ltr">
                    {item.make} {item.model}
                  </bdi>
                  <bdi dir="ltr" className="meta">
                    {item.number}
                  </bdi>
                  <span className="meta" dir="auto">
                    {item.concerns}
                  </span>
                  <span className="meta">
                    <bdi>{formatDubaiDateTime(item.assignedAt, locale)}</bdi>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
