import { t, type Locale } from "../../i18n";
import { formatDubaiDateTime } from "../../i18n/format";
import { normalizeMobile } from "../customer/service";

/**
 * The texts the advisor sends from their own device (I2-09, OD-68–OD-70). Wording lives in the message catalogues
 * (`message.estimate`, `message.ready`) so both languages read the same; drafted for owner review before UAT.
 * Customer-facing (rule 9): the contact's name, the car's make and model, the garage name, the link and its expiry —
 * never amounts, the plate, staff names or internal notes.
 */

/** Stands for the link in what is stored: the token itself never leaves the customer's URL (T-41). */
export const LINK_PLACEHOLDER = "[link]";

export interface MessageFacts {
  contactName: string;
  make: string;
  model: string;
  garageName: { ar: string; en: string } | null;
}

function garageLine(facts: MessageFacts, locale: Locale): string {
  return facts.garageName ? (locale === "ar" ? facts.garageName.ar : facts.garageName.en) : "";
}

/** "Your estimate is ready" with the link, valid until the estimate's expiry. */
export function estimateMessage(facts: MessageFacts, locale: Locale, link: string, expiresAt: Date): string {
  return t(locale, "message.estimate", {
    name: facts.contactName,
    car: `${facts.make} ${facts.model}`,
    link,
    date: formatDubaiDateTime(expiresAt, locale),
    garage: garageLine(facts, locale),
  }).trim();
}

/** "Your car is ready for collection" (no link until the status page, I6-07). */
export function readyMessage(facts: MessageFacts, locale: Locale): string {
  return t(locale, "message.ready", {
    name: facts.contactName,
    car: `${facts.make} ${facts.model}`,
    garage: garageLine(facts, locale),
  }).trim();
}

/**
 * WhatsApp's click-to-chat address for the contact's mobile with the text filled in (OD-70). A UAE mobile saved
 * without its country code (05x… → 5x…, nine digits) gets 971; any other number is used as stored [T-46].
 */
export function whatsAppUrl(mobile: string, text: string): string {
  const digits = normalizeMobile(mobile);
  const international = /^5[0-9]{8}$/.test(digits) ? `971${digits}` : digits;
  return `https://wa.me/${international}?text=${encodeURIComponent(text)}`;
}
