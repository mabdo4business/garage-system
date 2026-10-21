import type { ReactNode } from "react";
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic, Rubik } from "next/font/google";
import { notFound } from "next/navigation";
import { htmlAttributes, isLocale, LOCALES, t } from "../../i18n";
import "./tokens.css";
import "./components.css";

export const dynamicParams = false;

// Deck typefaces (slide 13). next/font downloads them at build time and serves them from the app,
// so pages make no requests to Google at runtime.
const rubik = Rubik({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-rubik",
  display: "swap",
});
const plex = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex",
  display: "swap",
});
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-arabic",
  display: "swap",
});

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
    <html {...htmlAttributes(locale)} className={`${rubik.variable} ${plex.variable} ${plexArabic.variable}`}>
      <body>{children}</body>
    </html>
  );
}
