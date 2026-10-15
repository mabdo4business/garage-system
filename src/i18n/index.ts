import ar from "./messages/ar.json";
import en from "./messages/en.json";

/**
 * Arabic (RTL) and English (LTR). Message catalogs must have identical keys; a test fails the
 * build if a key is missing, empty, or referenced in code but absent (AC2-34 scaffolding).
 */
export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export type MessageKey = keyof typeof en;

export const catalogs: Record<Locale, Record<string, string>> = { ar, en };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function direction(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function t(locale: Locale, key: MessageKey, vars: Record<string, string> = {}): string {
  const template = catalogs[locale][key];
  if (template === undefined) {
    throw new Error(`Missing ${locale} message for ${key}`);
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? `{${name}}`);
}

/** Attributes for the <html> element of a locale. */
export function htmlAttributes(locale: Locale): { lang: string; dir: "rtl" | "ltr" } {
  return { lang: locale, dir: direction(locale) };
}
