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
  /** SVG path data for the 24 × 24 line icon (decorative; the label carries the meaning). */
  icon: string;
}

const ICON = {
  today: "M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z",
  repairOrders: "M9 3h6v3H9z M7 4.5H5V21h14V4.5h-2 M8 11h8 M8 15h5",
  inspections: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M20 20l-4-4 M8 11l2 2 4-4",
  workshop: "M4 4h4v16H4z M10 4h4v10h-4z M16 4h4v13h-4z",
  myJobs: "M6 2h12v20H6z M11 18h2",
  parts: "M21 8l-9-5-9 5 9 5 9-5z M3 8v8l9 5 9-5V8 M12 13v8",
  stock: "M4 7h16v4H4z M4 13h16v4H4z M8 9h.01 M8 15h.01",
  directory:
    "M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 20v-1a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8",
  catalogue: "M20 12l-8 8-9-9V3h8z M7.5 7.5h.01",
  tax: "M19 5L5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5 M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
  business: "M3 21h18 M5 21V7l7-4 7 4v14 M9 21v-6h6v6 M9 10h.01 M15 10h.01",
} as const;

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "today", label: "nav.today", path: "", permission: null, sections: [], icon: ICON.today },
  {
    key: "repairOrders",
    label: "nav.repairOrders",
    path: "/repair-orders",
    permission: "repair_order.read",
    sections: ["/repair-orders", "/check-ins"],
    icon: ICON.repairOrders,
  },
  {
    key: "myInspections",
    label: "nav.myInspections",
    path: "/inspections",
    permission: "inspection.my_work",
    // A technician reaches the inspection screen (under /repair-orders) only from here.
    sections: ["/inspections", "/repair-orders"],
    icon: ICON.inspections,
  },
  {
    key: "workshop",
    label: "nav.workshop",
    path: "/workshop",
    permission: "workshop.board",
    sections: ["/workshop"],
    icon: ICON.workshop,
  },
  {
    key: "myJobs",
    label: "nav.myJobs",
    path: "/jobs",
    permission: "workshop.my_jobs",
    sections: ["/jobs"],
    icon: ICON.myJobs,
  },
  {
    key: "parts",
    label: "nav.parts",
    path: "/parts",
    permission: "stock.read",
    sections: ["/parts"],
    icon: ICON.parts,
  },
  {
    key: "stock",
    label: "nav.stock",
    path: "/stock",
    permission: "stock.read",
    sections: ["/stock"],
    icon: ICON.stock,
  },
  {
    key: "directory",
    label: "nav.directory",
    path: "/search",
    permission: "directory.search",
    sections: ["/search", "/customers", "/vehicles"],
    icon: ICON.directory,
  },
  {
    key: "catalogue",
    label: "nav.catalogue",
    path: "/catalogue",
    permission: "catalogue.read",
    sections: ["/catalogue"],
    icon: ICON.catalogue,
  },
  {
    key: "taxSettings",
    label: "nav.taxSettings",
    path: "/settings/tax",
    permission: "tax.manage",
    sections: ["/settings/tax"],
    icon: ICON.tax,
  },
  {
    key: "businessProfile",
    label: "nav.businessProfile",
    path: "/settings/business",
    permission: "business_profile.manage",
    sections: ["/settings/business"],
    icon: ICON.business,
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
