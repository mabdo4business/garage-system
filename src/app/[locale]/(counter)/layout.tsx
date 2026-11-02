import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../server/auth/session";
import { getDb } from "../../../server/db/client";

export const dynamic = "force-dynamic";

/**
 * Screens the customer holds at the counter (I1-05b decision screen). Signed-in staff only, but without the
 * staff shell: no navigation, no search, no staff names (rule 9), so the tablet shows the customer only their
 * own estimate. Pages still authorize themselves (rule 8).
 */
export default async function CounterLayout({
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
  return <main className="counter">{children}</main>;
}
