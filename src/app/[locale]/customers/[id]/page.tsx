import { notFound } from "next/navigation";
import { isLocale, t } from "../../../../i18n";
import { getDb } from "../../../../server/db/client";
import { getCustomer } from "../../../../server/customer/service";
import { requirePagePermission } from "../../server-support";

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

  return (
    <main className="card">
      <h1>{t(locale, "customer.profile.title")}</h1>
      <p>{profile.nameEn ?? profile.nameAr}</p>
      {profile.contact ? (
        <>
          <p>
            {t(locale, "customer.profile.mobile")}: <span dir="ltr">{profile.contact.mobile}</span>
          </p>
          {profile.contact.email ? (
            <p>
              {t(locale, "customer.profile.email")}: <span dir="ltr">{profile.contact.email}</span>
            </p>
          ) : null}
        </>
      ) : (
        <p className="hint">{t(locale, "customer.profile.contactHidden")}</p>
      )}
    </main>
  );
}
