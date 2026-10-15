import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { htmlAttributes, isLocale, LOCALES, t } from "../../i18n";
import "./styles.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return { title: isLocale(locale) ? t(locale, "app.name") : "Garage" };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <html {...htmlAttributes(locale)}>
      <body>{children}</body>
    </html>
  );
}
