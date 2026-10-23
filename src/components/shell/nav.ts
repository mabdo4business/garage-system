import type { MessageKey } from "../../i18n";
import { hasPermission, type Permission } from "../../server/auth/permissions";

/**
 * Staff menu (UI/UX deck, information architecture). Only sections that exist are listed; each
 * later story appends its own item. An item is shown when the viewer holds its permission — the
 * same check the pages make on the server, so the menu never offers a page that would refuse.
 */
export interface NavItem {
  key: string;
  label: MessageKey;
  /** Path after /{locale}. */
  path: string;
  permission: Permission | null;
  /** Path prefixes (after /{locale}) that count as this section, for the active marker. */
  sections: readonly string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "today", label: "nav.today", path: "", permission: null, sections: [] },
  {
    key: "repairOrders",
    label: "nav.repairOrders",
    path: "/repair-orders",
    permission: "repair_order.read",
    sections: ["/repair-orders", "/check-ins"],
  },
  {
    key: "myInspections",
    label: "nav.myInspections",
    path: "/inspections",
    permission: "inspection.my_work",
    // A technician reaches the inspection screen (under /repair-orders) only from here.
    sections: ["/inspections", "/repair-orders"],
  },
  {
    key: "workshop",
    label: "nav.workshop",
    path: "/workshop",
    permission: "workshop.board",
    sections: ["/workshop"],
  },
  {
    key: "myJobs",
    label: "nav.myJobs",
    path: "/jobs",
    permission: "workshop.my_jobs",
    sections: ["/jobs"],
  },
  {
    key: "parts",
    label: "nav.parts",
    path: "/parts",
    permission: "stock.read",
    sections: ["/parts"],
  },
  {
    key: "stock",
    label: "nav.stock",
    path: "/stock",
    permission: "stock.read",
    sections: ["/stock"],
  },
  {
    key: "directory",
    label: "nav.directory",
    path: "/search",
    permission: "directory.search",
    sections: ["/search", "/customers", "/vehicles"],
  },
  {
    key: "catalogue",
    label: "nav.catalogue",
    path: "/catalogue",
    permission: "catalogue.read",
    sections: ["/catalogue"],
  },
  {
    key: "taxSettings",
    label: "nav.taxSettings",
    path: "/settings/tax",
    permission: "tax.manage",
    sections: ["/settings/tax"],
  },
];

export function navFor(roles: readonly string[], items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items.filter((item) => item.permission === null || hasPermission(roles, item.permission));
}

/** `pathWithinLocale` is the path after /{locale}, e.g. "" or "/vehicles/…". */
export function isActive(item: NavItem, pathWithinLocale: string): boolean {
  if (item.sections.length === 0) return pathWithinLocale === "" || pathWithinLocale === "/";
  return item.sections.some(
    (prefix) => pathWithinLocale === prefix || pathWithinLocale.startsWith(`${prefix}/`),
  );
}

/** Splits "/ar/vehicles/x" into the path after the locale ("/vehicles/x"). */
export function pathWithinLocale(pathname: string): string {
  const match = /^\/(?:ar|en)(\/.*)?$/.exec(pathname);
  return match ? (match[1] ?? "") : pathname;
}

/** Shortcuts on the Today screen, filtered by permission the same way as the menu. */
export interface QuickAction {
  key: string;
  label: MessageKey;
  description: MessageKey;
  path: string;
  permission: Permission;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    key: "search",
    label: "today.action.search",
    description: "today.action.searchHint",
    path: "/search",
    permission: "directory.search",
  },
  {
    key: "newCustomer",
    label: "directory.newCustomer",
    description: "today.action.newCustomerHint",
    path: "/customers/new",
    permission: "customer.write",
  },
  {
    key: "newVehicle",
    label: "directory.newVehicle",
    description: "today.action.newVehicleHint",
    path: "/vehicles/new",
    permission: "vehicle.write",
  },
];

export function quickActionsFor(roles: readonly string[]): QuickAction[] {
  return QUICK_ACTIONS.filter((action) => hasPermission(roles, action.permission));
}
