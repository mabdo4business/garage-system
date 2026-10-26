import { dubaiDate, formatDubaiDateTime, formatDubaiTime } from "./format";
import { t, type Locale } from "./index";

/** "2 d 5 h", "1 h 25 min", "2 h", "40 min". */
export function formatDuration(locale: Locale, seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    return t(locale, "dashboard.duration.dh", { d: String(Math.floor(hours / 24)), h: String(hours % 24) });
  }
  if (hours > 0 && minutes % 60 === 0) return t(locale, "dashboard.duration.h", { h: String(hours) });
  return hours > 0
    ? t(locale, "dashboard.duration.hm", { h: String(hours), m: String(minutes % 60) })
    : t(locale, "dashboard.duration.m", { m: String(minutes) });
}

/** Time only when it falls on `businessDate`; otherwise date and time, so an old instant never looks like today. */
export function formatWhen(instant: Date, locale: Locale, businessDate: string): string {
  return dubaiDate(instant) === businessDate
    ? formatDubaiTime(instant, locale)
    : formatDubaiDateTime(instant, locale);
}
