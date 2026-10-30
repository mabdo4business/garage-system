import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { LinkPage } from "../../../../components/link-page";
import { isLocale, t } from "../../../../i18n";
import { getDb } from "../../../../server/db/client";
import { openCustomerLink, requesterFrom } from "../../../../server/links/customer";

export const dynamic = "force-dynamic";

/**
 * The customer's estimate link (I2-03a, PRD v0.2 §6.4). No sign-in: the token is the key. Response headers
 * (no indexing, no referrer, no caching) come from next.config.ts; the metadata repeats them for the page itself.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: isLocale(locale) ? t(locale, "link.pageTitle") : "",
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function CustomerLinkRoute({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  if (!isLocale(locale)) notFound();
  const page = await openCustomerLink(getDb(), token, requesterFrom(await headers()));
  return <LinkPage locale={locale} token={token} page={page} />;
}
