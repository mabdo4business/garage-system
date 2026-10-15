import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale, t } from "../../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../../server/auth/session";
import { getDb } from "../../../../server/db/client";
import { createCustomerAction } from "./actions";

export const dynamic = "force-dynamic";

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function NewCustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(getDb(), token);
  if (!session) redirect(`/${locale}/login`);

  const query = await searchParams;
  const duplicate = str(query.duplicate) === "1";
  const values = {
    nameEn: str(query.nameEn),
    nameAr: str(query.nameAr),
    mobile: str(query.mobile),
    email: str(query.email),
    preferredLanguage: str(query.preferredLanguage) === "ar" ? "ar" : "en",
    marketingConsent: str(query.marketingConsent) === "1",
  };

  return (
    <main className="card card-wide">
      <h1>{t(locale, "customer.new.title")}</h1>
      {duplicate ? (
        <p role="alert" className="error">
          {t(locale, "customer.duplicate.heading")} — {t(locale, "customer.duplicate.body")}
        </p>
      ) : null}
      <form action={createCustomerAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="idempotencyKey" value={randomUUID()} />
        {duplicate ? <input type="hidden" name="confirmDuplicate" value="1" /> : null}

        <label htmlFor="nameEn">{t(locale, "customer.new.nameEn")}</label>
        <input id="nameEn" name="nameEn" defaultValue={values.nameEn} dir="ltr" />

        <label htmlFor="nameAr">{t(locale, "customer.new.nameAr")}</label>
        <input id="nameAr" name="nameAr" defaultValue={values.nameAr} dir="rtl" />

        <label htmlFor="mobile">{t(locale, "customer.new.mobile")}</label>
        <input id="mobile" name="mobile" defaultValue={values.mobile} required dir="ltr" />

        <label htmlFor="email">{t(locale, "customer.new.email")}</label>
        <input id="email" name="email" type="email" defaultValue={values.email} dir="ltr" />

        <label htmlFor="preferredLanguage">{t(locale, "customer.new.language")}</label>
        <select id="preferredLanguage" name="preferredLanguage" defaultValue={values.preferredLanguage}>
          <option value="en">{t(locale, "customer.new.languageEn")}</option>
          <option value="ar">{t(locale, "customer.new.languageAr")}</option>
        </select>

        <label>
          <input type="checkbox" name="marketingConsent" defaultChecked={values.marketingConsent} />{" "}
          {t(locale, "customer.new.marketingConsent")}
        </label>

        <button type="submit">
          {duplicate ? t(locale, "customer.duplicate.createAnyway") : t(locale, "customer.new.submit")}
        </button>
      </form>
    </main>
  );
}
