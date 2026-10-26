import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "../../../i18n";
import { SESSION_COOKIE, validateSession } from "../../../server/auth/session";
import { getDb } from "../../../server/db/client";
import "./print.css";

export const dynamic = "force-dynamic";

/**
 * Printable documents (I1-09b). Signed-in staff only, without the staff shell, so the page holds the document alone
 * (no navigation, no staff names — rule 9). Pages still authorize themselves (rule 8).
 */
export default async function PrintLayout({
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
  return <main className="print-page">{children}</main>;
}
