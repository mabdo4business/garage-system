import type { ReactNode } from "react";
import { t, type Locale, type MessageKey } from "../../i18n";
import { isRole } from "../../server/auth/permissions";
import { LocaleSwitch, NavLinks } from "./client";
import { navFor } from "./nav";

export interface ShellUser {
  displayName: string;
  roles: readonly string[];
}

/**
 * Every staff screen: menu by role, the global search bar (deck: "on every staff screen"), the
 * signed-in user, language switch and sign-out. Display only — each page checks its own
 * permission on the server.
 */
export function AppShell({
  locale,
  user,
  children,
}: {
  locale: Locale;
  user: ShellUser;
  children: ReactNode;
}) {
  const roleNames = user.roles
    .filter(isRole)
    .map((role) => t(locale, `shell.role.${role}` as MessageKey))
    .join(t(locale, "common.listSeparator"));
  const canSearch = navFor(user.roles).some((item) => item.key === "directory");

  return (
    <div className="shell">
      <nav className="shell-nav" aria-label={t(locale, "nav.label")}>
        <div className="shell-brand">{t(locale, "app.name")}</div>
        <NavLinks locale={locale} items={navFor(user.roles)} />
      </nav>
      <div className="shell-main">
        <header className="shell-topbar">
          {canSearch ? (
            <form className="topbar-search" method="get" action={`/${locale}/search`} role="search">
              <label htmlFor="shell-search" className="visually-hidden">
                {t(locale, "shell.search.label")}
              </label>
              <input
                id="shell-search"
                name="q"
                type="search"
                placeholder={t(locale, "directory.search.placeholder")}
                dir="auto"
              />
              <button type="submit" className="btn btn-secondary">
                {t(locale, "directory.search.submit")}
              </button>
            </form>
          ) : null}
          <div className="topbar-user">
            <span className="who">
              <span>{user.displayName}</span>
              <small>{roleNames}</small>
            </span>
            <LocaleSwitch locale={locale} />
            <form method="post" action="/api/auth/logout">
              <input type="hidden" name="locale" value={locale} />
              <button type="submit" className="btn btn-quiet">
                {t(locale, "home.signOut")}
              </button>
            </form>
          </div>
        </header>
        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
