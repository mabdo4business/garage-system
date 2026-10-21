import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/shell/app-shell";
import { isLocale } from "../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../server/auth/session";
import { getDb } from "../../../server/db/client";

export const dynamic = "force-dynamic";

/** Wraps every signed-in staff page in the app shell. Pages still authorize themselves (rule 8). */
export default async function StaffLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await validateSession(getDb(), (await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) redirect(`/${locale}/login`);

  return (
    <AppShell locale={locale} user={{ displayName: session.displayName, roles: session.roles }}>
      {children}
    </AppShell>
  );
}
