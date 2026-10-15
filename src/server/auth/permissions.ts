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

export const PERMISSIONS = {
  "test_document.create": ["partner", "manager", "service_advisor"],
  "test_document.issue": ["partner", "manager", "service_advisor"],
  // Deactivation is risk-reducing (R0) and therefore immediate. Increment 0 grants it to
  // partners only; manager rights over non-partner staff arrive with the governance work.
  "user.deactivate": ["partner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function hasPermission(roles: readonly string[], permission: Permission): boolean {
  const allowed: readonly string[] = PERMISSIONS[permission];
  return roles.some((role) => allowed.includes(role));
}
