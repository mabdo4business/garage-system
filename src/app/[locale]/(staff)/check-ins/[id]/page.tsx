import { randomUUID } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { Card, EmptyState, PageHeader, PlateBadge, StatusChip } from "../../../../../components/ui";
import { isLocale, t, type MessageKey } from "../../../../../i18n";
import { canReadContact } from "../../../../../server/customer/service";
import { getDb } from "../../../../../server/db/client";
import { getCheckInSettings } from "../../../../../server/repair-order/check-in";
import { getCheckIn } from "../../../../../server/repair-order/queries";
import { requirePagePermission } from "../../../server-support";
import { AbandonCheckInForm, CheckInForm } from "./check-in-form";
import { PhotoSlots } from "./photo-slots";

export const dynamic = "force-dynamic";

/** "2026-10-21T17:30" in Asia/Dubai (UTC+4, no daylight saving) for a datetime-local input. */
function dubaiLocalInput(instant: Date | null): string {
  if (!instant) return "";
  return new Date(instant.getTime() + 4 * 3_600_000).toISOString().slice(0, 16);
}

export default async function CheckInPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "repair_order.check_in", {
    entityType: "check_in",
    entityId: id,
  });

  const db = getDb();
  const checkIn = await getCheckIn(db, session.roles, id);
  if (!checkIn) notFound();
  if (checkIn.status === "completed" && checkIn.repairOrderId)
    redirect(`/${locale}/repair-orders/${checkIn.repairOrderId}`);

  const vehicleTitle = t(locale, "vehicle.summary", {
    make: checkIn.make,
    model: checkIn.model,
    year: String(checkIn.year),
  });
  if (checkIn.status === "abandoned") {
    return (
      <>
        <PageHeader
          title={vehicleTitle}
          subtitle={<StatusChip tone="neutral">{t(locale, "checkIn.status.abandoned")}</StatusChip>}
        />
        <EmptyState title={t(locale, "checkIn.abandonedTitle")} />
      </>
    );
  }

  const settings = await getCheckInSettings(db);
  const present = new Set(checkIn.photos.map((photo) => photo.slot));
  const missingSlots = settings.requiredSlots
    .filter((slot) => !present.has(slot))
    .map((slot) => t(locale, `checkIn.slot.${slot}` as MessageKey));

  return (
    <>
      <PageHeader
        title={t(locale, "checkIn.title")}
        subtitle={
          <>
            {checkIn.plate ? <PlateBadge locale={locale} plate={checkIn.plate} /> : null}{" "}
            <bdi dir="ltr">{vehicleTitle}</bdi>{" "}
            <StatusChip tone="warning">{t(locale, "checkIn.status.in_progress")}</StatusChip>
          </>
        }
      />
      <Card>
        <dl className="detail-list">
          <dt>{t(locale, "checkIn.customer")}</dt>
          <dd>
            <a href={`/${locale}/customers/${checkIn.customerId}`}>{checkIn.customerName}</a>
          </dd>
          <dt>{t(locale, "checkIn.vehicle")}</dt>
          <dd>
            <a href={`/${locale}/vehicles/${checkIn.vehicleId}`}>
              <bdi dir="ltr">{vehicleTitle}</bdi>
            </a>
          </dd>
        </dl>
      </Card>

      <Card title={t(locale, "checkIn.section.photos")}>
        <p className="muted">{t(locale, "checkIn.photosHint")}</p>
        <PhotoSlots
          locale={locale}
          checkInId={checkIn.id}
          requiredSlots={settings.requiredSlots}
          photos={checkIn.photos.map((photo) => ({ id: photo.id, slot: photo.slot }))}
        />
      </Card>

      <Card title={t(locale, "checkIn.section.details")}>
        <CheckInForm
          locale={locale}
          checkInId={checkIn.id}
          idempotencyKey={randomUUID()}
          missingSlots={missingSlots}
          showContactMobile={canReadContact(session.roles)}
          initial={{
            contactName: checkIn.contactName ?? "",
            contactMobile: checkIn.contactMobile ?? "",
            contactRelationship: checkIn.contactRelationship ?? "owner",
            odometerKm: checkIn.odometerKm?.toString() ?? "",
            fuelEighths: checkIn.fuelEighths?.toString() ?? "",
            warningLights: checkIn.warningLights ?? "",
            concerns: checkIn.concerns ?? "",
            belongings: checkIn.belongings ?? "",
            keysReceived: checkIn.keysReceived?.toString() ?? "",
            keyTag: checkIn.keyTag ?? "",
            promisedAt: dubaiLocalInput(checkIn.promisedAt),
            photoShortfallReason: checkIn.photoShortfallReason ?? "",
          }}
        />
      </Card>

      <Card title={t(locale, "checkIn.abandonTitle")}>
        <AbandonCheckInForm locale={locale} checkInId={checkIn.id} />
      </Card>
    </>
  );
}
