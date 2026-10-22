import { notFound } from "next/navigation";
import { Card, PageHeader, PlateBadge, StatusChip } from "../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../i18n/format";
import { hasPermission } from "../../../../../server/auth/permissions";
import { getDb } from "../../../../../server/db/client";
import { getRepairOrder } from "../../../../../server/repair-order/queries";
import { requirePagePermission } from "../../../server-support";
import { ExcludePhotoForm } from "./exclude-photo-form";
import { getInspection, listTechnicians } from "../../../../../server/inspection/queries";
import { AssignInspectionForm } from "./inspection/inspection-forms";
import { estimateView } from "../../../../../server/estimate/queries";
import { Money } from "../../../../../server/core/money";
import { formatAed } from "../../../../../i18n/format";

export const dynamic = "force-dynamic";

export default async function RepairOrderPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "repair_order.read", {
    entityType: "repair_order",
    entityId: id,
  });

  const ro = await getRepairOrder(getDb(), session.roles, id);
  if (!ro) notFound();
  const canExclude = hasPermission(session.roles, "media.exclude");
  const canAssign = hasPermission(session.roles, "inspection.assign");
  const inspection = await getInspection(getDb(), id);
  const technicians = canAssign ? await listTechnicians(getDb()) : [];
  const estimate = hasPermission(session.roles, "estimate.read") ? await estimateView(getDb(), id) : null;
  const activeFindings = inspection?.findings.filter((finding) => finding.status === "active") ?? [];
  const countOf = (severity: string) =>
    activeFindings.filter((finding) => finding.severity === severity).length;
  const vehicleTitle = t(locale, "vehicle.summary", {
    make: ro.make,
    model: ro.model,
    year: String(ro.year),
  });
  const none = t(locale, "repairOrder.none");

  return (
    <>
      <PageHeader
        title={
          <>
            {t(locale, "repairOrder.title")} <bdi dir="ltr">{ro.number}</bdi>
          </>
        }
        subtitle={
          <>
            {ro.plate ? <PlateBadge locale={locale} plate={ro.plate} /> : null}{" "}
            <bdi dir="ltr">{vehicleTitle}</bdi>{" "}
            <StatusChip>{t(locale, `repairOrder.status.${ro.status}` as MessageKey)}</StatusChip>
          </>
        }
      />

      <Card title={t(locale, "checkIn.section.contact")}>
        <dl className="detail-list">
          <dt>{t(locale, "checkIn.customer")}</dt>
          <dd>
            <a href={`/${locale}/customers/${ro.customerId}`}>{ro.customerName}</a>
          </dd>
          <dt>{t(locale, "checkIn.contactName")}</dt>
          <dd dir="auto">{ro.contactName}</dd>
          <dt>{t(locale, "checkIn.relationship")}</dt>
          <dd>
            {ro.contactRelationship ? t(locale, `checkIn.relationship.${ro.contactRelationship}`) : none}
          </dd>
          {ro.contactMobile ? (
            <>
              <dt>{t(locale, "customer.new.mobile")}</dt>
              <dd>
                <bdi dir="ltr">{ro.contactMobile}</bdi>
              </dd>
            </>
          ) : null}
        </dl>
      </Card>

      <Card title={t(locale, "checkIn.section.arrival")}>
        <dl className="detail-list">
          <dt>{t(locale, "repairOrder.checkedIn")}</dt>
          <dd>
            <bdi>{formatDubaiDateTime(ro.checkedInAt, locale)}</bdi>
            {ro.checkedInByName ? (
              <>
                {t(locale, "common.listSeparator")}
                {ro.checkedInByName}
              </>
            ) : null}
          </dd>
          <dt>{t(locale, "checkIn.odometer")}</dt>
          <dd>
            <bdi dir="ltr">{ro.odometerKm}</bdi>
          </dd>
          <dt>{t(locale, "checkIn.fuel")}</dt>
          <dd>
            {ro.fuelEighths === null ? none : t(locale, `checkIn.fuel.${ro.fuelEighths}` as MessageKey)}
          </dd>
          <dt>{t(locale, "checkIn.concerns")}</dt>
          <dd dir="auto">{ro.concerns}</dd>
          <dt>{t(locale, "checkIn.warningLights")}</dt>
          <dd dir="auto">{ro.warningLights ?? none}</dd>
          <dt>{t(locale, "checkIn.belongings")}</dt>
          <dd dir="auto">{ro.belongings ?? none}</dd>
          <dt>{t(locale, "checkIn.keysReceived")}</dt>
          <dd>
            {ro.keysReceived === null ? none : <bdi dir="ltr">{ro.keysReceived}</bdi>}
            {ro.keyTag ? (
              <>
                {t(locale, "common.listSeparator")}
                <bdi dir="ltr">{ro.keyTag}</bdi>
              </>
            ) : null}
          </dd>
          <dt>{t(locale, "checkIn.promisedAt")}</dt>
          <dd>
            {ro.promisedAt ? (
              <bdi>{formatDubaiDateTime(ro.promisedAt, locale)}</bdi>
            ) : (
              t(locale, "checkIn.promisedTbc")
            )}
          </dd>
          {ro.photoShortfallReason ? (
            <>
              <dt>{t(locale, "checkIn.shortfallReason")}</dt>
              <dd dir="auto">{ro.photoShortfallReason}</dd>
            </>
          ) : null}
        </dl>
      </Card>

      <Card
        title={t(locale, "inspection.title")}
        actions={
          <a className="btn btn-secondary" href={`/${locale}/repair-orders/${ro.id}/inspection`}>
            {t(locale, "inspection.open")}
          </a>
        }
      >
        <dl className="detail-list">
          <dt>{t(locale, "inspection.technician")}</dt>
          <dd>{inspection?.technician?.displayName ?? t(locale, "inspection.unassigned")}</dd>
          <dt>{t(locale, "inspection.findings")}</dt>
          <dd>
            {activeFindings.length === 0
              ? t(locale, "inspection.noFindings")
              : t(locale, "inspection.findingCounts", {
                  urgent: String(countOf("urgent")),
                  soon: String(countOf("soon")),
                  ok: String(countOf("ok")),
                })}
          </dd>
        </dl>
        {canAssign && (ro.status === "checked_in" || ro.status === "diagnosing") ? (
          <AssignInspectionForm
            locale={locale}
            repairOrderId={ro.id}
            technicians={technicians}
            currentTechnicianId={inspection?.technician?.userId ?? null}
          />
        ) : null}
      </Card>

      {hasPermission(session.roles, "estimate.read") ? (
        <Card
          title={t(locale, "estimate.title")}
          actions={
            <a className="btn btn-secondary" href={`/${locale}/repair-orders/${ro.id}/estimate`}>
              {t(locale, "estimate.open")}
            </a>
          }
        >
          {estimate ? (
            <dl className="detail-list">
              <dt>{t(locale, "estimate.version", { no: String(estimate.versionNo) })}</dt>
              <dd>{t(locale, `estimate.status.${estimate.status}` as MessageKey)}</dd>
              <dt>{t(locale, "estimate.jobs")}</dt>
              <dd>
                <bdi dir="ltr">{estimate.jobs.length}</bdi>
              </dd>
              <dt>{t(locale, "estimate.total")}</dt>
              <dd>
                <bdi>{formatAed(Money.parse(estimate.totals.total), locale)}</bdi>
              </dd>
            </dl>
          ) : (
            <p className="muted">{t(locale, "estimate.none")}</p>
          )}
        </Card>
      ) : null}

      <Card title={t(locale, "checkIn.section.photos")}>
        <p className="muted">{t(locale, "repairOrder.photosLocked")}</p>
        <div className="photo-grid">
          {ro.photos.map((photo) => {
            const label = t(locale, `checkIn.slot.${photo.slot}` as MessageKey);
            return (
              <div
                key={photo.id}
                className={photo.excluded ? "photo-slot filled excluded" : "photo-slot filled"}
              >
                <span className="slot-name">{label}</span>
                <a href={`/api/media/${photo.id}`} target="_blank" rel="noreferrer">
                  {/* A plain <img>: the photo comes from the private, authorized /api/media endpoint. */}
                  <img src={`/api/media/${photo.id}`} alt={label} />
                </a>
                {photo.excluded ? (
                  <p>
                    <StatusChip tone="neutral">{t(locale, "repairOrder.excluded")}</StatusChip>{" "}
                    {photo.excluded.reason}
                  </p>
                ) : canExclude ? (
                  <details className="disclosure">
                    <summary>{t(locale, "repairOrder.excludePhoto")}</summary>
                    <ExcludePhotoForm locale={locale} repairOrderId={ro.id} mediaId={photo.id} />
                  </details>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
