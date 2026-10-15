import { Money } from "../server/core/money";
import type { Locale } from "./index";

/**
 * Display formatting for AED amounts and Asia/Dubai dates.
 *
 * Digits: Western (Latin) digits are used in both languages until the owners decide D-28
 * (Arabic-Indic vs Western digits). Change ARABIC_NUMBERING to "arab" to switch.
 */
export const BUSINESS_TIME_ZONE = "Asia/Dubai";
export const ARABIC_NUMBERING: "latn" | "arab" = "latn";

function intlLocale(locale: Locale): string {
  return locale === "ar" ? `ar-AE-u-nu-${ARABIC_NUMBERING}` : "en-AE";
}

/** Formats an exact amount without converting it to a JavaScript float. */
export function formatAed(amount: Money, locale: Locale): string {
  const formatter = new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "AED",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Intl.NumberFormat accepts decimal strings exactly (ECMA-402 NumberFormat v3).
  return formatter.format(amount.toString() as unknown as number);
}

export function formatDubaiDateTime(instant: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(instant);
}

/** The Asia/Dubai calendar date of an instant, 'YYYY-MM-DD'. Mirrors SQL business_date_of(). */
export function dubaiDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
