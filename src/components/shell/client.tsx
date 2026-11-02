"use client";

import { usePathname } from "next/navigation";
import { t, type Locale } from "../../i18n";
import { isActive, pathWithinLocale, type NavItem } from "./nav";

/** The two shell parts that need the current URL: the menu's active marker and the language link. */

export function NavLinks({ locale, items }: { locale: Locale; items: NavItem[] }) {
  const rest = pathWithinLocale(usePathname() ?? "");
  return (
    <ul>
      {items.map((item) => (
        <li key={item.key}>
          <a href={`/${locale}${item.path}`} aria-current={isActive(item, rest) ? "page" : undefined}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={item.icon} />
            </svg>
            <span>{t(locale, item.label)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Same page in the other language. */
export function LocaleSwitch({ locale }: { locale: Locale }) {
  const other: Locale = locale === "ar" ? "en" : "ar";
  const rest = pathWithinLocale(usePathname() ?? "");
  return (
    <a className="btn btn-quiet" href={`/${other}${rest}`} hrefLang={other} lang={other}>
      {t(locale, "login.switchLanguage")}
    </a>
  );
}
