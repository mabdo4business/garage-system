/**
 * The six fixed roles (PRD v0.2 §6.1) and the Increment 0 permission map.
 *
 * Only permissions needed by Increment 0 endpoints exist yet. Each later increment adds its
 * own permissions here. The five sensitive per-user toggles (T1–T5) arrive in Increment 5.
 */
export const ROLES = [
  "partner",
  "manager",
  "service_advisor",
  "technician",
  "store_keeper",
  "accountant",
] as const;

export type Role = (typeof ROLES)[number];

const ALL_ROLES = [
  "partner",
  "manager",
  "service_advisor",
  "technician",
  "store_keeper",
  "accountant",
] as const satisfies readonly Role[];

export const PERMISSIONS = {
  "test_document.create": ["partner", "manager", "service_advisor"],
  "test_document.issue": ["partner", "manager", "service_advisor"],
  // Deactivation is risk-reducing (R0) and therefore immediate. Increment 0 grants it to
  // partners only; manager rights over non-partner staff arrive with the governance work.
  "user.deactivate": ["partner"],

  // I1-01: the one search box everyone at the counter or in the bay uses (plate/mobile/name/VIN).
  "directory.search": ALL_ROLES,
  // Profile read, minus contact fields — see customer.read_contact.
  "customer.read": ALL_ROLES,
  "vehicle.read": ALL_ROLES,
  // Mobile/email. Technicians and store keepers never see customer phone numbers (UI/UX deck
  // persona table; this is the control the I1-01 "technician cannot read phone numbers" test checks).
  "customer.read_contact": ["partner", "manager", "service_advisor", "accountant"],
  "customer.write": ["partner", "manager", "service_advisor"],
  "vehicle.write": ["partner", "manager", "service_advisor"],

  // I1-02: check-in at the counter. Technicians see repair orders only through their own assigned
  // jobs (I1-06, AC2-30), so they get no repair_order.* permission yet.
  "repair_order.check_in": ["partner", "manager", "service_advisor"],
  "repair_order.read": ["partner", "manager", "service_advisor"],
  // AC2-33: after check-in a photo can only be marked excluded, by a manager, with a reason.
  "media.exclude": ["partner", "manager"],

  // I1-03: assigning the inspection (T-11) and recording findings. A technician records findings only
  // on repair orders whose inspection they are assigned to (checked in the inspection module, AC2-30).
  "inspection.assign": ["partner", "manager"],
  "finding.record": ["partner", "manager", "service_advisor", "technician"],
  // The technician's own list of assigned inspections (menu item "My inspections").
  "inspection.my_work": ["technician"],

  // I1-04: price list. Technicians never see prices (AC2-30); changing prices is partner or manager
  // (OD-12) until the per-user T4 toggle. Tax settings are partner-only until dual control (T-15).
  "catalogue.read": ["partner", "manager", "service_advisor", "store_keeper", "accountant"],
  "pricing.manage": ["partner", "manager"],
  "tax.manage": ["partner"],

  // I1-05: estimates. Technicians never see prices (AC2-30). Line discounts are managers and partners
  // only until discount limits and approvals arrive in I3-06 (OD-19).
  "estimate.read": ["partner", "manager", "service_advisor"],
  "estimate.edit": ["partner", "manager", "service_advisor"],
  "estimate.discount": ["partner", "manager"],
  // I1-05b: presenting the estimate and recording the customer's in-person decision (L3, OD-20).
  "estimate.send": ["partner", "manager", "service_advisor"],
  "estimate.record_approval": ["partner", "manager", "service_advisor"],

  // I1-06: the workshop board (no prices), assigning jobs (US-07.2, OD-26) and the assignee's own jobs. Managers
  // and partners can be assignees (OD-27), so they have "My jobs" too.
  "workshop.board": ["partner", "manager", "service_advisor"],
  "workshop.assign": ["partner", "manager"],
  "workshop.my_jobs": ["partner", "manager", "technician"],

  // I1-07: stock and parts for jobs (OD-29). Stock values and line costs are shown to these roles only (T-24).
  "stock.read": ["partner", "manager", "service_advisor", "store_keeper"],
  "stock.receive": ["partner", "manager", "service_advisor", "store_keeper"],
  "stock.issue": ["partner", "manager", "service_advisor", "store_keeper"],

  // I1-08: QC (OD-36). Technicians may request QC only on repair orders they have a job on (checked in the command).
  "qc.request": ["partner", "manager", "technician"],
  "qc.decide": ["partner", "manager"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((role) => allowed.includes(role));
}
