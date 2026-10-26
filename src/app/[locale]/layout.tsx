import type { ReactNode } from "react";
import { IBM_Plex_Sans_Arabic, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { notFound } from "next/navigation";
import { htmlAttributes, isLocale, LOCALES, t } from "../../i18n";
import "./tokens.css";
import "./components.css";

export const dynamicParams = false;

// Typefaces from the redesign references (OD-49): Plus Jakarta Sans, JetBrains Mono for plates and timers,
// IBM Plex Sans Arabic. next/font downloads them at build time and serves them from the app, so pages make no
// requests to Google at runtime.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-jakarta",
  display: "swap",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
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
    <html
      {...htmlAttributes(locale)}
      className={`${jakarta.variable} ${jetbrains.variable} ${plexArabic.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
