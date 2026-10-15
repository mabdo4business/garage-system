import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale, t } from "../../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import { getCustomer } from "../../../../server/customer/service";

export const dynamic = "force-dynamic";

export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) notFound();
  const db = getDb();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(db, token);
  if (!session) redirect(`/${locale}/login`);

  const profile = await getCustomer(db, session.roles, id);
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
