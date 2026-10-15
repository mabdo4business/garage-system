import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale, t } from "../../i18n";
import { dubaiDate } from "../../i18n/format";
import { SESSION_COOKIE, validateSession } from "../../server/auth/session";
import { getDb } from "../../server/db/client";

export const dynamic = "force-dynamic";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await validateSession(getDb(), token);
  if (!session) redirect(`/${locale}/login`);

  return (
    <main className="card">
      <h1>{t(locale, "app.name")}</h1>
      <p>{t(locale, "home.signedInAs", { name: session.displayName })}</p>
      <p>{t(locale, "home.businessDate", { date: dubaiDate(new Date()) })}</p>
      <p>
        <a href={`/${locale}/search`}>{t(locale, "home.directory")}</a>
      </p>
      <form method="post" action="/api/auth/logout">
        <input type="hidden" name="locale" value={locale} />
        <button type="submit">{t(locale, "home.signOut")}</button>
      </form>
    </main>
  );
}
