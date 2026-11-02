import type { ReactNode } from "react";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { htmlAttributes, isLocale, LOCALES, t } from "../../i18n";
import "./tokens.css";
import "./components.css";

export const dynamicParams = false;

// Typefaces from the redesign references (OD-49): Plus Jakarta Sans, JetBrains Mono for plates and timers,
// IBM Plex Sans Arabic. The files are kept in src/app/fonts (SIL Open Font License, texts alongside), taken from
// Google Fonts' latin and arabic subsets with Google's unicode ranges, so neither builds nor pages depend on
// Google being reachable. next/font reads these options at compile time, so they must stay literals.
const jakarta = localFont({
  src: "../fonts/plus-jakarta-sans-latin.woff2",
  weight: "400 800",
  variable: "--font-jakarta",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});
const jetbrains = localFont({
  src: "../fonts/jetbrains-mono-latin.woff2",
  weight: "500 700",
  variable: "--font-jetbrains",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});
// IBM Plex Sans Arabic in two parts: Arabic script, then its Latin letters and digits, which Arabic pages use
// for names, plates and numbers (T-02). tokens.css joins them as --font-plex-arabic. Only the Latin part carries
// the metric-matched fallback, so Latin text reaches it instead of stopping at a fallback after the Arabic part.
const plexArabicScript = localFont({
  src: [
    { path: "../fonts/ibm-plex-sans-arabic-400-arabic.woff2", weight: "400" },
    { path: "../fonts/ibm-plex-sans-arabic-500-arabic.woff2", weight: "500" },
    { path: "../fonts/ibm-plex-sans-arabic-600-arabic.woff2", weight: "600" },
    { path: "../fonts/ibm-plex-sans-arabic-700-arabic.woff2", weight: "700" },
  ],
  variable: "--font-plex-arabic-script",
  display: "swap",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0600-06FF, U+0750-077F, U+0870-0891, U+0897-08E1, U+08E3-08FF, U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC",
    },
  ],
});
const plexArabicLatin = localFont({
  src: [
    { path: "../fonts/ibm-plex-sans-arabic-400-latin.woff2", weight: "400" },
    { path: "../fonts/ibm-plex-sans-arabic-500-latin.woff2", weight: "500" },
    { path: "../fonts/ibm-plex-sans-arabic-600-latin.woff2", weight: "600" },
    { path: "../fonts/ibm-plex-sans-arabic-700-latin.woff2", weight: "700" },
  ],
  variable: "--font-plex-arabic-latin",
  display: "swap",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
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
      className={`${jakarta.variable} ${jetbrains.variable} ${plexArabicScript.variable} ${plexArabicLatin.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
