import { notFound } from "next/navigation";
import {
  ButtonLink,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  PlateBadge,
  StatusChip,
} from "../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../i18n";
import { formatDubaiDateTime } from "../../../../i18n/format";
import { hasPermission } from "../../../../server/auth/permissions";
import { getDb } from "../../../../server/db/client";
import { listOpenWork } from "../../../../server/repair-order/queries";
import { requirePagePermission } from "../../server-support";

export const dynamic = "force-dynamic";

/** Open repair orders and check-ins still in progress (deck: "Repair orders — board, check-in"). */
export default async function RepairOrdersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "repair_order.read");
  const { repairOrders, checkIns } = await listOpenWork(getDb());
  const canCheckIn = hasPermission(session.roles, "repair_order.check_in");

  return (
    <>
      <PageHeader
        title={t(locale, "nav.repairOrders")}
        actions={
          canCheckIn ? (
            <ButtonLink href={`/${locale}/search`} variant="primary">
              {t(locale, "repairOrder.newCheckIn")}
            </ButtonLink>
          ) : undefined
        }
      />

      {checkIns.length > 0 ? (
        <Card title={t(locale, "repairOrder.checkInsInProgress")}>
          <ul className="result-list">
            {checkIns.map((checkIn) => (
              <li key={checkIn.id}>
                <a href={`/${locale}/check-ins/${checkIn.id}`}>
                  {checkIn.plate ? <PlateBadge locale={locale} plate={checkIn.plate} /> : null}
                  <bdi dir="ltr">
                    {checkIn.make} {checkIn.model}
                  </bdi>
                  <span className="meta">
                    <bdi>{formatDubaiDateTime(checkIn.startedAt, locale)}</bdi>
                  </span>
                  <StatusChip tone="warning">{t(locale, "checkIn.status.in_progress")}</StatusChip>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {repairOrders.length === 0 ? (
        <EmptyState title={t(locale, "repairOrder.emptyTitle")} text={t(locale, "repairOrder.emptyText")} />
      ) : (
        <Card title={t(locale, "repairOrder.open")}>
          <DataTable
            columns={[
              t(locale, "repairOrder.number"),
              t(locale, "vehicle.profile.plate"),
              t(locale, "checkIn.vehicle"),
              t(locale, "checkIn.customer"),
              t(locale, "repairOrder.checkedIn"),
              t(locale, "repairOrder.statusColumn"),
            ]}
            rows={repairOrders.map((ro) => [
              <a key="number" href={`/${locale}/repair-orders/${ro.id}`}>
                <bdi dir="ltr">{ro.number}</bdi>
              </a>,
              ro.plate ? <PlateBadge key="plate" locale={locale} plate={ro.plate} /> : "",
              <bdi key="vehicle" dir="ltr">
                {ro.make} {ro.model}
              </bdi>,
              ro.customerName ?? "",
              <bdi key="when">{formatDubaiDateTime(ro.checkedInAt, locale)}</bdi>,
              <StatusChip key="status">
                {t(locale, `repairOrder.status.${ro.status}` as MessageKey)}
              </StatusChip>,
            ])}
          />
        </Card>
      )}
    </>
  );
}
