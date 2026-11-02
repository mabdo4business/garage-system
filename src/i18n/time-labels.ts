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

/**
 * A promised time against now (UI-R4): "Overdue by 3 h", "Due in 40 min" within a day, otherwise the time (or date
 * and time). `overdue` says which, for colour; the words carry it too.
 */
export function formatDue(
  promisedAt: Date,
  now: Date,
  locale: Locale,
  businessDate: string,
): { label: string; overdue: boolean } {
  const seconds = (promisedAt.getTime() - now.getTime()) / 1000;
  // Within the minute either side: never "Overdue by 0 min".
  if (Math.abs(seconds) < 60) return { label: t(locale, "dashboard.due.now"), overdue: seconds < 0 };
  if (seconds < 0) {
    return {
      label: t(locale, "dashboard.due.overdue", { time: formatDuration(locale, -seconds) }),
      overdue: true,
    };
  }
  if (seconds < 24 * 3600) {
    return {
      label: t(locale, "dashboard.due.in", { time: formatDuration(locale, seconds) }),
      overdue: false,
    };
  }
  return { label: formatWhen(promisedAt, locale, businessDate), overdue: false };
}
