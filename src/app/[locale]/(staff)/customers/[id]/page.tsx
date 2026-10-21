import { notFound } from "next/navigation";
import { Card, PageHeader } from "../../../../../components/ui";
import { isLocale, t } from "../../../../../i18n";
import { getCustomer } from "../../../../../server/customer/service";
import { getDb } from "../../../../../server/db/client";
import { requirePagePermission } from "../../../server-support";

export const dynamic = "force-dynamic";

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const session = await requirePagePermission(locale, "customer.read", {
    entityType: "customer",
    entityId: id,
  });

  const profile = await getCustomer(getDb(), session.roles, id);
  if (!profile) notFound();
  const name =
    (locale === "ar" ? (profile.nameAr ?? profile.nameEn) : (profile.nameEn ?? profile.nameAr)) ?? "";

  return (
    <>
      <PageHeader title={name} subtitle={t(locale, "customer.profile.title")} />
      <Card>
        <dl className="detail-list">
          {profile.nameEn ? (
            <>
              <dt>{t(locale, "customer.new.nameEn")}</dt>
              <dd dir="ltr">{profile.nameEn}</dd>
            </>
          ) : null}
          {profile.nameAr ? (
            <>
              <dt>{t(locale, "customer.new.nameAr")}</dt>
              <dd dir="rtl">{profile.nameAr}</dd>
            </>
          ) : null}
          <dt>{t(locale, "customer.new.language")}</dt>
          <dd>
            {t(
              locale,
              profile.preferredLanguage === "ar" ? "customer.new.languageAr" : "customer.new.languageEn",
            )}
          </dd>
          <dt>{t(locale, "customer.profile.marketing")}</dt>
          <dd>{t(locale, profile.marketingConsent ? "common.yes" : "common.no")}</dd>
          {profile.contact ? (
            <>
              <dt>{t(locale, "customer.profile.mobile")}</dt>
              <dd dir="ltr">{profile.contact.mobile}</dd>
              {profile.contact.email ? (
                <>
                  <dt>{t(locale, "customer.profile.email")}</dt>
                  <dd dir="ltr">{profile.contact.email}</dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
        {profile.contact ? null : <p className="muted">{t(locale, "customer.profile.contactHidden")}</p>}
      </Card>
    </>
  );
}
