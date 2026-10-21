import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { catalogs, htmlAttributes, LOCALES, t, type Locale } from "../src/i18n";
import { PERMISSIONS, ROLES, hasPermission } from "../src/server/auth/permissions";

/** I1-11 — staff app shell: menus follow permissions; Arabic renders RTL, English LTR. */

const nav = vi.hoisted(() => ({ pathname: "/en" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { AppShell } = await import("../src/components/shell/app-shell");
const { NAV_ITEMS, QUICK_ACTIONS, isActive, navFor, pathWithinLocale, quickActionsFor } =
  await import("../src/components/shell/nav");

function renderShell(locale: Locale, pathname: string, roles: string[]) {
  nav.pathname = pathname;
  return renderToStaticMarkup(
    <html {...htmlAttributes(locale)}>
      <body>
        <AppShell locale={locale} user={{ displayName: "Sara Test", roles }}>
          <p>page</p>
        </AppShell>
      </body>
    </html>,
  );
}

describe("S12 — staff app shell", () => {
  it("every role's menu is exactly the items whose permission the role holds", () => {
    for (const role of ROLES) {
      const expected = NAV_ITEMS.filter(
        (item) =>
          item.permission === null || (PERMISSIONS[item.permission] as readonly string[]).includes(role),
      ).map((item) => item.key);
      expect({ role, menu: navFor([role]).map((item) => item.key) }).toEqual({ role, menu: expected });
    }
  });

  it("a menu item gated on a restricted permission is hidden from roles without it", () => {
    // Today's real items are open to every role, so prove the filter with a restricted one too.
    const items = [
      ...NAV_ITEMS,
      {
        key: "restricted",
        label: "nav.today" as const,
        path: "/x",
        permission: "customer.write" as const,
        sections: [],
      },
    ];
    for (const role of ROLES) {
      expect({ role, shown: navFor([role], items).some((item) => item.key === "restricted") }).toEqual({
        role,
        shown: hasPermission([role], "customer.write"),
      });
    }
    expect(navFor([], items).map((item) => item.key)).toEqual(["today"]);
    expect(navFor(["unknown"], items).map((item) => item.key)).toEqual(["today"]);
  });

  it("Today quick actions follow permissions: a technician can only search, an advisor can also register", () => {
    expect(quickActionsFor(["technician"]).map((a) => a.key)).toEqual(["search"]);
    expect(quickActionsFor(["store_keeper"]).map((a) => a.key)).toEqual(["search"]);
    expect(quickActionsFor(["service_advisor"]).map((a) => a.key)).toEqual([
      "search",
      "newCustomer",
      "newVehicle",
    ]);
    for (const role of ROLES) {
      for (const action of quickActionsFor([role])) {
        expect(hasPermission([role], action.permission)).toBe(true);
      }
    }
    expect(QUICK_ACTIONS.length).toBe(3);
  });

  it("marks the section of the current page as active", () => {
    const [today, directory] = NAV_ITEMS;
    expect(pathWithinLocale("/ar")).toBe("");
    expect(pathWithinLocale("/en/vehicles/abc")).toBe("/vehicles/abc");
    expect(isActive(today!, "")).toBe(true);
    expect(isActive(today!, "/search")).toBe(false);
    for (const path of ["/search", "/customers/new", "/vehicles/abc"]) {
      expect(isActive(directory!, path)).toBe(true);
    }
    expect(isActive(directory!, "/searching")).toBe(false);
  });

  it.each(LOCALES)(
    "renders the shell in %s with catalog labels, the global search and a same-page language link",
    (locale) => {
      const other = locale === "ar" ? "en" : "ar";
      const html = renderShell(locale, `/${locale}/vehicles/abc`, ["service_advisor"]);

      expect(html).toContain(`dir="${locale === "ar" ? "rtl" : "ltr"}"`);
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain(t(locale, "nav.today"));
      expect(html).toContain(t(locale, "shell.role.service_advisor"));
      expect(html).toContain(`action="/${locale}/search"`);
      expect(html).toContain(`href="/${other}/vehicles/abc"`);
      // The section containing the current page is marked for assistive technology.
      expect(html).toMatch(new RegExp(`href="/${locale}/search" aria-current="page"`));
      // No text from the other catalog leaks in.
      expect(html).not.toContain(catalogs[other]["nav.today"]);
      expect(html).toMatchSnapshot();
    },
  );
});
