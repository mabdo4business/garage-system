import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { Card, DataTable, EmptyState, PageHeader, StatusChip } from "../../../../../components/ui";
import { isLocale, t } from "../../../../../i18n";
import { formatDubaiDateTime } from "../../../../../i18n/format";
import { getDb } from "../../../../../server/db/client";
import {
  businessProfileHistory,
  currentBusinessProfile,
} from "../../../../../server/settings/business-profile";
import { requirePagePermission } from "../../../server-support";
import { BusinessProfileForm } from "./profile-form";

export const dynamic = "force-dynamic";

/** Business profile (I1-09b, OD-42): the garage details printed on invoices, kept as versions (OD-46). */
export default async function BusinessProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  await requirePagePermission(locale, "business_profile.manage");
  const db = getDb();
  const history = await businessProfileHistory(db);
  const current = await currentBusinessProfile(db);

  return (
    <>
      <PageHeader title={t(locale, "nav.businessProfile")} subtitle={t(locale, "businessProfile.subtitle")} />
      <Card title={t(locale, "businessProfile.current")}>
        {current ? (
          <dl className="detail-list">
            <dt>{t(locale, "businessProfile.legalNameEn")}</dt>
            <dd dir="ltr">{current.legalNameEn}</dd>
            <dt>{t(locale, "businessProfile.legalNameAr")}</dt>
            <dd dir="rtl">{current.legalNameAr}</dd>
            <dt>{t(locale, "businessProfile.addressEn")}</dt>
            <dd dir="ltr">{current.addressEn}</dd>
            <dt>{t(locale, "businessProfile.addressAr")}</dt>
            <dd dir="rtl">{current.addressAr}</dd>
            <dt>{t(locale, "businessProfile.phone")}</dt>
            <dd>
              <bdi dir="ltr">{current.phone}</bdi>
            </dd>
          </dl>
        ) : (
          <EmptyState title={t(locale, "businessProfile.none")} />
        )}
        <p className="muted">{t(locale, "businessProfile.trnFromTax")}</p>
        <details className="disclosure" open={!current}>
          <summary>{t(locale, current ? "businessProfile.edit" : "businessProfile.enter")}</summary>
          <BusinessProfileForm locale={locale} idempotencyKey={randomUUID()} current={current} />
        </details>
      </Card>
      {history.length > 0 ? (
        <Card title={t(locale, "businessProfile.history")}>
          <DataTable
            columns={[
              t(locale, "businessProfile.savedAt"),
              t(locale, "businessProfile.savedBy"),
              locale === "ar"
                ? t(locale, "businessProfile.legalNameAr")
                : t(locale, "businessProfile.legalNameEn"),
              t(locale, "businessProfile.phone"),
            ]}
            rows={history.map((version) => [
              <span key="at">
                <bdi dir="ltr">{formatDubaiDateTime(version.createdAt, locale)}</bdi>{" "}
                {version.id === current?.id ? (
                  <StatusChip tone="success">{t(locale, "businessProfile.inUse")}</StatusChip>
                ) : null}
              </span>,
              <bdi key="by">{version.createdByName ?? ""}</bdi>,
              <bdi key="name">{locale === "ar" ? version.legalNameAr : version.legalNameEn}</bdi>,
              <bdi key="phone" dir="ltr">
                {version.phone}
              </bdi>,
            ])}
          />
        </Card>
      ) : null}
    </>
  );
}
